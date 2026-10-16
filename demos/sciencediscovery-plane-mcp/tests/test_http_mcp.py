"""Real loopback HTTP protocol, auth and cross-client isolation tests."""

from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
import hashlib
import json
from pathlib import Path
import socket
import sys
import tempfile
import unittest

import httpx
from mcp import ClientSession
from mcp.client.streamable_http import streamable_http_client
import uvicorn

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from agent_mcp import create_server as create_agent_server
from agent_workflow import AgentWorkflow, unpack
from http_mcp import HttpClient, HttpConfig, HttpConfigError, create_app, load_http_config
from read_only_mcp import ReadOnlyPlaneProxy, create_server as create_read_only_server
from test_agent_workflow import BROWSE, CONFIG, FakePlaneMCP, TASK, UI, URL

TOKEN_A, TOKEN_B = "a" * 43, "b" * 43


def client(name, token, *, mode="agent", publish=True):
    return HttpClient(name, hashlib.sha256(token.encode()).digest(), CONFIG, UI, mode, publish)


@asynccontextmanager
async def running_app(config, factory=None):
    app = create_app(config) if factory is None else create_app(config, server_factory=factory)
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    server = uvicorn.Server(uvicorn.Config(app, log_level="critical", access_log=False, proxy_headers=False))
    task = asyncio.create_task(server.serve(sockets=[sock]))
    try:
        async with asyncio.timeout(45):
            while not server.started:
                if task.done():
                    await task
                    raise RuntimeError("HTTP server failed to start")
                await asyncio.sleep(0.01)
        yield f"http://127.0.0.1:{port}", app
    finally:
        server.should_exit = True
        try:
            await asyncio.wait_for(task, timeout=10)
        finally:
            sock.close()


@asynccontextmanager
async def session(url, token):
    async with httpx.AsyncClient(headers={"Authorization": "Bearer " + token}, trust_env=False, timeout=30) as http:
        async with streamable_http_client(url + "/mcp", http_client=http) as streams:
            async with ClientSession(*streams[:2]) as connection:
                await connection.initialize()
                yield connection


class ConfigTests(unittest.TestCase):
    def values(self):
        return {"clients": [{"name": "alice", "bearer_token": TOKEN_A, "plane": {
            "PLANE_BASE_URL": CONFIG.base_url, "PLANE_WORKSPACE_SLUG": "lab",
            "PLANE_API_KEY": CONFIG.api_key, "PLANE_UI_BASE_URL": UI,
        }}]}

    def load(self, values):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "http.local.json"
            path.write_text(json.dumps(values), encoding="utf-8")
            return load_http_config(path)

    def test_safe_defaults_and_secrets_not_in_repr(self):
        config = self.load(self.values())
        self.assertEqual((config.host, config.port, config.clients[0].mode), ("127.0.0.1", 8765, "read-only"))
        self.assertFalse(config.clients[0].enable_publish)
        self.assertNotIn(TOKEN_A, repr(config))
        self.assertNotIn(CONFIG.api_key, repr(config.clients[0]))
        with tempfile.TemporaryDirectory() as folder:
            upper = AgentWorkflow(FakePlaneMCP(), CONFIG, UI, Path(folder), state_namespace="http-client:Alice")
            lower = AgentWorkflow(FakePlaneMCP(), CONFIG, UI, Path(folder), state_namespace="http-client:alice")
            legacy = AgentWorkflow(FakePlaneMCP(), CONFIG, UI, Path(folder))
            self.assertEqual(len({upper.store.scope, lower.store.scope, legacy.store.scope}), 3)

    def test_bad_client_configs_and_shared_tokens_rejected_without_values(self):
        variants = []
        for token in ("short-secret", "REPLACE_WITH_A_RANDOM_TOKEN_GENERATED_LOCALLY", "secret with spaces" * 3):
            value = self.values()
            value["clients"][0]["bearer_token"] = token
            variants.append(value)
        value = self.values()
        value["clients"].append({**value["clients"][0], "name": "bob"})
        variants.append(value)
        value = self.values()
        value["clients"][0]["enable_publish"] = True
        variants.append(value)
        value = self.values()
        value["clients"][0]["plane"]["PLANE_BASE_URL"] = "http://secret@plane.lab"
        variants.append(value)
        for value in variants:
            with self.subTest(value=value):
                with self.assertRaises(HttpConfigError) as caught:
                    self.load(value)
                self.assertNotIn(CONFIG.api_key, str(caught.exception))
                self.assertNotIn(TOKEN_A, str(caught.exception))

    def test_bad_listener_and_wildcard_rejected(self):
        for field, item in (("port", True), ("port", 0), ("port", 65536), ("allowed_hosts", ["*"]), ("allowed_hosts", []), ("allowed_origins", ["*"]), ("clients", [])):
            value = self.values()
            value[field] = item
            with self.subTest(field=field, item=item), self.assertRaises(HttpConfigError):
                self.load(value)


