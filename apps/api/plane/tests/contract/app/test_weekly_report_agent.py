"""Personal weekly report capabilities, immutable proposals and atomic recovery."""

from unittest.mock import patch
from uuid import uuid4

import pytest
from django.utils import timezone
from rest_framework.test import APIClient

from plane.db import models as db
from plane.research.services.weekly_report_catalog import VERSION
from plane.research.services.weekly_report_errors import WeeklyReportError
from plane.research.services.weekly_report_operations import WeeklyReportService
from plane.research.services.weekly_report_policy import issue_grant
from plane.tests.contract.app.test_research_reports import env as report_env, research_module_on  # noqa: F401

pytestmark = [pytest.mark.contract, pytest.mark.django_db]


@pytest.fixture
def env(report_env, settings):  # noqa: F811
    settings.RESEARCH_WEEKLY_REPORT_MCP_ENABLED = True
    return report_env


def connection(env, actions=None):
    return issue_grant(
        workspace=env["workspace"],
        user=env["student"],
        label="Test Agent",
        actions=actions or ["save_draft", "submit"],
        ttl_days=7,
    )


def proposal(
    service,
    *,
    action="submit",
    request_id=None,
    body="## 本周完成\n\n完成核心实现。",
    context=None,
    reviewer_id=None,
):
    context = context or service.execute("get_weekly_report_context", {"period_offset": -1})
    args = {
        "request_id": request_id or str(uuid4()),
        "action": action,
        "period_key": context["period"]["key"],
        "expected_revision": context["revision"],
        "body_markdown": body,
    }
    if action == "submit":
        args["reviewer_id"] = reviewer_id or context["approval"]["default_reviewer_id"]
        args["cc_user_ids"] = []
    return service.execute("prepare_weekly_report_operation", args), args


def test_new_submit_is_immutable_idempotent_and_recovers_after_readback_outage(env):
    grant, _ = connection(env)
    service = WeeklyReportService(grant=grant)
    prepared, args = proposal(service)
    assert prepared["report_id"] is None
    assert prepared["proposal"]["approval"]["reviewer_id"] == args["reviewer_id"]
    assert not db.PeriodicReport.objects.filter(period_key=args["period_key"], workspace=env["workspace"]).exists()
    assert service.execute("prepare_weekly_report_operation", args)["operation_id"] == prepared["operation_id"]
    with pytest.raises(WeeklyReportError) as error:
        service.execute("prepare_weekly_report_operation", {**args, "reviewer_id": str(uuid4())})
    assert error.value.code == "idempotency_conflict"
    operation_id = prepared["operation_id"]
    with patch.object(db.PeriodicReportSnapshot.objects, "get", side_effect=RuntimeError("readback unavailable")):
        committed = service.execute("execute_weekly_report_operation", {"operation_id": operation_id})
    assert committed["status"] == "COMMITTED"
    assert committed["readback"] == "pending"
    result = committed["result"]
    recovered = service.execute("get_weekly_report_operation", {"operation_id": operation_id})
    assert recovered["result"] == result
    assert recovered["readback"] == "verified"
    assert service.execute("execute_weekly_report_operation", {"operation_id": operation_id})["result"] == result
    assert service.execute("prepare_weekly_report_operation", args)["result"] == result
    assert db.PeriodicReportSnapshot.objects.filter(report_id=result["report_id"]).count() == 1
    assert db.ReportReviewLog.objects.filter(report_id=result["report_id"], action="SUBMIT").count() == 1
    assert (
        len(result["notification_record_ids"])
        == db.Notification.objects.filter(entity_identifier=result["report_id"]).count()
        == 1
    )
    route = db.ResearchApprovalRoute.objects.get(
        resource_type="PERIODIC_REPORT",
        resource_id=result["report_id"],
        status="ACTIVE",
    )
    assert str(route.reviewer_id) == args["reviewer_id"]
    assert result["approval_route_id"] == str(route.pk)
    assert result["reviewer_id"] == args["reviewer_id"]


def test_submit_proposal_requires_an_explicit_reviewer(env):
    grant, _ = connection(env)
    service = WeeklyReportService(grant=grant)
    context = service.execute("get_weekly_report_context", {"period_offset": -1})
    args = {
        "request_id": str(uuid4()),
        "action": "submit",
        "period_key": context["period"]["key"],
        "expected_revision": context["revision"],
        "body_markdown": "## 本周完成\n\n缺少审批人。",
    }

    with pytest.raises(WeeklyReportError) as error:
        service.execute("prepare_weekly_report_operation", args)

    assert error.value.code == "invalid_arguments"
    assert not db.ReportAgentOperation.objects.exists()


