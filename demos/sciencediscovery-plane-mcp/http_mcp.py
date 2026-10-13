"""Authenticated Streamable HTTP transport for the existing Plane MCP tools.

Each configured client gets a separate official STDIO upstream, MCP server and
draft directory. HTTP never accepts Plane credentials or commands from callers.
"""

from __future__ import annotations

import argparse
from contextlib import AsyncExitStack, asynccontextmanager
from dataclasses import dataclass
from datetime import timedelta
import hashlib
import hmac
from importlib.metadata import version
import json
import os
from pathlib import Path
import re
import sys

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client
from mcp.server.streamable_http_manager import StreamableHTTPSessionManager
from mcp.server.transport_security import TransportSecuritySettings
from starlette.applications import Starlette
from starlette.responses import JSONResponse
from starlette.routing import Route
import uvicorn

from agent_mcp import create_server as create_agent_server
from agent_workflow import AgentWorkflow
from plane_client import PlaneConfig, PlaneError
from read_only_mcp import ReadOnlyPlaneProxy, UPSTREAM_PACKAGE, UPSTREAM_VERSION, create_server as create_read_only_server


class HttpConfigError(ValueError):
    """Configuration errors with no secret values in their messages."""


@dataclass(frozen=True, repr=False)
class HttpClient:
    name: str
    token_digest: bytes
    plane: PlaneConfig
    ui_origin: str
    mode: str = "read-only"
    enable_publish: bool = False


@dataclass(frozen=True, repr=False)
class HttpConfig:
    clients: tuple[HttpClient, ...]
    state_dir: Path
    host: str = "127.0.0.1"
    port: int = 8765
    allowed_hosts: tuple[str, ...] = ("127.0.0.1:*", "localhost:*", "[::1]:*")
    allowed_origins: tuple[str, ...] = ()


