"""Organization participation stays live and never grants access to private projects."""

from unittest.mock import patch

import pytest
from rest_framework.test import APIClient

from plane.db.models import (
    AdministrativeOrganization,
    AdministrativeOrganizationMember,
    Issue,
    IssueAssignee,
    Project,
    ProjectMember,
    ProjectNetwork,
    ResearchProjectProfile,
    State,
    WorkspaceMember,
)
from plane.tests.research_fixtures import make_user
from plane.utils.administrative_projects import (
    assignable_project_member_ids,
    effective_project_member,
    project_member_roster,
)

pytestmark = [pytest.mark.contract, pytest.mark.django_db]


@pytest.fixture
def inherited(workspace, create_user):
    user = make_user(first_name="Inherited")
    outsider = make_user(first_name="Outsider")
    for member in (user, outsider):
        WorkspaceMember.objects.create(workspace=workspace, member=member, role=15)
    organization = AdministrativeOrganization.objects.create(workspace=workspace, name="Office")
    relation = AdministrativeOrganizationMember.objects.create(
        workspace=workspace,
        organization=organization,
        member=user,
        role="MEMBER",
    )
    project = Project.objects.create(
        workspace=workspace,
        name="Office work",
        identifier="OFF",
        network=ProjectNetwork.PUBLIC.value,
        administrative_organization=organization,
        created_by=create_user,
    )
    State.objects.create(workspace=workspace, project=project, name="Todo", group="unstarted", default=True)
    client = APIClient()
    client.force_authenticate(user=user)
    owner_client = APIClient()
    owner_client.force_authenticate(user=create_user)
    with (
        patch("plane.app.views.issue.base.issue_activity.delay"),
        patch("plane.app.views.issue.base.model_activity.delay"),
        patch("plane.app.views.issue.base.issue_description_version_task.delay"),
        patch("plane.app.views.issue.base.recent_visited_task.delay"),
        patch("plane.app.views.project.base.recent_visited_task.delay"),
    ):
        yield {
            "user": user,
            "outsider": outsider,
            "relation": relation,
            "organization": organization,
            "project": project,
            "client": client,
            "owner_client": owner_client,
            "base": f"/api/workspaces/{workspace.slug}/projects/{project.id}/",
        }


def test_inherited_member_is_listed_once_and_can_participate(inherited, workspace):
    env = inherited
    assert effective_project_member(env["user"], workspace.slug, env["project"].id).role == 15
    rows = env["client"].get(env["base"] + "members/")
    assert rows.status_code == 200, rows.data
    assert rows.data == [
        {
            "id": None,
            "member": str(env["user"].id),
            "role": 15,
            "original_role": None,
            "created_at": None,
            "membership_source": "ORGANIZATION",
            "inherits_organization": True,
        }
    ]
    roles = env["client"].get(f"/api/users/me/workspaces/{workspace.slug}/project-roles/")
    assert roles.data[str(env["project"].id)] == 15
    projects = env["client"].get(f"/api/workspaces/{workspace.slug}/projects/")
    assert next(row for row in projects.data if str(row["id"]) == str(env["project"].id))["member_role"] == 15
    me = env["client"].get(env["base"] + "project-members/me/")
    assert me.status_code == 200 and me.data["role"] == 15
    assert not ProjectMember.objects.filter(project=env["project"], member=env["user"]).exists()


def test_administrative_role_endpoint_promotes_and_downgrades_inherited_member(inherited, workspace):
    """组织继承成员提升后建立直接授权，降级后保留直接成员关系。"""
    env = inherited
    endpoint = env["base"] + f"members/by-user/{env['user'].id}/role/"

    promoted = env["owner_client"].patch(endpoint, {"role": 20}, format="json")
    assert promoted.status_code == 200, promoted.data
    direct = ProjectMember.objects.get(project=env["project"], member=env["user"])
    assert direct.is_active and direct.role == 20
    assert promoted.data["id"] == str(direct.id)
    assert promoted.data["membership_source"] == "DIRECT"
    assert promoted.data["inherits_organization"] is True

    downgraded = env["owner_client"].patch(endpoint, {"role": 15}, format="json")
    assert downgraded.status_code == 200, downgraded.data
    direct.refresh_from_db()
    assert direct.is_active and direct.role == 15
    assert downgraded.data["id"] == str(direct.id)
    assert downgraded.data["membership_source"] == "DIRECT"
    assert downgraded.data["inherits_organization"] is True


