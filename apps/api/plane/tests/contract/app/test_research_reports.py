# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from threading import Barrier
from time import sleep
from unittest.mock import patch

import pytest
from django.db import close_old_connections
from django.utils import timezone
from rest_framework.test import APIClient

from plane.db.models import (
    FileAsset,
    MentorBinding,
    Notification,
    OrgUnit,
    OrgUnitMember,
    Page,
    PeriodicReport,
    PeriodicReportReadReceipt,
    PeriodicReportProjectReference,
    PeriodicReportSnapshot,
    Project,
    ProjectPage,
    ReportAccessGrant,
    ReportAttachment,
    ReportReviewLog,
    ResearchAuditEvent,
    ReportTemplate,
    WorkspaceResearchSetting,
)
from plane.tests.research_fixtures import (
    add_workspace_member,
    enable_research,
    make_user,
    make_workspace,
)

pytestmark = pytest.mark.contract


@pytest.fixture(autouse=True)
def research_module_on(settings):
    settings.RESEARCH_MODULE_ENABLED = True


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
def env(db):
    admin = make_user(first_name="Admin")
    workspace = make_workspace(admin)
    enable_research(workspace)
    student = make_user(first_name="Student", email="student@example.com")
    advisor = make_user(first_name="Advisor", email="advisor@example.com")
    colleague = make_user(first_name="Colleague", email="colleague@example.com")
    for user in (student, advisor, colleague):
        add_workspace_member(workspace, user)

    root = create_unit(workspace, "Root", None, OrgUnit.UnitType.ROOT)
    group = create_unit(workspace, "Group", root, OrgUnit.UnitType.GROUP)
    OrgUnitMember.objects.create(
        workspace=workspace,
        org_unit=group,
        user=student,
        org_role=OrgUnitMember.OrgRole.OWNER,
        is_primary=True,
    )
    OrgUnitMember.objects.create(
        workspace=workspace, org_unit=group, user=advisor, org_role=OrgUnitMember.OrgRole.ADVISOR
    )
    MentorBinding.objects.create(
        workspace=workspace,
        org_unit=group,
        mentee=student,
        mentor=advisor,
        is_primary_advisor=True,
    )
    OrgUnitMember.objects.create(
        workspace=workspace, org_unit=group, user=colleague, org_role=OrgUnitMember.OrgRole.REVIEWER
    )

    student_client = client_for(student)
    # every research owner needs an active project before creating reports
    student_client.post(
        f"/api/research/workspaces/{workspace.slug}/projects/",
        {"org_unit": str(group.id), "research_type": "PHD"},
        format="json",
    )
    return {
        "admin": admin,
        "student": student,
        "advisor": advisor,
        "colleague": colleague,
        "workspace": workspace,
        "root": root,
        "group": group,
        "admin_client": client_for(admin),
        "student_client": student_client,
        "advisor_client": client_for(advisor),
        "colleague_client": client_for(colleague),
        "url": f"/api/research/workspaces/{workspace.slug}/reports/",
    }


def create_report(env, **payload):
    return env["student_client"].post(
        env["url"],
        {"report_type": "WEEKLY", "period_key": "2026-W38", **payload},
        format="json",
    )


