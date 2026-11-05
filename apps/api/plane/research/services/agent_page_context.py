"""Server-authoritative page snapshots for the workspace Agent Dock.

The resolver deliberately returns a bounded seed rather than a full page dump.
Long content stays behind Plane's paged unified MCP tools so an Agent can follow
references on demand without inflating every LLM turn.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any
from uuid import UUID

from django.utils.html import strip_tags

from plane.db.models import (
    Issue,
    IssueComment,
    Project,
    ResearchChain,
    ResearchChainEvent,
    ResearchChainNode,
    ResearchChainNodeTask,
    Workspace,
)
from plane.research.views.projects import visible_profile_queryset
from plane.utils.administrative_projects import visible_administrative_projects
from plane.utils.content_validator import validate_html_content

PAGE_CONTEXT_SCHEMA = "agent-page-context.v1"
MAX_SUMMARY_CHARS = 12_000


@dataclass(frozen=True)
class PageFocus:
    """An ACL-checked object selected by the route or right detail dock."""

    kind: str
    object_id: UUID
    title: str
    status: str = ""
    parent_kind: str = ""
    parent_id: UUID | None = None


def _uuid(value: Any) -> UUID | None:
    """Convert a request value to a UUID without leaking exceptions."""
    try:
        return UUID(str(value))
    except (TypeError, ValueError):
        return None


def _clean_html(value: str, limit: int = 1200) -> str:
    """Return a bounded plain-text projection of untrusted HTML."""
    _valid, _error, cleaned = validate_html_content(value or "")
    text = strip_tags(cleaned or "").strip()
    return text[:limit]


def _iso(value: datetime | None) -> str | None:
    return value.isoformat() if value else None


def _focus_payload(focus: PageFocus | None, route: str) -> dict[str, Any]:
    """Build the safe focus descriptor used by both Plane UI and Synlora."""
    if focus is None:
        return {"type": "WORKSPACE", "id": "", "title": "Workspace", "route": route}
    return {
        "type": focus.kind,
        "id": str(focus.object_id),
        "title": focus.title[:300],
        "status": focus.status,
        **({"parent_type": focus.parent_kind} if focus.parent_kind else {}),
        **({"parent_id": str(focus.parent_id)} if focus.parent_id else {}),
        "route": route,
    }


def _research_task_focus(workspace: Workspace, user, task_id: UUID) -> tuple[PageFocus, ResearchChainNodeTask] | None:
    """Resolve a research task only when its project metadata is readable."""
    task = (
        ResearchChainNodeTask.objects.select_related(
            "node__chain__project__research_profile", "node__chain__workspace", "assignee"
        )
        .filter(pk=task_id, node__chain__workspace=workspace, deleted_at__isnull=True)
        .first()
    )
    if task is None:
        return None
    profile = getattr(task.node.chain.project, "research_profile", None)
    if profile is None or not visible_profile_queryset(workspace, user).filter(pk=profile.pk).exists():
        return None
    return (
        PageFocus(
            kind="RESEARCH_TASK",
            object_id=task.id,
            title=task.title,
            status=task.status,
            parent_kind="RESEARCH_NODE",
            parent_id=task.node_id,
        ),
        task,
    )


def _research_node_focus(workspace: Workspace, user, node_id: UUID) -> tuple[PageFocus, ResearchChainNode] | None:
    """Resolve a research node using the same metadata ACL as the page."""
    node = (
        ResearchChainNode.objects.select_related("chain__project__research_profile", "chain__workspace", "assignee")
        .filter(pk=node_id, chain__workspace=workspace, deleted_at__isnull=True)
        .first()
    )
    if node is None:
        return None
    profile = getattr(node.chain.project, "research_profile", None)
    if profile is None or not visible_profile_queryset(workspace, user).filter(pk=profile.pk).exists():
        return None
    return (
        PageFocus(
            kind="RESEARCH_NODE",
            object_id=node.id,
            title=node.title,
            status=node.status,
            parent_kind="RESEARCH_CHAIN",
            parent_id=node.chain_id,
        ),
        node,
    )


def _research_chain_focus(workspace: Workspace, user, chain_id: UUID) -> tuple[PageFocus, ResearchChain] | None:
    """Resolve a research chain through readable project metadata."""
    chain = (
        ResearchChain.objects.select_related("project__research_profile", "workspace")
        .filter(pk=chain_id, workspace=workspace, deleted_at__isnull=True)
        .exclude(status="DELETED")
        .first()
    )
    if chain is None:
        return None
    profile = getattr(chain.project, "research_profile", None)
    if profile is None or not visible_profile_queryset(workspace, user).filter(pk=profile.pk).exists():
        return None
    return (
        PageFocus(
            kind="RESEARCH_CHAIN",
            object_id=chain.id,
            title=chain.project.name,
            status=chain.status,
            parent_kind="PROJECT",
            parent_id=chain.project_id,
        ),
        chain,
    )


def _administrative_project_focus(
    workspace: Workspace, user, project_id: UUID
) -> tuple[PageFocus, Project] | None:
    """Resolve an administrative project only through the existing visibility helper."""
    project = (
        visible_administrative_projects(user, workspace.slug)
        .filter(pk=project_id, workspace=workspace, archived_at__isnull=True)
        .first()
    )
    if project is None:
        return None
    return (
        PageFocus(
            kind="ADMIN_PROJECT",
            object_id=project.id,
            title=project.name,
        ),
        project,
    )


def _issue_focus(workspace: Workspace, user, issue_id: UUID) -> tuple[PageFocus, Issue] | None:
    """Resolve an administrative issue through the existing visibility helper."""
    issue = (
        Issue.objects.select_related("project", "state")
        .filter(pk=issue_id, workspace=workspace, archived_at__isnull=True, deleted_at__isnull=True)
        .first()
    )
    if issue is None or issue.project_id is None:
        return None
    if not visible_administrative_projects(user, workspace.slug).filter(pk=issue.project_id).exists():
        return None
    return (
        PageFocus(
            kind="ISSUE",
            object_id=issue.id,
            title=issue.name or "",
            status=issue.state.name if issue.state_id else "",
            parent_kind="PROJECT",
            parent_id=issue.project_id,
        ),
        issue,
    )


def _route_focus(workspace: Workspace, user, route: str) -> tuple[PageFocus, Any | None] | None:
    """Derive the narrowest safe focus from the current URL."""
    path = str(route or "").split("?", 1)[0]
    segments = [segment for segment in path.replace("\\", "/").split("/") if segment]

    def after(marker: str) -> UUID | None:
        try:
            return _uuid(segments[segments.index(marker) + 1])
        except (ValueError, IndexError):
            return None

    for marker, resolver in (
        ("tasks", lambda value: _research_task_focus(workspace, user, value)),
        ("nodes", lambda value: _research_node_focus(workspace, user, value)),
        ("chains", lambda value: _research_chain_focus(workspace, user, value)),
        ("issues", lambda value: _issue_focus(workspace, user, value)),
    ):
        value = after(marker)
        if value is not None:
            resolved = resolver(value)
            if resolved is not None:
                return resolved

    # Fall back only to an administrative project root. The stable shape is
    # ``/{slug}/projects/{id}/*``; research-project and settings-project routes
    # intentionally do not match this position.
    if len(segments) >= 3 and segments[1] == "projects":
        project_id = _uuid(segments[2])
        if project_id is not None:
            return _administrative_project_focus(workspace, user, project_id)
    return None


def _requested_focus(workspace: Workspace, user, focus_ref: dict[str, Any] | None):
    """Validate a focus submitted by the right dock; malformed data is ignored."""
    if not isinstance(focus_ref, dict):
        return None
    kind = str(focus_ref.get("type") or "").upper()
    object_id = _uuid(focus_ref.get("id"))
    if object_id is None:
        return None
    if kind == "RESEARCH_TASK":
        return _research_task_focus(workspace, user, object_id)
    if kind == "RESEARCH_NODE":
        return _research_node_focus(workspace, user, object_id)
    if kind == "RESEARCH_CHAIN":
        return _research_chain_focus(workspace, user, object_id)
    if kind == "ADMIN_PROJECT":
        return _administrative_project_focus(workspace, user, object_id)
    if kind == "ISSUE":
        return _issue_focus(workspace, user, object_id)
    return None


def _workspace_summary(workspace: Workspace, user) -> tuple[list[str], list[dict[str, Any]]]:
    """Build a compact workspace overview and navigation hints."""
    research_profiles = visible_profile_queryset(workspace, user).filter(deleted_at__isnull=True)
    administrative_projects = visible_administrative_projects(user, workspace.slug).filter(archived_at__isnull=True)
    research_rows = list(research_profiles.values("project_id", "project__name")[:20])
    admin_rows = list(administrative_projects.values("id", "name")[:20])
    admin_ids = [row["id"] for row in admin_rows]
    recent_issues = (
        Issue.objects.filter(workspace=workspace, project_id__in=admin_ids, archived_at__isnull=True)
        .select_related("project", "state")
        .order_by("-updated_at")[:10]
    )
    lines = [
        f"Workspace: {workspace.name} ({workspace.slug})",
        f"Visible administrative projects: {administrative_projects.count()}",
        f"Visible research projects: {research_profiles.count()}",
    ]
    resources = [
        {"kind": "project", "id": str(row["id"]), "title": row["name"], "status": ""}
        for row in admin_rows
    ]
    resources.extend(
        {
            "kind": "research_project",
            "id": str(row["project_id"]),
            "title": row["project__name"],
            "status": "",
        }
        for row in research_rows
    )
    resources.extend(
        {
            "kind": "issue",
            "id": str(issue.id),
            "title": issue.name or "",
            "status": issue.state.name if issue.state_id else "",
            "updated_at": _iso(issue.updated_at),
        }
        for issue in recent_issues
    )
    return lines, resources


def _research_snapshot(focus: PageFocus, obj: Any) -> tuple[list[str], list[dict[str, Any]], list[dict[str, Any]]]:
    """Build chain/node/task seed sections without loading file bodies."""
    if focus.kind == "RESEARCH_TASK":
        task = obj
        node = task.node
        chain = node.chain
        lines = [
            f"Research task: {task.title} ({task.status})",
            f"Research node: {node.title} ({node.node_type}, {node.status})",
            f"Research chain: {chain.id} ({chain.status})",
            "Task instruction excerpt:",
            _clean_html(task.instruction or ""),
        ]
        events = (
            ResearchChainEvent.objects.filter(node=node)
            .order_by("-occurred_at")
            .values("id", "event_type", "summary", "occurred_at")[:8]
        )
        resources = [
            {"kind": "event", "id": str(event["id"]), "title": event["summary"] or event["event_type"], "status": ""}
            for event in events
        ]
        actions = [
            {"label": "Open research task", "route": f"chains/{chain.id}/nodes/{node.id}"},
            {"label": "Read task details", "tool": "plane_get_context"},
            {"label": "Read related events", "tool": "plane_get_context"},
        ]
        return lines, resources, actions

    if focus.kind == "RESEARCH_NODE":
        node = obj
        chain = node.chain
        tasks = (
            ResearchChainNodeTask.objects.filter(node=node, deleted_at__isnull=True)
            .order_by("-updated_at")
            .values("id", "title", "status", "updated_at")[:20]
        )
        events = (
            ResearchChainEvent.objects.filter(node=node)
            .order_by("-occurred_at")
            .values("id", "event_type", "summary", "occurred_at")[:10]
        )
        lines = [
            f"Research node: {node.title} ({node.node_type}, {node.status})",
            f"Research chain: {chain.id} ({chain.status})",
            f"Visible tasks in node: {len(tasks)}",
        ]
        resources = [
            {"kind": "task", "id": str(task["id"]), "title": task["title"], "status": task["status"]}
            for task in tasks
        ]
        resources.extend(
            {"kind": "event", "id": str(event["id"]), "title": event["summary"] or event["event_type"], "status": ""}
            for event in events
        )
        actions = [
            {"label": "List node tasks", "tool": "plane_list_tasks"},
            {"label": "Read node context", "tool": "plane_get_context"},
            {"label": "Open node", "route": f"chains/{chain.id}/nodes/{node.id}"},
        ]
        return lines, resources, actions

    chain = obj
    nodes = (
        ResearchChainNode.objects.filter(chain=chain, deleted_at__isnull=True)
        .select_related("assignee")
        .order_by("created_at")[:30]
    )
    stages = chain.stage_approvals.filter(deleted_at__isnull=True).order_by("sort_order")
    active_stage = next((stage for stage in stages if stage.status not in ("APPROVED",)), None)
    task_rows = (
        ResearchChainNodeTask.objects.filter(node__chain=chain, deleted_at__isnull=True)
        .values("node_id", "status")[:200]
    )
    task_counts: dict[str, dict[str, int]] = {}
    for row in task_rows:
        counts = task_counts.setdefault(str(row["node_id"]), {})
        counts[row["status"]] = counts.get(row["status"], 0) + 1
    events = (
        ResearchChainEvent.objects.filter(chain=chain)
        .order_by("-occurred_at")
        .values("id", "event_type", "summary", "occurred_at")[:12]
    )
    lines = [
        f"Research chain: {chain.project.name} ({chain.status}, {chain.id})",
        f"Research project: {chain.project.name}",
        f"Visible nodes: {nodes.count()}",
        f"Current or next stage: {active_stage.stage_code if active_stage else 'not started'}",
    ]
    resources = []
    for node in nodes:
        resources.append(
            {
                "kind": "node",
                "id": str(node.id),
                "title": node.title,
                "status": node.status,
                "task_counts": task_counts.get(str(node.id), {}),
            }
        )
    resources.extend(
        {
            "kind": "stage",
            "id": str(stage.id),
            "title": stage.get_stage_code_display(),
            "status": stage.status,
        }
        for stage in stages[:13]
    )
    resources.extend(
        {"kind": "event", "id": str(event["id"]), "title": event["summary"] or event["event_type"], "status": ""}
        for event in events
    )
    actions = [
        {"label": "List research nodes", "tool": "plane_list_nodes"},
        {"label": "Read chain context", "tool": "plane_get_context"},
        {"label": "Open chain", "route": f"chains/{chain.id}"},
    ]
    return lines, resources, actions


def _issue_snapshot(issue: Issue) -> tuple[list[str], list[dict[str, Any]], list[dict[str, Any]]]:
    """Build a bounded administrative issue seed."""
    comments = (
        IssueComment.objects.filter(issue=issue, deleted_at__isnull=True)
        .order_by("-created_at")[:10]
    )
    lines = [
        f"Administrative task: {issue.name or issue.id} ({issue.state.name if issue.state_id else ''})",
        f"Project: {issue.project.name if issue.project_id else ''}",
        f"Priority: {issue.priority or 'none'}",
        "Description excerpt:",
        _clean_html(issue.description_html or "", 2000),
    ]
    resources = [
        {
            "kind": "comment",
            "id": str(comment.id),
            "title": _clean_html(comment.comment_html, 160),
            "status": "",
        }
        for comment in comments
    ]
    actions = [
        {"label": "Read task context", "tool": "plane_get_context"},
        {"label": "Read description or comments", "tool": "plane_read_resource"},
        {"label": "Open task", "route": f"projects/{issue.project_id}/issues/{issue.id}"},
    ]
    return lines, resources, actions


def _administrative_project_snapshot(project: Project) -> tuple[list[str], list[dict[str, Any]], list[dict[str, Any]]]:
    """Build a bounded administrative project seed without loading page bodies."""
    issues = (
        Issue.objects.filter(
            workspace=project.workspace,
            project=project,
            archived_at__isnull=True,
            deleted_at__isnull=True,
        )
        .select_related("state")
        .order_by("-updated_at")[:20]
    )
    lines = [
        f"Administrative project: {project.name} ({project.identifier})",
        f"Visible recent work items: {len(issues)}",
        "Recent work item titles:",
        *[issue.name or str(issue.id) for issue in issues],
    ]
    resources = [
        {
            "kind": "issue",
            "id": str(issue.id),
            "title": issue.name or "",
            "status": issue.state.name if issue.state_id else "",
        }
        for issue in issues
    ]
    actions = [
        {"label": "List project tasks", "tool": "plane_list_tasks"},
        {"label": "Read project context", "tool": "plane_get_context"},
        {"label": "Open project", "route": f"projects/{project.id}"},
    ]
    return lines, resources, actions


def build_page_context(
    *,
    workspace: Workspace,
    user,
    route: str,
    focus_ref: dict[str, Any] | None = None,
    selected_text: str = "",
) -> dict[str, Any]:
    """Resolve an ACL-checked, bounded snapshot for every Plane page.

    Args:
        workspace: Current workspace after Plane authentication.
        user: Current Plane user.
        route: Current browser route; used only as a locating hint.
        focus_ref: Optional object reference from the coordinated right dock.
        selected_text: Optional current user selection, bounded by the caller.

    Returns:
        A non-empty ``agent-page-context.v1`` snapshot. Unknown or inaccessible
        pages fall back to a workspace overview instead of an empty context.
    """
    resolved = _requested_focus(workspace, user, focus_ref) or _route_focus(workspace, user, route)
    focus, obj = resolved if resolved else (None, None)
    hierarchy = [{"type": "WORKSPACE", "id": str(workspace.id), "title": workspace.name}]
    actions: list[dict[str, Any]] = [
        {"label": "List available containers", "tool": "plane_list_containers"},
        {"label": "List current tasks", "tool": "plane_list_tasks"},
    ]

    if focus is not None and focus.kind in {"RESEARCH_TASK", "RESEARCH_NODE", "RESEARCH_CHAIN"}:
        lines, resources, actions = _research_snapshot(focus, obj)
        page_kind = {
            "RESEARCH_NODE": "research_node",
            "RESEARCH_TASK": "research_task",
            "RESEARCH_CHAIN": "research_chain",
        }[focus.kind]
        depth = "focused"
    elif focus is not None and focus.kind == "ISSUE":
        lines, resources, actions = _issue_snapshot(obj)
        page_kind = "administrative_task"
        depth = "focused"
    elif focus is not None and focus.kind == "ADMIN_PROJECT":
        lines, resources, actions = _administrative_project_snapshot(obj)
        page_kind = "administrative_project"
        depth = "focused"
    else:
        lines, resources = _workspace_summary(workspace, user)
        page_kind = "workspace"
        depth = "minimal"

    summary = "\n".join(line for line in lines if str(line).strip())[:MAX_SUMMARY_CHARS]
    payload = {
        "schema_version": PAGE_CONTEXT_SCHEMA,
        "route": str(route or "")[:2048],
        "page_kind": page_kind,
        "depth": depth,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "hierarchy": hierarchy,
        "focus": _focus_payload(focus, route),
        "summary": summary,
        "resources": resources[:100],
        "suggested_tools": actions,
        **({"selected_text": selected_text[:4000]} if selected_text else {}),
    }
    payload["hash"] = hashlib.sha256(
        json.dumps(payload, ensure_ascii=False, sort_keys=True, default=str).encode()
    ).hexdigest()
    return payload
