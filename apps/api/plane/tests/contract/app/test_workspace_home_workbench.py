"""首页个性化偏好与真实业务动态契约。"""

from datetime import timedelta
from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path

import pytest
from django.apps import apps
from django.urls import reverse
from django.utils import timezone
from rest_framework import status
from rest_framework.test import APIClient

from plane.db.models import (
    AdministrativeOrganization,
    HomeActivityEvent,
    Issue,
    IssueActivity,
    IssueComment,
    Project,
    ResearchAuditEvent,
    ResearchProjectProfile,
    State,
    UserRecentVisit,
    WorkspaceHomePreference,
    WorkspaceMember,
)
from plane.tests.research_fixtures import make_user
from plane.utils.home_activity import record_project_activity


pytestmark = [pytest.mark.contract, pytest.mark.django_db]
BASE_TIME = timezone.now().replace(microsecond=0)


@pytest.fixture
def env(workspace, create_user):
    """创建首页契约测试所需的公共数据。"""
    organization = AdministrativeOrganization.objects.filter(workspace=workspace, is_default=True).first()
    project = Project.objects.create(
        workspace=workspace,
        name="Office",
        identifier="OFF",
        administrative_organization=organization,
    )
    state = State.objects.create(
        workspace=workspace,
        project=project,
        name="Started",
        group="started",
        default=True,
    )
    issue = Issue.objects.create(
        workspace=workspace,
        project=project,
        name="采购申请",
        state=state,
        created_by=create_user,
    )
    client = APIClient()
    client.force_authenticate(user=create_user)
    return {"workspace": workspace, "user": create_user, "project": project, "issue": issue, "client": client}


def preference_map(client, slug):
    """读取首页偏好并按 key 转成字典。"""
    response = client.get(reverse("workspace-home-preference", kwargs={"slug": slug}))
    assert response.status_code == status.HTTP_200_OK, response.data
    return {row["key"]: row for row in response.data}


def load_default_grid_migration():
    """加载 0199 首页默认栅格迁移，直接验证数据迁移函数。"""
    path = Path(__file__).parents[3] / "db/migrations/0199_restore_home_workbench_default_grid.py"
    spec = spec_from_file_location("restore_home_workbench_default_grid_migration", path)
    assert spec is not None and spec.loader is not None
    module = module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def create_preference_group(workspace, user, *, enabled=True):
    """创建一组旧默认首页偏好，供数据迁移测试使用。"""
    rows = [
        ("my_todos", {"size": "medium"}, 1100),
        ("research_projects", {"size": "large"}, 1000),
        ("administrative_projects", {"size": "medium"}, 900),
        ("recent_activity", {"size": "medium"}, 800),
        ("report_summary", {"size": "medium"}, 700),
        ("workbench_layout", {"density": "compact"}, 100),
    ]
    WorkspaceHomePreference.objects.bulk_create(
        WorkspaceHomePreference(
            workspace=workspace,
            user=user,
            key=key,
            is_enabled=enabled,
            config=config,
            sort_order=sort_order,
        )
        for key, config, sort_order in rows
    )


def test_home_preferences_initialize_and_stay_user_scoped(env):
    """首次进入有默认布局；后续修改只作用于当前用户。"""
    rows = preference_map(env["client"], env["workspace"].slug)
    assert rows["my_todos"]["config"] == {"size": "medium"}
    assert rows["research_projects"]["config"] == {"size": "large"}
    for key in ("administrative_projects", "recent_activity", "report_summary"):
        assert rows[key]["config"] == {"size": "small"}
    assert rows["workbench_layout"]["config"] == {"density": "compact"}
    assert rows["my_todos"]["is_enabled"] is True

    key_change = env["client"].patch(
        reverse("workspace-home-preference", kwargs={"slug": env["workspace"].slug, "key": "workbench_layout"}),
        {"key": "my_todos", "config": {"density": "detailed"}},
        format="json",
    )
    assert key_change.status_code == status.HTTP_200_OK, key_change.data
    assert key_change.json()["key"] == "workbench_layout"

    response = env["client"].patch(
        reverse("workspace-home-preference", kwargs={"slug": env["workspace"].slug, "key": "my_todos"}),
        {"is_enabled": False, "config": {"size": "full"}, "sort_order": 2000},
        format="json",
    )
    assert response.status_code == status.HTTP_200_OK, response.data

    response = env["client"].patch(
        reverse("workspace-home-preference", kwargs={"slug": env["workspace"].slug, "key": "workbench_layout"}),
        {"config": {"density": "detailed"}},
        format="json",
    )
    assert response.status_code == status.HTTP_200_OK, response.data

    other = make_user(first_name="Other")
    WorkspaceMember.objects.create(workspace=env["workspace"], member=other, role=15)
    other_client = APIClient()
    other_client.force_authenticate(user=other)
    other_rows = preference_map(other_client, env["workspace"].slug)
    assert other_rows["my_todos"]["is_enabled"] is True
    assert other_rows["my_todos"]["config"] == {"size": "medium"}
    assert other_rows["workbench_layout"]["config"] == {"density": "compact"}

    rows = preference_map(env["client"], env["workspace"].slug)
    assert rows["my_todos"]["is_enabled"] is False
    assert rows["my_todos"]["config"] == {"size": "full"}
    assert rows["workbench_layout"]["config"] == {"density": "detailed"}


