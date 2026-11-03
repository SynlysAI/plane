# Copyright (c) 2023-present Plane Software, Inc. contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Agent Dock server-authoritative context resolution tests."""

from datetime import timedelta
from hashlib import sha256
from uuid import uuid4

import pytest
from django.utils import timezone
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
    assert "Current node: Dock node" in envelope["manifest_summary"]["summary"]
    assert len(envelope["manifest_summary"]["resources"]) == envelope["resources_summary"]["total"]
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
                        {"sequence": 1, "event": {"type": "run.started", "remote_run_id": "synlora-run-1"}},
                        {
                            "sequence": 2,
                            "event": {
                                "type": "tool.started",
                                "remote_run_id": "synlora-run-1",
                                "name": "knowledge.search",
                            },
                        },
                        {
                            "sequence": 3,
                            "event": {
                                "type": "assistant.snapshot",
                                "remote_run_id": "synlora-run-1",
                                "content": "节点摘要",
                            },
                        },
                        {
                            "sequence": 4,
                            "event": {"type": "run.completed", "remote_run_id": "synlora-run-1"},
                        },
                ],
                    4,
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
        f"/api/workspaces/{env['workspace'].slug}/agent-dock/runs/{message.json()['run_id']}/events/"
    )
    assert events.status_code == 200, events.text
    body = events.json()
    assert {item["event_type"] for item in body["results"]} >= {
        "CONTEXT_ASSEMBLED",
        "COMMUNICATION",
        "DATA_CHANGE",
        "OUTPUT",
    }, [(item["event_type"], item["payload"]) for item in body["results"]]
    assert any(
        item["event_type"] == "DATA_CHANGE" and item["payload"].get("context_access") is True
        for item in body["results"]
    )
    assert body["session"]["status"] == "READY"


