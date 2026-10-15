"""Exercise the real official Plane MCP, with a separately requested comment write."""
from __future__ import annotations

import argparse
import asyncio
from collections import Counter
from datetime import datetime, timezone
import html
from importlib.metadata import version
import json
import os
from pathlib import Path
import sys
from typing import Any
from urllib.parse import urlsplit

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

from plane_client import PlaneError, load_config
from seed_demo import OWNERSHIP_MARKER, TASKS, task_marker, write_manifest

ROOT = Path(__file__).resolve().parent
COMMENT_MARKER = "[ScienceDiscovery MCP Demo]"


class VerificationError(RuntimeError):
    pass


def payload(result: Any) -> Any:
    """Check MCP errors AND official tools' plain-text application errors."""
    if getattr(result, "isError", False):
        raise VerificationError("MCP tool failed; raw response details are withheld.")
    data = getattr(result, "structuredContent", None)
    if data is None:
        blocks = [block.text for block in result.content if getattr(block, "type", None) == "text"]
        if len(blocks) != 1:
            raise VerificationError("MCP response did not contain one structured result.")
        try:
            data = json.loads(blocks[0])
        except ValueError:
            raise VerificationError("MCP returned an application error or non-JSON result; details withheld.") from None
    while isinstance(data, dict) and set(data) == {"result"}:
        data = data["result"]
    if not isinstance(data, (dict, list)):
        raise VerificationError("MCP result is not a resource or list.")
    return data


async def pages(session: Any, name: str, arguments: dict[str, Any]) -> tuple[list[dict[str, Any]], int]:
    rows: list[dict[str, Any]] = []
    cursors: set[str] = set()
    ids: set[str] = set()
    args = {**arguments, "per_page": 2}
    for page_number in range(1, 501):
        data = payload(await session.call_tool(name, args))
        if isinstance(data, list):
            batch, more = data, False
        else:
            batch, more = data.get("results"), data.get("next_page_results")
            if not isinstance(more, bool):
                raise VerificationError("MCP list omitted pagination metadata.")
        if not isinstance(batch, list):
            raise VerificationError("MCP list has an unexpected resource shape.")
        for row in batch:
            if not isinstance(row, dict) or not isinstance(row.get("id"), str) or row["id"] in ids:
                raise VerificationError("MCP pagination returned invalid or duplicate resources.")
            ids.add(row["id"])
            rows.append(row)
        if not more:
            return rows, page_number
        cursor = data.get("next_cursor")
        if not isinstance(cursor, str) or not cursor or cursor in cursors or not batch:
            raise VerificationError("MCP list repeated or omitted its next cursor.")
        cursors.add(cursor)
        args["cursor"] = cursor
    raise VerificationError("MCP pagination exceeded the demo limit.")


def read_report(path: Path) -> str:
    text = path.read_text(encoding="utf-8-sig")
    if path.suffix.lower() == ".json":
        evidence = json.loads(text)
        if not isinstance(evidence, dict) or evidence.get("ok") is not True or evidence.get("mcp_verified") is not True:
            raise VerificationError("Comment requires a successful, MCP-verified ScienceDiscovery report.")
        text = evidence.get("report", "")
    if not isinstance(text, str) or not text.strip() or len(text) > 30_000:
        raise VerificationError("Comment report must contain 1..30000 characters.")
    return text.strip()


