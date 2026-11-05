# Copyright (c) 2023-present Plane Software, Inc. contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Workspace Agent Dock context BFF."""

import json
from datetime import datetime, timezone as dt_timezone
from uuid import UUID

from django.http import StreamingHttpResponse
from django.core import signing
from rest_framework import status
from rest_framework.negotiation import BaseContentNegotiation
from rest_framework.response import Response
from django.utils import timezone

from plane.app.permissions import ROLE, allow_permission
from plane.app.views.base import BaseAPIView
from django.db.models import Q
from plane.db.models import ResearchAgentSession, ResearchContextGrant, Workspace
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


class IgnoreAcceptNegotiation(BaseContentNegotiation):
    """Allow browser SSE Accept headers on a DRF streaming endpoint."""

    def select_parser(self, request, parsers):
        return parsers[0]

    def select_renderer(self, request, renderers, format_suffix=None):
        return (renderers[0], renderers[0].media_type)


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
        focus_ref = request.data.get("focus_ref")
        focus_ref = focus_ref if isinstance(focus_ref, dict) else None
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
                focus_ref=focus_ref,
                attachment_ids=attachment_ids,
                provider=str(request.data.get("provider") or ResearchAgentSession.Provider.SYNLORA),
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
            ResearchContextGrant.objects.select_related("workspace", "user", "project", "research_chain", "chain_node")
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


def _session_for_run_or_none(workspace, user, run_id):
    """Resolve a historical run without depending on the session's current run."""
    from plane.db.models import ResearchAgentRunEvent, ResearchAgentSession

    try:
        run_uuid = UUID(str(run_id))
    except (TypeError, ValueError):
        return None
    session = (
        ResearchAgentSession.objects.select_related(
            "workspace",
            "user",
            "project",
            "research_chain",
            "chain_node",
            "context_grant",
        )
        .filter(
            run_id=run_uuid,
            workspace=workspace,
            user=user,
            deleted_at__isnull=True,
        )
        .first()
    )
    if session is not None:
        return session
    event = (
        ResearchAgentRunEvent.objects.select_related(
            "session__workspace",
            "session__user",
            "session__project",
            "session__research_chain",
            "session__chain_node",
            "session__context_grant",
        )
        .filter(
            run_id=run_uuid,
            session__workspace=workspace,
            session__user=user,
            session__deleted_at__isnull=True,
        )
        .order_by("seq")
        .first()
    )
    return event.session if event is not None else None


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
        raw_session_ids = str(request.query_params.get("session_ids") or "")
        route = str(request.query_params.get("route") or "").strip()
        sessions = ResearchAgentSession.objects.select_related(
            "workspace", "project", "research_chain", "chain_node", "context_grant"
        ).filter(workspace=workspace, user=request.user, deleted_at__isnull=True).filter(
            Q(provider="SYNLORA")
            | Q(provider="SCIENCE_DISCOVERY", target_type="WORKSPACE", assembly__persona="plane-agent-dock")
        )
        provider = request.query_params.get("provider")
        if provider:
            if provider not in ResearchAgentSession.Provider.values:
                return Response({"error": "invalid_provider"}, status=status.HTTP_400_BAD_REQUEST)
            sessions = sessions.filter(provider=provider)
        if target_type:
            sessions = sessions.filter(target_type=target_type)
        if route:
            sessions = sessions.filter(context_grant__context_manifest__page_context__route__icontains=route)
        if raw_session_ids:
            session_ids = []
            for value in raw_session_ids.split(",")[:100]:
                try:
                    session_ids.append(UUID(value.strip()))
                except (TypeError, ValueError):
                    continue
            if session_ids:
                sessions = sessions.filter(session_id__in=session_ids)
            else:
                return Response({"results": [], "count": 0})
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
                provider=str(request.data.get("provider") or ResearchAgentSession.Provider.SYNLORA),
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


