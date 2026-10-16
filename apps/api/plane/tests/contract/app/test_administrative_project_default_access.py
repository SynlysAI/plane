"""验证行政项目默认管理权限及其身份、工作区和科研项目边界。"""

from unittest.mock import patch

import pytest
from rest_framework.test import APIClient

from plane.db.models import (
    Cycle,
    CycleIssue,
    Issue,
    Module,
    ModuleLink,
    Page,
    Project,
    ProjectMember,
    ProjectPage,
    ResearchProjectProfile,
    State,
    WorkspaceMember,
    WorkspaceResearchSetting,
)
from plane.license.models import Instance, InstanceAdmin
from plane.tests.research_fixtures import make_user

pytestmark = [pytest.mark.contract, pytest.mark.django_db]


@pytest.fixture
def env(workspace, create_user):
    """创建带普通成员名单和公开页面的私有行政项目。"""
    project = Project.objects.create(workspace=workspace, name="Administrative", identifier="ADM", network=0)
    ProjectMember.objects.create(project=project, member=create_user, role=20)
    state = State.objects.create(project=project, workspace=workspace, name="Todo", group="unstarted", default=True)
    issue = Issue.objects.create(project=project, workspace=workspace, name="Existing task", state=state)
    page = Page.objects.create(workspace=workspace, owned_by=create_user, name="Administrative page", access=0)
    ProjectPage.objects.create(project=project, page=page, workspace=workspace)
    cycle = Cycle.objects.create(
        project=project, workspace=workspace, name="Administrative cycle", owned_by=create_user
    )
    CycleIssue.objects.create(project=project, issue=issue, cycle=cycle)
    module = Module.objects.create(project=project, workspace=workspace, name="Administrative module")
    module_link = ModuleLink.objects.create(
        project=project, module=module, title="Reference", url="https://example.com"
    )
    return {
        "workspace": workspace,
        "project": project,
        "issue": issue,
        "page": page,
        "owner": create_user,
        "cycle": cycle,
        "module": module,
        "module_link": module_link,
    }


@pytest.fixture(autouse=True)
def no_side_effects():
    """屏蔽异步任务，测试只验证接口权限和数据库结果。"""
    with (
        patch("plane.app.views.project.base.recent_visited_task.delay"),
        patch("plane.app.views.project.base.model_activity.delay"),
        patch("plane.app.views.issue.base.issue_activity.delay"),
        patch("plane.app.views.issue.base.model_activity.delay"),
        patch("plane.app.views.issue.base.issue_description_version_task.delay"),
    ):
        yield


def actor_client(env, identity):
    """创建指定身份的工作区用户和客户端。

    Args:
        env: 行政项目测试环境。
        identity: 工作区管理员、实例管理员、主 PI 或普通成员。

    Returns:
        用户和已认证客户端。
    """
    user = make_user(first_name=identity)
    WorkspaceMember.objects.create(workspace=env["workspace"], member=user, role=20 if identity == "admin" else 15)
    if identity == "instance_admin":
        instance = Instance.objects.create(instance_name="Test", instance_id=str(user.id), current_version="1.0.0")
        InstanceAdmin.objects.create(instance=instance, user=user)
    if identity == "main_pi":
        WorkspaceResearchSetting.objects.create(
            workspace=env["workspace"], purpose=WorkspaceResearchSetting.Purpose.PUBLIC_RESEARCH, main_pi=user
        )
    client = APIClient()
    client.force_authenticate(user=user)
    return user, client


@pytest.mark.parametrize("identity", ["admin", "instance_admin", "main_pi"])
@pytest.mark.parametrize("existing_role", [None, 5, 15])
def test_default_admin_can_read_and_write_without_joining(env, identity, existing_role):
    """管理员和主 PI 无成员记录也能打开和修改行政项目。"""
    user, client = actor_client(env, identity)
    if existing_role is not None:
        ProjectMember.objects.create(project=env["project"], member=user, role=existing_role)
    slug = env["workspace"].slug
    base = f"/api/workspaces/{slug}/projects/{env['project'].id}/"
    roles = client.get(f"/api/users/me/workspaces/{slug}/project-roles/")
    assert roles.status_code == 200, roles.data
    assert roles.data[str(env["project"].id)] == 20
    for path in ("projects/", "projects/details/"):
        projects = client.get(f"/api/workspaces/{slug}/{path}")
        assert projects.status_code == 200, projects.data
        row = next(row for row in projects.data if str(row["id"]) == str(env["project"].id))
        assert row["member_role"] == 20
    detail = client.get(base)
    assert detail.status_code == 200 and detail.data["member_role"] == 20
    me = client.get(f"{base}project-members/me/")
    assert me.status_code == 200 and me.data["role"] == 20
    assert client.get(f"{base}members/").status_code == 200
    member = ProjectMember.objects.get(project=env["project"], member=env["owner"])
    assert client.get(f"{base}members/{member.id}/").status_code == 200
    properties = client.get(f"{base}user-properties/")
    assert properties.status_code == 200, properties.data
    states = client.get(f"{base}states/")
    assert states.status_code == 200 and len(states.data) == 1
    issues = client.get(f"{base}issues/")
    assert issues.status_code == 200, issues.data
    assert client.get(f"{base}issues/{env['issue'].id}/").status_code == 200
    pages = client.get(f"{base}pages/")
    assert pages.status_code == 200 and any(str(row["id"]) == str(env["page"].id) for row in pages.data)
    cycle_issues = client.get(f"{base}cycles/{env['cycle'].id}/cycle-issues/")
    assert cycle_issues.status_code == 200, cycle_issues.data
    links = client.get(f"{base}modules/{env['module'].id}/module-links/")
    assert links.status_code == 200, links.data
    assert any(str(row["id"]) == str(env["module_link"].id) for row in links.data)
    created = client.post(f"{base}issues/", {"name": "Default admin task"}, format="json")
    assert created.status_code == 201, created.data
    updated = client.patch(base, {"description": "Managed by default"}, format="json")
    assert updated.status_code == 200, updated.data
    memberships = ProjectMember.objects.filter(project=env["project"], member=user)
    if existing_role is None:
        assert not memberships.exists()
    else:
        assert memberships.get().role == existing_role