def test_routed_reviewer_lists_reads_returns_and_accepts_reports(env):
    """导师连接只能看到路由报告，并通过不可变提案完成退回与接受。"""
    student_grant, _ = connection(env)
    student = WeeklyReportService(grant=student_grant)
    submitted, _ = proposal(student)
    report_id = student.execute("execute_weekly_report_operation", {"operation_id": submitted["operation_id"]})[
        "result"
    ]["report_id"]

    db.OrgUnitMember.objects.filter(workspace=env["workspace"], user=env["advisor"]).update(is_primary=True)
    advisor_grant, _ = issue_grant(
        workspace=env["workspace"],
        user=env["advisor"],
        label="导师审阅",
        actions=["read_reports", "return", "accept"],
        ttl_days=7,
    )
    reviewer = WeeklyReportService(grant=advisor_grant)
    listing = reviewer.execute("list_weekly_reports", {"scope": "review", "limit": 20})
    assert [item["id"] for item in listing["results"]] == [report_id]
    detail = reviewer.execute("get_weekly_report", {"report_id": report_id})
    assert detail["report"]["status"] == "SUBMITTED" and detail["content_page"]["complete"] is True

    returned = reviewer.execute(
        "prepare_weekly_report_operation",
        {
            "request_id": "review-return-1",
            "action": "return",
            "report_id": report_id,
            "expected_revision": detail["revision"],
            "comment": "请补充实验结果。",
        },
    )
    committed = reviewer.execute("execute_weekly_report_operation", {"operation_id": returned["operation_id"]})
    assert committed["result"]["status"] == "NEEDS_REVISION"
    assert db.ResearchApprovalRoute.objects.filter(resource_id=report_id, status="SUPERSEDED").exists()
    history = reviewer.execute("list_weekly_report_history", {"report_id": report_id})
    assert "RETURN" in [item["action"] for item in history["results"]]

    context = student.execute("get_weekly_report_context", {"period_key": listing["results"][0]["period_key"]})
    again, _ = proposal(student, context=context)
    report_id = student.execute("execute_weekly_report_operation", {"operation_id": again["operation_id"]})["result"][
        "report_id"
    ]
    detail = reviewer.execute("get_weekly_report", {"report_id": report_id})
    accepted = reviewer.execute(
        "prepare_weekly_report_operation",
        {
            "request_id": "review-accept-1",
            "action": "accept",
            "report_id": report_id,
            "expected_revision": detail["revision"],
            "comment": "完成。",
        },
    )
    committed = reviewer.execute("execute_weekly_report_operation", {"operation_id": accepted["operation_id"]})
    assert committed["result"]["status"] == "ACCEPTED" and committed["readback"] == "verified"
    assert db.ReportReviewLog.objects.filter(report_id=report_id, action="ACCEPT").exists()


def test_legacy_write_grant_does_not_gain_report_catalog_reads(env):
    """旧 save/submit 周报连接保留原能力，不自动获得全量目录读取。"""
    grant, _ = connection(env)
    service = WeeklyReportService(grant=grant)
    assert service.execute("get_weekly_report_context", {"period_offset": -1})["contract_version"] == VERSION
    with pytest.raises(WeeklyReportError) as error:
        service.execute("list_weekly_reports", {"scope": "mine"})
    assert error.value.code == "scope_denied"


def test_review_only_connection_does_not_require_personal_report_context(env):
    """纯审阅连接不要求审阅者本人拥有可申报的科研档案。"""
    db.OrgUnitMember.objects.filter(workspace=env["workspace"], user=env["advisor"]).update(is_primary=False)
    grant, _ = issue_grant(
        workspace=env["workspace"],
        user=env["advisor"],
        label="纯审阅",
        actions=["read_reports", "return", "accept"],
        ttl_days=7,
    )
    assert grant.allowed_actions == ["accept", "read_reports", "return"]


def test_owner_can_withdraw_a_submitted_report_through_proposal(env):
    """撤回同样使用提案、状态校验、审计与路由关闭。"""
    grant, _ = connection(env, actions=["read_reports", "save_draft", "submit", "withdraw"])
    service = WeeklyReportService(grant=grant)
    submitted, _ = proposal(service)
    report_id = service.execute("execute_weekly_report_operation", {"operation_id": submitted["operation_id"]})[
        "result"
    ]["report_id"]
    detail = service.execute("get_weekly_report", {"report_id": report_id})
    prepared = service.execute(
        "prepare_weekly_report_operation",
        {
            "request_id": "owner-withdraw-1",
            "action": "withdraw",
            "report_id": report_id,
            "expected_revision": detail["revision"],
            "comment": "需要补充材料。",
        },
    )
    committed = service.execute("execute_weekly_report_operation", {"operation_id": prepared["operation_id"]})
    assert committed["result"]["status"] == "DRAFT"
    assert db.ReportReviewLog.objects.filter(report_id=report_id, action="REOPEN").exists()
    assert not db.ResearchApprovalRoute.objects.filter(resource_id=report_id, status="ACTIVE").exists()


def test_save_draft_schema_rejects_approval_selection(env):
    grant, _ = connection(env)
    service = WeeklyReportService(grant=grant)
    _, args = proposal(service, action="save_draft")
    invalid_request_id = str(uuid4())

    with pytest.raises(WeeklyReportError) as error:
        service.execute(
            "prepare_weekly_report_operation",
            {**args, "request_id": invalid_request_id, "reviewer_id": str(uuid4())},
        )

    assert error.value.code == "invalid_arguments"
    assert not db.ReportAgentOperation.objects.filter(request_id=invalid_request_id).exists()


def test_submit_proposal_rejects_reviewer_outside_approval_group(env):
    grant, _ = connection(env)
    service = WeeklyReportService(grant=grant)

    with pytest.raises(WeeklyReportError) as error:
        proposal(service, reviewer_id=str(uuid4()))

    assert error.value.code == "approval_reviewer_invalid"
    assert not db.ReportAgentOperation.objects.exists()


