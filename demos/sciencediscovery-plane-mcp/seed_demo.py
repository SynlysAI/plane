"""Create/reuse only the marked Plane MCP demo resources, or check them read-only."""

from __future__ import annotations

import argparse
import copy
import html
import json
import os
import sys
from datetime import datetime, timezone
from html.parser import HTMLParser
from pathlib import Path
from typing import Any, Callable

from plane_client import PlaneClient, PlaneError, load_config


OWNERSHIP_MARKER = "[ScienceDiscovery MCP Demo seed:v1]"
PROJECT_NAME = "ScienceDiscovery MCP Demo"
PROJECT_IDENTIFIER = "SDMCP"
TASKS = (
    {"key": "literature", "name": "整理相关文献", "group": "completed", "description": "已整理三种材料的性能对比。"},
    {"key": "cycling", "name": "完成首轮循环测试", "group": "completed", "description": "已测三组样品，结果存在波动；测试条件尚待核对。"},
    {"key": "analysis", "name": "分析容量衰减原因", "group": "started", "description": "等待确认温度、倍率、电压窗口和样品负载量是否一致；当前尚不能判断波动来自材料还是测试条件。"},
    {"key": "planning", "name": "制定第二轮实验方案", "group": "unstarted", "description": "需等待容量衰减分析完成后确定对照条件。"},
)


class SeedError(RuntimeError):
    """Safe, local validation failure; does not echo server data."""


