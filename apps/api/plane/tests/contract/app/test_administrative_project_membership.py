"""验证行政项目只能由有效成员或默认管理身份访问。"""

from unittest.mock import patch

import pytest
from rest_framework.test import APIClient

from plane.db.models import (
    Project,
    ProjectMember,
    ProjectMemberInvite,
    ProjectUserProperty,
    ResearchProjectProfile,
    Workspace,
    WorkspaceMember,
    WorkspaceResearchSetting,
)
from plane.db.models.api import APIToken
from plane.license.models import Instance, InstanceAdmin
from plane.tests.research_fixtures import make_user

pytestmark = [pytest.mark.contract, pytest.mark.django_db]


@pytest.fixture
def env(workspace, create_user):
    """创建行政项目、科研项目及未加入项目的工作区成员。"""
    user = make_user(first_name="Unassigned")
    membership = WorkspaceMember.objects.create(workspace=workspace, member=user, role=15)
    administrative = Project.objects.create(workspace=workspace, name="Administrative", identifier="ADM", network=2)
    research = Project.objects.create(workspace=workspace, name="Research", identifier="RES", network=2)
    ResearchProjectProfile.objects.create(workspace=workspace, project=research, owner=create_user)
    client = APIClient()
    client.force_authenticate(user=user)
    token = APIToken.objects.create(user=user)
    api = APIClient()
    api.credentials(HTTP_X_API_KEY=token.token)
    return {
        "workspace": workspace,
        "owner": create_user,
        "user": user,
        "membership": membership,
        "administrative": administrative,
        "research": research,
        "client": client,
        "api": api,
    }


@pytest.fixture(autouse=True)
def no_side_effects():
    """屏蔽访问记录和成员通知的异步任务。"""
    with (
        patch("plane.app.views.project.base.recent_visited_task.delay"),
        patch("plane.app.views.project.member.project_add_user_email.delay"),
    ):
        yield


def configure_identity(env, identity):
    """为测试用户配置指定的工作区或管理身份。

    Args:
        env: 项目测试环境。
        identity: 普通成员、访客、工作区管理员、实例管理员或主 PI。
    """
    env["membership"].role = {"admin": 20, "guest": 5}.get(identity, 15)
    env["membership"].save()
    if identity == "instance_admin":
        instance = Instance.objects.create(instance_name="Membership test", instance_id=str(env["user"].id))
        InstanceAdmin.objects.create(instance=instance, user=env["user"])
    elif identity == "main_pi":
        WorkspaceResearchSetting.objects.create(
            workspace=env["workspace"], purpose=WorkspaceResearchSetting.Purpose.PUBLIC_RESEARCH, main_pi=env["user"]
        )


@pytest.mark.parametrize("network", [0, 2])
@pytest.mark.parametrize("identity", ["member", "guest"])
@pytest.mark.parametrize("active", [None, False, True])
def test_lists_and_search_require_active_membership(env, network, identity, active):
    """公开行政项目也必须配置有效成员才能出现在列表和搜索。"""
    configure_identity(env, identity)
    project = env["administrative"]
    project.network = network
    project.save()
    if active is not None:
        ProjectMember.objects.create(project=project, member=env["user"], role=5, is_active=active)
    slug = env["workspace"].slug
    for suffix in ("projects/", "projects/details/"):
        response = env["client"].get(f"/api/workspaces/{slug}/{suffix}")
        assert response.status_code == 200, response.data
        assert (str(project.id) in {str(row["id"]) for row in response.data}) == (active is True)
    for suffix in ("projects/", "projects-lite/"):
        response = env["api"].get(f"/api/v1/workspaces/{slug}/{suffix}")
        assert response.status_code == 200, response.data
        assert (str(project.id) in {str(row["id"]) for row in response.data["results"]}) == (active is True)
    for suffix, params, key in (
        ("entity-search/", {"query_type": "project"}, "project"),
        ("search/", {"entities": "project"}, "results"),
        ("entity-search/", {"query_type": "project", "project_id": str(env["research"].id)}, "project"),
    ):
        response = env["client"].get(f"/api/workspaces/{slug}/{suffix}", params)
        assert response.status_code == 200, response.data
        rows = response.data[key]["project"] if key == "results" else response.data[key]
        assert (str(project.id) in {str(row["id"]) for row in rows}) == (active is True)