def test_save_draft_then_returned_report_resubmits_with_preserved_v1(env):
    grant, _ = connection(env)
    service = WeeklyReportService(grant=grant)
    prepared, _ = proposal(service, action="save_draft")
    draft = service.execute("execute_weekly_report_operation", {"operation_id": prepared["operation_id"]})
    assert draft["result"]["status"] == "DRAFT"
    assert draft["result"]["snapshot_version"] is None
    assert draft["result"]["notification_record_ids"] == []
    assert not db.PeriodicReportSnapshot.objects.filter(report_id=draft["report_id"]).exists()
    prepared, _ = proposal(service)
    committed = service.execute("execute_weekly_report_operation", {"operation_id": prepared["operation_id"]})
    first_operation_id = prepared["operation_id"]
    first = db.PeriodicReportSnapshot.objects.get(report_id=committed["report_id"], version_no=1)
    before = first.description_json
    returned = env["advisor_client"].post(
        f"{env['url']}{committed['report_id']}/return/", {"comment": "补充结果"}, format="json"
    )
    assert returned.status_code == 200
    prepared, _ = proposal(service, body="## 本周完成\n\n补充正式结果。")
    second = service.execute("execute_weekly_report_operation", {"operation_id": prepared["operation_id"]})
    assert second["result"]["snapshot_version"] == 2
    first.refresh_from_db()
    assert first.description_json == before
    assert (
        service.execute("get_weekly_report_operation", {"operation_id": first_operation_id})["result"][
            "snapshot_version"
        ]
        == 1
    )
    assert service.execute("get_weekly_report_context", {"period_offset": -1})["policy"]["allowed_actions"] == []


@pytest.mark.parametrize("change", ["body", "binary", "org", "visibility", "settings", "image", "attachment"])
def test_prepared_revision_covers_web_body_assets_organization_and_policy(env, change):
    grant, _ = connection(env)
    service = WeeklyReportService(grant=grant)
    drafted, _ = proposal(service, action="save_draft")
    draft = service.execute("execute_weekly_report_operation", {"operation_id": drafted["operation_id"]})
    prepared, _ = proposal(service)
    report = db.PeriodicReport.objects.get(pk=draft["report_id"])
    if change == "body":
        db.Page.objects.filter(pk=report.page_id).update(description_html="<p>web edit</p>")
    elif change == "binary":
        db.Page.objects.filter(pk=report.page_id).update(description_binary=b"new collaborative update")
    elif change == "org":
        db.OrgUnitMember.objects.filter(workspace=env["workspace"], user=env["student"]).update(is_primary=False)
    elif change == "visibility":
        db.PeriodicReport.objects.filter(pk=report.pk).update(visibility="PRIVATE")
    elif change == "settings":
        db.WorkspaceResearchSetting.objects.filter(workspace=env["workspace"]).update(
            weekly_default_visibility="PRIVATE"
        )
    else:
        asset = db.FileAsset.objects.create(
            workspace=env["workspace"],
            user=env["student"],
            asset="test.pdf",
            entity_type="REPORT_IMAGE",
            entity_identifier=str(report.pk),
            is_uploaded=True,
        )
        if change == "attachment":
            db.ReportAttachment.objects.create(report=report, asset=asset, file_name="test.pdf")
    with pytest.raises(WeeklyReportError) as error:
        service.execute("execute_weekly_report_operation", {"operation_id": prepared["operation_id"]})
    assert error.value.status in (403, 409)
    assert not db.PeriodicReportSnapshot.objects.filter(report=report).exists()


@pytest.mark.parametrize("change", ["revoke", "expire", "member", "account", "feature"])
def test_live_authorization_rechecked_before_execute(env, settings, change):
    grant, _ = connection(env)
    service = WeeklyReportService(grant=grant)
    prepared, _ = proposal(service)
    if change == "revoke":
        db.ReportAgentGrant.objects.filter(pk=grant.pk).update(revoked_at=timezone.now())
    elif change == "expire":
        db.ReportAgentGrant.objects.filter(pk=grant.pk).update(expires_at=timezone.now())
    elif change == "member":
        db.WorkspaceMember.objects.filter(workspace=env["workspace"], member=env["student"]).update(is_active=False)
    elif change == "account":
        db.User.objects.filter(pk=env["student"].pk).update(is_active=False)
    else:
        settings.RESEARCH_WEEKLY_REPORT_MCP_ENABLED = False
    with pytest.raises(WeeklyReportError) as error:
        service.execute("execute_weekly_report_operation", {"operation_id": prepared["operation_id"]})
    assert error.value.status == 403
    assert not db.PeriodicReport.objects.filter(
        workspace=env["workspace"], period_key=prepared["period"]["key"]
    ).exists()


def test_draft_only_cannot_submit_or_swap_payload_and_cross_grant_is_denied(env):
    grant, _ = connection(env, ["save_draft"])
    service = WeeklyReportService(grant=grant)
    with pytest.raises(WeeklyReportError, match="does not allow"):
        proposal(service, action="submit")
    prepared, args = proposal(service, action="save_draft")
    with pytest.raises(WeeklyReportError) as error:
        service.execute(
            "execute_weekly_report_operation", {"operation_id": prepared["operation_id"], "body_markdown": "swap"}
        )
    assert error.value.code == "invalid_arguments"
    with pytest.raises(WeeklyReportError) as error:
        service.execute("prepare_weekly_report_operation", {**args, "body_markdown": "different"})
    assert error.value.code == "idempotency_conflict"
    other, _ = connection(env)
    with pytest.raises(WeeklyReportError) as error:
        WeeklyReportService(grant=other).execute(
            "get_weekly_report_operation", {"operation_id": prepared["operation_id"]}
        )
    assert error.value.code == "not_found"


