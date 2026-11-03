# Copyright (c) 2023-present Plane Software, Inc. contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Workspace Agent Dock context BFF."""

import json
from datetime import datetime, timezone as dt_timezone
from uuid import UUID

from django.http import StreamingHttpResponse
from rest_framework import status
from rest_framework.response import Response
from django.utils import timezone

from plane.app.permissions import ROLE, allow_permission
from plane.app.views.base import BaseAPIView
from plane.db.models import ResearchContextGrant, Workspace
from plane.research.services.agent_dock import (
    AgentDockContextError,
    AgentDockTarget,
    _envelope,
    resolve_agent_dock_context,
)
from plane.research.services.agent_runtime import (
    project_synlora_stream_event,
    resolve_synlora_runtime,
    synlora_event_run_id,
)
from plane.research.services.agent_dock_sessions import persist_synlora_stream_event
from plane.research.services.idempotency import request_id_from


def _workspace_or_none(slug: str):
    return Workspace.objects.filter(slug=slug).first()


class AgentDockContextResolveEndpoint(BaseAPIView):
    """``POST /api/workspaces/<slug>/agent-dock/context/resolve/``."""

    @allow_permission(allowed_roles=[ROLE.ADMIN, ROLE.MEMBER], level="WORKSPACE")
    def post(self, request, slug):
        workspace = _workspace_or_none(slug)
        if workspace is None:
            return Response({"error": "Workspace not found"}, status=status.HTTP_404_NOT_FOUND)
        route = str(request.data.get("route") or "")
        request_id = request_id_from(request)
        selected_text = str(request.data.get("selected_text") or "")
        raw_attachments = request.data.get("attachment_ids") or []
        attachment_ids = [str(item) for item in raw_attachments] if isinstance(raw_attachments, list) else []
        try:
            _grant, _token, envelope = resolve_agent_dock_context(
                workspace=workspace,
                user=request.user,
                route=route,
                request_id=request_id,
                selected_text=selected_text,
                attachment_ids=attachment_ids,
            )
        except AgentDockContextError as exc:
            return Response(
                {"error": "agent_context_invalid", "message": exc.message},
                status=exc.status_code,
            )
        return Response(envelope, status=status.HTTP_201_CREATED)


class AgentDockContextDetailEndpoint(BaseAPIView):
    """``GET /api/workspaces/<slug>/agent-dock/context/<context_id>/``."""

    @allow_permission(allowed_roles=[ROLE.ADMIN, ROLE.MEMBER], level="WORKSPACE")
    def get(self, request, slug, context_id):
        workspace = _workspace_or_none(slug)
        if workspace is None:
            return Response({"error": "Workspace not found"}, status=status.HTTP_404_NOT_FOUND)
        try:
            context_uuid = UUID(str(context_id))
        except (TypeError, ValueError):
            return Response({"error": "agent_context_invalid"}, status=status.HTTP_400_BAD_REQUEST)
        grant = (
            ResearchContextGrant.objects.select_related(
                "workspace", "user", "project", "research_chain", "chain_node"
            )
            .filter(context_id=context_uuid, workspace=workspace, user=request.user, deleted_at__isnull=True)
            .first()
        )
        if grant is None:
            return Response({"error": "agent_context_not_found"}, status=status.HTTP_404_NOT_FOUND)
        target = AgentDockTarget(
            type=grant.target_type,
            workspace=grant.workspace,
            project=grant.project,
            chain=grant.research_chain,
            node=grant.chain_node,
        )
        envelope = _envelope(grant, target, request.user)
        envelope["status"] = (
            "expired" if grant.revoked_at is not None or grant.expires_at <= timezone.now() else "linked"
        )
        return Response(envelope)


def _session_or_none(workspace, user, session_id):
    from plane.db.models import ResearchAgentSession

    try:
        from uuid import UUID as _UUID

        session_uuid = _UUID(str(session_id))
    except (TypeError, ValueError):
        return None
    return (
        ResearchAgentSession.objects.select_related(
            "workspace",
            "user",
            "project",
            "research_chain",
            "chain_node",
            "context_grant",
        )
        .filter(
            session_id=session_uuid,
            workspace=workspace,
            user=user,
            deleted_at__isnull=True,
        )
        .first()
    )


