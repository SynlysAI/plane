# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Workspace AI-assistant BFF: proxies the Synlora Run API with SSE pass-through.

The browser never talks to Synlora directly — the workspace session
authenticates, and the connection credential stays server-side. The run
events endpoint streams Synlora's SSE frames through byte-for-byte so the
frontend sees tokens as they arrive.
"""

from uuid import uuid4

import httpx
from django.http import StreamingHttpResponse
from rest_framework import status
from rest_framework.negotiation import BaseContentNegotiation
from rest_framework.response import Response

from plane.app.permissions import ROLE, allow_permission
from plane.app.views.base import BaseAPIView
from plane.db.models import Workspace
from plane.utils.exception_logger import log_exception

from .client import (
    AssistantNotConfigured,
    SynloraAssistantClient,
    resolve_assistant_client,
    resolve_assistant_config,
)

UPSTREAM_UNAVAILABLE = "synlora_unavailable"
UPSTREAM_ERROR = "synlora_error"


class IgnoreAcceptNegotiation(BaseContentNegotiation):
    """Browsers ask for ``text/event-stream`` on the run-events endpoint.

    DRF's default negotiator only knows the JSON renderer and would reject
    that Accept header with a 406 before the streaming view runs.
    """

    def select_parser(self, request, parsers):
        return parsers[0]

    def select_renderer(self, request, renderers, format_suffix=None):
        return (renderers[0], renderers[0].media_type)


def _workspace_or_none(slug: str):
    return Workspace.objects.filter(slug=slug).first()


def _client(request, slug: str) -> tuple[SynloraAssistantClient | None, Response | None]:
    workspace = _workspace_or_none(slug)
    if workspace is None:
        return None, Response({"error": "Workspace not found"}, status=status.HTTP_404_NOT_FOUND)
    try:
        return resolve_assistant_client(workspace), None
    except AssistantNotConfigured:
        return None, Response(
            {"error": "assistant_not_configured"},
            status=status.HTTP_503_SERVICE_UNAVAILABLE,
        )


def _upstream_error_response(exc: Exception) -> Response:
    if isinstance(exc, (httpx.ConnectError, httpx.TimeoutException, httpx.NetworkError)):
        return Response({"error": UPSTREAM_UNAVAILABLE}, status=status.HTTP_503_SERVICE_UNAVAILABLE)
    return Response({"error": UPSTREAM_ERROR}, status=status.HTTP_502_BAD_GATEWAY)


class AssistantStatusEndpoint(BaseAPIView):
    """``GET /api/workspaces/<slug>/assistant/status/`` — drives UI availability."""

    @allow_permission(allowed_roles=[ROLE.ADMIN, ROLE.MEMBER], level="WORKSPACE")
    def get(self, request, slug):
        workspace = _workspace_or_none(slug)
        if workspace is None:
            return Response({"error": "Workspace not found"}, status=status.HTTP_404_NOT_FOUND)
        config = resolve_assistant_config(workspace)
        enabled = bool(config.base_url and config.token and config.is_enabled)
        ready = False
        if enabled:
            try:
                ready = SynloraAssistantClient(config).health().status_code == 200
            except Exception as e:
                log_exception(e)
        return Response({"enabled": enabled, "ready": ready, "credential_mode": config.credential_mode})


class AssistantSessionEndpoint(BaseAPIView):
    """``POST /api/workspaces/<slug>/assistant/session/`` — create a chat thread."""

    @allow_permission(allowed_roles=[ROLE.ADMIN, ROLE.MEMBER], level="WORKSPACE")
    def post(self, request, slug):
        client, error = _client(request, slug)
        if error:
            return error
        title = str(request.data.get("title") or f"Plane/{slug}")
        try:
            response = client.create_thread(title)
        except Exception as e:
            log_exception(e)
            return _upstream_error_response(e)
        if response.status_code >= 400:
            return Response({"error": UPSTREAM_ERROR}, status=status.HTTP_502_BAD_GATEWAY)
        data = response.json()
        thread_id = data.get("id") or data.get("_id")
        if not thread_id:
            return Response({"error": UPSTREAM_ERROR}, status=status.HTTP_502_BAD_GATEWAY)
        return Response({"thread_id": thread_id, "title": title}, status=status.HTTP_201_CREATED)


class AssistantChatEndpoint(BaseAPIView):
    """``POST /api/workspaces/<slug>/assistant/chat/`` — submit a run for a query."""

    @allow_permission(allowed_roles=[ROLE.ADMIN, ROLE.MEMBER], level="WORKSPACE")
    def post(self, request, slug):
        client, error = _client(request, slug)
        if error:
            return error
        query = str(request.data.get("query") or "").strip()
        thread_id = str(request.data.get("thread_id") or "").strip()
        if not query or not thread_id:
            return Response(
                {"error": "query and thread_id are required"},
                status=status.HTTP_400_BAD_REQUEST,
            )
        request_id = str(request.data.get("request_id") or uuid4())
        try:
            response = client.start_run(query=query, thread_id=thread_id, request_id=request_id)
        except Exception as e:
            log_exception(e)
            return _upstream_error_response(e)
        if response.status_code == 404:
            return Response({"error": "thread_not_found"}, status=status.HTTP_404_NOT_FOUND)
        if response.status_code >= 400:
            return Response({"error": UPSTREAM_ERROR}, status=status.HTTP_502_BAD_GATEWAY)
        data = response.json()
        return Response(
            {
                "request_id": data.get("request_id", request_id),
                "run_id": data.get("run_id"),
                "status": data.get("status"),
                "message_id": data.get("message_id"),
                "thread_id": data.get("thread_id", thread_id),
                "queued": data.get("stream_url") is None or data.get("status") == "queued",
            },
            status=status.HTTP_200_OK,
        )


class AssistantRunEventsEndpoint(BaseAPIView):
    """``GET /api/workspaces/<slug>/assistant/runs/<run_id>/events/`` — SSE pass-through."""

    content_negotiation_class = IgnoreAcceptNegotiation

    @allow_permission(allowed_roles=[ROLE.ADMIN, ROLE.MEMBER], level="WORKSPACE")
    def get(self, request, slug, run_id):
        client, error = _client(request, slug)
        if error:
            return error
        last_event_id = request.headers.get("Last-Event-ID")

        def stream():
            try:
                with client.stream_run_events(run_id, last_event_id) as upstream:
                    for chunk in upstream.iter_bytes():
                        yield chunk
            except Exception as e:
                # The 200 header block is already committed, so surface the
                # failure as a synthesized SSE error frame for the client.
                log_exception(e)
                yield (
                    b'event: error\n'
                    b'data: {"error": "' + UPSTREAM_UNAVAILABLE.encode() + b'", "retryable": true}\n\n'
                )

        response = StreamingHttpResponse(stream(), content_type="text/event-stream")
        response["Cache-Control"] = "no-cache"
        response["X-Accel-Buffering"] = "no"
        # A pre-set Content-Encoding makes GZipMiddleware skip this response.
        response["Content-Encoding"] = "identity"
        return response


class AssistantRunResultEndpoint(BaseAPIView):
    """``GET /api/workspaces/<slug>/assistant/runs/<run_id>/result/``."""

    @allow_permission(allowed_roles=[ROLE.ADMIN, ROLE.MEMBER], level="WORKSPACE")
    def get(self, request, slug, run_id):
        client, error = _client(request, slug)
        if error:
            return error
        try:
            response = client.get_result(run_id)
        except Exception as e:
            log_exception(e)
            return _upstream_error_response(e)
        if response.status_code == 404:
            return Response({"error": "run_not_found"}, status=status.HTTP_404_NOT_FOUND)
        if response.status_code >= 400:
            return Response({"error": UPSTREAM_ERROR}, status=status.HTTP_502_BAD_GATEWAY)
        return Response(response.json(), status=status.HTTP_200_OK)


class AssistantRunCancelEndpoint(BaseAPIView):
    """``POST /api/workspaces/<slug>/assistant/runs/<run_id>/cancel/``."""

    @allow_permission(allowed_roles=[ROLE.ADMIN, ROLE.MEMBER], level="WORKSPACE")
    def post(self, request, slug, run_id):
        client, error = _client(request, slug)
        if error:
            return error
        try:
            response = client.cancel_run(run_id)
        except Exception as e:
            log_exception(e)
            return _upstream_error_response(e)
        if response.status_code == 404:
            return Response({"error": "run_not_found"}, status=status.HTTP_404_NOT_FOUND)
        if response.status_code >= 400:
            return Response({"error": UPSTREAM_ERROR}, status=status.HTTP_502_BAD_GATEWAY)
        return Response({"cancelled": True}, status=status.HTTP_200_OK)


class AssistantHistoryEndpoint(BaseAPIView):
    """``GET /api/workspaces/<slug>/assistant/history/?thread_id=``."""

    @allow_permission(allowed_roles=[ROLE.ADMIN, ROLE.MEMBER], level="WORKSPACE")
    def get(self, request, slug):
        client, error = _client(request, slug)
        if error:
            return error
        thread_id = str(request.query_params.get("thread_id") or "").strip()
        if not thread_id:
            return Response({"error": "thread_id is required"}, status=status.HTTP_400_BAD_REQUEST)
        try:
            response = client.get_history(thread_id)
        except Exception as e:
            log_exception(e)
            return _upstream_error_response(e)
        if response.status_code == 404:
            return Response({"error": "thread_not_found"}, status=status.HTTP_404_NOT_FOUND)
        if response.status_code >= 400:
            return Response({"error": UPSTREAM_ERROR}, status=status.HTTP_502_BAD_GATEWAY)
        return Response(response.json(), status=status.HTTP_200_OK)
