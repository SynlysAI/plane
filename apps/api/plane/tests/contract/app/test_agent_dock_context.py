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
from plane.research.services.agent_dock import agent_context_v3_for_grant, resolve_agent_dock_context
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


def test_invalid_node_hint_does_not_silently_downgrade_to_chain_context(env):
    route = f"/{env['workspace'].slug}/research/chains/{env['chain'].id}/nodes/{uuid4()}/agent"
    response = _resolve(env, route)
    assert response.status_code == 403
    assert response.json()["error"] == "agent_context_invalid"


def test_context_resolve_is_idempotent_and_workspace_route_is_safe(env):
    route = f"/{env['workspace'].slug}"
    request_id = f"ctx-{uuid4().hex}"
    first = _resolve(env, route, request_id=request_id)
    second = _resolve(env, route, request_id=request_id)
    assert first.status_code == 201
    assert second.status_code == 201
    assert first.json()["context_id"] == second.json()["context_id"]
    assert second.json()["target_type"] == "WORKSPACE"


@pytest.mark.parametrize("project_scope", [False, True])
def test_context_callback_accepts_workspace_and_project_tokens(env, project_scope):
    """验证真实上下文令牌回调，并保持项目范围约束。

    Args:
        env: 已建立科研组织权限的工作区与项目测试数据。
        project_scope: 是否使用绑定到具体项目的上下文令牌。
    """
    route = f"/{env['workspace'].slug}"
    if project_scope:
        route += f"/research/chains/{env['chain'].id}"
    grant, token, _envelope = resolve_agent_dock_context(
        workspace=env["workspace"],
        user=env["owner"],
        route=route,
        request_id=f"callback-{uuid4().hex}",
    )
    client = APIClient()
    client.credentials(
        HTTP_X_RESEARCH_CONTEXT_TOKEN=token,
        HTTP_X_RESEARCH_CONTEXT_HASH=grant.context_hash,
    )
    url = f"/api/research/workspaces/{env['workspace'].slug}/context/"

    response = client.get(url)

    assert response.status_code == 200, response.text
    expected_project = str(env["project"].id) if project_scope else None
    assert response.json()["scope"]["project_id"] == expected_project
    assert response.json()["context"]["context_id"] == str(grant.context_id)
    denied = client.get(url, {"project_id": str(uuid4())})
    assert denied.status_code == 403


def test_context_version_advances_and_invalid_attachments_fail_closed(env):
    route = f"/{env['workspace'].slug}"
    first = _resolve(env, route)
    second = _resolve(env, route)
    assert first.json()["context_version"] == 1
    assert second.json()["context_version"] == 2
    invalid = _resolve(env, route, attachment_ids=["not-an-uuid"])
    assert invalid.status_code == 400


def test_agent_dock_session_is_target_bound_and_projects_durable_events(env, monkeypatch):
    from plane.research.services import agent_dock_sessions

    class FakeRuntime:
        def __init__(self):
            self.pulled = False

        def create_session(self, *, title, research_context, context_token):
            assert research_context["schema_version"] == "agent-context.v3"
            assert research_context["target"]["type"] == "RESEARCH_CHAIN_NODE"
            assert context_token
            return "synlora-session-1"

        def start_run(self, *, thread_id, content, request_id, research_context, context_token):
            assert thread_id == "synlora-session-1"
            assert content == "总结当前节点"
            assert research_context["schema_version"] == "agent-context.v3"
            assert context_token
            return "synlora-run-1"

        def pull_events(self, *, session_id, after_seq=-1):
            if self.pulled:
                return [], after_seq, None
            self.pulled = True
            return (
                [
                    {"sequence": 1, "event": {"type": "tool.started", "name": "knowledge.search"}},
                    {"sequence": 2, "event": {"type": "assistant.snapshot", "content": "节点摘要"}},
                    {"sequence": 3, "event": {"type": "run.completed", "message": {"content": ""}}},
                ],
                3,
                "completed",
            )

    runtime = FakeRuntime()
    monkeypatch.setattr(agent_dock_sessions, "resolve_synlora_runtime", lambda *args, **kwargs: runtime)

    route = f"/{env['workspace'].slug}/research/chains/{env['chain'].id}/nodes/{env['node'].id}/agent"
    context = _resolve(env, route).json()
    session_response = env["client"].post(
        f"/api/workspaces/{env['workspace'].slug}/agent-dock/sessions/",
        {"request_id": f"session-{uuid4().hex}", "context_id": context["context_id"]},
        format="json",
    )
    assert session_response.status_code == 201, session_response.text
    session = session_response.json()
    assert session["target_type"] == "RESEARCH_CHAIN_NODE"
    assert session["target_key"] == f"node:{env['node'].id}"
    assert "token" not in str(session).lower()

    message = env["client"].post(
        f"/api/workspaces/{env['workspace'].slug}/agent-dock/sessions/{session['session_id']}/messages/",
        {"request_id": f"message-{uuid4().hex}", "content": "总结当前节点"},
        format="json",
    )
    assert message.status_code == 200, message.text
    assert message.json()["status"] == "STREAMING"

    events = env["client"].get(
        f"/api/workspaces/{env['workspace'].slug}/agent-dock/runs/{session['run_id']}/events/"
    )
    assert events.status_code == 200, events.text
    body = events.json()
    assert {item["event_type"] for item in body["results"]} >= {
        "CONTEXT_ASSEMBLED",
        "COMMUNICATION",
        "TOOL_CALL",
        "OUTPUT",
    }
    assert body["session"]["status"] == "READY"
