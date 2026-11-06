"""Domain boundary tests after retiring administrative approvals."""

from datetime import timedelta
from unittest.mock import patch
import pytest
from django.core.cache import cache
from django.db import transaction
from django.utils import timezone
from rest_framework.test import APIClient
from plane.db.models import (
    AdministrativeOrganization,
    AdministrativeOrganizationMember,
    Issue,
    IssueAssignee,
    Project,
    ProjectMember,
    State,
    WorkspaceMember,
    Workspace,
    WorkspaceResearchSetting,
)
from plane.tests.research_fixtures import make_user
from plane.utils.workspace_todos_cache import (
    TODO_CACHE_TTL_SECONDS,
    TODO_CACHE_VERSION_PREFIX,
    invalidate_workspace_todos,
    workspace_todo_cache_key,
    workspace_todo_cache_version,
)

pytestmark = [pytest.mark.contract, pytest.mark.django_db(transaction=True)]


@pytest.fixture
def domain_env(workspace, create_user):
    WorkspaceResearchSetting.objects.update_or_create(workspace=workspace, defaults={"module_enabled": False})
    organization = AdministrativeOrganization.objects.create(workspace=workspace, name="行政测试")
    AdministrativeOrganizationMember.objects.create(
        workspace=workspace, organization=organization, member=create_user, role="ADMIN"
    )
    member = make_user(first_name="行政成员")
    WorkspaceMember.objects.create(workspace=workspace, member=member, role=15)
    AdministrativeOrganizationMember.objects.create(
        workspace=workspace, organization=organization, member=member, role="MEMBER"
    )
    project = Project.objects.create(
        workspace=workspace, name="行政项目", identifier="DOMAIN", administrative_organization=organization, network=2
    )
    ProjectMember.objects.create(workspace=workspace, project=project, member=create_user, role=20)
    ProjectMember.objects.create(workspace=workspace, project=project, member=member, role=15)
    state = State.objects.create(workspace=workspace, project=project, name="待处理", group="unstarted")
    issue = Issue.objects.create(
        workspace=workspace,
        project=project,
        state=state,
        name="设备采购",
        target_date=timezone.localdate() - timedelta(days=60),
    )
    IssueAssignee.objects.create(workspace=workspace, project=project, issue=issue, assignee=member)
    admin_client = APIClient()
    admin_client.force_authenticate(create_user)
    client = APIClient()
    client.force_authenticate(member)
    base = f"/api/workspaces/{workspace.slug}"
    return locals()


def test_todos_include_old_assigned_tasks_and_degrade_independently(domain_env):
    env = domain_env
    response = env["client"].get(f"{env['base']}/todos/")
    assert response.status_code == 200, response.data
    assert response.data["results"] and all(item["source"] == "WORK_ITEM" for item in response.data["results"])
    assert response.data["results"][0]["domain"] == "ADMINISTRATIVE"
    assert response.data["results"][0]["urgency"] == "OVERDUE"
    assert response.data["results"][0]["object_id"] == str(env["issue"].id)
    cache.clear()
    with (
        patch("plane.app.views.workspace.todos.research_admitted", return_value=True),
        patch("plane.app.views.workspace.todos.collect_research_todos", side_effect=RuntimeError("source unavailable")),
    ):
        result = env["client"].get(f"{env['base']}/todos/")
    assert len(result.data["results"]) == 1 and "RESEARCH" in result.data["degraded_sources"]


class MemoryCache:
    """Tiny cache double that records values and expiration arguments."""

    def __init__(self):
        """初始化缓存值、可控时钟及写入记录。"""
        self.values = {}
        self.writes = []
        self.expires = {}
        self.now = 0

    def get(self, key):
        """读取尚未过期的值。"""
        if key in self.expires and self.now >= self.expires[key]:
            self.values.pop(key, None)
        return self.values.get(key)

    def add(self, key, value, timeout=None):
        """仅在键不存在时写入，模拟 Django cache.add。"""
        if self.get(key) is not None:
            return False
        self.set(key, value, timeout=timeout)
        return True

    def set(self, key, value, timeout=None):
        """记录写入并设置可控的过期时间。"""
        self.values[key] = value
        if timeout is not None:
            self.expires[key] = self.now + timeout
        self.writes.append((key, value, timeout))


