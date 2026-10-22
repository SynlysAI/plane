# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Standalone personal-token binding and revocable MCP credentials.

Plane origins and workspace choices come only from administrator settings.
Plane PATs are encrypted at rest; MCP/session tokens are stored only as hashes.
"""
from __future__ import annotations

from contextlib import contextmanager
from dataclasses import dataclass
import hashlib
import asyncio
import hmac
import json
import os
from pathlib import Path
import secrets
import sqlite3
import time
from urllib.parse import quote, urlsplit
from uuid import UUID, uuid4

from cryptography.fernet import Fernet
import httpx
from starlette.responses import FileResponse, JSONResponse
from starlette.routing import Route

from plane_client import PlaneConfig, PlaneError


class PortalError(ValueError):
    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.status = status


def origin(value: str) -> str:
    try:
        return PlaneConfig(value, "validation", "validation").base_url
    except (PlaneError, TypeError):
        raise ValueError("Configure valid HTTP(S) origins without paths or credentials.") from None


@dataclass(frozen=True)
class SelfServiceSettings:
    public_url: str
    plane_base_url: str
    plane_ui_url: str
    workspaces: tuple[str, ...]
    allow_publish: bool = False
    max_token_days: int = 90
    max_tokens_per_user: int = 10
    max_runtimes: int = 20


def parse_settings(value) -> SelfServiceSettings | None:
    if value is None or value == {"enabled": False}:
        return None
    if not isinstance(value, dict) or type(value.get("enabled", False)) is not bool:
        raise ValueError("self_service.enabled must be a boolean.")
    if not value.get("enabled"):
        return None
    public = origin(value.get("public_url"))
    plane = origin(value.get("plane_base_url"))
    ui = origin(value.get("plane_ui_url", plane))
    insecure = value.get("allow_insecure_http", False)
    if type(insecure) is not bool:
        raise ValueError("allow_insecure_http must be a boolean.")
    if urlsplit(public).scheme != "https" and not insecure and urlsplit(public).hostname not in {"127.0.0.1", "localhost", "::1"}:
        raise ValueError("Self-service requires HTTPS; trusted-LAN demos must explicitly allow insecure HTTP.")
    workspaces = value.get("workspaces")
    if not isinstance(workspaces, list) or not workspaces or len(workspaces) > 50 or any(not isinstance(w, str) or not w or len(w) > 100 or any(c in w for c in "/\\?#") or any(c.isspace() for c in w) for w in workspaces):
        raise ValueError("Configure explicit self-service workspace slugs.")
    publish = value.get("allow_publish", False)
    if type(publish) is not bool:
        raise ValueError("allow_publish must be a boolean.")
    limits = []
    for key, default, maximum in (("max_token_days", 90, 365), ("max_tokens_per_user", 10, 50), ("max_runtimes", 20, 50)):
        item = value.get(key, default)
        if type(item) is not int or not 1 <= item <= maximum:
            raise ValueError("Invalid self-service capacity or expiry limit.")
        limits.append(item)
    return SelfServiceSettings(public, plane, ui, tuple(dict.fromkeys(workspaces)), publish, *limits)


def digest(secret: str) -> str:
    return hashlib.sha256(secret.encode("utf-8")).hexdigest()


class CredentialStore:
    def __init__(self, root: Path, *, clock=time.time):
        self.clock = clock
        self.root = root / "self-service"
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.path = self.root / "credentials.sqlite3"
        key_path = self.root / "encryption.key"
        if not key_path.exists():
            if self.path.exists():
                raise ValueError("Credential encryption key is missing; restore it with its database.")
            try:
                fd = os.open(key_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                with os.fdopen(fd, "wb") as handle:
                    handle.write(Fernet.generate_key())
            except FileExistsError:
                pass
        self.cipher = Fernet(key_path.read_bytes())
        if not self.path.exists():
            try:
                os.close(os.open(self.path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600))
            except FileExistsError:
                pass
        with self.db() as db:
            db.executescript("""
                CREATE TABLE IF NOT EXISTS sessions (
                    hash TEXT PRIMARY KEY, owner TEXT NOT NULL, display_name TEXT NOT NULL,
                    pat BLOB NOT NULL, csrf TEXT NOT NULL, expires REAL NOT NULL
                );
                CREATE TABLE IF NOT EXISTS tokens (
                    id TEXT PRIMARY KEY, hash TEXT UNIQUE NOT NULL, owner TEXT NOT NULL,
                    label TEXT NOT NULL, workspace TEXT NOT NULL, pat BLOB NOT NULL,
                    publish INTEGER NOT NULL, created REAL NOT NULL, expires REAL NOT NULL,
                    revoked INTEGER NOT NULL DEFAULT 0, last_used REAL
                );
            """)

    @contextmanager
    def db(self):
        db = sqlite3.connect(self.path, timeout=5)
        db.row_factory = sqlite3.Row
        try:
            with db:
                yield db
        finally:
            db.close()

    def login(self, profile: dict, pat: str) -> tuple[str, dict]:
        secret, csrf = secrets.token_urlsafe(32), secrets.token_urlsafe(32)
        expiry = self.clock() + 1800
        with self.db() as db:
            db.execute("DELETE FROM sessions WHERE expires <= ?", (self.clock(),))
            db.execute("INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?)", (digest(secret), profile["id"], profile["name"], self.cipher.encrypt(pat.encode()), csrf, expiry))
        return secret, {"name": profile["name"], "csrf": csrf, "expires": expiry}

    def session(self, secret: str | None) -> dict:
        if not secret or len(secret) > 256:
            raise PortalError("请先使用个人访问令牌验证身份。", 401)
        with self.db() as db:
            row = db.execute("SELECT * FROM sessions WHERE hash = ? AND expires > ?", (digest(secret), self.clock())).fetchone()
        if row is None:
            raise PortalError("验证已过期，请重新绑定个人访问令牌。", 401)
        return dict(row)

    def logout(self, secret: str):
        with self.db() as db:
            db.execute("DELETE FROM sessions WHERE hash = ?", (digest(secret),))

    def cleanup(self):
        with self.db() as db:
            db.execute("DELETE FROM sessions WHERE expires <= ?", (self.clock(),))
            db.execute("UPDATE tokens SET pat = X'' WHERE expires <= ? AND length(pat) > 0", (self.clock(),))

    def issue(self, session: dict, workspace: str, label: str, days: int, publish: bool, limit: int) -> tuple[str, dict]:
        secret, identifier = "pmcp_" + secrets.token_urlsafe(32), uuid4().hex
        now = self.clock()
        with self.db() as db:
            db.execute("BEGIN IMMEDIATE")
            count = db.execute("SELECT count(*) FROM tokens WHERE owner = ? AND revoked = 0 AND expires > ?", (session["owner"], now)).fetchone()[0]
            if count >= limit:
                raise PortalError("有效连接数量已达上限，请先撤销不再使用的连接。", 409)
            db.execute("INSERT INTO tokens (id, hash, owner, label, workspace, pat, publish, created, expires) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", (identifier, digest(secret), session["owner"], label, workspace, session["pat"], int(publish), now, now + days * 86400))
        return secret, {"id": identifier, "label": label, "workspace": workspace, "publish": publish, "created": now, "expires": now + days * 86400}

    def authenticate(self, token_hash: str) -> dict | None:
        now = self.clock()
        with self.db() as db:
            row = db.execute("SELECT * FROM tokens WHERE hash = ? AND revoked = 0 AND expires > ?", (token_hash, now)).fetchone()
            if row is None:
                return None
            db.execute("UPDATE tokens SET last_used = ? WHERE id = ?", (now, row["id"]))
        value = dict(row)
        value["pat"] = self.cipher.decrypt(value["pat"]).decode()
        return value

    def list_tokens(self, owner: str) -> list[dict]:
        with self.db() as db:
            rows = db.execute("SELECT id, label, workspace, publish, created, expires, revoked, last_used FROM tokens WHERE owner = ? ORDER BY created DESC", (owner,)).fetchall()
        return [dict(row) for row in rows]

    def revoke(self, owner: str, identifier: str):
        with self.db() as db:
            result = db.execute("UPDATE tokens SET revoked = 1, pat = X'' WHERE owner = ? AND id = ?", (owner, identifier))
            if result.rowcount != 1:
                raise PortalError("未找到此连接。", 404)


async def verify_plane(settings: SelfServiceSettings, pat: str, workspace: str | None = None) -> dict:
    if not isinstance(pat, str) or not 1 <= len(pat) <= 1024 or any(ord(c) < 33 or ord(c) > 126 for c in pat):
        raise PortalError("请填写有效的 Plane 个人访问令牌。")
    try:
        async with httpx.AsyncClient(timeout=10, follow_redirects=False, trust_env=False) as http:
            response = await http.get(settings.plane_base_url + "/api/v1/users/me/", headers={"X-Api-Key": pat})
            if response.status_code in {401, 403}:
                raise PortalError("个人访问令牌无效、已过期或账号不可用。", 401)
            if response.status_code != 200:
                raise PortalError("无法验证 Plane 账号，请稍后重试。", 502)
            data = response.json()
            identifier = str(UUID(data["id"]))
            if workspace is not None:
                if workspace not in settings.workspaces:
                    raise PortalError("该工作区未开放自助接入。", 403)
                response = await http.get(settings.plane_base_url + "/api/v1/workspaces/" + quote(workspace, safe="") + "/projects/", params={"per_page": 1}, headers={"X-Api-Key": pat})
                if response.status_code in {401, 403, 404}:
                    raise PortalError("此账号无权访问所选工作区，或个人令牌已失效。", 403)
                if response.status_code != 200:
                    raise PortalError("工作区验证失败，请稍后重试。", 502)
                listing = response.json()
                if not (isinstance(listing, list) or isinstance(listing, dict) and isinstance(listing.get("results"), list)):
                    raise PortalError("Plane 返回了无法识别的工作区数据。", 502)
            name = data.get("display_name") or data.get("first_name") or "Plane 用户"
            return {"id": identifier, "name": str(name)[:100]}
    except PortalError:
        raise
    except Exception:
        raise PortalError("无法连接或识别 Plane API，请检查部署配置。", 502) from None


def connection_configs(settings: SelfServiceSettings, token: str) -> dict:
    url = settings.public_url + "/mcp"
    codex = "\n".join([
        "[mcp_servers.plane]", "url = " + json.dumps(url),
        'http_headers = { Authorization = ' + json.dumps("Bearer " + token) + " }",
        "tool_timeout_sec = 120", 'default_tools_approval_mode = "prompt"', "",
    ])
    science = {"mcpServers": {"Plane Task and Progress": {"type": "http", "url": url, "headers": {"Authorization": "Bearer " + token}, "timeoutSeconds": 120}}}
    return {"codex_toml": codex, "sciencediscovery_json": json.dumps(science, ensure_ascii=False, indent=2), "mcp_url": url}


class SelfServicePortal:
    COOKIE = "plane_mcp_portal"

    def __init__(self, settings: SelfServiceSettings, store: CredentialStore, *, verifier=verify_plane):
        self.settings, self.store, self.verifier = settings, store, verifier
        self.attempts: dict[str, tuple[float, int]] = {}

    def guard(self, request, *, mutating=False):
        expected = urlsplit(self.settings.public_url)
        host = request.headers.get("host", "").lower()
        if host != expected.netloc.lower():
            raise PortalError("请通过部署者提供的自助接入地址访问。", 421)
        if mutating and request.headers.get("origin") != self.settings.public_url:
            raise PortalError("请求来源不匹配，请重新打开接入页面。", 403)

    async def body(self, request) -> dict:
        if request.headers.get("content-type", "").split(";")[0].strip().lower() != "application/json":
            raise PortalError("请求格式必须为 JSON。", 415)
        raw = bytearray()
        async for chunk in request.stream():
            raw.extend(chunk)
            if len(raw) > 8192:
                raise PortalError("请求内容过长。", 413)
        try:
            value = json.loads(raw)
            if not isinstance(value, dict):
                raise ValueError()
            return value
        except (ValueError, UnicodeError):
            raise PortalError("请求内容无效。") from None

    def current(self, request, *, write=False) -> dict:
        session = self.store.session(request.cookies.get(self.COOKIE))
        if write and not hmac.compare_digest(request.headers.get("x-mcp-csrf", "").encode("utf-8"), session["csrf"].encode("utf-8")):
            raise PortalError("验证信息已失效，请刷新页面。", 403)
        return session

    def rate_limit(self, request):
        now = time.monotonic()
        self.attempts = {key: value for key, value in self.attempts.items() if now - value[0] < 60}
        key = request.client.host if request.client else "unknown"
        since, count = self.attempts.get(key, (now, 0))
        if count >= 10 or key not in self.attempts and len(self.attempts) >= 1000:
            raise PortalError("验证次数过多，请一分钟后重试。", 429)
        self.attempts[key] = (since, count + 1)

    def endpoint(self, handler):
        async def wrapped(request):
            try:
                self.guard(request, mutating=request.method == "POST")
                response = await handler(request)
                if not isinstance(response, (JSONResponse, FileResponse)):
                    response = JSONResponse(response)
            except PortalError as error:
                response = JSONResponse({"error": str(error)}, status_code=error.status)
            except Exception:
                response = JSONResponse({"error": "接入服务暂时不可用，请联系部署者。"}, status_code=500)
            response.headers.update({"Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY", "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"})
            return response
        return wrapped

    def routes(self) -> list[Route]:
        async def page(request):
            return FileResponse(Path(__file__).parent / "portal" / "connect.html", media_type="text/html")

        async def asset(request):
            filename = request.path_params["filename"]
            if filename not in {"connect.js", "connect.css"}:
                raise PortalError("文件不存在。", 404)
            return FileResponse(Path(__file__).parent / "portal" / filename)

        async def options(request):
            return {"plane_ui_url": self.settings.plane_ui_url, "workspaces": self.settings.workspaces, "allow_publish": self.settings.allow_publish, "max_token_days": self.settings.max_token_days}

        async def login(request):
            self.rate_limit(request)
            data = await self.body(request)
            pat = data.get("plane_token")
            profile = await self.verifier(self.settings, pat)
            previous = request.cookies.get(self.COOKIE)
            if previous and len(previous) <= 256:
                self.store.logout(previous)
            secret, status = self.store.login(profile, pat)
            response = JSONResponse(status)
            response.set_cookie(self.COOKIE, secret, max_age=1800, httponly=True, secure=self.settings.public_url.startswith("https:"), samesite="strict", path="/connect")
            return response

        async def session(request):
            current = self.current(request)
            return {"name": current["display_name"], "csrf": current["csrf"], "expires": current["expires"]}

        async def tokens(request):
            current = self.current(request, write=request.method == "POST")
            if request.method == "GET":
                return {"tokens": self.store.list_tokens(current["owner"])}
            self.rate_limit(request)
            data = await self.body(request)
            workspace, label, days = data.get("workspace"), data.get("label"), data.get("days", 30)
            publish = data.get("publish", False)
            if not isinstance(workspace, str) or workspace not in self.settings.workspaces:
                raise PortalError("请选择已开放的工作区。", 403)
            if not isinstance(label, str) or not label.strip() or len(label) > 64 or any(ord(c) < 32 for c in label):
                raise PortalError("连接名称需为 1 到 64 个字符。")
            if type(days) is not int or not 1 <= days <= self.settings.max_token_days:
                raise PortalError("连接有效期超出允许范围。")
            if type(publish) is not bool or publish and not self.settings.allow_publish:
                raise PortalError("管理员未开放评论发布能力。", 403)
            pat = self.store.cipher.decrypt(current["pat"]).decode()
            profile = await self.verifier(self.settings, pat, workspace)
            if profile["id"] != current["owner"]:
                raise PortalError("Plane 账号已变化，请重新验证。", 401)
            token, info = self.store.issue(current, workspace, label.strip(), days, publish, self.settings.max_tokens_per_user)
            return {**info, **connection_configs(self.settings, token)}

        async def candidates(request):
            current = self.current(request)
            pat = self.store.cipher.decrypt(current["pat"]).decode()
            semaphore = asyncio.Semaphore(5)

            async def check(workspace):
                async with semaphore:
                    try:
                        profile = await self.verifier(self.settings, pat, workspace)
                        if profile["id"] != current["owner"]:
                            raise PortalError("Plane 账号已变化，请重新验证。", 401)
                        return workspace, None
                    except PortalError as error:
                        if error.status == 401:
                            raise
                        return None, {"workspace": workspace, "status": error.status,
                                      "error": str(error)} if error.status != 403 else None

            checked = await asyncio.gather(*(check(workspace) for workspace in self.settings.workspaces))
            return {"workspaces": [workspace for workspace, _ in checked if workspace],
                    "failures": [failure for _, failure in checked if failure],
                    "plane_ui_url": self.settings.plane_ui_url, "identity_mapping": "independent",
                    "account": {"id": current["owner"], "name": current["display_name"]}}

        async def revoke(request):
            current = self.current(request, write=True)
            await self.body(request)
            self.store.revoke(current["owner"], request.path_params["identifier"])
            return {"revoked": True}

        async def logout(request):
            self.current(request, write=True)
            await self.body(request)
            self.store.logout(request.cookies[self.COOKIE])
            response = JSONResponse({"logged_out": True})
            response.delete_cookie(self.COOKIE, path="/connect")
            return response

        definitions = [("/connect", page, ["GET"]), ("/connect/", page, ["GET"]), ("/connect/assets/{filename}", asset, ["GET"]), ("/connect/api/options", options, ["GET"]), ("/connect/api/login", login, ["POST"]), ("/connect/api/session", session, ["GET"]), ("/connect/api/tokens", tokens, ["GET", "POST"]), ("/connect/api/tokens/{identifier}/revoke", revoke, ["POST"]), ("/connect/api/logout", logout, ["POST"])]
        definitions.append(("/connect/api/candidates", candidates, ["GET"]))
        return [Route(path, self.endpoint(handler), methods=methods) for path, handler, methods in definitions]