def test_notification_failure_rolls_back_report_page_snapshot_and_commit_result(env):
    grant, _ = connection(env)
    service = WeeklyReportService(grant=grant)
    prepared, _ = proposal(service)
    page_count = db.Page.objects.count()
    from plane.research.services import report_workflow

    real = report_workflow.notify_report_submitted

    def fail_after_write(*args, **kwargs):
        real(*args, **kwargs)
        raise RuntimeError("notification fault")

    with patch.object(report_workflow, "notify_report_submitted", side_effect=fail_after_write):
        with pytest.raises(RuntimeError, match="notification fault"):
            service.execute("execute_weekly_report_operation", {"operation_id": prepared["operation_id"]})
    assert db.Page.objects.count() == page_count
    assert not db.Notification.objects.exists()
    operation = db.ReportAgentOperation.objects.get(pk=prepared["operation_id"])
    assert operation.status == "PROPOSED" and operation.result == {} and operation.report_id is None
    result = service.execute("execute_weekly_report_operation", {"operation_id": prepared["operation_id"]})
    assert result["status"] == "COMMITTED"


def test_management_issue_list_revoke_and_machine_workspace_isolation(env):
    client = env["student_client"]
    root = f"/api/research/workspaces/{env['workspace'].slug}/mcp/weekly-report/"
    options = client.get(root + "options/")
    assert options.status_code == 200, options.data
    assert options.data["workspaces"][0]["ttl_days"] == [1, 7, 30, 365, None]
    issued = client.post(
        root + "connections/", {"label": "Weekly", "actions": ["submit"], "ttl_days": 1}, format="json"
    )
    assert issued.status_code == 201, issued.data
    secret = issued.data["headers"]["X-Weekly-Report-Token"]
    listing = client.get(root + "connections/")
    assert secret not in str(listing.data)
    machine = APIClient()
    machine.credentials(HTTP_X_WEEKLY_REPORT_TOKEN=secret)
    catalogue = machine.get(issued.data["mcp_path"].replace("mcp/", "tools/"))
    assert catalogue.status_code == 200, catalogue.data
    assert len(catalogue.data["tools"]) == 5
    other = machine.get("/api/research/workspaces/wrong/weekly-report-agent/tools/")
    assert other.status_code == 403
    assert machine.post(root + "connections/", {"label": "forbidden"}, format="json").status_code in (401, 403)
    revoked = client.post(root + f"connections/{issued.data['id']}/revoke/", {}, format="json")
    assert revoked.status_code == 200
    assert machine.get(issued.data["mcp_path"].replace("mcp/", "tools/")).data["error_code"] == "grant_revoked"


def test_chain_flags_do_not_disable_personal_reports_and_old_credentials_cannot_write(env, settings):
    settings.RESEARCH_MCP_ENABLED = False
    settings.RESEARCH_MCP_WRITE_ENABLED = False
    db.WorkspaceResearchSetting.objects.filter(workspace=env["workspace"]).update(research_chain_enabled=False)
    grant, _ = connection(env)
    prepared, _ = proposal(WeeklyReportService(grant=grant))
    assert prepared["status"] == "PROPOSED"
    path = f"/api/research/workspaces/{env['workspace'].slug}/weekly-report-agent/tools/"
    machine = APIClient()
    machine.credentials(HTTP_X_RESEARCH_CONTEXT_TOKEN="node-token", HTTP_X_API_KEY="old-key")
    assert machine.get(path).data["error_code"] == "weekly_grant_required"


def test_context_paging_is_complete_and_bound_to_revision(env):
    grant, _ = connection(env)
    service = WeeklyReportService(grant=grant)
    prepared, _ = proposal(service, action="save_draft", body="progress " * 5000)
    committed = service.execute("execute_weekly_report_operation", {"operation_id": prepared["operation_id"]})
    context = service.execute("get_weekly_report_context", {"period_offset": -1})
    text, page = "", context["content_page"]
    assert page["complete"] is False
    first_cursor = page["next_cursor"]
    while True:
        assert page["offset"] == len(text)
        text += page["text"]
        if page["next_cursor"] is None:
            assert page["complete"] and len(text) == page["total_chars"]
            break
        page = service.execute(
            "get_weekly_report_context", {"period_key": context["period"]["key"], "cursor": page["next_cursor"]}
        )["content_page"]
    import json

    assert json.loads(text)["report_content"]["description_stripped"] == ("progress " * 5000).rstrip()
    report = db.PeriodicReport.objects.get(pk=committed["report_id"])
    db.Page.objects.filter(pk=report.page_id).update(description_html="<p>changed</p>")
    with pytest.raises(WeeklyReportError) as error:
        service.execute("get_weekly_report_context", {"period_key": context["period"]["key"], "cursor": first_cursor})
    assert error.value.code == "report_revision_conflict"


def test_cancel_and_expiry_are_durable_and_committed_cancel_cannot_undo(env):
    from datetime import timedelta

    grant, _ = connection(env)
    service = WeeklyReportService(grant=grant)
    prepared, _ = proposal(service)
    args = {"operation_id": prepared["operation_id"]}
    assert service.execute("cancel_weekly_report_operation", args)["status"] == "CANCELLED"
    assert service.execute("execute_weekly_report_operation", args)["status"] == "CANCELLED"
    prepared, _ = proposal(service)
    operation = db.ReportAgentOperation.objects.get(pk=prepared["operation_id"])
    operation.expires_at = timezone.now() - timedelta(seconds=1)
    operation.proposal_hash = service.seal(operation)
    operation.save(update_fields=["expires_at", "proposal_hash"])
    assert service.execute("get_weekly_report_operation", {"operation_id": str(operation.pk)})["status"] == "EXPIRED"
    prepared, _ = proposal(service)
    args = {"operation_id": prepared["operation_id"]}
    result = service.execute("execute_weekly_report_operation", args)
    assert service.execute("cancel_weekly_report_operation", args)["result"] == result["result"]