@pytest.mark.django_db
class TestReportCreation:
    def test_create_weekly_report_with_period_metadata(self, env):
        iso = timezone.localdate().isocalendar()
        period_key = f"{iso.year}-W{iso.week:02d}"
        response = create_report(env, period_key=period_key)
        assert response.status_code == 201
        payload = response.json()
        assert payload["period_start"] == str(timezone.localdate() - timedelta(days=timezone.localdate().weekday()))
        assert payload["period_end"] == str(timezone.localdate() + timedelta(days=6 - timezone.localdate().weekday()))
        assert payload["status"] == "DRAFT"
        assert payload["visibility"] == "WORKSPACE"
        assert payload["is_backfill"] is False
        assert Page.objects.filter(pk=payload["page"]).exists()

    def test_created_report_returns_template_draft_content(self, env):
        template = ReportTemplate.objects.create(
            workspace=env["workspace"],
            report_type="WEEKLY",
            name="Browser weekly template",
            content_json={
                "type": "doc",
                "content": [
                    {
                        "type": "paragraph",
                        "content": [{"type": "text", "text": "Browser evidence template"}],
                    }
                ],
            },
            created_by=env["admin"],
        )

        response = create_report(env, period_key="2026-W15", template=str(template.id))

        assert response.status_code == 201
        assert response.json()["draft_content"]["description_json"] == template.content_json

    def test_default_template_is_loaded_and_linked_without_explicit_selection(self, env):
        template = ReportTemplate.objects.create(
            workspace=env["workspace"],
            report_type="WEEKLY",
            name="Default weekly framework",
            is_default=True,
            sections_json={
                "version": 1,
                "guidance": "按框架填写。",
                "sections": [
                    {
                        "id": "progress",
                        "title": "本周进展",
                        "guidance": "请填写本周进展。",
                        "required": True,
                    }
                ],
            },
            created_by=env["admin"],
        )

        response = create_report(env, period_key="2026-W16")

        assert response.status_code == 201
        payload = response.json()
        assert payload["template"] == str(template.id)
        assert payload["template_detail"]["name"] == "Default weekly framework"
        assert payload["template_detail"]["sections_json"]["sections"][0]["id"] == "progress"
        headings = [
            node for node in payload["draft_content"]["description_json"]["content"] if node.get("type") == "heading"
        ]
        assert headings[0]["attrs"]["id"] == "progress"

    def test_stage_material_template_cannot_be_used_for_periodic_report(self, env):
        template = ReportTemplate.objects.create(
            workspace=env["workspace"],
            report_type="WEEKLY",
            name="Pre-opening framework",
            scope=ReportTemplate.Scope.STAGE_MATERIAL,
            stage="PRE_OPENING",
            material_type="TOPIC_DESCRIPTION",
            created_by=env["admin"],
        )

        response = create_report(env, period_key="2026-W17", template=str(template.id))

        assert response.status_code == 400
        assert response.json()["error_code"] == "report_template_not_found"

    def test_historical_period_is_marked_as_backfill(self, env):
        response = create_report(env, period_key="2026-W10")
        assert response.status_code == 201
        assert response.json()["is_backfill"] is True

    def test_duplicate_period_is_rejected(self, env):
        assert create_report(env).status_code == 201
        duplicate = create_report(env)
        assert duplicate.status_code == 409
        assert duplicate.json()["error_code"] == "report_period_conflict"

    def test_monthly_report_uses_natural_month(self, env):
        response = create_report(env, report_type="MONTHLY", period_key="2026-09")
        assert response.status_code == 201
        assert response.json()["period_start"] == "2026-09-01"
        assert response.json()["period_end"] == "2026-09-30"

    def test_invalid_period_is_rejected(self, env):
        response = create_report(env, period_key="2026-99")
        assert response.status_code == 400

    def test_visibility_cannot_exceed_the_default(self, env):
        WorkspaceResearchSetting.objects.filter(workspace=env["workspace"]).update(
            weekly_default_visibility="DIRECT_ADVISOR"
        )
        response = create_report(env, visibility="WORKSPACE")
        assert response.status_code == 422
        assert response.json()["error_code"] == "report_visibility_exceeds_default"

    def test_visibility_can_be_narrowed(self, env):
        response = create_report(env, visibility="PRIVATE")
        assert response.status_code == 201
        assert response.json()["visibility"] == "PRIVATE"

    def test_creation_requires_an_effective_primary_org_assignment(self, env):
        # the admin has neither a cultivation project nor a primary org assignment
        response = env["admin_client"].post(
            env["url"], {"report_type": "WEEKLY", "period_key": "2026-W39"}, format="json"
        )
        assert response.status_code == 400
        assert response.json()["error_code"] == "research_project_not_found"

    def test_primary_org_member_can_create_and_edit_a_report_without_any_project(self, env):
        member = make_user(first_name="Standalone", email="standalone@example.com")
        add_workspace_member(env["workspace"], member)
        OrgUnitMember.objects.create(
            workspace=env["workspace"],
            org_unit=env["group"],
            user=member,
            org_role=OrgUnitMember.OrgRole.REVIEWER,
            is_primary=True,
        )
        client = client_for(member)

        created = client.post(
            env["url"],
            {"report_type": "WEEKLY", "period_key": "2026-W39"},
            format="json",
        )

        assert created.status_code == 201
        payload = created.json()
        assert payload["project"] is None
        assert payload["page_project"] is None
        assert payload["org_unit"] == str(env["group"].id)
        page = Page.objects.get(pk=payload["page"])
        assert page.project_pages.filter(deleted_at__isnull=True).count() == 0

        updated = client.patch(
            f"{env['url']}{payload['id']}/",
            {
                "description_json": {
                    "type": "doc",
                    "content": [{"type": "paragraph", "content": [{"type": "text", "text": "Progress"}]}],
                },
                "description_html": "<p>Progress</p>",
            },
            format="json",
        )

        assert updated.status_code == 200
        assert updated.json()["draft_content"]["description_html"] == "<p>Progress</p>"
        page.refresh_from_db()
        assert page.description_html == "<p>Progress</p>"

        submitted = client.post(f"{env['url']}{payload['id']}/submit/", {}, format="json")
        assert submitted.status_code == 200
        assert submitted.json()["project"] is None
        assert PeriodicReportSnapshot.objects.get(report_id=payload["id"]).description_html == "<p>Progress</p>"

        duplicate = client.post(
            env["url"],
            {"report_type": "WEEKLY", "period_key": "2026-W39"},
            format="json",
        )
        assert duplicate.status_code == 409


