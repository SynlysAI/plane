"""v2.1 real ORM/API contracts, using an isolated test database only."""

from datetime import timedelta
from unittest.mock import patch
from uuid import uuid4

import pytest
from django.utils import timezone
from rest_framework.test import APIClient

from plane.db.models import (
    ResearchAgentOperation, ResearchAgentOperationApproval, ResearchAnalysisResult,
    ResearchChainEvent, ResearchChainNodeTask, ResearchChainSnapshot, ResearchTaskComment,
    WorkspaceResearchSetting,
)
from plane.research.services.agent_operations import ResearchOperationService, issue_write_grant
from plane.research.services.operation_catalog import ACTIONS, OPERATION_TOOL_NAMES
from plane.tests.contract.app.test_research_chain_mvp import env  # noqa: F401
from plane.tests.contract.app.test_research_machine_access import machine, scoped_client  # noqa: F401

pytestmark = pytest.mark.contract


@pytest.fixture
def operations(machine, settings):
    settings.RESEARCH_MCP_WRITE_ENABLED = True
    WorkspaceResearchSetting.objects.filter(workspace=machine["workspace"]).update(research_mcp_write_enabled=True)
    write, raw = issue_write_grant(workspace=machine["workspace"], user=machine["owner"],
        node_id=machine["node"].pk, actions=sorted(ACTIONS), agent_label="Codex test")
    api = APIClient()
    api.credentials(HTTP_X_RESEARCH_CONTEXT_TOKEN=raw, HTTP_X_RESEARCH_CONTEXT_HASH=write.context.context_hash)
    task = ResearchChainNodeTask.objects.create(workspace=machine["workspace"], chain=machine["chain"], node=machine["node"],
                                               title="Check conditions", request_id=uuid4().hex, payload_hash="a" * 64)
    snapshot = ResearchChainSnapshot.objects.create(chain=machine["chain"], node=machine["node"], version=1,
        summary="Existing evidence", source_versions=[], resources=[], event_range={}, request_id=uuid4().hex, content_hash="b" * 64)
    return {**machine, "write": write, "grant": write.context, "raw": raw, "agent": api, "task": task, "snapshot": snapshot,
        "operations_root": machine["root"].replace("agent-access", "agent-operations"),
        "human": f"/api/research/workspaces/{machine['workspace'].slug}/nodes/{machine['node'].pk}/agent-operations/"}


def call(e, name, args, client=None):
    return (client or e["agent"]).post(e["operations_root"] + "tools/" + name + "/", args, format="json")


def prepare(e, action="create_task", payload=None, **extra):
    return call(e, "prepare_research_operation", {"request_id": uuid4().hex, "node_id": str(e["node"].pk),
        "action": action, "payload": payload if payload is not None else {"title": "Check temperature"}, **extra})


def decide(e, proposal, decision="APPROVED", client=None):
    return (client or e["owner_client"]).post(e["human"], {"kind": "decision", "operation_id": proposal["operation_id"],
        "proposal_hash": proposal["proposal_hash"], "decision": decision}, format="json")


def test_separate_catalogue_preserves_read_only_entry(operations):
    e = operations
    old = e["api"].get(e["root"] + "tools/").json()["tools"]
    new = e["agent"].get(e["operations_root"] + "tools/").json()["tools"]
    assert len(old) == 10 and all(tool["annotations"]["readOnlyHint"] for tool in old)
    assert len(new) == 15
    assert {tool["name"] for tool in new} - {tool["name"] for tool in old} == OPERATION_TOOL_NAMES
    assert not next(tool for tool in new if tool["name"] == "prepare_research_operation")["annotations"]["readOnlyHint"]
    rpc = e["agent"].post(e["operations_root"] + "mcp/", {"jsonrpc": "2.0", "id": 1, "method": "tools/call",
        "params": {"name": "approve_research_operation", "arguments": {}}}, format="json")
    assert rpc.json()["result"]["isError"] is True


def test_read_key_read_grant_and_session_cannot_gain_write_permission(operations):
    e = operations
    assert e["api"].get(e["operations_root"] + "tools/").status_code == 403
    read_api, _, _ = scoped_client(e)
    assert read_api.get(e["operations_root"] + "tools/").status_code == 403
    assert e["owner_client"].get(e["operations_root"] + "tools/").status_code == 403
    assert e["api"].post(e["human"], {"kind": "workspace_policy", "enabled": True}, format="json").status_code == 401