def test_agent_dock_sse_replays_and_deduplicates_synlora_events(env, monkeypatch):
    from plane.db.models import ResearchAgentRunEvent, ResearchAgentSession, ResearchChainEvent
    from plane.research.services import agent_dock_sessions
    from plane.app.views.agent_dock import views as agent_dock_views

    class FakeRuntime:
        events = [
            {"seq": 1, "type": "turn/start", "payload": {"run_id": "synlora-run-1"}},
            {"seq": 2, "type": "llm/delta", "payload": {"text": "暂存"}},
            {
                "seq": 3,
                "type": "tool/call",
                "payload": {"tool_call": {"id": "call-1", "name": "file.read", "arguments": {"file_id": "file-1"}}},
            },
            {
                "seq": 4,
                "type": "tool/result",
                "payload": {"tool_call_id": "call-1", "name": "file.read", "ok": True, "content": "命中"},
            },
            {
                "seq": 5,
                "type": "tool/call",
                "payload": {"tool_call": {"id": "call-risk", "name": "file.write", "arguments": {"file_id": "file-2"}}},
            },
            {
                "seq": 6,
                "type": "ask/user",
                "payload": {"kind": "approval", "tool_call_id": "call-risk", "tool": "file.write", "query": "请求审批"},
            },
            {
                "seq": 7,
                "type": "tool/result",
                "payload": {"tool_call_id": "call-risk", "name": "file.write", "ok": True, "content": "写入完成"},
            },
            {
                "seq": 8,
                "type": "assistant/message",
                "payload": {"content": "研究摘要"},
            },
            {"seq": 9, "type": "turn/end", "payload": {}},
        ]

        def create_session(self, *, title, research_context, context_token):
            return "synlora-session-sse"

        def start_run(self, **kwargs):
            return "synlora-run-1"

        def pull_events(self, *, session_id, after_seq=-1):
            return [], after_seq, None

        def stream_events(self, *, session_id, after_seq=-1):
            for event in self.events:
                if event["seq"] > after_seq:
                    yield event
                    if event["seq"] == 4:
                        yield event

    runtime = FakeRuntime()
    monkeypatch.setattr(agent_dock_sessions, "resolve_synlora_runtime", lambda *args, **kwargs: runtime)
    monkeypatch.setattr(agent_dock_views, "resolve_synlora_runtime", lambda *args, **kwargs: runtime)

    route = f"/{env['workspace'].slug}/research/chains/{env['chain'].id}/nodes/{env['node'].id}/agent"
    context = _resolve(env, route).json()
    created = env["client"].post(
        f"/api/workspaces/{env['workspace'].slug}/agent-dock/sessions/",
        {"request_id": f"session-{uuid4().hex}", "context_id": context["context_id"]},
        format="json",
    )
    assert created.status_code == 201, created.text
    session = created.json()
    started = env["client"].post(
        f"/api/workspaces/{env['workspace'].slug}/agent-dock/sessions/{session['session_id']}/messages/",
        {"request_id": f"message-{uuid4().hex}", "content": "总结当前节点"},
        format="json",
    )
    assert started.status_code == 200, started.text
    assert started.json()["run_id"] != session["run_id"]
    assert started.json()["run_start_cursor"] == -1

    response = env["client"].get(
        f"/api/workspaces/{env['workspace'].slug}/agent-dock/runs/{started.json()['run_id']}/events/stream/?after_seq=-1"
    )
    assert response.status_code == 200
    wire = b"".join(response.streaming_content).decode()
    assert wire.count("id: 4\n") == 1
    assert "event: context.accessed" in wire
    assert "event: output.delta" in wire
    assert "event: approval.required" in wire
    assert "event: approval.resolved" in wire
    assert "event: run.completed" in wire
    assert "暂存" in wire
    assert '"resource_id": "file-1"' in wire
    assert '"status": "completed"' in wire
    assert "命中" not in wire
    assert "写入完成" not in wire

    resumed = env["client"].get(
        f"/api/workspaces/{env['workspace'].slug}/agent-dock/runs/{started.json()['run_id']}/events/stream/?after_seq=0",
        HTTP_LAST_EVENT_ID="4",
    )
    resumed_wire = b"".join(resumed.streaming_content).decode()
    assert resumed.status_code == 200
    assert "id: 8\n" in resumed_wire
    assert "id: 9\n" in resumed_wire
    assert "id: 4\n" not in resumed_wire

    approval_resume = env["client"].get(
        f"/api/workspaces/{env['workspace'].slug}/agent-dock/runs/{started.json()['run_id']}/events/stream/?after_seq=0",
        HTTP_LAST_EVENT_ID="6",
    )
    approval_resume_wire = b"".join(approval_resume.streaming_content).decode()
    assert approval_resume.status_code == 200
    assert "event: approval.resolved\nid: 7\n" in approval_resume_wire

    session_record = ResearchAgentSession.objects.get(session_id=session["session_id"])
    stored = ResearchAgentRunEvent.objects.filter(
        session=session_record, payload__source_system="SYNLORA"
    )
    assert {item.payload["remote_seq"] for item in stored} == {1, 3, 4, 5, 6, 7, 8, 9}
    assert stored.filter(payload__remote_seq=4).count() == 1
    assert ResearchChainEvent.objects.filter(
        node=env["node"], source_system="SYNLORA"
    ).count() == 8
    refreshed = session_record
    refreshed.refresh_from_db()
    assert refreshed.status == "READY"
    assert refreshed.assembly["source_cursor"] == 9
    assert refreshed.assembly["run_start_cursor"] == -1

    next_started = env["client"].post(
        f"/api/workspaces/{env['workspace'].slug}/agent-dock/sessions/{session['session_id']}/messages/",
        {"request_id": f"message-{uuid4().hex}", "content": "继续总结"},
        format="json",
    )
    assert next_started.status_code == 200, next_started.text
    assert next_started.json()["run_id"] != started.json()["run_id"]
    current_events = env["client"].get(
        f"/api/workspaces/{env['workspace'].slug}/agent-dock/runs/{next_started.json()['run_id']}/events/"
    )
    assert current_events.status_code == 200, current_events.text
    assert all(
        item["run_id"] == next_started.json()["run_id"]
        for item in current_events.json()["results"]
    )

    invalid = env["client"].get(
        f"/api/workspaces/{env['workspace'].slug}/agent-dock/runs/{next_started.json()['run_id']}/events/stream/?after_seq=bad"
    )
    assert invalid.status_code == 400
    refreshed.context_grant.expires_at = timezone.now() - timedelta(seconds=1)
    refreshed.context_grant.save(update_fields=["expires_at", "updated_at"])
    expired = env["client"].get(
        f"/api/workspaces/{env['workspace'].slug}/agent-dock/runs/{next_started.json()['run_id']}/events/stream/"
    )
    assert expired.status_code == 403


