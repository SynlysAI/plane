"""成员资料页项目列表的可见性契约测试。

资料页项目列表必须展示“目标用户参与且当前用户可见”的交集项目，
避免查看他人资料时仍列出当前用户自己的项目。
"""

from django.utils import timezone
import pytest
from rest_framework import status
from rest_framework.test import APIClient

from plane.db.models import (
    Issue,
    IssueAssignee,
    Project,
    ProjectMember,
    State,
    WorkspaceMember,
)
from plane.tests.research_fixtures import make_user

pytestmark = [pytest.mark.contract, pytest.mark.django_db]


def _make_project(workspace, name, identifier, created_by, *, archived=False):
    """创建测试项目并初始化默认状态。"""
    project = Project.objects.create(
        workspace=workspace,
        name=name,
        identifier=identifier,
        created_by=created_by,
        archived_at=timezone.now() if archived else None,
    )
    State.objects.create(
        workspace=workspace,
        project=project,
        name="待处理",
        group="unstarted",
        default=True,
    )
    return project


def _add_project_member(project, user, *, is_active=True, deleted=False):
    """为项目添加一条成员记录，支持构造停用或软删除场景。"""
    return ProjectMember.objects.create(
        workspace=project.workspace,
        project=project,
        member=user,
        role=15,
        is_active=is_active,
        deleted_at=timezone.now() if deleted else None,
    )


def _profile_url(workspace, target):
    """返回目标用户的资料接口地址。"""
    return f"/api/workspaces/{workspace.slug}/user-profile/{target.id}/"


@pytest.fixture
def profile_env(workspace, create_user):
    """构造工作区、目标成员与不同成员组成的项目集合。"""
    target = make_user(first_name="Target", last_name="Member")
    WorkspaceMember.objects.create(workspace=workspace, member=target, role=15, is_active=True)

    shared = _make_project(workspace, "共同项目", "SHRD", create_user)
    _add_project_member(shared, create_user)
    _add_project_member(shared, target)

    mine_only = _make_project(workspace, "仅我参与", "MINE", create_user)
    _add_project_member(mine_only, create_user)

    theirs_only = _make_project(workspace, "仅对方参与", "THEIR", create_user)
    _add_project_member(theirs_only, target)

    inactive = _make_project(workspace, "对方已停用", "INACT", create_user)
    _add_project_member(inactive, create_user)
    _add_project_member(inactive, target, is_active=False)

    deleted = _make_project(workspace, "对方已移除", "DELED", create_user)
    _add_project_member(deleted, create_user)
    _add_project_member(deleted, target, deleted=True)

    archived = _make_project(workspace, "归档共同项目", "ARCH", create_user, archived=True)
    _add_project_member(archived, create_user)
    _add_project_member(archived, target)

    return {
        "requester": create_user,
        "target": target,
        "shared": shared,
        "mine_only": mine_only,
        "theirs_only": theirs_only,
        "inactive": inactive,
        "deleted": deleted,
        "archived": archived,
    }


def _fetch_projects(workspace, requester, target):
    """以指定用户身份请求资料接口并返回项目列表。"""
    client = APIClient()
    client.force_authenticate(user=requester)
    response = client.get(_profile_url(workspace, target))
    assert response.status_code == status.HTTP_200_OK, response.data
    return [{**row, "id": str(row["id"])} for row in response.data["project_data"]]


def test_project_list_shows_shared_projects_only(workspace, profile_env):
    """资料页只返回双方均为活跃成员的项目。"""
    projects = _fetch_projects(workspace, profile_env["requester"], profile_env["target"])
    project_ids = {row["id"] for row in projects}

    assert project_ids == {str(profile_env["shared"].id)}
    shared_row = projects[0]
    assert shared_row["name"] == "共同项目"


def test_own_profile_still_lists_own_projects(workspace, profile_env):
    """查看自己的资料时仍返回自己参与的项目。"""
    requester = profile_env["requester"]
    projects = _fetch_projects(workspace, requester, requester)
    project_ids = {row["id"] for row in projects}

    assert project_ids == {
        str(profile_env["shared"].id),
        str(profile_env["mine_only"].id),
        str(profile_env["inactive"].id),
        str(profile_env["deleted"].id),
    }


def test_project_stats_count_target_issues_in_shared_project(workspace, profile_env):
    """项目统计仍按目标用户在该项目中的工作项计数。"""
    shared = profile_env["shared"]
    target = profile_env["target"]
    requester = profile_env["requester"]

    target_issue = Issue.objects.create(
        workspace=workspace,
        project=shared,
        name="对方创建并负责的工作项",
        created_by=target,
    )
    # 模型基类保存时会用线程当前用户覆盖 created_by，这里显式改为目标用户。
    Issue.objects.filter(pk=target_issue.pk).update(created_by=target)
    assigned_issue = Issue.objects.create(
        workspace=workspace,
        project=shared,
        name="对方仅负责的工作项",
        created_by=requester,
    )
    IssueAssignee.objects.create(
        workspace=workspace,
        project=shared,
        issue=target_issue,
        assignee=target,
    )
    Issue.objects.create(
        workspace=workspace,
        project=shared,
        name="对方创建的草稿",
        created_by=target,
        is_draft=True,
    )
    Issue.objects.filter(name="对方创建的草稿").update(created_by=target)
    IssueAssignee.objects.create(
        workspace=workspace,
        project=shared,
        issue=assigned_issue,
        assignee=target,
    )

    projects = _fetch_projects(workspace, requester, target)
    shared_row = next(row for row in projects if row["id"] == str(shared.id))

    assert shared_row["created_issues"] == 1
    assert shared_row["assigned_issues"] == 2


def test_viewer_role_does_not_receive_project_data(workspace, profile_env):
    """工作区访客角色不返回项目列表，保持原有权限门控。"""
    viewer = make_user(first_name="Viewer", last_name="Guest")
    WorkspaceMember.objects.create(workspace=workspace, member=viewer, role=10, is_active=True)
    _add_project_member(profile_env["shared"], viewer)

    projects = _fetch_projects(workspace, viewer, profile_env["target"])

    assert projects == []