class AgentDockSessionContextRefreshEndpoint(BaseAPIView):
    """``POST /api/workspaces/<slug>/agent-dock/sessions/<session_id>/context/refresh/``."""

    @allow_permission(allowed_roles=[ROLE.ADMIN, ROLE.MEMBER], level="WORKSPACE")
    def post(self, request, slug, session_id):
        from plane.research.services.agent_dock_sessions import (
            AgentDockSessionError,
            refresh_agent_dock_session_context,
            serialize_agent_dock_session,
        )

        workspace = _workspace_or_none(slug)
        if workspace is None:
            return Response({"error": "Workspace not found"}, status=status.HTTP_404_NOT_FOUND)
        session = _session_or_none(workspace, request.user, session_id)
        if session is None:
            return Response({"error": "agent_session_not_found"}, status=status.HTTP_404_NOT_FOUND)
        context_id = str(request.data.get("context_id") or "")
        try:
            updated = refresh_agent_dock_session_context(
                workspace=workspace,
                user=request.user,
                session=session,
                context_id=context_id,
            )
        except AgentDockSessionError as exc:
            return Response({"error": exc.code, "message": exc.message}, status=exc.status_code)
        return Response(serialize_agent_dock_session(updated))


class AgentDockSessionEventEndpoint(BaseAPIView):
    """分页回放会话的全部轮次；读取本地事实，无需远端连接可用。"""

    @allow_permission(allowed_roles=[ROLE.ADMIN, ROLE.MEMBER], level="WORKSPACE")
    def get(self, request, slug, session_id):
        """使用签名快照游标读取有序事件，保留每个事件的原始 run ID。"""
        from plane.research.services.agent_dock_events import serialize_dock_events
        from plane.research.services.agent_dock_sessions import serialize_agent_dock_session

        workspace = _workspace_or_none(slug)
        if workspace is None:
            return Response({"error": "Workspace not found"}, status=status.HTTP_404_NOT_FOUND)
        session = _session_or_none(workspace, request.user, session_id)
        if session is None:
            return Response({"error": "agent_session_not_found"}, status=status.HTTP_404_NOT_FOUND)
        rows = session.run_events.all()
        salt = "agent-dock.session-events.v1"
        try:
            limit = int(request.query_params.get("limit", 200))
            if not 1 <= limit <= 500:
                raise ValueError
            raw_cursor = request.query_params.get("cursor")
            if raw_cursor:
                cursor = signing.loads(raw_cursor, salt=salt, max_age=3600)
                if cursor["session_id"] != str(session.session_id):
                    raise ValueError
                after_at, after_seq, after_id = cursor["after"]
                after_at, after_id = datetime.fromisoformat(after_at), UUID(after_id)
                rows = rows.filter(
                    Q(created_at__gt=after_at) | Q(created_at=after_at, seq__gt=after_seq)
                    | Q(created_at=after_at, seq=after_seq, pk__gt=after_id)
                )
                upper = cursor["upper"]
            else:
                last = rows.order_by("-created_at", "-seq", "-id").first()
                upper = [last.created_at.isoformat(), last.seq, str(last.pk)] if last else None
            if upper:
                upper_at, upper_seq, upper_id = upper
                upper_at, upper_id = datetime.fromisoformat(upper_at), UUID(upper_id)
                rows = rows.filter(
                    Q(created_at__lt=upper_at) | Q(created_at=upper_at, seq__lt=upper_seq)
                    | Q(created_at=upper_at, seq=upper_seq, pk__lte=upper_id)
                )
        except (signing.BadSignature, ValueError, TypeError, KeyError):
            return Response({"error": "invalid_event_cursor"}, status=status.HTTP_400_BAD_REQUEST)
        events = list(rows.order_by("created_at", "seq", "id")[:limit + 1]) if upper else []
        has_more = len(events) > limit
        events = events[:limit]
        next_cursor = None
        if has_more:
            last = events[-1]
            next_cursor = signing.dumps({
                "session_id": str(session.session_id), "upper": upper,
                "after": [last.created_at.isoformat(), last.seq, str(last.pk)],
            }, salt=salt, compress=True)
        return Response({
            "results": serialize_dock_events(events, session.provider), "count": len(events),
            "next_cursor": next_cursor, "has_more": has_more, "session": serialize_agent_dock_session(session),
        })


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
        focus_ref = request.data.get("focus_ref")
        if request.data.get("provider", session.provider) != session.provider:
            return Response({"error": "agent_context_provider_mismatch"}, status=status.HTTP_409_CONFLICT)
        focus_ref = focus_ref if isinstance(focus_ref, dict) else None
        selected_text = str(request.data.get("selected_text") or "")
        try:
            updated = start_agent_dock_message(
                workspace=workspace,
                user=request.user,
                session=session,
                content=str(request.data.get("content") or ""),
                request_id=request_id_from(request),
                route=str(request.data.get("route") or ""),
                focus_ref=focus_ref,
                selected_text=selected_text,
            )
        except AgentDockSessionError as exc:
            return Response({"error": exc.code, "message": exc.message}, status=exc.status_code)
        return Response(serialize_agent_dock_session(updated))


