"""验证首页行政最近访问的筛选、权限、排序与链接关联。"""

from datetime import timedelta
from uuid import uuid4

import pytest
from django.utils import timezone

from plane.db.models import (
    Issue,
    Page,
    Project,
    ProjectMember,
    ProjectPage,
    ResearchChain,
    ResearchProjectProfile,
    State,
    UserRecentVisit,
    WorkspaceMember,
)
from plane.tests.research_fixtures import make_user

pytestmark = [pytest.mark.contract, pytest.mark.django_db]


@pytest.fixture
def env(workspace, create_user, session_client):
    """创建授权行政项目、工作项、页面及当前用户最近访问。

    Args:
        workspace: 测试工作区。
        create_user: 工作区管理员。
        session_client: 已登录当前用户的 API 客户端。

    Returns:
        包含实体、当前用户和接口地址的测试环境。
    """
    project = Project.objects.create(workspace=workspace, name="行政项目", identifier="ADM")
    ProjectMember.objects.create(project=project, workspace=workspace, member=create_user, role=15)
    state = State.objects.create(project=project, workspace=workspace, name="待办", group="backlog")
    issue = Issue.objects.create(project=project, workspace=workspace, state=state, name="行政工作项")
    page = Page.objects.create(workspace=workspace, owned_by=create_user, name="行政页面")
    ProjectPage.objects.create(workspace=workspace, project=project, page=page)
    for name, entity in (("project", project), ("issue", issue), ("page", page)):
        UserRecentVisit.objects.create(
            workspace=workspace, user=create_user, entity_name=name, entity_identifier=entity.id
        )
    return {
        "workspace": workspace,
        "user": create_user,
        "client": session_client,
        "project": project,
        "issue": issue,
        "page": page,
        "url": f"/api/workspaces/{workspace.slug}/recent-visits/",
    }


def rows(env, **params):
    """获取行政范围的访问结果并验证请求成功。

    Args:
        env: 行政最近访问测试环境。
        **params: 追加的查询参数。

    Returns:
        接口返回的最近访问记录列表。
    """
    response = env["client"].get(env["url"], {"scope": "administrative", **params})
    assert response.status_code == 200, response.data
    return response.data


def add_project_visit(env, name="其他项目"):
    """添加当前工作区项目及当前用户访问记录。

    Args:
        env: 行政最近访问测试环境。
        name: 新项目名称。

    Returns:
        新项目及其最近访问记录。
    """
    project = Project.objects.create(workspace=env["workspace"], name=name, identifier=uuid4().hex[:5])
    visit = UserRecentVisit.objects.create(
        workspace=env["workspace"], user=env["user"], entity_name="project", entity_identifier=project.id
    )
    return project, visit


def test_administrative_entities_and_entity_filter(env):
    """项目、工作项和页面均可见，实体类型筛选保持有效。"""
    result = rows(env)
    assert {row["entity_name"] for row in result} == {"project", "issue", "page"}
    assert all(row["entity_data"] for row in result)
    assert {row["entity_name"] for row in rows(env, entity_name="project")} == {"project"}


@pytest.mark.parametrize("relation", ["profile", "chain", "deleted_profile", "deleted_chain"])
def test_excludes_all_research_project_associations(env, relation):
    """软删除科研关联也不能将项目变为行政项目。"""
    if "profile" in relation:
        association = ResearchProjectProfile.objects.create(
            workspace=env["workspace"], project=env["project"], owner=env["user"]
        )
    else:
        association = ResearchChain.objects.create(
            workspace=env["workspace"],
            project=env["project"],
            owner=env["user"],
            request_id="recent-test",
            payload_hash="recent-test",
        )
    if relation.startswith("deleted"):
        type(association).all_objects.filter(pk=association.pk).update(deleted_at=timezone.now())
    assert rows(env) == []


@pytest.mark.parametrize("field", ["archived_at", "deleted_at"])
def test_excludes_inactive_projects_and_related_entities(env, field):
    """项目归档或删除后，项目及其子实体访问均不再显示。"""
    Project.all_objects.filter(pk=env["project"].pk).update(**{field: timezone.now()})
    assert rows(env) == []


def test_member_revocation_removes_project_and_children(env):
    """普通用户退出项目后不能通过历史访问继续读取项目名称和子项。"""
    WorkspaceMember.objects.filter(workspace=env["workspace"], member=env["user"]).update(role=15)
    assert len(rows(env)) == 3
    ProjectMember.objects.filter(project=env["project"], member=env["user"]).update(is_active=False)
    assert rows(env) == []


def test_default_admin_access_does_not_require_project_membership(env):
    """工作区管理员无显式项目成员关系仍可读取行政访问。"""
    ProjectMember.objects.filter(project=env["project"], member=env["user"]).delete()
    assert len(rows(env)) == 3


def test_private_page_access_and_authorized_project_link(env):
    """共享页面链接选取授权行政关联，私有页面仅所有者可见。"""
    other, _ = add_project_visit(env, "无权项目")
    WorkspaceMember.objects.filter(workspace=env["workspace"], member=env["user"]).update(role=15)
    ProjectPage.objects.create(workspace=env["workspace"], project=other, page=env["page"])
    page_row = next(row for row in rows(env) if row["entity_name"] == "page")
    assert str(page_row["entity_data"]["project_id"]) == str(env["project"].id)
    assert page_row["entity_data"]["project_identifier"] == "ADM"
    Page.objects.filter(pk=env["page"].id).update(access=Page.PRIVATE_ACCESS)
    assert any(row["entity_name"] == "page" for row in rows(env))
    Page.objects.filter(pk=env["page"].id).update(owned_by=make_user(first_name="他人"))
    assert not any(row["entity_name"] == "page" for row in rows(env))


def test_filters_before_limit_and_orders_by_visit_time(env):
    """超过 20 条科研访问不会挤占行政记录，返回顺序基于访问时间。"""
    for index in range(21):
        project, _ = add_project_visit(env, f"科研{index}")
        ResearchProjectProfile.objects.create(workspace=env["workspace"], project=project, owner=env["user"])
    UserRecentVisit.objects.filter(entity_identifier=env["project"].id).update(
        visited_at=timezone.now() + timedelta(minutes=1)
    )
    result = rows(env)
    assert len(result) == 3
    assert result[0]["entity_name"] == "project"


def test_limit_applies_to_administrative_records(env):
    """行政记录仍限制为最近 20 条。"""
    for index in range(21):
        add_project_visit(env, f"行政{index}")
    assert len(rows(env)) == 20


def test_deleted_entities_and_removed_page_associations(env):
    """失效工作项和页面关联不占用行政访问结果。"""
    Issue.all_objects.filter(pk=env["issue"].id).update(deleted_at=timezone.now())
    ProjectPage.objects.filter(page=env["page"]).delete()
    assert {row["entity_name"] for row in rows(env)} == {"project"}


def test_unscoped_response_preserves_generic_recents(env):
    """未启用范围时保留通用接口及响应字段。"""
    project, _ = add_project_visit(env, "科研")
    ResearchProjectProfile.objects.create(workspace=env["workspace"], project=project, owner=env["user"])
    response = env["client"].get(env["url"])
    assert response.status_code == 200
    assert len(response.data) == 4
    assert set(response.data[0]) == {"id", "entity_name", "entity_identifier", "entity_data", "visited_at"}
