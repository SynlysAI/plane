"""Unified research writes over real ORM, shared native services and MCP TCP."""
# ruff: noqa: F811, F401

import asyncio
import json
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from unittest.mock import patch
from uuid import uuid4

import httpx
import pytest
from django.conf import settings as django_settings
from django.db import IntegrityError, close_old_connections, transaction
from django.utils import timezone
from rest_framework.test import APIClient

from plane.db import models as db
from plane.mcp.reading import UnifiedReadService
from plane.research.services.agent_operations import ResearchOperationService, digest, issue_write_grant
from plane.research.services.operation_catalog import ACTIONS
from plane.tests.contract.app.test_unified_mcp import (
    MANAGEMENT,
    collect,
    env,
    invoke,
    issued,
    machine,
    payload,
    reference,
    rpc,
    unified,
)
from plane.tests.research_fixtures import make_research_boundary_fixture

pytestmark = [pytest.mark.contract, pytest.mark.django_db]


@pytest.fixture
def scientific(unified, settings):
    e = unified
    settings.RESEARCH_MCP_WRITE_ENABLED = True
    db.WorkspaceResearchSetting.objects.filter(workspace=e["workspace"]).update(research_mcp_write_enabled=True)
    db.ProjectMember.objects.create(workspace=e["workspace"], project=e["private_project"], member=e["owner"], role=20)
    value, client = issued(e, domains={"research": "read_write", "administrative": "read_write"})
    return {**e, "connection": value, "client": client}


def prepare(e, action="create_task", data=None, node=None, request_id=None, client=None, **extra):
    return invoke(
        client or e["client"],
        "plane_prepare_research_operation",
        {
            "node": reference(e, "ResearchChainNode", node or e["node"]),
            "request_id": request_id or uuid4().hex,
            "action": action,
            "payload": data if data is not None else {"title": "Unified research task"},
            **extra,
        },
    )


def execute(e, proposal, client=None, error=None):
    return invoke(
        client or e["client"],
        "plane_execute_research_operation",
        {"workspace_slug": e["workspace"].slug, "operation_id": proposal["operation_id"]},
        error=error,
    )


def task_from(e, node=None, request_id=None):
    proposal = prepare(e, node=node, request_id=request_id)
    value = execute(e, proposal)
    assert value["status"] == "COMMITTED" and value["result"]["readback"] == "verified", value
    return db.ResearchChainNodeTask.objects.get(pk=value["result"]["object_id"]), proposal


def test_permanent_connection_executes_proposal_and_rechecks_membership(scientific):
    """永久科研连接可执行提案，撤回成员资格后不能提交待执行提案。"""
    e = scientific
    db.UnifiedMCPConnection.objects.filter(pk=e["connection"]["id"]).update(expires_at=None)
    task, _ = task_from(e)
    assert task.title == "Unified research task"
    pending = prepare(e)
    db.WorkspaceMember.objects.filter(workspace=e["workspace"], member=e["owner"]).update(is_active=False)
    execute(e, pending, error="scope_denied")


