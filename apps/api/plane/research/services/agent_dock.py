# Copyright (c) 2023-present Plane Software, Inc. contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Server-authoritative Agent Dock context resolution and issuance."""

from __future__ import annotations

import re
from dataclasses import dataclass
from uuid import UUID

from django.conf import settings
from django.utils import timezone

from plane.db.models import (
    Project,
    ResearchChain,
    ResearchChainEvent,
    ResearchChainNode,
    ResearchChainNodeTask,
    ResearchChainStageMaterialItem,
    ResearchContextGrant,
    ResearchChainUpload,
    Workspace,
)
from plane.research.services.context_tokens import issue_agent_dock_context_token
from plane.research.services.mcp_catalog import TOOL_NAMES
from plane.research.views.chain_foundation import _chain_writer
from plane.research.views.projects import can_read_project_research_metadata, visible_profile_queryset


class AgentDockContextError(Exception):
    """Raised when a requested dock target is absent or not accessible."""

    def __init__(self, message, status_code=403):
        super().__init__(message)
        self.message = message
        self.status_code = status_code


@dataclass(frozen=True)
class AgentDockTarget:
    """A fully ACL-checked dock target and its parent objects."""

    type: str
    workspace: Workspace
    project: Project | None = None
    chain: ResearchChain | None = None
    node: ResearchChainNode | None = None

    @property
    def key(self):
        """Stable target key used for session binding."""
        if self.node is not None:
            return f"node:{self.node.id}"
        if self.chain is not None:
            return f"chain:{self.chain.id}"
        if self.project is not None:
            return f"project:{self.project.id}"
        return f"workspace:{self.workspace.id}"


def _uuid(value: str) -> UUID | None:
    try:
        return UUID(str(value))
    except (TypeError, ValueError):
        return None


def _target_from_route(workspace: Workspace, user, route: str) -> AgentDockTarget:
    """Parse a Plane route server-side and resolve the narrowest visible target."""
    path = str(route or "").split("?", 1)[0].strip("/")
    segments = [segment for segment in re.split(r"[\\/]+", path) if segment]

    def segment_value(name: str, offset: int = 1) -> str | None:
        try:
            index = segments.index(name)
            return segments[index + offset]
        except (ValueError, IndexError):
            return None

    node_id = _uuid(segment_value("nodes") or "")
    chain_id = _uuid(segment_value("chains") or "")
    project_id = _uuid(segment_value("projects") or "")

    if node_id is not None:
        node = (
            ResearchChainNode.objects.select_related(
                "chain__project__research_profile",
                "chain__workspace",
            )
            .filter(pk=node_id, chain__workspace=workspace, deleted_at__isnull=True)
            .first()
        )
        profile = getattr(node.chain.project, "research_profile", None) if node else None
        if node is not None and profile is not None and can_read_project_research_metadata(
            workspace, user, profile
        ):
            return AgentDockTarget(
                type=ResearchContextGrant.TargetType.RESEARCH_CHAIN_NODE,
                workspace=workspace,
                project=node.chain.project,
                chain=node.chain,
                node=node,
            )

    if chain_id is not None:
        chain = (
            ResearchChain.objects.select_related("project__research_profile", "workspace")
            .filter(pk=chain_id, workspace=workspace, deleted_at__isnull=True)
            .exclude(status="DELETED")
            .first()
        )
        profile = getattr(chain.project, "research_profile", None) if chain else None
        if chain is not None and profile is not None and can_read_project_research_metadata(
            workspace, user, profile
        ):
            return AgentDockTarget(
                type=ResearchContextGrant.TargetType.RESEARCH_CHAIN,
                workspace=workspace,
                project=chain.project,
                chain=chain,
            )

    if project_id is not None:
        profile = (
            visible_profile_queryset(workspace, user)
            .filter(project_id=project_id, deleted_at__isnull=True)
            .select_related("project", "workspace")
            .first()
        )
        if profile is not None:
            return AgentDockTarget(
                type=ResearchContextGrant.TargetType.PROJECT,
                workspace=workspace,
                project=profile.project,
            )

    return AgentDockTarget(type=ResearchContextGrant.TargetType.WORKSPACE, workspace=workspace)
