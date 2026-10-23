# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details

from datetime import timedelta
from uuid import uuid4

import pytest
from django.utils import timezone
from rest_framework.test import APIClient

from plane.db.models import (
    MentorBinding,
    Notification,
    OrgUnit,
    OrgUnitMember,
    Page,
    PeriodicReportComment,
    PeriodicReportCommentFeedback,
    ResearchAuditEvent,
)
from plane.research.services.chain_context import ResearchReadService
from plane.tests.research_fixtures import add_workspace_member, enable_research, make_user, make_workspace

pytestmark = pytest.mark.contract


DOCUMENT = {
    "type": "doc",
    "content": [
        {
            "type": "paragraph",
            "attrs": {"id": "block-method"},
            "content": [{"type": "text", "text": "本周完成催化剂活性实验，结果稳定。"}],
        }
    ],
}


def client_for(user):
    client = APIClient()
    client.force_authenticate(user=user)
    return client


def create_unit(workspace, name, parent=None, unit_type=OrgUnit.UnitType.GROUP):
    unit = OrgUnit.objects.create(
        workspace=workspace,
        name=name,
        parent=parent,
        unit_type=unit_type,
        depth=(parent.depth + 1) if parent else 0,
        path="",
    )
    unit.path = (parent.path if parent else "/") + str(unit.id).replace("-", "") + "/"
    unit.save(update_fields=["path"])
    return unit


@pytest.fixture
def env(db, settings):
    settings.RESEARCH_MODULE_ENABLED = True
    admin = make_user(first_name="Admin")
    workspace = make_workspace(admin)
    enable_research(workspace)
    student = make_user(first_name="Student", email="report-student@example.com")
    advisor = make_user(first_name="Advisor", email="report-advisor@example.com")
    colleague = make_user(first_name="Colleague", email="report-colleague@example.com")
    for user in (student, advisor, colleague):
        add_workspace_member(workspace, user)

    root = create_unit(workspace, "Root", None, OrgUnit.UnitType.ROOT)
    group = create_unit(workspace, "Group", root)
    OrgUnitMember.objects.create(
        workspace=workspace,
        org_unit=group,
        user=student,
        org_role=OrgUnitMember.OrgRole.OWNER,
        is_primary=True,
    )
    OrgUnitMember.objects.create(
        workspace=workspace,
        org_unit=group,
        user=advisor,
        org_role=OrgUnitMember.OrgRole.ADVISOR,
    )
    MentorBinding.objects.create(
        workspace=workspace,
        org_unit=group,
        mentee=student,
        mentor=advisor,
        is_primary_advisor=True,
    )
    OrgUnitMember.objects.create(
        workspace=workspace,
        org_unit=group,
        user=colleague,
        org_role=OrgUnitMember.OrgRole.REVIEWER,
    )

    student_client = client_for(student)
    student_client.post(
        f"/api/research/workspaces/{workspace.slug}/projects/",
        {"org_unit": str(group.id), "research_type": "PHD"},
        format="json",
    )
    return {
        "workspace": workspace,
        "student": student,
        "advisor": advisor,
        "colleague": colleague,
        "student_client": student_client,
        "advisor_client": client_for(advisor),
        "colleague_client": client_for(colleague),
    }


def make_report(env, *, anchorless=False):
    created = env["student_client"].post(
        f"/api/research/workspaces/{env['workspace'].slug}/reports/",
        {"report_type": "WEEKLY", "period_key": f"2026-W{uuid4().int % 40 + 10:02d}"},
        format="json",
    )
    assert created.status_code == 201, created.data
    report = created.json()
    page = Page.objects.get(pk=report["page"])
    page.description_json = DOCUMENT
    page.description_html = "<p>本周完成催化剂活性实验，结果稳定。</p>"
    page.description_stripped = "本周完成催化剂活性实验，结果稳定。"
    page.save(update_fields=["description_json", "description_html", "description_stripped", "updated_at"])
    submitted = env["student_client"].post(
        f"/api/research/workspaces/{env['workspace'].slug}/reports/{report['id']}/submit/",
        {},
        format="json",
    )
    assert submitted.status_code == 200, submitted.data
    return submitted.json()


def valid_anchor():
    return {
        "version": 1,
        "block_id": "block-method",
        "block_type": "paragraph",
        "selected_text": "催化剂活性实验",
        "prefix": "本周完成",
        "suffix": "，结果稳定",
        "start_offset": 4,
        "end_offset": 11,
    }


def threads_url(env, report_id):
    return f"/api/research/workspaces/{env['workspace'].slug}/reports/{report_id}/comment-threads/"


