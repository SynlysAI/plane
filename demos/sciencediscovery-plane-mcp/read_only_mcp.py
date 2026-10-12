"""A small, fail-closed STDIO facade for the official Plane MCP server.

The facade is deliberately independent of Plane credentials and HTTP routing:
the official server remains responsible for both. Only its four explicitly
listed resources and their list/retrieve actions can cross this boundary.
"""

from __future__ import annotations

import asyncio
import copy
import json
import os
import sys
from collections.abc import Mapping, Sequence
from importlib.metadata import version
from typing import Any, Protocol

from jsonschema import Draft202012Validator
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client
from mcp.server.lowlevel import Server
from mcp.server.stdio import stdio_server
from mcp.types import CallToolResult, TextContent, Tool, ToolAnnotations

SERVER_NAME = "plane-demo-read-only"
POLICY_TOOL = "plane_demo_read_only_policy"
UPSTREAM_PACKAGE = "plane-mcp-server"
UPSTREAM_VERSION = "0.3.4"

# This is an operation allowlist, not a name-based guess about read semantics.
# Version 0.3.4 uses workitem_id externally; work_item_id is its SDK parameter.
ACTION_FIELDS: dict[str, dict[str, tuple[str, ...]]] = {
    "project": {
        "list": ("cursor", "per_page", "order_by"),
        "retrieve": ("project_id",),
    },
    "workitem": {
        "list": ("project_id", "cursor", "per_page", "order_by", "expand", "fields"),
        "retrieve": ("project_id", "workitem_id", "expand", "fields"),
    },
    "workitem_comment": {
        "list": ("project_id", "workitem_id", "cursor", "per_page"),
        "retrieve": ("project_id", "workitem_id", "comment_id"),
    },
    "state": {
        "list": ("project_id", "cursor", "per_page"),
        "retrieve": ("project_id", "state_id"),
    },
}
REQUIRED_FIELDS: dict[tuple[str, str], tuple[str, ...]] = {
    ("project", "retrieve"): ("project_id",),
    ("workitem", "list"): ("project_id",),
    ("workitem", "retrieve"): ("project_id", "workitem_id"),
    ("workitem_comment", "list"): ("project_id", "workitem_id"),
    ("workitem_comment", "retrieve"): ("project_id", "workitem_id", "comment_id"),
    ("state", "list"): ("project_id",),
    ("state", "retrieve"): ("project_id", "state_id"),
}


class Upstream(Protocol):
    async def list_tools(self, **kwargs: Any) -> Any: ...

    async def call_tool(self, name: str, arguments: dict[str, Any]) -> CallToolResult: ...


def error_result(message: str) -> CallToolResult:
    return CallToolResult(isError=True, content=[TextContent(type="text", text=message)])


def public_tool(tool: Tool) -> Tool | None:
    """Copy the discovered schema, removing every unapproved operation/field."""
    permitted = ACTION_FIELDS.get(tool.name)
    if permitted is None:
        return None
    schema = copy.deepcopy(tool.inputSchema)
    properties = schema.get("properties", {})
    action_schema = properties.get("action", {})
    upstream_actions = action_schema.get("enum", [])
    if not isinstance(upstream_actions, list):
        return None
    actions = [action for action in permitted if action in upstream_actions]
    if not actions:
        return None
    fields = {"action"}
    for action in actions:
        fields.update(permitted[action])
    # A changed upstream signature must never silently weaken this boundary.
    for action in actions:
        if any(field not in properties for field in REQUIRED_FIELDS.get((tool.name, action), ())):
            return None
    schema["properties"] = {key: value for key, value in properties.items() if key in fields}
    schema["properties"]["action"] = {"type": "string", "enum": actions}
    schema["required"] = sorted(set(schema.get("required", [])) & fields | {"action"})
    schema["additionalProperties"] = False
    description = (
        f"Read-only Plane {tool.name}. Allowed actions: {', '.join(actions)}. "
        "All writes are blocked by this proxy. Use project_id and, for work items, workitem_id. "
        "workitem list requires project_id; PQL is not supported by this demo."
    )
    # Do not retain the original description: it teaches the model write actions.
    return tool.model_copy(
        deep=True,
        update={
            "description": description,
            "inputSchema": schema,
            "annotations": ToolAnnotations(
                readOnlyHint=True,
                destructiveHint=False,
                idempotentHint=True,
                openWorldHint=True,
            ),
        },
    )


