# Copyright (c) 2023-present Plane Software, Inc. contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Workspace Agent Dock context BFF."""

from uuid import UUID

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
        events = session.run_events.filter(seq__gt=after_seq).order_by("seq")
        return Response(
            {
                "results": ResearchAgentRunEventSerializer(events, many=True).data,
                "count": events.count(),
                "latest_seq": session.latest_seq,
                "session": serialize_agent_dock_session(session),
            }
        )


class AgentDockRunCancelEndpoint(BaseAPIView):
    """``POST /api/workspaces/<slug>/agent-dock/runs/<run_id>/cancel/``."""

    @allow_permission(allowed_roles=[ROLE.ADMIN, ROLE.MEMBER], level="WORKSPACE")
    def post(self, request, slug, run_id):
        from plane.db.models import ResearchAgentSession
        from plane.research.services.agent_runtime import resolve_synlora_runtime
        from plane.research.services.agent_dock_sessions import serialize_agent_dock_session

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
        if runtime is not None and session.synlora_run_id:
            try:
                runtime.cancel(run_id=session.synlora_run_id)
            except Exception:
                pass
        session.status = ResearchAgentSession.Status.CLOSED
        session.updated_by = request.user
        session.save(update_fields=["status", "updated_by", "updated_at"])
        return Response(serialize_agent_dock_session(session))
