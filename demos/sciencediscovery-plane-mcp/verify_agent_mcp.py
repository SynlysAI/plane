"""Read-only live verification of the agent workflow's actual STDIO entrypoint."""

from __future__ import annotations

import argparse
import asyncio
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import sys

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

from agent_workflow import WorkflowError, unpack


def safe_failure(error: BaseException) -> str:
    """TaskGroup transports wrap even safe workflow failures in ExceptionGroups."""
    if isinstance(error, WorkflowError):
        return str(error)
    children = getattr(error, "exceptions", ())
    if len(children) == 1:
        return safe_failure(children[0])
    return "Protocol, configuration, timeout, or file failure; raw details withheld."


async def verify(config: Path, task_url: str) -> dict:
    root = Path(__file__).resolve().parent
    parameters = StdioServerParameters(command=sys.executable, args=[str(root / "agent_mcp.py"), "--config", str(config.resolve())], env=dict(os.environ))
    with open(os.devnull, "w", encoding="utf-8") as diagnostics:
        async with stdio_client(parameters, errlog=diagnostics) as streams:
            async with ClientSession(*streams) as session:
                await session.initialize()
                discovered = await session.list_tools()
                names = {tool.name for tool in discovered.tools}
                if names not in ({"read_task_context"}, {"read_task_context", "prepare_progress", "publish_progress"}):
                    raise WorkflowError("Unexpected workflow tool surface.")
                for tool in discovered.tools:
                    if tool.annotations is None or tool.annotations.readOnlyHint != (tool.name == "read_task_context"):
                        raise WorkflowError("Tool read/write annotations did not match the workflow.")
                context = unpack(await session.call_tool("read_task_context", {"task_url": task_url}))
                if context.get("context_scope", {}).get("comments_complete") is not True:
                    raise WorkflowError("Task comments were not completely read.")
                return {
                    "ok": True, "checked_at": datetime.now(timezone.utc).isoformat(),
                    "tools": sorted(names), "project_id": context["project"]["id"],
                    "workitem_id": context["task"]["id"], "comment_count": len(context["comments"]),
                    "context_scope": context["context_scope"], "plane_writes": False,
                }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--task-url", required=True)
    parser.add_argument("--output", type=Path, default=Path(__file__).resolve().parent / "output" / "agent-read-verification.json")
    parser.add_argument("--timeout", type=int, default=120)
    args = parser.parse_args()
    if args.output.resolve() == args.config.resolve() or not 1 <= args.timeout <= 600:
        parser.error("Output must differ from private configuration; timeout must be 1..600 seconds.")
    try:
        async def bounded():
            async with asyncio.timeout(args.timeout):
                return await verify(args.config, args.task_url)
        evidence = asyncio.run(bounded())
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(evidence, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print("Agent MCP verified: real STDIO task context read; no Plane writes. Evidence saved.")
        return 0
    except Exception as exc:
        print("Agent MCP verification stopped: " + safe_failure(exc), file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
