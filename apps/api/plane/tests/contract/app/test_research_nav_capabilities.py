# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file in the repo root for details.

"""Navigation levels: the published menu and the endpoints agree (v2.5.0)."""

import pytest
from rest_framework.test import APIClient

from plane.db.models import OrgUnit, OrgUnitMember, Project, ResearchProjectProfile, ResearchStageInstance
from plane.research.utils.org import build_path
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
    unit.path = build_path(unit.id, parent.path if parent else None)
    unit.save(update_fields=["path"])
    return unit


@pytest.fixture
def env(db):
    admin = make_user(first_name="Admin")
    workspace = make_workspace(admin)
    enable_research(workspace)
    pi_user = make_user(first_name="MainPI")
    advisor = make_user(first_name="Advisor")
    student = make_user(first_name="Student")
    bystander = make_user(first_name="Bystander")
    for user in (pi_user, advisor, student, bystander):
        add_workspace_member(workspace, user)

    root = create_unit(workspace, "Root", None, OrgUnit.UnitType.ROOT)
    group = create_unit(workspace, "Group", root, OrgUnit.UnitType.GROUP)
    OrgUnitMember.objects.create(
        workspace=workspace,
        org_unit=group,
        user=admin,
        org_role=OrgUnitMember.OrgRole.OWNER,
    )
    OrgUnitMember.objects.create(workspace=workspace, org_unit=group, user=pi_user, org_role=OrgUnitMember.OrgRole.PI)
    OrgUnitMember.objects.create(
        workspace=workspace, org_unit=group, user=advisor, org_role=OrgUnitMember.OrgRole.ADVISOR
    )
    OrgUnitMember.objects.create(
        workspace=workspace, org_unit=group, user=student, org_role=OrgUnitMember.OrgRole.REVIEWER
    )
    slug = workspace.slug
    return {
        "admin": admin,
        "workspace": workspace,
        "group": group,
        "pi": pi_user,
        "advisor": advisor,
        "student": student,
        "bystander": bystander,
        "identity_url": f"/api/research/workspaces/{slug}/identity/me/",
        "summary_url": f"/api/research/workspaces/{slug}/reports/summary/",
        "aggregate_url": f"/api/research/workspaces/{slug}/aggregate/",
        "org_units_url": f"/api/research/workspaces/{slug}/org-units/",
        "reviews_url": f"/api/research/workspaces/{slug}/reviews/",
        "templates_url": f"/api/research/workspaces/{slug}/report-templates/",
        "audit_url": f"/api/research/workspaces/{slug}/audit-events/",
        "settings_url": f"/api/research/workspaces/{slug}/settings/",
        "projects_url": f"/api/research/workspaces/{slug}/projects/",
    }


def identity_of(env, user):
    response = client_for(user).get(env["identity_url"])
    assert response.status_code == 200
    return response.json()


def test_identity_publishes_the_level_and_the_menu(env):
    admin_identity = identity_of(env, env["admin"])
    assert admin_identity["user"]["research_level"] == "ADMIN"
    assert admin_identity["capabilities"]["level"] == "ADMIN"
    assert set(admin_identity["capabilities"]["nav"]) == {
        "overview",
        "dashboard",
        "reports",
        "summary",
        "projects",
        "reviews",
        "approvals",
        "org",
        "system",
        "templates",
        "identity",
        "platform",
        "audit",
        "integrations",
    }

    student_identity = identity_of(env, env["student"])
    assert student_identity["user"]["research_level"] == "RESEARCHER"
    assert student_identity["capabilities"]["nav"] == ["overview", "reports", "projects"]

    bystander_identity = identity_of(env, env["bystander"])
    assert bystander_identity["user"]["research_level"] == "NONE"
    assert bystander_identity["capabilities"]["nav"] == []