class AgentDockRunEventEndpoint(BaseAPIView):
    """``GET /api/workspaces/<slug>/agent-dock/runs/<run_id>/events/``."""

    @allow_permission(allowed_roles=[ROLE.ADMIN, ROLE.MEMBER], level="WORKSPACE")
    def get(self, request, slug, run_id):
        from plane.research.services.agent_dock_events import serialize_dock_events
        from plane.research.services.agent_dock_sessions import (
            sync_agent_dock_events,
            serialize_agent_dock_session,
        )

        workspace = _workspace_or_none(slug)
        if workspace is None:
            return Response({"error": "Workspace not found"}, status=status.HTTP_404_NOT_FOUND)
        session = _session_for_run_or_none(workspace, request.user, run_id)
        if session is None:
            return Response({"error": "agent_run_not_found"}, status=status.HTTP_404_NOT_FOUND)
        run_uuid = UUID(str(run_id))
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
                "results": serialize_dock_events(events, session.provider),
                "count": events.count(),
                "latest_seq": events.order_by("-seq").values_list("seq", flat=True).first() or 0,
                "session": serialize_agent_dock_session(session),
            }
        )


class AgentDockRunEventStreamEndpoint(BaseAPIView):
    """受 Plane 权限保护的 Agent Dock SSE BFF。"""

    content_negotiation_class = IgnoreAcceptNegotiation

    @allow_permission(allowed_roles=[ROLE.ADMIN, ROLE.MEMBER], level="WORKSPACE")
    def get(self, request, slug, run_id):
        workspace = _workspace_or_none(slug)
        if workspace is None:
            return Response({"error": "Workspace not found"}, status=status.HTTP_404_NOT_FOUND)
        session = _session_for_run_or_none(workspace, request.user, run_id)
        if session is None:
            return Response({"error": "agent_run_not_found"}, status=status.HTTP_404_NOT_FOUND)
        if session.context_grant.revoked_at is not None or session.context_grant.expires_at <= timezone.now():
            return Response({"error": "agent_context_expired"}, status=status.HTTP_403_FORBIDDEN)
        if session.provider == ResearchAgentSession.Provider.SCIENCE_DISCOVERY:
            from plane.research.services.agent_dock_science_discovery import (
                sd_client_for_session, stream_sd_dock_events,
            )
            from plane.research.services.sciencediscovery import ScienceDiscoveryError

            try:
                after_seq = int(request.headers.get("Last-Event-ID", request.query_params.get("after_seq", 0)))
                if after_seq < -1:
                    raise ValueError
            except (TypeError, ValueError):
                return Response({"error": "invalid_event_cursor"}, status=status.HTTP_400_BAD_REQUEST)
            try:
                sd_client_for_session(session)
            except ScienceDiscoveryError as exc:
                return Response({"error": exc.code}, status=exc.status_code)

            def sd_body():
                """包装 SD HTTP 事件并把连接错误转成可重试状态帧。"""
                try:
                    yield from stream_sd_dock_events(session=session, run_id=UUID(str(run_id)), after_seq=after_seq)
                except Exception as exc:
                    envelope = {
                        "schema_version": "agent-dock-event.v1", "run_id": str(run_id), "seq": 0,
                        "source_seq": 0, "created_at": timezone.now().isoformat(), "event_type": "stream.error",
                        "payload": {"code": getattr(exc, "code", "science_discovery_event_cursor_failed")},
                    }
                    yield f"event: stream.error\ndata: {json.dumps(envelope)}\n\n"

            response = StreamingHttpResponse(sd_body(), content_type="text/event-stream")
            response["Cache-Control"] = "no-cache, no-transform"
            response["X-Accel-Buffering"] = "no"
            response["Content-Encoding"] = "identity"
            return response
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
                    elif not run_started or (remote_run_id and remote_run_id != str(session.synlora_run_id or "")):
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
                        f"event: {event_name}\nid: {source_seq}\ndata: {json.dumps(envelope, ensure_ascii=False)}\n\n"
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
        from plane.research.services.agent_runtime import SynloraRuntimeError, resolve_synlora_runtime
        from plane.research.services.agent_dock_sessions import (
            serialize_agent_dock_session,
            sync_agent_dock_events,
        )

        workspace = _workspace_or_none(slug)
        if workspace is None:
            return Response({"error": "Workspace not found"}, status=status.HTTP_404_NOT_FOUND)
        session = _session_for_run_or_none(workspace, request.user, run_id)
        if session is None:
            return Response({"error": "agent_run_not_found"}, status=status.HTTP_404_NOT_FOUND)
        try:
            run_uuid = UUID(str(run_id))
        except (TypeError, ValueError):
            return Response({"error": "agent_run_not_found"}, status=status.HTTP_404_NOT_FOUND)
        if session.run_id != run_uuid:
            return Response(serialize_agent_dock_session(session))
        if session.provider == ResearchAgentSession.Provider.SCIENCE_DISCOVERY:
            from plane.research.services.agent_dock_science_discovery import cancel_sd_dock_run

            return Response(serialize_agent_dock_session(cancel_sd_dock_run(session)))
        runtime = resolve_synlora_runtime(workspace, user=session.user)
        if session.synlora_run_id and runtime is None:
            return Response(
                {"error": "synlora_unavailable"},
                status=status.HTTP_503_SERVICE_UNAVAILABLE,
            )
        if runtime is not None and session.synlora_run_id:
            try:
                runtime.cancel(run_id=session.synlora_run_id)
            except SynloraRuntimeError as exc:
                return Response(
                    {"error": exc.code, "message": exc.message},
                    status=exc.status_code,
                )
            session = sync_agent_dock_events(workspace=workspace, session=session, runtime=runtime)
        return Response(serialize_agent_dock_session(session))