@pytest.mark.django_db
class TestReportStateMachine:
    def test_full_loop_submit_return_resubmit_accept(self, env):
        report = create_report(env).json()
        report_id = report["id"]
        detail_url = f"{env['url']}{report_id}/"

        submitted = env["student_client"].post(f"{detail_url}submit/", {}, format="json")
        assert submitted.status_code == 200
        assert submitted.json()["status"] == "SUBMITTED"
        # 提交响应必须直接携带正文，否则前端 store 整体替换后正文会闪退成“加载中”。
        assert submitted.json()["draft_content"] is not None

        # a second submit must not create another transition (409, P0-RPT-06)
        again = env["student_client"].post(f"{detail_url}submit/", {}, format="json")
        assert again.status_code == 409
        assert ReportReviewLog.objects.filter(report_id=report_id, action="SUBMIT").count() == 1

        returned = env["advisor_client"].post(
            f"{detail_url}return/", {"comment": "Please add the experiment log."}, format="json"
        )
        assert returned.status_code == 200
        assert returned.json()["status"] == "NEEDS_REVISION"

        resubmitted = env["student_client"].post(f"{detail_url}submit/", {}, format="json")
        assert resubmitted.status_code == 200
        assert resubmitted.json()["status"] == "SUBMITTED"

        accepted = env["advisor_client"].post(f"{detail_url}accept/", {}, format="json")
        assert accepted.status_code == 200
        assert accepted.json()["status"] == "ACCEPTED"

        history = env["student_client"].get(f"{detail_url}history/").json()
        assert history["count"] == 4
        actions = [entry["action"] for entry in history["results"]]
        assert actions == ["ACCEPT", "SUBMIT", "RETURN", "SUBMIT"]

    def test_return_requires_a_reason(self, env):
        report = create_report(env).json()
        env["student_client"].post(f"{env['url']}{report['id']}/submit/", {}, format="json")
        response = env["advisor_client"].post(f"{env['url']}{report['id']}/return/", {"comment": ""}, format="json")
        assert response.status_code == 422
        assert response.json()["error_code"] == "report_return_reason_required"

    def test_only_the_owner_can_submit(self, env):
        report = create_report(env).json()
        response = env["advisor_client"].post(f"{env['url']}{report['id']}/submit/", {}, format="json")
        assert response.status_code == 404

    def test_submit_captures_an_immutable_official_snapshot(self, env):
        report = create_report(env).json()
        page = Page.objects.get(pk=report["page"])
        page.description_json = {"type": "doc", "content": [{"type": "paragraph"}]}
        page.description_html = "<p>Official version</p>"
        page.save()

        submitted = env["student_client"].post(f"{env['url']}{report['id']}/submit/", {}, format="json")

        assert submitted.status_code == 200
        snapshot = PeriodicReportSnapshot.objects.get(report_id=report["id"], version_no=1)
        assert snapshot.description_html == "<p>Official version</p>"
        assert submitted.json()["latest_official_version"] == 1

    def test_report_without_org_assignment_cannot_be_submitted(self, env):
        report = create_report(env).json()
        PeriodicReport.objects.filter(pk=report["id"]).update(org_unit=None)

        response = env["student_client"].post(f"{env['url']}{report['id']}/submit/", {}, format="json")

        assert response.status_code == 422
        assert response.json()["error_code"] == "org_unit_not_found"

    def test_reviewer_keeps_reading_last_snapshot_while_author_revises(self, env):
        report = create_report(env).json()
        page = Page.objects.get(pk=report["page"])
        page.description_html = "<p>Submitted v1</p>"
        page.save()
        env["student_client"].post(f"{env['url']}{report['id']}/submit/", {}, format="json")
        env["advisor_client"].post(
            f"{env['url']}{report['id']}/return/",
            {"comment": "revise"},
            format="json",
        )
        page.description_html = "<p>Private revision</p>"
        page.save()

        advisor_detail = env["advisor_client"].get(f"{env['url']}{report['id']}/")

        assert advisor_detail.status_code == 200
        assert advisor_detail.json()["official_content"]["description_html"] == "<p>Submitted v1</p>"
        assert advisor_detail.json()["draft_content"] is None

    def test_admin_can_read_another_members_draft(self, env):
        report = create_report(env).json()
        response = env["admin_client"].get(f"{env['url']}{report['id']}/")
        assert response.status_code == 200

    def test_colleague_cannot_review(self, env):
        report = create_report(env).json()
        env["student_client"].post(f"{env['url']}{report['id']}/submit/", {}, format="json")
        response = env["colleague_client"].post(f"{env['url']}{report['id']}/accept/", {}, format="json")
        assert response.status_code == 403

    def test_accepted_report_is_terminal(self, env):
        report = create_report(env).json()
        env["student_client"].post(f"{env['url']}{report['id']}/submit/", {}, format="json")
        env["advisor_client"].post(f"{env['url']}{report['id']}/accept/", {}, format="json")
        response = env["advisor_client"].post(
            f"{env['url']}{report['id']}/return/", {"comment": "too late"}, format="json"
        )
        assert response.status_code == 409

    def test_submitted_report_body_is_read_only(self, env):
        report = create_report(env).json()
        page_id = report["page"]
        project_pages = Page.objects.get(pk=page_id)
        project_id = str(project_pages.projects.first().id)
        page_url = f"/api/workspaces/{env['workspace'].slug}/projects/{project_id}/pages/{page_id}/"

        editable = env["student_client"].patch(page_url, {"description_html": "<p>Draft body</p>"}, format="json")
        assert editable.status_code == 200

        env["student_client"].post(f"{env['url']}{report['id']}/submit/", {}, format="json")
        blocked = env["student_client"].patch(
            page_url, {"description_html": "<p>Edited after submit</p>"}, format="json"
        )
        assert blocked.status_code == 403
        assert blocked.json()["error_code"] == "report_read_only"

    def test_author_can_open_draft_page_but_advisor_cannot(self, env):
        report = create_report(env).json()
        page = Page.objects.get(pk=report["page"])
        project_id = str(page.projects.first().id)
        page_url = f"/api/workspaces/{env['workspace'].slug}/projects/{project_id}/pages/{report['page']}/"

        assert env["student_client"].get(page_url).status_code == 200
        assert env["advisor_client"].get(page_url).status_code == 403

    def test_submitted_report_binary_description_is_read_only(self, env):
        report = create_report(env).json()
        page_id = report["page"]
        page = Page.objects.get(pk=page_id)
        project_id = str(page.projects.first().id)
        description_url = f"/api/workspaces/{env['workspace'].slug}/projects/{project_id}/pages/{page_id}/description/"

        editable = env["student_client"].patch(
            description_url, {"description_html": "<p>Draft body</p>"}, format="json"
        )
        assert editable.status_code == 200

        env["student_client"].post(f"{env['url']}{report['id']}/submit/", {}, format="json")
        blocked = env["student_client"].patch(
            description_url,
            {"description_html": "<p>Edited after submit</p>"},
            format="json",
        )

        assert blocked.status_code == 403
        assert blocked.json()["error_code"] == "report_read_only"

    def test_reported_page_cannot_be_deleted_directly(self, env):
        report = create_report(env).json()
        page = Page.objects.get(pk=report["page"])
        project_id = str(page.projects.first().id)
        page_url = f"/api/workspaces/{env['workspace'].slug}/projects/{project_id}/pages/{report['page']}/"
        response = env["student_client"].delete(page_url)
        assert response.status_code == 403


