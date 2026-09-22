"""RAGPortal v1 endpoint contract tests."""

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