class AgentDockRunAnswerEndpoint(BaseAPIView):
    """``POST /api/workspaces/<slug>/agent-dock/runs/<run_id>/answer/``."""

    @allow_permission(allowed_roles=[ROLE.ADMIN, ROLE.MEMBER], level="WORKSPACE")
    def post(self, request, slug, run_id):
        from plane.research.services.agent_runtime import SynloraRuntimeError, resolve_synlora_runtime
        from plane.research.services.agent_dock_sessions import serialize_agent_dock_session

        workspace = _workspace_or_none(slug)
        if workspace is None:
            return Response({"error": "Workspace not found"}, status=status.HTTP_404_NOT_FOUND)
        session = _session_for_run_or_none(workspace, request.user, run_id)
        if session is None:
            return Response({"error": "agent_run_not_found"}, status=status.HTTP_404_NOT_FOUND)
        approved = request.data.get("approved") is True
        if session.run_id != UUID(str(run_id)):
            return Response({"error": "agent_run_not_current"}, status=status.HTTP_409_CONFLICT)
        if session.provider == ResearchAgentSession.Provider.SCIENCE_DISCOVERY:
            from plane.research.services.agent_dock_science_discovery import answer_sd_dock_run
            from plane.research.services.agent_dock_sessions import AgentDockSessionError
            from plane.research.services.sciencediscovery import ScienceDiscoveryError

            try:
                permission_request_id = request.data.get("permission_request_id")
                if permission_request_id is not None and (
                    not isinstance(permission_request_id, str)
                    or not permission_request_id
                    or len(permission_request_id) > 128
                ):
                    return Response({"error": "invalid_permission_request_id"}, status=status.HTTP_400_BAD_REQUEST)
                updated = answer_sd_dock_run(
                    session=session, approved=approved, permission_request_id=permission_request_id,
                )
            except (ScienceDiscoveryError, AgentDockSessionError) as exc:
                return Response({"error": exc.code, "message": exc.message}, status=exc.status_code)
            return Response(serialize_agent_dock_session(updated))
        runtime = resolve_synlora_runtime(workspace, user=session.user)
        if session.synlora_run_id and runtime is None:
            return Response({"error": "synlora_unavailable"}, status=status.HTTP_503_SERVICE_UNAVAILABLE)
        if runtime is not None and session.synlora_run_id:
            try:
                runtime.answer(run_id=session.synlora_run_id, approved=approved)
            except SynloraRuntimeError as exc:
                return Response(
                    {"error": exc.code, "message": exc.message},
                    status=exc.status_code,
                )
        return Response(serialize_agent_dock_session(session))
