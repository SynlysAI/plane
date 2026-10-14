# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Assistant BFF endpoints: auth, config gating and the SSE pass-through."""

from unittest.mock import patch

import pytest
from rest_framework.test import APIClient

from plane.db.models import ExternalSystemConnection, IntegrationSystem
from plane.tests.research_fixtures import make_user, make_workspace

pytestmark = pytest.mark.django_db


def _configure(workspace, credential="yxkey-shared"):
    connection = ExternalSystemConnection.objects.create(
        workspace=workspace,
        system=IntegrationSystem.SYNLORA,
        display_name="Synlora",
        base_url="http://synlora.internal:5050",
        auth_mode=ExternalSystemConnection.AuthMode.BEARER,
        is_enabled=True,
    )
    connection.set_credential(credential)
    connection.save(update_fields=["credential"])
    return connection


@pytest.fixture
def env(db, settings):
    settings.SYNLORA_AGENT_SLUG = "agent-test"
    owner = make_user(first_name="Owner")
    workspace = make_workspace(owner)
    return {
        "owner": owner,
        "workspace": workspace,
        "owner_client": APIClient(),
        "outsider_client": APIClient(),
    }


def _client_for(user):
    client = APIClient()
    client.force_authenticate(user=user)
    return client


def test_anonymous_requests_are_rejected(env):
    response = APIClient().get(f"/api/workspaces/{env['workspace'].slug}/assistant/status/")
    assert response.status_code in (401, 403)


def test_non_members_are_rejected(env):
    _configure(env["workspace"])
    stranger = make_user(first_name="Stranger")
    response = _client_for(stranger).get(
        f"/api/workspaces/{env['workspace'].slug}/assistant/status/"
    )
    assert response.status_code == 403


def test_status_reports_disabled_without_a_connection(env):
    client = _client_for(env["owner"])
    response = client.get(f"/api/workspaces/{env['workspace'].slug}/assistant/status/")
    assert response.status_code == 200
    assert response.json() == {"enabled": False, "ready": False, "credential_mode": "SHARED"}


def test_unconfigured_connection_maps_to_503_on_chat(env):
    client = _client_for(env["owner"])
    response = client.post(
        f"/api/workspaces/{env['workspace'].slug}/assistant/chat/",
        {"query": "hi", "thread_id": "t-1"},
        format="json",
    )
    assert response.status_code == 503
    assert response.json()["error"] == "assistant_not_configured"


def test_status_reports_ready_when_synlora_answers(env):
    _configure(env["workspace"])

    class FakeResponse:
        status_code = 200

        def json(self):
            return {"status": "ready"}

    client = _client_for(env["owner"])
    with patch("plane.app.views.assistant.client.httpx.get", return_value=FakeResponse()) as fake_get:
        response = client.get(f"/api/workspaces/{env['workspace'].slug}/assistant/status/")
    assert response.status_code == 200
    assert response.json()["enabled"] is True
    assert response.json()["ready"] is True
    assert fake_get.call_args.args[0] == "http://synlora.internal:5050/api/system/ready"


def test_chat_pins_the_agent_slug_and_returns_run_identity(env):
    _configure(env["workspace"])
    captured = {}

    class FakeRunResponse:
        status_code = 200

        def json(self):
            return {
                "request_id": captured["json"]["meta"]["request_id"],
                "status": "dispatched",
                "run_id": "run-1",
                "message_id": 7,
                "thread_id": captured["json"]["thread_id"],
                "stream_url": "/api/agent/runs/run-1/events",
            }

    def fake_request(method, url, *, headers=None, json=None, params=None, timeout=None):
        captured.update({"method": method, "url": url, "json": json})
        return FakeRunResponse()

    client = _client_for(env["owner"])
    with patch("plane.app.views.assistant.client.httpx.request", side_effect=fake_request):
        response = client.post(
            f"/api/workspaces/{env['workspace'].slug}/assistant/chat/",
            {"query": "summarize this page", "thread_id": "thread-1"},
            format="json",
        )
    assert response.status_code == 200
    body = response.json()
    assert body["run_id"] == "run-1"
    assert body["queued"] is False
    assert captured["url"] == "http://synlora.internal:5050/api/agent/runs"
    assert captured["json"]["agent_slug"] == "agent-test"


def test_events_stream_passes_bytes_through_with_sse_headers(env):
    _configure(env["workspace"])
    frames = [b'event: messages\ndata: {"a":1}\n\n', b"event: end\ndata: {}\n\n"]
    captured = {}

    class FakeStream:
        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def iter_bytes(self):
            yield from frames

    def fake_stream(method, url, *, params=None, headers=None, timeout=None):
        captured.update({"url": url, "params": params, "headers": headers})
        return FakeStream()

    client = _client_for(env["owner"])
    with patch("plane.app.views.assistant.client.httpx.stream", side_effect=fake_stream):
        response = client.get(
            f"/api/workspaces/{env['workspace'].slug}/assistant/runs/00000000-0000-0000-0000-000000000001/events/",
            headers={"Last-Event-ID": "1789-0", "Accept": "text/event-stream"},
        )
    assert response.status_code == 200
    assert response["Content-Type"] == "text/event-stream"
    assert response["Cache-Control"] == "no-cache"
    assert response["X-Accel-Buffering"] == "no"
    # pre-set Content-Encoding keeps GZipMiddleware away from the stream
    assert response["Content-Encoding"] == "identity"
    assert b"".join(response.streaming_content) == b"".join(frames)
    assert captured["url"] == "http://synlora.internal:5050/api/agent/runs/00000000-0000-0000-0000-000000000001/events"
    assert captured["params"] == {"verbose": "false"}
    assert captured["headers"]["Last-Event-ID"] == "1789-0"
    assert captured["headers"]["Authorization"] == "Bearer yxkey-shared"


def test_events_stream_synthesizes_an_error_frame_when_upstream_fails(env):
    _configure(env["workspace"])

    def failing_stream(*args, **kwargs):
        raise ConnectionError("synlora down")

    client = _client_for(env["owner"])
    with patch("plane.app.views.assistant.client.httpx.stream", side_effect=failing_stream):
        response = client.get(
            f"/api/workspaces/{env['workspace'].slug}/assistant/runs/00000000-0000-0000-0000-000000000002/events/"
        )
    assert response.status_code == 200
    body = b"".join(response.streaming_content)
    assert b"event: error" in body
    assert b"synlora_unavailable" in body


def test_cancel_and_history_proxy_upstream(env):
    _configure(env["workspace"])

    class FakeResponse:
        status_code = 200

        def json(self):
            return {"ok": True}

    client = _client_for(env["owner"])
    with patch("plane.app.views.assistant.client.httpx.request", return_value=FakeResponse()) as fake_request:
        cancelled = client.post(
            f"/api/workspaces/{env['workspace'].slug}/assistant/runs/00000000-0000-0000-0000-000000000003/cancel/"
        )
        history = client.get(
            f"/api/workspaces/{env['workspace'].slug}/assistant/history/?thread_id=thread-9"
        )
    assert cancelled.status_code == 200
    assert cancelled.json() == {"cancelled": True}
    assert history.status_code == 200
    called_urls = [call.args[1] for call in fake_request.call_args_list]
    assert any(url.endswith("/api/agent/runs/00000000-0000-0000-0000-000000000003/cancel") for url in called_urls)
    assert any(url.endswith("/api/chat/thread/thread-9/history") for url in called_urls)
