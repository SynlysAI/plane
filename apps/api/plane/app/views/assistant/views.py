# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Workspace AI-assistant BFF over Synlora v1 Sessions.

The browser never talks to Synlora directly — the workspace session
authenticates, and delegated credentials stay server-side. Durable events are
replayed before the live session SSE stream is forwarded.
"""

import json
from dataclasses import replace
from uuid import uuid4

import httpx
from django.conf import settings
from django.http import StreamingHttpResponse
from rest_framework import status
from rest_framework.negotiation import BaseContentNegotiation
from rest_framework.response import Response

from plane.app.permissions import ROLE, allow_permission
from plane.app.views.base import BaseAPIView
from plane.db.models import Workspace
from plane.license.utils.encryption import decrypt_data
from plane.research.services.agent_identity import (
    ensure_synlora_identity_binding,
)
from plane.utils.exception_logger import log_exception

from .client import (
    AssistantNotConfigured,
    SynloraAssistantClient,
    assistant_history_messages,
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
        return resolve_assistant_client(workspace, user=request.user), None
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
        config = resolve_assistant_config(workspace, user=request.user)
        binding = ensure_synlora_identity_binding(workspace, request.user)
        if binding is not None:
            config = replace(
                config,
                base_url=binding.base_url or config.base_url,
                token=decrypt_data(binding.credential_encrypted),
                service_token="",
                auth_mode="PERSONAL_API_KEY",
            )
        enabled = bool(config.base_url and config.is_enabled and (binding is not None or config.token))
        ready = False
        state = "not_configured"
        if not config.is_enabled or not config.base_url:
            state = "not_configured"
        elif binding is None:
            state = "personal_credential_required"
        elif enabled:
            try:
                state = "service_unavailable"
                health_response = SynloraAssistantClient(
                    config,
                    workspace=workspace,
                    user=request.user,
                ).health()
                token_response = SynloraAssistantClient(
                    config,
                    workspace=workspace,
                    user=request.user,
                ).verify_personal_token()
                if token_response.status_code in (401, 403):
                    state = "invalid_personal_credential"
                elif token_response.status_code >= 400:
                    state = "service_unavailable"
                if health_response.status_code != 200:
                    state = "service_unavailable"
                elif token_response.status_code == 200:
                    ready = True
                    state = "ready"
            except Exception as e:
                log_exception(e)
        return Response(
            {
                "enabled": enabled,
                "ready": ready,
                "credential_mode": "PERSONAL",
                "portal_url": (
                    getattr(settings, "SYNLORA_PORTAL_URL", "")
                    or (binding.base_url if binding is not None else "")
                    or None
                ),
                "state": state,
            }
        )


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
    """``POST /api/workspaces/<slug>/assistant/chat/`` — submit a background run."""

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
                "request_id": request_id,
                "run_id": data.get("run_id"),
                "status": "dispatched",
                "message_id": None,
                "thread_id": data.get("session_id", thread_id),
                "queued": False,
            },
            status=status.HTTP_200_OK,
        )


def _parse_last_event_id(raw_value: str | None) -> int:
    """Parse the browser SSE cursor, tolerating pre-v1 composite ids."""
    if not raw_value:
        return -1
    try:
        return int(str(raw_value).rsplit("-", 1)[-1])
    except ValueError:
        return -1


def _stream_session_events(client: SynloraAssistantClient, thread_id: str, last_event_id: str | None):
    """Replay durable events first, then forward the already-open live stream.

    The live stream is opened before history is fetched so no event can fall in
    a subscription gap. Closing this response only closes SSE; the Synlora run
    continues in its background executor.
    """
    after_seq = _parse_last_event_id(last_event_id)
    upstream = None
    try:
        upstream = client.stream_session_events(thread_id).__enter__()
        history = client.get_history(thread_id, after_seq=after_seq)
        if history.status_code < 400:
            events = history.json() if isinstance(history.json(), list) else []
            for event in events:
                yield (
                    f"event: {event.get('type', 'message')}\n".encode()
                    + b"data: "
                    + json.dumps(event, ensure_ascii=False).encode()
                    + b"\n"
                    + f"id: {event.get('seq', 0)}\n\n".encode()
                )
        for chunk in upstream.iter_bytes():
            yield chunk
    except Exception as e:
        log_exception(e)
        yield (b"event: error\n" + b'data: {"error": "' + UPSTREAM_UNAVAILABLE.encode() + b'", "retryable": true}\n\n')
    finally:
        if upstream is not None:
            upstream.__exit__(None, None, None)


class AssistantSessionEventsEndpoint(BaseAPIView):
    """``GET /api/workspaces/<slug>/assistant/sessions/<thread_id>/events/``."""

    content_negotiation_class = IgnoreAcceptNegotiation

    @allow_permission(allowed_roles=[ROLE.ADMIN, ROLE.MEMBER], level="WORKSPACE")
    def get(self, request, slug, thread_id):
        client, error = _client(request, slug)
        if error:
            return error
        response = StreamingHttpResponse(
            _stream_session_events(client, thread_id, request.headers.get("Last-Event-ID")),
            content_type="text/event-stream",
        )
        response["Cache-Control"] = "no-cache"
        response["X-Accel-Buffering"] = "no"
        response["Content-Encoding"] = "identity"
        return response


class AssistantRunEventsEndpoint(AssistantSessionEventsEndpoint):
    """Legacy run-event route; callers must supply the v1 session id."""

    @allow_permission(allowed_roles=[ROLE.ADMIN, ROLE.MEMBER], level="WORKSPACE")
    def get(self, request, slug, run_id):
        thread_id = str(request.query_params.get("thread_id") or "").strip()
        if not thread_id:
            return Response({"error": "thread_id is required"}, status=status.HTTP_400_BAD_REQUEST)
        return super().get(request, slug, thread_id)


class AssistantRunResultEndpoint(BaseAPIView):
    """``GET .../runs/<run_id>/result/?thread_id=`` — derive state from events."""

    @allow_permission(allowed_roles=[ROLE.ADMIN, ROLE.MEMBER], level="WORKSPACE")
    def get(self, request, slug, run_id):
        client, error = _client(request, slug)
        if error:
            return error
        thread_id = str(request.query_params.get("thread_id") or "").strip()
        if not thread_id:
            return Response({"error": "thread_id is required"}, status=status.HTTP_400_BAD_REQUEST)
        try:
            history = client.get_history(thread_id)
        except Exception as e:
            log_exception(e)
            return _upstream_error_response(e)
        if history.status_code == 404:
            return Response({"error": "run_not_found"}, status=status.HTTP_404_NOT_FOUND)
        if history.status_code >= 400:
            return Response({"error": UPSTREAM_ERROR}, status=status.HTTP_502_BAD_GATEWAY)
        events = history.json() if isinstance(history.json(), list) else []
        in_run = False
        status_value = "running"
        output = ""
        for event in events:
            event_type = str(event.get("type") or "")
            payload = event.get("payload") if isinstance(event.get("payload"), dict) else {}
            if event_type == "turn/start" and str(payload.get("run_id") or "") == str(run_id):
                in_run = True
            elif in_run and event_type == "assistant/message":
                output = str(payload.get("content") or output)
            elif in_run and event_type == "turn/end":
                status_value = "completed"
            elif in_run and event_type == "turn/aborted":
                status_value = "cancelled"
            elif in_run and event_type == "error":
                status_value = "failed"
        return Response({"status": status_value, "output": output}, status=status.HTTP_200_OK)


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
        events = response.json() if isinstance(response.json(), list) else []
        return Response(assistant_history_messages(events), status=status.HTTP_200_OK)
