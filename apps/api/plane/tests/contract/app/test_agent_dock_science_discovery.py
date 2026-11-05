"""ScienceDiscovery Dock 的授权、装配与完整运行生命周期契约。"""

import json
from unittest.mock import MagicMock
from uuid import uuid4

import pytest
from django.core.cache import cache
from django.utils import timezone
from rest_framework.test import APIClient

from plane.db.models import ProjectMember, ResearchAgentSession, WorkspaceMember, WorkspaceResearchSetting
from plane.research.services import agent_dock_science_discovery as sd
from plane.research.services.agent_dock import resolve_agent_dock_context
from plane.research.services.agent_dock_sessions import (
    AgentDockSessionError,
    refresh_agent_dock_session_context,
)
from plane.research.services.chain_context import ResearchReadService
from plane.research.services.mcp_catalog import ResearchReadError
from plane.research.services.chain_projection import project_science_discovery_events
from plane.research.services.mcp_catalog import TOOL_NAMES
from plane.research.services.sciencediscovery import ScienceDiscoveryError
from plane.tests.research_fixtures import make_org_member, make_user

pytestmark = pytest.mark.contract


@pytest.fixture
def dock(sd_session, settings, monkeypatch):
    """在旧节点会话旁配置独立的工作区 Dock 和可观察的 SD 客户端。"""
    settings.RESEARCH_MCP_ENABLED = True
    settings.RESEARCH_MCP_PUBLIC_BASE_URL = "https://plane.test"
    WorkspaceResearchSetting.objects.filter(workspace=sd_session.workspace).update(
        research_agent_user_backend_enabled=True,
    )
    remote = MagicMock(configured=True)
    remote.create_research_connector.side_effect = lambda **kwargs: {
        "server_id": str(kwargs["grant"].context_id),
        "source_id": str(kwargs["grant"].context_id),
    }
    remote.ensure_project.return_value = "dock-project"
    remote.create_session.return_value = "dock-session"
    remote.start_run.return_value = "dock-run"
    remote.events.return_value = []
    monkeypatch.setattr(sd, "ScienceDiscoveryClient", lambda **kwargs: remote)
    monkeypatch.setattr(sd, "sync_specialists", lambda client: {"Plane Dock 工作区助手": "dock-specialist"})
    client = APIClient()
    client.force_authenticate(user=sd_session.user)
    return {
        "old": sd_session,
        "workspace": sd_session.workspace,
        "user": sd_session.user,
        "remote": remote,
        "client": client,
        "base": f"/api/workspaces/{sd_session.workspace.slug}/agent-dock",
    }


def _context(dock, provider="SCIENCE_DISCOVERY"):
    """解析测试用户的工作区上下文。

    Args:
        dock: 工作区测试环境。
        provider: 目标后端。

    Returns:
        对应 grant 与浏览器 envelope。
    """
    grant, _, envelope = resolve_agent_dock_context(
        workspace=dock["workspace"],
        user=dock["user"],
        route=f"/{dock['workspace'].slug}",
        provider=provider,
        request_id=f"ctx-{uuid4().hex}",
    )
    return grant, envelope


def _create(dock):
    """创建 SD Dock 并返回本地会话。

    Args:
        dock: 工作区测试环境。

    Returns:
        已装配的 Dock 会话。
    """
    grant, _ = _context(dock)
    response = dock["client"].post(
        f"{dock['base']}/sessions/",
        {
            "context_id": str(grant.context_id),
            "provider": "SCIENCE_DISCOVERY",
            "request_id": uuid4().hex,
        },
        format="json",
    )
    assert response.status_code == 201, response.content
    return ResearchAgentSession.objects.get(session_id=response.json()["session_id"])


def _start(dock, session):
    """提交一轮页面消息并重新读取运行状态。

    Args:
        dock: 工作区测试环境。
        session: 当前 Dock 会话。

    Returns:
        HTTP 响应与更新后的会话。
    """
    response = dock["client"].post(
        f"{dock['base']}/sessions/{session.session_id}/messages/",
        {
            "content": "分析当前研究",
            "provider": "SCIENCE_DISCOVERY",
            "request_id": uuid4().hex,
            "route": f"/{dock['workspace'].slug}?token=never-forward-this",
            "selected_text": "api_key=private-value",
        },
        format="json",
    )
    session.refresh_from_db()
    return response, session


@pytest.mark.parametrize("enabled", [True, False])
def test_context_tools_follow_research_mcp_switch(dock, settings, enabled):
    """SD 仅获得 research 读取工具，并在 MCP 关闭时获得空工具面。"""
    settings.RESEARCH_MCP_ENABLED = enabled
    grant, envelope = _context(dock)
    assert set(grant.allowed_tools) == (TOOL_NAMES if enabled else set())
    assert envelope["provider"] == "SCIENCE_DISCOVERY"
    assert envelope["science_discovery"]["available"] is True
    assert grant.target_type == "WORKSPACE"