def _install_memory_cache(monkeypatch):
    """Use one deterministic cache double for the endpoint and cache helpers."""
    from plane.app.views.workspace import todos as todos_view
    from plane.utils import workspace_todos_cache

    memory_cache = MemoryCache()
    monkeypatch.setattr(todos_view, "cache", memory_cache)
    monkeypatch.setattr(workspace_todos_cache, "cache", memory_cache)
    return memory_cache


def test_workspace_todo_contract_filters_domains_and_paginates(domain_env):
    env = domain_env
    second_issue = Issue.objects.create(
        workspace=env["workspace"],
        project=env["project"],
        state=env["state"],
        name="第二项采购",
    )
    IssueAssignee.objects.create(
        workspace=env["workspace"],
        project=env["project"],
        issue=second_issue,
        assignee=env["member"],
    )

    first_page = env["client"].get(f"{env['base']}/todos/?limit=1").data
    assert set(first_page) == {"schema_version", "results", "total_count", "degraded_sources", "next_cursor"}
    assert first_page["schema_version"] == "workspace-todo.v1"
    assert first_page["total_count"] == 2
    assert len(first_page["results"]) == 1
    assert first_page["next_cursor"]

    second_page = env["client"].get(f"{env['base']}/todos/?limit=1&cursor={first_page['next_cursor']}").data
    assert first_page["results"][0]["id"] != second_page["results"][0]["id"]
    assert second_page["next_cursor"] is None

    administrative = env["client"].get(f"{env['base']}/todos/?domain=administrative").data
    assert administrative["total_count"] == 2
    assert all(item["domain"] == "ADMINISTRATIVE" for item in administrative["results"])
    research = env["client"].get(f"{env['base']}/todos/?domain=research").data
    assert research["results"] == []
    assert research["total_count"] == 0


def test_workspace_todo_cache_is_user_scoped_and_uses_five_second_ttl(domain_env, monkeypatch):
    from plane.app.views.workspace import todos as todos_view

    memory_cache = _install_memory_cache(monkeypatch)
    original_collector = todos_view.administrative_todos
    calls = []

    def count_calls(workspace, user):
        """统计实际聚合次数以区分缓存命中。"""
        calls.append(str(user.id))
        return original_collector(workspace, user)

    monkeypatch.setattr(todos_view, "administrative_todos", count_calls)

    first = domain_env["client"].get(f"{domain_env['base']}/todos/")
    repeated = domain_env["client"].get(f"{domain_env['base']}/todos/")
    assert first.data == repeated.data
    assert calls == [str(domain_env["member"].id)]

    admin_response = domain_env["admin_client"].get(f"{domain_env['base']}/todos/")
    assert admin_response.status_code == 200
    assert calls == [str(domain_env["member"].id), str(domain_env["create_user"].id)]
    response_writes = [write for write in memory_cache.writes if write[2] is not None]
    assert response_writes and all(write[2] == TODO_CACHE_TTL_SECONDS == 5 for write in response_writes)
    memory_cache.now = 5
    assert domain_env["client"].get(f"{domain_env['base']}/todos/").status_code == 200
    assert len(calls) == 3


def test_degraded_workspace_todo_response_is_not_cached(domain_env, monkeypatch):
    from plane.app.views.workspace import todos as todos_view

    memory_cache = _install_memory_cache(monkeypatch)
    monkeypatch.setattr(todos_view, "research_admitted", lambda _user, _workspace: True)

    def fail_research(*_args, **_kwargs):
        """模拟科研聚合异常。"""
        raise RuntimeError("research unavailable")

    monkeypatch.setattr(todos_view, "collect_research_todos", fail_research)
    response = domain_env["client"].get(f"{domain_env['base']}/todos/")

    assert response.status_code == 200
    assert response.data["degraded_sources"] == ["RESEARCH"]
    assert response.data["results"]
    assert not any(write[2] == TODO_CACHE_TTL_SECONDS for write in memory_cache.writes)


def test_workspace_todo_invalidation_runs_after_commit(monkeypatch):
    from plane.utils import workspace_todos_cache

    callbacks = []
    writes = []
    monkeypatch.setattr(
        workspace_todos_cache.transaction,
        "on_commit",
        lambda callback, using=None: callbacks.append(callback),
    )
    monkeypatch.setattr(
        workspace_todos_cache.cache,
        "set",
        lambda key, value, timeout=None: writes.append((key, value, timeout)),
    )

    invalidate_workspace_todos("workspace-1", using="default")
    assert callbacks and writes == []
    callbacks[0]()

    assert len(writes) == 1
    assert writes[0][0] == f"{TODO_CACHE_VERSION_PREFIX}:workspace-1"
    assert writes[0][2] is None