@pytest.mark.parametrize("offset", [-2, 1, True])
def test_period_scope_does_not_allow_historical_future_or_boolean_offsets(env, offset):
    grant, _ = connection(env)
    service = WeeklyReportService(grant=grant)
    with pytest.raises(WeeklyReportError):
        service.execute("get_weekly_report_context", {"period_offset": offset})
    with pytest.raises(WeeklyReportError) as error:
        service.execute("get_weekly_report_context", {"period_key": "2020-W01"})
    assert error.value.code == "report_period_denied"


def test_sources_validate_current_node_access_version_hash_but_never_claim_actual_read(env):
    import hashlib
    from plane.research.services.chain_context import ResearchReadService, _json

    profile = db.ResearchProjectProfile.objects.filter(owner=env["student"]).first()
    chain = db.ResearchChain.objects.get(project=profile.project)
    node = db.ResearchChainNode.objects.create(
        chain=chain, node_type="GENERAL_RESEARCH", title="Evidence", request_id=str(uuid4()), payload_hash="test"
    )
    analysis = db.ResearchAnalysisResult.objects.create(
        workspace=env["workspace"],
        chain=chain,
        node=node,
        method="measure",
        summary="observed result",
        operator=env["student"],
        request_id=str(uuid4()),
        payload_hash="test",
    )
    reader = ResearchReadService(workspace=env["workspace"], user=env["student"])
    actual = reader.node(str(node.pk))
    content, _ = reader._content(actual, "analysis", analysis, 1)
    ref = {
        "kind": "analysis",
        "node_id": str(node.pk),
        "id": str(analysis.pk),
        "version": 1,
        "content_hash": hashlib.sha256(_json(content).encode()).hexdigest(),
    }
    grant, _ = connection(env)
    service = WeeklyReportService(grant=grant)
    _, args = proposal(service)
    args["request_id"], args["source_refs"] = str(uuid4()), [ref]
    prepared = service.execute("prepare_weekly_report_operation", args)
    source = prepared["proposal"]["source_refs"][0]
    assert source["verification"] == "visible_version_checked" and source["read_evidence"] == "declared_only"
    db.ResearchAnalysisResult.objects.filter(pk=analysis.pk).update(summary="changed")
    with pytest.raises(WeeklyReportError) as error:
        service.execute("execute_weekly_report_operation", {"operation_id": prepared["operation_id"]})
    assert error.value.code == "source_changed"
    args["request_id"] = str(uuid4())
    args["source_refs"] = [{**ref, "node_id": str(uuid4())}]
    with pytest.raises(WeeklyReportError) as error:
        service.execute("prepare_weekly_report_operation", args)
    assert error.value.code == "source_changed"


def test_session_csrf_is_required_and_listing_revocation_survive_disabled_feature(env, settings):
    from django.middleware.csrf import get_token
    from django.test import RequestFactory

    api = APIClient(enforce_csrf_checks=True)
    api.force_login(env["student"])
    root = f"/api/research/workspaces/{env['workspace'].slug}/mcp/weekly-report/"
    payload = {"label": "CSRF", "actions": ["submit"], "ttl_days": 1}
    assert api.post(root + "connections/", payload, format="json").status_code == 403
    request = RequestFactory().get("/")
    csrf = get_token(request)
    api.cookies["csrftoken"] = request.META["CSRF_COOKIE"]
    issued = api.post(root + "connections/", payload, format="json", HTTP_X_CSRFTOKEN=csrf)
    assert issued.status_code == 201, issued.data
    assert (
        api.post(
            root + "connections/", payload, format="json", HTTP_X_CSRFTOKEN=csrf, HTTP_ORIGIN="https://foreign.test"
        ).status_code
        == 403
    )
    settings.RESEARCH_WEEKLY_REPORT_MCP_ENABLED = False
    assert api.get(root + "connections/").status_code == 200
    assert (
        api.post(
            root + f"connections/{issued.data['id']}/revoke/", {}, format="json", HTTP_X_CSRFTOKEN=csrf
        ).status_code
        == 200
    )
    assert api.post(root + "connections/", payload, format="json", HTTP_X_CSRFTOKEN=csrf).status_code == 403


def test_http_rpc_and_direct_tool_use_same_catalogue_and_error_contract(env):
    _, raw = connection(env)
    api = APIClient()
    api.credentials(HTTP_X_WEEKLY_REPORT_TOKEN=raw)
    root = f"/api/research/workspaces/{env['workspace'].slug}/weekly-report-agent/"

    def rpc(method, params=None):
        return api.post(
            root + "mcp/", {"jsonrpc": "2.0", "id": 1, "method": method, "params": params or {}}, format="json"
        )

    assert rpc("initialize").data["result"]["serverInfo"]["name"] == "plane-weekly-report"
    assert rpc("tools/list").data["result"]["tools"] == api.get(root + "tools/").data["tools"]
    name = "get_weekly_report_context"
    response = rpc("tools/call", {"name": name, "arguments": {"period_offset": -1}})
    assert response.data["result"]["isError"] is False
    direct = api.post(root + f"tools/{name}/", {"owner": str(env["admin"].pk)}, format="json")
    through_rpc = rpc("tools/call", {"name": name, "arguments": {"owner": str(env["admin"].pk)}})
    assert direct.data == through_rpc.data["result"]["structuredContent"]
    assert through_rpc.data["result"]["isError"] is True
    assert through_rpc["Cache-Control"] == "no-store"


