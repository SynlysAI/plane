"""Self-service credential lifecycle and real HTTP-to-MCP integration."""
from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from dataclasses import replace
import json
from pathlib import Path
import socket
import sys
import tempfile
import tomllib
import unittest
from unittest.mock import patch

import httpx
from mcp import ClientSession
from mcp.client.streamable_http import streamable_http_client
import uvicorn

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from agent_mcp import create_server
from agent_workflow import AgentWorkflow, unpack
from http_mcp import HttpConfig, HttpConfigError, create_app, load_http_config
from self_service import CredentialStore, PortalError, SelfServiceSettings, connection_configs, digest, parse_settings, verify_plane
from test_agent_workflow import BROWSE, FakePlaneMCP, UI, URL

ALICE = {"id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "name": "Alice"}
BOB = {"id": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "name": "Bob"}
PAT_A, PAT_B = "alice-personal-token-private", "bob-personal-token-private"


def settings():
    return SelfServiceSettings("http://127.0.0.1:8765", "http://plane-api.lab:8000", UI, ("lab", "denied"))


async def fake_verify(config, pat, workspace=None):
    if pat not in {PAT_A, PAT_B}:
        raise PortalError("Invalid personal token", 401)
    if workspace == "denied":
        raise PortalError("Workspace forbidden", 403)
    return ALICE if pat == PAT_A else BOB


class StoreTests(unittest.TestCase):
    def test_encrypted_pat_hashed_mcp_and_session_and_persistent_key(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            store = CredentialStore(root)
            session_secret, info = store.login(ALICE, PAT_A)
            session = store.session(session_secret)
            token, issued = store.issue(session, "lab", "Laptop", 30, False, 10)
            blob = store.path.read_bytes()
            for secret in (PAT_A, token, session_secret):
                self.assertNotIn(secret.encode(), blob)
            restored = CredentialStore(root)
            self.assertEqual(restored.authenticate(digest(token))["pat"], PAT_A)
            self.assertEqual(restored.list_tokens(ALICE["id"])[0]["id"], issued["id"])
            self.assertNotIn("pat", restored.list_tokens(ALICE["id"])[0])
            self.assertNotIn("hash", restored.list_tokens(ALICE["id"])[0])

    def test_owner_isolation_revocation_and_expiry(self):
        with tempfile.TemporaryDirectory() as folder:
            now = [1000.0]
            store = CredentialStore(Path(folder), clock=lambda: now[0])
            secret, _ = store.login(ALICE, PAT_A)
            token, issued = store.issue(store.session(secret), "lab", "Laptop", 1, False, 10)
            self.assertEqual(store.list_tokens(BOB["id"]), [])
            with self.assertRaises(PortalError):
                store.revoke(BOB["id"], issued["id"])
            self.assertIsNotNone(store.authenticate(digest(token)))
            store.revoke(ALICE["id"], issued["id"])
            self.assertIsNone(store.authenticate(digest(token)))
            token, _ = store.issue(store.session(secret), "lab", "Laptop", 1, False, 10)
            now[0] += 86401
            self.assertIsNone(store.authenticate(digest(token)))
            with self.assertRaises(PortalError):
                store.session(secret)
            store.cleanup()
            with store.db() as db:
                self.assertEqual(db.execute("SELECT count(*) FROM sessions").fetchone()[0], 0)
                self.assertEqual(db.execute("SELECT sum(length(pat)) FROM tokens").fetchone()[0], 0)

    def test_token_quota_and_logout(self):
        with tempfile.TemporaryDirectory() as folder:
            store = CredentialStore(Path(folder))
            secret, _ = store.login(ALICE, PAT_A)
            session = store.session(secret)
            _, issued = store.issue(session, "lab", "One", 1, False, 1)
            with self.assertRaises(PortalError) as caught:
                store.issue(session, "lab", "Two", 1, False, 1)
            self.assertEqual(caught.exception.status, 409)
            store.revoke(ALICE["id"], issued["id"])
            store.issue(session, "lab", "Replacement", 1, False, 1)
            store.logout(secret)
            with self.assertRaises(PortalError):
                store.session(secret)

    def test_missing_key_fails_closed_without_overwriting_database(self):
        with tempfile.TemporaryDirectory() as folder:
            store = CredentialStore(Path(folder))
            (store.root / "encryption.key").unlink()
            with self.assertRaises(ValueError):
                CredentialStore(Path(folder))

    def test_codex_toml_and_science_config_contain_only_mcp_credential(self):
        configs = connection_configs(settings(), "pmcp_mcp-token")
        codex = tomllib.loads(configs["codex_toml"])["mcp_servers"]["plane"]
        science = json.loads(configs["sciencediscovery_json"])["mcpServers"]["Plane Task and Progress"]
        self.assertEqual(codex["url"], settings().public_url + "/mcp")
        self.assertEqual(codex["http_headers"]["Authorization"], science["headers"]["Authorization"])
        self.assertEqual(codex["default_tools_approval_mode"], "prompt")
        self.assertNotIn(PAT_A, str(configs))


class SettingsTests(unittest.TestCase):
    def test_zero_static_clients_only_when_self_service_enabled(self):
        value = {"clients": [], "self_service": {"enabled": True, "public_url": "http://127.0.0.1:8765", "plane_base_url": "http://plane.lab:8000", "workspaces": ["lab"]}}
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "test.local.json"
            path.write_text(json.dumps(value))
            self.assertIsNotNone(load_http_config(path).self_service)
            value["self_service"]["enabled"] = False
            path.write_text(json.dumps(value))
            with self.assertRaises(HttpConfigError):
                load_http_config(path)

    def test_rejects_public_http_unless_explicit_demo_and_invalid_limits(self):
        base = {"enabled": True, "public_url": "http://mcp.lab:8765", "plane_base_url": "http://plane.lab:8000", "workspaces": ["lab"]}
        with self.assertRaises(ValueError):
            parse_settings(base)
        self.assertIsNotNone(parse_settings({**base, "allow_insecure_http": True}))
        for change in ({"workspaces": ["../private"]}, {"max_token_days": True}, {"max_tokens_per_user": 0}, {"max_runtimes": 51}, {"allow_publish": "true"}, {"public_url": "https://mcp.lab/path"}):
            with self.subTest(change=change), self.assertRaises(ValueError):
                parse_settings({**base, "allow_insecure_http": True, **change})


class PlaneValidationTests(unittest.IsolatedAsyncioTestCase):
    async def test_validates_identity_and_workspace_at_fixed_origin(self):
        requests = []
        def handler(request):
            requests.append(request)
            self.assertEqual(request.headers["X-Api-Key"], PAT_A)
            self.assertEqual(request.url.host, "plane-api.lab")
            if request.url.path == "/api/v1/users/me/":
                return httpx.Response(200, json={"id": ALICE["id"], "display_name": "Alice"})
            self.assertEqual(request.url.path, "/api/v1/workspaces/lab/projects/")
            return httpx.Response(200, json={"results": []})
        actual = httpx.AsyncClient
        with patch("self_service.httpx.AsyncClient", side_effect=lambda **kw: actual(transport=httpx.MockTransport(handler), **kw)):
            result = await verify_plane(settings(), PAT_A, "lab")
        self.assertEqual(result["id"], ALICE["id"])
        self.assertEqual(len(requests), 2)

    async def test_invalid_personal_token_redirect_and_private_error_are_not_exposed(self):
        actual = httpx.AsyncClient
        for status in (401, 403, 302, 500):
            requests = []
            def handler(request):
                requests.append(request)
                return httpx.Response(status, headers={"Location": "https://attacker.example"}, json={"error": PAT_A})
            with self.subTest(status=status):
                with patch("self_service.httpx.AsyncClient", side_effect=lambda **kw: actual(transport=httpx.MockTransport(handler), **kw)):
                    with self.assertRaises(PortalError) as caught:
                        await verify_plane(settings(), PAT_A)
                self.assertNotIn(PAT_A, str(caught.exception))
                self.assertEqual(len(requests), 1)
        for pat in (None, "", "invalid token", "x\nkey"):
            with self.subTest(pat=pat), self.assertRaises(PortalError):
                await verify_plane(settings(), pat)


@asynccontextmanager
async def running_portal(folder, *, publish=False, capacity=20):
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    url = "http://127.0.0.1:" + str(sock.getsockname()[1])
    options = replace(settings(), public_url=url, allow_publish=publish, max_runtimes=capacity)
    config = HttpConfig((), Path(folder), self_service=options)
    upstreams, started = {}, []

    @asynccontextmanager
    async def factory(client, state):
        started.append(client.name)
        fake = upstreams.setdefault(client.plane.api_key, FakePlaneMCP())
        fake.item["name"] = "Alice task" if client.plane.api_key == PAT_A else "Bob task"
        workflow = AgentWorkflow(fake, client.plane, client.ui_origin, state, enable_publish=client.enable_publish, state_namespace="http-client:" + client.name)
        await workflow.discover()
        yield create_server(workflow)

    app = create_app(config, server_factory=factory, plane_verifier=fake_verify)
    server = uvicorn.Server(uvicorn.Config(app, log_level="critical", access_log=False, proxy_headers=False))
    task = asyncio.create_task(server.serve(sockets=[sock]))
    try:
        async with asyncio.timeout(15):
            while not server.started:
                if task.done():
                    await task
                    raise RuntimeError("Portal failed to start")
                await asyncio.sleep(0.01)
        yield url, app, upstreams, started
    finally:
        server.should_exit = True
        await asyncio.wait_for(task, 15)
        sock.close()


async def login(http, url, pat=PAT_A):
    response = await http.post(url + "/connect/api/login", headers={"Origin": url}, json={"plane_token": pat})
    assert response.status_code == 200, response.status_code
    http.headers.update({"Origin": url, "X-MCP-CSRF": response.json()["csrf"]})
    return response


async def issue(http, url, **changes):
    response = await http.post(url + "/connect/api/tokens", json={"workspace": "lab", "label": "My Codex", "days": 30, **changes})
    return response


@asynccontextmanager
async def mcp(url, auth):
    async with httpx.AsyncClient(headers={"Authorization": auth}, trust_env=False, timeout=15) as http:
        async with streamable_http_client(url + "/mcp", http_client=http) as streams:
            async with ClientSession(*streams[:2]) as session:
                await session.initialize()
                yield session


class PortalHTTPTests(unittest.IsolatedAsyncioTestCase):
    async def test_page_assets_and_csrf_host_body_protection(self):
        with tempfile.TemporaryDirectory() as folder:
            async with running_portal(folder) as (url, app, upstreams, started):
                async with httpx.AsyncClient(trust_env=False) as http:
                    page = await http.get(url + "/connect")
                    self.assertEqual(page.status_code, 200)
                    self.assertIn("Codex", page.text)
                    self.assertIn("frame-ancestors 'none'", page.headers["content-security-policy"])
                    self.assertEqual(page.headers["cache-control"], "no-store")
                    self.assertEqual((await http.get(url + "/connect/assets/connect.js")).status_code, 200)
                    self.assertEqual((await http.get(url + "/connect/assets/credentials.sqlite3")).status_code, 404)
                    self.assertEqual((await http.get(url + "/connect", headers={"Host": "evil.example"})).status_code, 421)
                    self.assertEqual((await http.post(url + "/connect/api/login", json={"plane_token": PAT_A})).status_code, 403)
                    self.assertEqual((await http.post(url + "/connect/api/login", headers={"Origin": "http://evil.example"}, json={"plane_token": PAT_A})).status_code, 403)
                    self.assertEqual((await http.post(url + "/connect/api/login", headers={"Origin": url}, content="plane_token=x")).status_code, 415)
                    self.assertEqual((await http.post(url + "/connect/api/login", headers={"Origin": url, "Content-Type": "application/json"}, content='{"x":"' + 'a' * 9000 + '"}')).status_code, 413)
                    response = await login(http, url)
                    cookie = response.headers["set-cookie"].lower()
                    self.assertIn("httponly", cookie)
                    self.assertIn("samesite=strict", cookie)
                    self.assertNotIn(PAT_A, cookie)
                    http.headers.pop("X-MCP-CSRF")
                    self.assertEqual((await issue(http, url)).status_code, 403)
                self.assertEqual(started, [])

    async def test_self_issue_codex_config_real_mcp_read_and_revocation_no_restart(self):
        with tempfile.TemporaryDirectory() as folder:
            async with running_portal(folder) as (url, app, upstreams, started):
                async with httpx.AsyncClient(trust_env=False) as http:
                    await login(http, url)
                    issued = await issue(http, url)
                    self.assertEqual(issued.status_code, 200)
                    value = issued.json()
                    codex = tomllib.loads(value["codex_toml"])["mcp_servers"]["plane"]
                    self.assertNotIn(PAT_A, issued.text)
                    auth = codex["http_headers"]["Authorization"]
                    async with mcp(url, auth) as session:
                        self.assertEqual([tool.name for tool in (await session.list_tools()).tools], ["read_task_context"])
                        context = unpack(await session.call_tool("read_task_context", {"task_url": BROWSE}))
                        self.assertEqual(context["task"]["name"], "Alice task")
                        self.assertTrue((await session.call_tool("prepare_progress", {"task_url": URL, "progress": "Not allowed"})).isError)
                        listed = (await http.get(url + "/connect/api/tokens")).json()["tokens"]
                        self.assertEqual(len(listed), 1)
                        self.assertNotIn(auth.split(" ", 1)[1], str(listed))
                        self.assertNotIn(PAT_A, str(listed))
                        response = await http.post(url + "/connect/api/tokens/" + value["id"] + "/revoke", json={})
                        self.assertEqual(response.status_code, 200)
                        denied = await http.post(url + "/mcp", headers={"Authorization": auth}, json={})
                        self.assertEqual(denied.status_code, 401)
                    self.assertEqual(len(started), 1)
                    self.assertEqual(upstreams[PAT_A].writes, [])

    async def test_two_users_isolated_and_renewed_token_reconciles_own_draft(self):
        with tempfile.TemporaryDirectory() as folder:
            async with running_portal(folder, publish=True) as (url, app, upstreams, started):
                async with httpx.AsyncClient(trust_env=False) as a, httpx.AsyncClient(trust_env=False) as b:
                    await login(a, url, PAT_A)
                    await login(b, url, PAT_B)
                    first = (await issue(a, url, publish=True)).json()
                    second = (await issue(b, url, publish=True)).json()
                    auth_a = tomllib.loads(first["codex_toml"])["mcp_servers"]["plane"]["http_headers"]["Authorization"]
                    auth_b = tomllib.loads(second["codex_toml"])["mcp_servers"]["plane"]["http_headers"]["Authorization"]
                    self.assertEqual((await b.post(url + "/connect/api/tokens/" + first["id"] + "/revoke", json={})).status_code, 404)
                    self.assertEqual([row["id"] for row in (await b.get(url + "/connect/api/tokens")).json()["tokens"]], [second["id"]])
                    async with mcp(url, auth_a) as ma, mcp(url, auth_b) as mb:
                        context = unpack(await mb.call_tool("read_task_context", {"task_url": BROWSE}))
                        self.assertEqual(context["task"]["name"], "Bob task")
                        draft = unpack(await ma.call_tool("prepare_progress", {"task_url": URL, "progress": "Reviewed test"}))
                        self.assertTrue((await mb.call_tool("publish_progress", {"draft_id": draft["draft_id"], "approved": True})).isError)
                    renewed = (await issue(a, url, publish=True)).json()
                    auth = tomllib.loads(renewed["codex_toml"])["mcp_servers"]["plane"]["http_headers"]["Authorization"]
                    async with mcp(url, auth) as ma:
                        published = unpack(await ma.call_tool("publish_progress", {"draft_id": draft["draft_id"], "approved": True}))
                        self.assertTrue(published["read_back"])
                    self.assertEqual(len(upstreams[PAT_A].writes), 1)
                    self.assertEqual(upstreams[PAT_B].writes, [])
                    self.assertEqual(len(started), 2)

    async def test_workspace_expiry_and_publishing_limits(self):
        with tempfile.TemporaryDirectory() as folder:
            async with running_portal(folder) as (url, app, upstreams, started):
                async with httpx.AsyncClient(trust_env=False) as http:
                    await login(http, url)
                    for data, expected in (({"workspace": "other"}, 403), ({"workspace": "denied"}, 403), ({"days": 0}, 400), ({"days": True}, 400), ({"days": 91}, 400), ({"publish": True}, 403), ({"label": ""}, 400)):
                        with self.subTest(data=data):
                            self.assertEqual((await issue(http, url, **data)).status_code, expected)
                    self.assertEqual((await http.get(url + "/connect/api/tokens")).json()["tokens"], [])

    async def test_login_rate_limit_and_session_logout(self):
        with tempfile.TemporaryDirectory() as folder:
            async with running_portal(folder) as (url, app, upstreams, started):
                async with httpx.AsyncClient(trust_env=False) as http:
                    await login(http, url)
                    self.assertEqual((await http.post(url + "/connect/api/logout", json={})).status_code, 200)
                    self.assertEqual((await http.get(url + "/connect/api/session")).status_code, 401)
                    for _ in range(9):
                        self.assertEqual((await http.post(url + "/connect/api/login", headers={"Origin": url}, json={"plane_token": "wrong"})).status_code, 401)
                    self.assertEqual((await http.post(url + "/connect/api/login", headers={"Origin": url}, json={"plane_token": "wrong"})).status_code, 429)

    async def test_capacity_bound_and_expired_token_rejected_on_next_request(self):
        with tempfile.TemporaryDirectory() as folder:
            async with running_portal(folder, capacity=1) as (url, app, upstreams, started):
                async with httpx.AsyncClient(trust_env=False) as a, httpx.AsyncClient(trust_env=False) as b:
                    await login(a, url, PAT_A)
                    await login(b, url, PAT_B)
                    first, second = (await issue(a, url)).json(), (await issue(b, url)).json()
                    auth_a = tomllib.loads(first["codex_toml"])["mcp_servers"]["plane"]["http_headers"]["Authorization"]
                    auth_b = tomllib.loads(second["codex_toml"])["mcp_servers"]["plane"]["http_headers"]["Authorization"]
                    async with mcp(url, auth_a) as connection:
                        response = await b.post(url + "/mcp", headers={"Authorization": auth_b}, json={})
                        self.assertEqual(response.status_code, 503)
                        app.state.credential_store.clock = lambda: first["expires"] + 1
                        response = await a.post(url + "/mcp", headers={"Authorization": auth_a}, json={})
                        self.assertEqual(response.status_code, 401)
                    self.assertEqual(len(started), 1)


if __name__ == "__main__":
    unittest.main()