def test_ordinary_member_still_needs_project_membership(env):
    """普通成员不能获得私有行政项目的默认权限。"""
    _, client = actor_client(env, "member")
    slug = env["workspace"].slug
    base = f"/api/workspaces/{slug}/projects/{env['project'].id}/"
    roles = client.get(f"/api/users/me/workspaces/{slug}/project-roles/")
    assert str(env["project"].id) not in roles.data
    assert client.get(base).status_code == 403
    assert client.get(f"{base}issues/").status_code == 403
    assert client.post(f"{base}issues/", {"name": "Denied"}, format="json").status_code == 403


@pytest.mark.parametrize("identity", ["admin", "instance_admin", "main_pi"])
def test_research_projects_do_not_receive_default_write_access(env, identity):
    """行政项目默认权限不能扩大科研项目写权限。"""
    _, client = actor_client(env, identity)
    ResearchProjectProfile.objects.create(project=env["project"], workspace=env["workspace"], owner=env["owner"])
    base = f"/api/workspaces/{env['workspace'].slug}/projects/{env['project'].id}/"
    assert client.post(f"{base}issues/", {"name": "Denied research write"}, format="json").status_code == 403


@pytest.mark.parametrize("identity", ["admin", "instance_admin", "main_pi"])
def test_revoking_identity_removes_default_access(env, identity):
    """默认权限随身份撤销即时消失，不遗留项目成员权限。"""
    user, client = actor_client(env, identity)
    if identity == "admin":
        WorkspaceMember.objects.filter(workspace=env["workspace"], member=user).update(role=15)
    elif identity == "instance_admin":
        InstanceAdmin.objects.filter(user=user).delete()
    else:
        WorkspaceResearchSetting.objects.filter(workspace=env["workspace"]).update(main_pi=None)
    base = f"/api/workspaces/{env['workspace'].slug}/projects/{env['project'].id}/"
    assert client.get(f"{base}issues/").status_code == 403


def test_default_access_requires_active_workspace_membership(env):
    """默认权限不绕过工作区成员准入。"""
    user, client = actor_client(env, "instance_admin")
    WorkspaceMember.objects.filter(workspace=env["workspace"], member=user).update(is_active=False)
    base = f"/api/workspaces/{env['workspace'].slug}/projects/{env['project'].id}/"
    assert client.get(f"{base}issues/").status_code == 403


def test_workspace_admin_cannot_bypass_private_workspace_gate(env):
    """历史工作区管理员身份不能绕过 PI 私有工作区准入。"""
    _, client = actor_client(env, "admin")
    WorkspaceResearchSetting.objects.create(
        workspace=env["workspace"], purpose=WorkspaceResearchSetting.Purpose.PI_PRIVATE
    )
    base = f"/api/workspaces/{env['workspace'].slug}/projects/{env['project'].id}/"
    assert client.get(f"{base}issues/").status_code == 403


def test_public_administrative_project_readable_by_every_member(env):
    """默认公共组织下的公共项目对全体成员只读开放，无需加入项目。"""
    from plane.db.models.project import ProjectNetwork
    from plane.utils.administrative_projects import get_or_create_default_administrative_organization

    public_project = Project.objects.create(
        workspace=env["workspace"],
        name="公共项目测试",
        identifier="PUB",
        network=ProjectNetwork.PUBLIC.value,
        administrative_organization=get_or_create_default_administrative_organization(env["workspace"]),
    )
    state = State.objects.create(
        project=public_project, workspace=env["workspace"], name="Todo", group="unstarted", default=True
    )
    Issue.objects.create(project=public_project, workspace=env["workspace"], name="Public task", state=state)
    page = Page.objects.create(workspace=env["workspace"], owned_by=env["owner"], name="Public page", access=0)
    ProjectPage.objects.create(project=public_project, page=page, workspace=env["workspace"])

    _, client = actor_client(env, "member")
    slug = env["workspace"].slug
    base = f"/api/workspaces/{slug}/projects/{public_project.id}/"

    # 权限地图必须包含公共项目，否则前端会把列表可见的项目显示成“未找到项目”。
    roles = client.get(f"/api/users/me/workspaces/{slug}/project-roles/")
    assert roles.status_code == 200, roles.data
    assert roles.data[str(public_project.id)] == 15

    detail = client.get(base)
    assert detail.status_code == 200, detail.data
    assert detail.data["member_role"] == 15
    assert client.get(f"{base}issues/").status_code == 200
    assert client.get(f"{base}states/").status_code == 200
    assert client.get(f"{base}members/").status_code == 200
    assert client.get(f"{base}pages/").status_code == 200
    # 公共行政项目对全员按 MEMBER 开放（effective_project_member 既有口径），可协作创建工作项。
    assert client.post(f"{base}issues/", {"name": "Public collaboration"}, format="json").status_code == 201