def test_default_grid_migration_updates_only_untouched_legacy_defaults(env):
    """旧默认组合升级为下三栏，用户自定义组合保持不变且默认组合可回滚。"""
    module = load_default_grid_migration()
    other = make_user(first_name="Other")
    create_preference_group(env["workspace"], env["user"])
    create_preference_group(env["workspace"], other, enabled=False)

    module.restore_default_grid(apps, None)

    bottom_keys = ("administrative_projects", "recent_activity", "report_summary")
    migrated = WorkspaceHomePreference.objects.filter(user=env["user"], key__in=bottom_keys)
    assert {row.config["size"] for row in migrated} == {"small"}
    customized = WorkspaceHomePreference.objects.filter(user=other, key__in=bottom_keys)
    assert {row.config["size"] for row in customized} == {"medium"}

    module.restore_default_grid_reverse(apps, None)
    migrated = WorkspaceHomePreference.objects.filter(user=env["user"], key__in=bottom_keys)
    assert {row.config["size"] for row in migrated} == {"medium"}


def test_existing_home_preferences_are_not_reset(env):
    """补齐新默认行时不能覆盖用户已保存的隐藏设置。"""
    WorkspaceHomePreference.objects.create(
        workspace=env["workspace"],
        user=env["user"],
        key="research_projects",
        is_enabled=False,
        config={"size": "full"},
        sort_order=123,
    )
    rows = preference_map(env["client"], env["workspace"].slug)
    assert rows["research_projects"]["is_enabled"] is False
    assert rows["research_projects"]["config"] == {"size": "full"}
    assert rows["research_projects"]["sort_order"] == 123
    assert rows["my_todos"]["is_enabled"] is True


def test_home_activity_feed_returns_real_mutations_not_visits(env):
    """动态必须包含操作者、对象、时间、变更与链接，且不读取浏览记录。"""
    record_project_activity(
        env["project"],
        env["user"],
        "updated",
        [{"field": "name", "old_value": "Office", "new_value": "Office 2"}],
        occurred_at=BASE_TIME,
    )
    created = IssueActivity.objects.create(
        workspace=env["project"].workspace,
        project=env["project"],
        issue=env["issue"],
        actor=env["user"],
        verb="created",
        comment="created the issue",
    )
    IssueActivity.objects.filter(pk=created.pk).update(created_at=BASE_TIME - timedelta(minutes=1))
    changed = IssueActivity.objects.create(
        workspace=env["project"].workspace,
        project=env["project"],
        issue=env["issue"],
        actor=env["user"],
        verb="updated",
        field="priority",
        old_value="none",
        new_value="high",
    )
    IssueActivity.objects.filter(pk=changed.pk).update(created_at=BASE_TIME - timedelta(minutes=2))
    comment = IssueComment.objects.create(
        workspace=env["project"].workspace,
        project=env["project"],
        issue=env["issue"],
        actor=env["user"],
        comment_html="<p>请补充报价单</p>",
    )
    IssueComment.objects.filter(pk=comment.pk).update(created_at=BASE_TIME - timedelta(minutes=3))
    UserRecentVisit.objects.create(
        workspace=env["project"].workspace,
        user=env["user"],
        entity_name="project",
        entity_identifier=env["project"].id,
    )

    response = env["client"].get(
        reverse("workspace-home-activities", kwargs={"slug": env["workspace"].slug}),
        {"days": "30", "per_page": 20},
    )
    assert response.status_code == status.HTTP_200_OK, response.data
    results = response.data["results"]
    assert {row["source"] for row in results} == {"project", "work_item", "comment"}
    assert all(str(row["actor"]["id"]) == str(env["user"].id) for row in results)
    assert all(row["occurred_at"] for row in results)
    assert all(row["url"] for row in results)
    assert all("浏览" not in row["entity_name"] for row in results)

    project_row = next(row for row in results if row["source"] == "project")
    assert project_row["entity_name"] == "Office"
    assert project_row["changes"][0]["old_value"] == "Office"
    assert project_row["changes"][0]["new_value"] == "Office 2"

    change_row = next(row for row in results if row["source"] == "work_item" and row["action"] == "updated")
    assert change_row["entity_name"] == "采购申请"
    assert change_row["changes"] == [{"field": "priority", "old_value": "none", "new_value": "high"}]

    comment_row = next(row for row in results if row["source"] == "comment")
    assert comment_row["action"] == "commented"
    assert comment_row["changes"][0]["new_value"] == "请补充报价单"


