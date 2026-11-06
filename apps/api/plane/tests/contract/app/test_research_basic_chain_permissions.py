"""基础研究链开放可见性、指派与承办人转派的权限契约。"""

from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from types import SimpleNamespace
from unittest.mock import patch
from uuid import uuid4

import pytest
from django.db import close_old_connections, connection
from django.test.utils import CaptureQueriesContext
from django.utils import timezone
from rest_framework.test import APIClient

from plane.db.models import (
    Notification,
    OrgUnitMember,
    ProjectMember,
    ResearchChainEvent,
    ResearchChainNodeTask,
    ResearchTaskSubscriber,
    WorkspaceMember,
    WorkspaceResearchSetting,
)
from plane.license.models import Instance, InstanceAdmin
from plane.research.serializers import ResearchChainNodeTaskSerializer
from plane.research.services.chain_tasks import (
    ChainTaskPermissionError,
    chain_assignable_user_ids,
    chain_resource,
    list_tasks,
    transfer_task_by_current_assignee,
    update_task,
    validate_assignable_user,
)
from plane.research.services.research_todos import collect_chain_task_todos
from plane.research.utils.chain_permissions import basic_research_unit_ids, is_basic_research_chain
from plane.research.views.projects import visible_profile_queryset
from plane.tests.research_fixtures import add_workspace_member, make_research_boundary_fixture, make_user
from plane.utils.assignment_transfer import assignment_transfer_candidates

pytestmark = [pytest.mark.contract, pytest.mark.django_db]


def client_for(user):
    """创建指定用户的登录客户端。

    Args:
        user: 请求身份。

    Returns:
        已认证的 API 客户端。
    """
    client = APIClient()
    client.force_authenticate(user=user)
    return client


@pytest.fixture
def env(settings):
    """构造没有配置课题成员的基础研究链与有效科研身份。

    Args:
        settings: 测试配置覆盖入口。

    Returns:
        研究链、组织与登录用户测试环境。
    """
    settings.RESEARCH_MODULE_ENABLED = True
    data = make_research_boundary_fixture()
    unit = data["group_a1"]
    unit.business_category = "BASIC_RESEARCH"
    unit.save(update_fields=["business_category"])
    profile = data["project_profile"]
    profile.chain_visibility = "PRIVATE"
    profile.save(update_fields=["chain_visibility"])
    data["chain"].visibility = "PRIVATE"
    data["chain"].save(update_fields=["visibility"])
    data["base"] = f"/api/research/workspaces/{data['workspace'].slug}/"
    data["chain_url"] = f"{data['base']}chains/{data['chain'].id}/"
    data["tasks_url"] = f"{data['chain_url']}nodes/{data['paper_node'].id}/tasks/"
    data["task"] = ResearchChainNodeTask.objects.create(
        workspace=data["workspace"],
        chain=data["chain"],
        node=data["paper_node"],
        title="基础研究行动项",
        assignee=data["group_member"],
        assigned_by=data["student"],
        created_by=data["student"],
        status="ASSIGNED",
        request_id=str(uuid4()),
        payload_hash="basic-chain-test",
    )
    data["task_url"] = f"{data['tasks_url']}{data['task'].id}/"
    return data


