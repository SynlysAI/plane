# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Synthetic ORM/API tests for the unified session-only node management surface."""
# ruff: noqa: F811

from uuid import uuid4

import pytest
from django.middleware.csrf import get_token
from django.test import RequestFactory
from rest_framework.test import APIClient

from plane.db.models import ResearchContextGrant, ResearchChainNode, WorkspaceResearchSetting
from plane.research.services.mcp_catalog import TOOL_NAMES
from plane.tests.contract.app.test_research_chain_mvp import env  # noqa: F401
from plane.tests.contract.app.test_research_machine_access import machine  # noqa: F401
from plane.tests.research_fixtures import make_workspace, enable_research, make_org_member

pytestmark = pytest.mark.contract


def root(e):
    return f"/api/research/workspaces/{e['workspace'].slug}/mcp/"


def issue(e, **extra):
    return e["owner_client"].post(
        root(e) + "connections/",
        {
            "node_id": str(e["node"].pk),
            "label": "Synthetic connection",
            "mode": "read",
            "actions": [],
            **extra,
        },
        format="json",
    )


def test_candidates_only_include_accessible_chains_and_nodes(machine):
    e = machine
    assert e["collaborator_client"].get(root(e) + "candidates/").json()["results"] == []
    assert e["collaborator_client"].get(root(e) + "candidates/", {"chain_id": str(e["chain"].pk)}).status_code == 404
    response = e["owner_client"].get(root(e) + "candidates/", {"chain_id": str(e["chain"].pk)})
    assert response.status_code == 200
    assert {item["id"] for item in response.json()["results"]} == {str(e["node"].pk), str(e["other"].pk)}
    assert response.json()["ttl_seconds"] == 604800
    assert all(item["actions"] == [] for item in response.json()["results"])


def test_read_grant_is_real_read_only_and_does_not_enable_writes(machine, settings):
    settings.RESEARCH_MCP_WRITE_ENABLED = False
    response = issue(machine)
    assert response.status_code == 201, response.data
    data = response.json()
    grant = ResearchContextGrant.objects.get(context_id=data["id"])
    assert grant.allowed_tools == sorted(TOOL_NAMES)
    assert grant.connection_label == "Synthetic connection"
    assert not hasattr(grant, "write_grant")
    assert not WorkspaceResearchSetting.objects.get(workspace=machine["workspace"]).research_mcp_write_enabled
    api = APIClient()
    api.credentials(
        HTTP_X_RESEARCH_CONTEXT_TOKEN=data["headers"]["X-Research-Context-Token"],
        HTTP_X_RESEARCH_CONTEXT_HASH=data["headers"]["X-Research-Context-Hash"],
    )
    response = api.get(machine["root"] + "tools/")
    assert response.status_code == 200
    assert {item["name"] for item in response.json()["tools"]} == TOOL_NAMES
    assert api.get(machine["root"].replace("agent-access", "agent-operations") + "tools/").status_code == 404
    assert api.get(root(machine) + "connections/").status_code == 401
    assert api.post(root(machine) + f"connections/{data['id']}/revoke/", {}, format="json").status_code == 401
    assert issue(machine, actions=["create_task"]).status_code == 403


def test_read_scope_blocks_siblings_and_fake_workspace_node_ids(machine):
    e = machine
    data = issue(e).json()
    api = APIClient()
    api.credentials(
        HTTP_X_RESEARCH_CONTEXT_TOKEN=data["headers"]["X-Research-Context-Token"],
        HTTP_X_RESEARCH_CONTEXT_HASH=data["headers"]["X-Research-Context-Hash"],
    )
    assert api.get(e["root"] + f"nodes/{e['other'].pk}/context/").status_code == 404
    assert issue(e, node_id=str(uuid4())).status_code == 404
    other = make_workspace(e["owner"])
    enable_research(other, research_chain_enabled=True)
    make_org_member(other, e["owner"])
    response = e["owner_client"].post(
        f"/api/research/workspaces/{other.slug}/mcp/connections/",
        {"node_id": str(e["node"].pk), "label": "Forged", "mode": "read", "actions": []},
        format="json",
    )
    assert response.status_code == 404