async def comment_once(session: Any, project_id: str, workitem_id: str, text: str, journal: Path) -> dict[str, Any]:
    args = {"action": "list", "project_id": project_id, "workitem_id": workitem_id}

    async def existing_comment() -> dict[str, Any] | None:
        comments, _ = await pages(session, "workitem_comment", args)
        found = [row for row in comments if COMMENT_MARKER in (row.get("comment_html") or "")]
        if len(found) > 1:
            raise VerificationError("Multiple demo comments exist; no further comment was written.")
        return found[0] if found else None

    previous = await existing_comment()
    if previous is not None:
        write_manifest(journal, {"project_id": project_id, "workitem_id": workitem_id, "pending": False, "comment_id": previous["id"]})
        return {"id": previous["id"], "reused": True, "read_back": True}
    if journal.exists():
        raise VerificationError("A previous comment attempt is recorded but not visible. Do not blindly retry the write.")
    write_manifest(journal, {"project_id": project_id, "workitem_id": workitem_id, "pending": True})
    comment_html = "<p>" + COMMENT_MARKER + "</p><p>" + html.escape(text).replace("\n", "<br>") + "</p>"
    # The journal is durable before this one permitted write. Never retry POST.
    created = payload(await session.call_tool("workitem_comment", {
        "action": "create", "project_id": project_id, "workitem_id": workitem_id,
        "comment_html": comment_html,
    }))
    if not isinstance(created, dict) or not isinstance(created.get("id"), str):
        raise VerificationError("Comment outcome unknown; inspect Plane before another write.")
    observed = await existing_comment()
    if observed is None or observed.get("id") != created["id"] or observed.get("comment_html") != comment_html:
        raise VerificationError("Comment readback did not match the created comment.")
    write_manifest(journal, {"project_id": project_id, "workitem_id": workitem_id, "pending": False, "comment_id": created["id"]})
    return {"id": created["id"], "reused": False, "read_back": True}