def test_context_marks_known_unhealthy_connection_unavailable(dock):
    """连接测试已确认不可用时，面板不得把已配置等同于可执行。"""
    connection = dock["old"].backend_connection
    type(connection).objects.filter(pk=connection.pk).update(health_status="DOWN")
    _, envelope = _context(dock)
    assert envelope["science_discovery"] == {
        "available": False,
        "reason": "science_discovery_service_unavailable",
    }


@pytest.mark.parametrize("configured", [False, True])
def test_creation_requires_personal_connection_and_governance(dock, configured):
    """个人连接及工作区治理必须同时允许 SD，失败不创建远端会话。"""
    if configured:
        WorkspaceResearchSetting.objects.filter(workspace=dock["workspace"]).update(
            research_agent_user_backend_enabled=False,
        )
    else:
        connection = dock["old"].backend_connection
        type(connection).objects.filter(pk=connection.pk).update(deleted_at=timezone.now())
    grant, envelope = _context(dock)
    assert envelope["science_discovery"]["available"] is False
    response = dock["client"].post(
        f"{dock['base']}/sessions/",
        {
            "context_id": str(grant.context_id),
            "provider": "SCIENCE_DISCOVERY",
            "request_id": uuid4().hex,
        },
        format="json",
    )
    assert response.status_code == 409
    assert response.json()["error"] == "science_discovery_not_configured"
    dock["remote"].create_session.assert_not_called()


def test_creation_binds_connector_specialist_and_reuses_workspace_session(dock):
    """工作区会话固定连接、专属 connector 和 specialist，重复创建复用 session。"""
    first = _create(dock)
    assert first.provider == "SCIENCE_DISCOVERY"
    assert first.sd_project_id == "dock-project"
    assert first.sd_session_id == "dock-session"
    assert first.backend_connection_id == dock["old"].backend_connection_id
    connector = dock["remote"].create_research_connector.call_args.kwargs
    assert set(connector["expected_tools"]) == TOOL_NAMES
    assert connector["grant"].pk == first.context_grant_id
    assert dock["remote"].create_session.call_args.kwargs["specialist_id"] == "dock-specialist"
    assert dock["remote"].create_session.call_args.kwargs["connector_ids"] == [str(first.context_grant.context_id)]
    second = _create(dock)
    assert first.pk == second.pk
    dock["remote"].create_session.assert_called_once()
    first.context_grant.refresh_from_db()
    assert first.context_grant.revoked_at is not None


def test_creation_with_mcp_disabled_has_no_connectors(dock, settings):
    """关闭 MCP 时会话明确选择空连接器列表。"""
    settings.RESEARCH_MCP_ENABLED = False
    session = _create(dock)
    assert session.context_grant.allowed_tools == []
    dock["remote"].create_research_connector.assert_not_called()
    assert dock["remote"].create_session.call_args.kwargs["connector_ids"] == []


def test_creation_failure_revokes_grant_and_removes_connector(dock):
    """远端会话创建失败后，回滚会话并撤销其全部授权。"""
    dock["remote"].create_session.side_effect = ScienceDiscoveryError("science_discovery_session_failed", "failed", 502)
    grant, _ = _context(dock)
    response = dock["client"].post(
        f"{dock['base']}/sessions/",
        {
            "context_id": str(grant.context_id),
            "provider": "SCIENCE_DISCOVERY",
            "request_id": uuid4().hex,
        },
        format="json",
    )
    assert response.status_code == 502
    assert response.json()["error"] == "science_discovery_session_failed"
    grant.refresh_from_db()
    assert grant.revoked_at is not None
    dock["remote"].remove_research_connector.assert_called_once_with(str(grant.context_id))


def test_refresh_failure_revokes_new_grant_after_rollback_and_preserves_old(dock):
    """刷新失败的撤销可持久化，原授权和设置继续保留。"""
    session = _create(dock)
    old_id = session.context_grant_id
    grant, _ = _context(dock)
    dock["remote"].set_session_connectors.side_effect = ScienceDiscoveryError(
        "science_discovery_session_failed", "fail", 502
    )
    with pytest.raises(AgentDockSessionError):
        refresh_agent_dock_session_context(
            workspace=dock["workspace"],
            user=dock["user"],
            session=session,
            context_id=str(grant.context_id),
        )
    grant.refresh_from_db()
    session.refresh_from_db()
    assert grant.revoked_at is not None
    assert session.context_grant_id == old_id
    assert session.context_grant.revoked_at is None