def test_prepare_does_not_write_target_and_execution_requires_approval(operations):
    e = operations
    before = (ResearchChainNodeTask.objects.count(), ResearchTaskComment.objects.count(), ResearchChainEvent.objects.count())
    prepared = prepare(e)
    assert prepared.status_code == 200, prepared.json()
    proposal = prepared.json()
    assert proposal["status"] == "PROPOSED"
    assert call(e, "execute_research_operation", {"operation_id": proposal["operation_id"]}).status_code == 403
    assert before == (ResearchChainNodeTask.objects.count(), ResearchTaskComment.objects.count(), ResearchChainEvent.objects.count())


@pytest.mark.parametrize("action", sorted(ACTIONS))
def test_five_actions_commit_once_and_read_back(operations, action):
    e = operations
    payloads = {
        "create_task": {"title": "  Three repetitions  ", "instruction": "Verify conditions first"},
        "append_task_comment": {"task_id": str(e["task"].pk), "text": "Awaiting logs <script>untrusted()</script>"},
        "save_analysis_draft": {"method": "Comparison", "summary": "Insufficient conditions", "conclusion": "Draft only"},
        "attach_task_resource": {"task_id": str(e["task"].pk), "resource_type": "SNAPSHOT", "resource_id": str(e["snapshot"].snapshot_id), "version": 1},
        "append_research_note": {"text": "Awaiting human review of the evidence"},
    }
    proposal = prepare(e, action, payloads[action]).json()
    assert decide(e, proposal).status_code == 200
    response = call(e, "execute_research_operation", {"operation_id": proposal["operation_id"]})
    assert response.status_code == 200, response.json()
    value = response.json()
    assert value["status"] == "COMMITTED" and value["result"]["readback"] == "verified"
    again = call(e, "execute_research_operation", {"operation_id": proposal["operation_id"]})
    assert again.json()["result"]["object_id"] == value["result"]["object_id"]
    assert ResearchAgentOperationApproval.objects.filter(operation_id=proposal["operation_id"]).count() == 1
    assert ResearchChainEvent.objects.filter(trace_id=proposal["operation_id"]).count() == 1
    provenance = ResearchChainEvent.objects.get(trace_id=proposal["operation_id"])
    assert provenance.actor_type == "AGENT" and provenance.metadata["agent_label"] == "Codex test"
    if action == "create_task":
        task = ResearchChainNodeTask.objects.get(pk=value["result"]["object_id"])
        assert task.status == "DRAFT" and task.assignee is None and task.due_at is None
        assert task.title == "Three repetitions"
    if action == "append_task_comment":
        comment = ResearchTaskComment.objects.get(pk=value["result"]["object_id"])
        assert "<script>" not in comment.comment_html
        assert "untrusted()" in comment.comment_stripped
    if action == "save_analysis_draft":
        assert ResearchAnalysisResult.objects.get(pk=value["result"]["object_id"]).status == "DRAFT"
        assert ResearchChainSnapshot.objects.count() == 1
    e["node"].refresh_from_db()
    assert e["node"].status == "DRAFT"


@pytest.mark.parametrize("field,value", [("confirmed", True), ("assignee", str(uuid4())), ("status", "COMPLETED"), ("approved", True)])
def test_unknown_payload_fields_never_bypass_the_contract(operations, field, value):
    assert prepare(operations, payload={"title": "Untrusted", field: value}).status_code == 400


def test_idempotent_prepare_and_changed_payload_conflict(operations):
    e = operations
    args = {"node_id": str(e["node"].pk), "request_id": uuid4().hex, "action": "create_task", "payload": {"title": "Stable"}}
    first = call(e, "prepare_research_operation", args).json()
    assert call(e, "prepare_research_operation", args).json()["operation_id"] == first["operation_id"]
    args["payload"]["title"] = "Replacement"
    assert call(e, "prepare_research_operation", args).status_code == 409