def test_administrative_role_endpoint_does_not_create_member_grant_for_inherited_member_role(inherited):
    """纯组织继承成员选择成员时不产生冗余直接关系。"""
    env = inherited
    response = env["owner_client"].patch(
        env["base"] + f"members/by-user/{env['user'].id}/role/",
        {"role": 15},
        format="json",
    )
    assert response.status_code == 200, response.data
    assert response.data["id"] is None
    assert response.data["membership_source"] == "ORGANIZATION"
    assert not ProjectMember.objects.filter(project=env["project"], member=env["user"]).exists()


def test_project_admin_can_promote_inherited_member_only_in_administrative_project(inherited, workspace):
    """行政项目管理员可将低权限继承成员提升为管理员。"""
    env = inherited
    project_admin = make_user(first_name="Project", last_name="Admin")
    WorkspaceMember.objects.create(workspace=workspace, member=project_admin, role=15)
    ProjectMember.objects.create(project=env["project"], member=project_admin, role=20)
    client = APIClient()
    client.force_authenticate(user=project_admin)

    response = client.patch(
        env["base"] + f"members/by-user/{env['user'].id}/role/",
        {"role": 20},
        format="json",
    )
    assert response.status_code == 200, response.data
    assert ProjectMember.objects.filter(project=env["project"], member=env["user"], role=20, is_active=True).exists()


def test_administrative_role_endpoint_rejects_research_projects(inherited, workspace, create_user):
    """科研项目继续使用原有角色接口，不接受行政项目按用户角色入口。"""
    from plane.db.models import ResearchProjectProfile

    env = inherited
    ResearchProjectProfile.objects.create(workspace=workspace, project=env["project"], owner=create_user)
    response = env["owner_client"].patch(
        env["base"] + f"members/by-user/{env['user'].id}/role/",
        {"role": 20},
        format="json",
    )
    assert response.status_code == 403, response.data
    assert not ProjectMember.objects.filter(project=env["project"], member=env["user"]).exists()


def test_administrative_role_endpoint_rejects_workspace_guest_admin_promotion(inherited, workspace):
    """工作区访客不能被提升为行政项目管理员。"""
    env = inherited
    WorkspaceMember.objects.filter(workspace=workspace, member=env["user"]).update(role=5)
    response = env["owner_client"].patch(
        env["base"] + f"members/by-user/{env['user'].id}/role/",
        {"role": 20},
        format="json",
    )
    assert response.status_code == 400, response.data
    assert not ProjectMember.objects.filter(project=env["project"], member=env["user"]).exists()


@pytest.mark.parametrize("direct_role,expected", [(5, 15), (15, 15), (20, 20)])
def test_direct_grant_and_inheritance_are_merged(inherited, workspace, direct_role, expected):
    env = inherited
    member = ProjectMember.objects.create(project=env["project"], member=env["user"], role=direct_role)
    rows = project_member_roster(env["project"])
    assert len(rows) == 1
    assert rows[0]["id"] == str(member.id)
    assert rows[0]["role"] == expected
    assert rows[0]["original_role"] == direct_role
    assert rows[0]["membership_source"] == "DIRECT" and rows[0]["inherits_organization"]
    assert effective_project_member(env["user"], workspace.slug, env["project"].id).role == expected
    roles = env["client"].get(f"/api/users/me/workspaces/{workspace.slug}/project-roles/")
    assert roles.data[str(env["project"].id)] == expected
    me = env["client"].get(env["base"] + "project-members/me/")
    assert me.data["role"] == expected
    member.is_active = False
    member.save()
    assert project_member_roster(env["project"])[0]["membership_source"] == "ORGANIZATION"


def test_inherited_member_can_create_and_assign_work_item(inherited, workspace, create_user):
    """Inherited project members can create a directly assigned work item."""
    env = inherited
    response = env["client"].post(
        env["base"] + "issues/",
        {"name": "Office request", "assignee_ids": [str(env["user"].id)]},
        format="json",
    )
    assert response.status_code == 201, response.data
    issue = Issue.objects.get(pk=response.data["id"])
    assert list(issue.assignees.values_list("id", flat=True)) == [env["user"].id]


def test_outside_member_cannot_be_assigned(inherited):
    env = inherited
    response = env["client"].post(
        env["base"] + "issues/",
        {
            "name": "Invalid assignment",
            "assignee_ids": [str(env["outsider"].id)],
        },
        format="json",
    )
    assert response.status_code == 400, response.data