def test_list_never_contains_secret_and_revocation_is_owner_and_workspace_bound(machine, settings):
    e = machine
    data = issue(e).json()
    listing = e["owner_client"].get(root(e) + "connections/")
    assert listing.status_code == 200
    assert data["headers"]["X-Research-Context-Token"] not in str(listing.data)
    assert "token_hash" not in str(listing.data)
    assert (
        e["collaborator_client"].post(root(e) + f"connections/{data['id']}/revoke/", {}, format="json").status_code
        == 404
    )
    assert e["owner_client"].post(root(e) + f"connections/{uuid4()}/revoke/", {}, format="json").status_code == 404
    settings.RESEARCH_MCP_ENABLED = False
    response = e["owner_client"].post(root(e) + f"connections/{data['id']}/revoke/", {}, format="json")
    assert response.status_code == 200
    assert ResearchContextGrant.objects.get(context_id=data["id"]).revoked_at
    assert e["owner_client"].get(root(e) + "connections/").json()["results"][0]["revoked_at"]


def test_write_options_and_issuance_obey_switches_state_and_actions(machine, settings):
    e = machine
    assert issue(e, mode="write", actions=["create_task"]).status_code == 404
    settings.RESEARCH_MCP_WRITE_ENABLED = True
    WorkspaceResearchSetting.objects.filter(workspace=e["workspace"]).update(research_mcp_write_enabled=True)
    rows = e["owner_client"].get(root(e) + "candidates/", {"chain_id": str(e["chain"].pk)}).json()["results"]
    assert "create_task" in rows[0]["actions"]
    assert issue(e, mode="write", actions=["delete_node"]).status_code == 403
    response = issue(e, mode="write", actions=["create_task"])
    assert response.status_code == 201, response.data
    assert response.json()["mcp_path"].endswith("/agent-operations/mcp/")
    e["node"].status = "WAITING_HUMAN"
    e["node"].save(update_fields=["status"])
    assert issue(e, mode="write", actions=["create_task"]).status_code == 409
    assert issue(e).status_code == 201


def test_pagination_search_and_scope_bound_cursors_never_silently_drop_nodes(machine):
    e = machine
    ResearchChainNode.objects.bulk_create(
        [
            ResearchChainNode(
                chain=e["chain"],
                title=f"Synthetic searchable {i}",
                node_type="ANALYSIS",
                request_id=uuid4().hex,
                payload_hash="a" * 64,
            )
            for i in range(33)
        ]
    )
    params = {"chain_id": str(e["chain"].pk), "q": "searchable"}
    first = e["owner_client"].get(root(e) + "candidates/", params).json()
    assert len(first["results"]) == 30 and first["next_cursor"]
    second = e["owner_client"].get(root(e) + "candidates/", {**params, "cursor": first["next_cursor"]}).json()
    assert len(second["results"]) == 3 and second["next_cursor"] is None
    assert len({row["id"] for row in first["results"] + second["results"]}) == 33
    assert (
        e["owner_client"]
        .get(root(e) + "candidates/", {**params, "q": "changed", "cursor": first["next_cursor"]})
        .status_code
        == 400
    )
    assert (
        e["owner_client"]
        .get(root(e) + "candidates/", {"chain_id": str(uuid4()), "cursor": first["next_cursor"]})
        .status_code
        == 404
    )


def test_human_management_requires_real_session_csrf_and_rejects_machine_credentials(machine):
    e = machine
    api = APIClient(enforce_csrf_checks=True)
    api.force_login(e["owner"])
    payload = {"node_id": str(e["node"].pk), "label": "CSRF fixture", "mode": "read", "actions": []}
    assert api.post(root(e) + "connections/", payload, format="json").status_code == 403
    request = RequestFactory().get("/")
    csrf = get_token(request)
    api.cookies["csrftoken"] = request.META["CSRF_COOKIE"]
    assert api.post(root(e) + "connections/", payload, format="json", HTTP_X_CSRFTOKEN=csrf).status_code == 201
    assert (
        api.post(
            root(e) + "connections/", payload, format="json", HTTP_X_CSRFTOKEN=csrf, HTTP_ORIGIN="https://foreign.test"
        ).status_code
        == 403
    )
    machine = APIClient()
    machine.credentials(HTTP_X_API_KEY=e["token"].token)
    assert machine.post(root(e) + "connections/", payload, format="json").status_code == 401


@pytest.mark.parametrize("extra", [{"mode": []}, {"actions": [True]}, {"node_id": "invalid"}, {"label": ""}])
def test_malformed_management_payload_returns_400(machine, extra):
    assert issue(machine, **extra).status_code == 400
