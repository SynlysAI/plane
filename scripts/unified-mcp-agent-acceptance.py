"""Run an installed, authenticated Codex CLI against one local acceptance MCP config.

Uses the user's existing CLI login, never modifies global config, never prints tokens.
Private event/output files belong in an ignored directory. This is a real Agent run,
not an SDK substitute. It deliberately accepts loopback synthetic test servers only.
"""

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path
from urllib.parse import urlsplit


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--config",
        required=True,
        type=Path,
        help="One-server exported JSON config from isolated UI",
    )
    parser.add_argument(
        "--prompt-file",
        required=True,
        type=Path,
        help="Explicit synthetic-data acceptance instructions",
    )
    parser.add_argument(
        "--output-dir",
        required=True,
        type=Path,
        help="New private directory, normally under .runtime",
    )
    parser.add_argument("--timeout", type=int, default=300)
    args = parser.parse_args()
    config = json.loads(args.config.read_text(encoding="utf-8-sig"))
    servers = config.get("mcpServers", {})
    if list(servers) != ["plane"]:
        parser.error("Expected exactly one server named plane")
    server = servers["plane"]
    url = urlsplit(server["url"])
    if (
        url.scheme != "http"
        or url.hostname != "127.0.0.1"
        or not url.port
        or url.path != "/api/mcp/"
        or url.query
        or url.fragment
        or url.username
        or url.password
    ):
        parser.error(
            "Only an explicit loopback /api/mcp/ synthetic acceptance server is supported"
        )
    headers = server.get("headers", {})
    if list(headers) != ["Authorization"] or not re.fullmatch(
        r"Bearer pum_[A-Za-z0-9_-]{43}", headers["Authorization"]
    ):
        parser.error("Expected the isolated unified Bearer credential")
    executable = shutil.which("codex")
    if not executable:
        parser.error("Install/login to the target Codex CLI first")
    output = args.output_dir.resolve()
    output.mkdir(parents=True, exist_ok=False)
    workspace = output / "workspace"
    workspace.mkdir()
    environment = os.environ.copy()
    environment["PLANE_ACCEPTANCE_TOKEN"] = headers["Authorization"][7:]
    command = [
        executable,
        "exec",
        "--ephemeral",
        "--ignore-user-config",
        "--sandbox",
        "read-only",
        "--skip-git-repo-check",
        "--json",
        "--color",
        "never",
        "-C",
        str(workspace),
        "-o",
        str(output / "last-message.txt"),
    ]
    overrides = {
        "approval_policy": "never",
        "mcp_servers.plane.url": server["url"],
        "mcp_servers.plane.bearer_token_env_var": "PLANE_ACCEPTANCE_TOKEN",
        "mcp_servers.plane.required": True,
        "mcp_servers.plane.tool_timeout_sec": 120,
        "mcp_servers.plane.default_tools_approval_mode": "auto",
    }
    for key, value in overrides.items():
        command.extend(["-c", key + "=" + json.dumps(value)])
    command.append("-")
    prompt = args.prompt_file.read_text(encoding="utf-8-sig")
    try:
        with (
            (output / "events.private.jsonl").open("w", encoding="utf-8") as stdout,
            (output / "stderr.private.log").open("w", encoding="utf-8") as stderr,
        ):
            result = subprocess.run(
                command,
                check=False,
                input=prompt,
                text=True,
                encoding="utf-8",
                stdout=stdout,
                stderr=stderr,
                env=environment,
                timeout=args.timeout,
            )
    except subprocess.TimeoutExpired:
        (output / "proof.json").write_text(
            json.dumps(
                {
                    "real_agent": True,
                    "completed": False,
                    "reason": "client_timeout",
                    "timeout_seconds": args.timeout,
                }
            ),
            encoding="utf-8",
        )
        print(
            "Target Agent timed out. Inspect private logs; verify writes before any retry."
        )
        return 2
    rows = []
    for line in (
        (output / "events.private.jsonl").read_text(encoding="utf-8").splitlines()
    ):
        try:
            rows.append(json.loads(line))
        except ValueError:
            continue
    calls = [
        row["item"]
        for row in rows
        if row.get("type") == "item.completed"
        and row.get("item", {}).get("type") == "mcp_tool_call"
    ]
    commands = [
        row
        for row in rows
        if row.get("item", {}).get("type")
        in ("command_execution", "file_change", "web_search")
    ]
    proof = {
        "real_agent": True,
        "client": subprocess.check_output([executable, "--version"], text=True).strip(),
        "servers": 1,
        "global_config_modified": False,
        "ephemeral": True,
        "exit_code": result.returncode,
        "turn_completed": any(row.get("type") == "turn.completed" for row in rows),
        "tools": [
            {
                "server": item.get("server"),
                "tool": item.get("tool"),
                "status": item.get("status"),
                "error": bool(item.get("error")) or item.get("status") != "completed",
                "error_code": (
                    (item.get("result") or {}).get("structured_content") or {}
                ).get("error_code"),
            }
            for item in calls
        ],
        "unexpected_non_mcp_actions": len(commands),
    }
    (output / "proof.json").write_text(json.dumps(proof, indent=2), encoding="utf-8")
    print(json.dumps(proof))
    return (
        0
        if result.returncode == 0 and proof["turn_completed"] and calls and not commands
        else 1
    )


if __name__ == "__main__":
    sys.exit(main())