MAX_SELECTED_TEXT = 4000
MAX_ATTACHMENT_IDS = 20


def _resource(kind: str, resource_id, title: str, status: str = "", updated_at=None, version=None):
    """Build one safe display-only resource reference."""
    return {
        "kind": kind,
        "id": str(resource_id) if resource_id else None,
        "title": str(title or "")[:300],
        "status": str(status or ""),
        "updated_at": updated_at.isoformat() if hasattr(updated_at, "isoformat") else None,
        **({"version": int(version)} if version is not None else {}),
    }


def _node_resources(node: ResearchChainNode):
    """Collect bounded task/material/upload/event references for one node."""
    tasks = (
        ResearchChainNodeTask.objects.filter(node=node, deleted_at__isnull=True)
        .order_by("-created_at")
        .values("id", "title", "status", "updated_at")[:20]
    )
    materials = (
        ResearchChainStageMaterialItem.objects.filter(
            source_node=node,
            deleted_at__isnull=True,
        )
        .select_related("requirement", "upload")
        .order_by("-updated_at")[:20]
    )
    uploads = ResearchChainUpload.objects.filter(node=node, deleted_at__isnull=True).order_by("-created_at")[:20]
    events = (
        ResearchChainEvent.objects.filter(node=node)
        .order_by("-occurred_at")
        .values("id", "event_type", "summary", "occurred_at")[:10]
    )
    resources = [
        _resource("task", item["id"], item["title"], item["status"], item["updated_at"])
        for item in tasks
    ]
    resources.extend(
        _resource(
            "stage_material",
            item.id,
            item.title,
            item.upload.status if item.upload else "",
            item.updated_at,
        )
        for item in materials
    )
    resources.extend(
        _resource("file", upload.id, upload.file_name, upload.status, upload.updated_at)
        for upload in uploads
    )
    resources.extend(
        _resource("event", item["id"], item["summary"] or item["event_type"], updated_at=item["occurred_at"])
        for item in events
    )
    return resources[:100], uploads


def _build_manifest(target: AgentDockTarget, user, selected_text: str = ""):
    """Build a bounded summary and reference list; file bodies never enter it."""
    lines: list[str] = []
    resources: list[dict] = []
    allowed_knowledge_base_ids: list[str] = []
    allowed_file_ids: list[str] = []

    if target.type == ResearchContextGrant.TargetType.WORKSPACE:
        lines.extend([f"Workspace: {target.workspace.name} ({target.workspace.slug})"])
    elif target.type == ResearchContextGrant.TargetType.PROJECT and target.project is not None:
        profile = getattr(target.project, "research_profile", None)
        lines.extend(
            [
                f"Workspace: {target.workspace.name}",
                f"Research project: {target.project.name}",
                f"Research status: {getattr(profile, 'workflow_status', '')}",
            ]
        )
    elif target.chain is not None:
        profile = getattr(target.chain.project, "research_profile", None)
        stages = target.chain.stage_approvals.filter(deleted_at__isnull=True).order_by("sort_order")
        active_stage = next((stage for stage in stages if stage.status not in ("APPROVED",)), None)
        node_count = target.chain.nodes.filter(deleted_at__isnull=True).count()
        lines.extend(
            [
                f"Workspace: {target.workspace.name}",
                f"Research project: {target.chain.project.name}",
                f"Research chain: {target.chain.id} ({target.chain.status})",
                f"Chain visibility: {getattr(profile, 'chain_visibility', '')}",
                f"Nodes visible in scope: {node_count}",
                f"Current or next stage: {active_stage.stage_code if active_stage else 'not started'}",
            ]
        )
        resources = [
            _resource("stage", stage.id, stage.get_stage_code_display(), stage.status, stage.updated_at)
            for stage in stages[:13]
        ]

    if target.node is not None:
        node_resources, uploads = _node_resources(target.node)
        resources = node_resources
        allowed_file_ids = [str(upload.id) for upload in uploads]
        allowed_knowledge_base_ids = sorted(
            {
                str(upload.knowledge_base_id)
                for upload in uploads
                if upload.knowledge_base_id
            }
        )
        stage = (
            target.chain.stage_approvals.filter(deleted_at__isnull=True, submitted_node=target.node)
            .order_by("-sort_order")
            .first()
        ) if target.chain is not None else None
        assignee = target.node.assignee
        lines.extend(
            [
                f"Current node: {target.node.title} ({target.node.node_type}, {target.node.status})",
                f"Node assignee: {getattr(assignee, 'display_name', None) or getattr(assignee, 'email', 'unassigned')}",
                f"Associated stage: {stage.stage_code if stage else 'not submitted'}",
            ]
        )

    if selected_text:
        lines.extend(["", "User-selected text is attached for this turn only."])

    return {
        "summary": "\n".join(lines)[:12000],
        "resources": resources[:100],
    }, allowed_knowledge_base_ids, allowed_file_ids


