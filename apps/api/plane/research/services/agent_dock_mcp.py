"""Short-lived Plane unified MCP connections for Agent Dock sessions."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import timedelta

from django.conf import settings
from django.utils import timezone

from plane.db.models import UnifiedMCPConnection, Workspace, WorkspaceResearchSetting
from plane.mcp.authorization import issue_connection
from plane.mcp.credentials import recover_credential
from plane.research.services.mcp_catalog import ResearchReadError

CONNECTION_TTL_MINUTES = 60
REUSE_SKEW_MINUTES = 5


@dataclass(frozen=True)
class AgentDockMcpCredential:
    """A server-side-only MCP credential handed to one Synlora run call."""

    connection: UnifiedMCPConnection
    token: str
    url: str


def _workspace_entry(workspace: Workspace, domains: dict[str, str]) -> dict:
    """Build the closed unified MCP issuance shape for one workspace."""
    return {"workspace_id": str(workspace.id), "domains": domains}


def _candidate_domain_sets():
    """Prefer full delegated capability, then narrow to actually permitted domains."""
    return (
        {"administrative": "read_write", "research": "read_write"},
        {"administrative": "read_write", "research": "read"},
        {"administrative": "read", "research": "read_write"},
        {"administrative": "read", "research": "read"},
        {"administrative": "read_write"},
        {"administrative": "read"},
        {"research": "read_write"},
        {"research": "read"},
    )


def _public_mcp_url() -> str:
    """Resolve the externally reachable unified MCP endpoint."""
    base = str(
        getattr(settings, "RESEARCH_CONTEXT_ISSUER_BASE_URL", "")
        or getattr(settings, "WEB_URL", "")
        or getattr(settings, "APP_URL", "")
    ).rstrip("/")
    return f"{base}/api/mcp/"


def issue_agent_dock_mcp_connection(*, workspace: Workspace, user) -> AgentDockMcpCredential:
    """Issue a narrow, short-lived unified MCP connection for an Agent session.

    Args:
        workspace: Workspace selected by the authenticated Plane user.
        user: Current Plane user and connection owner.

    Returns:
        A credential containing the connection, raw token, and public MCP URL.

    Raises:
        ResearchReadError: No administrative/research capability is currently available.
    """
    last_error: Exception | None = None
    for domains in _candidate_domain_sets():
        try:
            connection, raw_token = issue_connection(
                user,
                {
                    "name": f"Agent Dock · {workspace.name}"[:100],
                    "workspaces": [_workspace_entry(workspace, domains)],
                    "include_future_objects": True,
                    "ttl_days": 1,
                },
            )
            break
        except ResearchReadError as exc:
            last_error = exc
    else:
        raise last_error or ResearchReadError("scope_denied", "No unified MCP capability is available.", 403)

    expires_at = timezone.now() + timedelta(minutes=CONNECTION_TTL_MINUTES)
    connection.expires_at = expires_at
    connection.save(update_fields=["expires_at", "updated_at"])
    return AgentDockMcpCredential(
        connection=connection,
        token=raw_token,
        url=_public_mcp_url(),
    )


def resolve_agent_dock_mcp_credentials(
    *,
    workspace: Workspace,
    user,
    connection: UnifiedMCPConnection | None,
) -> AgentDockMcpCredential:
    """Reuse a healthy Agent connection or rotate it before its short expiry.

    Args:
        workspace: Current workspace.
        user: Current Plane user.
        connection: Connection linked to the existing Agent Dock session.

    Returns:
        A live credential with a token recovered only for this call path.
    """
    now = timezone.now()
    # Existing Agent connections were sometimes issued with administrative-only
    # scope while research MCP was disabled. Rotate them as soon as research is
    # enabled so a healthy-looking old credential cannot pin the session to a
    # reduced domain set.
    requires_research = bool(getattr(settings, "RESEARCH_MCP_ENABLED", False))
    research_write_enabled = bool(getattr(settings, "RESEARCH_MCP_WRITE_ENABLED", False)) and (
        WorkspaceResearchSetting.objects.filter(
            workspace=workspace,
            module_enabled=True,
            research_chain_enabled=True,
            research_mcp_write_enabled=True,
        ).exists()
    )
    healthy = (
        connection is not None
        and connection.owner_id == user.id
        and connection.revoked_at is None
        and connection.deleted_at is None
        and connection.expires_at is not None
        and connection.expires_at > now + timedelta(minutes=REUSE_SKEW_MINUTES)
        and any(
            item.get("workspace_id") == str(workspace.id)
            for item in (connection.scope or {}).get("workspaces", [])
        )
        and (not requires_research or any(
            item.get("domains", {}).get("research")
            in ({"read_write"} if research_write_enabled else {"read", "read_write"})
            for item in (connection.scope or {}).get("workspaces", [])
            if item.get("workspace_id") == str(workspace.id)
        ))
    )
    if healthy and connection.token_encrypted:
        try:
            return AgentDockMcpCredential(
                connection=connection,
                token=recover_credential(connection),
                url=_public_mcp_url(),
            )
        except Exception:
            pass
    if connection is not None:
        revoke_agent_dock_mcp_connection(connection)
    return issue_agent_dock_mcp_connection(workspace=workspace, user=user)


def revoke_agent_dock_mcp_connection(connection: UnifiedMCPConnection | None) -> None:
    """Revoke and clear an Agent-owned connection; read receipts remain auditable."""
    if connection is None:
        return
    now = timezone.now()
    if connection.revoked_at is None or connection.token_encrypted:
        connection.revoked_at = connection.revoked_at or now
        connection.token_encrypted = ""
        connection.save(update_fields=["revoked_at", "token_encrypted", "updated_at"])