@pytest.mark.django_db
class TestReportRestore:
    @staticmethod
    def make_deleted_report_with_dependencies(env):
        """创建带正文、课题引用和附件的已删除报告夹具。

        Args:
            env: 报告契约测试环境。

        Returns:
            包含报告、正文、ProjectPage、课题引用、有效附件和历史删除附件的字典。
        """
        created = create_report(env)
        assert created.status_code == 201, created.json()
        report = PeriodicReport.objects.get(pk=created.json()["id"])
        report.page.description_html = "<p>Recoverable weekly body</p>"
        report.page.save(update_fields=["description_html", "updated_at"])

        reference = PeriodicReportProjectReference.objects.create(
            report=report,
            project=report.project,
            created_by=env["student"],
        )
        active_asset = FileAsset.objects.create(
            workspace=env["workspace"],
            user=env["student"],
            created_by=env["student"],
            asset=f"{env['workspace'].slug}/restore-active.pdf",
            attributes={"name": "restore-active.pdf", "type": "application/pdf", "size": 1},
            size=1,
        )
        stale_asset = FileAsset.objects.create(
            workspace=env["workspace"],
            user=env["student"],
            created_by=env["student"],
            asset=f"{env['workspace'].slug}/restore-stale.pdf",
            attributes={"name": "restore-stale.pdf", "type": "application/pdf", "size": 1},
            size=1,
        )
        active_attachment = ReportAttachment.objects.create(
            report=report,
            asset=active_asset,
            file_name="restore-active.pdf",
            file_size=1,
            content_type="application/pdf",
            uploaded_by=env["student"],
        )
        stale_attachment = ReportAttachment.objects.create(
            report=report,
            asset=stale_asset,
            file_name="restore-stale.pdf",
            file_size=1,
            content_type="application/pdf",
            uploaded_by=env["student"],
        )
        ReportAttachment.all_objects.filter(pk=stale_attachment.pk).update(
            deleted_at=timezone.now() - timedelta(seconds=1)
        )
        project_page = ProjectPage.objects.filter(page_id=report.page_id).first()
        if project_page is None:
            page_project = report.project
            if page_project is None:
                page_project = Project.objects.create(
                    workspace=env["workspace"],
                    name=f"Report restore {report.period_key}",
                    identifier=f"RR{str(report.id)[:6].upper()}",
                )
            project_page = ProjectPage.objects.create(
                project=page_project,
                page=report.page,
                workspace=env["workspace"],
                created_by=env["student"],
            )

        response = env["student_client"].delete(f"{env['url']}{report.id}/")
        assert response.status_code == 204, response.data
        return {
            "report": report,
            "reference": reference,
            "project_page": project_page,
            "active_attachment": active_attachment,
            "stale_attachment": stale_attachment,
        }

    def test_author_can_restore_deleted_report_with_same_delete_batch(self, env):
        fixture = self.make_deleted_report_with_dependencies(env)
        report = fixture["report"]

        active_results = env["student_client"].get(env["url"], {"scope": "all"}).json()["results"]
        deleted_results = env["student_client"].get(env["url"], {"scope": "deleted"}).json()["results"]
        assert all(item["id"] != str(report.id) for item in active_results)
        row = next(item for item in deleted_results if item["id"] == str(report.id))
        assert row["deleted_at"] is not None
        assert row["can_restore"] is True
        assert row["can_edit"] is False
        assert row["can_delete"] is False
        assert row["can_review"] is False

        colleague_results = env["colleague_client"].get(env["url"], {"scope": "deleted"}).json()["results"]
        assert all(item["id"] != str(report.id) for item in colleague_results)
        assert env["colleague_client"].post(f"{env['url']}{report.id}/restore/", {}, format="json").status_code == 404

        restored = env["student_client"].post(f"{env['url']}{report.id}/restore/", {}, format="json")
        assert restored.status_code == 200, restored.json()
        assert restored.json()["draft_content"]["description_html"] == "<p>Recoverable weekly body</p>"

        report.refresh_from_db()
        report.page.refresh_from_db()
        fixture["reference"].refresh_from_db()
        fixture["project_page"].refresh_from_db()
        fixture["active_attachment"].refresh_from_db()
        fixture["stale_attachment"].refresh_from_db()
        assert report.deleted_at is None
        assert report.page.deleted_at is None
        assert fixture["reference"].deleted_at is None
        assert fixture["project_page"].deleted_at is None
        assert fixture["active_attachment"].deleted_at is None
        assert fixture["stale_attachment"].deleted_at is not None

        event = ResearchAuditEvent.objects.get(
            workspace=env["workspace"],
            action="report.restore",
            resource_id=report.pk,
        )
        assert event.actor_id == env["student"].id
        assert event.metadata["period_key"] == report.period_key
        assert env["student_client"].post(f"{env['url']}{report.id}/restore/", {}, format="json").status_code == 404

    def test_research_admin_can_restore_another_users_deleted_report(self, env):
        report = create_report(env).json()
        assert env["student_client"].delete(f"{env['url']}{report['id']}/").status_code == 204

        deleted_response = env["admin_client"].get(env["url"], {"scope": "deleted"})
        assert deleted_response.status_code == 200, deleted_response.json()
        deleted = deleted_response.json()["results"]
        row = next(item for item in deleted if item["id"] == report["id"])
        assert row["can_restore"] is True

        response = env["admin_client"].post(f"{env['url']}{report['id']}/restore/", {}, format="json")
        assert response.status_code == 200, response.json()
        assert PeriodicReport.objects.filter(pk=report["id"], deleted_at__isnull=True).exists()

    def test_restore_conflicts_with_replacement_and_does_not_partially_restore(self, env):
        fixture = self.make_deleted_report_with_dependencies(env)
        report = fixture["report"]
        replacement = create_report(env)
        assert replacement.status_code == 201, replacement.json()

        response = env["student_client"].post(f"{env['url']}{report.id}/restore/", {}, format="json")
        assert response.status_code == 409
        assert response.json()["error_code"] == "report_period_conflict"

        report.refresh_from_db()
        report.page.refresh_from_db()
        fixture["reference"].refresh_from_db()
        fixture["active_attachment"].refresh_from_db()
        assert report.deleted_at is not None
        assert report.page.deleted_at is not None
        assert fixture["reference"].deleted_at is not None
        assert fixture["active_attachment"].deleted_at is not None