def _scope_for_target(workspace, user, target: AgentDockTarget):
    """Classify write capability without broadening read-only sessions."""
    if target.chain is not None:
        if _chain_writer(workspace, user, target.chain):
            return "OWNER", "chain_operator"
        return "REVIEW", "chain_reader"
    return "OWNER", "workspace_member"


def _envelope(grant: ResearchContextGrant, target: AgentDockTarget, user) -> dict:
    """Build the browser-safe context envelope; it is never an auth credential."""
    manifest = grant.context_manifest or {}
    hierarchy = [
        {"type": "workspace", "id": str(target.workspace.id), "title": target.workspace.name}
    ]
    if target.project is not None:
        hierarchy.append({"type": "project", "id": str(target.project.id), "title": target.project.name})
    if target.chain is not None:
        hierarchy.append({"type": "research_chain", "id": str(target.chain.id), "title": str(target.chain.id)})
    if target.node is not None:
        hierarchy.append({"type": "research_chain_node", "id": str(target.node.id), "title": target.node.title})
    resource_kinds: dict[str, int] = {}
    for resource in manifest.get("resources", []):
        kind = str(resource.get("kind") or "other")
        resource_kinds[kind] = resource_kinds.get(kind, 0) + 1
    return {
        "schema_version": "agent-context-envelope.v1",
        "context_id": str(grant.context_id),
        "context_version": grant.context_version,
        "status": "linked",
        "target_type": grant.target_type,
        "target_hierarchy": hierarchy,
        "resources_summary": {
            "total": len(manifest.get("resources", [])),
            "by_kind": resource_kinds,
        },
        "capabilities": {
            "agent": "Synlora workspace assistant",
            "allowed_tools": grant.allowed_tools,
            "allowed_plugins": grant.allowed_plugins,
            "allowed_mcp_ids": grant.allowed_mcp_ids,
            "allowed_knowledge_base_ids": grant.allowed_knowledge_base_ids,
            "allowed_file_ids": grant.allowed_file_ids,
        },
        "expiry": grant.expires_at.isoformat(),
        "session_binding": {
            "workspace_id": str(grant.workspace_id),
            "target_key": target.key,
            "user_id": str(grant.user_id),
        },
    }