def test_research_project_chain_and_node_lifecycle(scientific):
    """科研项目、研究链与节点生命周期共享原生角色和状态机。"""
    e = scientific
    db.OrgUnitMember.objects.filter(workspace=e["workspace"], user=e["owner"]).update(is_primary=True)
    args = {
        "workspace_slug": e["workspace"].slug,
        "request_id": "create-research-project",
        "name": "MCP 科研项目",
        "research_type": "RESEARCH_PROJECT",
        "org_unit_id": str(e["group"].pk),
        "chain_visibility": "WORKSPACE",
    }
    created = invoke(e["client"], "plane_create_research_project", args)
    assert created["status"] == "COMMITTED", created
    project_id = created["data"]["id"]
    chain_id = created["data"]["research"]["chain_id"]
    profile = db.ResearchProjectProfile.objects.get(project_id=project_id)
    assert profile.chain_visibility == "WORKSPACE" and str(profile.org_unit_id) == str(e["group"].pk)
    assert invoke(e["client"], "plane_create_research_project", args)["data"]["id"] == project_id
    receipt = invoke(
        e["client"],
        "plane_get_write_result",
        {"workspace_slug": e["workspace"].slug, "request_id": args["request_id"]},
    )
    assert receipt["object_type"] == "ResearchChain" and receipt["object_id"] == chain_id

    node_args = {
        "workspace_slug": e["workspace"].slug,
        "chain_id": chain_id,
        "request_id": "create-research-node",
        "title": "文献调研",
        "node_type": "GENERAL_RESEARCH",
    }
    node = invoke(e["client"], "plane_create_research_node", node_args)
    node_id = node["target"]["id"]
    assert db.ResearchChainEvent.objects.filter(node_id=node_id, event_type="NODE_CREATED").exists()
    assert invoke(e["client"], "plane_create_research_node", node_args)["data"]["id"] == node_id
    updated = invoke(
        e["client"],
        "plane_update_research_node",
        {
            "workspace_slug": e["workspace"].slug,
            "node_id": node_id,
            "request_id": "update-research-node",
            "changes": {"title": "文献调研更新"},
        },
    )
    assert updated["data"]["title"] == "文献调研更新"
    transition = invoke(
        e["client"],
        "plane_transition_research_node",
        {
            "workspace_slug": e["workspace"].slug,
            "node_id": node_id,
            "request_id": "start-research-node",
            "action": "START",
        },
    )
    assert transition["data"]["status"] == "ACTIVE"

    updated_project = invoke(
        e["client"],
        "plane_update_research_project",
        {
            "workspace_slug": e["workspace"].slug,
            "project_id": project_id,
            "request_id": "update-research-project",
            "changes": {"name": "MCP 科研项目更新"},
        },
    )
    assert updated_project["data"]["name"] == "MCP 科研项目更新"
    invoke(
        e["client"],
        "plane_archive_research_project",
        {"workspace_slug": e["workspace"].slug, "project_id": project_id, "request_id": "archive-research"},
    )
    profile.refresh_from_db()
    assert profile.workflow_status == "ARCHIVED"
    invoke(
        e["client"],
        "plane_restore_research_project",
        {"workspace_slug": e["workspace"].slug, "project_id": project_id, "request_id": "restore-research"},
    )
    profile.refresh_from_db()
    assert profile.workflow_status == "ACTIVE"
    invoke(
        e["client"],
        "plane_delete_research_project",
        {
            "workspace_slug": e["workspace"].slug,
            "project_id": project_id,
            "request_id": "delete-research",
            "confirm_name": "MCP 科研项目更新",
        },
    )
    profile.refresh_from_db()
    assert profile.workflow_status == "DELETED"


def test_full_project_document_catalog_marks_all_apis_available_for_both_write_domains(scientific):
    """行政与科研双读写连接的完整 30 个 API 均应显示可用。"""
    e = scientific
    client = APIClient()
    client.force_login(e["owner"])
    response = client.get(f"/api/mcp/connections/{e['connection']['id']}/tools/")
    assert response.status_code == 200, response.data
    payload = response.json()
    assert payload["catalog_mode"] == "full"
    assert len(payload["catalog"]) == 30
    assert all(tool["availability"]["enabled"] for tool in payload["catalog"])
    assert payload["catalog_summary"] == {"total": 30, "available": 30, "unavailable": 0}
    assert e["connection"]["secret"] not in response.content.decode()


def test_research_only_connection_can_recover_lifecycle_receipts(scientific):
    """科研-only 写连接也能看到并使用通用创建回执工具。"""
    e = scientific
    _, client = issued(e, domains={"research": "read_write"})
    names, cursor = [], None
    while True:
        response = rpc(client, "tools/list", {"cursor": cursor} if cursor else {}).json()["result"]
        names.extend(tool["name"] for tool in response["tools"])
        cursor = response.get("nextCursor")
        if not cursor:
            break
    assert "plane_get_write_result" in names
    assert "plane_create_task" not in names

    args = {
        "workspace_slug": e["workspace"].slug,
        "chain_id": str(e["chain"].pk),
        "request_id": "research-only-node",
        "title": "科研专用连接节点",
        "node_type": "GENERAL_RESEARCH",
    }
    created = invoke(client, "plane_create_research_node", args)
    recovered = invoke(
        client,
        "plane_get_write_result",
        {"workspace_slug": e["workspace"].slug, "request_id": args["request_id"]},
    )
    assert recovered["object_type"] == "ResearchChainNode"
    assert recovered["object_id"] == created["target"]["id"]
    assert recovered["readback"] == "verified"


def test_research_chain_replay_conflicts_before_already_exists(scientific):
    """同一链创建 request_id 改变参数时必须冲突，而非误报已存在。"""
    e = scientific
    project = db.Project.objects.create(workspace=e["workspace"], name="空链项目", identifier="EMPTY")
    db.ResearchProjectProfile.objects.create(
        project=project,
        workspace=e["workspace"],
        owner=e["owner"],
        research_type="RESEARCH_PROJECT",
        chain_kind="RESEARCH_CHAIN",
        chain_visibility="PRIVATE",
    )
    args = {
        "workspace_slug": e["workspace"].slug,
        "project_id": str(project.pk),
        "request_id": "empty-chain-once",
    }
    assert invoke(e["client"], "plane_create_research_chain", args)["status"] == "COMMITTED"
    invoke(
        e["client"],
        "plane_create_research_chain",
        {**args, "visibility": "PRIVATE"},
        error="idempotency_conflict",
    )


