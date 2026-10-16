# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

from django.utils.dateparse import parse_datetime
from rest_framework.test import APIClient

import pytest

from plane.db.models import (
    MentorBinding,
    OrgUnit,
    OrgUnitMember,
    PeriodicReport,
    PeriodicReportReadReceipt,
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
    """Create an authenticated API client for one research actor."""
    client = APIClient()
    client.force_authenticate(user=user)
    return client


def create_unit(workspace, name, parent=None, unit_type=OrgUnit.UnitType.GROUP):
    """Create an organisation unit and maintain the materialised path."""
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
    """Create a minimal author / direct advisor / unrelated reader fixture."""
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
    created = student_client.post(
        f"/api/research/workspaces/{workspace.slug}/reports/",
        {
            "report_type": "WEEKLY",
            "period_key": "2026-W40",
            "visibility": "DIRECT_ADVISOR",
        },
        format="json",
    )
    assert created.status_code == 201
    report = created.json()
    submitted = student_client.post(
        f"/api/research/workspaces/{workspace.slug}/reports/{report['id']}/submit/",
        {},
        format="json",
    )
    assert submitted.status_code == 200

    return {
        "student": student,
        "advisor": advisor,
        "colleague": colleague,
        "workspace": workspace,
        "report": report,
        "admin_client": client_for(admin),
        "student_client": student_client,
        "advisor_client": client_for(advisor),
        "colleague_client": client_for(colleague),
        "detail_url": f"/api/research/workspaces/{workspace.slug}/reports/{report['id']}/",
        "read_url": f"/api/research/workspaces/{workspace.slug}/reports/{report['id']}/read/",
        "receipts_url": f"/api/research/workspaces/{workspace.slug}/reports/{report['id']}/read-receipts/",
    }


@pytest.mark.django_db
class TestResearchReportReadReceipts:
    def test_direct_advisor_reading_creates_one_immutable_receipt(self, env):
        before = env["advisor_client"].get(env["detail_url"]).json()
        assert before["official_content"]["version_no"] == 1
        assert before["has_read"] is False
        assert before["read_count"] == 0
        assert before["latest_read_at"] is None

        read = env["advisor_client"].post(env["read_url"], {}, format="json")
        payload = read.json()
        assert read.status_code == 200
        assert payload["has_read"] is True
        assert payload["snapshot_version"] == 1
        assert payload["read_count"] == 1
        assert payload["latest_read_at"] == payload["read_at"]
        first_read_at = payload["read_at"]

        repeated = env["advisor_client"].post(env["read_url"], {}, format="json")
        assert repeated.status_code == 200
        assert repeated.json()["read_at"] == first_read_at

        receipt = PeriodicReportReadReceipt.objects.get()
        assert receipt.reader_id == env["advisor"].id
        assert receipt.snapshot_version == 1
        assert receipt.source == PeriodicReportReadReceipt.Source.DETAIL_VIEW
        assert parse_datetime(first_read_at) == receipt.read_at

        detail = env["advisor_client"].get(env["detail_url"]).json()
        assert detail["has_read"] is True
        assert detail["read_count"] == 1
        assert detail["latest_read_at"] == first_read_at
        listed = env["advisor_client"].get(
            f"/api/research/workspaces/{env['workspace'].slug}/reports/",
            {"scope": "review"},
        ).json()
        row = next(item for item in listed["results"] if item["id"] == env["report"]["id"])
        assert (row["has_read"], row["read_count"], row["latest_read_at"]) == (True, 1, first_read_at)

    def test_author_detail_and_unrelated_reader_do_not_create_receipts(self, env):
        author_detail = env["student_client"].get(env["detail_url"])
        assert author_detail.status_code == 200
        assert author_detail.json()["official_content"] is None
        assert author_detail.json()["has_read"] is False
        assert author_detail.json()["read_count"] == 0

        denied = env["colleague_client"].post(env["read_url"], {}, format="json")
        assert denied.status_code == 404
        assert PeriodicReportReadReceipt.objects.count() == 0

    def test_author_cannot_append_a_read_receipt(self, env):
        response = env["student_client"].post(env["read_url"], {}, format="json")

        assert response.status_code == 403
        assert response.json()["error_code"] == "research_permission_denied"
        assert PeriodicReportReadReceipt.objects.count() == 0

    def test_workspace_admin_can_read_the_receipt_summary(self, env):
        env["advisor_client"].post(env["read_url"], {}, format="json")

        response = env["admin_client"].get(env["receipts_url"])

        assert response.status_code == 200
        assert response.json()["count"] == 1

    def test_admin_read_does_not_light_the_mentor_read_badge(self, env):
        admin_read = env["admin_client"].post(env["read_url"], {}, format="json")

        assert admin_read.status_code == 200
        assert admin_read.json()["read_count"] == 0
        assert PeriodicReportReadReceipt.objects.count() == 1
        assert env["admin_client"].get(env["receipts_url"]).json()["count"] == 1

        author_view = env["student_client"].get(env["detail_url"]).json()
        assert author_view["read_count"] == 0
        assert author_view["latest_read_at"] is None

        advisor_read = env["advisor_client"].post(env["read_url"], {}, format="json").json()
        assert advisor_read["read_count"] == 1

        author_view = env["student_client"].get(env["detail_url"]).json()
        assert author_view["read_count"] == 1
        assert parse_datetime(author_view["latest_read_at"]) == parse_datetime(advisor_read["read_at"])

    def test_main_pi_read_lights_the_mentor_read_badge(self, env):
        pi = make_user(first_name="MainPI", email="mainpi@example.com")
        add_workspace_member(env["workspace"], pi)
        WorkspaceResearchSetting.objects.filter(workspace=env["workspace"]).update(main_pi=pi)

        read = client_for(pi).post(env["read_url"], {}, format="json")

        assert read.status_code == 200
        author_view = env["student_client"].get(env["detail_url"]).json()
        assert author_view["read_count"] == 1
        assert author_view["latest_read_at"] is not None

    def test_draft_report_without_snapshot_conflicts(self, env):
        PeriodicReport.objects.filter(pk=env["report"]["id"]).update(status="DRAFT", submitted_at=None)
        response = env["advisor_client"].post(env["read_url"], {}, format="json")

        assert response.status_code == 404
        assert PeriodicReportReadReceipt.objects.count() == 0

    def test_review_actions_do_not_change_read_receipts(self, env):
        read = env["advisor_client"].post(env["read_url"], {}, format="json").json()
        receipt = PeriodicReportReadReceipt.objects.get()

        returned = env["advisor_client"].post(
            f"{env['detail_url']}return/",
            {"comment": "Please add experiment details."},
            format="json",
        )
        resubmitted = env["student_client"].post(f"{env['detail_url']}submit/", {}, format="json")
        accepted = env["advisor_client"].post(f"{env['detail_url']}accept/", {}, format="json")

        assert returned.status_code == 200
        assert resubmitted.status_code == 200
        assert accepted.status_code == 200
        receipt.refresh_from_db()
        assert PeriodicReportReadReceipt.objects.count() == 1
        assert parse_datetime(read["read_at"]) == receipt.read_at

        author_receipts = env["student_client"].get(env["receipts_url"])
        assert author_receipts.status_code == 200
        assert author_receipts.json()["count"] == 1
        assert author_receipts.json()["results"][0]["reader"] == str(env["advisor"].id)
