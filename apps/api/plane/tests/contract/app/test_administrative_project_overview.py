"""验证首页行政项目概览的数量、动态时间和访问边界。"""

from datetime import datetime, timedelta, timezone

import pytest
from rest_framework.test import APIClient

from plane.db.models import (
    Issue,
    IssueActivity,
    IssueComment,
    Project,
    ProjectMember,
    ResearchProjectProfile,
    State,
    Workspace,
    WorkspaceMember,
)
from plane.tests.research_fixtures import make_user


pytestmark = [pytest.mark.contract, pytest.mark.django_db]
BASE_TIME = datetime(2026, 10, 1, tzinfo=timezone.utc)
OVERVIEW_FIELDS = "open_issues,done_issues,last_activity_at"
DEFAULT_FIELDS = {"id", "total_issues", "completed_issues", "total_members", "total_cycles", "total_modules"}


@pytest.fixture
def env(workspace, create_user):
    """创建概览测试的项目、管理员客户端和各状态工作项工厂。

    Args:
        workspace: 测试工作区。
        create_user: 工作区管理员。

    Returns:
        包含客户端、项目和工作项工厂的测试环境字典。
    """
    project = Project.objects.create(workspace=workspace, name="Office", identifier="OFF")
    Project.objects.filter(pk=project.pk).update(updated_at=BASE_TIME)
    client = APIClient()
    client.force_authenticate(user=create_user)

    def issue(group="started", **kwargs):
        """创建指定状态的工作项，并固定资料更新时间。

        Args:
            group: 状态分组。
            **kwargs: 额外工作项字段。

        Returns:
            新建的工作项实例。
        """
        state, _ = State.all_state_objects.get_or_create(
            project=project,
            workspace=workspace,
            name=group,
            defaults={"group": group, "is_triage": group == "triage"},
        )
        item = Issue(
            project=project,
            workspace=workspace,
            state=state,
            name="Office item",
            **kwargs,
        )
        item.save(disable_auto_set_user=True)
        Issue.objects.filter(pk=item.pk).update(updated_at=BASE_TIME + timedelta(days=1))
        return item

    return {"workspace": workspace, "user": create_user, "project": project, "client": client, "issue": issue}


def overview(env, **params):
    """请求测试环境的批量项目统计。

    Args:
        env: 概览测试环境。
        **params: 覆盖默认概览请求的查询参数。

    Returns:
        项目统计的 HTTP 响应。
    """
    return env["client"].get(
        f"/api/workspaces/{env['workspace'].slug}/project-stats/",
        {"fields": OVERVIEW_FIELDS, **params},
    )


def parsed_time(value):
    """将响应中的 ISO 时间转换为可比较的时间对象。

    Args:
        value: JSON 响应时间字符串。

    Returns:
        带时区的 datetime。
    """
    return datetime.fromisoformat(str(value).replace("Z", "+00:00"))


def test_counts_exclude_cancelled_drafts_triage_archived_and_deleted(env):
    """未完成和已完成只统计当前有效工作项。"""
    for group in ("backlog", "unstarted", "started", "completed", "cancelled"):
        env["issue"](group)
    env["issue"](is_draft=True)
    env["issue"]("triage")
    env["issue"](archived_at=BASE_TIME.date())
    deleted = env["issue"]()
    Issue.objects.filter(pk=deleted.pk).update(deleted_at=BASE_TIME)
    response = overview(env)
    assert response.status_code == 200, response.data
    assert response.data[0]["open_issues"] == 3
    assert response.data[0]["done_issues"] == 1


def test_empty_project_returns_zero_and_project_timestamp(env):
    """无工作项的项目仍有零数量与项目资料更新时间。"""
    response = overview(env)
    assert response.status_code == 200, response.data
    row = response.data[0]
    assert row["open_issues"] == row["done_issues"] == 0
    assert parsed_time(row["last_activity_at"]) == BASE_TIME


@pytest.mark.parametrize("source", ["project", "issue", "activity", "activity_edit", "comment", "comment_edit"])
def test_latest_timestamp_includes_work_and_comments(env, source):
    """项目、工作项、活动和评论编辑均能推进最近更新时间。"""
    item = env["issue"]()
    latest = BASE_TIME + timedelta(days=5)
    if source == "project":
        Project.objects.filter(pk=env["project"].pk).update(updated_at=latest)
    elif source == "issue":
        Issue.objects.filter(pk=item.pk).update(updated_at=latest)
    elif source in {"activity", "activity_edit"}:
        activity = IssueActivity.objects.create(project=env["project"], workspace=env["workspace"], issue=item)
        IssueActivity.objects.filter(pk=activity.pk).update(
            created_at=latest if source == "activity" else BASE_TIME,
            updated_at=latest if source == "activity_edit" else BASE_TIME,
        )
    else:
        comment = IssueComment.objects.create(
            project=env["project"], workspace=env["workspace"], issue=item, comment_html="<p>Updated</p>"
        )
        IssueComment.objects.filter(pk=comment.pk).update(
            updated_at=latest if source == "comment" else BASE_TIME,
            edited_at=latest if source == "comment_edit" else None,
        )
    response = overview(env)
    assert response.status_code == 200, response.data
    assert parsed_time(response.data[0]["last_activity_at"]) == latest