def test_nonmembers_can_browse_and_receive_tasks_without_project_membership(env):
    """基础研究读者在列表、详情、节点及行动项中使用一致权限。

    Args:
        env: 基础研究链测试环境。
    """
    client = client_for(env["descendant"])
    member_count = ProjectMember.objects.count()
    assert visible_profile_queryset(env["workspace"], env["descendant"]).filter(pk=env["project_profile"].pk).exists()
    projects = client.get(f"{env['base']}projects/")
    assert projects.status_code == 200, projects.data
    project = next(row for row in projects.json()["results"] if row["id"] == str(env["project"].id))
    assert project["research"]["effective_visibility"] == "WORKSPACE"
    assert project["research"]["chain_visibility"] == "PRIVATE"
    chains = client.get(f"{env['base']}chains/")
    assert chains.status_code == 200, chains.data
    assert str(env["chain"].id) in {row["id"] for row in chains.json()["data"]}
    detail = client.get(env["chain_url"])
    assert detail.status_code == 200, detail.data
    assert detail.json()["data"]["effective_visibility"] == "WORKSPACE"
    assert detail.json()["data"]["capabilities"]["actions"]["view"]["allowed"] is True
    assert client.get(f"{env['chain_url']}nodes/").status_code == 200
    assert client.get(env["task_url"]).status_code == 200
    navigation = client.get(f"{env['base']}navigation/categories/", {"scope": "RESEARCH"})
    assert navigation.status_code == 200, navigation.data
    pending = list(navigation.json()["categories"])
    navigation_projects = list(navigation.json()["uncategorized"])
    while pending:
        category = pending.pop()
        navigation_projects.extend(category["projects"])
        pending.extend(category["children"])
    assert str(env["project"].id) in {row["id"] for row in navigation_projects}
    candidates = client.get(f"{env['chain_url']}assignable-users/")
    assert candidates.status_code == 200, candidates.data
    by_id = {row["user_id"]: row for row in candidates.json()["data"]}
    for key in ("student", "group_member", "descendant", "advisor", "workspace_admin"):
        assert by_id[str(env[key].id)]["scope"] == "WORKSPACE"
    assert str(env["guest"].id) not in by_id
    assert all("email" not in row for row in by_id.values())
    assert ProjectMember.objects.count() == member_count


def test_current_assignee_can_transfer_back_without_other_edit_rights(env):
    """承办人可指派回原指派人，事件、待办与能力同时更新。

    Args:
        env: 基础研究链测试环境。
    """
    client = client_for(env["group_member"])
    listed = client.get(env["tasks_url"]).json()
    assert listed["can_create"] is False
    actions = listed["data"][0]["capabilities"]["actions"]
    assert actions["assign"]["allowed"] is True
    assert actions["edit"]["allowed"] is False
    before = collect_chain_task_todos(env["workspace"], env["group_member"], "to_me")
    assert before[0]["capabilities"]["actions"]["assign"]["allowed"] is True
    with patch("plane.research.services.chain_tasks.notify_task_assigned") as notify:
        response = client.patch(env["task_url"], {"assignee": str(env["student"].id)}, format="json")
    assert response.status_code == 200, response.data
    assert response.json()["data"]["assignee"] == str(env["student"].id)
    assert response.json()["data"]["capabilities"]["actions"]["assign"]["allowed"] is False
    assert notify.call_count == 1
    event = ResearchChainEvent.objects.get(node=env["paper_node"], event_type="TASK_ASSIGNED")
    assert event.metadata["assignment_transfer_source"] == "WEB"
    assert event.metadata["email_assignment_transfer"] is False
    assert collect_chain_task_todos(env["workspace"], env["group_member"], "to_me") == []
    assert collect_chain_task_todos(env["workspace"], env["student"], "to_me")[0]["object_id"] == str(env["task"].id)
    stale = client.patch(env["task_url"], {"assignee": str(env["descendant"].id)}, format="json")
    assert stale.status_code == 403
    assert ResearchChainEvent.objects.filter(node=env["paper_node"], event_type="TASK_ASSIGNED").count() == 1


@pytest.mark.parametrize("field", ["title", "instruction", "due_at", "status", "unknown"])
def test_transfer_rejects_other_payload_fields(env, field):
    """承办人不能夹带可写、只读或未知字段扩大权限。

    Args:
        env: 基础研究链测试环境。
        field: 试图夹带的更新字段。
    """
    response = client_for(env["group_member"]).patch(
        env["task_url"], {"assignee": str(env["student"].id), field: "changed"}, format="json"
    )
    assert response.status_code == 403
    env["task"].refresh_from_db()
    assert env["task"].assignee_id == env["group_member"].id


def test_reader_cannot_create_assign_or_edit_other_tasks(env):
    """普通科研读者只能查看，不能新建或修改他人行动项。

    Args:
        env: 基础研究链测试环境。
    """
    client = client_for(env["descendant"])
    assert client.get(env["tasks_url"]).json()["can_create"] is False
    response = client.post(env["tasks_url"], {"title": "越权创建", "request_id": str(uuid4())}, format="json")
    assert response.status_code == 403
    response = client.patch(env["task_url"], {"assignee": str(env["student"].id)}, format="json")
    assert response.status_code == 403