def test_node_scope_is_enforced_for_targets_and_sources(operations):
    e = operations
    response = prepare(e, node_id=str(e["other"].pk))
    assert response.status_code == 404
    foreign = ResearchChainNodeTask.objects.create(workspace=e["workspace"], chain=e["chain"], node=e["other"],
        title="Outside node", request_id=uuid4().hex, payload_hash="b" * 64)
    assert prepare(e, "append_task_comment", {"task_id": str(foreign.pk), "text": "No"}).status_code == 404
    assert prepare(e, source_refs=[{"kind": "task", "id": str(foreign.pk), "usage": "body"}]).status_code == 404


def test_machine_cannot_review_and_exact_hash_is_required(operations):
    e = operations
    proposal = prepare(e).json()
    assert decide(e, proposal, client=e["agent"]).status_code == 401
    assert decide(e, {**proposal, "proposal_hash": "0" * 64}).status_code == 409
    assert decide(e, proposal, client=e["collaborator_client"]).status_code == 404
    assert decide(e, proposal).status_code == 200
    assert decide(e, proposal, "REJECTED").status_code == 409


def test_rejection_and_cancellation_cannot_be_executed(operations):
    e = operations
    rejected = prepare(e).json()
    assert decide(e, rejected, "REJECTED").status_code == 200
    assert call(e, "execute_research_operation", {"operation_id": rejected["operation_id"]}).status_code == 403
    cancelled = prepare(e).json()
    assert call(e, "cancel_research_operation", {"operation_id": cancelled["operation_id"]}).json()["status"] == "CANCELLED"
    assert decide(e, cancelled).status_code == 409
    assert ResearchChainNodeTask.objects.count() == 1


def test_web_task_edit_causes_full_precondition_conflict(operations):
    e = operations
    proposal = prepare(e, "append_task_comment", {"task_id": str(e["task"].pk), "text": "Proposed comment"}).json()
    decide(e, proposal)
    ResearchChainNodeTask.objects.filter(pk=e["task"].pk).update(instruction="Changed after approval")
    response = call(e, "execute_research_operation", {"operation_id": proposal["operation_id"]})
    assert response.status_code == 409
    assert ResearchAgentOperation.objects.get(pk=proposal["operation_id"]).status == "CONFLICT"
    assert not ResearchTaskComment.objects.exists()


def test_source_hash_uses_full_body_beyond_display_limit(operations):
    e = operations
    source = ResearchAnalysisResult.objects.create(workspace=e["workspace"], chain=e["chain"], node=e["node"],
        method="Comparison", summary="A" * 12000 + "old", request_id=uuid4().hex, payload_hash="b" * 64)
    proposal = prepare(e, source_refs=[{"kind": "analysis", "id": str(source.pk), "usage": "body"}]).json()
    decide(e, proposal)
    ResearchAnalysisResult.objects.filter(pk=source.pk).update(summary="A" * 12000 + "new")
    assert call(e, "execute_research_operation", {"operation_id": proposal["operation_id"]}).status_code == 409
    assert ResearchChainNodeTask.objects.count() == 1


def test_already_bound_resource_and_wrong_version_are_rejected(operations):
    e = operations
    payload = {"task_id": str(e["task"].pk), "resource_type": "SNAPSHOT", "resource_id": str(e["snapshot"].snapshot_id), "version": 9}
    assert prepare(e, "attach_task_resource", payload).status_code == 409
    payload["version"] = 1
    ResearchChainNodeTask.objects.filter(pk=e["task"].pk).update(resource_type="SNAPSHOT", resource_id=e["snapshot"].snapshot_id)
    assert prepare(e, "attach_task_resource", payload).status_code == 409


@pytest.mark.parametrize("change", ["revoke", "expire", "disable_workspace", "archive", "membership"])
def test_live_revocation_and_lifecycle_are_rechecked(operations, change):
    e = operations
    proposal = prepare(e).json()
    decide(e, proposal)
    if change == "revoke":
        e["grant"].revoked_at = timezone.now(); e["grant"].save(update_fields=["revoked_at"])
    elif change == "expire":
        e["grant"].expires_at = timezone.now() - timedelta(seconds=1); e["grant"].save(update_fields=["expires_at"])
    elif change == "disable_workspace":
        WorkspaceResearchSetting.objects.filter(workspace=e["workspace"]).update(research_mcp_write_enabled=False)
    elif change == "archive":
        e["chain"].status = "ARCHIVED"; e["chain"].save(update_fields=["status"])
    else:
        from plane.db.models import WorkspaceMember
        WorkspaceMember.objects.filter(workspace=e["workspace"], member=e["owner"]).update(is_active=False)
    assert call(e, "execute_research_operation", {"operation_id": proposal["operation_id"]}).status_code in {401, 403, 404, 409}
    assert ResearchChainNodeTask.objects.count() == 1


