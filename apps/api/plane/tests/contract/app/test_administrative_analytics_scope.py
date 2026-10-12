"""验证行政入口的列表、视图、分析、权限和成员统计范围。"""

from unittest.mock import patch

import pytest
from django.utils import timezone

from plane.db.models import (
    AnalyticView, Issue, Project, ProjectMember, ResearchChain,
    ResearchProjectProfile, State, WorkspaceMember,
)
from plane.tests.research_fixtures import make_user

pytestmark = [pytest.mark.contract, pytest.mark.django_db]


@pytest.fixture
def env(workspace, create_user, session_client):
    """创建行政、科研档案、科研链、归档和已删除项目混合环境。"""
    projects = {}
    issues = {}
    for index, name in enumerate(("admin", "admin2", "research", "chain", "archived", "deleted", "hidden")):
        project = Project.objects.create(workspace=workspace, name=name, identifier=f"P{index}")
        if name != "hidden":
            ProjectMember.objects.create(project=project, workspace=workspace, member=create_user, role=15)
        state = State.objects.create(project=project, workspace=workspace, name="Todo", group="backlog")
        issues[name] = Issue.objects.create(project=project, workspace=workspace, state=state, name=name)
        projects[name] = project
    profile = ResearchProjectProfile.objects.create(
        workspace=workspace, project=projects["research"], owner=create_user
    )
    ResearchProjectProfile.all_objects.filter(pk=profile.pk).update(deleted_at=timezone.now())
    chain = ResearchChain.objects.create(
        workspace=workspace, project=projects["chain"], owner=create_user,
        request_id="scope-chain", payload_hash="scope",
    )
    ResearchChain.all_objects.filter(pk=chain.pk).update(deleted_at=timezone.now())
    Project.all_objects.filter(pk=projects["archived"].pk).update(archived_at=timezone.now())
    Project.all_objects.filter(pk=projects["deleted"].pk).update(deleted_at=timezone.now())
    return workspace, projects, issues, session_client


@pytest.mark.parametrize("endpoint", ["projects/", "projects/details/"])
def test_project_scope_preserves_shared_research_access(env, endpoint):
    """行政列表排除软删除科研关联，并保留归档行政项目。"""
    workspace, projects, _, client = env
    response = client.get(f"/api/workspaces/{workspace.slug}/{endpoint}", {"scope": "administrative"})
    assert response.status_code == 200, response.data
    ids = {str(row["id"]) for row in response.data}
    assert str(projects["research"].id) not in ids
    assert str(projects["chain"].id) not in ids
    assert str(projects["archived"].id) in ids
    shared = client.get(f"/api/workspaces/{workspace.slug}/{endpoint}")
    chain_row = next(row for row in shared.data if str(row["id"]) == str(projects["chain"].id))
    assert chain_row["is_research_project"] is True


def test_workspace_view_counts_and_filter_cannot_include_research(env):
    """视图结果及分页总数只包含行政工作项，项目筛选不能绕过范围。"""
    workspace, projects, issues, client = env
    response = client.get(f"/api/workspaces/{workspace.slug}/issues/")
    assert response.status_code == 200, response.data
    assert {str(row["id"]) for row in response.data["results"]} == {
        str(issues[name].id) for name in ("admin", "admin2", "hidden")
    }
    assert response.data["total_count"] == 3
    response = client.get(f"/api/workspaces/{workspace.slug}/issues/", {"project": str(projects["chain"].id)})
    assert response.status_code == 200 and response.data["results"] == []


@pytest.mark.parametrize("endpoint", ["advance-analytics/", "advance-analytics-stats/", "project-stats/"])
def test_analytics_explicit_research_selection_is_empty(env, endpoint):
    """显式传入科研项目 ID 不得退回全部项目统计。"""
    workspace, projects, _, client = env
    response = client.get(f"/api/workspaces/{workspace.slug}/{endpoint}", {"project_ids": str(projects["chain"].id)})
    assert response.status_code == 200, response.data
    if endpoint == "advance-analytics/":
        assert all(value["count"] == 0 for value in response.data.values())
    else:
        assert list(response.data) == []