class ReadOnlyPlaneProxy:
    def __init__(self, upstream: Upstream):
        self.upstream = upstream
        self._tools: dict[str, Tool] = {}

    async def discover(self) -> None:
        cursor: str | None = None
        seen_cursors: set[str] = set()
        discovered: dict[str, Tool] = {}
        while True:
            page = await self.upstream.list_tools(**({"cursor": cursor} if cursor else {}))
            for tool in page.tools:
                exposed = public_tool(tool)
                if exposed is not None:
                    if exposed.name in discovered:
                        raise RuntimeError("Duplicate upstream resource")
                    Draft202012Validator.check_schema(exposed.inputSchema)
                    discovered[exposed.name] = exposed
            cursor = getattr(page, "nextCursor", None)
            if not cursor:
                break
            if cursor in seen_cursors:
                raise RuntimeError("Repeated upstream catalogue cursor")
            seen_cursors.add(cursor)
        # The project and work item reads are the minimum useful demo surface.
        if any(
            name not in discovered
            or "retrieve" not in discovered[name].inputSchema["properties"]["action"]["enum"]
            for name in ("project", "workitem")
        ):
            raise RuntimeError("Required upstream read tools unavailable")
        self._tools = discovered

    def policy(self) -> dict[str, Any]:
        return {
            "policy_version": "1",
            "read_only": True,
            "server_name": SERVER_NAME,
            "upstream": f"{UPSTREAM_PACKAGE}=={UPSTREAM_VERSION}",
            "allowed_actions": {
                name: list(tool.inputSchema["properties"]["action"]["enum"])
                for name, tool in self._tools.items()
            },
        }

    def list_tools(self) -> list[Tool]:
        policy_tool = Tool(
            name=POLICY_TOOL,
            description="Return the local proxy policy. Does not contact Plane or change data.",
            inputSchema={"type": "object", "properties": {}, "additionalProperties": False},
            annotations=ToolAnnotations(
                readOnlyHint=True, destructiveHint=False, idempotentHint=True, openWorldHint=False
            ),
        )
        return [policy_tool, *(tool.model_copy(deep=True) for tool in self._tools.values())]

    async def call_tool(self, name: str, arguments: Mapping[str, Any] | None = None) -> CallToolResult:
        if arguments is None:
            arguments = {}
        if not isinstance(arguments, Mapping):
            return error_result("Read-only policy: arguments must be an object.")
        if name == POLICY_TOOL:
            if arguments:
                return error_result("Read-only policy: the policy tool accepts no arguments.")
            policy = self.policy()
            return CallToolResult(
                content=[TextContent(type="text", text=json.dumps(policy, ensure_ascii=False))],
                structuredContent=policy,
            )
        tool = self._tools.get(name)
        if tool is None:
            return error_result("Read-only policy: unknown or hidden tool.")
        action = arguments.get("action")
        # Never trust a client to have followed tools/list or its action enum.
        if not isinstance(action, str) or action not in ACTION_FIELDS[name]:
            return error_result("Read-only policy: action is not allowed.")
        if action not in tool.inputSchema["properties"]["action"]["enum"]:
            return error_result("Read-only policy: action is unavailable upstream.")
        accepted = {"action", *ACTION_FIELDS[name][action]}
        if set(arguments) - accepted:
            return error_result("Read-only policy: unexpected arguments for this action.")
        values = dict(arguments)
        if not Draft202012Validator(tool.inputSchema).is_valid(values):
            return error_result("Read-only policy: arguments do not match the read schema.")
        if any(
            not isinstance(values.get(field), str) or not values[field].strip()
            for field in REQUIRED_FIELDS.get((name, action), ())
        ):
            return error_result("Read-only policy: required resource identifiers are missing.")
        try:
            return await self.upstream.call_tool(name, values)
        except Exception:
            # Upstream exception text may contain an HTTP header or credential.
            return error_result("Plane read failed. Check the local service and configured credentials.")


def create_server(proxy: ReadOnlyPlaneProxy) -> Server:
    server = Server(SERVER_NAME, version="1.0.0")

    @server.list_tools()
    async def list_tools() -> Sequence[Tool]:
        return proxy.list_tools()

    @server.call_tool(validate_input=False)
    async def call_tool(name: str, arguments: dict[str, Any]) -> CallToolResult:
        return await proxy.call_tool(name, arguments)

    return server


async def serve() -> None:
    if version(UPSTREAM_PACKAGE) != UPSTREAM_VERSION:
        raise RuntimeError("Install the pinned upstream version first")
    if not os.environ.get("PLANE_API_KEY") or not os.environ.get("PLANE_WORKSPACE_SLUG"):
        raise RuntimeError("Missing Plane configuration")
    parameters = StdioServerParameters(
        command=sys.executable,
        args=["-m", "plane_mcp", "stdio"],
        env=dict(os.environ),
    )
    # Only MCP frames go to stdout. Suppress upstream diagnostic output, which
    # is outside this proxy's control and may contain sensitive HTTP metadata.
    with open(os.devnull, "w", encoding="utf-8") as diagnostics:
        async with stdio_client(parameters, errlog=diagnostics) as (reader, writer):
            async with ClientSession(reader, writer) as session:
                await session.initialize()
                proxy = ReadOnlyPlaneProxy(session)
                await proxy.discover()
                server = create_server(proxy)
                async with stdio_server() as (incoming, outgoing):
                    await server.run(incoming, outgoing, server.create_initialization_options())


def main() -> int:
    try:
        asyncio.run(serve())
        return 0
    except KeyboardInterrupt:
        return 0
    except Exception:
        sys.stderr.write(
            "Plane read-only proxy could not start. Check dependencies, Plane configuration, and connectivity.\n"
        )
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