def test_payload_tampering_is_detected(operations):
    e = operations
    proposal = prepare(e).json()
    ResearchAgentOperation.objects.filter(pk=proposal["operation_id"]).update(payload={"title": "Tampered"})
    assert decide(e, proposal).status_code == 409
    assert call(e, "get_research_operation", {"operation_id": proposal["operation_id"]}).status_code == 409


def test_postcommit_readback_failure_is_recoverable_without_duplicate_write(operations):
    e = operations
    proposal = prepare(e).json(); decide(e, proposal)
    with patch("plane.research.services.agent_operations.ResearchReadService.execute", side_effect=RuntimeError("readback unavailable")):
        response = call(e, "execute_research_operation", {"operation_id": proposal["operation_id"]})
    assert response.status_code == 200
    assert response.json()["status"] == "COMMITTED" and response.json()["result"]["readback"] == "pending"
    result = call(e, "get_research_operation", {"operation_id": proposal["operation_id"]}).json()
    assert result["result"]["readback"] == "verified" and ResearchChainNodeTask.objects.count() == 2


def test_real_session_requires_csrf_and_rejects_foreign_origin(operations):
    e = operations
    api = APIClient(enforce_csrf_checks=True)
    api.force_login(e["owner"], backend="django.contrib.auth.backends.ModelBackend")
    state = api.get(e["human"])
    assert state.status_code == 200, state.content
    proposal = prepare(e).json()
    assert decide(e, proposal, client=api).status_code == 403
    api.credentials(HTTP_X_CSRFTOKEN=state.json()["csrf_token"])
    assert decide(e, proposal, client=api).status_code == 200
    other = prepare(e).json()
    api.credentials(HTTP_X_CSRFTOKEN=state.json()["csrf_token"], HTTP_ORIGIN="https://foreign.invalid")
    assert decide(e, other, client=api).status_code == 403


def test_human_issues_and_revokes_a_node_connection(operations):
    e = operations
    response = e["owner_client"].post(e["human"], {"kind": "issue_grant", "actions": ["create_task"], "agent_label": "Second Codex"}, format="json")
    assert response.status_code == 201, response.json()
    api = APIClient()
    api.credentials(**{"HTTP_" + key.upper().replace("-", "_"): value for key, value in response.json()["headers"].items()})
    catalogue = api.get(e["operations_root"] + "tools/").json()["tools"]
    prepare_schema = next(tool for tool in catalogue if tool["name"] == "prepare_research_operation")["inputSchema"]
    assert [schema["properties"]["action"]["const"] for schema in prepare_schema["oneOf"]] == ["create_task"]
    args = {"request_id": uuid4().hex, "node_id": str(e["node"].pk), "action": "append_research_note", "payload": {"text": "Not granted"}}
    assert call(e, "prepare_research_operation", args, api).status_code == 403
    assert e["owner_client"].post(e["human"], {"kind": "revoke_grant", "context_id": response.json()["context_id"]}, format="json").status_code == 200
    assert api.get(e["operations_root"] + "tools/").status_code == 401


def test_expired_approval_and_expired_proposal_do_not_commit(operations):
    e = operations
    proposal = prepare(e).json(); decide(e, proposal)
    ResearchAgentOperationApproval.objects.filter(operation_id=proposal["operation_id"]).update(expires_at=timezone.now() - timedelta(seconds=1))
    assert call(e, "execute_research_operation", {"operation_id": proposal["operation_id"]}).status_code == 403
    e["grant"].expires_at = timezone.now() + timedelta(days=3)
    e["grant"].save(update_fields=["expires_at"])
    future = timezone.now() + timedelta(days=2)
    with patch("plane.research.services.agent_operations.timezone.now", return_value=future):
        assert call(e, "execute_research_operation", {"operation_id": proposal["operation_id"]}).status_code == 409
    assert ResearchAgentOperation.objects.get(pk=proposal["operation_id"]).status == "EXPIRED"
    assert ResearchChainNodeTask.objects.count() == 1


