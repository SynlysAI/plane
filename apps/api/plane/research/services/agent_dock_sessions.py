# Copyright (c) 2023-present Plane Software, Inc. contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Target-bound Agent Dock session orchestration over Synlora v1."""

from __future__ import annotations

from django.db import transaction
from django.utils import timezone

from plane.db.models import ResearchAgentRunEvent, ResearchAgentSession, ResearchContextGrant, Workspace
from plane.license.utils.encryption import decrypt_data
from plane.research.services.agent_dock import agent_context_v3_for_grant, context_status
from plane.research.services.agent_runtime import (
    SynloraRuntimeClient,
    SynloraRuntimeError,
    resolve_synlora_runtime,
)
from plane.research.services.chain_projection import (
    SCIENCE_DISCOVERY_AGENT_EVENT_TYPE_MAP,
    SCIENCE_DISCOVERY_TERMINAL_SESSION_STATUS,
    _science_discovery_payload,
    project_science_discovery_events,
)
from plane.research.services.idempotency import payload_hash


class AgentDockSessionError(Exception):
    """Agent Dock session orchestration error with an HTTP status."""

    def __init__(self, message, status_code=400, code="agent_dock_invalid"):
        super().__init__(message)
        self.message = message
        self.status_code = status_code
        self.code = code


def _target_title(grant: ResearchContextGrant) -> str:
    """Build a bounded Synlora session title from the authorized target."""
    if grant.chain_node is not None:
        return grant.chain_node.title[:120]
    if grant.research_chain is not None:
        return f"Research chain {grant.research_chain_id}"[:120]
    if grant.project is not None:
        return grant.project.name[:120]
    return grant.workspace.name[:120]


def _assembly(grant: ResearchContextGrant) -> dict:
    return {
        "persona": "plane-agent-dock",
        "enabled_plugins": grant.allowed_plugins,
        "allowed_tools": grant.allowed_tools,
        "allowed_mcp_ids": grant.allowed_mcp_ids,
        "allowed_knowledge_base_ids": grant.allowed_knowledge_base_ids,
        "allowed_file_ids": grant.allowed_file_ids,
        "unavailable_reasons": [],
        "policy_id": grant.policy_id,
        "scope_kind": grant.scope_kind,
        "scope_source": grant.scope_source,
    }


def serialize_agent_dock_session(session: ResearchAgentSession) -> dict:
    """Return target/state metadata without tokens or context bodies."""
    grant = session.context_grant
    return {
        "schema_version": "agent-dock-session.v1",
        "session_id": str(session.session_id),
        "run_id": str(session.run_id),
        "workspace": str(session.workspace_id),
        "target_type": session.target_type,
        "project": str(session.project_id) if session.project_id else None,
        "research_chain": str(session.research_chain_id) if session.research_chain_id else None,
        "chain_node": str(session.chain_node_id) if session.chain_node_id else None,
        "target_key": (
            f"node:{session.chain_node_id}"
            if session.chain_node_id
            else f"chain:{session.research_chain_id}"
            if session.research_chain_id
            else f"project:{session.project_id}"
            if session.project_id
            else f"workspace:{session.workspace_id}"
        ),
        "context": {
            "context_id": str(grant.context_id),
            "context_version": grant.context_version,
            "status": context_status(grant),
            "expires_at": grant.expires_at.isoformat(),
        },
        "status": session.status,
        "last_error": session.last_error,
        "provider": session.provider,
        "assembly": session.assembly,
        "latest_seq": session.latest_seq,
        "created_at": session.created_at.isoformat(),
        "updated_at": session.updated_at.isoformat(),
    }


def _append_event(session, event_type: str, payload: dict, request_id: str):
    """Append one event with a transactional local sequence."""
    with transaction.atomic():
        locked = ResearchAgentSession.objects.select_for_update().get(pk=session.pk)
        seq = locked.run_events.count() + 1
        event = ResearchAgentRunEvent.objects.create(
            session=locked,
            run_id=locked.run_id,
            seq=seq,
            event_type=event_type,
            payload=payload,
            request_id=request_id,
        )
        locked.latest_seq = seq
        locked.save(update_fields=["latest_seq", "updated_at"])
    return event