class AgentDockSessionCollectionEndpoint(BaseAPIView):
    """``GET/POST /api/workspaces/<slug>/agent-dock/sessions/``."""

    @allow_permission(allowed_roles=[ROLE.ADMIN, ROLE.MEMBER], level="WORKSPACE")
    def get(self, request, slug):
        from plane.db.models import ResearchAgentSession
        from plane.research.services.agent_dock_sessions import serialize_agent_dock_session

        workspace = _workspace_or_none(slug)
        if workspace is None:
            return Response({"error": "Workspace not found"}, status=status.HTTP_404_NOT_FOUND)
        target_type = str(request.query_params.get("target_type") or "")
        sessions = (
            ResearchAgentSession.objects.select_related(
                "workspace", "project", "research_chain", "chain_node", "context_grant"
            )
            .filter(workspace=workspace, user=request.user, deleted_at__isnull=True)
        )
        if target_type:
            sessions = sessions.filter(target_type=target_type)
        sessions = sessions.order_by("-updated_at")[:100]
        results = [serialize_agent_dock_session(session) for session in sessions]
        return Response({"results": results, "count": len(results)})



    @allow_permission(allowed_roles=[ROLE.ADMIN, ROLE.MEMBER], level="WORKSPACE")
    def post(self, request, slug):
        """Create a target-bound Synlora v1 session."""
        from plane.research.services.agent_dock_sessions import (
            AgentDockSessionError,
            create_agent_dock_session,
            serialize_agent_dock_session,
        )

        workspace = _workspace_or_none(slug)
        if workspace is None:
            return Response({"error": "Workspace not found"}, status=status.HTTP_404_NOT_FOUND)
        try:
            session = create_agent_dock_session(
                workspace=workspace,
                user=request.user,
                context_id=str(request.data.get("context_id") or ""),
                request_id=request_id_from(request),
            )
        except AgentDockSessionError as exc:
            return Response({"error": exc.code, "message": exc.message}, status=exc.status_code)
        return Response(serialize_agent_dock_session(session), status=status.HTTP_201_CREATED)


class AgentDockSessionDetailEndpoint(BaseAPIView):
    """``GET /api/workspaces/<slug>/agent-dock/sessions/<session_id>/``."""

    @allow_permission(allowed_roles=[ROLE.ADMIN, ROLE.MEMBER], level="WORKSPACE")
    def get(self, request, slug, session_id):
        from plane.research.services.agent_dock_sessions import serialize_agent_dock_session

        workspace = _workspace_or_none(slug)
        if workspace is None:
            return Response({"error": "Workspace not found"}, status=status.HTTP_404_NOT_FOUND)
        session = _session_or_none(workspace, request.user, session_id)
        if session is None:
            return Response({"error": "agent_session_not_found"}, status=status.HTTP_404_NOT_FOUND)
        return Response(serialize_agent_dock_session(session))


class AgentDockSessionMessageEndpoint(BaseAPIView):
    """``POST /api/workspaces/<slug>/agent-dock/sessions/<session_id>/messages/``."""

    @allow_permission(allowed_roles=[ROLE.ADMIN, ROLE.MEMBER], level="WORKSPACE")
    def post(self, request, slug, session_id):
        from plane.research.services.agent_dock_sessions import (
            AgentDockSessionError,
            serialize_agent_dock_session,
            start_agent_dock_message,
        )

        workspace = _workspace_or_none(slug)
        if workspace is None:
            return Response({"error": "Workspace not found"}, status=status.HTTP_404_NOT_FOUND)
        session = _session_or_none(workspace, request.user, session_id)
        if session is None:
            return Response({"error": "agent_session_not_found"}, status=status.HTTP_404_NOT_FOUND)
        try:
            updated = start_agent_dock_message(
                workspace=workspace,
                user=request.user,
                session=session,
                content=str(request.data.get("content") or ""),
                request_id=request_id_from(request),
            )
        except AgentDockSessionError as exc:
            return Response({"error": exc.code, "message": exc.message}, status=exc.status_code)
        return Response(serialize_agent_dock_session(updated))