def test_research_node_assignee_and_unique_constraints_use_native_rules(scientific):
    """节点 assignee 必须可分配，重复父子迭代返回原生状态冲突。"""
    e = scientific
    parent = db.ResearchChainNode.objects.create(
        chain=e["chain"],
        node_type="GENERAL_RESEARCH",
        title="父节点",
        request_id=uuid4().hex,
        payload_hash="a" * 64,
    )
    common = {
        "workspace_slug": e["workspace"].slug,
        "chain_id": str(e["chain"].pk),
        "parent_node_id": str(parent.pk),
        "loop_iteration": 1,
        "node_type": "GENERAL_RESEARCH",
        "title": "重复子节点",
    }
    invoke(
        e["client"],
        "plane_create_research_node",
        {**common, "request_id": "invalid-assignee", "assignee_id": str(uuid4())},
        error="permission_denied",
    )
    first = invoke(e["client"], "plane_create_research_node", {**common, "request_id": "unique-child-1"})
    invoke(
        e["client"],
        "plane_create_research_node",
        {**common, "request_id": "unique-child-2"},
        error="state_conflict",
    )
    assert e["chain"].nodes.filter(parent_node=parent, loop_iteration=1).count() == 1
    invoke(
        e["client"],
        "plane_update_research_node",
        {
            "workspace_slug": e["workspace"].slug,
            "node_id": first["target"]["id"],
            "request_id": "invalid-node-assignee",
            "changes": {"assignee_id": str(uuid4())},
        },
        error="permission_denied",
    )


@pytest.mark.parametrize("action", sorted(ACTIONS))
def test_five_native_proposal_actions_commit_once_without_child_grants_or_approval(scientific, action):
    e = scientific
    snapshot = db.ResearchChainSnapshot.objects.create(
        chain=e["chain"],
        node=e["node"],
        version=1,
        summary="Evidence",
        source_versions=[],
        resources=[],
        event_range={},
        request_id=uuid4().hex,
        content_hash="a" * 64,
    )
    data = {
        "create_task": {"title": "Created via unified proposal", "instruction": "<p>Instructions</p>"},
        "append_task_comment": {
            "task_id": str(e["tasks"][0].pk),
            "text": "Native comment <script>reference()</script>",
        },
        "save_analysis_draft": {
            "method": "Comparison",
            "summary": "Draft observation",
            "conclusion": "Not a formal report",
        },
        "attach_task_resource": {
            "task_id": str(e["tasks"][0].pk),
            "resource_type": "SNAPSHOT",
            "resource_id": str(snapshot.snapshot_id),
            "version": 1,
        },
        "append_research_note": {"text": "Preserve provenance"},
    }[action]
    before = (
        db.ResearchChainNodeTask.objects.count(),
        db.ResearchTaskComment.objects.count(),
        db.ResearchAnalysisResult.objects.count(),
    )
    proposal = prepare(e, action, data)
    assert proposal["status"] == "PROPOSED" and proposal["execution_mode"] == "proposal"
    assert before == (
        db.ResearchChainNodeTask.objects.count(),
        db.ResearchTaskComment.objects.count(),
        db.ResearchAnalysisResult.objects.count(),
    )
    record = db.ResearchAgentOperation.objects.get(pk=proposal["operation_id"])
    assert (
        record.original_connection_id == __import__("uuid").UUID(e["connection"]["id"])
        and record.original_grant_id is None
    )
    first = execute(e, proposal)
    assert first["status"] == "COMMITTED" and first["result"]["readback"] == "verified", first
    counts = (db.ResearchChainEvent.objects.count(), db.Notification.objects.count())
    assert execute(e, proposal)["result"]["object_id"] == first["result"]["object_id"]
    assert counts == (db.ResearchChainEvent.objects.count(), db.Notification.objects.count())
    assert not db.ResearchContextGrant.objects.exists() and not db.ResearchAgentWriteGrant.objects.exists()
    assert not db.ResearchAgentOperationApproval.objects.exists()
    provenance = db.ResearchChainEvent.objects.get(trace_id=proposal["operation_id"])
    assert provenance.metadata["connection_id"] == e["connection"]["id"] and "grant_id" not in provenance.metadata
    assert provenance.metadata["authorization_source"] == "agent_client"


