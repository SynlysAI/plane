"""Shared generation of public MCP client configuration."""

import json
import re
from urllib.parse import urlsplit, urlunsplit

from django.conf import settings


def server_key(name):
    """Return the user-supplied MCP server key with only outer whitespace removed."""
    return name.strip()


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


def client_files(key, url, headers):
    """Generate Codex TOML and generic MCP JSON with the same server key.

    Args:
        key: User-supplied MCP server key.
        url: Absolute public MCP endpoint.
        headers: Authentication headers to embed in client configuration.

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
    return {
        "codex_toml": toml,
        "sciencediscovery_json": json.dumps(payload, ensure_ascii=False),
    }
