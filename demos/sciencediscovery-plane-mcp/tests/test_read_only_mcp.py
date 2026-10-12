"""Offline policy tests; no Plane credentials, network or writes are used."""

from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from mcp.types import CallToolResult, TextContent, Tool

from read_only_mcp import POLICY_TOOL, ReadOnlyPlaneProxy, create_server, public_tool


def fake_tool(name: str, actions: list[str] | None = None) -> Tool:
    return Tool(
        name=name,
        description="Create, update and delete resources using this official tool.",
        inputSchema={
            "type": "object",
            "properties": {
                "action": {"type": "string", "enum": actions or ["list", "retrieve", "create", "delete"]},
                "project_id": {"type": "string", "default": ""},
                "workitem_id": {"type": "string", "default": ""},
                "comment_id": {"type": "string", "default": ""},
                "state_id": {"type": "string", "default": ""},
                "cursor": {"type": "string", "default": ""},
                "per_page": {"type": "integer", "default": 0},
                "order_by": {"type": "string", "default": ""},
                "expand": {"type": "string", "default": ""},
                "fields": {"type": "string", "default": ""},
                "name": {"type": "string", "default": ""},
                "pql": {"type": "string", "default": ""},
                "command": {"type": "string", "default": ""},
            },
            "required": ["action"],
        },
    )


class SchemaTests(unittest.TestCase):
    def test_schema_is_copied_and_reduced(self):
        upstream = fake_tool("workitem")
        public = public_tool(upstream)
        self.assertIsNotNone(public)
        self.assertEqual(public.inputSchema["properties"]["action"]["enum"], ["list", "retrieve"])
        self.assertFalse(public.inputSchema["additionalProperties"])
        for field in ("name", "pql", "command", "comment_id"):
            self.assertNotIn(field, public.inputSchema["properties"])
        self.assertTrue(public.annotations.readOnlyHint)
        self.assertFalse(public.annotations.destructiveHint)
        self.assertNotIn("create", public.description.lower())
        self.assertIn("create", upstream.inputSchema["properties"]["action"]["enum"])
        self.assertIn("name", upstream.inputSchema["properties"])

    def test_unknown_tool_hidden(self):
        self.assertIsNone(public_tool(fake_tool("run_sql")))
        self.assertIsNone(public_tool(fake_tool("create_work_item")))

    def test_only_discovered_actions_are_exposed(self):
        public = public_tool(fake_tool("project", ["retrieve", "delete"]))
        self.assertEqual(public.inputSchema["properties"]["action"]["enum"], ["retrieve"])

    def test_changed_signature_is_hidden(self):
        upstream = fake_tool("workitem")
        del upstream.inputSchema["properties"]["workitem_id"]
        self.assertIsNone(public_tool(upstream))


class ProxyTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.result = CallToolResult(
            content=[TextContent(type="text", text='{"id":"task-1"}')],
            structuredContent={"id": "task-1"},
        )
        self.upstream = SimpleNamespace(
            list_tools=AsyncMock(
                return_value=SimpleNamespace(
                    tools=[fake_tool(name) for name in ("project", "workitem", "workitem_comment", "state", "sql")],
                    nextCursor=None,
                )
            ),
            call_tool=AsyncMock(return_value=self.result),
        )
        self.proxy = ReadOnlyPlaneProxy(self.upstream)
        await self.proxy.discover()

    async def test_read_call_is_forwarded_unchanged(self):
        arguments = {"action": "retrieve", "project_id": "project-1", "workitem_id": "task-1"}
        self.assertIs(await self.proxy.call_tool("workitem", arguments), self.result)
        self.upstream.call_tool.assert_awaited_once_with("workitem", arguments)

    async def test_all_four_resources_can_forward_reads(self):
        for name, args in (
            ("project", {"action": "list", "per_page": 5}),
            ("state", {"action": "list", "project_id": "project-1"}),
            ("workitem_comment", {"action": "retrieve", "project_id": "p", "workitem_id": "w", "comment_id": "c"}),
        ):
            self.assertIs(await self.proxy.call_tool(name, args), self.result)
        self.assertEqual(self.upstream.call_tool.await_count, 3)

    async def test_write_actions_blocked_even_when_not_advertised(self):
        for name in ("project", "workitem", "workitem_comment", "state"):
            for action in ("create", "update", "delete", "archive", "manage_assignee", "get", "sql"):
                result = await self.proxy.call_tool(name, {"action": action})
                self.assertTrue(result.isError)
        self.upstream.call_tool.assert_not_awaited()

    async def test_unknown_tools_blocked(self):
        for name in ("sql", "create_work_item", "PROJECT", "__getattr__"):
            self.assertTrue((await self.proxy.call_tool(name, {"action": "list"})).isError)
        self.upstream.call_tool.assert_not_awaited()

    async def test_unexpected_fields_and_missing_ids_blocked(self):
        cases = (
            {"action": "retrieve", "project_id": "p", "workitem_id": "w", "command": "write"},
            {"action": "retrieve", "project_id": "p", "workitem_id": "w", "sql": "write"},
            {"action": "retrieve", "project_id": "p", "workitem_id": "w", "name": "rename"},
            {"action": "list", "project_id": "p", "pql": "arbitrary query"},
            {"action": "list"},
            {"action": "retrieve", "project_id": "p", "workitem_id": " "},
            {"action": "list", "project_id": "p", "per_page": "wrong type"},
            {"action": ["retrieve"], "project_id": "p", "workitem_id": "w"},
        )
        for arguments in cases:
            self.assertTrue((await self.proxy.call_tool("workitem", arguments)).isError)
        self.upstream.call_tool.assert_not_awaited()

    async def test_action_specific_fields_are_checked(self):
        # project_id is in the combined schema, but not accepted by project list.
        result = await self.proxy.call_tool("project", {"action": "list", "project_id": "p"})
        self.assertTrue(result.isError)
        self.upstream.call_tool.assert_not_awaited()

    async def test_policy_is_local_and_no_arguments_allowed(self):
        result = await self.proxy.call_tool(POLICY_TOOL)
        policy = json.loads(result.content[0].text)
        self.assertTrue(policy["read_only"])
        self.assertEqual(policy["policy_version"], "1")
        self.assertEqual(policy["allowed_actions"]["workitem"], ["list", "retrieve"])
        self.assertEqual(result.structuredContent, policy)
        self.assertTrue((await self.proxy.call_tool(POLICY_TOOL, {"secret": "value"})).isError)
        self.upstream.call_tool.assert_not_awaited()

    async def test_no_secret_from_upstream_exception(self):
        self.upstream.call_tool.side_effect = RuntimeError("Bearer SECRET_TO_REDACT")
        result = await self.proxy.call_tool("project", {"action": "list"})
        self.assertTrue(result.isError)
        self.assertNotIn("SECRET_TO_REDACT", result.model_dump_json())

    async def test_schema_returned_to_client_cannot_mutate_policy(self):
        tools = self.proxy.list_tools()
        workitem = next(tool for tool in tools if tool.name == "workitem")
        workitem.inputSchema["properties"]["action"]["enum"].append("create")
        self.assertTrue((await self.proxy.call_tool("workitem", {"action": "create"})).isError)

    async def test_requires_upstream_core_tools(self):
        self.upstream.list_tools.return_value = SimpleNamespace(tools=[fake_tool("state")], nextCursor=None)
        with self.assertRaises(RuntimeError):
            await self.proxy.discover()

    async def test_discovery_supports_pagination(self):
        self.upstream.list_tools.side_effect = (
            SimpleNamespace(tools=[fake_tool("project")], nextCursor="next"),
            SimpleNamespace(tools=[fake_tool("workitem")], nextCursor=None),
        )
        await self.proxy.discover()
        self.upstream.list_tools.assert_awaited_with(cursor="next")
        self.assertEqual(set(self.proxy.policy()["allowed_actions"]), {"project", "workitem"})

    async def test_server_name_is_explicit(self):
        self.assertEqual(create_server(self.proxy).name, "plane-demo-read-only")


if __name__ == "__main__":
    unittest.main()