def test_unconfigured_assignee_can_complete_and_reopen_historical_task(env):
    """历史承办人无需补配课题成员即可接收并处理行动项。

    Args:
        env: 基础研究链测试环境。
    """
    client = client_for(env["group_member"])
    assert client.get(env["task_url"]).json()["data"]["assignee_is_valid"] is True
    assert client.get(f"{env['task_url']}comments/").status_code == 200
    for action in ("complete", "reopen"):
        response = client.post(f"{env['task_url']}{action}/", {"request_id": str(uuid4())}, format="json")
        assert response.status_code == 200, response.data


def test_new_cross_group_assignee_receives_notification_and_todo(env):
    """无课题成员关系的跨组承办人可收到通知、待办并完成行动项。

    Args:
        env: 基础研究链测试环境。
    """
    target = env["descendant"]
    response = client_for(env["student"]).patch(env["task_url"], {"assignee": str(target.id)}, format="json")
    assert response.status_code == 200, response.data
    assert Notification.objects.filter(
        entity_identifier=env["task"].id, receiver=target, data__action="assigned"
    ).exists()
    assert collect_chain_task_todos(env["workspace"], target, "to_me")[0]["object_id"] == str(env["task"].id)
    response = client_for(target).post(f"{env['task_url']}complete/", {"request_id": uuid4().hex}, format="json")
    assert response.status_code == 200, response.data
    assert not ProjectMember.objects.filter(project=env["project"], member=target).exists()


@pytest.mark.parametrize("invalidity", ["seat", "guest", "account", "org"])
def test_notifications_exclude_former_research_members(env, invalidity):
    """任务通知同时过滤失效的原指派人，并保留有效科研订阅者。

    Args:
        env: 基础研究链测试环境。
        invalidity: 原指派人的身份失效方式。
    """
    former = env["student"]
    if invalidity == "org":
        OrgUnitMember.objects.filter(workspace=env["workspace"], user=former).update(
            effective_to=timezone.localdate() - timedelta(days=1)
        )
    elif invalidity == "account":
        former.is_active = False
        former.save(update_fields=["is_active"])
    else:
        values = {"is_active": False} if invalidity == "seat" else {"role": 5}
        WorkspaceMember.objects.filter(workspace=env["workspace"], member=former).update(**values)
    ResearchTaskSubscriber.objects.create(
        workspace=env["workspace"], task=env["task"], subscriber=env["descendant"], source="SELF"
    )
    response = client_for(env["group_member"]).post(
        f"{env['task_url']}complete/", {"request_id": uuid4().hex}, format="json"
    )
    assert response.status_code == 200, response.data
    notifications = Notification.objects.filter(entity_identifier=env["task"].id)
    assert not notifications.filter(receiver=former).exists()
    assert notifications.filter(receiver=env["descendant"], data__action="completed").exists()


@pytest.mark.parametrize("identity", ["valid", "seat", "guest", "account", "org"])
def test_queued_email_rechecks_research_recipient_identity(env, identity):
    """排队邮件发送前再次检查科研身份，防止撤权后沿用旧指派关系。

    Args:
        env: 基础研究链测试环境。
        identity: 收件人在邮件排队后的身份状态。
    """
    from plane.bgtasks.email_notification_task import _research_event_currently_authorized

    receiver = env["group_member"]
    if identity == "org":
        OrgUnitMember.objects.filter(workspace=env["workspace"], user=receiver).update(
            effective_to=timezone.localdate() - timedelta(days=1)
        )
    elif identity == "account":
        receiver.is_active = False
        receiver.save(update_fields=["is_active"])
    elif identity in {"seat", "guest"}:
        values = {"is_active": False} if identity == "seat" else {"role": 5}
        WorkspaceMember.objects.filter(workspace=env["workspace"], member=receiver).update(**values)
    event = SimpleNamespace(
        workspace_id=env["workspace"].id,
        entity_name="research_chain_task",
        entity_identifier=env["task"].id,
        action="assigned",
        payload={},
    )
    assert _research_event_currently_authorized(event, receiver) is (identity == "valid")