@pytest.mark.django_db
class TestReportWithdraw:
    @staticmethod
    def submit_report(env, **payload):
        """Create and submit one report for withdrawal tests.

        Args:
            env: Report contract test environment.
            payload: Optional report creation overrides such as period_key.

        Returns:
            API representation of the newly submitted report.
        """
        report = create_report(env, **payload).json()
        response = env["student_client"].post(f"{env['url']}{report['id']}/submit/", {}, format="json")
        assert response.status_code == 200, response.json()
        return report

    def test_author_can_withdraw_after_read_and_comments_then_resubmit_v2(self, env):
        report = self.submit_report(env)
        report_id = report["id"]
        assert env["student_client"].get(f"{env['url']}{report_id}/").json()["can_withdraw"] is True
        assert env["advisor_client"].post(f"{env['url']}{report_id}/read/", {}, format="json").status_code == 200
        comment_response = env["advisor_client"].post(
            f"{env['url']}{report_id}/comment-threads/",
            {"comment_html": "<p>Please clarify the result.</p>", "request_id": "withdraw-comment-1"},
            format="json",
        )
        assert comment_response.status_code == 201, comment_response.json()
        thread_id = comment_response.json()["id"]

        withdrawn = env["student_client"].post(
            f"{env['url']}{report_id}/withdraw/",
            {"comment": "Submitted the wrong experiment section."},
            format="json",
        )
        assert withdrawn.status_code == 200, withdrawn.json()
        assert withdrawn.json()["status"] == "DRAFT"
        assert withdrawn.json()["submitted_at"] is None
        assert withdrawn.json()["can_edit"] is True
        assert withdrawn.json()["can_withdraw"] is False
        assert withdrawn.json()["draft_content"] is not None

        item = PeriodicReport.objects.get(pk=report_id)
        assert item.status == "DRAFT"
        assert item.submitted_at is None
        assert item.accepted_at is None
        assert item.reviewer_id is None
        assert item.official_snapshots.count() == 1
        assert PeriodicReportReadReceipt.objects.filter(report=item, snapshot_version=1).count() == 1
        assert item.comment_threads.filter(deleted_at__isnull=True).count() == 1

        log = ReportReviewLog.objects.filter(report=item, action="REOPEN").latest("created_at")
        assert log.from_status == "SUBMITTED"
        assert log.to_status == "DRAFT"
        assert log.actor_id == env["student"].id
        assert log.snapshot_version == "1"
        assert log.comment == "Submitted the wrong experiment section."
        audit = ResearchAuditEvent.objects.get(
            workspace=env["workspace"],
            action="report.withdraw",
            resource_id=item.pk,
        )
        assert audit.metadata["snapshot_version"] == 1
        assert Notification.objects.filter(
            entity_identifier=item.pk,
            title=f"{item.period_key} 报告已撤回",
        ).exists()

        review_results = env["advisor_client"].get(env["url"], {"scope": "review"}).json()["results"]
        assert all(row["id"] != report_id for row in review_results)
        withdrawn_detail = env["admin_client"].get(f"{env['url']}{report_id}/")
        assert withdrawn_detail.status_code == 200
        assert withdrawn_detail.json()["official_content"] is None
        blocked_comment = env["student_client"].post(
            f"{env['url']}{report_id}/comment-threads/",
            {"comment_html": "<p>Author note</p>", "request_id": "withdraw-comment-2"},
            format="json",
        )
        assert blocked_comment.status_code == 409
        assert blocked_comment.json()["error_code"] == "report_state_conflict"
        blocked_reply = env["student_client"].post(
            f"{env['url']}{report_id}/comment-threads/{thread_id}/comments/",
            {"comment_html": "<p>Author reply</p>", "request_id": "withdraw-reply-1"},
            format="json",
        )
        assert blocked_reply.status_code == 409
        assert blocked_reply.json()["error_code"] == "report_state_conflict"

        assert env["student_client"].post(f"{env['url']}{report_id}/submit/", {}, format="json").status_code == 200
        item.refresh_from_db()
        assert item.status == "SUBMITTED"
        assert item.official_snapshots.count() == 2
        review_again = env["advisor_client"].get(env["url"], {"scope": "review"}).json()["results"]
        assert any(row["id"] == report_id for row in review_again)
        restored_reply = env["advisor_client"].post(
            f"{env['url']}{report_id}/comment-threads/{thread_id}/comments/",
            {"comment_html": "<p>Thanks, v2 is clear.</p>", "request_id": "withdraw-reply-2"},
            format="json",
        )
        assert restored_reply.status_code == 201, restored_reply.json()

    def test_only_author_can_withdraw_submitted_report(self, env):
        report = self.submit_report(env)
        url = f"{env['url']}{report['id']}/withdraw/"

        assert env["advisor_client"].post(url, {}, format="json").status_code == 403
        assert env["admin_client"].post(url, {}, format="json").status_code == 403
        assert PeriodicReport.objects.filter(pk=report["id"], status="SUBMITTED").exists()

    def test_withdraw_requires_submitted_state(self, env):
        draft = create_report(env).json()
        draft_response = env["student_client"].post(f"{env['url']}{draft['id']}/withdraw/", {}, format="json")
        assert draft_response.status_code == 409

        submitted = self.submit_report(env, period_key="2026-W39")
        accepted = env["advisor_client"].post(f"{env['url']}{submitted['id']}/accept/", {}, format="json")
        assert accepted.status_code == 200, accepted.json()
        accepted_response = env["student_client"].post(f"{env['url']}{submitted['id']}/withdraw/", {}, format="json")
        assert accepted_response.status_code == 409
        assert accepted_response.json()["error_code"] == "report_state_conflict"

        returned = self.submit_report(env, period_key="2026-W40")
        assert (
            env["advisor_client"].post(
                f"{env['url']}{returned['id']}/return/",
                {"comment": "Needs more detail."},
                format="json",
            ).status_code
            == 200
        )
        returned_response = env["student_client"].post(f"{env['url']}{returned['id']}/withdraw/", {}, format="json")
        assert returned_response.status_code == 409