class AgentDockRunEventEndpoint(BaseAPIView):
    """``GET /api/workspaces/<slug>/agent-dock/runs/<run_id>/events/``."""

    @allow_permission(allowed_roles=[ROLE.ADMIN, ROLE.MEMBER], level="WORKSPACE")
    def get(self, request, slug, run_id):
        from plane.db.models import ResearchAgentSession
        from plane.research.serializers import ResearchAgentRunEventSerializer
        from plane.research.services.agent_dock_sessions import (
            sync_agent_dock_events,
            serialize_agent_dock_session,
        )

        workspace = _workspace_or_none(slug)
        if workspace is None:
            return Response({"error": "Workspace not found"}, status=status.HTTP_404_NOT_FOUND)
        try:
            from uuid import UUID as _UUID

            run_uuid = _UUID(str(run_id))
        except (TypeError, ValueError):
            return Response({"error": "agent_run_not_found"}, status=status.HTTP_404_NOT_FOUND)
        session = (
            ResearchAgentSession.objects.select_related(
                "workspace", "user", "project", "research_chain", "chain_node", "context_grant"
            )
            .filter(run_id=run_uuid, workspace=workspace, user=request.user, deleted_at__isnull=True)
            .first()
        )
        if session is None:
            return Response({"error": "agent_run_not_found"}, status=status.HTTP_404_NOT_FOUND)
        session = sync_agent_dock_events(workspace=workspace, session=session)
        try:
            after_seq = int(request.query_params.get("after_seq", 0))
        except (TypeError, ValueError):
            after_seq = -1
        if after_seq < 0:
            return Response({"error": "after_seq must be non-negative"}, status=status.HTTP_400_BAD_REQUEST)
        events = session.run_events.filter(run_id=run_uuid, seq__gt=after_seq).order_by("seq")
        return Response(
            {
                "results": ResearchAgentRunEventSerializer(events, many=True).data,
                "count": events.count(),
                "latest_seq": events.order_by("-seq").values_list("seq", flat=True).first() or 0,
                "session": serialize_agent_dock_session(session),
            }
        )


