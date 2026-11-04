# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Assistant BFF endpoints: auth, config gating and the SSE pass-through."""

from unittest.mock import patch

import pytest
from rest_framework.test import APIClient

from plane.db.models import (
    ExternalSystemConnection,
    IntegrationSystem,
    ResearchAgentBackendConnection,
    ResearchAgentIdentityBinding,
)
from plane.license.utils.encryption import encrypt_data
from plane.tests.research_fixtures import make_user, make_workspace

pytestmark = pytest.mark.django_db


def _configure(workspace, credential="yxkey-shared", credential_mode=ExternalSystemConnection.CredentialMode.SHARED):
    connection = ExternalSystemConnection.objects.create(
        workspace=workspace,
        system=IntegrationSystem.SYNLORA,
        display_name="Synlora",
        base_url="http://synlora.internal:5050",
        auth_mode=ExternalSystemConnection.AuthMode.BEARER,
        credential_mode=credential_mode,
        is_enabled=True,
    )
    if credential_mode == ExternalSystemConnection.CredentialMode.SHARED:
        connection.set_credential(credential)
        connection.save(update_fields=["credential"])
    return connection


def _personal_binding(workspace, user, token="yxkey_personal"):
    """创建已验证的 Synlora 个人身份绑定。"""
    binding = ResearchAgentIdentityBinding.objects.create(
        user=user,
        system="SYNLORA",
        base_url="http://synlora.internal:5050",
        external_user_id="synlora-user",
        external_username="synlora",
        credential_hash="hash-" + token,
        credential_encrypted=encrypt_data(token),
    )
    ResearchAgentBackendConnection.objects.create(
        workspace=workspace,
        user=user,
        system="SYNLORA",
        identity_binding=binding,
        credential_encrypted=encrypt_data(token),
        is_enabled=True,
    )
    return binding


@pytest.fixture
def env(db, settings):
    settings.SYNLORA_AGENT_SLUG = "agent-test"
    settings.SYNLORA_SERVICE_TOKEN = "service-token"
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


class FakeDelegatedResponse:
    """Minimal delegated-token exchange response."""

    status_code = 200

    @staticmethod
    def json():
        return {"token": "short-lived-user-token", "expires_in": 3600}


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
    assert response.json() == {
        "enabled": False,
        "ready": False,
        "credential_mode": "SHARED",
        "state": "not_configured",
    }


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
    _personal_binding(env["workspace"], env["owner"])

    class FakeResponse:
        status_code = 200

        def json(self):
            return {"status": "ready"}

    client = _client_for(env["owner"])
    with (
        patch("plane.app.views.assistant.client.httpx.get", return_value=FakeResponse()) as fake_get,
    ):
        response = client.get(f"/api/workspaces/{env['workspace'].slug}/assistant/status/")
    assert response.status_code == 200
    assert response.json()["enabled"] is True
    assert response.json()["ready"] is True
    assert response.json()["state"] == "ready"
    assert fake_get.call_args.args[0] == "http://synlora.internal:5050/api/health"
    assert "headers" not in fake_get.call_args.kwargs


def test_status_reports_personal_token_missing(env):
    _configure(
        env["workspace"],
        credential_mode=ExternalSystemConnection.CredentialMode.PERSONAL,
    )
    response = _client_for(env["owner"]).get(f"/api/workspaces/{env['workspace'].slug}/assistant/status/")
    assert response.status_code == 200
    assert response.json() == {
        "enabled": False,
        "ready": False,
        "credential_mode": "PERSONAL",
        "state": "personal_credential_required",
    }


def test_status_reports_service_unavailable_when_synlora_health_fails(env):
    _configure(env["workspace"])
    _personal_binding(env["workspace"], env["owner"])

    class FakeResponse:
        status_code = 503

    client = _client_for(env["owner"])
    with (
        patch("plane.app.views.assistant.client.httpx.get", return_value=FakeResponse()),
    ):
        response = client.get(f"/api/workspaces/{env['workspace'].slug}/assistant/status/")
    assert response.status_code == 200
    assert response.json() == {
        "enabled": True,
        "ready": False,
        "credential_mode": "SHARED",
        "state": "service_unavailable",
    }