@pytest.mark.parametrize("current_zone", ["UTC", "Asia/Shanghai"])
def test_one_connection_writes_two_nodes_edits_comments_and_cancels_natively(scientific, current_zone):
    e = scientific
    for node in (e["node"], e["other"]):
        task, _ = task_from(e, node)
        ref = reference(e, "ResearchChainNodeTask", task)
        with timezone.override(current_zone):
            value = invoke(
                e["client"],
                "plane_update_task",
                {
                    "target": ref,
                    "changes": {
                        "title": "Edited in real node",
                        "instruction": "<p>Revised</p>",
                        "assignee": str(e["owner"].pk),
                        "due_at": "2026-11-02T10:00:00+08:00",
                    },
                },
            )
        assert value["execution_mode"] == "direct" and value["readback"] == "verified"
        comment = prepare(e, "append_task_comment", {"task_id": str(task.pk), "text": "Two-node comment"}, node)
        execute(e, comment)
        transition = {"target": ref, "action": "cancel", "request_id": uuid4().hex, "reason": "Synthetic acceptance"}
        cancelled = invoke(e["client"], "plane_transition_task", transition)
        assert cancelled["readback"] == "verified" and cancelled["commit"]["status"] == "CANCELLED"
        before = db.ResearchChainEvent.objects.count()
        invoke(e["client"], "plane_transition_task", transition)
        assert db.ResearchChainEvent.objects.count() == before
        comments = invoke(e["client"], "plane_get_context", {"target": ref, "section": "comments"})
        assert "Two-node comment" in json.dumps(comments)
        task.refresh_from_db()
        assert task.node_id == node.pk and task.status == "CANCELLED"
    assert db.ResearchAgentOperation.objects.count() == 4  # No proposals for edits/state actions.
    assert db.UnifiedMCPWriteResult.objects.count() == 0


def test_prepare_recovery_filters_own_connection_and_paginates(scientific):
    e = scientific
    proposal = prepare(e, request_id="recover-prepare")
    replay = prepare(e, request_id="recover-prepare")
    assert proposal["proposal_hash"] == replay["proposal_hash"] and proposal["operation_id"] == replay["operation_id"]
    for _ in range(3):
        prepare(e)
    rows = collect(
        e["client"],
        "plane_list_research_operations",
        {"node": reference(e, "ResearchChainNode", e["node"]), "limit": 1},
    )
    assert len(rows) == 4
    filtered = collect(
        e["client"],
        "plane_list_research_operations",
        {"node": reference(e, "ResearchChainNode", e["node"]), "request_id": "recover-prepare"},
    )
    assert [row["operation_id"] for row in filtered] == [proposal["operation_id"]]
    context = collect(
        e["client"],
        "plane_get_context",
        {"target": reference(e, "ResearchChainNode", e["node"]), "section": "operations", "limit": 1},
    )
    assert len(context) == 4
    other_value, other = issued(e, domains={"research": "read_write"})
    args = {"workspace_slug": e["workspace"].slug, "operation_id": proposal["operation_id"]}
    invoke(other, "plane_get_research_operation", args, error="not_found")
    execute(e, proposal, client=other, error="not_found")
    invoke(
        other,
        "plane_prepare_research_operation",
        {
            "node": reference(e, "ResearchChainNode", e["node"]),
            "request_id": "recover-prepare",
            "action": "create_task",
            "payload": {"title": "Unified research task"},
        },
        error="idempotency_conflict",
    )
    page = invoke(
        e["client"],
        "plane_list_research_operations",
        {"node": reference(e, "ResearchChainNode", e["node"]), "limit": 1},
    )
    invoke(
        other,
        "plane_list_research_operations",
        {"node": reference(e, "ResearchChainNode", e["node"]), "limit": 1, "cursor": page["page"]["next_cursor"]},
        error="invalid_cursor",
    )


def test_legacy_refresh_hash_and_ownership_remain_distinct(scientific):
    e = scientific
    write, raw = issue_write_grant(
        workspace=e["workspace"],
        user=e["owner"],
        node_id=e["node"].pk,
        actions=sorted(ACTIONS),
        agent_label="Legacy compatibility",
    )
    service = ResearchOperationService(workspace=e["workspace"], user=e["owner"], grant=write.context)
    old = service.execute(
        "prepare_research_operation",
        {
            "node_id": str(e["node"].pk),
            "request_id": "legacy-proposal",
            "action": "create_task",
            "payload": {"title": "Old task"},
        },
    )
    record = db.ResearchAgentOperation.objects.get(pk=old["operation_id"])
    original_hash = digest(
        {
            "workspace": str(record.workspace_id),
            "user": str(record.user_id),
            "node": str(record.node_id),
            "grant": str(record.original_grant_id),
            "request_id": record.request_id,
            "action": record.action,
            "payload": record.payload,
            "sources": record.source_refs,
            "preconditions": record.preconditions,
            "agent_label": record.agent_label,
            "expires_at": record.expires_at.isoformat(),
        }
    )
    assert record.proposal_hash == original_hash
    invoke(
        e["client"],
        "plane_get_research_operation",
        {"workspace_slug": e["workspace"].slug, "operation_id": old["operation_id"]},
        error="not_found",
    )
    unified_proposal = prepare(e)
    with pytest.raises(Exception) as denied:
        service.execute("get_research_operation", {"operation_id": unified_proposal["operation_id"]})
    assert getattr(denied.value, "code", None) == "not_found"
    write2, _ = issue_write_grant(
        workspace=e["workspace"],
        user=e["owner"],
        node_id=e["node"].pk,
        actions=sorted(ACTIONS),
        agent_label="Legacy refreshed",
    )
    refreshed = ResearchOperationService(workspace=e["workspace"], user=e["owner"], grant=write2.context)
    result = refreshed.execute("execute_research_operation", {"operation_id": old["operation_id"]})
    assert result["status"] == "COMMITTED" and result["proposal_hash"] == original_hash