@pytest.mark.django_db(transaction=True)
class TestReportConcurrentStateFlow:
    @staticmethod
    def _run_together(*operations):
        barrier = Barrier(len(operations))

        def execute(operation):
            close_old_connections()
            try:
                barrier.wait(timeout=5)
                return operation().status_code
            finally:
                close_old_connections()

        with ThreadPoolExecutor(max_workers=len(operations)) as executor:
            return list(executor.map(execute, operations))

    def test_concurrent_submit_creates_one_official_version(self, env):
        from plane.research.services import report_workflow

        report = create_report(env).json()
        submit_url = f"{env['url']}{report['id']}/submit/"
        create_snapshot = report_workflow.create_report_snapshot

        def delayed_snapshot(*args, **kwargs):
            sleep(0.15)
            return create_snapshot(*args, **kwargs)

        with patch.object(report_workflow, "create_report_snapshot", side_effect=delayed_snapshot):
            statuses = self._run_together(
                lambda: client_for(env["student"]).post(submit_url, {}, format="json"),
                lambda: client_for(env["student"]).post(submit_url, {}, format="json"),
            )

        assert sorted(statuses) == [200, 409]
        assert PeriodicReportSnapshot.objects.filter(report_id=report["id"]).count() == 1
        assert ReportReviewLog.objects.filter(report_id=report["id"], action=ReportReviewLog.Action.SUBMIT).count() == 1

    def test_withdraw_and_accept_compete_on_one_submitted_state(self, env):
        report = create_report(env).json()
        report_url = f"{env['url']}{report['id']}/"
        assert env["student_client"].post(f"{report_url}submit/", {}, format="json").status_code == 200

        statuses = sorted(
            self._run_together(
                lambda: client_for(env["student"]).post(f"{report_url}withdraw/", {}, format="json"),
                lambda: client_for(env["advisor"]).post(f"{report_url}accept/", {}, format="json"),
            )
        )

        assert statuses[0] == 200
        assert statuses[1] in (403, 409)
        item = PeriodicReport.objects.get(pk=report["id"])
        assert item.status in ("DRAFT", "ACCEPTED")
        assert item.status == "ACCEPTED" or (item.submitted_at is None and item.accepted_at is None)

    def test_return_and_accept_compete_on_one_submitted_state(self, env):
        from plane.research.views import reports as report_views

        report = create_report(env).json()
        report_url = f"{env['url']}{report['id']}/"
        submitted = env["student_client"].post(f"{report_url}submit/", {}, format="json")
        assert submitted.status_code == 200
        transition_allowed = report_views.can_transition

        def delayed_transition(current, target):
            result = transition_allowed(current, target)
            if current == PeriodicReport.Status.SUBMITTED:
                sleep(0.15)
            return result

        with patch.object(report_views, "can_transition", side_effect=delayed_transition):
            statuses = self._run_together(
                lambda: client_for(env["advisor"]).post(
                    f"{report_url}return/",
                    {"comment": "revise"},
                    format="json",
                ),
                lambda: client_for(env["advisor"]).post(f"{report_url}accept/", {}, format="json"),
            )

        assert sorted(statuses) == [200, 409]
        assert (
            ReportReviewLog.objects.filter(
                report_id=report["id"],
                action__in=(ReportReviewLog.Action.RETURN, ReportReviewLog.Action.ACCEPT),
            ).count()
            == 1
        )