def test_analytics_member_deduplication_and_highest_role(env, create_user):
    """同一用户多项目角色取最高角色，并排除仅科研项目成员。"""
    workspace, projects, _, client = env
    ProjectMember.objects.filter(project=projects["admin"], member=create_user).update(role=20)
    member = make_user(first_name="Administrative member")
    guest = make_user(first_name="Administrative guest")
    research_member = make_user(first_name="Research member")
    for user, project, role in (
        (member, projects["admin"], 5), (member, projects["admin2"], 15),
        (guest, projects["admin"], 5), (research_member, projects["chain"], 20),
    ):
        ProjectMember.objects.create(workspace=workspace, project=project, member=user, role=role)
    response = client.get(f"/api/workspaces/{workspace.slug}/advance-analytics/")
    assert response.status_code == 200, response.data
    for field, count in (("total_users", 3), ("total_admins", 1), ("total_members", 1), ("total_guests", 1)):
        assert response.data[field]["count"] == count
    assert response.data["total_projects"]["count"] == 3
    assert response.data["total_work_items"]["count"] == 3
    chart = client.get(f"/api/workspaces/{workspace.slug}/advance-analytics-charts/")
    assert next(row["count"] for row in chart.data if row["key"] == "members") == 3


def test_saved_custom_and_export_analytics_use_administrative_scope(env, create_user):
    """旧保存条件、自定义图表和异步导出不能包含科研数据。"""
    workspace, _, _, client = env
    view = AnalyticView.objects.create(
        workspace=workspace, name="Legacy", query={}, query_dict={"x_axis": "priority", "y_axis": "issue_count"}
    )
    response = client.get(f"/api/workspaces/{workspace.slug}/saved-analytic-view/{view.id}/")
    assert response.status_code == 200 and response.data["total"] == 3
    view.query = {"project__id__in": [str(env[1]["admin"].id)]}
    view.save()
    selected = client.get(f"/api/workspaces/{workspace.slug}/saved-analytic-view/{view.id}/")
    assert selected.status_code == 200 and selected.data["total"] == 1
    response = client.get(f"/api/workspaces/{workspace.slug}/analytics/", {"x_axis": "priority", "y_axis": "issue_count"})
    assert response.status_code == 200 and response.data["total"] == 3
    with patch("plane.bgtasks.analytic_plot_export.send_export_email") as send:
        from plane.bgtasks.analytic_plot_export import analytic_export_task

        analytic_export_task.run(create_user.email, {"x_axis": "priority", "y_axis": "issue_count"}, workspace.slug)
        assert send.called


def test_ordinary_member_cannot_see_unjoined_administrative_projects(env):
    """行政统计保持有效项目成员准入，不向普通用户扩大权限。"""
    workspace, projects, issues, client = env
    user = make_user(first_name="Ordinary")
    WorkspaceMember.objects.create(workspace=workspace, member=user, role=15)
    ProjectMember.objects.create(workspace=workspace, project=projects["admin"], member=user, role=15)
    client.force_authenticate(user=user)
    response = client.get(f"/api/workspaces/{workspace.slug}/issues/")
    assert {str(row["id"]) for row in response.data["results"]} == {str(issues["admin"].id)}
    response = client.get(f"/api/workspaces/{workspace.slug}/advance-analytics/")
    assert response.data["total_projects"]["count"] == 1


def test_empty_administrative_scope_returns_zero(env):
    """只加入科研项目的用户获得空行政视图及零统计。"""
    workspace, projects, _, client = env
    user = make_user(first_name="Research only")
    WorkspaceMember.objects.create(workspace=workspace, member=user, role=15)
    ProjectMember.objects.create(workspace=workspace, project=projects["chain"], member=user, role=15)
    client.force_authenticate(user=user)
    response = client.get(f"/api/workspaces/{workspace.slug}/advance-analytics/")
    assert response.status_code == 200 and all(value["count"] == 0 for value in response.data.values())
