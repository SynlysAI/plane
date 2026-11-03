# Copyright (c) 2023-present Plane Software, Inc. contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Target-bound Agent Dock session orchestration over Synlora v1."""

from __future__ import annotations

from uuid import UUID, uuid4

from django.db import IntegrityError, transaction
from django.utils import timezone

from plane.db.models import (
    ResearchChain,
    ResearchChainNode,
    ResearchAgentRunEvent,
    ResearchAgentSession,
    ResearchChainEvent,
    ResearchContextGrant,
    Workspace,
)
from plane.license.utils.encryption import decrypt_data
from plane.research.services.agent_dock import agent_context_v3_for_grant, context_status
from plane.research.services.agent_dock_mcp import (
    issue_agent_dock_mcp_connection,
    resolve_agent_dock_mcp_credentials,
    revoke_agent_dock_mcp_connection,
)
from plane.research.services.agent_page_context import build_page_context
from plane.research.services.agent_runtime import (
    SynloraRuntimeClient,
    SynloraRuntimeError,
    _is_context_access_tool,
    resolve_synlora_runtime,
    synlora_event_run_id,
)
from plane.research.services.chain_projection import (
    SCIENCE_DISCOVERY_CHAIN_EVENT_TYPE_MAP,
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
    return f"Plane · {grant.workspace.name}"[:120]


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
        "tool_source": "plane-unified-mcp",
    }


def _plane_mcp_metadata(grant: ResearchContextGrant, credential) -> dict:
    """Build the token-free MCP descriptor consumed by one Synlora run."""
    return {
        "schema_version": "plane-mcp-runtime.v1",
        "url": credential.url,
        "connection_id": str(credential.connection.id),
        "allowed_tools": list(grant.allowed_tools or []),
    }


