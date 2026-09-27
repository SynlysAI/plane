# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

import pytest
from rest_framework.test import APIClient

from plane.db.models import (
    Issue,
    MentorBinding,
    OrgUnit,
    OrgUnitMember,
    Page,
    Project,
    ProjectMember,
    ProjectPage,
    ResearchProjectProfile,
    State,
    WorkspaceResearchSetting,
)
from plane.tests.research_fixtures import add_workspace_member, enable_research, make_user, make_workspace

pytestmark = pytest.mark.contract


@pytest.fixture(autouse=True)
def research_module_on(settings):
    settings.RESEARCH_MODULE_ENABLED = True


def client_for(user):
    client = APIClient()
    client.force_authenticate(user=user)
    return client


def _unit(workspace, name, unit_type, parent, depth):
    unit = OrgUnit.objects.create(
        workspace=workspace,
        name=name,
        parent=parent,
        unit_type=unit_type,
        depth=depth,
        path="",
    )
    prefix = parent.path if parent is not None else "/"
    unit.path = f"{prefix}{str(unit.id).replace('-', '')}/"
    unit.save(update_fields=["path"])
    return unit


def _project(workspace, owner, org_unit, name, identifier):
    project = Project.objects.create(
        workspace=workspace,
        name=name,
        identifier=identifier,
        network=0,
        created_by=owner,
    )
    ProjectMember.objects.create(
        workspace=workspace,
        project=project,
        member=owner,
        role=20,
        is_active=True,
    )
    ResearchProjectProfile.objects.create(
        project=project,
        workspace=workspace,
        owner=owner,
        org_unit=org_unit,
        chain_kind=ResearchProjectProfile.ChainKind.RESEARCH_CHAIN,
        chain_visibility=ResearchProjectProfile.ChainVisibility.PRIVATE,
        created_by=owner,
    )
    state = State.objects.create(
        name="Backlog",
        project=project,
        workspace=workspace,
        group="backlog",
        default=True,
        color="#60646C",
    )
    issue = Issue.objects.create(
        name="Student task",
        workspace=workspace,
        project=project,
        state=state,
        created_by=owner,
    )
    page = Page.objects.create(
        workspace=workspace,
        owned_by=owner,
        access=Page.PUBLIC_ACCESS,
        name="Student page",
    )
    ProjectPage.objects.create(workspace=workspace, project=project, page=page)
    return project, issue, page


@pytest.fixture
def env(db):
    admin = make_user(first_name="Admin")
    workspace = make_workspace(admin)
    setting = enable_research(workspace)
    setting.purpose = WorkspaceResearchSetting.Purpose.PUBLIC_RESEARCH
    setting.save(update_fields=["purpose"])

    root = _unit(workspace, "PiLab", OrgUnit.UnitType.ROOT, None, 0)
    basic = _unit(workspace, "基础研究", OrgUnit.UnitType.LAB, root, 1)
    industry = _unit(workspace, "产业化", OrgUnit.UnitType.LAB, root, 1)
    devices = _unit(workspace, "器件", OrgUnit.UnitType.GROUP, basic, 2)
    phosphate = _unit(workspace, "磷酸", OrgUnit.UnitType.GROUP, industry, 2)

    student = make_user(first_name="Student")
    peer = make_user(first_name="Peer")
    mentor = make_user(first_name="Mentor")
    direction_pi = make_user(first_name="Direction")
    main_pi = make_user(first_name="MainPI")
    for user in (student, peer, mentor, direction_pi, main_pi):
        add_workspace_member(workspace, user)

    OrgUnitMember.objects.create(
        workspace=workspace, org_unit=devices, user=student, org_role=OrgUnitMember.OrgRole.REVIEWER, is_primary=True
    )
    OrgUnitMember.objects.create(
        workspace=workspace, org_unit=devices, user=peer, org_role=OrgUnitMember.OrgRole.REVIEWER, is_primary=True
    )
    OrgUnitMember.objects.create(
        workspace=workspace, org_unit=basic, user=direction_pi, org_role=OrgUnitMember.OrgRole.PI, is_primary=True
    )
    MentorBinding.objects.create(workspace=workspace, mentor=mentor, mentee=student, org_unit=devices)
    setting.main_pi = main_pi
    setting.save(update_fields=["main_pi"])

    project, issue, page = _project(workspace, student, devices, "QZX-TEST1", "QZX1")
    other, _, _ = _project(workspace, peer, phosphate, "Other team", "OTH1")
    return {
        "workspace": workspace,
        "project": project,
        "other": other,
        "issue": issue,
        "page": page,
        "student": student,
        "peer": peer,
        "mentor": mentor,
        "direction_pi": direction_pi,
        "main_pi": main_pi,
    }


