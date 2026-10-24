"""Operations proxy boundaries; no real credentials or network calls."""

import json
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from plane_client import PlaneError
from research_operations_mcp import OPERATION_TOOLS, READ_OPERATION_TOOLS, ResearchOperationProxy, load_client


def tools():
    return [{"name": name, "description": "Operation", "inputSchema": {"type": "object", "properties": {
        "operation_id": {"type": "string"}}, "additionalProperties": False},
        "annotations": {"readOnlyHint": name in READ_OPERATION_TOOLS}} for name in sorted(OPERATION_TOOLS)]


class OperationProxyTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.client = SimpleNamespace(tools=AsyncMock(return_value=tools()), call_tool=AsyncMock(return_value={"status": "PROPOSED"}))
        self.proxy = ResearchOperationProxy(self.client)
        await self.proxy.discover()

    async def test_no_approval_or_unadvertised_tool_reaches_backend(self):
        result = await self.proxy.call_tool("approve_research_operation", {})
        self.assertTrue(result.isError)
        self.client.call_tool.assert_not_awaited()

    async def test_execute_cannot_supply_replacement_payload_or_approved_flag(self):
        result = await self.proxy.call_tool("execute_research_operation", {"operation_id": "id", "approved": True, "payload": {}})
        self.assertTrue(result.isError)
        self.client.call_tool.assert_not_awaited()

    async def test_execute_submits_operation_without_platform_approval(self):
        self.client.call_tool.return_value = {"status": "COMMITTED"}
        result = await self.proxy.call_tool("execute_research_operation", {"operation_id": "prepared-id"})
        self.assertFalse(result.isError)
        self.client.call_tool.assert_awaited_once_with("execute_research_operation", {"operation_id": "prepared-id"})

    async def test_recovery_guidance_is_preserved(self):
        self.client.call_tool.side_effect = PlaneError("research_unavailable", "Query the same operation_id", write_outcome_unknown=True)
        result = await self.proxy.call_tool("execute_research_operation", {"operation_id": "same-id"})
        self.assertTrue(result.isError)
        self.assertIn("same operation_id", result.model_dump_json())

    async def test_false_read_only_annotation_is_rejected(self):
        catalogue = tools()
        next(tool for tool in catalogue if tool["name"] == "execute_research_operation")["annotations"]["readOnlyHint"] = True
        self.client.tools.return_value = catalogue
        with self.assertRaises(PlaneError):
            await self.proxy.discover()

    async def test_unknown_tool_and_incomplete_catalogue_are_rejected(self):
        for catalogue in [tools()[:-1], [*tools(), {**tools()[0], "name": "approve_research_operation"}]]:
            self.client.tools.return_value = catalogue
            with self.assertRaises(PlaneError):
                await self.proxy.discover()


class OperationConfigTests(unittest.TestCase):
    def test_context_connection_cannot_fall_back_to_api_key(self):
        with self.assertRaises(PlaneError):
            load_client(None, environ={"PLANE_BASE_URL": "http://plane.test", "PLANE_WORKSPACE_SLUG": "test", "PLANE_API_KEY": "not-a-write-grant"})

    def test_context_connection_uses_separate_endpoint_and_no_api_key(self):
        client = load_client(None, environ={"PLANE_BASE_URL": "http://plane.test", "PLANE_WORKSPACE_SLUG": "test",
            "RESEARCH_CONTEXT_TOKEN": "test-context-token", "RESEARCH_CONTEXT_HASH": "a" * 64})
        self.assertTrue(client.root.endswith("/agent-operations/"))
        self.assertNotIn("X-Api-Key", client.headers)
        self.assertEqual(client.headers["X-Research-Context-Token"], "test-context-token")

    def test_header_injection_and_nondict_config_are_rejected(self):
        with self.assertRaises(PlaneError):
            load_client(None, environ={"PLANE_BASE_URL": "http://plane.test", "PLANE_WORKSPACE_SLUG": "test",
                "RESEARCH_CONTEXT_TOKEN": "bad\r\nheader", "RESEARCH_CONTEXT_HASH": "a" * 64})
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "config.json"
            path.write_text(json.dumps([]), encoding="utf-8")
            with self.assertRaises(PlaneError):
                load_client(path, environ={})


if __name__ == "__main__":
    unittest.main()