def _sync_page_focus_on_session(session: ResearchAgentSession, page_context: dict) -> None:
    """Keep audit targeting current while preserving workspace-stable history."""
    focus = page_context.get("focus") or {}
    focus_type = str(focus.get("type") or "").upper()
    focus_id = str(focus.get("id") or "")
    node = None
    chain = None
    if focus_type in {"RESEARCH_NODE", "RESEARCH_TASK"}:
        node = ResearchChainNode.objects.select_related("chain", "chain__project").filter(
            pk=focus_id, chain__workspace_id=session.workspace_id, deleted_at__isnull=True
        ).first()
        chain = node.chain if node else None
    elif focus_type == "RESEARCH_CHAIN":
        chain = ResearchChain.objects.select_related("project").filter(
            pk=focus_id, workspace_id=session.workspace_id, deleted_at__isnull=True
        ).exclude(status="DELETED").first()
    session.research_chain = chain
    session.chain_node = node
    session.project = chain.project if chain is not None else None


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
        "source_cursor": int((session.assembly or {}).get("source_cursor", -1)),
        "run_start_cursor": int((session.assembly or {}).get("run_start_cursor", -1)),
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
    bound_session = (
        ResearchAgentSession.objects.select_related(
            "workspace", "user", "project", "research_chain", "chain_node", "context_grant"
        )
        .filter(
            context_grant=grant,
            workspace=workspace,
            user=user,
            deleted_at__isnull=True,
        )
        .first()
    )
    if bound_session is not None:
        return bound_session

    runtime = runtime or resolve_synlora_runtime(workspace, user=user)
    if runtime is None:
        raise AgentDockSessionError("Synlora runtime is not configured", 503, "synlora_unavailable")
    context_token = decrypt_data(grant.context_token_encrypted) if grant.context_token_encrypted else ""
    if not context_token:
        raise AgentDockSessionError("Context token is unavailable; resolve context again", 403, "agent_context_expired")
    try:
        credential = issue_agent_dock_mcp_connection(workspace=workspace, user=user)
    except Exception as exc:
        raise AgentDockSessionError(
            "Plane unified MCP is unavailable", 503, "agent_mcp_unavailable"
        ) from exc
    plane_mcp = _plane_mcp_metadata(grant, credential)
    try:
        synlora_session_id = runtime.create_session(
            title=_target_title(grant),
            research_context=agent_context_v3_for_grant(grant),
            context_token=context_token,
            plane_mcp=plane_mcp,
            mcp_token=credential.token,
        )
    except SynloraRuntimeError as exc:
        revoke_agent_dock_mcp_connection(credential.connection)
        raise AgentDockSessionError(exc.message, exc.status_code, exc.code) from exc

    try:
        session = ResearchAgentSession.objects.create(
            workspace=workspace,
            user=user,
            target_type=grant.target_type,
            project=grant.project,
            research_chain=grant.research_chain,
            chain_node=grant.chain_node,
            context_grant=grant,
            unified_mcp_connection=credential.connection,
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
    except IntegrityError as exc:
        bound_session = (
            ResearchAgentSession.objects.select_related(
                "workspace", "user", "project", "research_chain", "chain_node", "context_grant"
            )
            .filter(
                context_grant=grant,
                workspace=workspace,
                user=user,
                deleted_at__isnull=True,
            )
            .first()
        )
        if bound_session is None:
            raise AgentDockSessionError(
                "Agent Dock session could not be created", 409, "agent_session_conflict"
            ) from exc
        try:
            runtime.close_session(thread_id=synlora_session_id)
            revoke_agent_dock_mcp_connection(credential.connection)
        except Exception:
            # The losing concurrent request only created a redundant upstream
            # session; failing to clean it must not hide the authoritative local one.
            pass
        return bound_session
    _append_event(
        session,
        "CONTEXT_ASSEMBLED",
        {"target_type": grant.target_type, "context_version": grant.context_version},
        f"context:{request_id}",
    )
    session.refresh_from_db()
    return session


def refresh_agent_dock_session_context(
    *,
    workspace: Workspace,
    user,
    session: ResearchAgentSession,
    context_id: str,
):
    """Atomically move one workspace-stable session to a fresh context grant.

    Args:
        workspace: Current workspace.
        user: Current Plane user.
        session: Existing Agent Dock session.
        context_id: Newly resolved context id.

    Returns:
        The updated session.

    Raises:
        AgentDockSessionError: The grant is missing, expired, owned by another user,
            already bound to another session, or the existing session is not workspace-stable.
    """
    try:
        context_uuid = UUID(str(context_id))
    except (TypeError, ValueError) as exc:
        raise AgentDockSessionError("Context not found", 404, "agent_context_not_found") from exc
    grant = (
        ResearchContextGrant.objects.select_related("workspace", "user")
        .filter(
            context_id=context_uuid,
            workspace=workspace,
            user=user,
            deleted_at__isnull=True,
        )
        .first()
    )
    if grant is None:
        raise AgentDockSessionError("Context not found", 404, "agent_context_not_found")
    if grant.revoked_at is not None or grant.expires_at <= timezone.now():
        raise AgentDockSessionError("Context expired", 403, "agent_context_expired")
    if getattr(grant, "agent_session_id", None) is not None and grant.agent_session_id != session.pk:
        raise AgentDockSessionError("Context already bound", 409, "agent_session_conflict")
    if session.target_type != ResearchAgentSession.TargetType.WORKSPACE:
        raise AgentDockSessionError("Session is not workspace-stable", 409, "agent_context_target_changed")

    with transaction.atomic():
        locked = ResearchAgentSession.objects.select_for_update().get(pk=session.pk)
        locked.context_grant = grant
        locked.context_token_encrypted = grant.context_token_encrypted
        locked.assembly = _assembly(grant)
        locked.updated_by = user
        locked.save(update_fields=[
            "context_grant", "context_token_encrypted", "assembly", "updated_by", "updated_at"
        ])
        _append_event(
            locked,
            "CONTEXT_ASSEMBLED",
            {
                "target_type": grant.target_type,
                "context_version": grant.context_version,
                "manifest_hash": (grant.context_manifest or {}).get("hash", ""),
                "refreshed": True,
            },
            f"context-refresh:{grant.context_id}",
        )
    locked.refresh_from_db()
    return locked


def start_agent_dock_message(
    *,
    workspace: Workspace,
    user,
    session: ResearchAgentSession,
    content: str,
    request_id: str,
    route: str = "",
    focus_ref: dict | None = None,
    selected_text: str = "",
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
        if existing.run_id != session.run_id:
            raise AgentDockSessionError("request_id belongs to a previous run", 409)
        return session

    # A session may contain many turns; each request gets its own immutable
    # Plane run id so delayed events can never be attributed to the next turn.
    session.run_id = uuid4()
    persisted_cursor = max(
        [
            int(event.payload["remote_seq"])
            for event in session.run_events.all()
            if event.payload.get("remote_seq") is not None
        ]
        + [int((session.assembly or {}).get("source_cursor", -1))]
    )
    session.assembly = {
        **(session.assembly or {}),
        "source_cursor": persisted_cursor,
        "run_start_cursor": persisted_cursor,
    }
    session.save(update_fields=["run_id", "assembly", "updated_at"])

    runtime = runtime or resolve_synlora_runtime(workspace, user=user)
    if runtime is None:
        raise AgentDockSessionError("Synlora runtime is not configured", 503, "synlora_unavailable")
    context_token = decrypt_data(session.context_token_encrypted) if session.context_token_encrypted else ""
    if not context_token:
        raise AgentDockSessionError("Context token is unavailable; create a new session", 403, "agent_context_expired")
    try:
        credential = resolve_agent_dock_mcp_credentials(
            workspace=workspace,
            user=user,
            connection=session.unified_mcp_connection,
        )
    except Exception as exc:
        raise AgentDockSessionError(
            "Plane unified MCP is unavailable", 503, "agent_mcp_unavailable"
        ) from exc
    session.unified_mcp_connection = credential.connection
    previous_page = (grant.context_manifest or {}).get("page_context") or {}
    effective_route = route or str(previous_page.get("route") or "")
    effective_focus = focus_ref or (previous_page.get("focus") if isinstance(previous_page.get("focus"), dict) else None)
    page_context = build_page_context(
        workspace=workspace,
        user=user,
        route=effective_route,
        focus_ref=effective_focus,
        selected_text=selected_text,
    )
    plane_mcp = _plane_mcp_metadata(grant, credential)
    _sync_page_focus_on_session(session, page_context)
    try:
        synlora_run_id = runtime.start_run(
            thread_id=session.synlora_session_id,
            content=content,
            request_id=request_id,
            research_context=agent_context_v3_for_grant(grant),
            context_token=context_token,
            plane_mcp=plane_mcp,
            mcp_token=credential.token,
            page_context=page_context,
            external_run_id=str(session.run_id),
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
    session.save(update_fields=[
        "unified_mcp_connection", "synlora_run_id", "status", "last_error",
        "updated_by", "updated_at", "research_chain", "chain_node", "project",
    ])
    content_hash = payload_hash({"content": content})
    _append_event(
        session,
        "COMMUNICATION",
        {"direction": "user", "content_hash": content_hash, "length": len(content)},
        request_id,
    )
    _append_event(
        session,
        "CONTEXT_ASSEMBLED",
        {
            "target_type": grant.target_type,
            "context_version": grant.context_version,
            "manifest_hash": (grant.context_manifest or {}).get("hash", ""),
            "page_context_hash": page_context.get("hash", ""),
            "page_kind": page_context.get("page_kind", ""),
            "route": page_context.get("route", ""),
            "mcp_connection_id": str(credential.connection.id),
        },
        f"context:{request_id}",
    )
    session.refresh_from_db()
    return session


def persist_synlora_stream_event(session, envelope: dict) -> ResearchAgentRunEvent | None:
    """幂等保存一个 Synlora 持久事件并同步 Plane 运行终态。

    Args:
        session: 当前已授权的 Agent Dock 会话。
        envelope: 已脱敏的 Agent Dock 统一事件封装。

    Returns:
        新建或已存在的本地事件；瞬态 delta 不落盘时返回 None。
    """
    remote_type = str(envelope.get("raw_event_type") or "")
    if remote_type in {"llm/delta", "reasoning/delta", "assistant.delta", "assistant.thinking.delta"}:
        return None
    source_seq = int(envelope.get("source_seq") or 0)
    if source_seq <= 0:
        return None
    request_id = f"dock:{session.synlora_session_id}:{source_seq}"
    with transaction.atomic():
        locked = ResearchAgentSession.objects.select_for_update().get(pk=session.pk)
        if str(envelope.get("run_id") or "") != str(locked.run_id):
            return None
        existing = ResearchAgentRunEvent.objects.filter(request_id=request_id).first()
        if existing is not None:
            event = existing
        else:
            next_seq = (
                ResearchAgentRunEvent.objects.filter(run_id=locked.run_id)
                .order_by("-seq")
                .values_list("seq", flat=True)
                .first()
                or 0
            ) + 1
            event_type = {
                "output.delta": "OUTPUT",
                "tool.started": "TOOL_CALL",
                "tool.completed": "TOOL_CALL",
                "context.accessed": "DATA_CHANGE",
                "approval.required": "APPROVAL",
                "approval.resolved": "HUMAN_DECISION",
                "run.completed": "OUTPUT",
                "run.failed": "DEGRADED",
                "run.cancelled": "DEGRADED",
            }.get(str(envelope.get("event_type")), "AI_ACTION")
            event = ResearchAgentRunEvent.objects.create(
                session=locked,
                run_id=locked.run_id,
                seq=next_seq,
                event_type=event_type,
                payload={
                    **(envelope.get("payload") if isinstance(envelope.get("payload"), dict) else {}),
                    "remote_seq": source_seq,
                    "remote_type": remote_type,
                    "source_system": "SYNLORA",
                },
                request_id=request_id,
            )
            locked.latest_seq = next_seq
        terminal = {
            "run.completed": (ResearchAgentSession.Status.READY, ""),
            "run.failed": (ResearchAgentSession.Status.DEGRADED, "synlora_run_failed"),
            "run.cancelled": (ResearchAgentSession.Status.READY, "synlora_run_cancelled"),
        }.get(str(envelope.get("event_type")))
        if terminal:
            locked.status, locked.last_error = terminal
        elif envelope.get("event_type") == "approval.required":
            locked.status = ResearchAgentSession.Status.WAITING_APPROVAL
            locked.last_error = ""
        elif envelope.get("event_type") == "approval.resolved":
            locked.status = ResearchAgentSession.Status.STREAMING
            locked.last_error = ""
        assembly = dict(locked.assembly or {})
        assembly["source_cursor"] = max(int(assembly.get("source_cursor", -1)), source_seq)
        locked.assembly = assembly
        locked.save(update_fields=["latest_seq", "status", "last_error", "assembly", "updated_at"])
        if locked.chain_node is not None:
            chain_type = SCIENCE_DISCOVERY_CHAIN_EVENT_TYPE_MAP.get(
                str(envelope.get("event_type")), "AI_ACTION"
            )
            chain_request_id = f"chain:{request_id}"
            remote_payload = envelope.get("payload") if isinstance(envelope.get("payload"), dict) else {}
            ResearchChainEvent.objects.get_or_create(
                request_id=chain_request_id,
                defaults={
                    "chain": locked.chain_node.chain,
                    "node": locked.chain_node,
                    "event_id": payload_hash({"request_id": chain_request_id}),
                    "actor": locked.user,
                    "actor_type": "USER",
                    "source_system": "SYNLORA",
                    "event_type": chain_type,
                    "occurred_at": timezone.now(),
                    "refs": [{"kind": "agent_event", "id": str(event.id), "seq": source_seq}],
                    "summary": remote_type or chain_type,
                    "content_hash": payload_hash(remote_payload),
                },
            )
    return event


def _project_synlora_replay_event(remote_type: str, payload: dict) -> tuple[str, dict] | None:
    """Normalize JSON replay events to the same durable shapes used by SSE."""
    event_type_map = {
        "run.started": "run.started",
        "turn/start": "run.started",
        "assistant.snapshot": "output.delta",
        "assistant.delta": "output.delta",
        "assistant.thinking.delta": "run.progress",
        "assistant.thinking.snapshot": "run.progress",
        "tool.started": "tool.started",
        "tool.completed": "tool.completed",
        "permission.required": "approval.required",
        "agent.phase": "run.progress",
        "artifact.upserted": "tool.completed",
        "run.completed": "run.completed",
        "run.failed": "run.failed",
        "run.cancelled": "run.cancelled",
    }
    event_type = event_type_map.get(remote_type)
    if not event_type:
        return None

    remote_run_id = str(payload.get("remote_run_id") or synlora_event_run_id(payload))
    if remote_type in {"run.started", "turn/start"}:
        shaped_payload = {"remote_run_id": remote_run_id} if remote_run_id else {}
    else:
        shaped_payload = dict(payload)
    if remote_type in {"assistant.thinking.delta", "assistant.thinking.snapshot"}:
        shaped_payload = {"phase": "thinking"}
    elif remote_type == "agent.phase":
        shaped_payload = {"phase": str(payload.get("phase") or "waiting_user")}
    elif remote_type == "assistant.snapshot":
        shaped_payload["final"] = True
    elif remote_type in {"tool.started", "tool.completed"}:
        name = str(payload.get("name") or "tool")
        if payload.get("context_access") or _is_context_access_tool(name):
            arguments = payload.get("arguments") if isinstance(payload.get("arguments"), dict) else {}
            resource_id = payload.get("resource_id") or next(
                (
                    arguments[key]
                    for key in ("resource_id", "file_id", "knowledge_base_id", "kb_id")
                    if arguments.get(key)
                ),
                "",
            )
            result_status = str(payload.get("status") or "COMPLETED").lower()
            shaped_payload = {
                "name": name,
                "tool_call_id": str(payload.get("tool_call_id") or ""),
                "status": "running" if remote_type == "tool.started" else result_status,
                "context_access": True,
            }
            if resource_id:
                shaped_payload["resource_id"] = str(resource_id)
            event_type = "context.accessed"
    elif remote_type == "permission.required":
        request = payload.get("request") if isinstance(payload.get("request"), dict) else {}
        shaped_payload["tool_call_id"] = str(payload.get("tool_call_id") or request.get("id") or "")
    elif remote_type == "artifact.upserted":
        refs = payload.get("refs") if isinstance(payload.get("refs"), list) else []
        resource_id = str((refs[0] or {}).get("id") or "") if refs and isinstance(refs[0], dict) else ""
        shaped_payload = {
            "name": "file/send",
            "status": "completed",
            "result": str(payload.get("summary") or "Artifact created."),
            "resource_id": resource_id,
        }
    if remote_run_id and "remote_run_id" not in shaped_payload:
        shaped_payload["remote_run_id"] = remote_run_id
    return event_type, shaped_payload


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
        [
            int(event.payload["remote_seq"])
            for event in session.run_events.all()
            if event.payload.get("remote_seq") is not None
        ]
        + [int((session.assembly or {}).get("source_cursor", -1))]
    )
    try:
        shaped, _cursor, terminal = runtime.pull_events(
            session_id=session.synlora_session_id,
            after_seq=remote_after,
        )
    except SynloraRuntimeError:
        return session
    if not shaped and session.provider != ResearchAgentSession.Provider.SYNLORA:
        return session
    run_start_cursor = int((session.assembly or {}).get("run_start_cursor", -1))
    current_run_started = any(
        str((event.payload if isinstance(event.payload, dict) else {}).get("remote_run_id") or "")
        == str(session.synlora_run_id or "")
        and str((event.payload if isinstance(event.payload, dict) else {}).get("remote_type") or "")
        in {"turn/start", "run.started"}
        and int((event.payload if isinstance(event.payload, dict) else {}).get("remote_seq") or 0)
        > run_start_cursor
        for event in session.run_events.filter(run_id=session.run_id)
    )
    current_run_terminal = False
    if session.provider == ResearchAgentSession.Provider.SYNLORA:
        pending_approval_ids: set[str] = set()
        for persisted in session.run_events.filter(
            run_id=session.run_id,
            event_type__in=["APPROVAL", "HUMAN_DECISION"],
        ):
            persisted_payload = persisted.payload if isinstance(persisted.payload, dict) else {}
            if int(persisted_payload.get("remote_seq") or 0) > remote_after:
                continue
            tool_call_id = str(persisted_payload.get("tool_call_id") or "")
            if not tool_call_id:
                continue
            if persisted.event_type == "APPROVAL":
                pending_approval_ids.add(tool_call_id)
            else:
                pending_approval_ids.discard(tool_call_id)
        for remote in shaped:
            remote_seq = int(remote.get("sequence") or 0)
            body = remote.get("event") if isinstance(remote.get("event"), dict) else {}
            remote_type = str(body.get("type") or "")
            if remote_seq <= run_start_cursor or current_run_terminal:
                continue
            remote_run_id = str(body.get("remote_run_id") or synlora_event_run_id(body))
            is_run_start = remote_type in {"turn/start", "run.started"}
            if is_run_start:
                if remote_run_id != str(session.synlora_run_id or ""):
                    continue
                current_run_started = True
            elif not current_run_started:
                continue
            elif remote_run_id and remote_run_id != str(session.synlora_run_id or ""):
                continue
            projection = _project_synlora_replay_event(remote_type, body)
            if projection is None:
                continue
            event_type, payload = projection
            tool_call_id = str(payload.get("tool_call_id") or "")
            if event_type == "approval.required" and tool_call_id:
                pending_approval_ids.add(tool_call_id)
            elif event_type == "tool.completed" and tool_call_id in pending_approval_ids:
                event_type = "approval.resolved"
                payload = {
                    "tool_call_id": tool_call_id,
                    "name": str(payload.get("name") or "tool"),
                    "status": str(payload.get("status") or "COMPLETED").upper(),
                    "approval_status": "resolved",
                }
                pending_approval_ids.discard(tool_call_id)
            envelope = {
                "run_id": str(session.run_id),
                "seq": remote_seq,
                "source_seq": remote_seq,
                "event_type": event_type,
                "raw_event_type": remote_type,
                "payload": payload,
            }
            persist_synlora_stream_event(session, envelope)
            current_run_terminal = event_type in {"run.completed", "run.failed", "run.cancelled"}
        with transaction.atomic():
            locked = ResearchAgentSession.objects.select_for_update().get(pk=session.pk)
            assembly = dict(locked.assembly or {})
            assembly["source_cursor"] = max(
                int(assembly.get("source_cursor", -1)), int(_cursor or remote_after)
            )
            locked.assembly = assembly
            locked.save(update_fields=["assembly", "updated_at"])
        return ResearchAgentSession.objects.get(pk=session.pk)
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