def test_refresh_same_grant_is_idempotent_and_checks_locked_status(dock):
    """同一授权刷新不撤销自身；数据库已运行时拒绝旧对象发起的刷新。"""
    session = _create(dock)
    refresh_agent_dock_session_context(
        workspace=dock["workspace"],
        user=dock["user"],
        session=session,
        context_id=str(session.context_grant.context_id),
    )
    session.context_grant.refresh_from_db()
    assert session.context_grant.revoked_at is None
    dock["remote"].set_session_connectors.assert_not_called()
    grant, _ = _context(dock)
    ResearchAgentSession.objects.filter(pk=session.pk).update(status="STREAMING")
    with pytest.raises(AgentDockSessionError, match="already active"):
        refresh_agent_dock_session_context(
            workspace=dock["workspace"],
            user=dock["user"],
            session=session,
            context_id=str(grant.context_id),
        )


def test_message_binds_live_page_context_and_starts_async_run(dock):
    """SD 收到脱敏页面前缀并异步启动，审计包含实时 hash。"""
    session = _create(dock)
    response, session = _start(dock, session)
    assert response.status_code == 200, response.content
    assert session.status == "STREAMING"
    message = dock["remote"].start_run.call_args.kwargs["content"]
    prefix = json.loads(message.split("\n", 2)[1])
    assert prefix["route"] == f"/{dock['workspace'].slug}"
    assert prefix["page_context_hash"]
    assert "private-value" not in message
    assert "never-forward-this" not in message
    audit = session.run_events.filter(run_id=session.run_id, event_type="CONTEXT_ASSEMBLED").get()
    assert audit.payload["page_context_hash"] == prefix["page_context_hash"]
    assert session.run_events.filter(event_type="COMMUNICATION").count() == 1


def test_provider_mismatch_is_rejected_without_starting_run(dock):
    """跨 provider grant 不可绑定，消息也不可静默改路由。"""
    session = _create(dock)
    grant, _ = _context(dock, "SYNLORA")
    with pytest.raises(AgentDockSessionError) as failure:
        refresh_agent_dock_session_context(
            workspace=dock["workspace"],
            user=dock["user"],
            session=session,
            context_id=str(grant.context_id),
        )
    assert failure.value.code == "agent_context_provider_mismatch"
    response = dock["client"].post(
        f"{dock['base']}/sessions/{session.session_id}/messages/",
        {
            "content": "test",
            "provider": "SYNLORA",
            "request_id": uuid4().hex,
        },
        format="json",
    )
    assert response.status_code == 409
    dock["remote"].start_run.assert_not_called()


def test_events_are_idempotent_redacted_and_terminal_state_cannot_reopen(dock):
    """重复页不重复投影，终态后迟到审批不重新激活运行。"""
    session = _create(dock)
    _, session = _start(dock, session)
    dock["remote"].events.return_value = [
        {"sequence": 1, "event": {"type": "assistant.delta", "delta": "内容"}},
        {
            "sequence": 2,
            "event": {"type": "tool.started", "trace": {"id": "t1", "name": "read", "args": {"token": "sensitive"}}},
        },
    ]
    sd.sync_sd_dock_events(session=session)
    count = session.run_events.count()
    sd.sync_sd_dock_events(session=session)
    assert session.run_events.count() == count
    assert dock["remote"].events.call_args.kwargs["after_seq"] == 2
    assert "sensitive" not in str(list(session.run_events.values_list("payload", flat=True)))
    dock["remote"].events.return_value = [
        {"sequence": 3, "event": {"type": "run.completed", "message": {"content": "完成"}}},
        {"sequence": 4, "event": {"type": "permission.required", "request": {"id": "late"}}},
    ]
    sd.sync_sd_dock_events(session=session)
    assert session.status == "READY"
    assert session.assembly["source_cursor"] == 3
    assert not session.run_events.filter(event_type="APPROVAL").exists()
    assert (
        project_science_discovery_events(session, dock["remote"].events.return_value, expected_run_id=session.run_id)
        == []
    )


def test_late_projection_cannot_enter_next_run(dock):
    """上一轮 HTTP 响应到达时不能写入已经开始的新 run。"""
    session = _create(dock)
    _, session = _start(dock, session)
    previous = session.run_id
    ResearchAgentSession.objects.filter(pk=session.pk).update(run_id=uuid4())
    assert (
        project_science_discovery_events(
            session,
            [
                {"sequence": 1, "event": {"type": "run.completed"}},
            ],
            expected_run_id=previous,
        )
        == []
    )


