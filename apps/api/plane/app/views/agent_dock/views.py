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