class _Text(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []

    def handle_data(self, data: str) -> None:
        self.parts.append(data)


def _text(value: Any) -> str:
    if not isinstance(value, str):
        return ""
    parser = _Text()
    parser.feed(value)
    return " ".join(parser.parts)


def task_marker(key: str) -> str:
    return f"{OWNERSHIP_MARKER} task:{key}"


def _timestamp() -> str:
    return datetime.now(timezone.utc).isoformat()


class SeedRunner:
    """Persist pending writes before POST; never automatically retry a write.

    A resumed run may reconcile a pending resource by its marker. If it cannot
    find that resource, it stops rather than assuming the earlier POST failed.
    The caller must use durable save_manifest storage before permitting seed.
    """

    def __init__(
        self, client: PlaneClient, *, manifest: dict[str, Any] | None = None,
        save_manifest: Callable[[dict[str, Any]], None] | None = None,
    ) -> None:
        self.client = client
        self.manifest = copy.deepcopy(manifest or {})
        self.save_manifest = save_manifest
        cfg = client.config
        if self.manifest:
            if (
                self.manifest.get("schema_version") != 1
                or self.manifest.get("ownership_marker") != OWNERSHIP_MARKER
                or self.manifest.get("workspace_slug") != cfg.workspace_slug
                or self.manifest.get("plane_base_url") != cfg.base_url
            ):
                raise SeedError("Existing manifest belongs to a different demo, API origin, or workspace; use another output file.")
        else:
            self.manifest = {
                "schema_version": 1, "ownership_marker": OWNERSHIP_MARKER,
                "workspace_slug": cfg.workspace_slug, "plane_base_url": cfg.base_url,
                "project": None, "work_items": [],
            }
        pending = self.manifest.get("pending_write")
        if pending is not None and (
            not isinstance(pending, dict) or pending.get("kind") not in {"project", "work_item"}
            or (pending.get("kind") == "project" and pending.get("key") != "project")
            or (pending.get("kind") == "work_item" and pending.get("key") not in {t["key"] for t in TASKS})
        ):
            raise SeedError("The pending-write journal is invalid; inspect the local manifest before proceeding.")

    def _save(self) -> None:
        self.manifest["updated_at"] = _timestamp()
        if self.save_manifest:
            self.save_manifest(copy.deepcopy(self.manifest))

    def _write(self, kind: str, key: str, operation: Callable[[], Any]) -> Any:
        if self.save_manifest is None:
            raise SeedError("Seed mode requires a durable manifest writer before creating resources.")
        if self.manifest.get("pending_write"):
            raise SeedError("An earlier write has not been reconciled; no further writes are allowed.")
        self.manifest["pending_write"] = {"kind": kind, "key": key, "started_at": _timestamp()}
        self._save()
        # Keep the pending journal on every exception, including server errors:
        # Plane may commit a row before failing to dispatch a background task.
        return operation()

    def _reconcile(self, kind: str, key: str, found: bool) -> None:
        pending = self.manifest.get("pending_write")
        if pending and pending["kind"] == kind and pending["key"] == key:
            if not found:
                raise SeedError("The previous write outcome is still unknown. No matching marked resource was found; verify Plane before manually resolving the local journal.")
            self.manifest.pop("pending_write", None)
            self._save()

    @staticmethod
    def _validate_project(project: Any) -> None:
        if (
            not isinstance(project, dict) or not isinstance(project.get("id"), str) or not project["id"]
            or project.get("name") != PROJECT_NAME or project.get("identifier") != PROJECT_IDENTIFIER
            or OWNERSHIP_MARKER not in _text(project.get("description"))
            or project.get("archived_at") is not None or project.get("deleted_at") is not None
        ):
            raise SeedError("Project is unmarked, changed, or archived. Refusing to use or modify it.")

    @staticmethod
    def _project_summary(project: dict[str, Any]) -> dict[str, str]:
        return {key: project[key] for key in ("id", "name", "identifier")}

    def _find_project(self, project_id: str | None) -> dict[str, Any] | None:
        prior = self.manifest.get("project")
        saved_id = prior.get("id") if isinstance(prior, dict) else None
        if project_id and saved_id and project_id != saved_id:
            raise SeedError("Explicit project ID disagrees with the existing manifest.")
        if project_id or saved_id:
            project = self.client.get_project(project_id or saved_id)
            self._validate_project(project)
            return project
        projects = self.client.list_projects()
        candidates = [p for p in projects if p.get("name") == PROJECT_NAME or p.get("identifier") == PROJECT_IDENTIFIER or OWNERSHIP_MARKER in _text(p.get("description"))]
        if len(candidates) > 1:
            raise SeedError("Multiple or conflicting demo projects exist. Inspect them before selecting an owned project explicitly.")
        if candidates:
            self._validate_project(candidates[0])
            return candidates[0]
        return None

    def _states(self, project_id: str) -> tuple[dict[str, str], dict[str, str]]:
        states = self.client.list_states(project_id)
        groups = {s["id"]: s.get("group") for s in states}
        selected: dict[str, str] = {}
        for group in ("completed", "started", "unstarted"):
            matches = [s for s in states if s.get("group") == group]
            if not matches:
                raise SeedError("Project is missing a required state group: " + group + ". No tasks were created.")
            # Prefer an existing default state, then stable ID; labels may be localized.
            selected[group] = sorted(matches, key=lambda s: (not bool(s.get("default")), s["id"]))[0]["id"]
        return selected, groups

    @staticmethod
    def _validate_task(item: Any, spec: dict[str, str], groups: dict[str, str]) -> None:
        state = item.get("state") if isinstance(item, dict) else None
        state_id = state.get("id") if isinstance(state, dict) else state
        if (
            not isinstance(item, dict) or not isinstance(item.get("id"), str) or not item["id"]
            or item.get("name") != spec["name"]
            or task_marker(spec["key"]) not in _text(item.get("description_html"))
            or spec["description"] not in _text(item.get("description_html"))
            or not isinstance(state_id, str) or groups.get(state_id) != spec["group"]
        ):
            raise SeedError("A demo task is unmarked or its name, description, or state has changed. Refusing to overwrite it.")

    @staticmethod
    def _task_summary(item: dict[str, Any], spec: dict[str, str]) -> dict[str, Any]:
        state = item["state"]
        summary = {
            "id": item["id"], "key": spec["key"], "name": spec["name"],
            "state_id": state["id"] if isinstance(state, dict) else state,
            "state_group": spec["group"],
        }
        if isinstance(item.get("sequence_id"), int):
            summary["sequence_id"] = item["sequence_id"]
        return summary

    def run(self, mode: str, *, project_id: str | None = None) -> dict[str, Any]:
        if mode not in {"check", "seed"}:
            raise SeedError("Mode must be check or seed.")
        project = self._find_project(project_id)
        self._reconcile("project", "project", project is not None)
        if project is None:
            if mode == "check":
                raise SeedError("Marked demo project does not exist. The read-only check created nothing.")
            project = self._write("project", "project", lambda: self.client.create_project({
                "name": PROJECT_NAME, "identifier": PROJECT_IDENTIFIER,
                "description": "人工构造的 ScienceDiscovery × Plane MCP 演示数据；仅用于接口联调。 " + OWNERSHIP_MARKER,
            }))
            self._validate_project(project)
            self.manifest["project"] = self._project_summary(project)
            self._reconcile("project", "project", True)
        self.manifest["project"] = self._project_summary(project)
        self._save()
        pid = project["id"]
        selected, groups = self._states(pid)
        items = self.client.list_work_items(pid)
        existing: dict[str, dict[str, Any]] = {}
        # Validate every existing resource before creating any missing task.
        for item in items:
            matches = [s for s in TASKS if item.get("name") == s["name"] or task_marker(s["key"]) in _text(item.get("description_html"))]
            if len(matches) != 1:
                raise SeedError("The dedicated demo project contains an unexpected or ambiguous task; inspect it before seeding.")
            spec = matches[0]
            self._validate_task(item, spec, groups)
            if spec["key"] in existing:
                raise SeedError("Duplicate marked demo tasks exist. No tasks were created.")
            existing[spec["key"]] = item
        pending = self.manifest.get("pending_write")
        if pending and pending["kind"] == "work_item":
            self._reconcile("work_item", pending["key"], pending["key"] in existing)
        missing = [spec for spec in TASKS if spec["key"] not in existing]
        if missing and mode == "check":
            raise SeedError("Some demo tasks are missing. The read-only check created nothing.")
        self.manifest["work_items"] = [self._task_summary(existing[s["key"]], s) for s in TASKS if s["key"] in existing]
        self._save()
        for spec in missing:
            item = self._write("work_item", spec["key"], lambda spec=spec: self.client.create_work_item(pid, {
                "name": spec["name"], "state": selected[spec["group"]],
                "description_html": "<p>" + html.escape(spec["description"]) + "</p><p>" + html.escape(task_marker(spec["key"])) + "</p>",
                "external_source": "sciencediscovery-mcp-demo", "external_id": "v1:" + spec["key"],
            }))
            self._validate_task(item, spec, groups)
            existing[spec["key"]] = item
            self.manifest["work_items"] = [self._task_summary(existing[s["key"]], s) for s in TASKS if s["key"] in existing]
            self._reconcile("work_item", spec["key"], True)
        self.manifest["checked_at"] = _timestamp()
        self._save()
        return copy.deepcopy(self.manifest)


def write_manifest(path: Path, manifest: dict[str, Any]) -> None:
    """Atomic JSON replacement; the file contains IDs and journal metadata only."""
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".tmp")
    try:
        temporary.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        os.replace(temporary, path)
    except OSError:
        raise SeedError("Cannot persist the manifest. No further API writes will be attempted.") from None


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=("check", "seed"), help="check reads only; seed creates missing owned demo resources")
    parser.add_argument("--config", type=Path, help="private JSON file with PLANE_BASE_URL, PLANE_WORKSPACE_SLUG, PLANE_API_KEY")
    parser.add_argument("--output", type=Path, default=Path(__file__).parent / "output" / "demo-manifest.json")
    parser.add_argument("--project-id", help="existing project ID; its ownership marker is still required")
    parser.add_argument("--timeout", type=float, default=20.0)
    args = parser.parse_args(argv)
    lock: Path | None = None
    acquired = False
    try:
        config = load_config(args.config, timeout=args.timeout)
        if args.config and args.output.resolve() == args.config.resolve():
            raise SeedError("The manifest output must differ from the private configuration file.")
        args.output.parent.mkdir(parents=True, exist_ok=True)
        lock = args.output.with_name(args.output.name + ".lock")
        try:
            with lock.open("x", encoding="ascii") as handle:
                handle.write(str(os.getpid()))
            acquired = True
        except FileExistsError:
            raise SeedError("The manifest is locked by another run. If a prior process crashed, verify it has stopped before removing the lock locally.") from None
        manifest = None
        if args.output.exists():
            try:
                manifest = json.loads(args.output.read_text(encoding="utf-8-sig"))
            except (ValueError, UnicodeError):
                raise SeedError("The existing manifest is invalid JSON; inspect it locally.") from None
            if not isinstance(manifest, dict):
                raise SeedError("The existing manifest must be a JSON object.")
        runner = SeedRunner(PlaneClient(config), manifest=manifest, save_manifest=lambda data: write_manifest(args.output, data))
        result = runner.run(args.mode, project_id=args.project_id)
        print(f"Demo {args.mode} succeeded: 1 owned project, {len(result['work_items'])} tasks (2 completed, 1 started, 1 unstarted).")
        print("Saved a credential-free demo manifest.")
        return 0
    except (PlaneError, SeedError) as exc:
        print("Demo stopped: " + str(exc), file=sys.stderr)
        return 1
    except OSError:
        print("Demo stopped: local file access failed; details are withheld.", file=sys.stderr)
        return 1
    finally:
        if acquired and lock is not None:
            try:
                lock.unlink()
            except OSError:
                pass


if __name__ == "__main__":
    raise SystemExit(main())