def test_sse_resume_uses_remote_cursor_and_reaches_terminal(dock):
    """SSE 重连仅发送游标后的统一事件，终态后连接关闭。"""
    session = _create(dock)
    _, session = _start(dock, session)
    dock["remote"].events.return_value = [
        {"sequence": 1, "event": {"type": "assistant.delta", "delta": "已消费"}},
        {"sequence": 2, "event": {"type": "assistant.snapshot", "content": "完整回答"}},
        {"sequence": 3, "event": {"type": "run.completed"}},
    ]
    response = dock["client"].get(f"{dock['base']}/runs/{session.run_id}/events/stream/", HTTP_LAST_EVENT_ID="1")
    assert response.status_code == 200
    body = b"".join(response.streaming_content).decode()
    assert "agent-dock-event.v1" in body
    assert "event: context.bound" in body
    assert "已消费" not in body
    assert "完整回答" in body
    assert "event: run.completed" in body


@pytest.mark.parametrize("approved, decision", [(True, "allow_once"), (False, "deny")])
def test_approval_bridge_uses_latest_permission_id(dock, approved, decision):
    """统一布尔审批使用最新 permission request id。"""
    session = _create(dock)
    _, session = _start(dock, session)
    project_science_discovery_events(
        session,
        [
            {
                "sequence": 1,
                "event": {"type": "permission.required", "request": {"id": "permission-1"}},
            }
        ],
        expected_run_id=session.run_id,
    )
    session.refresh_from_db()
    response = dock["client"].post(
        f"{dock['base']}/runs/{session.run_id}/answer/",
        {"approved": approved},
        format="json",
    )
    assert response.status_code == 200
    dock["remote"].answer_approval.assert_called_once_with(request_id="permission-1", decision=decision)


def test_cancel_converges_locally_when_remote_is_down(dock):
    """远端取消失败仍本地终止，后续补拉不会重新启动运行。"""
    session = _create(dock)
    _, session = _start(dock, session)
    dock["remote"].cancel.side_effect = ScienceDiscoveryError("remote_down", "offline", 502)
    response = dock["client"].post(f"{dock['base']}/runs/{session.run_id}/cancel/", {}, format="json")
    assert response.status_code == 200
    session.refresh_from_db()
    assert session.status == "READY"
    assert session.last_error == "science_discovery_run_cancelled"
    with pytest.raises(ScienceDiscoveryError):
        sd.sync_sd_dock_events(session=session)
    dock["remote"].events.assert_not_called()


def test_history_lists_provider_and_excludes_old_node_sessions(dock):
    """统一历史序列化 provider，旧节点工作台历史不混入 Dock。"""
    session = _create(dock)
    response = dock["client"].get(f"{dock['base']}/sessions/")
    assert response.status_code == 200
    assert response.json()["count"] == 1
    assert response.json()["results"][0]["provider"] == "SCIENCE_DISCOVERY"
    assert response.json()["results"][0]["target_key"] == f"workspace:{session.workspace_id}"


def test_reconciliation_pulls_sd_dock_only(dock):
    """后台补拉收敛 Dock，并保留旧节点工作台的独立生命周期。"""
    from plane.bgtasks.agent_dock_task import reconcile_agent_dock_runs

    session = _create(dock)
    _, session = _start(dock, session)
    dock["remote"].events.return_value = [{"sequence": 1, "event": {"type": "run.completed"}}]
    cache.clear()
    assert reconcile_agent_dock_runs()["succeeded"] == 1
    session.refresh_from_db()
    dock["old"].refresh_from_db()
    assert session.status == "READY"
    assert dock["old"].status == "STREAMING"


def test_workspace_research_grant_can_read_visible_chain(dock):
    """workspace grant 不按空 project_id 限制，仍通过实时可见项目检查。"""
    grant, _ = _context(dock)
    service = ResearchReadService(workspace=dock["workspace"], user=dock["user"], grant=grant)
    assert service.chains().filter(pk=dock["old"].chain_node.chain_id).exists()
    old_service = ResearchReadService(
        workspace=dock["workspace"],
        user=dock["user"],
        grant=dock["old"].context_grant,
    )
    assert old_service.chains().filter(pk=dock["old"].chain_node.chain_id).exists()


def test_workspace_research_scope_respects_live_membership(dock):
    """同工作区的私人科研链仍需项目成员授权，撤销成员后立即失去读取权限。"""
    user = make_user()
    WorkspaceMember.objects.create(workspace=dock["workspace"], member=user, role=15, is_active=True)
    make_org_member(dock["workspace"], user, org_role="MEMBER")
    grant, _ = _context({**dock, "user": user})
    service = ResearchReadService(workspace=dock["workspace"], user=user, grant=grant)
    chain_id = dock["old"].chain_node.chain_id
    assert not service.chains().filter(pk=chain_id).exists()
    membership = ProjectMember.objects.create(
        workspace=dock["workspace"],
        project_id=dock["old"].project_id,
        member=user,
        role=15,
        is_active=True,
    )
    assert service.chains().filter(pk=chain_id).exists()
    ProjectMember.objects.filter(pk=membership.pk).update(is_active=False)
    assert not service.chains().filter(pk=chain_id).exists()