def test_metadata_only_source_cannot_claim_body_and_revoked_source_hides_proposal(operations):
    from plane.db.models import ResearchExternalReference
    from plane.tests.contract.app.test_research_mcp_extended import link

    e = operations
    source = ResearchExternalReference.objects.create(workspace=e["workspace"], system="RAGPORTAL", external_type="KNOWLEDGE_ENTRY",
        external_id=uuid4().hex, title="Source metadata", acl_hint={"public": True})
    link(e, "external_reference", source)
    ref = {"kind": "external_reference", "id": str(source.pk), "usage": "body"}
    assert prepare(e, source_refs=[ref]).status_code == 422
    ref["usage"] = "metadata"
    proposal = prepare(e, source_refs=[ref]).json()
    source.status = "REVOKED"; source.save(update_fields=["status"])
    assert call(e, "get_research_operation", {"operation_id": proposal["operation_id"]}).status_code == 404
    assert call(e, "list_research_operations", {"node_id": str(e["node"].pk)}).json()["data"] == []
    assert e["owner_client"].get(e["human"]).json()["operations"] == []


def test_source_binding_supports_external_metadata_without_fetching_a_url(operations):
    from plane.db.models import ResearchExternalReference
    from plane.tests.contract.app.test_research_mcp_extended import link

    e = operations
    source = ResearchExternalReference.objects.create(workspace=e["workspace"], system="RAGPORTAL", external_type="KNOWLEDGE_ENTRY",
        external_id=uuid4().hex, title="Metadata", source_url="http://127.0.0.1:1/never-fetch", acl_hint={"public": True})
    link(e, "external_reference", source)
    proposal = prepare(e, "attach_task_resource", {"task_id": str(e["task"].pk), "resource_type": "EXTERNAL_REF", "resource_id": str(source.pk)}).json()
    decide(e, proposal)
    assert call(e, "execute_research_operation", {"operation_id": proposal["operation_id"]}).status_code == 200
    e["task"].refresh_from_db()
    assert e["task"].resource_id == source.pk


def test_refresh_grant_recovers_same_operation_without_expanding_scope(operations):
    e = operations
    proposal = prepare(e).json(); decide(e, proposal)
    e["grant"].revoked_at = timezone.now(); e["grant"].save(update_fields=["revoked_at"])
    write, raw = issue_write_grant(workspace=e["workspace"], user=e["owner"], node_id=e["node"].pk,
                                   actions=["create_task"], agent_label="Reconnected Codex")
    api = APIClient()
    api.credentials(HTTP_X_RESEARCH_CONTEXT_TOKEN=raw, HTTP_X_RESEARCH_CONTEXT_HASH=write.context.context_hash)
    value = call(e, "execute_research_operation", {"operation_id": proposal["operation_id"]}, api).json()
    assert value["status"] == "COMMITTED" and ResearchChainNodeTask.objects.count() == 2
    assert call(e, "cancel_research_operation", {"operation_id": proposal["operation_id"]}, api).status_code == 409


def test_mcp_jsonrpc_prepares_and_executes_real_operation(operations):
    e = operations
    args = {"request_id": uuid4().hex, "node_id": str(e["node"].pk), "action": "append_research_note", "payload": {"text": "MCP protocol fact"}}
    response = e["agent"].post(e["operations_root"] + "mcp/", {"jsonrpc": "2.0", "id": 1, "method": "tools/call",
        "params": {"name": "prepare_research_operation", "arguments": args}}, format="json")
    proposal = response.json()["result"]["structuredContent"]
    assert decide(e, proposal).status_code == 200
    response = e["agent"].post(e["operations_root"] + "mcp/", {"jsonrpc": "2.0", "id": 2, "method": "tools/call",
        "params": {"name": "execute_research_operation", "arguments": {"operation_id": proposal["operation_id"]}}}, format="json")
    result = response.json()["result"]
    assert result["isError"] is False and result["structuredContent"]["result"]["readback"] == "verified"