@pytest.mark.parametrize("network", [0, 2])
@pytest.mark.parametrize("active", [None, False])
def test_direct_access_is_denied_without_active_membership(env, network, active):
    """直接链接和项目资源不能绕过行政项目成员准入。"""
    project = env["administrative"]
    project.network = network
    project.save()
    if active is not None:
        ProjectMember.objects.create(project=project, member=env["user"], role=15, is_active=active)
    slug = env["workspace"].slug
    for prefix, client in (("/api", env["client"]), ("/api/v1", env["api"])):
        response = client.get(f"{prefix}/workspaces/{slug}/projects/{project.id}/")
        assert response.status_code == 403, response.data
        assert response.data["code"] == "PROJECT_MEMBERSHIP_REQUIRED"
        assert "name" not in response.data
    for resource in ("issues/", "pages/", "states/", "members/"):
        response = env["client"].get(f"/api/workspaces/{slug}/projects/{project.id}/{resource}")
        assert response.status_code == 403, response.data
    response = env["client"].get(
        f"/api/workspaces/{slug}/entity-search/", {"project_id": str(project.id), "query_type": "user_mention"}
    )
    assert response.status_code == 403, response.data


@pytest.mark.parametrize("network", [0, 2])
@pytest.mark.parametrize("identity", ["admin", "instance_admin", "main_pi"])
def test_default_managers_can_access_without_creating_members(env, network, identity):
    """管理身份无需成员记录，应用和外部 API 均可访问行政项目。"""
    configure_identity(env, identity)
    project = env["administrative"]
    project.network = network
    project.save()
    slug = env["workspace"].slug
    for prefix, client in (("/api", env["client"]), ("/api/v1", env["api"])):
        response = client.get(f"{prefix}/workspaces/{slug}/projects/{project.id}/")
        assert response.status_code == 200, response.data
        response = client.get(f"{prefix}/workspaces/{slug}/projects/")
        assert response.status_code == 200, response.data
        rows = response.data["results"] if prefix == "/api/v1" else response.data
        assert str(project.id) in {str(row["id"]) for row in rows}
    response = env["client"].get(f"/api/workspaces/{slug}/entity-search/", {"query_type": "project"})
    assert response.status_code == 200, response.data
    assert str(project.id) in {str(row["id"]) for row in response.data["project"]}
    assert not ProjectMember.objects.filter(project=project, member=env["user"]).exists()


@pytest.mark.parametrize("identity", ["member", "guest", "admin", "instance_admin", "main_pi"])
@pytest.mark.parametrize("network", [0, 2])
def test_self_join_rejects_entire_batch_without_writes(env, identity, network):
    """任何身份均不能自行加入行政项目，混合批量拒绝后不得部分写入。"""
    configure_identity(env, identity)
    project = env["administrative"]
    project.network = network
    project.save()
    inactive = ProjectMember.objects.create(project=project, member=env["user"], role=5, is_active=False)
    research_member = ProjectMember.objects.create(project=env["research"], member=env["user"], role=5, is_active=False)
    properties_before = list(ProjectUserProperty.objects.filter(user=env["user"]).values())
    response = env["client"].post(
        f"/api/users/me/workspaces/{env['workspace'].slug}/projects/invitations/",
        {"project_ids": [str(env["research"].id), str(project.id)]},
        format="json",
    )
    assert response.status_code == 403, response.data
    inactive.refresh_from_db()
    research_member.refresh_from_db()
    assert inactive.is_active is False and inactive.role == 5
    assert research_member.is_active is False
    assert list(ProjectUserProperty.objects.filter(user=env["user"]).values()) == properties_before