def test_sse_emits_heartbeat_without_events(dock, monkeypatch):
    """上游暂时没有事件时发送统一心跳，并在有限轮询窗口结束时返回。"""
    session = _create(dock)
    _, session = _start(dock, session)
    clock = iter([0, 0, 30])
    monkeypatch.setattr(sd, "time", MagicMock(monotonic=lambda: next(clock), sleep=lambda _: None))
    body = "".join(sd.stream_sd_dock_events(session=session, run_id=session.run_id, after_seq=0))
    assert "event: heartbeat" in body
    assert '"schema_version": "agent-dock-event.v1"' in body


def test_refresh_restores_old_connector_after_local_write_failure(dock, monkeypatch):
    """远端设置成功而本地审计失败时，恢复旧连接器并撤销失败 grant。"""
    from plane.research.services import agent_dock_sessions

    session = _create(dock)
    old_source = session.assembly["research_mcp"]["source_id"]
    grant, _ = _context(dock)
    monkeypatch.setattr(agent_dock_sessions, "_append_event", MagicMock(side_effect=RuntimeError("audit failed")))
    with pytest.raises(RuntimeError, match="audit failed"):
        refresh_agent_dock_session_context(
            workspace=dock["workspace"],
            user=dock["user"],
            session=session,
            context_id=str(grant.context_id),
        )
    grant.refresh_from_db()
    session.refresh_from_db()
    assert grant.revoked_at is not None
    assert session.context_grant_id != grant.pk
    assert dock["remote"].set_session_connectors.call_args.kwargs["connector_ids"] == [old_source]


def test_submission_intent_precedes_post_and_timeout_recovers_without_reposting(dock):
    """远端响应丢失时按已持久化请求恢复，重复请求不再次提交。"""
    session = _create(dock)

    def accept_then_timeout(**kwargs):
        """模拟 SD 已接收但响应超时，并检查此前已写入本地意图。"""
        persisted = ResearchAgentSession.objects.get(pk=session.pk)
        context = json.loads(kwargs["content"].split("\n", 2)[1])
        assert persisted.status == "INITIALIZING"
        assert persisted.assembly["sd_submission"]["request_id"] == context["request_id"]
        assert persisted.run_events.filter(run_id=persisted.run_id, event_type="USER_MESSAGE").exists()
        dock["remote"].list_runs.return_value = [{"id": "recovered-run", "prompt": kwargs["content"]}]
        raise ScienceDiscoveryError("request_timeout", "timeout", 502)

    dock["remote"].start_run.side_effect = accept_then_timeout
    response, session = _start(dock, session)
    assert response.status_code == 200
    assert session.status == "STREAMING"
    assert session.sd_run_id == "recovered-run"
    request_id = session.assembly["sd_submission"]["request_id"]
    duplicate = dock["client"].post(
        f"{dock['base']}/sessions/{session.session_id}/messages/",
        {"content": "分析当前研究", "provider": "SCIENCE_DISCOVERY", "request_id": request_id},
        format="json",
    )
    assert duplicate.status_code == 200
    assert duplicate.json()["run_id"] == str(session.run_id)
    conflict = dock["client"].post(
        f"{dock['base']}/sessions/{session.session_id}/messages/",
        {"content": "不同内容", "provider": "SCIENCE_DISCOVERY", "request_id": request_id},
        format="json",
    )
    assert conflict.status_code == 409
    dock["remote"].start_run.assert_called_once()


def test_uncertain_submission_blocks_new_runs_and_reconciliation_counts_failure(dock):
    """结果未明时保持固定本地 run，后台准确记录未恢复失败。"""
    from plane.bgtasks.agent_dock_task import reconcile_agent_dock_runs

    session = _create(dock)
    dock["remote"].start_run.side_effect = ScienceDiscoveryError("request_timeout", "timeout", 502)
    dock["remote"].list_runs.return_value = []
    response, session = _start(dock, session)
    assert response.status_code == 200
    original_run = session.run_id
    assert session.status == "INITIALIZING"
    response, session = _start(dock, session)
    assert response.status_code == 409
    assert session.run_id == original_run
    dock["remote"].start_run.assert_called_once()
    ResearchAgentSession.objects.filter(pk=session.pk).update(updated_at=timezone.now() - timezone.timedelta(days=2))
    cache.clear()
    result = reconcile_agent_dock_runs()
    assert result["failed"] == 1
    assert result["succeeded"] == 0