def test_writer_assignment_compares_against_locked_assignee(env):
    """写入者显式指派时，以锁内承办人为准处理并发转派后的旧页面。

    Args:
        env: 基础研究链测试环境。
    """
    ResearchChainNodeTask.objects.filter(pk=env["task"].pk).update(assignee=env["descendant"])
    updated = update_task(
        task=env["task"], actor=env["student"], payload={"assignee": env["group_member"]}
    )
    updated.refresh_from_db()
    assert updated.assignee_id == env["group_member"].id
    event = ResearchChainEvent.objects.get(node=env["paper_node"], event_type="TASK_ASSIGNED")
    assert event.metadata["previous_assignee"] == str(env["descendant"].id)


def test_assignment_to_same_named_member_preserves_event_and_notification(env):
    """两个成员同名时仍按用户主键识别转派，并保留事件与通知。

    Args:
        env: 基础研究链测试环境。
    """
    for key in ("group_member", "descendant"):
        env[key].display_name = "同名科研成员"
        env[key].save(update_fields=["display_name"])
    response = client_for(env["student"]).patch(
        env["task_url"], {"assignee": str(env["descendant"].id)}, format="json"
    )
    assert response.status_code == 200, response.data
    event = ResearchChainEvent.objects.get(node=env["paper_node"], event_type="TASK_ASSIGNED")
    assert event.metadata["assignee"] == str(env["descendant"].id)
    assert Notification.objects.filter(
        entity_identifier=env["task"].id, receiver=env["descendant"], data__action="assigned"
    ).exists()


def test_task_list_preloads_policy_and_reuses_capability_projection(env):
    """列表预加载分类所需关系，同一任务的能力投影不重复查询权限。

    Args:
        env: 基础研究链测试环境。
    """
    tasks = list(list_tasks(workspace=env["workspace"], chain=env["chain"], node=env["paper_node"]))
    with CaptureQueriesContext(connection) as policy_queries:
        assert all(is_basic_research_chain(task.chain.project.research_profile) for task in tasks)
    assert len(policy_queries) == 0
    serializer = ResearchChainNodeTaskSerializer(context={"request": SimpleNamespace(user=env["group_member"])})
    serializer.get_capabilities(tasks[0])
    with CaptureQueriesContext(connection) as repeated_queries:
        assert serializer.get_can_complete(tasks[0]) is True
        assert serializer.get_can_reopen(tasks[0]) is False
        assert serializer.get_capabilities(tasks[0])["actions"]["assign"]["allowed"] is True
    assert len(repeated_queries) == 0


@pytest.mark.parametrize(
    "invalidity", ["seat_inactive", "seat_deleted", "guest", "account", "org_expired", "org_deleted", "unit_inactive"]
)
def test_invalid_identities_are_excluded_from_all_candidate_paths(env, invalidity):
    """席位、账号或科研组织关系失效后，各入口同时撤销候选资格。

    Args:
        env: 基础研究链测试环境。
        invalidity: 失效关系类型。
    """
    target = env["descendant"]
    seat = WorkspaceMember.objects.get(workspace=env["workspace"], member=target)
    org_member = OrgUnitMember.objects.get(workspace=env["workspace"], user=target)
    objects = {
        "seat_inactive": (seat, "is_active", False),
        "seat_deleted": (seat, "deleted_at", timezone.now()),
        "guest": (seat, "role", 5),
        "account": (target, "is_active", False),
        "org_expired": (org_member, "effective_to", timezone.localdate() - timedelta(days=1)),
        "org_deleted": (org_member, "deleted_at", timezone.now()),
        "unit_inactive": (env["child_group"], "is_active", False),
    }
    instance, field, value = objects[invalidity]
    setattr(instance, field, value)
    instance.save(update_fields=[field])
    assert not validate_assignable_user(env["workspace"], env["chain"], target.id)
    assert target.id not in chain_assignable_user_ids(env["workspace"], env["chain"])
    assert target.id not in {user.id for user in assignment_transfer_candidates("research_chain_task", env["task"])}
    response = client_for(env["student"]).patch(env["task_url"], {"assignee": str(target.id)}, format="json")
    assert response.status_code in (403, 422)