@pytest.mark.parametrize("identity", ["member", "admin"])
def test_single_self_join_does_not_create_administrative_members(env, identity):
    """拒绝单个行政项目的自行加入，不产生任何隐式成员。"""
    configure_identity(env, identity)
    response = env["client"].post(
        f"/api/users/me/workspaces/{env['workspace'].slug}/projects/invitations/",
        {"project_ids": [str(env["administrative"].id)]},
        format="json",
    )
    assert response.status_code == 403, response.data
    assert response.data["code"] == "PROJECT_MEMBERSHIP_REQUIRED"
    assert not ProjectMember.objects.filter(member=env["user"]).exists()
    assert not ProjectUserProperty.objects.filter(user=env["user"]).exists()


def test_public_research_join_preserves_cross_workspace_scoping(env):
    """科研项目仍可自行加入，其他工作区的项目 ID 不得写入成员关系。"""
    other = Workspace.objects.create(name="Other", slug="other", owner=env["owner"])
    foreign = Project.objects.create(workspace=other, name="Foreign administrative", identifier="OTHER", network=0)
    response = env["client"].post(
        f"/api/users/me/workspaces/{env['workspace'].slug}/projects/invitations/",
        {"project_ids": [str(env["research"].id), str(foreign.id)]},
        format="json",
    )
    assert response.status_code == 201, response.data
    assert ProjectMember.objects.filter(project=env["research"], member=env["user"], is_active=True).exists()
    assert not ProjectMember.objects.filter(project=foreign, member=env["user"]).exists()


@pytest.mark.parametrize("identity,expected", [("member", 403), ("admin", 201)])
def test_private_research_join_keeps_existing_rules(env, identity, expected):
    """科研私有项目继续仅允许工作区管理员自行加入。"""
    configure_identity(env, identity)
    env["research"].network = 0
    env["research"].save()
    response = env["client"].post(
        f"/api/users/me/workspaces/{env['workspace'].slug}/projects/invitations/",
        {"project_ids": [str(env["research"].id)]},
        format="json",
    )
    assert response.status_code == expected, response.data


def test_administrator_can_configure_members(env):
    """工作区管理员配置成员后，被配置用户可以直接访问行政项目。"""
    owner_client = APIClient()
    owner_client.force_authenticate(user=env["owner"])
    slug = env["workspace"].slug
    base = f"/api/workspaces/{slug}/projects/{env['administrative'].id}/"
    response = owner_client.post(
        f"{base}members/", {"members": [{"member_id": str(env["user"].id), "role": 15}]}, format="json"
    )
    assert response.status_code == 201, response.data
    assert env["client"].get(base).status_code == 200


def test_administrator_can_configure_mixed_workspace_roles_in_one_batch(env):
    """一次批量添加不同工作区角色的成员时保持整单成功。"""
    owner_client = APIClient()
    owner_client.force_authenticate(user=env["owner"])
    targets = []
    for index, role in enumerate((20, 15, 5), start=1):
        user = make_user(first_name="Batch", last_name=str(index))
        WorkspaceMember.objects.create(workspace=env["workspace"], member=user, role=role)
        targets.append((user, role))

    response = owner_client.post(
        f"/api/workspaces/{env['workspace'].slug}/projects/{env['administrative'].id}/members/",
        {"members": [{"member_id": str(user.id), "role": role} for user, role in targets]},
        format="json",
    )

    assert response.status_code == 201, response.data
    persisted = ProjectMember.objects.filter(project=env["administrative"], member__in=[user for user, _ in targets])
    assert {str(row.member_id): row.role for row in persisted} == {
        str(user.id): role for user, role in targets
    }


def test_authorized_invitation_can_add_administrative_member(env):
    """管理员发出的有效邀请仍可建立行政项目成员关系。"""
    invitation = ProjectMemberInvite.objects.create(
        project=env["administrative"], workspace=env["workspace"], email=env["user"].email, role=15, token="valid-token"
    )
    response = env["client"].post(
        f"/api/workspaces/{env['workspace'].slug}/projects/{env['administrative'].id}/join/{invitation.id}/",
        {"token": invitation.token, "accepted": True},
        format="json",
    )
    assert response.status_code == 200, response.data
    assert ProjectMember.objects.filter(project=env["administrative"], member=env["user"], is_active=True).exists()