@pytest.mark.django_db(transaction=True)
@pytest.mark.parametrize("existing_draft", [False, True])
@pytest.mark.parametrize("same_operation", [False, True])
def test_two_agents_competing_for_report_or_repeating_operation_commit_only_once(env, existing_draft, same_operation):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Barrier
    from django.db import close_old_connections

    grant, _ = connection(env)
    service = WeeklyReportService(grant=grant)
    if existing_draft:
        prepared, _ = proposal(service, action="save_draft")
        service.execute("execute_weekly_report_operation", {"operation_id": prepared["operation_id"]})
    context = service.execute("get_weekly_report_context", {"period_offset": -1})
    first, _ = proposal(service, context=context)
    second, _ = proposal(service, context=context)
    barrier = Barrier(2)

    def execute(identity):
        close_old_connections()
        try:
            local = WeeklyReportService(
                grant=db.ReportAgentGrant.objects.select_related("user", "workspace").get(pk=grant.pk)
            )
            barrier.wait(timeout=10)
            try:
                return local.execute("execute_weekly_report_operation", {"operation_id": identity})["status"]
            except WeeklyReportError as exc:
                return exc.code
        finally:
            close_old_connections()

    with ThreadPoolExecutor(max_workers=2) as executor:
        outcomes = list(
            executor.map(
                execute, [first["operation_id"], first["operation_id"] if same_operation else second["operation_id"]]
            )
        )
    assert sorted(outcomes) == (
        ["COMMITTED", "COMMITTED"] if same_operation else ["COMMITTED", "report_revision_conflict"]
    )
    assert (
        db.PeriodicReport.objects.filter(workspace=env["workspace"], period_key=context["period"]["key"]).count() == 1
    )
    assert db.PeriodicReportSnapshot.objects.filter(report__workspace=env["workspace"]).count() == 1
    assert db.ReportReviewLog.objects.filter(report__workspace=env["workspace"], action="SUBMIT").count() == 1


@pytest.mark.django_db(transaction=True)
def test_legacy_page_write_in_progress_finishes_before_final_revision_check(env):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Event
    from django.db import close_old_connections, transaction

    grant, _ = connection(env)
    service = WeeklyReportService(grant=grant)
    draft, _ = proposal(service, action="save_draft")
    saved = service.execute("execute_weekly_report_operation", {"operation_id": draft["operation_id"]})
    prepared, _ = proposal(service)
    report = db.PeriodicReport.objects.get(pk=saved["report_id"])
    editing, finish = Event(), Event()

    def legacy_edit():
        close_old_connections()
        try:
            with transaction.atomic():
                db.Page.objects.filter(pk=report.page_id).update(description_html="<p>concurrent web body</p>")
                editing.set()
                assert finish.wait(timeout=10)
        finally:
            close_old_connections()

    def execute():
        close_old_connections()
        try:
            local = WeeklyReportService(
                grant=db.ReportAgentGrant.objects.select_related("workspace", "user").get(pk=grant.pk)
            )
            with pytest.raises(WeeklyReportError) as error:
                local.execute("execute_weekly_report_operation", {"operation_id": prepared["operation_id"]})
            return error.value.code
        finally:
            close_old_connections()

    with ThreadPoolExecutor(max_workers=2) as pool:
        writer = pool.submit(legacy_edit)
        assert editing.wait(timeout=10)
        submitter = pool.submit(execute)
        finish.set()
        writer.result(timeout=15)
        assert submitter.result(timeout=15) == "report_revision_conflict"
    assert db.Page.objects.get(pk=report.page_id).description_html == "<p>concurrent web body</p>"
    assert not db.PeriodicReportSnapshot.objects.filter(report=report).exists()


def test_commit_result_storage_failure_rolls_back_all_business_writes_and_is_retryable(env):
    from django.db import DatabaseError

    grant, _ = connection(env)
    service = WeeklyReportService(grant=grant)
    prepared, _ = proposal(service)
    original = db.ReportAgentOperation.save

    def fail_commit(instance, *args, **kwargs):
        if instance.status == "COMMITTED":
            raise DatabaseError("result storage unavailable")
        return original(instance, *args, **kwargs)

    page_count = db.Page.objects.count()
    with patch.object(db.ReportAgentOperation, "save", fail_commit):
        with pytest.raises(WeeklyReportError) as error:
            service.execute("execute_weekly_report_operation", {"operation_id": prepared["operation_id"]})
    assert error.value.code == "temporarily_unavailable" and error.value.data()["retryable"]
    assert db.Page.objects.count() == page_count and not db.Notification.objects.exists()
    assert db.ReportAgentOperation.objects.get(pk=prepared["operation_id"]).status == "PROPOSED"
    assert (
        service.execute("execute_weekly_report_operation", {"operation_id": prepared["operation_id"]})["status"]
        == "COMMITTED"
    )