def test_published_menu_never_exceeds_the_workspace_switches(env):
    enable_research(env["workspace"], approval_enabled=False, integration_enabled=False)

    payload = identity_of(env, env["admin"])
    sections = payload["sections"]

    assert sections["approvals"] is False
    assert "approvals" not in payload["capabilities"]["nav"]
    assert "integrations" not in payload["capabilities"]["nav"]
    assert "reports" in payload["capabilities"]["nav"]
    # the level itself is untouched by a switch
    assert payload["capabilities"]["level"] == "ADMIN"


def test_summary_is_refused_for_the_lowest_level(env):
    denied = client_for(env["student"]).get(env["summary_url"])
    assert denied.status_code == 403
    assert denied.json()["error_code"] == "research_permission_denied"

    assert client_for(env["advisor"]).get(env["summary_url"]).status_code == 200
    assert client_for(env["pi"]).get(env["summary_url"]).status_code == 200


def test_board_is_scoped_to_advisors_and_pi_roles(env):
    assert client_for(env["student"]).get(env["aggregate_url"]).status_code == 403
    assert client_for(env["advisor"]).get(env["aggregate_url"]).status_code == 200
    assert client_for(env["pi"]).get(env["aggregate_url"]).status_code == 200


def test_student_keeps_the_tree_but_loses_the_administration_surfaces(env):
    client = client_for(env["student"])

    assert client.get(env["org_units_url"]).status_code == 200
    assert client.get(f"{env['org_units_url']}{env['group'].id}/members/").status_code == 403
    assert client.post(env["org_units_url"], {"name": "New", "unit_type": "GROUP"}, format="json").status_code == 403
    assert client.get(env["templates_url"]).status_code == 403
    assert client.get(env["audit_url"]).status_code == 403
    assert client.get(env["settings_url"]).status_code == 403


def test_student_keeps_reports_and_projects_but_not_the_approval_queue(env):
    client = client_for(env["student"])

    assert client.get(f"/api/research/workspaces/{env['workspace'].slug}/reports/").status_code == 200
    assert client.get(env["projects_url"]).status_code == 200
    assert client.get(f"/api/research/workspaces/{env['workspace'].slug}/approval-requests/").status_code == 403


@pytest.mark.django_db
def test_workspace_admin_without_org_relation_has_full_research_project_access(env):
    """工作区管理员无需加入科研组织即可浏览并管理所有科研项目。"""
    from plane.db.models import ResearchChain

    enable_research(env["workspace"], research_chain_enabled=True)
    admin = make_user(first_name="Workspace admin without research unit")
    add_workspace_member(env["workspace"], admin, role=20)
    project = Project.objects.create(
        workspace=env["workspace"],
        name="管理员可见课题",
        identifier="ADMIN01",
        created_by=admin,
    )
    profile = ResearchProjectProfile.objects.create(
        workspace=env["workspace"],
        project=project,
        owner=env["student"],
        org_unit=env["group"],
        chain_kind=ResearchProjectProfile.ChainKind.RESEARCH_CHAIN,
        chain_visibility=ResearchProjectProfile.ChainVisibility.PRIVATE,
        workflow_status=ResearchProjectProfile.WorkflowStatus.ACTIVE,
        created_by=admin,
    )
    chain = ResearchChain.objects.create(
        workspace=env["workspace"],
        project=project,
        owner=env["student"],
        visibility=profile.chain_visibility,
        request_id="admin-without-org-chain",
        payload_hash="admin-without-org-chain",
        created_by=admin,
    )
    admin_client = client_for(admin)

    identity = identity_of(env, admin)
    assert identity["user"]["org_units"] == []
    assert identity["user"]["research_level"] == "ADMIN"
    assert "research_chain" in identity["capabilities"]["nav"]
    project_list = admin_client.get(env["projects_url"])
    assert project_list.status_code == 200
    assert project.name in str(project_list.json())

    tree = admin_client.get(
        f"/api/research/workspaces/{env['workspace'].slug}/navigation/categories/",
        {"scope": "RESEARCH"},
    )
    assert tree.status_code == 200
    assert project.name in str(tree.json())

    chains = admin_client.get(f"/api/research/workspaces/{env['workspace'].slug}/chains/")
    assert chains.status_code == 200
    assert str(chain.id) in [row["id"] for row in chains.json()["results"]]

    update = admin_client.patch(
        f"/api/research/workspaces/{env['workspace'].slug}/projects/{project.id}/",
        {"name": "管理员已更新课题"},
        format="json",
    )
    assert update.status_code == 200, update.json()


