"""RAGPortal v1 endpoint contract tests."""

import base64
import hashlib
import hmac
import json

from unittest.mock import patch

import pytest

from plane.db.models import ExternalSystemConnection
from plane.research.services.integrations import client_for
from plane.research.services.integrations.base import IntegrationErrorCode
from plane.tests.research_fixtures import enable_research, make_user, make_workspace

pytestmark = pytest.mark.unit


class FakeResponse:
    """Minimal httpx response fixture."""

    def __init__(self, status_code=200, payload=None):
        self.status_code = status_code
        self._payload = payload if payload is not None else {"items": []}
        self.content = b"{}"

    def json(self):
        return self._payload


@pytest.fixture
def client(db):
    """Create an enabled RAGPortal adapter."""
    user = make_user(first_name="RAG owner")
    workspace = make_workspace(user)
    enable_research(workspace)
    connection = ExternalSystemConnection.objects.create(
        workspace=workspace,
        system="RAGPORTAL",
        display_name="RAGPortal",
        base_url="http://ragportal.test",
        auth_mode="NONE",
        is_enabled=True,
        degraded_mode="HIDDEN",
    )
    return client_for("RAGPORTAL", connection)


def test_kb_list_uses_actual_ragportal_path(client):
    """KB listing must call /api/kb/list, not the removed entries endpoint."""
    with patch("httpx.get", return_value=FakeResponse(payload={"items": [{"id": "kb-1", "name": "Materials"}]})) as get:
        result = client.knowledge_bases()
    assert result.degraded is False
    assert result.items[0]["external_id"] == "kb-1"
    assert get.call_args.args[0].endswith("/api/kb/list")


def test_ragportal_hmac_uses_ai4ms_bearer_token(client, settings):
    """RAGPortal HMAC mode must use the AI4MS bearer-token contract."""
    client.connection.auth_mode = "HMAC"
    client.connection.credential_ref = "RAGPORTAL_AUTH_SECRET"
    client.connection.save(update_fields=["auth_mode", "credential_ref"])
    settings.RAGPORTAL_AUTH_SECRET = "top-secret"

    headers = client.headers(path="/api/kb/list")

    token = headers["Authorization"].removeprefix("Bearer ")
    payload_b64, signature = token.rsplit(".", 1)
    expected_signature = hmac.new(b"top-secret", payload_b64.encode(), hashlib.sha256).hexdigest()
    padding = 4 - len(payload_b64) % 4
    payload = json.loads(base64.urlsafe_b64decode(payload_b64 + "=" * (padding % 4)))
    assert signature == expected_signature
    assert payload["sub"] == "plane-research-bff"
    assert payload["role"] == "user"
    assert "X-AI4MS-Signature" not in headers


def test_upload_passes_research_scope_metadata_and_request_id(client):
    """Uploads carry workspace/project/node metadata and idempotency headers."""
    request = type("Request", (), {"headers": {"X-Request-Id": "req-upload-1"}})()
    with patch("httpx.post", return_value=FakeResponse(payload={"id": 7, "parse_status": "pending"})) as post:
        result = client.upload(
            file_name="paper.pdf",
            file_content=b"pdf",
            kb_id="kb-1",
            metadata={"workspace_slug": "ws", "research_project_id": "project-1", "chain_node_id": "node-1"},
            request=request,
        )
    assert result.degraded is False
    assert post.call_args.args[0].endswith("/api/uploads")
    assert post.call_args.kwargs["data"]["research_project_id"] == "project-1"
    assert post.call_args.kwargs["headers"]["Idempotency-Key"] == "req-upload-1"


def test_upload_detail_uses_actual_path(client):
    """Upload status polling targets /api/uploads/{id}."""
    with patch("httpx.get", return_value=FakeResponse(payload={"id": 7, "parse_status": "success"})) as get:
        client.upload_detail(7)
    assert get.call_args.args[0].endswith("/api/uploads/7")


@pytest.mark.parametrize("status_code", [401, 404, 429])
def test_ragportal_http_errors_have_specific_degraded_codes(client, status_code):
    """Authentication, missing resources and throttling are distinguishable."""
    with patch("httpx.get", return_value=FakeResponse(status_code=status_code)):
        result = client.knowledge_bases()
    expected = {
        401: IntegrationErrorCode.UNAUTHORIZED,
        404: IntegrationErrorCode.NOT_FOUND,
        429: IntegrationErrorCode.RATE_LIMITED,
    }[status_code]
    assert result.degraded is True
    assert result.degraded_reason == expected
    assert result.degraded_mode == "HIDDEN"


def test_ragportal_health_path_is_available(client):
    """Health checks use the RAGPortal health endpoint."""
    with patch("httpx.get", return_value=FakeResponse(payload={"status": "ok"})) as get:
        client.health()
    assert get.call_args.args[0].endswith("/api/health")


def test_rate_limited_request_is_retried_before_success(client):
    """A transient 429 is retried and can recover within the attempt ceiling."""
    responses = [
        FakeResponse(status_code=429),
        FakeResponse(payload={"items": [{"id": "kb-1", "name": "Materials"}]}),
    ]
    with patch("httpx.get", side_effect=responses) as get, patch("plane.research.services.integrations.base.time.sleep"):
        result = client.knowledge_bases()
    assert result.degraded is False
    assert get.call_count == 2


def test_link_only_degraded_mode_is_preserved(client):
    """LINK_ONLY keeps manual research usable while external search is down."""
    client.connection.degraded_mode = "LINK_ONLY"
    client.connection.save(update_fields=["degraded_mode"])
    with patch("httpx.get", return_value=FakeResponse(status_code=503)):
        result = client.knowledge_bases()
    assert result.degraded is True
    assert result.degraded_mode == "LINK_ONLY"


def test_duplicate_upload_reuses_the_same_idempotency_key(client):
    """RAGPortal can safely deduplicate a retried upload by request ID."""
    request = type("Request", (), {"headers": {"X-Request-Id": "req-upload-fixed"}})()
    response = FakeResponse(payload={"id": 7, "parse_status": "pending"})
    with patch("httpx.post", return_value=response) as post:
        first = client.upload(
            file_name="paper.pdf",
            file_content=b"pdf",
            kb_id="kb-1",
            metadata={"workspace_slug": "ws", "research_project_id": "project-1"},
            request=request,
        )
        second = client.upload(
            file_name="paper.pdf",
            file_content=b"pdf",
            kb_id="kb-1",
            metadata={"workspace_slug": "ws", "research_project_id": "project-1"},
            request=request,
        )
    assert first.request_id == second.request_id == "req-upload-fixed"
    assert [call.kwargs["headers"]["Idempotency-Key"] for call in post.call_args_list] == [
        "req-upload-fixed",
        "req-upload-fixed",
    ]


def test_weknora_health_uses_the_shared_health_contract(db):
    """WeKnora inherits the same health endpoint contract as RAGPortal."""
    user = make_user(first_name="WeKnora owner")
    workspace = make_workspace(user)
    enable_research(workspace)
    connection = ExternalSystemConnection.objects.create(
        workspace=workspace,
        system="WEKNORA",
        display_name="WeKnora",
        base_url="http://weknora.test",
        auth_mode="NONE",
        is_enabled=True,
    )
    weknora = client_for("WEKNORA", connection)
    with patch("httpx.get", return_value=FakeResponse(payload={"status": "ok"})) as get:
        result = weknora.health()
    assert result.degraded is False
    assert get.call_args.args[0].endswith("/api/health")
