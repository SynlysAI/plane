"""待办缓存的科研依赖、事务、权限及观测边界。"""

import logging

import pytest
from django.apps import apps
from django.db import transaction
from django.utils import timezone

from plane.db.models import (
    ApprovalAction,
    PeriodicReportReadReceipt,
    PeriodicReportSnapshot,
    ResearchApprovalRoute,
    StageReview,
    StageReviewerAssignment,
    State,
    User,
    Workspace,
    WorkspaceMember,
    WorkspaceResearchSetting,
)
from plane.db.todo_queryset import TodoInvalidationQuerySet
from plane.license.models import InstanceAdmin
from plane.tests.contract.app.test_project_domain_separation import _install_memory_cache
from plane.tests.contract.app.test_project_domain_separation import domain_env as administrative_env  # noqa: F401
from plane.tests.contract.app.test_research_todos import env as research_env  # noqa: F401
from plane.tests.research_fixtures import make_instance, make_user
from plane.utils.workspace_todos_cache import todo_workspace_path, workspace_todo_cache_version

pytestmark = [pytest.mark.contract, pytest.mark.django_db(transaction=True)]


@pytest.fixture
def todo_env(request):
    """复用科研待办场景，避免导入名与测试参数重名。"""
    return request.getfixturevalue("research_env")


@pytest.mark.parametrize("mutation", ["receipt", "snapshot", "route", "assignment", "review"])
def test_research_child_writes_invalidate_on_commit(todo_env, monkeypatch, mutation):
    """科研子记录的保存和批量写入在提交后使投影失效。"""
    env = todo_env
    _install_memory_cache(monkeypatch)
    url = f"/api/workspaces/{env['workspace'].slug}/todos/"
    before = env["advisor_client"].get(url).data
    version = workspace_todo_cache_version(env["workspace"].id)
    with transaction.atomic():
        if mutation == "receipt":
            PeriodicReportReadReceipt.objects.bulk_create(
                [PeriodicReportReadReceipt(report=env["report"], reader=env["advisor"], snapshot_version=3)]
            )
        elif mutation == "snapshot":
            PeriodicReportSnapshot.objects.bulk_create(
                [PeriodicReportSnapshot(report=env["report"], version_no=4, snapshot_status="SUBMITTED")]
            )
        elif mutation == "route":
            route = ResearchApprovalRoute.objects.get(resource_id=env["report"].id)
            route.reviewer = env["group_member"]
            route.save(update_fields=["reviewer"])
        elif mutation == "assignment":
            StageReviewerAssignment.objects.filter(stage_instance=env["stage"]).update(is_active=False)
        else:
            StageReview.objects.create(
                stage_instance=env["stage"],
                reviewer=env["advisor"],
                reviewer_role="DIRECT_ADVISOR",
                recommendation="PASS",
                submitted_at=timezone.now(),
            )
        assert workspace_todo_cache_version(env["workspace"].id) == version
    assert workspace_todo_cache_version(env["workspace"].id) != version
    after = env["advisor_client"].get(url).data
    assert after["degraded_sources"] == []
    if mutation != "snapshot":
        assert before != after


def test_atomic_read_cannot_publish_rolled_back_projection(todo_env, monkeypatch):
    """事务内读写都绕过共享响应缓存，回滚不会污染已提交结果。"""
    env = todo_env
    memory = _install_memory_cache(monkeypatch)
    url = f"/api/workspaces/{env['workspace'].slug}/todos/"
    before = env["advisor_client"].get(url).data
    version = workspace_todo_cache_version(env["workspace"].id)
    response_writes = len([write for write in memory.writes if write[2] == 5])
    with pytest.raises(RuntimeError), transaction.atomic():
        StageReviewerAssignment.objects.filter(stage_instance=env["stage"]).update(is_active=False)
        uncommitted = env["advisor_client"].get(url).data
        assert uncommitted != before
        raise RuntimeError("rollback")
    assert workspace_todo_cache_version(env["workspace"].id) == version
    assert len([write for write in memory.writes if write[2] == 5]) == response_writes
    assert env["advisor_client"].get(url).data == before