@pytest.mark.django_db
def test_seated_instance_admin_has_top_research_capabilities_without_org_assignment(env):
    """已加入工作区的实例管理员无科研组织关系也拥有最高科研级别。"""
    from plane.license.models import Instance, InstanceAdmin

    enable_research(env["workspace"], research_chain_enabled=True)
    instance = Instance.objects.create(
        instance_name="Research navigation test",
        instance_id="research-admin-capabilities",
        current_version="test",
    )
    admin = make_user(first_name="Seated instance admin")
    add_workspace_member(env["workspace"], admin)
    InstanceAdmin.objects.create(instance=instance, user=admin)

    identity = identity_of(env, admin)
    assert identity["user"]["org_units"] == []
    assert identity["user"]["research_level"] == "ADMIN"
    assert {"research_chain", "projects", "platform", "audit"}.issubset(identity["capabilities"]["nav"])


@pytest.mark.django_db
def test_instance_admin_without_workspace_seat_cannot_access_research_workspace(env):
    """实例管理员仍须是当前工作区成员，不能跨工作区读取科研数据。"""
    from plane.license.models import Instance, InstanceAdmin

    instance = Instance.objects.create(
        instance_name="Unseated research admin test",
        instance_id="unseated-research-admin",
        current_version="test",
    )
    admin = make_user(first_name="Unseated instance admin")
    InstanceAdmin.objects.create(instance=instance, user=admin)

    response = client_for(admin).get(env["identity_url"])
    assert response.status_code == 404
    assert response.json()["error_code"] == "research_workspace_not_found"


def test_review_inbox_opens_for_the_assigned_reviewer(env):
    from plane.db.models import StageReviewerAssignment

    client = client_for(env["student"])
    assert client.get(env["reviews_url"]).status_code == 403

    project = Project.objects.create(
        workspace=env["workspace"], name="Stage project", identifier="NAV1", created_by=env["admin"]
    )
    ResearchProjectProfile.objects.create(
        project=project,
        workspace=env["workspace"],
        owner=env["student"],
        org_unit=env["group"],
        research_type=ResearchProjectProfile.ResearchType.PHD,
        workflow_status=ResearchProjectProfile.WorkflowStatus.ACTIVE,
        created_by=env["admin"],
    )
    stage = ResearchStageInstance.objects.create(
        workspace=env["workspace"],
        project=project,
        org_unit=env["group"],
        stage="OPENING",
        status=ResearchStageInstance.Status.SUBMITTED,
        sort_order=2,
        created_by=env["admin"],
    )
    StageReviewerAssignment.objects.create(
        stage_instance=stage,
        reviewer=env["student"],
        reviewer_role="REVIEWER",
        is_required=False,
        assignment_kind=StageReviewerAssignment.AssignmentKind.MANUAL,
    )

    identity = identity_of(env, env["student"])
    assert identity["capabilities"]["level"] == "MENTOR"
    assert "reviews" in identity["capabilities"]["nav"]
    assert client.get(env["reviews_url"]).status_code == 200


def test_bystander_is_refused_on_every_gated_surface(env):
    client = client_for(env["bystander"])

    for url in (
        env["summary_url"],
        env["aggregate_url"],
        env["templates_url"],
        env["audit_url"],
        env["settings_url"],
        env["reviews_url"],
        f"/api/research/workspaces/{env['workspace'].slug}/reports/",
        env["projects_url"],
    ):
        response = client.get(url)
        assert response.status_code == 403, url
        assert response.json()["error_code"] == "research_permission_denied", url