def test_home_activity_feed_respects_project_visibility_and_time_filter(env):
    """非成员不能读取私密项目事件，时间筛选也不能把浏览记录补进结果。"""
    hidden_project = Project.objects.create(
        workspace=env["workspace"],
        name="Secret",
        identifier="SEC",
        network=0,
    )
    hidden_issue = Issue.objects.create(
        workspace=env["workspace"],
        project=hidden_project,
        name="保密事项",
        created_by=env["user"],
    )
    IssueActivity.objects.create(
        workspace=env["workspace"],
        project=hidden_project,
        issue=hidden_issue,
        actor=env["user"],
        verb="created",
    )
    record_project_activity(env["project"], env["user"], "created", occurred_at=BASE_TIME - timedelta(days=31))
    record_project_activity(hidden_project, env["user"], "created", occurred_at=BASE_TIME)

    member = make_user(first_name="Member")
    WorkspaceMember.objects.create(workspace=env["workspace"], member=member, role=15)
    client = APIClient()
    client.force_authenticate(user=member)
    response = client.get(
        reverse("workspace-home-activities", kwargs={"slug": env["workspace"].slug}),
        {"days": "30"},
    )
    assert response.status_code == status.HTTP_200_OK, response.data
    assert response.data["results"] == []


def test_meaningful_project_patch_creates_a_traceable_home_event(env, monkeypatch):
    """项目字段修改必须写入事件；变更值可读且属于当前操作者。"""
    from django.conf import settings

    monkeypatch.setattr(settings, "WEB_URL", "http://test.local")
    from plane.bgtasks.webhook_task import model_activity

    monkeypatch.setattr(model_activity, "delay", lambda **kwargs: None)
    response = env["client"].patch(
        f"/api/workspaces/{env['workspace'].slug}/projects/{env['project'].id}/",
        {"name": "Office 2"},
        format="json",
    )
    assert response.status_code == status.HTTP_200_OK, response.data

    event = HomeActivityEvent.objects.get(workspace=env["workspace"], entity_id=env["project"].id)
    assert event.actor == env["user"]
    assert event.action == "updated"
    assert event.entity_name == "Office 2"
    assert event.changes == [{"field": "name", "old_value": "Office", "new_value": "Office 2"}]


def test_home_activity_feed_includes_visible_research_audit_events(env, monkeypatch):
    """科研审计事件应按科研档案可见性过滤并解析业务对象。"""
    from plane.app.views.workspace import home_activity

    monkeypatch.setattr(home_activity, "research_module_enabled", lambda: True)
    monkeypatch.setattr(home_activity, "workspace_research_enabled", lambda workspace: True)
    research_project = Project.objects.create(
        workspace=env["workspace"],
        name="Research",
        identifier="RES",
        network=0,
    )
    profile = ResearchProjectProfile.objects.create(
        workspace=env["workspace"],
        project=research_project,
        owner=env["user"],
        chain_visibility=ResearchProjectProfile.ChainVisibility.PRIVATE,
    )
    ResearchAuditEvent.objects.create(
        workspace=env["workspace"],
        actor=env["user"],
        action="project.create",
        resource_type="research_project",
        resource_id=profile.id,
        metadata={"project": str(research_project.id), "owner": str(env["user"].id)},
    )

    response = env["client"].get(
        reverse("workspace-home-activities", kwargs={"slug": env["workspace"].slug}),
        {"per_page": 20},
    )
    assert response.status_code == status.HTTP_200_OK, response.data
    row = next(item for item in response.data["results"] if item["source"] == "research")
    assert row["action"] == "project.create"
    assert row["entity_name"] == "Research"
    assert row["project"]["name"] == "Research"
    assert str(row["actor"]["id"]) == str(env["user"].id)

    other = make_user(first_name="Other")
    WorkspaceMember.objects.create(workspace=env["workspace"], member=other, role=15)
    other_client = APIClient()
    other_client.force_authenticate(user=other)
    other_response = other_client.get(
        reverse("workspace-home-activities", kwargs={"slug": env["workspace"].slug}),
        {"per_page": 20},
    )
    assert other_response.status_code == status.HTTP_200_OK, other_response.data
    assert all(item["source"] != "research" for item in other_response.data["results"])