def create_agent_dock_session(
    *,
    workspace: Workspace,
    user,
    context_id: str,
    request_id: str,
    runtime: SynloraRuntimeClient | None = None,
):
    """Create a Synlora v1 session and bind it to one authorized target."""
    grant = (
        ResearchContextGrant.objects.select_related(
            "workspace", "user", "project", "research_chain", "chain_node"
        )
        .filter(context_id=context_id, workspace=workspace, user=user, deleted_at__isnull=True)
        .first()
    )
    if grant is None:
        raise AgentDockSessionError("Context not found", 404, "agent_context_not_found")
    if grant.revoked_at is not None or grant.expires_at <= timezone.now():
        raise AgentDockSessionError("Context expired", 403, "agent_context_expired")
    existing = ResearchAgentSession.objects.filter(request_id=request_id).first()
    if existing is not None:
        if existing.workspace_id != workspace.id or existing.user_id != user.id:
            raise AgentDockSessionError("request_id was already used", 409)
        return existing

    runtime = runtime or resolve_synlora_runtime(workspace, user=user)
    if runtime is None:
        raise AgentDockSessionError("Synlora runtime is not configured", 503, "synlora_unavailable")
    context_token = decrypt_data(grant.context_token_encrypted) if grant.context_token_encrypted else ""
    if not context_token:
        raise AgentDockSessionError("Context token is unavailable; resolve context again", 403, "agent_context_expired")
    try:
        synlora_session_id = runtime.create_session(
            title=_target_title(grant),
            research_context=agent_context_v3_for_grant(grant),
            context_token=context_token,
        )
    except SynloraRuntimeError as exc:
        raise AgentDockSessionError(exc.message, exc.status_code, exc.code) from exc

    session = ResearchAgentSession.objects.create(
        workspace=workspace,
        user=user,
        target_type=grant.target_type,
        project=grant.project,
        research_chain=grant.research_chain,
        chain_node=grant.chain_node,
        context_grant=grant,
        status=ResearchAgentSession.Status.READY,
        provider=ResearchAgentSession.Provider.SYNLORA,
        synlora_session_id=synlora_session_id,
        delegated_subject=f"plane-ws-{workspace.id}-user-{user.id}",
        context_token_encrypted=grant.context_token_encrypted,
        assembly=_assembly(grant),
        request_id=request_id,
        payload_hash=payload_hash({"context_id": str(grant.context_id)}),
        created_by=user,
    )
    _append_event(
        session,
        "CONTEXT_ASSEMBLED",
        {"target_type": grant.target_type, "context_version": grant.context_version},
        f"context:{request_id}",
    )
    session.refresh_from_db()
    return session


def start_agent_dock_message(
    *,
    workspace: Workspace,
    user,
    session: ResearchAgentSession,
    content: str,
    request_id: str,
    runtime: SynloraRuntimeClient | None = None,
):
    """Start one background turn with a fresh server-side context snapshot."""
    if not content.strip():
        raise AgentDockSessionError("content is required", 400)
    if not request_id:
        raise AgentDockSessionError("request_id is required", 400)
    if session.user_id != user.id:
        raise AgentDockSessionError("Session not found", 404, "agent_session_not_found")
    grant = session.context_grant
    if grant.revoked_at is not None or grant.expires_at <= timezone.now():
        session.status = ResearchAgentSession.Status.DEGRADED
        session.last_error = "context_expired"
        session.save(update_fields=["status", "last_error", "updated_at"])
        raise AgentDockSessionError("Context expired", 403, "agent_context_expired")

    existing = ResearchAgentRunEvent.objects.filter(request_id=request_id).first()
    if existing is not None:
        if existing.session_id != session.pk:
            raise AgentDockSessionError("request_id was already used", 409)
        return existing

    content_hash = payload_hash({"content": content})
    _append_event(
        session,
        "COMMUNICATION",
        {"direction": "user", "content_hash": content_hash, "length": len(content)},
        request_id,
    )
    runtime = runtime or resolve_synlora_runtime(workspace, user=user)
    if runtime is None:
        raise AgentDockSessionError("Synlora runtime is not configured", 503, "synlora_unavailable")
    context_token = decrypt_data(session.context_token_encrypted) if session.context_token_encrypted else ""
    if not context_token:
        raise AgentDockSessionError("Context token is unavailable; create a new session", 403, "agent_context_expired")
    try:
        synlora_run_id = runtime.start_run(
            thread_id=session.synlora_session_id,
            content=content,
            request_id=request_id,
            research_context=agent_context_v3_for_grant(grant),
            context_token=context_token,
        )
    except SynloraRuntimeError as exc:
        session.status = ResearchAgentSession.Status.DEGRADED
        session.last_error = exc.code
        session.save(update_fields=["status", "last_error", "updated_at"])
        raise AgentDockSessionError(exc.message, exc.status_code, exc.code) from exc
    session.synlora_run_id = synlora_run_id
    session.status = ResearchAgentSession.Status.STREAMING
    session.last_error = ""
    session.updated_by = user
    session.save(update_fields=["synlora_run_id", "status", "last_error", "updated_by", "updated_at"])
    _append_event(
        session,
        "CONTEXT_ASSEMBLED",
        {
            "target_type": grant.target_type,
            "context_version": grant.context_version,
            "manifest_hash": (grant.context_manifest or {}).get("hash", ""),
        },
        f"context:{request_id}",
    )
    session.refresh_from_db()
    return session