def test_main_pi_setting_invalidates_paired_workspace(todo_env, monkeypatch):
    """共享主 PI 配置变化会同时失效配对科研工作区。"""
    env = todo_env
    WorkspaceResearchSetting.objects.filter(workspace=env["workspace"]).update(
        purpose="PUBLIC_RESEARCH", main_pi=env["principal"]
    )
    other = Workspace.objects.create(name="PI 私人空间", slug="todo-pi", owner=env["principal"])
    WorkspaceResearchSetting.objects.create(workspace=other, purpose="PI_PRIVATE")
    _install_memory_cache(monkeypatch)
    versions = {workspace.id: workspace_todo_cache_version(workspace.id) for workspace in (env["workspace"], other)}
    with transaction.atomic():
        WorkspaceResearchSetting.objects.filter(workspace=env["workspace"]).update(main_pi=env["advisor"])
        assert all(workspace_todo_cache_version(key) == value for key, value in versions.items())
    assert all(workspace_todo_cache_version(key) != value for key, value in versions.items())


@pytest.mark.parametrize("mutation", ["save", "update", "bulk_update"])
def test_instance_admin_reassignment_invalidates_old_and_new_workspaces(todo_env, monkeypatch, mutation):
    """平台管理员改绑用户时，旧用户和新用户所在工作区都会失效。"""
    env = todo_env
    new_admin = make_user()
    other = Workspace.objects.create(name="另一空间", slug="todo-admin-other", owner=new_admin)
    WorkspaceMember.objects.create(workspace=other, member=new_admin, role=15)
    admin = InstanceAdmin.objects.create(instance=make_instance(), user=env["advisor"])
    _install_memory_cache(monkeypatch)
    versions = {workspace.id: workspace_todo_cache_version(workspace.id) for workspace in (env["workspace"], other)}
    with transaction.atomic():
        if mutation == "update":
            InstanceAdmin.objects.filter(pk=admin.pk).update(user=new_admin)
        else:
            admin.user = new_admin
            if mutation == "save":
                admin.save(update_fields=["user"])
            else:
                InstanceAdmin.objects.bulk_update([admin], ["user"])
        assert all(workspace_todo_cache_version(key) == value for key, value in versions.items())
    assert all(workspace_todo_cache_version(key) != value for key, value in versions.items())


@pytest.mark.parametrize("mutation", ["bulk_create", "soft_delete", "hard_delete", "instance_delete"])
def test_instance_admin_creation_and_removal_invalidate_on_commit(todo_env, monkeypatch, mutation):
    """管理员批量创建及允许的删除入口均在提交后失效。"""
    env = todo_env
    instance = make_instance()
    admin = InstanceAdmin.objects.create(instance=instance, user=env["advisor"])
    _install_memory_cache(monkeypatch)
    version = workspace_todo_cache_version(env["workspace"].id)
    with transaction.atomic():
        if mutation == "bulk_create":
            InstanceAdmin.objects.bulk_create([InstanceAdmin(instance=instance, user=env["student"])])
        elif mutation == "soft_delete":
            InstanceAdmin.objects.filter(pk=admin.pk).delete()
            assert InstanceAdmin.all_objects.filter(pk=admin.pk).exists()
        elif mutation == "hard_delete":
            InstanceAdmin.all_objects.filter(pk=admin.pk).delete()
        else:
            admin.delete(soft=False)
        assert workspace_todo_cache_version(env["workspace"].id) == version
    assert workspace_todo_cache_version(env["workspace"].id) != version


@pytest.mark.parametrize("mutation", ["save", "update", "bulk_update", "upsert"])
def test_user_display_changes_invalidate_participant_projection(todo_env, monkeypatch, mutation):
    """参与人显示名修改后不会继续返回缓存中的旧名称。"""
    env = todo_env
    _install_memory_cache(monkeypatch)
    url = f"/api/workspaces/{env['workspace'].slug}/todos/"
    before = env["advisor_client"].get(url).data
    version = workspace_todo_cache_version(env["workspace"].id)
    with transaction.atomic():
        env["student"].display_name = "更新后的研究者"
        if mutation == "save":
            env["student"].save(update_fields=["display_name"])
        elif mutation == "update":
            User.objects.filter(pk=env["student"].pk).update(display_name=env["student"].display_name)
        elif mutation == "bulk_update":
            User.objects.bulk_update([env["student"]], ["display_name"])
        else:
            User.objects.bulk_create(
                [User(username=env["student"].username, email=env["student"].email, display_name="更新后的研究者")],
                update_conflicts=True,
                unique_fields=["username"],
                update_fields=["display_name"],
            )
        assert workspace_todo_cache_version(env["workspace"].id) == version
    assert workspace_todo_cache_version(env["workspace"].id) != version
    assert env["advisor_client"].get(url).data != before