@pytest.mark.parametrize("upstream_status, expected_status", [(400, "DEGRADED"), (408, "INITIALIZING")])
def test_upstream_rejection_and_timeout_have_distinct_recovery_rules(dock, upstream_status, expected_status):
    """保留旧 BFF 状态码，同时区分明确拒绝与 HTTP 超时的未知结果。"""
    session = _create(dock)
    dock["remote"].start_run.side_effect = ScienceDiscoveryError(
        "science_discovery_run_failed",
        "upstream failure",
        502,
        upstream_status=upstream_status,
    )
    dock["remote"].list_runs.return_value = []
    response, session = _start(dock, session)
    assert session.status == expected_status
    assert response.status_code == (502 if upstream_status == 400 else 200)
    if upstream_status == 400:
        dock["remote"].list_runs.assert_not_called()


@pytest.mark.parametrize("cancel_fails", [False, True])
def test_local_bind_failure_compensates_remote_and_retries_cancel(dock, monkeypatch, cancel_fails):
    """远端成功、本地绑定失败时补偿取消，失败的补偿可由后台重试。"""
    session = _create(dock)
    original_bind = sd._bind_sd_submission
    monkeypatch.setattr(sd, "_bind_sd_submission", MagicMock(side_effect=RuntimeError("local binding failed")))
    if cancel_fails:
        dock["remote"].cancel.side_effect = ScienceDiscoveryError("remote_down", "offline", 502)
    with pytest.raises(RuntimeError, match="local binding failed"):
        sd.start_sd_dock_message(
            session=session,
            content="分析",
            request_id=uuid4().hex,
            route=f"/{dock['workspace'].slug}",
            focus_ref=None,
            selected_text="",
        )
    session.refresh_from_db()
    assert session.status == "DEGRADED"
    assert session.assembly["sd_submission"]["remote_run_id"] == "dock-run"
    assert session.assembly["sd_submission"]["phase"] == ("cancel_pending" if cancel_fails else "cancelled")
    dock["remote"].cancel.assert_called_once_with(session_id="dock-session", run_id="dock-run")
    if cancel_fails:
        monkeypatch.setattr(sd, "_bind_sd_submission", original_bind)
        dock["remote"].cancel.side_effect = None
        sd.sync_sd_dock_events(session=session)
        session.refresh_from_db()
        assert session.assembly["sd_submission"]["phase"] == "cancelled"
        assert session.status == "DEGRADED"
        dock["remote"].events.assert_not_called()


def test_late_recovery_cannot_reopen_completed_run(dock):
    """并发恢复使用旧意图时也不能让终态重新进入 STREAMING。"""
    session = _create(dock)
    _, session = _start(dock, session)
    stale = ResearchAgentSession.objects.get(pk=session.pk)
    stale.assembly["sd_submission"]["phase"] = "pending"
    project_science_discovery_events(
        session,
        [{"sequence": 1, "event": {"type": "run.completed"}}],
        expected_run_id=session.run_id,
    )
    restored = sd.recover_sd_dock_submission(session=stale)
    assert restored.status == "READY"


def test_session_history_pages_all_runs_offline_with_bound_cursor(dock):
    """会话历史跨轮分页、保留 run ID，连接关闭后仍能读取且游标不能串会话。"""
    session = _create(dock)
    _, session = _start(dock, session)
    first_run = session.run_id
    project_science_discovery_events(
        session,
        [{"sequence": 1, "event": {"type": "run.completed", "message": {"content": "第一轮"}}}],
        expected_run_id=first_run,
    )
    session.refresh_from_db()
    _, session = _start(dock, session)
    second_run = session.run_id
    project_science_discovery_events(
        session,
        [{"sequence": 1, "event": {"type": "assistant.delta", "delta": "第二轮"}}],
        expected_run_id=second_run,
    )
    connection = dock["old"].backend_connection
    type(connection).objects.filter(pk=connection.pk).update(is_enabled=False)
    path = f"{dock['base']}/sessions/{session.session_id}/events/"
    first = dock["client"].get(path, {"limit": 2})
    assert first.status_code == 200
    cursor = first.json()["next_cursor"]
    assert cursor
    events = first.json()["results"]
    while cursor:
        page = dock["client"].get(path, {"limit": 2, "cursor": cursor})
        assert page.status_code == 200
        events.extend(page.json()["results"])
        cursor = page.json()["next_cursor"]
    assert {row["run_id"] for row in events} >= {str(first_run), str(second_run)}
    assert len({row["seq"] for row in events}) == len(events)
    assert any(row["payload"].get("content") == "第一轮" for row in events)
    assert any(row["payload"].get("content") == "第二轮" for row in events)
    assert dock["client"].get(path, {"cursor": "tampered"}).status_code == 400
    other_grant, _ = _context(dock)
    other = ResearchAgentSession.objects.create(
        workspace=session.workspace,
        user=session.user,
        context_grant=other_grant,
        provider=session.provider,
        target_type="WORKSPACE",
        assembly=session.assembly,
        request_id=uuid4().hex,
        payload_hash=uuid4().hex,
    )
    wrong_path = f"{dock['base']}/sessions/{other.session_id}/events/"
    assert dock["client"].get(wrong_path, {"cursor": first.json()["next_cursor"]}).status_code == 400


