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
    ResearchChainNode,
    ResearchContextGrant,
    Workspace,
)
from plane.mcp.catalog import SCHEMAS as UNIFIED_MCP_SCHEMAS
from plane.research.services.agent_page_context import build_page_context
from plane.research.services.context_tokens import issue_agent_dock_context_token
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


def _context_issuer() -> str:
    """Return the normalized Plane issuer URL used by external agent runtimes."""
    return str(getattr(settings, "RESEARCH_CONTEXT_ISSUER_BASE_URL", "") or "").rstrip("/")


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
    explicit_node = segment_value("nodes") is not None
    explicit_chain = segment_value("chains") is not None

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
        if explicit_node:
            raise AgentDockContextError("Research node is not accessible", 403)

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
        if explicit_chain:
            raise AgentDockContextError("Research chain is not accessible", 403)

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
        "schema_version": "agent-context-envelope.v2",
        "context_id": str(grant.context_id),
        "context_version": grant.context_version,
        "status": "linked",
        "target_type": grant.target_type,
        "target_hierarchy": hierarchy,
        "resources_summary": {
            "total": len(manifest.get("resources", [])),
            "by_kind": resource_kinds,
        },
        "manifest_summary": {
            "summary": str(manifest.get("summary") or "")[:12000],
            "resources": [
                {
                    "kind": str(resource.get("kind") or "other"),
                    "id": str(resource.get("id") or ""),
                    "title": str(resource.get("title") or "")[:300],
                    "status": str(resource.get("status") or ""),
                    "updated_at": str(resource.get("updated_at") or ""),
                    **({"version": int(resource["version"])} if resource.get("version") is not None else {}),
                }
                for resource in manifest.get("resources", [])[:100]
                if isinstance(resource, dict)
            ],
        },
        "manifest_hash": str(manifest.get("hash") or ""),
        "page_context": manifest.get("page_context") or {},
        "capabilities": {
            "agent": "Synlora workspace assistant",
            "tool_source": "plane-unified-mcp",
            "allowed_tools": grant.allowed_tools,
            "allowed_plugins": grant.allowed_plugins,
            "allowed_mcp_ids": grant.allowed_mcp_ids,
            "allowed_knowledge_base_ids": grant.allowed_knowledge_base_ids,
            "allowed_file_ids": grant.allowed_file_ids,
        },
        "expiry": grant.expires_at.isoformat(),
        "session_binding": {
            "workspace_id": str(grant.workspace_id),
            "target_key": f"workspace:{target.workspace.id}",
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
    focus_ref: dict | None = None,
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
    attachment_ids = list(attachment_ids or [])
    if len(attachment_ids) > MAX_ATTACHMENT_IDS:
        raise AgentDockContextError("attachment_ids supports at most 20 items", 413)
    if any(_uuid(item) is None for item in attachment_ids):
        raise AgentDockContextError("attachment_ids must be UUIDs", 400)

    target = _target_from_route(workspace, user, route)
    if target.type == ResearchContextGrant.TargetType.RESEARCH_CHAIN_NODE and target.node is None:
        raise AgentDockContextError("Research node is not accessible", 403)
    if target.type == ResearchContextGrant.TargetType.RESEARCH_CHAIN and target.chain is None:
        raise AgentDockContextError("Research chain is not accessible", 403)

    existing = ResearchContextGrant.objects.filter(request_id=request_id).first()
    if existing is not None:
        if existing.workspace_id != workspace.id or existing.user_id != user.id:
            raise AgentDockContextError("request_id was already used by another user", 409)
        # Agent Dock threads are workspace-stable. A route only changes the page
        # seed, so moving between project/chain/node pages never forks history.
        if existing.revoked_at is not None or existing.expires_at <= timezone.now():
            raise AgentDockContextError("Context expired", 403)
        return existing, "", _envelope(existing, target, user)

    page_context = build_page_context(
        workspace=workspace,
        user=user,
        route=route,
        focus_ref=focus_ref,
        selected_text=selected_text,
    )
    manifest = {
        "summary": page_context["summary"],
        "resources": page_context["resources"],
        "page_context": page_context,
    }
    knowledge_ids: list[str] = []
    file_ids: list[str] = []
    allowed_tools = sorted(UNIFIED_MCP_SCHEMAS)
    scope_kind, scope_source = "OWNER", "workspace_member"
    issuer = _context_issuer()
    grant, token = issue_agent_dock_context_token(
        workspace=workspace,
        user=user,
        target_type=ResearchContextGrant.TargetType.WORKSPACE,
        request_id=request_id,
        project=None,
        research_chain=None,
        chain_node=None,
        visibility_scope="WORKSPACE",
        allowed_tools=allowed_tools,
        allowed_knowledge_base_ids=knowledge_ids,
        allowed_file_ids=file_ids,
        manifest=manifest,
        policy_id=f"agent-dock:workspace:{workspace.id}",
        scope_kind=scope_kind,
        scope_source=scope_source,
        policy_version="agent-dock-policy.v1",
        issuer=issuer,
        ttl_seconds=3600,
    )
    return grant, token, _envelope(grant, target, user)


def agent_context_v3_for_grant(grant: ResearchContextGrant) -> dict:
    """Convert a stored grant into Synlora agent-context.v3 metadata."""
    manifest = grant.context_manifest or {}
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
    return {
        "schema_version": "agent-context.v3",
        "issuer": str(manifest.get("issuer") or ""),
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
