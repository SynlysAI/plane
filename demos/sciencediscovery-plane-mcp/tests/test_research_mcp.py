"""Offline read-facade boundary tests, with no Plane or SD connection."""

import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from plane_client import PlaneError
from research_mcp import ResearchReadProxy


def read_tool():
    return {
        "name": "get_research_node_context", "description": "Read a node",
        "inputSchema": {"type": "object", "properties": {"node_id": {"type": "string"}},
                        "required": ["node_id"], "additionalProperties": False},
        "annotations": {"readOnlyHint": True, "destructiveHint": False},
    }


class ResearchProxyTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.client = SimpleNamespace(tools=AsyncMock(return_value=[read_tool()]),
                                      call_tool=AsyncMock(return_value={"data": {"id": "node"}}))
        self.proxy = ResearchReadProxy(self.client)
        await self.proxy.discover()

    async def test_extra_arguments_or_unknown_writes_never_reach_backend(self):
        for name, args in [("delete_node", {"node_id": "node"}),
                           ("get_research_node_context", {"node_id": "node", "user_id": "other"}),
                           ("get_research_node_context", {})]:
            self.assertTrue((await self.proxy.call_tool(name, args)).isError)
        self.client.call_tool.assert_not_awaited()

    async def test_catalogue_copy_cannot_expand_tool_schema(self):
        self.proxy.list_tools()[0].inputSchema["additionalProperties"] = True
        result = await self.proxy.call_tool("get_research_node_context", {"node_id": "node", "url": "private"})
        self.assertTrue(result.isError)
        self.client.call_tool.assert_not_awaited()

    async def test_valid_read_keeps_structured_source_result(self):
        result = await self.proxy.call_tool("get_research_node_context", {"node_id": "node"})
        self.assertFalse(result.isError)
        self.assertEqual(result.structuredContent, {"data": {"id": "node"}})

    async def test_raw_upstream_error_is_withheld(self):
        self.client.call_tool.side_effect = RuntimeError("Bearer SECRET_NEVER_EXPOSE")
        result = await self.proxy.call_tool("get_research_node_context", {"node_id": "node"})
        self.assertTrue(result.isError)
        self.assertNotIn("SECRET_NEVER_EXPOSE", result.model_dump_json())

    async def test_unexpected_catalogue_is_rejected(self):
        invalid = read_tool()
        invalid["name"] = "delete_node"
        self.client.tools.return_value = [invalid]
        with self.assertRaises(PlaneError):
            await self.proxy.discover()


if __name__ == "__main__":
    unittest.main()