@pytest.mark.parametrize("excluded", ["draft", "triage", "archived", "deleted"])
def test_excluded_work_cannot_advance_activity_time(env, excluded):
    """被排除工作项的资料、活动与评论不影响首页更新时间。"""
    kwargs = {"is_draft": True} if excluded == "draft" else {}
    if excluded == "archived":
        kwargs["archived_at"] = BASE_TIME.date()
    item = env["issue"]("triage" if excluded == "triage" else "started", **kwargs)
    Issue.objects.filter(pk=item.pk).update(
        updated_at=BASE_TIME + timedelta(days=10), deleted_at=BASE_TIME if excluded == "deleted" else None
    )
    IssueActivity.objects.create(project=env["project"], workspace=env["workspace"], issue=item)
    IssueComment.objects.create(project=env["project"], workspace=env["workspace"], issue=item)
    response = overview(env)
    assert response.status_code == 200, response.data
    assert parsed_time(response.data[0]["last_activity_at"]) == BASE_TIME


def test_deleted_comments_and_their_activity_are_ignored(env):
    """软删除评论及其活动不会把项目最近更新时间向后推进。"""
    item = env["issue"]()
    comment = IssueComment.objects.create(project=env["project"], workspace=env["workspace"], issue=item)
    IssueComment.objects.filter(pk=comment.pk).update(deleted_at=BASE_TIME)
    IssueActivity.objects.create(project=env["project"], workspace=env["workspace"], issue=item, issue_comment=comment)
    response = overview(env)
    assert response.status_code == 200, response.data
    assert parsed_time(response.data[0]["last_activity_at"]) == BASE_TIME + timedelta(days=1)


@pytest.mark.parametrize("active", [False, True])
def test_batch_respects_project_membership_and_workspace(env, active):
    """批量项目 ID 不能绕过成员、工作区、归档及删除边界。"""
    user = make_user(first_name="Member")
    WorkspaceMember.objects.create(workspace=env["workspace"], member=user, role=15)
    ProjectMember.objects.create(
        project=env["project"], workspace=env["workspace"], member=user, role=15, is_active=active
    )
    foreign_workspace = Workspace.objects.create(name="Other", slug="other-overview", owner=env["user"])
    foreign = Project.objects.create(workspace=foreign_workspace, name="Other", identifier="OTH")
    archived = Project.objects.create(
        workspace=env["workspace"], name="Archived", identifier="ARC", archived_at=BASE_TIME
    )
    deleted = Project.objects.create(workspace=env["workspace"], name="Deleted", identifier="DEL")
    Project.objects.filter(pk=deleted.pk).update(deleted_at=BASE_TIME)
    env["client"].force_authenticate(user=user)
    response = overview(
        env, project_ids=",".join(str(project.pk) for project in (env["project"], foreign, archived, deleted))
    )
    assert response.status_code == 200, response.data
    assert {str(row["id"]) for row in response.data} == ({str(env["project"].pk)} if active else set())


def test_restricted_guest_counts_and_activity_only_include_own_work(env):
    """受限访客不能通过统计数量或更新时间获知他人的工作动态。"""
    guest = make_user(first_name="Guest")
    WorkspaceMember.objects.create(workspace=env["workspace"], member=guest, role=5)
    ProjectMember.objects.create(project=env["project"], workspace=env["workspace"], member=guest, role=5)
    env["issue"]("completed", created_by=guest)
    hidden = env["issue"](created_by=env["user"])
    Issue.objects.filter(pk=hidden.pk).update(updated_at=BASE_TIME + timedelta(days=10))
    IssueActivity.objects.create(project=env["project"], workspace=env["workspace"], issue=hidden)
    IssueComment.objects.create(project=env["project"], workspace=env["workspace"], issue=hidden)
    env["client"].force_authenticate(user=guest)
    response = overview(env)
    assert response.status_code == 200, response.data
    row = response.data[0]
    assert row["open_issues"] == 0
    assert row["done_issues"] == 1
    assert parsed_time(row["last_activity_at"]) == BASE_TIME + timedelta(days=1)


def test_overview_cannot_include_research_project_ids(env):
    """首页概览字段仅返回行政项目，不接受科研项目 ID 扩大范围。"""
    research = Project.objects.create(workspace=env["workspace"], name="Research", identifier="RES")
    ResearchProjectProfile.objects.create(workspace=env["workspace"], project=research, owner=env["user"])
    response = overview(env, project_ids=f"{env['project'].pk},{research.pk}")
    assert response.status_code == 200, response.data
    assert {str(row["id"]) for row in response.data} == {str(env["project"].pk)}


@pytest.mark.parametrize("access", ["full_guest", "admin"])
def test_full_access_users_can_see_all_work(env, access):
    """完整访客和默认管理员可读取全部项目工作项。"""
    env["issue"]()
    env["issue"]("completed")
    if access == "full_guest":
        guest = make_user(first_name="FullGuest")
        WorkspaceMember.objects.create(workspace=env["workspace"], member=guest, role=5)
        ProjectMember.objects.create(project=env["project"], workspace=env["workspace"], member=guest, role=5)
        Project.objects.filter(pk=env["project"].pk).update(guest_view_all_features=True)
        env["client"].force_authenticate(user=guest)
    response = overview(env)
    assert response.status_code == 200, response.data
    assert response.data[0]["open_issues"] == response.data[0]["done_issues"] == 1


def test_overview_fields_are_opt_in_and_legacy_completed_count_is_unchanged(env):
    """默认响应不增加概览字段，旧完成统计仍包含已取消。"""
    env["issue"]("completed")
    env["issue"]("cancelled")
    for fields in ("", "unknown"):
        response = overview(env, fields=fields)
        assert response.status_code == 200, response.data
        assert set(response.data[0]) == DEFAULT_FIELDS
        assert response.data[0]["completed_issues"] == 2
    response = overview(env, fields="done_issues")
    assert response.status_code == 200, response.data
    assert set(response.data[0]) == {"id", "done_issues"}
    assert response.data[0]["done_issues"] == 1