def test_connection_pagination_candidate_workspace_and_scope_binding(env):
    from datetime import timedelta

    client = env["student_client"]
    root = f"/api/research/workspaces/{env['workspace'].slug}/mcp/weekly-report/"
    db.ReportAgentGrant.objects.bulk_create(
        [
            db.ReportAgentGrant(
                workspace=env["workspace"],
                user=env["student"],
                label=f"Expired {i}",
                token_hash=uuid4().hex * 2,
                expires_at=timezone.now() - timedelta(days=1),
            )
            for i in range(31)
        ]
    )
    first = client.get(root + "connections/").data
    assert len(first["results"]) == 30 and first["next_cursor"]
    second = client.get(root + "connections/", {"cursor": first["next_cursor"]}).data
    assert len(second["results"]) == 1 and second["next_cursor"] is None
    assert len({r["id"] for r in first["results"] + second["results"]}) == 31
    denied = env["colleague_client"].get(root + "connections/", {"cursor": first["next_cursor"]})
    assert denied.status_code == 400 and denied.data["error_code"] == "invalid_cursor"
    candidates = client.get("/api/research/mcp/weekly-report/options/")
    assert candidates.status_code == 200, candidates.data
    assert [w["slug"] for w in candidates.data["workspaces"]] == [env["workspace"].slug]


def test_workspace_report_timezone_resolves_iso_boundary_and_template_variables(env):
    from datetime import date, datetime, timezone as dt_timezone

    # Keep fixture memberships valid at the fixed ISO-boundary date even when
    # this test runs days later; do not weaken the live authorization checks.
    db.OrgUnitMember.objects.filter(workspace=env["workspace"]).update(effective_from=date(2026, 10, 1))
    db.MentorBinding.objects.filter(workspace=env["workspace"]).update(effective_from=date(2026, 10, 1))

    db.WorkspaceResearchSetting.objects.filter(workspace=env["workspace"]).update(timezone="Asia/Shanghai")
    db.ReportTemplate.objects.create(
        workspace=env["workspace"],
        name="Weekly variables",
        report_type="WEEKLY",
        is_default=True,
        content_json={
            "type": "doc",
            "content": [{"type": "paragraph", "content": [{"type": "text", "text": "{{user}} {{period}}"}]}],
        },
    )
    with patch(
        "plane.research.utils.periods.django_timezone.now",
        return_value=datetime(2026, 10, 25, 16, 30, tzinfo=dt_timezone.utc),
    ):
        grant, _ = connection(env)
        service = WeeklyReportService(grant=grant)
        context = service.execute("get_weekly_report_context", {"period_offset": -1})
        assert context["period"] == {
            "report_type": "WEEKLY",
            "key": "2026-W43",
            "start": "2026-10-19",
            "end": "2026-10-25",
            "timezone": "Asia/Shanghai",
        }
        assert not context["template"]["is_fallback"]
        assert "2026-W43" in context["content_page"]["text"] and "{{user}}" not in context["content_page"]["text"]
        db.WorkspaceResearchSetting.objects.filter(workspace=env["workspace"]).update(timezone="America/New_York")
        assert service.execute("get_weekly_report_context", {"period_offset": -1})["period"]["key"] == "2026-W42"


def test_invalid_workspace_timezone_is_rejected_instead_of_using_host_timezone(env):
    db.WorkspaceResearchSetting.objects.filter(workspace=env["workspace"]).update(timezone="Invalid/Timezone")
    with pytest.raises(WeeklyReportError) as error:
        connection(env)
    assert error.value.code == "policy_changed" and not db.ReportAgentGrant.objects.exists()


def test_shared_workflow_business_error_is_rolled_back_then_durably_rejected(env):
    from plane.research.services.report_workflow import ReportWorkflowError

    grant, _ = connection(env)
    service = WeeklyReportService(grant=grant)
    prepared, _ = proposal(service)
    page_count = db.Page.objects.count()
    with patch(
        "plane.research.services.report_workflow.submit_report",
        side_effect=ReportWorkflowError("report_state_conflict", "Business rule rejected", 409),
    ):
        with pytest.raises(WeeklyReportError) as error:
            service.execute("execute_weekly_report_operation", {"operation_id": prepared["operation_id"]})
    assert error.value.code == "report_state_conflict" and str(error.value.operation_id) == prepared["operation_id"]
    operation = service.execute("get_weekly_report_operation", {"operation_id": prepared["operation_id"]})
    assert operation["status"] == "REJECTED" and operation["result"] is None
    assert db.Page.objects.count() == page_count


def test_submit_proposal_requires_a_reviewer_when_approval_group_is_empty(env):
    db.MentorBinding.objects.filter(workspace=env["workspace"]).delete()
    grant, _ = connection(env)
    service = WeeklyReportService(grant=grant)
    context = service.execute("get_weekly_report_context", {"period_offset": -1})
    assert context["approval"]["candidates"] == []
    assert context["approval"]["default_reviewer_id"] is None

    with pytest.raises(WeeklyReportError) as error:
        proposal(service)

    assert error.value.code == "invalid_arguments"
    assert not db.ReportAgentOperation.objects.exists()


