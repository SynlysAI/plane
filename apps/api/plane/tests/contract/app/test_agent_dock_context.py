# Copyright (c) 2023-present Plane Software, Inc. contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Agent Dock server-authoritative context resolution tests."""

from hashlib import sha256
from uuid import uuid4

import pytest
from rest_framework.test import APIClient

from plane.db.models import (
    Project,
    ResearchChain,
    ResearchChainNode,
    ResearchProjectProfile,
)
from plane.research.services.agent_dock import agent_context_v3_for_grant
from plane.tests.research_fixtures import (
    enable_research,
    make_org_member,
    make_user,
    make_workspace,
)

pytestmark = pytest.mark.contract


def _hash(value):
    return sha256(str(value).encode()).hexdigest()


@pytest.fixture
def env(db, settings):
    settings.RESEARCH_MODULE_ENABLED = True
    owner = make_user(first_name="Dock owner")
    other = make_user(first_name="Dock other")
    workspace = make_workspace(owner)
    make_org_member(workspace, owner)
    enable_research(workspace, research_agent_enabled=True, research_chain_enabled=True)
    suffix = uuid4().hex[:6]
    project = Project.objects.create(
        workspace=workspace,
        name=f"Dock project {suffix}",
        identifier=f"DK{suffix}",
        network=0,
        created_by=owner,
    )
    profile = ResearchProjectProfile.objects.create(
        project=project, workspace=workspace, owner=owner, created_by=owner
    )
    chain = ResearchChain.objects.create(
        project=project,
        workspace=workspace,
        owner=owner,
        request_id=f"chain-{uuid4().hex}",
        payload_hash=_hash("chain"),
        created_by=owner,
    )
    node = ResearchChainNode.objects.create(
        chain=chain,
        node_type="GENERAL_RESEARCH",
        title="Dock node",
        request_id=f"node-{uuid4().hex}",
        payload_hash=_hash("node"),
        created_by=owner,
    )
    client = APIClient()
    client.force_authenticate(user=owner)
    return {
        "owner": owner,
        "other": other,
        "workspace": workspace,
        "project": project,
        "profile": profile,
        "chain": chain,
        "node": node,
        "client": client,
    }


def _resolve(env, route, **overrides):
    payload = {
        "request_id": f"ctx-{uuid4().hex}",
        "route": route,
        "selected_text": "用户选中的材料段落",
        **overrides,
    }
    return env["client"].post(
        f"/api/workspaces/{env['workspace'].slug}/agent-dock/context/resolve/",
        payload,
        format="json",
    )


def test_node_route_issues_safe_v3_context_and_envelope(env, settings):
    settings.RESEARCH_MCP_ENABLED = True
    route = f"/{env['workspace'].slug}/research/chains/{env['chain'].id}/nodes/{env['node'].id}/agent"
    response = _resolve(env, route)

    assert response.status_code == 201, response.text
    envelope = response.json()
    assert envelope["schema_version"] == "agent-context-envelope.v1"
    assert envelope["target_type"] == "RESEARCH_CHAIN_NODE"
    assert [item["type"] for item in envelope["target_hierarchy"]] == [
        "workspace",
        "project",
        "research_chain",
        "research_chain_node",
    ]
    assert envelope["capabilities"]["allowed_tools"]
    assert envelope["session_binding"]["target_key"] == f"node:{env['node'].id}"
    serialized = str(envelope)
    assert "token" not in serialized.lower()
    assert "用户选中的材料段落" not in serialized

    grant = env["node"].context_grants.first()
    metadata = agent_context_v3_for_grant(grant)
    assert metadata["schema_version"] == "agent-context.v3"
    assert metadata["target"]["chain_node_id"] == str(env["node"].id)
    assert metadata["policy"]["allowed_tools"] == envelope["capabilities"]["allowed_tools"]
    assert metadata["manifest"]["hash"] == grant.context_manifest["hash"]


def test_chain_home_falls_back_to_chain_context_without_inventing_node(env):
    route = f"/{env['workspace'].slug}/research/chains/{env['chain'].id}"
    response = _resolve(env, route)
    assert response.status_code == 201, response.text
    envelope = response.json()
    assert envelope["target_type"] == "RESEARCH_CHAIN"
    assert envelope["session_binding"]["target_key"] == f"chain:{env['chain'].id}"
    assert all(item["type"] != "research_chain_node" for item in envelope["target_hierarchy"])


def test_unauthorized_node_hint_fails_closed(env):
    other_client = APIClient()
    other_client.force_authenticate(user=env["other"])
    route = f"/{env['workspace'].slug}/research/chains/{env['chain'].id}/nodes/{env['node'].id}/agent"
    response = other_client.post(
        f"/api/workspaces/{env['workspace'].slug}/agent-dock/context/resolve/",
        {"request_id": f"ctx-{uuid4().hex}", "route": route},
        format="json",
    )
    # Non-members are stopped by workspace authorization before route parsing.
    assert response.status_code == 403


def test_context_resolve_is_idempotent_and_workspace_route_is_safe(env):
    route = f"/{env['workspace'].slug}"
    request_id = f"ctx-{uuid4().hex}"
    first = _resolve(env, route, request_id=request_id)
    second = _resolve(env, route, request_id=request_id)
    assert first.status_code == 201
    assert second.status_code == 201
    assert first.json()["context_id"] == second.json()["context_id"]
    assert second.json()["target_type"] == "WORKSPACE"