def create_thread(env, report, client=None, **overrides):
    payload = {
        "anchor": valid_anchor(),
        "comment_html": "<p>请补充重复实验次数。</p>",
        "request_id": uuid4().hex,
        **overrides,
    }
    return (client or env["advisor_client"]).post(threads_url(env, report["id"]), payload, format="json")


def test_visible_reader_can_anchor_comment_reply_and_reload(env):
    report = make_report(env)
    created = create_thread(env, report)
    assert created.status_code == 201, created.data
    thread = created.json()
    assert thread["quoted_text"] == "催化剂活性实验"
    assert thread["snapshot_version"] == report["latest_official_version"]
    assert thread["comments"][0]["actor"] == str(env["advisor"].id)
    assert thread["comments"][0]["can_edit"] is True

    reply = env["student_client"].post(
        f"{threads_url(env, report['id'])}{thread['id']}/comments/",
        {
            "comment_html": "<p>已补充三次重复实验。</p>",
            "parent": thread["comments"][0]["id"],
            "request_id": uuid4().hex,
        },
        format="json",
    )
    assert reply.status_code == 201, reply.data

    reloaded = env["advisor_client"].get(threads_url(env, report["id"]), {"status": "ALL"}).json()
    assert reloaded["can_comment"] is True
    assert reloaded["count"] == 1
    assert [item["feedback_type"] for item in reloaded["results"][0]["comments"]] == ["DISCUSSION", "DISCUSSION"]
    assert Notification.objects.filter(entity_name="research_report", receiver=env["student"]).exists()
    edited = env["advisor_client"].patch(
        f"/api/research/workspaces/{env['workspace'].slug}/reports/{report['id']}/comments/{thread['comments'][0]['id']}/",
        {"comment_html": "<p><strong>请补充方差分析。</strong></p>"},
        format="json",
    )
    assert edited.status_code == 200
    assert edited.json()["comment_stripped"] == "请补充方差分析。"
    actions = set(
        ResearchAuditEvent.objects.filter(resource_id=thread["comments"][0]["id"]).values_list("action", flat=True)
    )
    assert "report.comment.create" in actions


def test_comment_request_id_is_idempotent(env):
    report = make_report(env)
    request_id = uuid4().hex
    first = create_thread(env, report, request_id=request_id)
    retry = create_thread(env, report, request_id=request_id)

    assert first.status_code == 201
    assert retry.status_code == 200
    assert retry.json()["id"] == first.json()["id"]
    assert PeriodicReportComment.objects.filter(thread__report_id=report["id"]).count() == 1


def test_new_comments_use_generic_discussion_and_legacy_types_stay_read_only(env):
    report = make_report(env)
    explicit = create_thread(env, report, feedback_type="DISCUSSION")
    assert explicit.status_code == 201
    assert explicit.json()["comments"][0]["feedback_type"] == "DISCUSSION"

    rejected = create_thread(env, report, feedback_type="SUGGESTION")
    assert rejected.status_code == 400
    assert rejected.json()["error_code"] == "report_comment_invalid"

    thread = explicit.json()
    rejected_reply = env["student_client"].post(
        f"{threads_url(env, report['id'])}{thread['id']}/comments/",
        {
            "comment_html": "<p>尝试写入人工认可。</p>",
            "feedback_type": "APPROVAL",
            "parent": thread["comments"][0]["id"],
            "request_id": uuid4().hex,
        },
        format="json",
    )
    assert rejected_reply.status_code == 400
    assert rejected_reply.json()["error_code"] == "report_comment_invalid"

    root = PeriodicReportComment.objects.get(pk=thread["comments"][0]["id"])
    legacy = PeriodicReportComment.objects.create(
        thread=root.thread,
        actor=env["advisor"],
        comment_html="<p>历史修改建议。</p>",
        comment_stripped="历史修改建议。",
        feedback_type=PeriodicReportComment.FeedbackType.SUGGESTION,
        request_id=uuid4().hex,
        created_by=env["advisor"],
    )
    reloaded = env["student_client"].get(threads_url(env, report["id"]), {"status": "ALL"}).json()
    assert {item["feedback_type"] for item in reloaded["results"][0]["comments"]} == {"DISCUSSION", "SUGGESTION"}

    detail = f"/api/research/workspaces/{env['workspace'].slug}/reports/{report['id']}/comments/{legacy.id}/"
    rejected_patch = env["advisor_client"].patch(detail, {"feedback_type": "CORRECTION"}, format="json")
    assert rejected_patch.status_code == 400
    assert rejected_patch.json()["error_code"] == "report_comment_invalid"

    no_op_patch = env["advisor_client"].patch(detail, {"feedback_type": "DISCUSSION"}, format="json")
    assert no_op_patch.status_code == 200
    legacy.refresh_from_db()
    assert legacy.feedback_type == PeriodicReportComment.FeedbackType.SUGGESTION