def test_approval_route_change_invalidates_prepared_submission(env):
    grant, _ = connection(env)
    service = WeeklyReportService(grant=grant)
    context = service.execute("get_weekly_report_context", {"period_offset": -1})
    prepared, _ = proposal(service, context=context)
    db.ResearchApprovalRoute.objects.create(
        workspace=env["workspace"],
        resource_type="PERIODIC_REPORT",
        resource_id=uuid4(),
        submitted_by=env["student"],
        reviewer=env["advisor"],
        reviewer_role="PRIMARY_ADVISOR",
        request_id=f"concurrent-route-{uuid4()}",
    )

    with pytest.raises(WeeklyReportError) as error:
        service.execute("execute_weekly_report_operation", {"operation_id": prepared["operation_id"]})

    assert error.value.code == "report_revision_conflict"
    operation = db.ReportAgentOperation.objects.get(pk=prepared["operation_id"])
    assert operation.status == "REJECTED"
    assert not db.PeriodicReport.objects.filter(
        workspace=env["workspace"], period_key=context["period"]["key"]
    ).exists()


def test_web_withdraw_then_mcp_resubmit_preserves_original_commit(env):
    grant, _ = connection(env)
    service = WeeklyReportService(grant=grant)
    first_proposal, _ = proposal(service, body="## 本周完成\n\n原正式版本。")
    first_commit = service.execute("execute_weekly_report_operation", {"operation_id": first_proposal["operation_id"]})
    report_url = f"{env['url']}{first_commit['report_id']}/"
    first_snapshot = db.PeriodicReportSnapshot.objects.get(report_id=first_commit["report_id"], version_no=1)
    first_body = first_snapshot.description_json

    withdrawn = env["student_client"].post(f"{report_url}withdraw/", {"comment": "补充 MCP 联调结果"}, format="json")
    assert withdrawn.status_code == 200
    assert withdrawn.json()["status"] == "DRAFT"
    assert withdrawn.json()["submitted_at"] is None

    second_proposal, _ = proposal(service, body="## 本周完成\n\n撤回后补充结果。")
    second_commit = service.execute(
        "execute_weekly_report_operation", {"operation_id": second_proposal["operation_id"]}
    )
    assert second_commit["result"]["snapshot_version"] == 2
    first_snapshot.refresh_from_db()
    assert first_snapshot.description_json == first_body
    notification_count = db.Notification.objects.filter(entity_identifier=first_commit["report_id"]).count()
    repeated = service.execute("execute_weekly_report_operation", {"operation_id": first_proposal["operation_id"]})
    assert repeated["result"] == first_commit["result"]
    assert repeated["readback"] == "verified"
    assert db.PeriodicReportSnapshot.objects.filter(report_id=first_commit["report_id"]).count() == 2
    assert db.Notification.objects.filter(entity_identifier=first_commit["report_id"]).count() == notification_count


@pytest.mark.parametrize("restore", [False, True])
def test_web_delete_and_restore_invalidate_mcp_proposal_and_keep_list_scopes(env, restore):
    grant, _ = connection(env)
    service = WeeklyReportService(grant=grant)
    drafted, _ = proposal(service, action="save_draft")
    draft = service.execute("execute_weekly_report_operation", {"operation_id": drafted["operation_id"]})
    stale, _ = proposal(service, action="save_draft", body="旧提案不得覆盖。")
    report_id = draft["report_id"]
    report_url = f"{env['url']}{report_id}/"

    assert env["student_client"].get(env["url"]).json()["count"] == 1
    assert env["student_client"].delete(report_url).status_code == 204
    assert env["student_client"].get(env["url"]).json()["count"] == 0
    deleted = env["student_client"].get(env["url"], {"scope": "deleted"})
    assert deleted.status_code == 200
    assert [item["id"] for item in deleted.json()["results"]] == [report_id]
    assert service.execute("get_weekly_report_context", {"period_offset": -1})["report"] is None

    if restore:
        restored = env["student_client"].post(f"{report_url}restore/", {}, format="json")
        assert restored.status_code == 200
        assert restored.json()["id"] == report_id
        assert env["student_client"].get(env["url"]).json()["count"] == 1
        assert env["student_client"].get(env["url"], {"scope": "deleted"}).json()["count"] == 0

    with pytest.raises(WeeklyReportError) as error:
        service.execute("execute_weekly_report_operation", {"operation_id": stale["operation_id"]})
    assert error.value.code == "report_revision_conflict"
    assert not db.PeriodicReportSnapshot.objects.filter(report_id=report_id).exists()
    if restore:
        fresh, _ = proposal(service, action="save_draft", body="恢复后重新读取并保存。")
        saved = service.execute("execute_weekly_report_operation", {"operation_id": fresh["operation_id"]})
        assert saved["report_id"] == report_id


def test_web_submit_and_withdraw_does_not_make_old_draft_proposal_valid_again(env):
    grant, _ = connection(env)
    service = WeeklyReportService(grant=grant)
    drafted, _ = proposal(service, action="save_draft")
    draft = service.execute("execute_weekly_report_operation", {"operation_id": drafted["operation_id"]})
    stale, _ = proposal(service, action="save_draft", body="提交撤回前的旧提案。")
    report_url = f"{env['url']}{draft['report_id']}/"
    assert (
        env["student_client"]
        .post(
            f"{report_url}submit/",
            {"reviewer_id": str(env["advisor"].pk), "cc_user_ids": []},
            format="json",
        )
        .status_code
        == 200
    )
    assert env["student_client"].post(f"{report_url}withdraw/", {}, format="json").status_code == 200
    with pytest.raises(WeeklyReportError) as error:
        service.execute("execute_weekly_report_operation", {"operation_id": stale["operation_id"]})
    assert error.value.code == "report_revision_conflict"
    report = db.PeriodicReport.objects.get(pk=draft["report_id"])
    assert report.status == "DRAFT"
    assert "旧提案" not in report.page.description_stripped
    assert report.official_snapshots.count() == 1
