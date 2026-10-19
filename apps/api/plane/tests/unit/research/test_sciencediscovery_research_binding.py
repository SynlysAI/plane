"""SD binding uses existing per-server credential isolation, not a shared header."""

from types import SimpleNamespace
from unittest.mock import patch
from uuid import uuid4

import pytest
from django.utils import timezone

from plane.research.services.mcp_catalog import TOOL_NAMES
from plane.research.services.sciencediscovery import ScienceDiscoveryClient, ScienceDiscoveryError

pytestmark = pytest.mark.unit


def test_each_grant_creates_a_fresh_server_and_only_exports_nonsecret_binding():
    client = ScienceDiscoveryClient()
    user, workspace = SimpleNamespace(id=uuid4()), SimpleNamespace(id=uuid4())
    requests = []

    def request(method, path, **kwargs):
        requests.append((method, path, kwargs))
        if method == "GET":
            return []
        if path == "/api/mcp/servers":
            return {"id": "custom-111111111111"}
        return {"id": "custom-111111111111", "sourceId": "custom-111111111111", "status": "ready",
                "tools": [{"name": name} for name in TOOL_NAMES]}

    grant = SimpleNamespace(context_id=uuid4(), expires_at=timezone.now(), context_hash="hash",
                            allowed_tools=sorted(TOOL_NAMES))
    with patch.object(client, "_request", side_effect=request):
        binding = client.create_research_connector(workspace=workspace, user=user, grant=grant,
            token="opaque-secret", url="https://plane.example/api/research/workspaces/lab/agent-access/mcp/")
    assert [method for method, _, _ in requests] == ["GET", "POST", "POST"]
    payload = requests[1][2]["json_payload"]
    assert payload["headers"]["X-Research-Context-Token"] == "opaque-secret"
    assert payload["headers"]["X-Research-Context-Hash"] == "hash"
    assert "opaque-secret" not in str(binding)
    assert binding["server_id"] == binding["source_id"]


def test_connector_discovery_failure_removes_its_dedicated_server():
    client = ScienceDiscoveryClient()
    grant = SimpleNamespace(context_id=uuid4(), expires_at=timezone.now(), context_hash="hash",
                            allowed_tools=sorted(TOOL_NAMES))
    identity = "custom-222222222222"
    calls = []

    def request(method, path, **kwargs):
        calls.append((method, path))
        if method == "GET":
            return []
        if path == "/api/mcp/servers":
            return {"id": identity}
        if method == "DELETE":
            return {"deleted": True}
        return {"id": identity, "sourceId": identity, "status": "error", "tools": []}

    with patch.object(client, "_request", side_effect=request), pytest.raises(ScienceDiscoveryError):
        client.create_research_connector(workspace=SimpleNamespace(id=uuid4()), user=SimpleNamespace(id=uuid4()),
            grant=grant, token="secret", url="https://plane.example/mcp/")
    assert ("DELETE", f"/api/mcp/servers/{identity}") in calls


def test_create_session_explicitly_selects_the_scoped_connector():
    client = ScienceDiscoveryClient()
    with patch.object(client, "_request", return_value={"id": "session"}) as request:
        client.create_session(project_id="project", title="Node", connector_ids=["custom-333333333333"])
    assert request.call_args.kwargs["json_payload"]["settingsOverrides"] == {
        "enabledConnectorIds": ["custom-333333333333"]}