def test_approval_details_multiple_pending_and_explicit_identity(dock):
    """审批保留动作、资源及真实工具关联，多请求时必须指定当前卡片 ID。"""
    session = _create(dock)
    _, session = _start(dock, session)
    requests = [
        {
            "id": f"permission-{index}",
            "toolCallId": f"tool-{index}",
            "summary": "写入分析结果",
            "action": "write",
            "resource": f"/workspace/results-{index}.txt",
        }
        for index in (1, 2)
    ]
    project_science_discovery_events(
        session,
        [
            {"sequence": index, "event": {"type": "permission.required", "request": request}}
            for index, request in enumerate(requests, 1)
        ],
        expected_run_id=session.run_id,
    )
    path = f"{dock['base']}/runs/{session.run_id}/answer/"
    assert dock["client"].post(path, {"approved": True}, format="json").status_code == 409
    dock["remote"].answer_approval.assert_not_called()
    response = dock["client"].get(f"{dock['base']}/sessions/{session.session_id}/events/")
    approvals = [row for row in response.json()["results"] if row["event_type"] == "APPROVAL"]
    payload = approvals[0]["payload"]
    assert payload["permission_request_id"] == "permission-1"
    assert payload["tool_call_id"] == "tool-1"
    assert payload["summary"] == "写入分析结果"
    assert payload["tool"] == "write"
    assert payload["resource"] == "/workspace/results-1.txt"
    answer = {"approved": True, "permission_request_id": "permission-1"}
    assert dock["client"].post(path, answer, format="json").status_code == 200
    session.refresh_from_db()
    assert session.status == "WAITING_APPROVAL"
    assert dock["client"].post(path, answer, format="json").status_code == 409
    dock["remote"].answer_approval.assert_called_once_with(request_id="permission-1", decision="allow_once")
    assert dock["client"].post(path, {"approved": False}, format="json").status_code == 200
    session.refresh_from_db()
    assert session.status == "STREAMING"
    dock["remote"].answer_approval.assert_called_with(request_id="permission-2", decision="deny")


def _linked_report(dock):
    """创建明确关联可见节点的正式报告，返回报告与关联事件。"""
    from plane.db.models import OrgUnit, Page, PeriodicReport, PeriodicReportSnapshot, ResearchChainEvent

    node = dock["old"].chain_node
    page = Page.objects.create(workspace=dock["workspace"], name="正式报告", owned_by=dock["user"])
    report = PeriodicReport.objects.create(
        workspace=dock["workspace"],
        project=node.chain.project,
        owner=dock["user"],
        org_unit=OrgUnit.objects.filter(workspace=dock["workspace"]).first(),
        page=page,
        report_type="WEEKLY",
        period_key="2026-W42",
        period_start="2026-10-12",
        period_end="2026-10-18",
        status="SUBMITTED",
        submitted_at=timezone.now(),
    )
    PeriodicReportSnapshot.objects.create(
        report=report,
        version_no=1,
        snapshot_status="SUBMITTED",
        description_stripped="正式证据",
    )
    linked = ResearchChainEvent.objects.create(
        chain=node.chain,
        node=node,
        event_type="OUTPUT",
        occurred_at=timezone.now(),
        event_id=uuid4().hex,
        request_id=uuid4().hex,
        refs=[{"kind": "report", "id": str(report.pk)}],
    )
    return report, linked


def _read_service(dock, grant):
    """为每次工具请求创建实时授权服务。"""
    return ResearchReadService(workspace=dock["workspace"], user=dock["user"], grant=grant)


