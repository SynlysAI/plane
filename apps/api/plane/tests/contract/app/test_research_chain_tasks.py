# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Research Chain node task API contracts."""

from collections import Counter
from uuid import uuid4

import pytest
from rest_framework.test import APIClient

from plane.db.models import (
    Notification,
    ResearchAuditEvent,
    ResearchChainEvent,
    ResearchChainNode,
    ResearchChainNodeTask,
)
from plane.research.services.chain_tasks import actor_can_review_task
from plane.tests.research_fixtures import make_research_boundary_fixture

pytestmark = pytest.mark.contract


@pytest.fixture
def env(db, settings):
    settings.RESEARCH_MODULE_ENABLED = True
    fixture = make_research_boundary_fixture()
    fixture.update(
        {
            "student_client": _client(fixture["student"]),
            "member_client": _client(fixture["group_member"]),
            "advisor_client": _client(fixture["advisor"]),
            "admin_client": _client(fixture["workspace_admin"]),
        }
    )
    return fixture


def _client(user):
    client = APIClient()
    client.force_authenticate(user=user)
    return client


def _url(env, task_id=""):
    suffix = f"{task_id}/" if task_id else ""
    return (
        f"/api/research/workspaces/{env['workspace'].slug}/chains/{env['chain'].id}/"
        f"nodes/{env['paper_node'].id}/tasks/{suffix}"
    )


def _action_url(env, task_id, action):
    return f"{_url(env, task_id)}{action}/"


def _create(env, client=None, **overrides):
    payload = {
        "title": "整理论文实验图表",
        "instruction": "补充误差棒和样本量说明。",
        "request_id": f"task-{uuid4()}",
    }
    payload.update(overrides)
    response = (client or env["student_client"]).post(_url(env), payload, format="json")
    assert response.status_code == 201, response.json()
    return response.json()["data"]