def resolve_agent_dock_context(
    *,
    workspace: Workspace,
    user,
    route: str,
    request_id: str,
    selected_text: str = "",
    attachment_ids: list[str] | None = None,
):
    """Resolve a route, enforce ACL, and issue a bounded v3 Context grant.

    Returns:
        ``(grant, raw_token, envelope)``. Only the grant/envelope are safe to
        serialize; the raw token must remain in the backend call path.
    """
    if not request_id:
        raise AgentDockContextError("request_id is required", 400)
    if len(selected_text) > MAX_SELECTED_TEXT:
        raise AgentDockContextError("selected_text exceeds 4000 characters", 413)
    attachment_ids = list(attachment_ids or [])[:MAX_ATTACHMENT_IDS]

    target = _target_from_route(workspace, user, route)
    if target.type == ResearchContextGrant.TargetType.RESEARCH_CHAIN_NODE and target.node is None:
        raise AgentDockContextError("Research node is not accessible", 403)
    if target.type == ResearchContextGrant.TargetType.RESEARCH_CHAIN and target.chain is None:
        raise AgentDockContextError("Research chain is not accessible", 403)

    existing = ResearchContextGrant.objects.filter(request_id=request_id).first()
    if existing is not None:
        if existing.workspace_id != workspace.id or existing.user_id != user.id:
            raise AgentDockContextError("request_id was already used by another user", 409)
        return existing, "", _envelope(existing, target, user)

    manifest, knowledge_ids, file_ids = _build_manifest(target, user, selected_text)
    allowed_tools = (
        sorted(TOOL_NAMES)
        if target.type == ResearchContextGrant.TargetType.RESEARCH_CHAIN_NODE
        and bool(getattr(settings, "RESEARCH_MCP_ENABLED", False))
        else []
    )
    scope_kind, scope_source = _scope_for_target(workspace, user, target)
    grant, token = issue_agent_dock_context_token(
        workspace=workspace,
        user=user,
        target_type=target.type,
        request_id=request_id,
        project=target.project,
        research_chain=target.chain,
        chain_node=target.node,
        visibility_scope=getattr(getattr(target.project, "research_profile", None), "chain_visibility", "WORKSPACE"),
        allowed_tools=allowed_tools,
        allowed_knowledge_base_ids=knowledge_ids,
        allowed_file_ids=file_ids,
        manifest=manifest,
        policy_id=f"agent-dock:{target.key}",
        scope_kind=scope_kind,
        scope_source=scope_source,
        policy_version="agent-dock-policy.v1",
    )
    return grant, token, _envelope(grant, target, user)


def agent_context_v3_for_grant(grant: ResearchContextGrant) -> dict:
    """Convert a stored grant into Synlora agent-context.v3 metadata."""
    target = {
        "type": grant.target_type,
        "workspace_id": str(grant.workspace_id),
        "workspace_slug": grant.workspace.slug,
        "project_id": str(grant.project_id) if grant.project_id else None,
        "research_chain_id": str(grant.research_chain_id) if grant.research_chain_id else None,
        "chain_node_id": str(grant.chain_node_id) if grant.chain_node_id else None,
    }
    subject = {
        "plane_user_id": str(grant.user_id),
        "delegated_subject": f"plane-ws-{grant.workspace_id}-user-{grant.user_id}",
        "scope_kind": grant.scope_kind,
        "scope_source": grant.scope_source,
    }
    policy = {
        "policy_id": grant.policy_id,
        "policy_hash": grant.policy_hash,
        "policy_version": grant.policy_version,
        "visibility_scope": grant.visibility_scope,
        "allowed_tools": grant.allowed_tools,
        "allowed_plugins": grant.allowed_plugins,
        "allowed_mcp_ids": grant.allowed_mcp_ids,
        "allowed_knowledge_base_ids": grant.allowed_knowledge_base_ids,
        "allowed_file_ids": grant.allowed_file_ids,
    }
    manifest = grant.context_manifest or {}
    return {
        "schema_version": "agent-context.v3",
        "context_id": str(grant.context_id),
        "context_hash": grant.context_hash,
        "expires_at": grant.expires_at.isoformat(),
        "target": target,
        "subject": subject,
        "policy": policy,
        **({"manifest": manifest} if manifest else {}),
    }


def context_status(grant: ResearchContextGrant) -> str:
    """Derive the public context state without exposing token internals."""
    if grant.revoked_at is not None:
        return "expired"
    if grant.expires_at <= timezone.now():
        return "expired"
    return "linked"