class HTTPTests(unittest.IsolatedAsyncioTestCase):
    def factory(self, upstreams):
        @asynccontextmanager
        async def factory(client, state_dir):
            upstream = upstreams[client.name]
            if client.mode == "read-only":
                proxy = ReadOnlyPlaneProxy(upstream)
                await proxy.discover()
                yield create_read_only_server(proxy)
            else:
                workflow = AgentWorkflow(upstream, client.plane, client.ui_origin, state_dir, enable_publish=client.enable_publish, state_namespace="http-client:" + client.name)
                await workflow.discover()
                yield create_agent_server(workflow)
        return factory

    async def test_auth_every_request_and_host_origin_validation(self):
        with tempfile.TemporaryDirectory() as folder:
            config = HttpConfig((client("alice", TOKEN_A),), Path(folder))
            fake = FakePlaneMCP()
            async with running_app(config, self.factory({"alice": fake})) as (url, app):
                async with httpx.AsyncClient(trust_env=False) as http:
                    self.assertEqual((await http.get(url + "/healthz")).status_code, 200)
                    for method in ("GET", "POST", "DELETE"):
                        for headers in ({}, {"Authorization": "Bearer " + TOKEN_B}, {"Authorization": "Basic " + TOKEN_A}):
                            response = await http.request(method, url + "/mcp", headers=headers, content=b"{}")
                            self.assertEqual(response.status_code, 401)
                            self.assertIn("Bearer", response.headers["www-authenticate"])
                    response = await http.post(url + "/mcp", headers=[("Authorization", "Bearer " + TOKEN_A), ("Authorization", "Bearer " + TOKEN_B)])
                    self.assertEqual(response.status_code, 401)
                    headers = {"Authorization": "Bearer " + TOKEN_A, "Content-Type": "application/json", "Accept": "application/json, text/event-stream"}
                    response = await http.post(url + "/mcp", headers={**headers, "Host": "attacker.example"}, content=b"{}")
                    self.assertEqual(response.status_code, 421)
                    response = await http.post(url + "/mcp", headers={**headers, "Origin": "https://attacker.example"}, content=b"{}")
                    self.assertEqual(response.status_code, 403)
                    # Knowing another request's/session's metadata never replaces auth.
                    response = await http.post(url + "/mcp", headers={"Mcp-Session-Id": "stolen"}, content=b"{}")
                    self.assertEqual(response.status_code, 401)
                self.assertEqual(fake.calls, [])

    async def test_real_http_read_only_tools_and_write_denial(self):
        with tempfile.TemporaryDirectory() as folder:
            config = HttpConfig((client("reader", TOKEN_A, mode="read-only", publish=False),), Path(folder))
            fake = FakePlaneMCP()
            async with running_app(config, self.factory({"reader": fake})) as (url, app):
                async with session(url, TOKEN_A) as connection:
                    names = {t.name for t in (await connection.list_tools()).tools}
                    self.assertEqual(names, {"plane_demo_read_only_policy", "project", "workitem", "workitem_comment", "state"})
                    result = unpack(await connection.call_tool("project", {"action": "list"}))
                    self.assertEqual(result["results"][0]["name"], "Materials")
                    for name, args in (("workitem_comment", {"action": "create", "project_id": "p", "workitem_id": "t", "comment_html": "bad"}), ("publish_progress", {"draft_id": "a" * 64, "approved": True})):
                        self.assertTrue((await connection.call_tool(name, args)).isError)
                self.assertEqual(fake.writes, [])

    async def test_real_http_isolation_publish_and_retry_across_connections(self):
        with tempfile.TemporaryDirectory() as folder:
            config = HttpConfig((client("alice", TOKEN_A), client("bob", TOKEN_B)), Path(folder))
            alice, bob = FakePlaneMCP(), FakePlaneMCP()
            bob.item["name"] = "Bob's separate context"
            async with running_app(config, self.factory({"alice": alice, "bob": bob})) as (url, app):
                async with session(url, TOKEN_A) as a, session(url, TOKEN_B) as b:
                    results = await asyncio.gather(a.call_tool("read_task_context", {"task_url": BROWSE}), b.call_tool("read_task_context", {"task_url": BROWSE}))
                    self.assertEqual(unpack(results[0])["task"]["id"], TASK)
                    self.assertEqual(unpack(results[1])["task"]["name"], "Bob's separate context")
                    draft = unpack(await a.call_tool("prepare_progress", {"task_url": URL, "progress": "Student-reviewed report"}))
                    self.assertTrue((await b.call_tool("publish_progress", {"draft_id": draft["draft_id"], "approved": True})).isError)
                    self.assertTrue((await a.call_tool("publish_progress", {"draft_id": draft["draft_id"], "approved": False})).isError)
                    published = unpack(await a.call_tool("publish_progress", {"draft_id": draft["draft_id"], "approved": True}))
                    self.assertTrue(published["read_back"])
                async with session(url, TOKEN_A) as reconnected:
                    repeated = unpack(await reconnected.call_tool("publish_progress", {"draft_id": draft["draft_id"], "approved": True}))
                    self.assertEqual(repeated["comment_id"], published["comment_id"])
                    self.assertTrue(repeated["reused"])
                self.assertEqual(len(alice.writes), 1)
                self.assertEqual(len(bob.writes), 0)

    async def test_agent_read_only_mode_and_trailing_slash(self):
        with tempfile.TemporaryDirectory() as folder:
            config = HttpConfig((client("alice", TOKEN_A, publish=False),), Path(folder))
            async with running_app(config, self.factory({"alice": FakePlaneMCP()})) as (url, app):
                async with httpx.AsyncClient(headers={"Authorization": "Bearer " + TOKEN_A}, trust_env=False) as http:
                    async with streamable_http_client(url + "/mcp/", http_client=http) as streams:
                        async with ClientSession(*streams[:2]) as connection:
                            await connection.initialize()
                            self.assertEqual([t.name for t in (await connection.list_tools()).tools], ["read_task_context"])
                            self.assertTrue((await connection.call_tool("prepare_progress", {"task_url": URL, "progress": "blocked"})).isError)

    async def test_pinned_official_stdio_upstream_discovery_through_http(self):
        # Real official package and subprocess, with deliberately fake Plane
        # credentials. Tool discovery/policy must not read or write Plane data.
        with tempfile.TemporaryDirectory() as folder:
            config = HttpConfig((client("reader", TOKEN_A, mode="read-only", publish=False),), Path(folder))
            async with running_app(config) as (url, app):
                async with session(url, TOKEN_A) as connection:
                    names = {t.name for t in (await connection.list_tools()).tools}
                    self.assertEqual(names, {"plane_demo_read_only_policy", "project", "workitem", "workitem_comment", "state"})
                    policy = unpack(await connection.call_tool("plane_demo_read_only_policy", {}))
                    self.assertEqual(policy["upstream"], "plane-mcp-server==0.3.4")


if __name__ == "__main__":
    unittest.main()