@pytest.mark.django_db
class TestResearchChainNodeTaskApi:
    def test_create_assign_submit_return_resubmit_and_complete(self, env):
        task = _create(env)
        assert task["status"] == "DRAFT"
        assert task["request_id"]
        assert task["schema_version"] == "research-chain-task.v1"

        assigned = (
            env["student_client"]
            .patch(
                _url(env, task["id"]),
                {"assignee": str(env["group_member"].id)},
                format="json",
            )
            .json()["data"]
        )
        assert assigned["status"] == "ASSIGNED"
        assert assigned["assignee"] == str(env["group_member"].id)
        assert assigned["assigned_by"] == str(env["student"].id)
        assert assigned["assignee_detail"]["display_name"]

        submitted = (
            env["member_client"]
            .post(
                _action_url(env, task["id"], "submit"),
                {"request_id": f"submit-{uuid4()}"},
                format="json",
            )
            .json()["data"]
        )
        assert submitted["status"] == "SUBMITTED"
        assert submitted["submitted_at"]

        returned = (
            env["advisor_client"]
            .post(
                _action_url(env, task["id"], "return"),
                {"request_id": f"return-{uuid4()}", "reason": "图中样本量缺失。"},
                format="json",
            )
            .json()["data"]
        )
        assert returned["status"] == "NEEDS_REVISION"

        resubmitted = (
            env["member_client"]
            .post(
                _action_url(env, task["id"], "submit"),
                {"request_id": f"resubmit-{uuid4()}"},
                format="json",
            )
            .json()["data"]
        )
        assert resubmitted["status"] == "SUBMITTED"

        completed = (
            env["advisor_client"]
            .post(
                _action_url(env, task["id"], "complete"),
                {"request_id": f"complete-{uuid4()}", "comment": "图表信息完整。"},
                format="json",
            )
            .json()["data"]
        )
        assert completed["status"] == "COMPLETED"
        assert completed["completed_at"]

        assert list(ResearchChainEvent.objects.filter(node=env["paper_node"]).values_list("event_type", flat=True)) == [
            "TASK_CREATED",
            "TASK_ASSIGNED",
            "TASK_SUBMITTED",
            "TASK_RETURNED",
            "TASK_SUBMITTED",
            "TASK_COMPLETED",
        ]
        assert list(
            ResearchAuditEvent.objects.filter(workspace=env["workspace"], resource_id=task["id"])
            .order_by("created_at")
            .values_list("action", flat=True)
        ) == [
            "task.create",
            "task.update",
            "task.submit",
            "task.return",
            "task.submit",
            "task.complete",
        ]
        notification_actions = Counter(
            Notification.objects.filter(entity_name="research_chain_task", data__task_id=task["id"]).values_list(
                "data__action", flat=True
            )
        )
        assert notification_actions == {
            "assigned": 1,
            "submitted": 6,
            "returned": 1,
            "completed": 1,
        }
        env["paper_node"].refresh_from_db()
        assert env["paper_node"].status == ResearchChainNode.Status.ACTIVE

    def test_tasks_can_be_listed_and_filtered(self, env):
        first = _create(env, title="First", assignee=str(env["group_member"].id))
        _create(env, title="Second")

        response = env["advisor_client"].get(_url(env), {"status": "ASSIGNED"})
        assert response.status_code == 200, response.json()
        data = response.json()["data"]
        assert [item["id"] for item in data] == [first["id"]]
        assert data[0]["title"] == "First"

    def test_assignee_outside_server_candidate_scope_is_rejected(self, env):
        response = env["student_client"].post(
            _url(env),
            {
                "title": "越权任务",
                "assignee": str(env["descendant"].id),
                "request_id": f"invalid-task-{uuid4()}",
            },
            format="json",
        )

        assert response.status_code == 403
        assert response.json()["error_code"] == "research_permission_denied"
        assert not ResearchChainNodeTask.objects.filter(title="越权任务").exists()

    def test_only_current_assignee_can_submit(self, env):
        task = _create(env, assignee=str(env["group_member"].id))
        response = env["student_client"].post(
            _action_url(env, task["id"], "submit"),
            {"request_id": f"wrong-submit-{uuid4()}"},
            format="json",
        )

        assert response.status_code == 403
        assert response.json()["error_code"] == "research_permission_denied"
        task = ResearchChainNodeTask.objects.get(pk=task["id"])
        assert task.status == ResearchChainNodeTask.Status.ASSIGNED

    def test_review_actions_require_research_review_permission(self, env):
        task = _create(env, assignee=str(env["group_member"].id))
        env["member_client"].post(
            _action_url(env, task["id"], "submit"),
            {"request_id": f"admin-submit-{uuid4()}"},
            format="json",
        )
        persisted_task = ResearchChainNodeTask.objects.get(pk=task["id"])
        assert actor_can_review_task(env["workspace"], persisted_task, env["workspace_admin"])
        response = env["member_client"].post(
            _action_url(env, task["id"], "return"),
            {"request_id": f"unauthorized-return-{uuid4()}", "reason": "Current assignee."},
            format="json",
        )

        assert response.status_code == 403
        assert response.json()["error_code"] == "research_permission_denied"
        assert ResearchChainNodeTask.objects.get(pk=task["id"]).status == "SUBMITTED"

    def test_manager_can_cancel_open_task(self, env):
        task = _create(env, assignee=str(env["group_member"].id))
        response = env["student_client"].post(
            _action_url(env, task["id"], "cancel"),
            {"request_id": f"cancel-{uuid4()}", "reason": "课题方向调整。"},
            format="json",
        )

        assert response.status_code == 200, response.json()
        assert response.json()["data"]["status"] == "CANCELLED"
        assert ResearchChainEvent.objects.filter(event_type="TASK_CANCELLED").exists()
        assert ResearchAuditEvent.objects.filter(action="task.cancel").exists()
        assert Notification.objects.filter(entity_name="research_chain_task", data__action="cancelled").exists()

    def test_create_is_idempotent_by_request_id(self, env):
        request_id = f"idempotent-{uuid4()}"
        payload = {"title": "幂等任务", "request_id": request_id}

        first = env["student_client"].post(_url(env), payload, format="json")
        second = env["student_client"].post(_url(env), payload, format="json")

        assert first.status_code == 201
        assert second.status_code == 200
        assert second.json()["data"]["id"] == first.json()["data"]["id"]
        assert ResearchChainNodeTask.objects.filter(request_id=request_id).count() == 1
        assert ResearchChainEvent.objects.filter(request_id=request_id).count() == 1

    def test_task_lifecycle_does_not_touch_node_workflow(self, env):
        task = _create(env, assignee=str(env["group_member"].id))
        before_updated_at = env["paper_node"].updated_at

        env["member_client"].post(
            _action_url(env, task["id"], "submit"),
            {"request_id": f"isolate-submit-{uuid4()}"},
            format="json",
        )
        env["advisor_client"].post(
            _action_url(env, task["id"], "complete"),
            {"request_id": f"isolate-complete-{uuid4()}"},
            format="json",
        )

        env["paper_node"].refresh_from_db()
        assert env["paper_node"].status == ResearchChainNode.Status.ACTIVE
        assert env["paper_node"].updated_at == before_updated_at