def test_assignment_survives_task_reads_and_updates(inherited, workspace, create_user):
    env = inherited
    project = env["project"]
    issue = Issue.objects.create(project=project, workspace=workspace, name="Assigned work", created_by=create_user)
    IssueAssignee.objects.create(issue=issue, project=project, workspace=workspace, assignee=env["user"])
    paths = [
        (env["base"] + f"issues/{issue.id}/", False),
        (env["base"] + "v2/issues/", True),
        (f"/api/workspaces/{workspace.slug}/work-items/{project.identifier}-{issue.sequence_id}/", False),
    ]
    for path, paginated in paths:
        response = env["client"].get(path)
        assert response.status_code == 200, response.data
        row = response.data["results"][0] if paginated else response.data
        assert {str(value) for value in row["assignee_ids"]} == {str(env["user"].id)}, response.data
    updated = env["client"].patch(env["base"] + f"issues/{issue.id}/", {"name": "Updated work"}, format="json")
    assert updated.status_code == 204, updated.data
    reopened = env["client"].get(env["base"] + f"issues/{issue.id}/")
    assert {str(value) for value in reopened.data["assignee_ids"]} == {str(env["user"].id)}
    # An extra guest grant must not restrict inherited participants to their own tasks.
    ProjectMember.objects.create(project=project, member=env["user"], role=5)
    assert env["client"].get(env["base"] + f"issues/{issue.id}/").status_code == 200


def test_inherited_member_can_be_project_lead_and_default_assignee(inherited):
    env = inherited
    response = env["owner_client"].patch(
        env["base"],
        {
            "project_lead": str(env["user"].id),
            "default_assignee": str(env["user"].id),
        },
        format="json",
    )
    assert response.status_code == 200, response.data
    created = env["client"].post(env["base"] + "issues/", {"name": "Default assignment"}, format="json")
    assert created.status_code == 201, created.data
    assert list(Issue.objects.get(pk=created.data["id"]).assignees.values_list("id", flat=True)) == [env["user"].id]


@pytest.mark.parametrize("grant", [False, True])
def test_removing_organization_membership_revokes_only_inheritance(inherited, workspace, grant):
    env = inherited
    if grant:
        ProjectMember.objects.create(project=env["project"], member=env["user"], role=15)
    env["relation"].is_active = False
    env["relation"].save()
    rows = project_member_roster(env["project"])
    assert len(rows) == int(grant)
    assert (env["user"].id in assignable_project_member_ids(env["project"])) == grant
    member = effective_project_member(env["user"], workspace.slug, env["project"].id)
    assert (member is not None) == grant
    assert env["client"].get(env["base"]).status_code == (200 if grant else 403)


@pytest.mark.parametrize("boundary", ["private", "research", "workspace_inactive", "organization_deleted"])
def test_inheritance_respects_boundaries(inherited, workspace, create_user, boundary):
    env = inherited
    if boundary == "private":
        env["project"].network = ProjectNetwork.SECRET.value
        env["project"].save()
    elif boundary == "research":
        ResearchProjectProfile.objects.create(workspace=workspace, project=env["project"], owner=create_user)
    elif boundary == "workspace_inactive":
        WorkspaceMember.objects.filter(workspace=workspace, member=env["user"]).update(is_active=False)
    else:
        from django.utils import timezone

        env["organization"].deleted_at = timezone.now()
        env["organization"].save()
    assert list(assignable_project_member_ids(env["project"])) == []
    assert project_member_roster(env["project"]) == []
    assert effective_project_member(env["user"], workspace.slug, env["project"].id) is None


def test_private_project_still_accepts_direct_members(inherited, workspace):
    env = inherited
    env["project"].network = ProjectNetwork.SECRET.value
    env["project"].save()
    ProjectMember.objects.create(project=env["project"], member=env["user"], role=15)
    assert list(assignable_project_member_ids(env["project"])) == [env["user"].id]
    assert not project_member_roster(env["project"])[0]["inherits_organization"]


def test_organization_admin_does_not_inherit_project_administration(inherited, workspace):
    env = inherited
    env["relation"].role = "ADMIN"
    env["relation"].save()
    assert effective_project_member(env["user"], workspace.slug, env["project"].id).role == 15
    assert env["client"].patch(env["base"], {"name": "Unauthorized"}, format="json").status_code == 403