def sync_agent_dock_events(
    *,
    workspace: Workspace,
    session: ResearchAgentSession,
    runtime: SynloraRuntimeClient | None = None,
):
    """Pull durable Synlora events and project them into Plane's append-only log."""
    if session.provider != ResearchAgentSession.Provider.SYNLORA or not session.synlora_session_id:
        return session
    runtime = runtime or resolve_synlora_runtime(workspace, user=session.user)
    if runtime is None:
        return session
    remote_after = max(
        [int(event.payload.get("remote_seq") or 0) for event in session.run_events.all()] or [-1]
    )
    try:
        shaped, _cursor, terminal = runtime.pull_events(
            session_id=session.synlora_session_id,
            after_seq=remote_after,
        )
    except SynloraRuntimeError:
        return session
    if not shaped:
        return session
    if session.chain_node is not None:
        project_science_discovery_events(session, shaped, source_system="SYNLORA")
        session.refresh_from_db()
        session.latest_seq = session.run_events.count()
        session.save(update_fields=["latest_seq", "updated_at"])
    else:
        with transaction.atomic():
            locked = ResearchAgentSession.objects.select_for_update().get(pk=session.pk)
            for remote in shaped:
                remote_seq = int(remote.get("sequence") or 0)
                event_body = remote.get("event") if isinstance(remote.get("event"), dict) else {}
                remote_type = str(event_body.get("type") or "")
                request_id = f"dock:{locked.session_id}:{remote_seq}"
                if ResearchAgentRunEvent.objects.filter(request_id=request_id).exists():
                    continue
                next_seq = locked.run_events.count() + 1
                ResearchAgentRunEvent.objects.create(
                    session=locked,
                    run_id=locked.run_id,
                    seq=next_seq,
                    event_type=SCIENCE_DISCOVERY_AGENT_EVENT_TYPE_MAP.get(remote_type, "AI_ACTION"),
                    payload={
                        **_science_discovery_payload(remote_type, event_body),
                        "remote_seq": remote_seq,
                        "remote_type": remote_type,
                    },
                    request_id=request_id,
                )
                locked.latest_seq = next_seq
            terminal_state = SCIENCE_DISCOVERY_TERMINAL_SESSION_STATUS.get(remote_type)
            if terminal_state is not None:
                locked.status = terminal_state[0]
                locked.last_error = terminal_state[1]
            elif remote_type == "permission.required":
                locked.status = ResearchAgentSession.Status.WAITING_APPROVAL
                locked.last_error = ""
            locked.save(update_fields=["latest_seq", "status", "last_error", "updated_at"])
        session = ResearchAgentSession.objects.get(pk=session.pk)
    if terminal == "interrupted":
        session.status = ResearchAgentSession.Status.WAITING_APPROVAL
        session.save(update_fields=["status", "updated_at"])
    return session