def _listed(client, workspace):
    response = client.get(f"/api/workspaces/{workspace.slug}/projects/details/")
    assert response.status_code == 200
    return response.json()


def _row(rows, project_id):
    return next((row for row in rows if row["id"] == str(project_id)), None)


@pytest.mark.django_db
class TestResearchProjectReviewAccess:
    def test_mentor_can_read_private_project_without_membership(self, env):
        before = ProjectMember.objects.filter(project=env["project"]).count()
        client = client_for(env["mentor"])
        row = _row(_listed(client, env["workspace"]), env["project"].id)
        assert row is not None
        assert row["research_access"] == "review"
        assert row["member_role"] is None

        detail = client.get(f"/api/workspaces/{env['workspace'].slug}/projects/{env['project'].id}/")
        assert detail.status_code == 200
        assert detail.json()["research_access"] == "review"

        issues = client.get(f"/api/workspaces/{env['workspace'].slug}/projects/{env['project'].id}/issues/")
        assert issues.status_code == 200
        issue = client.get(
            f"/api/workspaces/{env['workspace'].slug}/projects/{env['project'].id}/issues/{env['issue'].id}/"
        )
        assert issue.status_code == 200
        created = client.post(
            f"/api/workspaces/{env['workspace'].slug}/projects/{env['project'].id}/issues/",
            {"name": "should fail"},
            format="json",
        )
        assert created.status_code == 403

        pages = client.get(f"/api/workspaces/{env['workspace'].slug}/projects/{env['project'].id}/pages/")
        assert pages.status_code == 200
        assert any(item["id"] == str(env["page"].id) for item in pages.json())
        page = client.get(
            f"/api/workspaces/{env['workspace'].slug}/projects/{env['project'].id}/pages/{env['page'].id}/"
        )
        assert page.status_code == 200
        rejected = client.post(
            f"/api/workspaces/{env['workspace'].slug}/projects/{env['project'].id}/pages/",
            {"name": "no write"},
            format="json",
        )
        assert rejected.status_code == 403

        patched = client.patch(
            f"/api/workspaces/{env['workspace'].slug}/projects/{env['project'].id}/",
            {"name": "renamed"},
            format="json",
        )
        assert patched.status_code == 403
        assert ProjectMember.objects.filter(project=env["project"]).count() == before
        assert not ProjectMember.objects.filter(project=env["project"], member=env["mentor"]).exists()

    def test_peer_and_unrelated_student_cannot_open_the_private_project(self, env):
        stranger = make_user(first_name="Stranger")
        add_workspace_member(env["workspace"], stranger)
        for user in (env["peer"], stranger):
            client = client_for(user)
            assert _row(_listed(client, env["workspace"]), env["project"].id) is None
            detail = client.get(f"/api/workspaces/{env['workspace'].slug}/projects/{env['project'].id}/")
            assert detail.status_code == 403

    def test_direction_pi_sees_descendant_team_only(self, env):
        client = client_for(env["direction_pi"])
        rows = _listed(client, env["workspace"])
        visible = _row(rows, env["project"].id)
        assert visible is not None
        assert visible["research_access"] == "review"
        assert _row(rows, env["other"].id) is None

    def test_main_pi_can_read_both_private_projects(self, env):
        client = client_for(env["main_pi"])
        rows = _listed(client, env["workspace"])
        assert _row(rows, env["project"].id)["research_access"] == "review"
        assert _row(rows, env["other"].id)["research_access"] == "review"

    def test_owner_membership_is_unchanged(self, env):
        client = client_for(env["student"])
        row = _row(_listed(client, env["workspace"]), env["project"].id)
        assert row is not None
        assert row["member_role"] == 20
        assert row["research_access"] is None
        patched = client.patch(
            f"/api/workspaces/{env['workspace'].slug}/projects/{env['project'].id}/",
            {"name": "Renamed project"},
            format="json",
        )
        assert patched.status_code == 200
        assert patched.json()["name"] == "Renamed project"
