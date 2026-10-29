# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Periodic-report approval routing API contracts."""

import pytest
from rest_framework.test import APIClient

from plane.db.models import Notification, ResearchApprovalRoute
from plane.tests.research_fixtures import make_research_boundary_fixture

pytestmark = [pytest.mark.contract, pytest.mark.django_db]


@pytest.fixture
def env(db, settings):
    """Build one research boundary and API clients for routing assertions."""
    settings.RESEARCH_MODULE_ENABLED = True
    fixture = make_research_boundary_fixture()
    fixture.update(
        {
            "student_client": _client(fixture["student"]),
            "advisor_client": _client(fixture["advisor"]),
            "principal_client": _client(fixture["principal"]),
            "member_client": _client(fixture["group_member"]),
        }
    )
    return fixture


def _client(user):
    client = APIClient()
    client.force_authenticate(user=user)
    return client


def test_periodic_report_routes_notifications_and_review_permission(env):
    report_response = env["student_client"].post(
        f"/api/research/workspaces/{env['workspace'].slug}/reports/",
        {"report_type": "WEEKLY"},
        format="json",
    )
    assert report_response.status_code == 201, report_response.json()
    report = report_response.json()
    report_id = report["id"]
    route_url = f"/api/research/workspaces/{env['workspace'].slug}/reports/{report_id}/approval-route/"

    route_response = env["student_client"].get(route_url)
    assert route_response.status_code == 200, route_response.json()
    route = route_response.json()["data"]
    assert route["default_reviewer_id"] == str(env["advisor"].id)
    assert str(env["student"].id) not in {item["id"] for item in route["candidates"]}

    missing = env["student_client"].post(
        f"/api/research/workspaces/{env['workspace'].slug}/reports/{report_id}/submit/",
        {},
        format="json",
    )
    assert missing.status_code == 422
    assert missing.json()["error_code"] == "approval_reviewer_required"

    self_review = env["student_client"].post(
        f"/api/research/workspaces/{env['workspace'].slug}/reports/{report_id}/submit/",
        {"reviewer_id": str(env["student"].id)},
        format="json",
    )
    assert self_review.status_code == 422
    assert self_review.json()["error_code"] == "approval_reviewer_self"

    submitted = env["student_client"].post(
        f"/api/research/workspaces/{env['workspace'].slug}/reports/{report_id}/submit/",
        {
            "reviewer_id": str(env["advisor"].id),
            "cc_user_ids": [str(env["principal"].id)],
        },
        format="json",
    )
    assert submitted.status_code == 200, submitted.json()
    assert ResearchApprovalRoute.objects.filter(
        resource_type="PERIODIC_REPORT",
        resource_id=report_id,
        reviewer=env["advisor"],
        status="ACTIVE",
    ).exists()
    submitted_notifications = list(Notification.objects.values_list("receiver_id", "title"))
    assert (
        env["advisor"].id,
        f"{report['period_key']} 报告已提交",
    ) in submitted_notifications
    assert Notification.objects.filter(
        receiver=env["principal"],
        entity_identifier=report_id,
        data__action="submitted.cc",
    ).exists()

    principal_return = env["principal_client"].post(
        f"/api/research/workspaces/{env['workspace'].slug}/reports/{report_id}/return/",
        {"comment": "未选择为主审人。"},
        format="json",
    )
    assert principal_return.status_code == 403

    advisor_return = env["advisor_client"].post(
        f"/api/research/workspaces/{env['workspace'].slug}/reports/{report_id}/return/",
        {"comment": "请补充实验细节。"},
        format="json",
    )
    assert advisor_return.status_code == 200, advisor_return.json()
    assert not ResearchApprovalRoute.objects.filter(
        resource_type="PERIODIC_REPORT",
        resource_id=report_id,
        status="ACTIVE",
    ).exists()