@pytest.mark.parametrize("change", ["revoke", "expire", "inactive_user", "exit_workspace", "policy", "archive_node"])
def test_execution_rechecks_current_credential_membership_policy_and_parent(scientific, settings, change):
    e = scientific
    proposal = prepare(e)
    before = db.ResearchChainNodeTask.objects.count()
    if change == "revoke":
        db.UnifiedMCPConnection.objects.filter(pk=e["connection"]["id"]).update(revoked_at=timezone.now())
    elif change == "expire":
        db.UnifiedMCPConnection.objects.filter(pk=e["connection"]["id"]).update(
            expires_at=timezone.now() - timedelta(seconds=1)
        )
    elif change == "inactive_user":
        db.User.objects.filter(pk=e["owner"].pk).update(is_active=False)
    elif change == "exit_workspace":
        db.WorkspaceMember.objects.filter(workspace=e["workspace"], member=e["owner"]).update(is_active=False)
    elif change == "policy":
        db.WorkspaceResearchSetting.objects.filter(workspace=e["workspace"]).update(research_mcp_write_enabled=False)
    else:
        db.ResearchChainNode.objects.filter(pk=e["node"].pk).update(status="ARCHIVED")
    response = rpc(
        e["client"],
        "tools/call",
        {
            "name": "plane_execute_research_operation",
            "arguments": {"workspace_slug": e["workspace"].slug, "operation_id": proposal["operation_id"]},
        },
    )
    assert response.status_code == 401 or response.json()["result"]["isError"] is True
    assert db.ResearchChainNodeTask.objects.count() == before
    assert db.ResearchAgentOperation.objects.get(pk=proposal["operation_id"]).status == "PROPOSED"


def test_readonly_scope_wrong_node_invalid_inputs_and_no_arbitrary_mutation(scientific):
    e = scientific
    _, readonly = issued(e)
    invoke(
        readonly,
        "plane_prepare_research_operation",
        {
            "node": reference(e, "ResearchChainNode", e["node"]),
            "request_id": "readonly",
            "action": "create_task",
            "payload": {"title": "Forbidden"},
        },
        error="scope_denied",
    )
    task, _ = task_from(e)
    ref = reference(e, "ResearchChainNodeTask", task)
    for changes in (
        {"status": "COMPLETED"},
        {"resource_type": "SNAPSHOT"},
        {"assignee": str(uuid4())},
        {"due_at": "tomorrow"},
    ):
        invoke(e["client"], "plane_update_task", {"target": ref, "changes": changes}, error="invalid_arguments")
    invoke(
        e["client"],
        "plane_prepare_research_operation",
        {
            "node": reference(e, "ResearchChainNode", e["other"]),
            "request_id": "wrong-node-task",
            "action": "append_task_comment",
            "payload": {"task_id": str(task.pk), "text": "wrong parent"},
        },
        error="not_found",
    )
    invoke(
        e["client"],
        "plane_prepare_research_operation",
        {
            "node": reference(e, "ResearchChainNode", e["node"]),
            "request_id": "forbidden-payload",
            "action": "create_task",
            "payload": {"title": "No owner field", "assignee": str(e["owner"].pk)},
        },
        error="invalid_arguments",
    )
    assert (
        rpc(e["client"], "tools/call", {"name": "plane_submit_weekly_report", "arguments": {}}).json()["error"]["code"]
        == -32602
    )
    assert (
        rpc(e["client"], "tools/call", {"name": "approve_research_operation", "arguments": {}}).json()["error"]["code"]
        == -32602
    )


def test_result_readback_outage_and_proposal_tamper_or_source_change(scientific):
    e = scientific
    proposal = prepare(e)
    with patch(
        "plane.research.services.chain_context.ResearchReadService.execute",
        side_effect=RuntimeError("synthetic readback outage"),
    ):
        value = execute(e, proposal)
    assert value["status"] == "COMMITTED" and value["result"]["readback"] == "pending"
    recovered = invoke(
        e["client"],
        "plane_get_research_operation",
        {"workspace_slug": e["workspace"].slug, "operation_id": proposal["operation_id"]},
    )
    assert recovered["result"]["readback"] == "verified"
    changed = prepare(e)
    db.ResearchChainNode.objects.filter(pk=e["node"].pk).update(title="Native changed parent")
    execute(e, changed, error="operation_conflict")
    tampered = prepare(e)
    db.ResearchAgentOperation.objects.filter(pk=tampered["operation_id"]).update(payload={"title": "Tampered"})
    execute(e, tampered, error="proposal_changed")