def test_all_declared_todo_managers_extend_the_runtime_queryset():
    """枚举每个依赖模型的实际 manager，防止特殊 manager 绕过批量失效。"""
    for model in apps.get_models():
        if todo_workspace_path(model) is None:
            continue
        for manager in model._meta.managers:
            assert isinstance(manager.get_queryset(), TodoInvalidationQuerySet), (
                model._meta.label_lower,
                manager.name,
                type(manager.get_queryset()),
            )
    assert User.objects.deconstruct()[1] == "django.contrib.auth.models.UserManager"


@pytest.mark.parametrize("field,value", [("is_active", False), ("username", "renamed-todo-user")])
@pytest.mark.parametrize("mutation", ["update", "bulk_update"])
def test_user_bulk_writes_invalidate_only_member_workspaces(todo_env, monkeypatch, field, value, mutation):
    """用户状态和后备显示名更新失效所有成员空间，回滚保持原版本。"""
    env = todo_env
    other = Workspace.objects.create(name="共享参与人空间", slug="todo-user-other", owner=env["student"])
    unrelated = Workspace.objects.create(name="无关空间", slug="todo-user-unrelated", owner=env["advisor"])
    WorkspaceMember.objects.create(workspace=other, member=env["student"])
    _install_memory_cache(monkeypatch)
    versions = {
        workspace.id: workspace_todo_cache_version(workspace.id)
        for workspace in (env["workspace"], other, unrelated)
    }

    def mutate():
        """通过被测批量入口修改同一个参与人。"""
        if mutation == "update":
            return User.objects.filter(pk=env["student"].pk).update(**{field: value})
        setattr(env["student"], field, value)
        return User.objects.bulk_update([env["student"]], [field])

    with pytest.raises(RuntimeError), transaction.atomic():
        assert mutate() == 1
        raise RuntimeError("rollback")
    assert all(workspace_todo_cache_version(key) == version for key, version in versions.items())
    with transaction.atomic():
        assert mutate() == 1
        assert all(workspace_todo_cache_version(key) == version for key, version in versions.items())
    for workspace in (env["workspace"], other):
        assert workspace_todo_cache_version(workspace.id) != versions[workspace.id]
    assert workspace_todo_cache_version(unrelated.id) == versions[unrelated.id]


@pytest.mark.parametrize("mutation", ["save", "update", "bulk_update"])
def test_user_login_updates_do_not_evict_todos(todo_env, monkeypatch, mutation):
    """登录时间写入保持待办缓存，避免每次认证都清空短缓存。"""
    env = todo_env
    _install_memory_cache(monkeypatch)
    version = workspace_todo_cache_version(env["workspace"].id)
    student = env["student"]
    student.last_login = timezone.now()
    if mutation == "save":
        student.save(update_fields=["last_login"])
    elif mutation == "update":
        User.objects.filter(pk=student.pk).update(last_login=student.last_login)
    else:
        User.objects.bulk_update([student], ["last_login"])
    assert workspace_todo_cache_version(env["workspace"].id) == version


@pytest.mark.parametrize("mutation", ["update", "bulk_update", "bulk_create"])
def test_all_state_manager_writes_invalidate_todos(request, monkeypatch, mutation):
    """无过滤状态 manager 的批量操作也会失效工作项待办。"""
    env = request.getfixturevalue("administrative_env")
    _install_memory_cache(monkeypatch)
    url = f"{env['base']}/todos/"
    assert env["client"].get(url).data["total_count"] == 1
    version = workspace_todo_cache_version(env["workspace"].id)
    with transaction.atomic():
        if mutation == "update":
            State.all_state_objects.filter(pk=env["state"].pk).update(group="completed")
        elif mutation == "bulk_update":
            env["state"].group = "completed"
            State.all_state_objects.bulk_update([env["state"]], ["group"])
        else:
            State.all_state_objects.bulk_create(
                [State(workspace=env["workspace"], project=env["project"], name="另一状态", group="unstarted")]
            )
        assert workspace_todo_cache_version(env["workspace"].id) == version
    assert workspace_todo_cache_version(env["workspace"].id) != version
    if mutation != "bulk_create":
        assert env["client"].get(url).data["total_count"] == 0