@pytest.mark.django_db
class TestReportAccessControl:
    @pytest.mark.parametrize(
        "params",
        [
            {"owner": "not-a-uuid"},
            {"org_unit": "not-a-uuid"},
            {"date_from": "not-a-date"},
            {"date_from": "2026-10-01", "date_to": "2026-09-01"},
            {"per_page": "0"},
            {"per_page": "not-an-integer"},
            {"cursor": "not-a-cursor"},
        ],
    )
    def test_list_rejects_invalid_filter_and_pagination_values(self, env, params):
        response = env["student_client"].get(env["url"], params)
        assert response.status_code == 400

    def test_list_filters_visibility_in_sql_before_pagination(self, env, mocker):
        report = create_report(env, period_key="2026-W09").json()
        env["student_client"].post(f"{env['url']}{report['id']}/submit/", {}, format="json")
        object_acl = mocker.patch(
            "plane.research.views.reports.check_access",
            side_effect=AssertionError("report list must not scan objects through Python ACL"),
        )

        response = env["advisor_client"].get(env["url"], {"per_page": "1"})

        assert response.status_code == 200
        assert response.data["per_page"] == 1
        assert response.data["total_results"] == 1
        assert object_acl.call_count == 0

    def test_visibility_filters_the_list_for_each_subject(self, env):
        private = create_report(env, visibility="PRIVATE", period_key="2026-W10").json()
        advised = create_report(env, visibility="DIRECT_ADVISOR", period_key="2026-W11").json()
        assert private["visibility"] == "PRIVATE"
        assert advised["visibility"] == "DIRECT_ADVISOR"

        owner_list = env["student_client"].get(env["url"]).json()
        assert owner_list["count"] == 2

        env["student_client"].post(f"{env['url']}{advised['id']}/submit/", {}, format="json")
        advisor_list = env["advisor_client"].get(env["url"]).json()
        assert {item["id"] for item in advisor_list["results"]} == {advised["id"]}

        colleague_list = env["colleague_client"].get(env["url"]).json()
        assert colleague_list["count"] == 0

        admin_list = env["admin_client"].get(env["url"]).json()
        assert admin_list["count"] == 2

    def test_unit_visibility_is_available_when_the_policy_allows_it(self, env):
        env["admin_client"].patch(
            f"/api/research/workspaces/{env['workspace'].slug}/settings/",
            {"default_report_visibility": "UNIT"},
            format="json",
        )
        unit = create_report(env, visibility="UNIT", period_key="2026-W12").json()
        assert unit["visibility"] == "UNIT"
        env["student_client"].post(f"{env['url']}{unit['id']}/submit/", {}, format="json")
        # a member of the same organisation node now sees the report
        colleague_list = env["colleague_client"].get(env["url"]).json()
        assert {item["id"] for item in colleague_list["results"]} == {unit["id"]}

    def test_direct_advisor_scope_default(self, env):
        WorkspaceResearchSetting.objects.filter(workspace=env["workspace"]).update(
            weekly_default_visibility="DIRECT_ADVISOR"
        )
        report = create_report(env).json()
        env["student_client"].post(f"{env['url']}{report['id']}/submit/", {}, format="json")
        advisor_list = env["advisor_client"].get(env["url"]).json()
        assert {item["id"] for item in advisor_list["results"]} == {report["id"]}

    def test_confidential_subtree_hides_history_and_new_weekly_reports_in_real_time(self, env):
        outsider = make_user(first_name="Outsider", email="outsider@example.com")
        principal = make_user(first_name="Principal", email="principal@example.com")
        manager = make_user(first_name="Manager", email="manager@example.com")
        for user in (outsider, principal, manager):
            add_workspace_member(env["workspace"], user)
        OrgUnitMember.objects.create(
            workspace=env["workspace"],
            org_unit=env["root"],
            user=manager,
            org_role=OrgUnitMember.OrgRole.PI,
            is_primary=True,
        )
        WorkspaceResearchSetting.objects.filter(workspace=env["workspace"]).update(main_pi=principal)

        public_group = create_unit(env["workspace"], "Public Group", env["root"])
        OrgUnitMember.objects.create(
            workspace=env["workspace"],
            org_unit=public_group,
            user=outsider,
            org_role=OrgUnitMember.OrgRole.REVIEWER,
            is_primary=True,
        )
        OrgUnitMember.objects.create(
            workspace=env["workspace"],
            org_unit=public_group,
            user=principal,
            org_role=OrgUnitMember.OrgRole.REVIEWER,
            is_primary=True,
        )
        confidential_parent = create_unit(env["workspace"], "Confidential Institute", env["root"])
        moved = env["admin_client"].patch(
            f"/api/research/workspaces/{env['workspace'].slug}/org-units/{env['group'].id}/",
            {"parent": str(confidential_parent.id)},
            format="json",
        )
        assert moved.status_code == 200
        env["group"].refresh_from_db()

        historical = create_report(env, period_key="2026-W20").json()
        assert historical["visibility"] == "WORKSPACE"
        env["student_client"].post(f"{env['url']}{historical['id']}/submit/", {}, format="json")
        outsider_client = client_for(outsider)
        principal_client = client_for(principal)
        manager_client = client_for(manager)

        assert outsider_client.get(f"{env['url']}{historical['id']}/").status_code == 200
        assert outsider_client.get(f"{env['url']}{historical['id']}/comment-threads/").status_code == 200
        assert outsider_client.get(f"{env['url']}{historical['id']}/attachments/").status_code == 200

        confidential_parent.weekly_report_confidential = True
        confidential_parent.save(update_fields=["weekly_report_confidential"])

        assert outsider_client.get(env["url"]).json()["count"] == 0
        assert outsider_client.get(f"{env['url']}{historical['id']}/").status_code == 404
        assert outsider_client.get(f"{env['url']}{historical['id']}/comment-threads/").status_code == 404
        assert outsider_client.get(f"{env['url']}{historical['id']}/attachments/").status_code == 404
        author_detail = env["student_client"].get(f"{env['url']}{historical['id']}/").json()
        assert author_detail["visibility"] == "WORKSPACE"
        assert author_detail["effective_visibility"] == "UNIT"
        assert author_detail["weekly_confidential"] is True
        assert historical["id"] in {item["id"] for item in env["colleague_client"].get(env["url"]).json()["results"]}
        assert historical["id"] in {item["id"] for item in env["advisor_client"].get(env["url"]).json()["results"]}
        assert historical["id"] in {item["id"] for item in manager_client.get(env["url"]).json()["results"]}
        assert historical["id"] in {item["id"] for item in principal_client.get(env["url"]).json()["results"]}

        widened = create_report(env, period_key="2026-W21", visibility="WORKSPACE")
        assert widened.status_code == 422
        assert widened.json()["error_code"] == "report_visibility_exceeds_default"
        narrowed = create_report(env, period_key="2026-W22").json()
        assert narrowed["visibility"] == "UNIT"
        access = env["student_client"].get(f"{env['url']}{narrowed['id']}/access/").json()
        assert access["default_visibility"] == "UNIT"
        custom = env["student_client"].patch(
            f"{env['url']}{narrowed['id']}/access/",
            {"grants": [{"grantee_user": str(outsider.id)}]},
            format="json",
        )
        assert custom.status_code == 422

        confidential_parent.weekly_report_confidential = False
        confidential_parent.save(update_fields=["weekly_report_confidential"])
        assert outsider_client.get(env["url"]).json()["count"] == 1

    def test_joint_advisor_reads_formal_report_but_cannot_review_it(self, env):
        joint = make_user(first_name="JointAdvisor", email="joint@example.com")
        add_workspace_member(env["workspace"], joint)
        OrgUnitMember.objects.create(
            workspace=env["workspace"],
            org_unit=env["group"],
            user=joint,
            org_role=OrgUnitMember.OrgRole.ADVISOR,
        )
        MentorBinding.objects.create(
            workspace=env["workspace"],
            org_unit=env["group"],
            mentee=env["student"],
            mentor=joint,
            is_primary_advisor=False,
        )
        report = create_report(env, period_key="2026-W13").json()
        env["student_client"].post(f"{env['url']}{report['id']}/submit/", {}, format="json")

        detail = client_for(joint).get(f"{env['url']}{report['id']}/")
        assert detail.status_code == 200
        assert detail.json()["can_review"] is False
        denied = client_for(joint).post(
            f"{env['url']}{report['id']}/return/",
            {"comment": "joint advisor cannot return"},
            format="json",
        )
        assert denied.status_code == 403

    def test_same_unit_advisor_without_binding_cannot_read_formal_report(self, env):
        WorkspaceResearchSetting.objects.filter(workspace=env["workspace"]).update(
            weekly_default_visibility="DIRECT_ADVISOR"
        )
        unbound = make_user(first_name="UnboundAdvisor", email="unbound@example.com")
        add_workspace_member(env["workspace"], unbound)
        OrgUnitMember.objects.create(
            workspace=env["workspace"],
            org_unit=env["group"],
            user=unbound,
            org_role=OrgUnitMember.OrgRole.ADVISOR,
        )
        report = create_report(env, period_key="2026-W14").json()
        env["student_client"].post(f"{env['url']}{report['id']}/submit/", {}, format="json")

        assert client_for(unbound).get(f"{env['url']}{report['id']}/").status_code == 404

    def test_detail_is_hidden_from_unauthorised_member(self, env):
        private = create_report(env, visibility="PRIVATE").json()
        response = env["colleague_client"].get(f"{env['url']}{private['id']}/")
        assert response.status_code == 404

    def test_author_can_narrow_but_not_widen(self, env):
        WorkspaceResearchSetting.objects.filter(workspace=env["workspace"]).update(
            weekly_default_visibility="DIRECT_ADVISOR"
        )
        report = create_report(env).json()
        access_url = f"{env['url']}{report['id']}/access/"

        widened = env["student_client"].patch(access_url, {"visibility": "WORKSPACE"}, format="json")
        assert widened.status_code == 422

        narrowed = env["student_client"].patch(access_url, {"visibility": "PRIVATE"}, format="json")
        assert narrowed.status_code == 200
        assert narrowed.json()["visibility"] == "PRIVATE"
        assert narrowed.json()["can_widen"] is False

    def test_custom_grants_cannot_expand_a_direct_advisor_policy_to_a_colleague(self, env):
        WorkspaceResearchSetting.objects.filter(workspace=env["workspace"]).update(
            weekly_default_visibility="DIRECT_ADVISOR"
        )
        report = create_report(env).json()
        access_url = f"{env['url']}{report['id']}/access/"
        response = env["student_client"].patch(
            access_url,
            {"grants": [{"grantee_user": str(env["colleague"].id)}]},
            format="json",
        )
        assert response.status_code == 422
        assert ReportAccessGrant.objects.filter(report_id=report["id"], is_revoked=False).count() == 0

    def test_custom_grant_can_select_an_existing_direct_advisor(self, env):
        WorkspaceResearchSetting.objects.filter(workspace=env["workspace"]).update(
            weekly_default_visibility="DIRECT_ADVISOR"
        )
        report = create_report(env).json()
        response = env["student_client"].patch(
            f"{env['url']}{report['id']}/access/",
            {"grants": [{"grantee_user": str(env["advisor"].id)}]},
            format="json",
        )
        assert response.status_code == 200
        assert response.json()["visibility"] == "CUSTOM"

    def test_private_reports_reject_custom_grants(self, env):
        report = create_report(env, visibility="PRIVATE").json()
        response = env["student_client"].patch(
            f"{env['url']}{report['id']}/access/",
            {"grants": [{"grantee_user": str(env["colleague"].id)}]},
            format="json",
        )
        assert response.status_code == 422

    def test_reviewer_cannot_change_visibility(self, env):
        report = create_report(env).json()
        response = env["advisor_client"].patch(
            f"{env['url']}{report['id']}/access/", {"visibility": "PRIVATE"}, format="json"
        )
        assert response.status_code == 404