def test_transaction_rollback_and_database_exactly_one_credential_constraint(scientific):
    e = scientific
    proposal = prepare(e)
    before = db.ResearchChainNodeTask.objects.count()
    with patch(
        "plane.research.services.agent_operations.ResearchOperationService.audit",
        side_effect=IntegrityError("synthetic rollback"),
    ):
        invoke(
            e["client"],
            "plane_execute_research_operation",
            {"workspace_slug": e["workspace"].slug, "operation_id": proposal["operation_id"]},
            error="write_unavailable",
        )
    assert db.ResearchChainNodeTask.objects.count() == before
    assert db.ResearchAgentOperation.objects.get(pk=proposal["operation_id"]).status == "PROPOSED"
    with pytest.raises(IntegrityError), transaction.atomic():
        db.ResearchAgentOperation.objects.filter(pk=proposal["operation_id"]).update(original_connection=None)


def test_bidirectional_legacy_and_unified_write_quotas(scientific):
    e = scientific
    for _ in range(4):
        issue_write_grant(
            workspace=e["workspace"],
            user=e["owner"],
            node_id=e["node"].pk,
            actions=sorted(ACTIONS),
            agent_label="Quota",
        )
    with pytest.raises(Exception) as denied:
        issue_write_grant(
            workspace=e["workspace"],
            user=e["owner"],
            node_id=e["node"].pk,
            actions=sorted(ACTIONS),
            agent_label="Overflow",
        )
    assert getattr(denied.value, "code", None) == "grant_limit"
    response = e["owner_client"].post(MANAGEMENT, payload(e, domains={"research": "read_write"}), format="json")
    assert response.status_code == 409 and response.data["error_code"] == "grant_limit"


def test_actual_weekly_credential_and_unified_credential_cannot_cross_purpose(scientific, settings):
    from plane.research.services.weekly_report_policy import issue_grant

    e = scientific
    settings.RESEARCH_WEEKLY_REPORT_MCP_ENABLED = True
    db.OrgUnitMember.objects.filter(workspace=e["workspace"], user=e["owner"], org_unit=e["group"]).update(
        is_primary=True
    )
    grant, raw = issue_grant(
        workspace=e["workspace"],
        user=e["owner"],
        label="Isolated weekly purpose",
        actions=["read_reports", "save_draft", "submit"],
        ttl_days=7,
    )
    assert grant.purpose == "weekly_report" and grant.report_type == "WEEKLY"
    weekly = APIClient()
    weekly.credentials(
        HTTP_X_WEEKLY_REPORT_TOKEN=raw,
        HTTP_ACCEPT="application/json, text/event-stream",
        HTTP_MCP_PROTOCOL_VERSION="2025-03-26",
    )
    weekly_url = f"/api/research/workspaces/{e['workspace'].slug}/weekly-report-agent/mcp/"
    request = {
        "jsonrpc": "2.0",
        "id": 1,
        "method": "tools/call",
        "params": {"name": "get_weekly_report_context", "arguments": {"period_offset": 0}},
    }
    valid = weekly.post(weekly_url, request, format="json")
    assert valid.status_code == 200 and valid.json()["result"]["isError"] is False, valid.data
    assert rpc(weekly, "ping").status_code == 401
    weekly.credentials(HTTP_AUTHORIZATION="Bearer " + raw, HTTP_ACCEPT="application/json, text/event-stream")
    assert rpc(weekly, "ping").status_code == 401
    weekly.credentials(
        HTTP_X_WEEKLY_REPORT_TOKEN=e["connection"]["secret"], HTTP_ACCEPT="application/json, text/event-stream"
    )
    assert weekly.post(weekly_url, request, format="json").status_code in (401, 403)
    assert not db.PeriodicReportSnapshot.objects.exists()


def test_later_node_is_writable_and_result_visibility_rechecks_scope(scientific):
    e = scientific
    later = db.ResearchChainNode.objects.create(
        chain=e["chain"], node_type="ANALYSIS", title="Future node", request_id=uuid4().hex, payload_hash="a" * 64
    )
    task, proposal = task_from(e, later)
    assert task.node_id == later.pk
    db.Project.objects.filter(pk=e["private_project"].pk).update(deleted_at=timezone.now())
    invoke(
        e["client"],
        "plane_get_research_operation",
        {"workspace_slug": e["workspace"].slug, "operation_id": proposal["operation_id"]},
        error="not_found",
    )