class AgentDockRunEventStreamEndpoint(BaseAPIView):
    """受 Plane 权限保护的 Agent Dock SSE BFF。"""

    @allow_permission(allowed_roles=[ROLE.ADMIN, ROLE.MEMBER], level="WORKSPACE")
    def get(self, request, slug, run_id):
        from plane.db.models import ResearchAgentSession

        workspace = _workspace_or_none(slug)
        if workspace is None:
            return Response({"error": "Workspace not found"}, status=status.HTTP_404_NOT_FOUND)
        try:
            run_uuid = UUID(str(run_id))
        except (TypeError, ValueError):
            return Response({"error": "agent_run_not_found"}, status=status.HTTP_404_NOT_FOUND)
        session = (
            ResearchAgentSession.objects.select_related("workspace", "user", "context_grant")
            .filter(run_id=run_uuid, workspace=workspace, user=request.user, deleted_at__isnull=True)
            .first()
        )
        if session is None:
            return Response({"error": "agent_run_not_found"}, status=status.HTTP_404_NOT_FOUND)
        if session.context_grant.revoked_at is not None or session.context_grant.expires_at <= timezone.now():
            return Response({"error": "agent_context_expired"}, status=status.HTTP_403_FORBIDDEN)
        if not session.synlora_session_id:
            return Response({"error": "synlora_session_not_found"}, status=status.HTTP_409_CONFLICT)
        try:
            cursor_value = request.headers.get("Last-Event-ID")
            if cursor_value is None:
                cursor_value = request.query_params.get("after_seq")
            if cursor_value is None:
                cursor_value = (session.assembly or {}).get("source_cursor", -1)
            after_seq = int(cursor_value)
        except (TypeError, ValueError):
            return Response({"error": "invalid_event_cursor"}, status=status.HTTP_400_BAD_REQUEST)
        if after_seq < -1:
            return Response({"error": "invalid_event_cursor"}, status=status.HTTP_400_BAD_REQUEST)
        runtime = resolve_synlora_runtime(workspace, user=request.user)
        if runtime is None:
            return Response({"error": "synlora_unavailable"}, status=status.HTTP_503_SERVICE_UNAVAILABLE)

        def sse_body():
            """先发状态帧，再代理已注册的 Synlora 回放与实时事件。"""
            assembly = session.assembly or {}
            run_start_cursor = int(assembly.get("run_start_cursor", assembly.get("source_cursor", -1)))
            run_started = any(
                str((item.payload if isinstance(item.payload, dict) else {}).get("remote_run_id") or "")
                == str(session.synlora_run_id or "")
                and str((item.payload if isinstance(item.payload, dict) else {}).get("remote_type") or "")
                in {"turn/start", "run.started"}
                and int((item.payload if isinstance(item.payload, dict) else {}).get("remote_seq") or 0)
                > run_start_cursor
                for item in session.run_events.filter(run_id=session.run_id)
            )
            last_source_seq = after_seq
            pending_approval_ids: set[str] = set()
            for persisted in session.run_events.filter(
                run_id=session.run_id,
                event_type__in=["APPROVAL", "HUMAN_DECISION"],
            ).order_by("seq"):
                persisted_payload = persisted.payload if isinstance(persisted.payload, dict) else {}
                if int(persisted_payload.get("remote_seq") or 0) > after_seq:
                    continue
                call_id = str(persisted_payload.get("tool_call_id") or "")
                if not call_id:
                    continue
                if persisted.event_type == "APPROVAL" and persisted_payload.get("kind") == "approval":
                    pending_approval_ids.add(call_id)
                elif persisted.event_type == "HUMAN_DECISION":
                    pending_approval_ids.discard(call_id)
            now = datetime.now(dt_timezone.utc).isoformat()
            yield ": heartbeat\n\n"
            bound = {
                "schema_version": "agent-dock-event.v1",
                "run_id": str(session.run_id),
                "seq": 0,
                "source_seq": 0,
                "created_at": now,
                "event_type": "context.bound",
                "raw_event_type": "context.bound",
                "payload": {
                    "context_id": str(session.context_grant.context_id),
                    "context_version": session.context_grant.context_version,
                    "grant_status": "linked",
                    "target_type": session.target_type,
                    "manifest_hash": str((session.context_grant.context_manifest or {}).get("hash") or ""),
                },
            }
            yield f"event: context.bound\ndata: {json.dumps(bound, ensure_ascii=False)}\n\n"
            try:
                for raw in runtime.stream_events(session_id=session.synlora_session_id, after_seq=after_seq):
                    if raw.get("_heartbeat"):
                        heartbeat = {
                            "schema_version": "agent-dock-event.v1",
                            "run_id": str(session.run_id),
                            "seq": 0,
                            "source_seq": max(after_seq, 0),
                            "created_at": datetime.now(dt_timezone.utc).isoformat(),
                            "event_type": "heartbeat",
                            "raw_event_type": "heartbeat",
                            "payload": {},
                        }
                        yield f"event: heartbeat\ndata: {json.dumps(heartbeat)}\n\n"
                        continue
                    raw_seq = int(raw.get("seq") or 0)
                    if raw_seq > 0 and raw_seq <= last_source_seq:
                        continue
                    if raw_seq > 0:
                        last_source_seq = raw_seq
                    payload = raw.get("payload") if isinstance(raw.get("payload"), dict) else {}
                    remote_run_id = synlora_event_run_id(payload)
                    raw_type = str(raw.get("type") or "")
                    is_run_start = raw_type in {"turn/start", "run.started"}
                    if is_run_start:
                        if remote_run_id != str(session.synlora_run_id or ""):
                            cursor_event = {
                                "schema_version": "agent-dock-event.v1",
                                "run_id": str(session.run_id),
                                "seq": raw_seq,
                                "source_seq": raw_seq,
                                "created_at": datetime.now(dt_timezone.utc).isoformat(),
                                "event_type": "heartbeat",
                                "raw_event_type": "heartbeat",
                                "payload": {},
                            }
                            yield f"event: heartbeat\nid: {raw_seq}\ndata: {json.dumps(cursor_event)}\n\n"
                            continue
                        run_started = True
                    elif (
                        not run_started
                        or (remote_run_id and remote_run_id != str(session.synlora_run_id or ""))
                    ):
                        cursor_event = {
                            "schema_version": "agent-dock-event.v1",
                            "run_id": str(session.run_id),
                            "seq": raw_seq,
                            "source_seq": raw_seq,
                            "created_at": datetime.now(dt_timezone.utc).isoformat(),
                            "event_type": "heartbeat",
                            "raw_event_type": "heartbeat",
                            "payload": {},
                        }
                        yield f"event: heartbeat\nid: {raw_seq}\ndata: {json.dumps(cursor_event)}\n\n"
                        continue
                    envelope = project_synlora_stream_event(
                        raw,
                        run_id=str(session.run_id),
                        created_at=datetime.now(dt_timezone.utc).isoformat(),
                    )
                    source_seq = int((envelope or {}).get("source_seq") or raw_seq)
                    approval_tool_call_id = str(payload.get("tool_call_id") or "")
                    if raw.get("type") == "ask/user" and payload.get("kind") == "approval":
                        if approval_tool_call_id:
                            pending_approval_ids.add(approval_tool_call_id)
                    elif (
                        raw.get("type") == "tool/result"
                        and approval_tool_call_id in pending_approval_ids
                        and envelope is not None
                    ):
                        pending_approval_ids.discard(approval_tool_call_id)
                        envelope = {
                            **envelope,
                            "event_type": "approval.resolved",
                            "payload": {
                                "tool_call_id": approval_tool_call_id,
                                "name": str(payload.get("name") or "tool"),
                                "status": "COMPLETED" if payload.get("ok", True) else "FAILED",
                                "approval_status": "resolved",
                            },
                        }
                    if envelope is None:
                        cursor_event = {
                            "schema_version": "agent-dock-event.v1",
                            "run_id": str(session.run_id),
                            "seq": source_seq,
                            "source_seq": source_seq,
                            "created_at": datetime.now(dt_timezone.utc).isoformat(),
                            "event_type": "heartbeat",
                            "raw_event_type": "heartbeat",
                            "payload": {},
                        }
                        yield f"event: heartbeat\nid: {source_seq}\ndata: {json.dumps(cursor_event)}\n\n"
                        continue
                    persist_synlora_stream_event(session, envelope)
                    event_name = str(envelope["event_type"])
                    yield (
                        f"event: {event_name}\n"
                        f"id: {source_seq}\n"
                        f"data: {json.dumps(envelope, ensure_ascii=False)}\n\n"
                    )
                    if event_name in {"run.completed", "run.failed", "run.cancelled"}:
                        break
            except Exception as exc:
                error = {
                    "schema_version": "agent-dock-event.v1",
                    "run_id": str(session.run_id),
                    "seq": 0,
                    "source_seq": max(after_seq, 0),
                    "created_at": datetime.now(dt_timezone.utc).isoformat(),
                    "event_type": "stream.error",
                    "raw_event_type": "stream.error",
                    "payload": {"code": getattr(exc, "code", "synlora_stream_failed")},
                }
                yield f"event: stream.error\ndata: {json.dumps(error, ensure_ascii=False)}\n\n"

        response = StreamingHttpResponse(sse_body(), content_type="text/event-stream")
        response["Cache-Control"] = "no-cache, no-transform"
        response["X-Accel-Buffering"] = "no"
        response["Content-Encoding"] = "identity"
        return response