def test_workspace_todo_cache_key_separates_users_workspaces_and_filters():
    base = workspace_todo_cache_key("ws-1", "user-1", "all", 50, 0, "version")
    assert base != workspace_todo_cache_key("ws-2", "user-1", "all", 50, 0, "version")
    assert base != workspace_todo_cache_key("ws-1", "user-2", "all", 50, 0, "version")
    assert base != workspace_todo_cache_key("ws-1", "user-1", "research", 50, 0, "version")
    assert base != workspace_todo_cache_key("ws-1", "user-1", "all", 25, 0, "version")
    assert base != workspace_todo_cache_key("ws-1", "user-1", "all", 50, 10, "version")
    assert base != workspace_todo_cache_key("ws-1", "user-1", "all", 50, 0, "new-version")


@pytest.mark.parametrize("mutation", ["save", "update", "bulk_update", "soft_delete", "hard_delete"])
def test_todo_writes_invalidate_after_commit(domain_env, monkeypatch, django_capture_on_commit_callbacks, mutation):
    """所有现有任务写入方式均在提交后清除工作区旧投影。"""
    env = domain_env
    _install_memory_cache(monkeypatch)
    url = f"{env['base']}/todos/"
    before = env["client"].get(url).data
    version = workspace_todo_cache_version(env["workspace"].id)
    with django_capture_on_commit_callbacks(execute=True), transaction.atomic():
        issue = env["issue"]
        if mutation == "save":
            issue.name = "已更新采购"
            issue.save(update_fields=["name"])
        elif mutation == "update":
            Issue.objects.filter(pk=issue.pk).update(name="已更新采购")
        elif mutation == "bulk_update":
            issue.name = "已更新采购"
            Issue.objects.bulk_update([issue], ["name"])
        elif mutation == "soft_delete":
            Issue.objects.filter(pk=issue.pk).delete()
        else:
            # 使用工作项指派验证级联删除前能够解析工作区。
            IssueAssignee.all_objects.filter(issue=issue).delete()
        assert workspace_todo_cache_version(env["workspace"].id) == version
    assert workspace_todo_cache_version(env["workspace"].id) != version
    after = env["client"].get(url).data
    assert before != after
    if mutation in ("soft_delete", "hard_delete"):
        assert after["results"] == []
    else:
        assert after["results"][0]["title"] == "已更新采购"


def test_bulk_assignments_invalidate_and_rollback_preserves_cache(
    domain_env, monkeypatch, django_capture_on_commit_callbacks
):
    """批量插入会失效，回滚的写入不会清除成功缓存。"""
    env = domain_env
    _install_memory_cache(monkeypatch)
    url = f"{env['base']}/todos/"
    assert env["admin_client"].get(url).data["total_count"] == 0
    version = workspace_todo_cache_version(env["workspace"].id)
    with django_capture_on_commit_callbacks(execute=True):
        IssueAssignee.objects.filter(issue=env["issue"]).delete()
        IssueAssignee.objects.bulk_create(
            [
                IssueAssignee(
                    workspace=env["workspace"], project=env["project"], issue=env["issue"], assignee=env["create_user"]
                )
            ]
        )
    assert workspace_todo_cache_version(env["workspace"].id) != version
    assert env["admin_client"].get(url).data["total_count"] == 1
    version = workspace_todo_cache_version(env["workspace"].id)
    with django_capture_on_commit_callbacks(execute=True):
        with pytest.raises(RuntimeError), transaction.atomic():
            Issue.objects.filter(pk=env["issue"].pk).update(name="回滚的标题")
            raise RuntimeError("rollback")
    assert workspace_todo_cache_version(env["workspace"].id) == version
    assert env["admin_client"].get(url).data["results"][0]["title"] == "设备采购"