@pytest.mark.parametrize("mutation", ["bulk_create", "update", "bulk_update", "delete"])
def test_approval_action_queryset_writes_invalidate_after_commit(todo_env, monkeypatch, mutation):
    """审批动作原有 QuerySet 写入语义保持不变，并补足提交后失效。"""
    env = todo_env
    action = ApprovalAction.objects.create(
        request=env["office_approval"], actor=env["advisor"], action="APPROVE"
    )
    _install_memory_cache(monkeypatch)
    version = workspace_todo_cache_version(env["workspace"].id)
    with transaction.atomic():
        if mutation == "bulk_create":
            ApprovalAction.objects.bulk_create(
                [ApprovalAction(request=env["office_approval"], actor=env["advisor"], action="REJECT")]
            )
        elif mutation == "update":
            ApprovalAction.objects.filter(pk=action.pk).update(comment="批量备注")
        elif mutation == "bulk_update":
            action.comment = "批量备注"
            ApprovalAction.objects.bulk_update([action], ["comment"])
        else:
            ApprovalAction.objects.filter(pk=action.pk).delete()
        assert workspace_todo_cache_version(env["workspace"].id) == version
    assert workspace_todo_cache_version(env["workspace"].id) != version
    with pytest.raises(TypeError, match="append-only"):
        action.save()
    with pytest.raises(TypeError, match="append-only"):
        action.delete()


def test_ignored_bulk_conflicts_preserve_data_and_invalidation(todo_env, monkeypatch):
    """忽略冲突仍成功返回，保守失效不会修改已有记录或漏掉同批新记录。"""
    env = todo_env
    existing = WorkspaceMember.objects.get(workspace=env["workspace"], member=env["student"])
    new_user = make_user()
    _install_memory_cache(monkeypatch)
    version = workspace_todo_cache_version(env["workspace"].id)
    with transaction.atomic():
        WorkspaceMember.objects.bulk_create(
            [
                WorkspaceMember(workspace=env["workspace"], member=env["student"], role=5),
                WorkspaceMember(workspace=env["workspace"], member=new_user, role=15),
            ],
            ignore_conflicts=True,
        )
        assert workspace_todo_cache_version(env["workspace"].id) == version
    assert workspace_todo_cache_version(env["workspace"].id) != version
    existing.refresh_from_db()
    assert existing.role != 5
    assert WorkspaceMember.objects.filter(workspace=env["workspace"], member=new_user).exists()


def test_queryset_extension_preserves_soft_delete_and_append_only_rules(todo_env):
    """通用批量失效扩展保留软删除、硬删除及只追加记录约束。"""
    env = todo_env
    assignments = StageReviewerAssignment.objects.filter(stage_instance=env["stage"])
    ids = list(assignments.values_list("id", flat=True))
    assignments.delete()
    assert not StageReviewerAssignment.objects.filter(pk__in=ids).exists()
    assert StageReviewerAssignment.all_objects.filter(pk__in=ids).exists()
    StageReviewerAssignment.all_objects.filter(pk__in=ids).delete()
    assert not StageReviewerAssignment.all_objects.filter(pk__in=ids).exists()
    snapshot = env["snapshot"]
    with pytest.raises(TypeError, match="Append-only"):
        PeriodicReportSnapshot.objects.filter(pk=snapshot.pk).update(version_no=99)
    with pytest.raises(TypeError, match="Append-only"):
        PeriodicReportSnapshot.objects.bulk_update([snapshot], ["snapshot_status"])
    with pytest.raises(TypeError, match="Append-only"):
        PeriodicReportSnapshot.objects.filter(pk=snapshot.pk).delete()


def test_observations_share_request_id_and_mark_degradation(todo_env, monkeypatch, caplog):
    """请求和各来源记录关联标识、查询量、结果量及内部降级状态。"""
    from plane.research.services import research_todos

    env = todo_env
    _install_memory_cache(monkeypatch)

    def fail_reports(*_args):
        """模拟仅报告来源故障。"""
        raise RuntimeError("report unavailable")

    monkeypatch.setattr(research_todos, "collect_report_todos", fail_reports)
    logger = logging.getLogger("plane.api")
    monkeypatch.setattr(logger, "propagate", True)
    with caplog.at_level(logging.INFO, logger="plane.api"):
        response = env["advisor_client"].get(
            f"/api/workspaces/{env['workspace'].slug}/todos/", HTTP_X_REQUEST_ID="todo-observation-test"
        )
    assert response.data["degraded_sources"] == ["RESEARCH:REPORT"]
    requests = [record for record in caplog.records if getattr(record, "event", None) == "workspace_todo_request"]
    sources = [record for record in caplog.records if getattr(record, "event", None) == "workspace_todo_source"]
    assert len(requests) == 1 and sources
    assert all(record.request_id == "todo-observation-test" for record in requests + sources)
    assert requests[0].degraded and requests[0].status_code == 200
    assert requests[0].result_count == len(response.data["results"])
    assert requests[0].query_count > 0 and requests[0].duration_ms > 0
    assert all(record.query_count >= 0 and record.result_count >= 0 for record in sources)
    assert {record.source for record in sources if record.degraded} == {"RESEARCH", "REPORT"}