def test_identity_without_org_and_user_without_workspace_seat_are_excluded(env):
    """普通工作区席位与其他工作区科研身份均不能获得候选资格。

    Args:
        env: 基础研究链测试环境。
    """
    no_org = make_user()
    add_workspace_member(env["workspace"], no_org)
    no_seat = make_user()
    OrgUnitMember.objects.create(workspace=env["workspace"], org_unit=env["group_a1"], user=no_seat)
    for user in (no_org, no_seat):
        assert not validate_assignable_user(env["workspace"], env["chain"], user.id)
        assert client_for(user).get(env["chain_url"]).status_code in (403, 404)


def test_seated_instance_admin_is_assignable_without_org_relation(env):
    """实例管理员无需组织关系，但仍须持有当前工作区有效席位。

    Args:
        env: 基础研究链测试环境。
    """
    admin = make_user()
    instance = Instance.objects.create(instance_id=uuid4().hex, current_version="test")
    InstanceAdmin.objects.create(instance=instance, user=admin, role=20)
    assert not validate_assignable_user(env["workspace"], env["chain"], admin.id)
    seat = add_workspace_member(env["workspace"], admin)
    assert validate_assignable_user(env["workspace"], env["chain"], admin.id)
    assert client_for(admin).get(env["chain_url"]).status_code == 200
    candidates = client_for(env["descendant"]).get(f"{env['chain_url']}assignable-users/").json()["data"]
    assert next(row for row in candidates if row["user_id"] == str(admin.id))["scope"] == "WORKSPACE"
    seat.is_active = False
    seat.save(update_fields=["is_active"])
    assert not validate_assignable_user(env["workspace"], env["chain"], admin.id)


def test_owner_moving_to_industrial_org_does_not_change_project_policy(env):
    """负责人调往产业化组织后，已有项目仍按项目归属组织开放。

    Args:
        env: 基础研究链测试环境。
    """
    env["group_b1"].business_category = "INDUSTRIALIZATION"
    env["group_b1"].save(update_fields=["business_category"])
    OrgUnitMember.objects.filter(workspace=env["workspace"], user=env["student"]).update(org_unit=env["group_b1"])
    env["project_profile"].refresh_from_db()
    assert is_basic_research_chain(env["project_profile"])
    assert client_for(env["descendant"]).get(env["chain_url"]).json()["data"]["effective_visibility"] == "WORKSPACE"
    assert validate_assignable_user(env["workspace"], env["chain"], env["student"].id)


def test_mcp_and_email_share_unconfigured_research_candidates(env, settings):
    """MCP 和邮件使用同一科研候选范围，无需补建课题成员。

    Args:
        env: 基础研究链测试环境。
        settings: MCP 测试开关。
    """
    from plane.tests.contract.app.test_unified_mcp import invoke, issued, reference

    settings.RESEARCH_MCP_ENABLED = settings.RESEARCH_MCP_WRITE_ENABLED = True
    WorkspaceResearchSetting.objects.filter(workspace=env["workspace"]).update(research_mcp_write_enabled=True)
    _connection, client = issued(
        {"workspace": env["workspace"], "owner_client": client_for(env["student"])},
        domains={"research": "read_write"},
    )
    target = reference(env, "ResearchChainNodeTask", env["task"])
    capabilities = invoke(client, "plane_get_context", {"target": target, "section": "capabilities"})["data"]
    assert str(env["descendant"].id) in {row["id"] for row in capabilities["assignable_users"]}
    assert env["descendant"].id in {
        user.id for user in assignment_transfer_candidates("research_chain_task", env["task"])
    }
    with patch("plane.research.services.chain_tasks.notify_task_assigned"):
        result = invoke(
            client, "plane_update_task", {"target": target, "changes": {"assignee": str(env["descendant"].id)}}
        )
    assert result["readback"] == "verified"
    env["task"].refresh_from_db()
    assert env["task"].assignee_id == env["descendant"].id
    assert not ProjectMember.objects.filter(project=env["project"], member=env["descendant"]).exists()