def test_chat_uses_v1_session_and_returns_run_identity(env):
    _configure(env["workspace"])
    captured = {}

    class FakeRunResponse:
        status_code = 200

        def json(self):
            return {
                "session_id": "thread-1",
                "run_id": "run-1",
            }

    def fake_request(method, url, *, headers=None, json=None, params=None, timeout=None):
        captured.update({"method": method, "url": url, "json": json})
        return FakeRunResponse()

    client = _client_for(env["owner"])
    with (
        patch("plane.app.views.assistant.client.httpx.post", return_value=FakeDelegatedResponse()),
        patch("plane.app.views.assistant.client.httpx.request", side_effect=fake_request),
    ):
        response = client.post(
            f"/api/workspaces/{env['workspace'].slug}/assistant/chat/",
            {"query": "summarize this page", "thread_id": "thread-1"},
            format="json",
        )
    assert response.status_code == 200
    body = response.json()
    assert body["run_id"] == "run-1"
    assert body["queued"] is False
    assert captured["url"] == "http://synlora.internal:5050/api/v1/sessions/thread-1/runs"
    assert captured["json"]["text"] == "summarize this page"


def test_events_stream_passes_bytes_through_with_sse_headers(env):
    _configure(env["workspace"])
    frames = [
        'event: llm/delta\ndata: {"payload":{"text":"你好"}}\n\n'.encode(),
        b"event: turn/end\ndata: {}\n\n",
    ]
    captured = {}

    class FakeHistoryResponse:
        status_code = 200

        @staticmethod
        def json():
            return []

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
    with (
        patch("plane.app.views.assistant.client.httpx.post", return_value=FakeDelegatedResponse()),
        patch(
            "plane.app.views.assistant.client.httpx.request",
            return_value=FakeHistoryResponse(),
        ),
        patch("plane.app.views.assistant.client.httpx.stream", side_effect=fake_stream),
    ):
        response = client.get(
            f"/api/workspaces/{env['workspace'].slug}/assistant/sessions/thread-9/events/",
            headers={"Last-Event-ID": "7", "Accept": "text/event-stream"},
        )
        streamed = b"".join(response.streaming_content)
    assert response.status_code == 200
    assert response["Content-Type"] == "text/event-stream"
    assert response["Cache-Control"] == "no-cache"
    assert response["X-Accel-Buffering"] == "no"
    # pre-set Content-Encoding keeps GZipMiddleware away from the stream
    assert response["Content-Encoding"] == "identity"
    assert streamed == b"".join(frames)
    assert captured["url"] == "http://synlora.internal:5050/api/v1/sessions/thread-9/events"
    assert captured["headers"]["Authorization"] == "Bearer short-lived-user-token"


def test_events_stream_synthesizes_an_error_frame_when_upstream_fails(env):
    _configure(env["workspace"])

    def failing_stream(*args, **kwargs):
        raise ConnectionError("synlora down")

    client = _client_for(env["owner"])
    with (
        patch("plane.app.views.assistant.client.httpx.post", return_value=FakeDelegatedResponse()),
        patch("plane.app.views.assistant.client.httpx.stream", side_effect=failing_stream),
    ):
        response = client.get(
            f"/api/workspaces/{env['workspace'].slug}/assistant/sessions/thread-10/events/"
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
            return [
                {"seq": 1, "type": "user/message", "payload": {"text": "之前的问题"}},
                {"seq": 2, "type": "assistant/message", "payload": {"content": "之前的回答"}},
            ]

    client = _client_for(env["owner"])
    with (
        patch("plane.app.views.assistant.client.httpx.post", return_value=FakeDelegatedResponse()),
        patch("plane.app.views.assistant.client.httpx.request", return_value=FakeResponse()) as fake_request,
    ):
        cancelled = client.post(
            f"/api/workspaces/{env['workspace'].slug}/assistant/runs/00000000-0000-0000-0000-000000000003/cancel/"
        )
        history = client.get(
            f"/api/workspaces/{env['workspace'].slug}/assistant/history/?thread_id=thread-9"
        )
    assert cancelled.status_code == 200
    assert cancelled.json() == {"cancelled": True}
    assert history.status_code == 200
    assert history.json() == [
        {"id": "1", "role": "user", "content": "之前的问题"},
        {"id": "2", "role": "assistant", "content": "之前的回答"},
    ]
    called_urls = [call.args[1] for call in fake_request.call_args_list]
    assert any(url.endswith("/api/v1/runs/00000000-0000-0000-0000-000000000003/cancel") for url in called_urls)
    assert any(url.endswith("/api/v1/sessions/thread-9/events") for url in called_urls)