def load_http_config(path: Path) -> HttpConfig:
    try:
        values = json.loads(path.read_text(encoding="utf-8-sig"))
        if not isinstance(values, dict):
            raise HttpConfigError("HTTP configuration must be an object.")
        host, port = values.get("host", "127.0.0.1"), values.get("port", 8765)
        if not isinstance(host, str) or not host or any(c.isspace() for c in host):
            raise HttpConfigError("Set a valid HTTP listen host.")
        if type(port) is not int or not 1 <= port <= 65535:
            raise HttpConfigError("HTTP port must be an integer from 1 to 65535.")
        hosts = values.get("allowed_hosts", ["127.0.0.1:*", "localhost:*", "[::1]:*"])
        origins = values.get("allowed_origins", [])
        for entries in (hosts, origins):
            if not isinstance(entries, list) or any(not isinstance(x, str) or not x or x == "*" or any(c.isspace() for c in x) for x in entries):
                raise HttpConfigError("Host/Origin allowlists must contain explicit nonempty names, not '*'.")
        if not hosts:
            raise HttpConfigError("At least one allowed Host is required.")
        state = values.get("state_dir", "~/.plane-http-mcp")
        if not isinstance(state, str) or not state:
            raise HttpConfigError("Set a valid state_dir.")
        state_dir = Path(state).expanduser()
        if not state_dir.is_absolute():
            state_dir = path.resolve().parent / state_dir
        entries = values.get("clients")
        if not isinstance(entries, list) or not 1 <= len(entries) <= 50:
            raise HttpConfigError("Configure between 1 and 50 HTTP clients.")
        clients, names, tokens = [], set(), set()
        for entry in entries:
            if not isinstance(entry, dict):
                raise HttpConfigError("Each HTTP client must be an object.")
            name, token = entry.get("name"), entry.get("bearer_token")
            if not isinstance(name, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", name) or name in names:
                raise HttpConfigError("Client names must be unique and contain only letters, digits, '_' or '-'.")
            if not isinstance(token, str) or not re.fullmatch(r"[A-Za-z0-9_-]{32,256}", token) or token.startswith("REPLACE"):
                raise HttpConfigError("Generate a separate random Bearer token of at least 32 URL-safe characters for each client.")
            token_digest = hashlib.sha256(token.encode("ascii")).digest()
            if token_digest in tokens:
                raise HttpConfigError("HTTP clients must not share Bearer tokens.")
            plane_values = entry.get("plane")
            if not isinstance(plane_values, dict) or any(not isinstance(plane_values.get(key), str) for key in ("PLANE_BASE_URL", "PLANE_WORKSPACE_SLUG", "PLANE_API_KEY", "PLANE_UI_BASE_URL")):
                raise HttpConfigError("Each client needs explicit Plane API/UI origins, workspace and API key.")
            plane = PlaneConfig(*(plane_values[key] for key in ("PLANE_BASE_URL", "PLANE_WORKSPACE_SLUG", "PLANE_API_KEY")))
            ui_origin = PlaneConfig(plane_values["PLANE_UI_BASE_URL"], plane.workspace_slug, plane.api_key).base_url
            mode, publish = entry.get("mode", "read-only"), entry.get("enable_publish", False)
            if mode not in ("read-only", "agent") or type(publish) is not bool or (mode == "read-only" and publish):
                raise HttpConfigError("Use mode read-only or agent; publishing is a boolean available only in agent mode.")
            names.add(name)
            tokens.add(token_digest)
            clients.append(HttpClient(name, token_digest, plane, ui_origin, mode, publish))
        return HttpConfig(tuple(clients), state_dir.resolve(), host, port, tuple(hosts), tuple(origins))
    except HttpConfigError:
        raise
    except (OSError, UnicodeError, ValueError, TypeError, PlaneError):
        raise HttpConfigError("Cannot load HTTP configuration; check the private JSON and Plane settings. Raw values withheld.") from None


@asynccontextmanager
async def open_server(client: HttpClient, state_dir: Path):
    if version(UPSTREAM_PACKAGE) != UPSTREAM_VERSION:
        raise HttpConfigError("Install the pinned official MCP dependencies first.")
    # Explicit per-client values take precedence over the host's environment.
    allowed = {"PATH", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "LANG", "LC_ALL", "SSL_CERT_FILE", "SSL_CERT_DIR", "REQUESTS_CA_BUNDLE", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy"}
    environment = {key: value for key, value in os.environ.items() if key in allowed}
    environment.update(PLANE_BASE_URL=client.plane.base_url, PLANE_WORKSPACE_SLUG=client.plane.workspace_slug, PLANE_API_KEY=client.plane.api_key, LOG_PAYLOADS="false", LOG_USER_INFO="false")
    parameters = StdioServerParameters(command=sys.executable, args=["-m", "plane_mcp", "stdio"], env=environment)
    with open(os.devnull, "w", encoding="utf-8") as diagnostics:
        async with stdio_client(parameters, errlog=diagnostics) as streams:
            async with ClientSession(*streams, read_timeout_seconds=timedelta(seconds=60)) as session:
                await session.initialize()
                if client.mode == "read-only":
                    proxy = ReadOnlyPlaneProxy(session)
                    await proxy.discover()
                    yield create_read_only_server(proxy)
                else:
                    # Fold identity into the existing scope hash rather than
                    # adding a directory: keeps Windows draft paths short and
                    # separates case-distinct users sharing a Plane account.
                    workflow = AgentWorkflow(session, client.plane, client.ui_origin, state_dir, enable_publish=client.enable_publish, state_namespace="http-client:" + client.name)
                    await workflow.discover()
                    yield create_agent_server(workflow)


class AuthenticatedMCP:
    def __init__(self, config: HttpConfig):
        self.config = config
        self.managers: dict[str, StreamableHTTPSessionManager] = {}

    async def __call__(self, scope, receive, send):
        headers = [value for key, value in scope.get("headers", []) if key.lower() == b"authorization"]
        principal = None
        if len(headers) == 1:
            parts = headers[0].split(b" ")
            if len(parts) == 2 and parts[0].lower() == b"bearer" and 32 <= len(parts[1]) <= 256:
                candidate = hashlib.sha256(parts[1]).digest()
                for client in self.config.clients:
                    if hmac.compare_digest(candidate, client.token_digest):
                        principal = client.name
        if principal is None:
            response = JSONResponse({"error": "Bearer authentication required."}, status_code=401, headers={"WWW-Authenticate": 'Bearer realm="plane-mcp"', "Cache-Control": "no-store"})
            await response(scope, receive, send)
            return
        manager = self.managers.get(principal)
        if manager is None:
            await JSONResponse({"error": "MCP service unavailable."}, status_code=503)(scope, receive, send)
            return
        await manager.handle_request(scope, receive, send)


def create_app(config: HttpConfig, *, server_factory=open_server) -> Starlette:
    endpoint = AuthenticatedMCP(config)
    security = TransportSecuritySettings(enable_dns_rebinding_protection=True, allowed_hosts=list(config.allowed_hosts), allowed_origins=list(config.allowed_origins))

    @asynccontextmanager
    async def lifespan(app):
        try:
            async with AsyncExitStack() as stack:
                for client in config.clients:
                    server = await stack.enter_async_context(server_factory(client, config.state_dir))
                    manager = StreamableHTTPSessionManager(server, stateless=True, json_response=True, security_settings=security)
                    await stack.enter_async_context(manager.run())
                    endpoint.managers[client.name] = manager
                yield
        except Exception:
            raise RuntimeError("Plane HTTP MCP lifecycle failed; check private configuration, dependencies and upstream availability. Raw details withheld.") from None
        finally:
            endpoint.managers.clear()

    async def health(request):
        return JSONResponse({"status": "ok" if endpoint.managers else "unavailable"}, status_code=200 if endpoint.managers else 503)

    return Starlette(debug=False, lifespan=lifespan, routes=[
        Route("/healthz", health, methods=["GET"]),
        Route("/mcp", endpoint, methods=["GET", "POST", "DELETE"]),
        Route("/mcp/", endpoint, methods=["GET", "POST", "DELETE"]),
    ])


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", required=True, type=Path, help="Private HTTP configuration with per-client credentials.")
    args = parser.parse_args()
    try:
        config = load_http_config(args.config)
        print(f"Starting Plane HTTP MCP on {config.host}:{config.port}; endpoint /mcp", flush=True)
        # Disable access logs (URLs can contain accidental secrets) and untrusted
        # forwarded headers. Reverse proxies must preserve the allowed Host.
        server = uvicorn.Server(uvicorn.Config(create_app(config), host=config.host, port=config.port, access_log=False, proxy_headers=False, log_level="critical"))
        server.run()
        if not server.started:
            sys.stderr.write("Plane HTTP MCP could not start; check private configuration, dependencies and the listen port. Raw details withheld.\n")
            return 1
        return 0
    except KeyboardInterrupt:
        return 0
    except HttpConfigError as exc:
        sys.stderr.write("Plane HTTP MCP stopped: " + str(exc) + "\n")
    except SystemExit:
        sys.stderr.write("Plane HTTP MCP could not bind the listen port.\n")
    except Exception:
        sys.stderr.write("Plane HTTP MCP stopped; check configuration, dependencies and the listen port. Raw details withheld.\n")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