def test_mcp_assignee_capabilities_match_narrow_transfer_permission(env, settings):
    """MCP 如实公布承办人的单字段转派能力，并拒绝正文编辑。

    Args:
        env: 基础研究链测试环境。
        settings: MCP 测试开关。
    """
    from plane.tests.contract.app.test_unified_mcp import invoke, issued, reference

    settings.RESEARCH_MCP_ENABLED = settings.RESEARCH_MCP_WRITE_ENABLED = True
    WorkspaceResearchSetting.objects.filter(workspace=env["workspace"]).update(research_mcp_write_enabled=True)
    _connection, client = issued(
        {"workspace": env["workspace"], "owner_client": client_for(env["group_member"])},
        domains={"research": "read_write"},
    )
    target = reference(env, "ResearchChainNodeTask", env["task"])
    capabilities = invoke(client, "plane_get_context", {"target": target, "section": "capabilities"})["data"]
    assert "update_task" in capabilities["allowed_actions"]
    assert capabilities["editable_fields"] == ["assignee"]
    assert str(env["student"].id) in {row["id"] for row in capabilities["assignable_users"]}
    invoke(
        client,
        "plane_update_task",
        {"target": target, "changes": {"assignee": str(env["student"].id), "title": "越权编辑"}},
        error="permission_denied",
    )
    result = invoke(client, "plane_update_task", {"target": target, "changes": {"assignee": str(env["student"].id)}})
    assert result["readback"] == "verified"
    event = ResearchChainEvent.objects.get(node=env["paper_node"], event_type="TASK_ASSIGNED")
    assert event.metadata["assignment_transfer_source"] == "MCP"
    capabilities = invoke(client, "plane_get_context", {"target": target, "section": "capabilities"})["data"]
    assert "update_task" not in capabilities["allowed_actions"]
    assert capabilities["editable_fields"] == []
    assert capabilities["assignable_users"] == []


@pytest.mark.parametrize("parent", ["chain", "paper_node", "task"])
def test_readonly_parent_or_completed_task_blocks_transfer(env, parent):
    """归档研究链、归档节点和已完成任务均不可转派。

    Args:
        env: 基础研究链测试环境。
        parent: 进入只读状态的对象。
    """
    instance = env[parent]
    instance.status = "COMPLETED" if parent == "task" else "ARCHIVED"
    instance.save(update_fields=["status"])
    client = client_for(env["group_member"])
    assert client.get(env["task_url"]).json()["data"]["capabilities"]["actions"]["assign"]["allowed"] is False
    assert client.patch(env["task_url"], {"assignee": str(env["student"].id)}, format="json").status_code in (403, 409)


def test_transfer_rechecks_assignee_after_lock(env):
    """事务重新读取当前承办人，拒绝基于旧页面提交的转派。

    Args:
        env: 基础研究链测试环境。
    """
    ResearchChainNodeTask.objects.filter(pk=env["task"].pk).update(assignee=env["student"])
    with pytest.raises(ChainTaskPermissionError):
        transfer_task_by_current_assignee(
            task=env["task"], actor=env["group_member"], assignee_id=env["descendant"].id, source="WEB"
        )
    assert not ResearchChainEvent.objects.filter(node=env["paper_node"], event_type="TASK_ASSIGNED").exists()


@pytest.mark.parametrize("source", ["WEB", "EMAIL"])
def test_transfer_rechecks_current_assignee_identity(env, source):
    """基础研究链的网页和邮件转派均在锁内复核当前承办人身份。

    Args:
        env: 基础研究链测试环境。
        source: 转派入口来源。
    """
    OrgUnitMember.objects.filter(workspace=env["workspace"], user=env["group_member"]).update(
        effective_to=timezone.localdate() - timedelta(days=1)
    )
    with pytest.raises(ChainTaskPermissionError):
        transfer_task_by_current_assignee(
            task=env["task"], actor=env["group_member"], assignee_id=env["student"].id, source=source
        )
    env["task"].refresh_from_db()
    assert env["task"].assignee_id == env["group_member"].id