def test_cached_todos_check_membership_and_permission_revocation(
    domain_env, monkeypatch, django_capture_on_commit_callbacks
):
    """缓存命中仍检查成员身份，项目权限撤销使旧结果失效。"""
    env = domain_env
    _install_memory_cache(monkeypatch)
    url = f"{env['base']}/todos/"
    assert env["client"].get(url).data["total_count"] == 1
    with django_capture_on_commit_callbacks(execute=True):
        ProjectMember.objects.filter(project=env["project"], member=env["member"]).update(
            is_active=False, inheritance_revoked=True
        )
    assert env["client"].get(url).data["results"] == []
    WorkspaceMember.objects.filter(workspace=env["workspace"], member=env["member"]).update(is_active=False)
    assert env["client"].get(url).status_code == 403


def test_cache_failures_and_internal_degradation_bypass_cache(domain_env, monkeypatch):
    """缓存故障不影响响应，内部来源降级也不能进入缓存。"""
    from plane.app.views.workspace import todos as todos_view

    memory = _install_memory_cache(monkeypatch)
    monkeypatch.setattr(todos_view, "research_admitted", lambda *_: True)
    monkeypatch.setattr(todos_view, "collect_research_todos", lambda *_: ([], ["REPORT"]))
    response = domain_env["client"].get(f"{domain_env['base']}/todos/")
    assert response.data["degraded_sources"] == ["RESEARCH:REPORT"]
    assert not any(write[2] == 5 for write in memory.writes)

    def unavailable(*_args, **_kwargs):
        """模拟 Redis 不可用。"""
        raise ConnectionError("cache unavailable")

    monkeypatch.setattr(memory, "get", unavailable)
    assert domain_env["client"].get(f"{domain_env['base']}/todos/").status_code == 200


def test_cache_workspace_isolation(domain_env, monkeypatch):
    """同一用户的两个工作区不会共享响应。"""
    env = domain_env
    _install_memory_cache(monkeypatch)
    other = Workspace.objects.create(name="另一个工作区", slug="todo-other", owner=env["member"])
    WorkspaceMember.objects.create(workspace=other, member=env["member"], role=15)
    assert env["client"].get(f"{env['base']}/todos/").data["total_count"] == 1
    assert env["client"].get(f"/api/workspaces/{other.slug}/todos/").data["total_count"] == 0


def test_context_strict_boolean_and_admin_authorization(domain_env):
    env = domain_env
    url = f"{env['base']}/context/"
    response = env["client"].get(url)
    assert response.status_code == 200 and response.data["navigation"]["administrative"]
    assert not response.data["workspace_enabled"]
    assert env["client"].patch(url, {"research_enabled": True}, format="json").status_code == 403
    assert env["admin_client"].patch(url, {"research_enabled": "false"}, format="json").status_code == 400
    enabled = env["admin_client"].patch(url, {"research_enabled": True}, format="json")
    assert enabled.status_code == 200 and enabled.data["sections"]["research_chain"]


def test_project_member_is_visible_in_tree_without_organization_membership(domain_env):
    env = domain_env
    AdministrativeOrganizationMember.objects.filter(organization=env["organization"], member=env["member"]).delete()
    response = env["client"].get(f"/api/research/workspaces/{env['workspace'].slug}/administrative-organizations/")
    assert response.status_code == 200
    org = next(item for item in response.data if item["id"] == str(env["organization"].id))
    assert str(env["project"].id) in org["project_ids"]
    env["project"].archived_at = timezone.now()
    env["project"].save()
    response = env["client"].get(f"/api/research/workspaces/{env['workspace'].slug}/administrative-organizations/")
    assert all(str(env["project"].id) not in item["project_ids"] for item in response.data)


def test_retired_approval_configuration_endpoints_are_removed(domain_env):
    env = domain_env
    assert env["admin_client"].get(f"{env['base']}/administrative/approval-flows/").status_code == 404
    assert env["admin_client"].get(f"{env['base']}/administrative/approval-requests/").status_code == 404
    assert (
        env["admin_client"]
        .post(
            f"{env['base']}/administrative/approval-requests/",
            {"project_id": str(env["project"].id), "issue_id": str(env["issue"].id)},
            format="json",
        )
        .status_code
        == 404
    )
    assert (
        env["admin_client"]
        .get(f"{env['base']}/administrative/organizations/{env['organization'].id}/approvers/")
        .status_code
        == 404
    )
    assert env["admin_client"].get(f"{env['base']}/projects/{env['project'].id}/approval-setting/").status_code == 404