async def verify(args: argparse.Namespace) -> dict[str, Any]:
    config = load_config(args.config)
    manifest = json.loads(args.manifest.read_text(encoding="utf-8-sig"))
    if manifest.get("ownership_marker") != OWNERSHIP_MARKER or manifest.get("workspace_slug") != config.workspace_slug or manifest.get("plane_base_url") != config.base_url:
        raise VerificationError("Manifest ownership/workspace/origin does not match the local configuration.")
    specs = {item["key"]: item for item in TASKS}
    if {item["key"] for item in manifest["work_items"]} != set(specs) or len(manifest["work_items"]) != 4:
        raise VerificationError("Manifest must contain the four expected demo tasks.")
    environment = dict(os.environ)
    environment.update({"PLANE_BASE_URL": config.base_url, "PLANE_WORKSPACE_SLUG": config.workspace_slug,
        "PLANE_API_KEY": config.api_key, "LOG_PAYLOADS": "false", "LOG_USER_INFO": "false"})
    environment["NO_PROXY"] = ",".join(filter(None, [environment.get("NO_PROXY", ""), urlsplit(config.base_url).hostname, "localhost", "127.0.0.1"]))
    command_args = [str(ROOT / "read_only_mcp.py")] if args.read_only_proxy else ["-m", "plane_mcp", "stdio"]
    server = StdioServerParameters(command=sys.executable, args=command_args, env=environment)
    # Official server diagnostics can include response payloads; don't expose them.
    with open(os.devnull, "w", encoding="utf-8") as errlog:
        async with stdio_client(server, errlog=errlog) as streams:
            async with ClientSession(*streams) as session:
                await session.initialize()
                discovered = await session.list_tools()
                tools = {tool.name: tool for tool in discovered.tools}
                for name in ("project", "workitem", "state", "workitem_comment"):
                    if name not in tools or "retrieve" not in tools[name].inputSchema.get("properties", {}).get("action", {}).get("enum", []):
                        raise VerificationError("Official MCP tool schema does not match the pinned demo version.")
                pid = manifest["project"]["id"]
                project = payload(await session.call_tool("project", {"action": "retrieve", "project_id": pid}))
                if not isinstance(project, dict) or project.get("id") != pid or OWNERSHIP_MARKER not in (project.get("description") or ""):
                    raise VerificationError("MCP project identity/ownership did not match the seed.")
                projects, project_pages = await pages(session, "project", {"action": "list"})
                if pid not in {row["id"] for row in projects}:
                    raise VerificationError("MCP project list omitted the demo project.")
                states, state_pages = await pages(session, "state", {"action": "list", "project_id": pid})
                groups = {row["id"]: row.get("group") for row in states}
                items, item_pages = await pages(session, "workitem", {"action": "list", "project_id": pid})
                if {row["id"] for row in items} != {row["id"] for row in manifest["work_items"]}:
                    raise VerificationError("MCP work item list did not contain exactly the seeded tasks.")
                verified = []
                for item in manifest["work_items"]:
                    detail = payload(await session.call_tool("workitem", {"action": "retrieve", "project_id": pid, "workitem_id": item["id"]}))
                    spec = specs[item["key"]]
                    if not isinstance(detail, dict) or detail.get("id") != item["id"] or detail.get("name") != spec["name"] or task_marker(item["key"]) not in (detail.get("description_html") or ""):
                        raise VerificationError("MCP work item content/ownership does not match the demo.")
                    state_id = detail.get("state_id", detail.get("state"))
                    if groups.get(state_id) != spec["group"]:
                        raise VerificationError("MCP work item state does not match the demo.")
                    verified.append({"id": item["id"], "identifier": f"{project['identifier']}-{detail['sequence_id']}", "name": detail["name"], "state_group": groups[state_id]})
                analysis_id = next(item["id"] for item in manifest["work_items"] if item["key"] == "analysis")
                comments, comment_pages = await pages(session, "workitem_comment", {"action": "list", "project_id": pid, "workitem_id": analysis_id})
                evidence = {"ok": True, "checked_at": datetime.now(timezone.utc).isoformat(),
                    "upstream": {"plane-mcp-server": version("plane-mcp-server"), "plane-sdk": version("plane-sdk"), "mcp": version("mcp")},
                    "read_only_proxy": args.read_only_proxy, "tools_discovered": len(tools),
                    "project_id": pid, "work_items": verified, "state_counts": dict(Counter(item["state_group"] for item in verified)),
                    "pages": {"projects": project_pages, "states": state_pages, "work_items": item_pages, "comments": comment_pages},
                    "analysis_comment_count": len(comments), "plane_writes": False}
                if args.write_comment:
                    text = read_report(args.comment_file)
                    if config.api_key in text:
                        raise VerificationError("Report contains a credential; no comment was written.")
                    evidence["comment"] = await comment_once(session, pid, analysis_id, text, args.output.parent / "comment-journal.json")
                    evidence["plane_writes"] = not evidence["comment"]["reused"]
                return evidence


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path)
    parser.add_argument("--manifest", type=Path, default=ROOT / "output/demo-manifest.json")
    parser.add_argument("--output", type=Path, default=ROOT / "output/mcp-verification.json")
    parser.add_argument("--read-only-proxy", action="store_true")
    parser.add_argument("--write-comment", action="store_true", help="Explicitly post one deduplicated comment to the seeded analysis task")
    parser.add_argument("--comment-file", type=Path, help="Plain text or a successful ScienceDiscovery run-read.json")
    parser.add_argument("--timeout", type=float, default=180)
    args = parser.parse_args()
    if args.write_comment and (args.comment_file is None or args.read_only_proxy):
        parser.error("--write-comment requires --comment-file and the direct official MCP server")
    if not 1 <= args.timeout <= 600:
        parser.error("--timeout must be 1..600 seconds")
    if args.config and args.output.resolve() == args.config.resolve():
        parser.error("Evidence output must differ from private configuration")
    try:
        async def bounded() -> dict[str, Any]:
            async with asyncio.timeout(args.timeout):
                return await verify(args)
        evidence = asyncio.run(bounded())
        write_manifest(args.output, evidence)
        print(f"Official MCP verified: 4 tasks, complete pagination, evidence saved ({'comment requested' if args.write_comment else 'read only'}).")
        return 0
    except (PlaneError, VerificationError) as exc:
        print("MCP demo stopped: " + str(exc), file=sys.stderr)
    except Exception:
        # ExceptionGroups from SDK transports may embed process env/HTTP details.
        print("MCP demo stopped: protocol, timeout, or local file error; raw details withheld.", file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