def test_operation_pages_obey_output_budget_and_allow_continuation(operations):
    import json
    e = operations
    ids = {prepare(e, payload={"title": str(index), "instruction": "A" * 8000}).json()["operation_id"] for index in range(4)}
    seen, cursor = set(), None
    for _ in range(5):
        value = call(e, "list_research_operations", {"node_id": str(e["node"].pk), **({"cursor": cursor} if cursor else {})}).json()
        assert len(json.dumps(value, ensure_ascii=False)) < 25000
        seen.update(item["operation_id"] for item in value["data"])
        if not value["page"]["has_more"]:
            break
        cursor = value["page"]["next_cursor"]
    assert seen == ids


def test_readback_detects_later_changes_without_repeating_business_mutation(operations):
    e = operations
    proposal = prepare(e).json(); decide(e, proposal)
    value = call(e, "execute_research_operation", {"operation_id": proposal["operation_id"]}).json()
    ResearchChainNodeTask.objects.filter(pk=value["result"]["object_id"]).update(title="Human revised the task")
    value = call(e, "get_research_operation", {"operation_id": proposal["operation_id"]}).json()
    assert value["status"] == "COMMITTED" and value["result"]["readback"] == "changed"
    assert ResearchChainNodeTask.objects.count() == 2


def test_report_attachment_requires_human_selected_formal_version(operations):
    from plane.db.models import Page, PeriodicReport, PeriodicReportSnapshot
    from plane.tests.contract.app.test_research_mcp_extended import link

    e = operations
    page = Page.objects.create(workspace=e["workspace"], name="Formal report", owned_by=e["owner"])
    report = PeriodicReport.objects.create(workspace=e["workspace"], project=e["private_project"], owner=e["owner"],
        org_unit=e["group"], page=page, report_type="WEEKLY", period_key="2026-W42", period_start="2026-10-12", period_end="2026-10-18",
        status="SUBMITTED", submitted_at=timezone.now())
    PeriodicReportSnapshot.objects.create(report=report, version_no=1, snapshot_status="SUBMITTED", description_stripped="Formal evidence")
    link(e, "report", report)
    payload = {"task_id": str(e["task"].pk), "resource_type": "REPORT", "resource_id": str(report.pk), "version": 1}
    assert prepare(e, "attach_task_resource", payload).status_code == 404
    response = e["owner_client"].post(e["human"], {"kind": "issue_grant", "agent_label": "Report Agent", "actions": ["attach_task_resource"],
        "reports": [{"id": str(report.pk), "version": 1}]}, format="json")
    assert response.status_code == 201, response.json()
    api = APIClient()
    api.credentials(**{"HTTP_" + key.upper().replace("-", "_"): value for key, value in response.json()["headers"].items()})
    proposal = prepare({**e, "agent": api}, "attach_task_resource", payload).json()
    assert proposal["target"]["task_title"] == e["task"].title
    assert decide(e, proposal).status_code == 200
    value = call(e, "execute_research_operation", {"operation_id": proposal["operation_id"]}, api)
    assert value.status_code == 200, value.json()
    assert value.json()["result"]["readback"] == "verified"


def test_malformed_rpc_tool_name_returns_protocol_error_without_crashing(operations):
    e = operations
    response = e["agent"].post(e["operations_root"] + "mcp/", {"jsonrpc": "2.0", "id": 1, "method": "tools/call",
        "params": {"name": {"unexpected": "object"}, "arguments": {}}}, format="json")
    assert response.status_code == 200 and response.json()["result"]["isError"] is True


@pytest.mark.django_db(transaction=True)
def test_concurrent_execute_has_one_business_effect(operations):
    from concurrent.futures import ThreadPoolExecutor
    from django.db import close_old_connections
    from plane.db.models import ResearchContextGrant

    e = operations
    proposal = prepare(e).json(); decide(e, proposal)

    def execute_once():
        close_old_connections()
        try:
            grant = ResearchContextGrant.objects.get(pk=e["grant"].pk)
            service = ResearchOperationService(workspace=e["workspace"], user=e["owner"], grant=grant)
            return service.execute("execute_research_operation", {"operation_id": proposal["operation_id"]})
        finally:
            close_old_connections()

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda _: execute_once(), range(2)))
    assert len({value["result"]["object_id"] for value in results}) == 1
    assert all(value["status"] == "COMMITTED" for value in results)
    assert ResearchChainNodeTask.objects.count() == 2
