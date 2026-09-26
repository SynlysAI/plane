"""Observability, active health and security-denial metric tests."""

from unittest.mock import patch

import pytest
from rest_framework.test import APIClient

from plane.db.models import ExternalSystemConnection, ResearchAuditEvent
from plane.tests.research_fixtures import add_workspace_member, enable_research, make_user, make_workspace

pytestmark = pytest.mark.contract


class FakeResponse:
    def __init__(self, payload=None):
        self.status_code = 200
        self.content = b"{}"
        self._payload = payload or {"status": "ok"}

    def json(self):
        return self._payload


@pytest.fixture
def env(db, settings):
    settings.RESEARCH_MODULE_ENABLED = True
    owner = make_user(first_name="Ops owner")
    outsider = make_user(first_name="Ops outsider")
    workspace = make_workspace(owner)
    add_workspace_member(workspace, outsider)
    enable_research(workspace, research_chain_enabled=True)
    owner_client = APIClient()
    owner_client.force_authenticate(user=owner)
    outsider_client = APIClient()
    outsider_client.force_authenticate(user=outsider)
    return {"owner": owner, "workspace": workspace, "client": owner_client, "outsider_client": outsider_client}


def test_security_denials_are_audited_and_observable(env):
    denied = env["outsider_client"].get(f"/api/research/workspaces/{env['workspace'].slug}/projects/")
    assert denied.status_code == 403
    assert ResearchAuditEvent.objects.filter(
        workspace=env["workspace"],
        action="security.denied",
        metadata__reason="research_capability_denied",
    ).exists()

    response = env["client"].get(f"/api/research/workspaces/{env['workspace'].slug}/observability/")
    assert response.status_code == 200
    payload = response.json()
    assert payload["metrics"]["security_denials_total"] >= 1
    assert payload["metrics"]["security_denials_24h"] >= 1
    assert payload["metrics"]["api_requests_total"] >= 1
    assert payload["log_redaction"]["request_body"] == "not_persisted"
    assert "x-research-context-token" in payload["log_redaction"]["sensitive_headers"]


def test_active_health_probe_reports_normalized_ragportal_status(env):
    ExternalSystemConnection.objects.create(
        workspace=env["workspace"],
        system="RAGPORTAL",
        display_name="RAGPortal",
        base_url="http://ragportal.test",
        auth_mode="NONE",
        is_enabled=True,
    )
    with patch("httpx.get", return_value=FakeResponse()) as get:
        response = env["client"].post(
            f"/api/research/workspaces/{env['workspace'].slug}/integrations/health/probe/",
            {"system": "RAGPORTAL"},
            format="json",
        )
    assert response.status_code == 200
    result = response.json()["results"][0]
    assert result["system"] == "RAGPORTAL"
    assert result["status"] == "OK"
    assert get.call_args.args[0].endswith("/api/health")