def test_unauthorized_workspace_member_cannot_read_or_comment(env):
    report = make_report(env)
    response = env["colleague_client"].get(threads_url(env, report["id"]))
    posted = create_thread(env, report, client=env["colleague_client"])

    assert response.status_code == 404
    assert posted.status_code == 404


def test_comment_author_boundary_invalid_anchor_and_xss_are_rejected(env):
    report = make_report(env)
    created = create_thread(env, report)
    comment = created.json()["comments"][0]
    detail = f"/api/research/workspaces/{env['workspace'].slug}/reports/{report['id']}/comments/{comment['id']}/"

    assert env["student_client"].patch(detail, {"comment_html": "<p>Changed</p>"}, format="json").status_code == 403
    assert env["student_client"].delete(detail).status_code == 403
    invalid = create_thread(env, report, anchor={**valid_anchor(), "selected_text": "不存在"})
    assert invalid.status_code == 422
    assert invalid.json()["error_code"] == "report_comment_anchor_invalid"
    malicious = create_thread(env, report, comment_html="<p onclick='x()'>Bad<script>x()</script></p>")
    assert malicious.status_code == 201
    assert "onclick" not in malicious.json()["comments"][0]["comment_html"]
    assert "script" not in malicious.json()["comments"][0]["comment_html"]


def test_thread_can_be_resolved_and_reopened_by_authorized_users(env):
    report = make_report(env)
    thread = create_thread(env, report).json()
    status_url = f"{threads_url(env, report['id'])}{thread['id']}/status/"

    resolved = env["advisor_client"].post(status_url, {"status": "RESOLVED"}, format="json")
    assert resolved.status_code == 200
    assert resolved.json()["status"] == "RESOLVED"
    reopened = env["student_client"].post(status_url, {"status": "OPEN"}, format="json")
    assert reopened.status_code == 200
    assert reopened.json()["status"] == "OPEN"


def test_explicit_ai_feedback_is_scoped_and_ordinary_discussion_stays_private(env):
    report = make_report(env)
    explicit = create_thread(env, report).json()
    explicit_comment = explicit["comments"][0]
    ordinary = create_thread(
        env,
        report,
        client=env["student_client"],
        comment_html="<p>这是普通讨论，不是人工审核结论。</p>",
        feedback_type="DISCUSSION",
    ).json()

    submitted = env["advisor_client"].post(
        f"/api/research/workspaces/{env['workspace'].slug}/reports/{report['id']}/comments/{explicit_comment['id']}/ai-feedback/",
        {},
        format="json",
    )
    assert submitted.status_code == 201, submitted.data
    feedback = PeriodicReportCommentFeedback.objects.get(pk=submitted.json()["id"])
    assert feedback.payload["quote"]["text"] == "催化剂活性实验"
    assert feedback.payload["report"]["snapshot_version"] == report["latest_official_version"]
    assert feedback.payload["report"]["source_url"].endswith(f"/research/reports/{report['id']}/")

    class Grant:
        pass

    grant = Grant()
    grant.allowed_reports = [{"report_id": str(report["id"]), "version_no": report["latest_official_version"]}]
    grant.workspace_id = env["workspace"].id
    grant.user_id = env["advisor"].id
    grant.revoked_at = None
    grant.expires_at = timezone.now() + timedelta(minutes=5)
    grant.context_id = uuid4()
    grant.policy_hash = "test-policy"
    grant.chain_node_id = None
    service = ResearchReadService(workspace=env["workspace"], user=env["advisor"], grant=grant)
    result = service.list_research_report_feedback()
    assert [item["comment_id"] for item in result["data"]] == [str(explicit_comment["id"])]
    assert str(ordinary["id"]) not in [item["thread_id"] for item in result["data"]]

    grant.allowed_reports = [{"report_id": str(report["id"]), "version_no": 999}]
    service = ResearchReadService(workspace=env["workspace"], user=env["advisor"], grant=grant)
    assert service.list_research_report_feedback()["data"] == []


def test_deleted_comment_withdraws_its_explicit_ai_feedback(env):
    report = make_report(env)
    thread = create_thread(env, report).json()
    comment = thread["comments"][0]
    feedback_url = (
        f"/api/research/workspaces/{env['workspace'].slug}/reports/{report['id']}/comments/{comment['id']}/ai-feedback/"
    )
    assert env["advisor_client"].post(feedback_url, {}, format="json").status_code == 201

    detail = f"/api/research/workspaces/{env['workspace'].slug}/reports/{report['id']}/comments/{comment['id']}/"
    assert env["advisor_client"].delete(detail).status_code == 204
    feedback = PeriodicReportCommentFeedback.objects.get(comment_id=comment["id"])
    assert feedback.status == PeriodicReportCommentFeedback.Status.WITHDRAWN