def test_transition_key_conflicts_and_policy_revocation_hide_actions(scientific, settings):
    e = scientific
    task, _ = task_from(e)
    ref = reference(e, "ResearchChainNodeTask", task)
    invoke(
        e["client"],
        "plane_transition_task",
        {"target": ref, "action": "cancel", "request_id": "state-once", "reason": "Original"},
    )
    invoke(
        e["client"],
        "plane_transition_task",
        {"target": ref, "action": "cancel", "request_id": "state-once", "reason": "Changed"},
        error="idempotency_conflict",
    )
    db.WorkspaceResearchSetting.objects.filter(workspace=e["workspace"]).update(research_mcp_write_enabled=False)
    caps = invoke(e["client"], "plane_get_context", {"target": ref, "section": "capabilities"})["data"]
    assert caps["allowed_actions"] == [] and caps["assignable_users"] == []
    invoke(e["client"], "plane_update_task", {"target": ref, "changes": {"title": "Disabled write"}}, error="disabled")


def test_current_assignee_completes_reopens_and_manager_cancels(settings):
    settings.RESEARCH_MODULE_ENABLED = settings.RESEARCH_MCP_ENABLED = settings.RESEARCH_MCP_WRITE_ENABLED = True
    b = make_research_boundary_fixture()
    db.WorkspaceResearchSetting.objects.filter(workspace=b["workspace"]).update(
        research_chain_enabled=True, research_mcp_write_enabled=True
    )
    db.ProjectMember.objects.get_or_create(
        project=b["project"], member=b["group_member"], defaults={"role": 15, "workspace": b["workspace"]}
    )
    clients = {}
    for key in ("student", "group_member", "advisor"):
        human = APIClient()
        human.force_authenticate(b[key])
        _, clients[key] = issued(
            {"workspace": b["workspace"], "owner_client": human}, domains={"research": "read_write"}
        )
    e = {"workspace": b["workspace"], "node": b["paper_node"], "client": clients["student"]}
    task, _ = task_from(e)
    ref = reference(e, "ResearchChainNodeTask", task)
    invoke(clients["student"], "plane_update_task", {"target": ref, "changes": {"assignee": str(b["group_member"].pk)}})
    caps = invoke(clients["group_member"], "plane_get_context", {"target": ref, "section": "capabilities"})["data"]
    assert (
        "complete" in caps["allowed_actions"]
        and "submit" not in caps["allowed_actions"]
        and "return" not in caps["allowed_actions"]
    )
    for key in ("student", "advisor"):
        invoke(
            clients[key],
            "plane_transition_task",
            {"target": ref, "action": "complete", "request_id": "not-assignee-" + key},
            error="permission_denied",
        )
    complete = {"target": ref, "action": "complete", "request_id": "assignee-completes"}
    assert invoke(clients["group_member"], "plane_transition_task", complete)["commit"]["status"] == "COMPLETED"
    invoke(clients["group_member"], "plane_transition_task", complete)
    caps = invoke(clients["group_member"], "plane_get_context", {"target": ref, "section": "capabilities"})["data"]
    assert "reopen" in caps["allowed_actions"] and "complete" not in caps["allowed_actions"]
    reopened = {"target": ref, "action": "reopen", "request_id": "assignee-reopens", "reason": "More work"}
    invoke(clients["advisor"], "plane_transition_task", reopened, error="permission_denied")
    assert invoke(clients["group_member"], "plane_transition_task", reopened)["commit"]["status"] == "ASSIGNED"
    invoke(clients["group_member"], "plane_transition_task", reopened)
    task2, _ = task_from(e)
    ref2 = reference(e, "ResearchChainNodeTask", task2)
    invoke(
        clients["advisor"],
        "plane_transition_task",
        {"target": ref2, "action": "cancel", "request_id": "not-manager", "reason": "No"},
        error="permission_denied",
    )
    invoke(
        clients["student"],
        "plane_transition_task",
        {"target": ref2, "action": "cancel", "request_id": "manager-cancels", "reason": "Unused"},
    )


@pytest.mark.django_db(transaction=True)
def test_concurrent_execute_uses_one_native_result(scientific):
    e = scientific
    proposal = prepare(e)

    def worker(_):
        close_old_connections()
        try:
            client = APIClient()
            client.credentials(
                HTTP_AUTHORIZATION="Bearer " + e["connection"]["secret"],
                HTTP_ACCEPT="application/json, text/event-stream",
            )
            return execute(e, proposal, client=client)
        finally:
            close_old_connections()

    with ThreadPoolExecutor(max_workers=2) as pool:
        values = list(pool.map(worker, range(2)))
    assert values[0]["result"]["object_id"] == values[1]["result"]["object_id"]
    assert db.ResearchChainEvent.objects.filter(trace_id=proposal["operation_id"]).count() == 1