def test_agent_dock_run_boundary_filters_old_events_and_prompt(env, monkeypatch):
    """只投影当前 Synlora run，并且不持久化启动事件中的系统提示词。"""
    from plane.db.models import ResearchAgentRunEvent, ResearchAgentSession
    from plane.research.services import agent_dock_sessions
    from plane.app.views.agent_dock import views as agent_dock_views

    class FakeRuntime:
        replay = [
            {"sequence": 11, "event": {"type": "run.cancelled", "remote_run_id": "previous-run"}},
            {
                "sequence": 12,
                "event": {
                    "type": "run.started",
                    "remote_run_id": "current-run",
                    "system_prompt": "private-system-prompt-marker",
                },
            },
            {
                "sequence": 13,
                "event": {
                    "type": "assistant.snapshot",
                    "remote_run_id": "current-run",
                    "content": "current answer",
                },
            },
            {"sequence": 14, "event": {"type": "run.cancelled", "remote_run_id": "previous-run"}},
            {"sequence": 15, "event": {"type": "run.completed", "remote_run_id": "current-run"}},
        ]
        stream = [
            {"seq": 11, "type": "turn/aborted", "payload": {"run_id": "previous-run"}},
            {
                "seq": 12,
                "type": "turn/start",
                "payload": {"run_id": "current-run", "system_prompt": "private-system-prompt-marker"},
            },
            {"seq": 13, "type": "assistant/message", "payload": {"run_id": "current-run", "content": "current answer"}},
            {"seq": 14, "type": "turn/aborted", "payload": {"run_id": "previous-run"}},
            {"seq": 15, "type": "turn/end", "payload": {"run_id": "current-run"}},
        ]

        def create_session(self, *, title, research_context, context_token):
            return "synlora-session-run-boundary"

        def start_run(self, **kwargs):
            return "current-run"

        def pull_events(self, *, session_id, after_seq=-1):
            events = [event for event in self.replay if event["sequence"] > after_seq]
            return events, 15 if events else after_seq, "completed" if events else None

        def stream_events(self, *, session_id, after_seq=-1):
            yield from (event for event in self.stream if event["seq"] > after_seq)

    runtime = FakeRuntime()
    monkeypatch.setattr(agent_dock_sessions, "resolve_synlora_runtime", lambda *args, **kwargs: runtime)
    monkeypatch.setattr(agent_dock_views, "resolve_synlora_runtime", lambda *args, **kwargs: runtime)
    route = f"/{env['workspace'].slug}/research/chains/{env['chain'].id}/nodes/{env['node'].id}/agent"
    context = _resolve(env, route).json()
    created = env["client"].post(
        f"/api/workspaces/{env['workspace'].slug}/agent-dock/sessions/",
        {"request_id": f"session-{uuid4().hex}", "context_id": context["context_id"]},
        format="json",
    )
    started = env["client"].post(
        f"/api/workspaces/{env['workspace'].slug}/agent-dock/sessions/{created.json()['session_id']}/messages/",
        {"request_id": f"message-{uuid4().hex}", "content": "继续回答"},
        format="json",
    )
    assert created.status_code == 201, created.text
    assert started.status_code == 200, started.text

    session = ResearchAgentSession.objects.get(session_id=created.json()["session_id"])
    session.assembly = {**session.assembly, "source_cursor": 10, "run_start_cursor": 10}
    session.save(update_fields=["assembly", "updated_at"])
    agent_dock_sessions.sync_agent_dock_events(
        workspace=env["workspace"], session=session, runtime=runtime
    )

    stored = ResearchAgentRunEvent.objects.filter(
        session=session, run_id=started.json()["run_id"], payload__source_system="SYNLORA"
    )
    assert {event.payload["remote_seq"] for event in stored} == {12, 13, 15}
    assert all(event.event_type != "DEGRADED" for event in stored)
    assert "private-system-prompt-marker" not in str(list(stored.values_list("payload", flat=True)))

    response = env["client"].get(
        f"/api/workspaces/{env['workspace'].slug}/agent-dock/runs/{started.json()['run_id']}/events/stream/?after_seq=10"
    )
    wire = b"".join(response.streaming_content).decode()
    assert response.status_code == 200
    assert "event: run.completed" in wire
    assert "private-system-prompt-marker" not in wire
    assert "previous-run" not in wire


