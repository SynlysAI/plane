"""Shared generation of public MCP client configuration."""

import json
import re
from urllib.parse import urlsplit, urlunsplit

from django.conf import settings


def server_key(name):
    """Return the user-supplied MCP server key with only outer whitespace removed."""
    return name.strip()


def workbuddy_server_key(connection_id):
    """生成适合 WorkBuddy 配置导入的稳定安全服务标识。

    Args:
        connection_id: 统一 MCP 连接 UUID。

    Returns:
        由连接 UUID 全量十六进制形式派生的 ASCII 服务标识，保证不同连接
        在 WorkBuddy 中不会因键名碰撞而互相覆盖。
    """
    return f"plane-unified-{str(connection_id).replace('-', '')}"


def _valid_origin(value):
    """Return a configured HTTP(S) origin, or an empty string for invalid values."""
    value = str(value or "").strip().rstrip("/")
    parsed = urlsplit(value)
    try:
        parsed.port
    except ValueError:
        return ""
    if (
        parsed.scheme not in {"http", "https"}
        or not parsed.hostname
        or parsed.username
        or parsed.password
        or parsed.path
        or parsed.query
        or parsed.fragment
    ):
        return ""
    return value


def public_origin(request):
    """Resolve a stable public API origin without exposing proxy-internal paths."""
    explicit = _valid_origin(getattr(settings, "RESEARCH_MCP_PUBLIC_BASE_URL", ""))
    if explicit:
        return explicit

    for value in (getattr(settings, "WEB_URL", ""), getattr(settings, "APP_URL", "")):
        origin = _valid_origin(value)
        if origin:
            return origin

    scheme = request.headers.get("X-Forwarded-Proto", "").split(",", 1)[0].strip()
    if scheme not in {"http", "https"}:
        scheme = request.scheme
    host = request.get_host()
    return urlunsplit((scheme, host, "", "", ""))


def public_url(request, path):
    """Build an absolute public URL for a path that must start with ``/``."""
    if not path.startswith("/"):
        raise ValueError("Public MCP paths must be absolute.")
    return public_origin(request) + path


def workbuddy_files(key, url, headers):
    """生成 WorkBuddy 自定义连接使用的精简 JSON。

    Args:
        key: 由连接 ID 派生的安全服务标识。
        url: 统一 MCP 公开地址；导出时去掉尾斜杠以避免客户端重定向。
        headers: 认证请求头。

    Returns:
        可直接导入 WorkBuddy 的 JSON 字符串。
    """
    payload = {"mcpServers": {key: {"url": url.rstrip("/"), "headers": headers}}}
    return json.dumps(payload, ensure_ascii=False)


def client_files(key, url, headers, workbuddy_key=None):
    """Generate Codex TOML, generic MCP JSON, and optional WorkBuddy JSON.

    Args:
        key: User-supplied MCP server key.
        url: Absolute public MCP endpoint.
        headers: Authentication headers to embed in client configuration.
        workbuddy_key: Optional safe server key used by WorkBuddy import.

    Returns:
        TOML and JSON strings suitable for direct client import.
    """
    value = {"type": "http", "url": url, "headers": headers, "timeoutSeconds": 120}
    header_pairs = ", ".join(f"{json.dumps(name)} = {json.dumps(value)}" for name, value in headers.items())
    key_literal = key if re.fullmatch(r"[A-Za-z0-9_-]+", key) else json.dumps(key)
    toml = (
        f"[mcp_servers.{key_literal}]\n"
        f"url = {json.dumps(url)}\n"
        f"http_headers = {{ {header_pairs} }}\n"
        "tool_timeout_sec = 120\n"
        'default_tools_approval_mode = "prompt"\n'
    )
    payload = {"mcpServers": {key: value}}
    files = {
        "codex_toml": toml,
        "sciencediscovery_json": json.dumps(payload, ensure_ascii=False),
    }
    if workbuddy_key is not None:
        files["workbuddy_server_key"] = workbuddy_key
        files["workbuddy_json"] = workbuddy_files(workbuddy_key, url, headers)
    return files
