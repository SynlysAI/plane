"""Weekly-only STDIO catalogue, bounded HTTP adapter and recovery semantics."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from plane_client import PlaneError
from weekly_report_mcp import (
    READ_TOOLS,
    WEEKLY_TOOLS,
    WeeklyProxyError,
    WeeklyReportProxy,
    load_client,
)


def catalogue():
    return [
        {
            "name": name,
            "description": "test",
            "inputSchema": {
                "type": "object",
                "properties": {"operation_id": {"type": "string", "format": "uuid"}},
                "required": ["operation_id"],
                "additionalProperties": False,
            },
            "annotations": {"readOnlyHint": name in READ_TOOLS},
        }
        for name in sorted(WEEKLY_TOOLS)
    ]


class WeeklyProxyTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.client = AsyncMock()
        self.client.tools.return_value = catalogue()
        self.proxy = WeeklyReportProxy(self.client)
        await self.proxy.discover()

    async def test_catalogue_is_closed_and_cannot_replace_body(self):
        assert len(self.proxy.list_tools()) == 5
        args = {
            "operation_id": "00000000-0000-4000-8000-000000000001",
            "body_markdown": "swap",
        }
        result = await self.proxy.call_tool("execute_weekly_report_operation", args)
        assert (
            result.isError
            and result.structuredContent["error_code"] == "invalid_arguments"
        )
        self.client.call_tool.assert_not_awaited()

    async def test_node_tools_or_wrong_readonly_hint_reject_discovery(self):
        for mutate in ("node", "hint"):
            tools = catalogue()
            if mutate == "node":
                tools[0]["name"] = "execute_research_operation"
            else:
                tools[0]["annotations"]["readOnlyHint"] = not tools[0]["annotations"][
                    "readOnlyHint"
                ]
            self.client.tools.return_value = tools
            with self.assertRaises(PlaneError):
                await self.proxy.discover()

    async def test_committed_pending_survives_proxy_and_timeout_has_recovery_id(self):
        identity = "00000000-0000-4000-8000-000000000001"
        value = {
            "status": "COMMITTED",
            "readback": "pending",
            "result": {"snapshot_version": 1},
        }
        self.client.call_tool.return_value = value
        result = await self.proxy.call_tool(
            "execute_weekly_report_operation", {"operation_id": identity}
        )
        assert result.isError is False and result.structuredContent == value
        self.client.call_tool.side_effect = WeeklyProxyError(
            "temporarily_unavailable", operation_id=identity
        )
        result = await self.proxy.call_tool(
            "get_weekly_report_operation", {"operation_id": identity}
        )
        assert result.isError and result.structuredContent["operation_id"] == identity


class WeeklyClientTests(unittest.IsolatedAsyncioTestCase):
    def client(self):
        return load_client(
            environ={
                "PLANE_BASE_URL": "http://plane.test",
                "PLANE_WORKSPACE_SLUG": "test",
                "WEEKLY_REPORT_TOKEN": "pwr_" + "a" * 43,
            }
        )

    async def test_dedicated_header_namespace_and_budget_above_legacy_limit(self):
        client = self.client()
        actual_client = httpx.AsyncClient

        def handler(request):
            assert request.headers["X-Weekly-Report-Token"].startswith("pwr_")
            assert "X-Api-Key" not in request.headers
            assert "/weekly-report-agent/" in str(request.url)
            return httpx.Response(200, json={"body": "x" * 300000})

        with patch(
            "weekly_report_mcp.httpx.AsyncClient",
            side_effect=lambda **kw: actual_client(
                **kw, transport=httpx.MockTransport(handler)
            ),
        ):
            value = await client.call_tool(
                "get_weekly_report_operation", {"operation_id": "test"}
            )
        assert len(value["body"]) == 300000

    async def test_over_budget_redirect_and_echoed_secrets_are_not_forwarded(self):
        actual_client = httpx.AsyncClient
        for status, value, expected in (
            (200, {"body": "x" * (2 * 1024 * 1024)}, "response_too_large"),
            (302, {"error_code": "redirect", "message": "pwr_secret"}, "redirect"),
            (
                403,
                {"error_code": "scope_denied", "message": "pwr_secret"},
                "scope_denied",
            ),
        ):
            with (
                patch(
                    "weekly_report_mcp.httpx.AsyncClient",
                    side_effect=lambda status=status, value=value, **kw: actual_client(
                        **kw,
                        transport=httpx.MockTransport(
                            lambda request: httpx.Response(status, json=value)
                        ),
                    ),
                ),
                self.assertRaises(WeeklyProxyError) as error,
            ):
                await self.client().call_tool("get_weekly_report_operation", {})
            assert error.exception.code == expected and "pwr_secret" not in str(
                error.exception
            )

    async def test_old_node_credentials_are_not_accepted_as_weekly_config(self):
        with self.assertRaises(PlaneError):
            load_client(
                environ={
                    "PLANE_BASE_URL": "http://plane.test",
                    "PLANE_WORKSPACE_SLUG": "test",
                    "RESEARCH_CONTEXT_TOKEN": "node",
                    "PLANE_API_KEY": "old",
                }
            )


if __name__ == "__main__":
    unittest.main()