class AgentDockRunCancelEndpoint(BaseAPIView):
    """``POST /api/workspaces/<slug>/agent-dock/runs/<run_id>/cancel/``."""

    @allow_permission(allowed_roles=[ROLE.ADMIN, ROLE.MEMBER], level="WORKSPACE")
    def post(self, request, slug, run_id):
        from plane.db.models import ResearchAgentSession
        from plane.research.services.agent_runtime import SynloraRuntimeError, resolve_synlora_runtime
        from plane.research.services.agent_dock_sessions import (
            serialize_agent_dock_session,
            sync_agent_dock_events,
        )

        workspace = _workspace_or_none(slug)
        if workspace is None:
            return Response({"error": "Workspace not found"}, status=status.HTTP_404_NOT_FOUND)
        session = (
            ResearchAgentSession.objects.select_related("workspace", "user", "context_grant")
            .filter(run_id=run_id, workspace=workspace, user=request.user, deleted_at__isnull=True)
            .first()
        )
        if session is None:
            return Response({"error": "agent_run_not_found"}, status=status.HTTP_404_NOT_FOUND)
        runtime = resolve_synlora_runtime(workspace, user=session.user)
        if session.synlora_run_id and runtime is None:
            return Response(
                {"error": "synlora_unavailable"},
                status=status.HTTP_503_SERVICE_UNAVAILABLE,
            )
        if runtime is not None and session.synlora_run_id:
            try:
                cancelled = runtime.cancel(run_id=session.synlora_run_id)
            except SynloraRuntimeError as exc:
                return Response(
                    {"error": exc.code, "message": exc.message},
                    status=exc.status_code,
                )
            if not cancelled:
                return Response(
                    {"error": "synlora_cancel_failed"},
                    status=status.HTTP_502_BAD_GATEWAY,
                )
            session = sync_agent_dock_events(workspace=workspace, session=session, runtime=runtime)
        return Response(serialize_agent_dock_session(session))
