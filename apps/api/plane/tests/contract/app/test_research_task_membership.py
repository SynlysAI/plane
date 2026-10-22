"""科研任务必须先加入课题才能指派、接收待办与提交。"""

from io import StringIO
import json
from uuid import uuid4
from unittest.mock import patch

import pytest
from django.core.management import call_command
from rest_framework.test import APIClient

from plane.db.models import ProjectMember, ResearchChainNodeTask, ResearchChainEvent
from plane.research.services.chain_tasks import ChainTaskPermissionError, submit_task
from plane.research.services.research_todos import collect_chain_task_todos
from plane.tests.research_fixtures import make_research_boundary_fixture

pytestmark = [pytest.mark.contract, pytest.mark.django_db]


@pytest.fixture
def env(settings):
    """构造私有课题及有组织身份但尚未加入课题的负责人。"""
    settings.RESEARCH_MODULE_ENABLED = True
    data = make_research_boundary_fixture()
    profile = data["project"].research_profile
    profile.chain_visibility = "PRIVATE"
    profile.save(update_fields=["chain_visibility"])
    data["chain"].visibility = "PRIVATE"
    data["chain"].save(update_fields=["visibility"])
    data["owner_client"] = APIClient()
    data["owner_client"].force_authenticate(user=data["student"])
    data["member_client"] = APIClient()
    data["member_client"].force_authenticate(user=data["group_member"])
    data["url"] = (
        f"/api/research/workspaces/{data['workspace'].slug}/chains/{data['chain'].id}/"
        f"nodes/{data['paper_node'].id}/tasks/"
    )
    return data


def legacy_task(env, status="ASSIGNED"):
    """创建历史指派，保留未加入课题的负责人。

    Args:
        env: 私有课题环境。
        status: 历史任务状态。

    Returns:
        新建的历史科研任务。
    """
    return ResearchChainNodeTask.objects.create(
        workspace=env["workspace"],
        chain=env["chain"],
        node=env["paper_node"],
        title="文献调研",
        status=status,
        assignee=env["group_member"],
        created_by=env["student"],
        assigned_by=env["student"],
        request_id=str(uuid4()),
        payload_hash="legacy",
    )


def test_nonmember_create_and_reassignment_rejected(env):
    """私有课题的同组织非成员无法通过创建或改派接口绕过校验。"""
    payload = {"title": "文献调研", "assignee": str(env["group_member"].id), "request_id": str(uuid4())}
    response = env["owner_client"].post(env["url"], payload, format="json")
    assert response.status_code == 403
    assert not ResearchChainNodeTask.objects.filter(chain=env["chain"]).exists()
    task = legacy_task(env)
    response = env["owner_client"].patch(env["url"] + f"{task.id}/", payload, format="json")
    assert response.status_code == 403
    task.refresh_from_db()
    assert task.assignee_id == env["group_member"].id
    assert task.status == "ASSIGNED"


def test_membership_restores_todo_detail_comments_and_submission(env):
    """补充课题成员后，历史任务自动恢复待办及处理入口。"""
    task = legacy_task(env)
    detail = env["url"] + f"{task.id}/"
    owner_data = env["owner_client"].get(detail).json()["data"]
    assert owner_data["assignee_is_valid"] is False
    assert owner_data["assignee_detail"]["id"] == str(env["group_member"].id)
    assert env["member_client"].get(detail).status_code == 404
    assert collect_chain_task_todos(env["workspace"], env["group_member"], "to_me") == []
    blocked = collect_chain_task_todos(env["workspace"], env["student"], "to_me")
    assert blocked[0]["handling_status"] == "BLOCKED"
    assert blocked[0]["next_action"] == "ASSIGN"
    member = ProjectMember.objects.create(project=env["project"], member=env["group_member"], role=15)
    data = env["member_client"].get(detail).json()["data"]
    assert data["assignee_is_valid"] is True
    assert data["capabilities"]["actions"]["submit"]["allowed"] is True
    assert env["member_client"].get(detail + "comments/").status_code == 200
    todos = collect_chain_task_todos(env["workspace"], env["group_member"], "to_me")
    assert [row["object_id"] for row in todos] == [str(task.id)]
    member.is_active = False
    member.save(update_fields=["is_active"])
    assert env["member_client"].post(detail + "submit/", {"request_id": str(uuid4())}, format="json").status_code == 404
    member.is_active = True
    member.save(update_fields=["is_active"])
    response = env["member_client"].post(detail + "submit/", {"request_id": str(uuid4())}, format="json")
    assert response.status_code == 200, response.data
    assert response.json()["data"]["status"] == "SUBMITTED"


def test_submit_rechecks_membership_inside_transaction(env):
    """事务内复核成员资格失败时不产生提交状态或活动。"""
    task = legacy_task(env)
    ProjectMember.objects.create(project=env["project"], member=env["group_member"], role=15)
    with patch("plane.research.services.chain_tasks.validate_assignable_user", side_effect=[True, False]):
        with pytest.raises(ChainTaskPermissionError):
            submit_task(task=task, actor=env["group_member"], request_id=str(uuid4()), content_hash="submit")
    task.refresh_from_db()
    assert task.status == "ASSIGNED"
    assert not ResearchChainEvent.objects.filter(chain=env["chain"], event_type="TASK_SUBMITTED").exists()


def test_unassigned_task_reports_invalid_assignee(env):
    """无负责人时只读资格字段为 false，且不授予提交能力。"""
    task = ResearchChainNodeTask.objects.create(
        workspace=env["workspace"],
        chain=env["chain"],
        node=env["paper_node"],
        title="待指派文献调研",
        status="DRAFT",
        created_by=env["student"],
        request_id=str(uuid4()),
        payload_hash="unassigned",
    )
    data = env["owner_client"].get(env["url"] + f"{task.id}/").json()["data"]

    assert data["assignee"] is None
    assert data["assignee_detail"] is None
    assert data["assignee_is_valid"] is False
    assert data["capabilities"]["actions"]["submit"]["allowed"] is False


def test_invalid_submitted_task_keeps_review_workflow(env):
    """负责人失效不改变已经提交的审核流转。"""
    task = legacy_task(env, status="SUBMITTED")
    todos = collect_chain_task_todos(env["workspace"], env["advisor"], "to_me")
    row = next(row for row in todos if row["object_id"] == str(task.id))
    assert row["handling_status"] == "IN_PROGRESS"
    assert row["next_action"] == "REVIEW"
    assert row["capabilities"]["actions"]["review"]["allowed"] is True


def test_assignment_audit_is_read_only_and_scoped(env):
    """审计只列出指定工作区的无效指派，保留历史数据。"""
    task = legacy_task(env)
    output = StringIO()
    before = ResearchChainNodeTask.objects.values().get(id=task.id)
    member_count = ProjectMember.objects.count()
    call_command("audit_research_task_assignees", env["workspace"].slug, "--json", stdout=output)
    rows = json.loads(output.getvalue())["tasks"]
    assert [row["task_id"] for row in rows] == [str(task.id)]
    assert ResearchChainNodeTask.objects.values().get(id=task.id) == before
    assert ProjectMember.objects.count() == member_count
    ProjectMember.objects.create(project=env["project"], member=env["group_member"], role=15)
    output = StringIO()
    call_command("audit_research_task_assignees", env["workspace"].slug, "--json", stdout=output)
    assert json.loads(output.getvalue())["tasks"] == []