def test_workspace_reports_require_link_version_and_keep_old_node_whitelist(dock):
    """仅 Dock 可按实时关联读取正式版本，旧节点仍受固定白名单约束。"""
    report, linked = _linked_report(dock)
    grant, _ = _context(dock)
    args = {"node_id": str(linked.node_id), "kind": "report"}
    listing = _read_service(dock, grant).execute("list_research_node_resources", args)
    assert listing["data"][0]["version"] == 1
    read_args = {**args, "resource_id": str(report.pk), "version": 1}
    result = _read_service(dock, grant).execute("read_research_resource", read_args)
    assert "正式证据" in result["data"]["text"]
    with pytest.raises(ResearchReadError) as missing_version:
        _read_service(dock, grant).execute("read_research_resource", {**args, "resource_id": str(report.pk)})
    assert missing_version.value.code == "version_required"
    old_grant = dock["old"].context_grant
    old_grant.allowed_tools = list(TOOL_NAMES)
    old = _read_service(dock, old_grant)
    assert old.execute("list_research_node_resources", args)["data"] == []
    type(linked.node).objects.filter(pk=linked.node_id).update(deleted_at=timezone.now())
    with pytest.raises(ResearchReadError) as unlinked:
        _read_service(dock, grant).execute("read_research_resource", read_args)
    assert unlinked.value.status == 404


def test_workspace_report_version_change_is_explicit(dock):
    """正式版本更新后，旧选择报错而列表返回新版本。"""
    from plane.db.models import PeriodicReportSnapshot

    report, linked = _linked_report(dock)
    grant, _ = _context(dock)
    PeriodicReportSnapshot.objects.create(report=report, version_no=2, snapshot_status="SUBMITTED")
    args = {"node_id": str(linked.node_id), "kind": "report", "resource_id": str(report.pk), "version": 1}
    with pytest.raises(ResearchReadError) as changed:
        _read_service(dock, grant).execute("read_research_resource", args)
    assert changed.value.code == "report_context_version_changed"
    listing = _read_service(dock, grant).execute(
        "list_research_node_resources",
        {"node_id": str(linked.node_id), "kind": "report"},
    )
    assert listing["data"][0]["version"] == 2


def test_report_acl_revocation_is_live_for_workspace_grant(dock):
    """报告 ACL 收窄后已有 workspace grant 立即失效。"""
    from plane.db.models import PeriodicReport

    report, linked = _linked_report(dock)
    reader = make_user()
    WorkspaceMember.objects.create(workspace=dock["workspace"], member=reader, role=15, is_active=True)
    make_org_member(dock["workspace"], reader, org_role="MEMBER")
    ProjectMember.objects.create(
        workspace=dock["workspace"],
        project_id=dock["old"].project_id,
        member=reader,
        role=15,
        is_active=True,
    )
    scope = {**dock, "user": reader}
    grant, _ = _context(scope)
    PeriodicReport.objects.filter(pk=report.pk).update(visibility="WORKSPACE")
    args = {"node_id": str(linked.node_id), "kind": "report", "resource_id": str(report.pk), "version": 1}
    assert _read_service(scope, grant).execute("read_research_resource", args)["data"]["version"] == 1
    PeriodicReport.objects.filter(pk=report.pk).update(visibility="PRIVATE")
    with pytest.raises(ResearchReadError) as denied:
        _read_service(scope, grant).execute("read_research_resource", args)
    assert denied.value.status == 404


@pytest.mark.parametrize("version_changed", [False, True])
def test_report_feedback_follows_same_link_and_formal_version_scope(dock, version_changed):
    """反馈只来自可见节点关联的当前正式版本，更新或撤销关联后不再返回。"""
    from plane.db.models import (
        PeriodicReportComment,
        PeriodicReportCommentFeedback,
        PeriodicReportCommentThread,
        PeriodicReportSnapshot,
    )

    report, linked = _linked_report(dock)
    grant, _ = _context(dock)
    thread = PeriodicReportCommentThread.objects.create(report=report, snapshot_version=1, content_hash="version-1")
    comment = PeriodicReportComment.objects.create(
        thread=thread,
        actor=dock["user"],
        comment_html="<p>检查结论</p>",
        comment_stripped="检查结论",
        feedback_type="CORRECTION",
        request_id=uuid4().hex,
    )
    feedback = PeriodicReportCommentFeedback.objects.create(
        comment=comment,
        report=report,
        thread=thread,
        feedback_type="CORRECTION",
        submitted_by=dock["user"],
        payload={"comment": {"text": "检查结论"}},
        payload_hash="feedback-hash",
    )
    result = _read_service(dock, grant).execute("list_research_report_feedback", {})
    assert [item["id"] for item in result["data"]] == [str(feedback.pk)]
    if version_changed:
        PeriodicReportSnapshot.objects.create(report=report, version_no=2, snapshot_status="SUBMITTED")
    else:
        type(linked.node).objects.filter(pk=linked.node_id).update(deleted_at=timezone.now())
    assert _read_service(dock, grant).execute("list_research_report_feedback", {})["data"] == []