@pytest.mark.django_db(transaction=True)
def test_concurrent_transfers_only_allow_current_assignee_once(env):
    """并发转派在数据库锁内串行复核，只有一条请求能改变承办人。

    Args:
        env: 基础研究链测试环境。
    """

    def transfer(target):
        """使用独立连接模拟并发转派。

        Args:
            target: 新承办人的用户主键。

        Returns:
            转派是否成功。
        """
        close_old_connections()
        try:
            transfer_task_by_current_assignee(
                task=env["task"], actor=env["group_member"], assignee_id=target, source="WEB"
            )
            return True
        except ChainTaskPermissionError:
            return False
        finally:
            close_old_connections()

    with patch("plane.research.services.chain_tasks.notify_task_assigned"):
        with ThreadPoolExecutor(max_workers=2) as executor:
            outcomes = list(executor.map(transfer, [env["student"].id, env["descendant"].id]))
    assert sorted(outcomes) == [False, True]
    assert ResearchChainEvent.objects.filter(node=env["paper_node"], event_type="TASK_ASSIGNED").count() == 1


def test_industrial_chain_keeps_membership_and_visibility_boundary(env):
    """产业化项目保持配置成员后才能指派的原有边界。

    Args:
        env: 基础研究链测试环境。
    """
    env["group_a1"].business_category = "INDUSTRIALIZATION"
    env["group_a1"].save(update_fields=["business_category"])
    client = client_for(env["descendant"])
    assert client.get(env["chain_url"]).status_code == 404
    assert (
        not visible_profile_queryset(env["workspace"], env["descendant"]).filter(pk=env["project_profile"].pk).exists()
    )
    assert not validate_assignable_user(env["workspace"], env["chain"], env["group_member"].id)
    assert validate_assignable_user(env["workspace"], env["chain"], env["cross_org"].id)
    assert client_for(env["advisor"]).get(f"{env['chain_url']}assignable-users/").status_code == 403


def test_nearest_project_org_category_controls_policy_and_legacy_is_unchanged(env):
    """业务方向取项目组织最近分类，旧培养项目不采用开放策略。

    Args:
        env: 基础研究链测试环境。
    """
    unit = env["group_a1"]
    parent = env["direction_a"]
    unit.business_category = None
    unit.save(update_fields=["business_category"])
    parent.business_category = "BASIC_RESEARCH"
    parent.save(update_fields=["business_category"])
    profile = env["project_profile"]
    profile.refresh_from_db()
    assert is_basic_research_chain(profile)
    assert unit.id in basic_research_unit_ids(env["workspace"])
    unit.business_category = "INDUSTRIALIZATION"
    unit.save(update_fields=["business_category"])
    profile.refresh_from_db()
    assert not is_basic_research_chain(profile)
    assert unit.id not in basic_research_unit_ids(env["workspace"])
    unit.business_category = "BASIC_RESEARCH"
    unit.save(update_fields=["business_category"])
    profile.refresh_from_db()
    profile.chain_kind = "LEGACY_TRAINING"
    assert not is_basic_research_chain(profile)


@pytest.mark.parametrize("category", ["INDUSTRIALIZATION", None])
def test_nonbasic_chain_keeps_its_own_configured_visibility(env, category):
    """产业化和未知方向即使档案配置不同，也保留研究链原有可见性。

    Args:
        env: 基础研究链测试环境。
        category: 非基础研究业务方向。
    """
    env["group_a1"].business_category = category
    env["group_a1"].save(update_fields=["business_category"])
    env["project_profile"].chain_visibility = "WORKSPACE"
    env["project_profile"].save(update_fields=["chain_visibility"])
    env["chain"].refresh_from_db()
    assert chain_resource(env["chain"]).visibility == "PRIVATE"
    response = client_for(env["student"]).get(env["chain_url"])
    assert response.status_code == 200, response.data
    assert response.json()["data"]["effective_visibility"] == "PRIVATE"