def test_context_access_projection_never_returns_resource_body():
    """上下文访问事件只暴露资源标识和结果状态，不回传读取正文。"""
    from plane.research.services.agent_runtime import project_synlora_events, project_synlora_stream_event

    marker = "private-resource-body"
    source = {
        "seq": 7,
        "type": "tool/result",
        "payload": {
            "name": "file.read",
            "tool_call_id": "call-7",
            "file_id": "file-7",
            "ok": True,
            "content": marker,
        },
    }

    legacy = project_synlora_events([source])
    streamed = project_synlora_stream_event(source, run_id="run-7", created_at="2026-11-03T00:00:00Z")

    assert legacy[0]["event"]["type"] == "tool.completed"
    assert legacy[0]["event"]["resource_id"] == "file-7"
    assert marker not in str(legacy)
    assert streamed["event_type"] == "context.accessed"
    assert streamed["payload"]["resource_id"] == "file-7"
    assert streamed["payload"]["status"] == "completed"
    assert marker not in str(streamed)


def test_agent_dock_cancel_failure_is_reported(env, monkeypatch):
    """上游拒绝取消时，Plane 返回可观察错误并保留运行状态。"""
    from plane.db.models import ResearchAgentSession
    from plane.research.services import agent_runtime
    from plane.research.services import agent_dock_sessions

    class FakeRuntime:
        def create_session(self, *, title, research_context, context_token):
            return "synlora-session-cancel"

        def start_run(self, **kwargs):
            return "synlora-run-cancel"

        def cancel(self, *, run_id):
            assert run_id == "synlora-run-cancel"
            return False

    runtime = FakeRuntime()
    monkeypatch.setattr(agent_dock_sessions, "resolve_synlora_runtime", lambda *args, **kwargs: runtime)
    monkeypatch.setattr(agent_runtime, "resolve_synlora_runtime", lambda *args, **kwargs: runtime)

    route = f"/{env['workspace'].slug}/research/chains/{env['chain'].id}/nodes/{env['node'].id}/agent"
    context = _resolve(env, route).json()
    created = env["client"].post(
        f"/api/workspaces/{env['workspace'].slug}/agent-dock/sessions/",
        {"request_id": f"session-{uuid4().hex}", "context_id": context["context_id"]},
        format="json",
    )
    started = env["client"].post(
        f"/api/workspaces/{env['workspace'].slug}/agent-dock/sessions/{created.json()['session_id']}/messages/",
        {"request_id": f"message-{uuid4().hex}", "content": "开始执行后取消"},
        format="json",
    )

    cancelled = env["client"].post(
        f"/api/workspaces/{env['workspace'].slug}/agent-dock/runs/{started.json()['run_id']}/cancel/"
    )

    assert cancelled.status_code == 502
    assert cancelled.json()["error"] == "synlora_cancel_failed"
    session = ResearchAgentSession.objects.get(session_id=created.json()["session_id"])
    assert session.status == "STREAMING"