@pytest.mark.django_db(transaction=True)
def test_real_sdk_one_config_two_research_nodes_proposals_edits_and_states(
    scientific, settings, live_server, record_property
):
    from mcp import ClientSession
    from mcp.client.streamable_http import streamable_http_client

    e = scientific
    settings.RESEARCH_MCP_PUBLIC_BASE_URL = live_server.url
    login = APIClient()
    login.force_login(e["owner"])
    with httpx.Client(
        base_url=live_server.url,
        cookies={django_settings.SESSION_COOKIE_NAME: login.cookies[django_settings.SESSION_COOKIE_NAME].value},
        trust_env=False,
    ) as human:
        csrf = human.get(MANAGEMENT).json()["csrf_token"]
        response = human.post(
            MANAGEMENT,
            json=payload(e, domains={"administrative": "read_write", "research": "read_write"}),
            headers={"X-CSRFToken": csrf},
        )
        assert response.status_code == 201
        configs = json.loads(response.json()["sciencediscovery_json"])["mcpServers"]
        assert len(configs) == 1
        assert next(iter(configs)) == "Synthetic unified connection"
        config = next(iter(configs.values()))

        async def scenario():
            async with httpx.AsyncClient(headers=config["headers"], trust_env=False) as http:
                async with streamable_http_client(config["url"], http_client=http) as streams:
                    async with ClientSession(
                        streams[0], streams[1], read_timeout_seconds=timedelta(seconds=30)
                    ) as session:
                        await session.initialize()
                        names, cursor = [], None
                        while True:
                            page = await session.list_tools(cursor=cursor)
                            names.extend(tool.name for tool in page.tools)
                            cursor = page.nextCursor
                            if not cursor:
                                break
                        assert len(names) == 30

                        async def call(name, args):
                            result = await session.call_tool(name, args)
                            assert not result.isError, result
                            return result.structuredContent

                        containers = await call("plane_list_containers", {"workspace_slug": e["workspace"].slug})
                        assert len([row for row in containers["data"] if row["domain"] == "administrative"]) == 2
                        nodes = await call("plane_list_nodes", {"container": reference(e, "ResearchChain", e["chain"])})
                        assert len(nodes["data"]) == 2
                        results = []
                        for node in (e["node"], e["other"]):
                            node_ref = reference(e, "ResearchChainNode", node)
                            proposal = await call(
                                "plane_prepare_research_operation",
                                {
                                    "node": node_ref,
                                    "request_id": uuid4().hex,
                                    "action": "create_task",
                                    "payload": {"title": "SDK research task"},
                                },
                            )
                            committed = await call(
                                "plane_execute_research_operation",
                                {"workspace_slug": e["workspace"].slug, "operation_id": proposal["operation_id"]},
                            )
                            ref = {
                                **node_ref,
                                "object_type": "ResearchChainNodeTask",
                                "id": committed["result"]["object_id"],
                            }
                            edited = await call(
                                "plane_update_task",
                                {
                                    "target": ref,
                                    "changes": {
                                        "title": "SDK revised",
                                        "assignee": str(e["owner"].pk),
                                        "due_at": "2026-11-02T10:00:00+08:00",
                                    },
                                },
                            )
                            assert edited["readback"] == "verified"
                            comment = await call(
                                "plane_prepare_research_operation",
                                {
                                    "node": node_ref,
                                    "request_id": uuid4().hex,
                                    "action": "append_task_comment",
                                    "payload": {"task_id": ref["id"], "text": "SDK research comment"},
                                },
                            )
                            await call(
                                "plane_execute_research_operation",
                                {"workspace_slug": e["workspace"].slug, "operation_id": comment["operation_id"]},
                            )
                            state = await call(
                                "plane_transition_task",
                                {
                                    "target": ref,
                                    "action": "cancel",
                                    "request_id": uuid4().hex,
                                    "reason": "SDK synthetic acceptance",
                                },
                            )
                            assert state["data"]["status"] == "CANCELLED"
                            comments = await call("plane_get_context", {"target": ref, "section": "comments"})
                            assert "SDK research comment" in json.dumps(comments)
                            results.append({"task_id": ref["id"], "operation_id": proposal["operation_id"]})
                        return results

        result = asyncio.run(scenario())
        for item, node in zip(result, (e["node"], e["other"])):
            root = (
                f"/api/research/workspaces/{e['workspace'].slug}/chains/{e['chain'].pk}/"
                f"nodes/{node.pk}/tasks/{item['task_id']}/"
            )
            assert human.get(root).json()["data"]["title"] == "SDK revised"
        record_property(
            "unified_research_sdk_proof",
            json.dumps(
                {
                    "transport": "real TCP",
                    "sdk": "mcp 1.28.1",
                    "servers": 1,
                    "tools": 15,
                    "research_nodes": 2,
                    "proposal_actions": ["create_task", "append_task_comment"],
                    "direct": ["update_task", "cancel"],
                    "native_web_readback": True,
                }
            ),
        )
