# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Research Chain action-item task API contracts."""

from uuid import uuid4

import pytest
from rest_framework.test import APIClient

from plane.db.models import (
    Notification,
    ProjectMember,
    ResearchApprovalRoute,
    ResearchAuditEvent,
    ResearchChainEvent,
    ResearchChainNode,
    ResearchChainNodeTask,
    ResearchTaskSubscriber,
)
from plane.tests.research_fixtures import make_research_boundary_fixture

pytestmark = pytest.mark.contract


@pytest.fixture
def env(db, settings):
    settings.RESEARCH_MODULE_ENABLED = True
    fixture = make_research_boundary_fixture()
    for key in ("group_member", "advisor"):
        ProjectMember.objects.create(project=fixture["project"], member=fixture[key], role=15)
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


def _notification_url(env, task_id, suffix=""):
    return f"{_url(env, task_id)}notification-recipients/{suffix}"


def _action(env, task_id, action, client=None, **payload):
    response = (client or env["member_client"]).post(
        _action_url(env, task_id, action),
        {"request_id": f"{action}-{uuid4()}", **payload},
        format="json",
    )
    assert response.status_code == 200, response.json()
    return response.json()["data"]


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
    def test_assignee_can_repeatedly_complete_and_reopen_task(self, env):
        task = _create(env, assignee=str(env["group_member"].id))
        assert task["status"] == "ASSIGNED"

        completed = _action(env, task["id"], "complete", comment="图表信息完整。")
        assert completed["status"] == "COMPLETED"
        assert completed["completed_at"]
        assert completed["completed_by"] == str(env["group_member"].id)
        assert completed["can_reopen"] is True

        reopened = _action(env, task["id"], "reopen", reason="需要补充一版图注。")
        assert reopened["status"] == "ASSIGNED"
        assert reopened["completed_at"] is None
        assert reopened["completed_by"] is None
        assert reopened["can_complete"] is True

        completed_again = _action(env, task["id"], "complete")
        assert completed_again["status"] == "COMPLETED"

        assert list(ResearchChainEvent.objects.filter(node=env["paper_node"]).values_list("event_type", flat=True)) == [
            "TASK_CREATED",
            "TASK_COMPLETED",
            "TASK_REOPENED",
            "TASK_COMPLETED",
        ]
        assert list(
            ResearchAuditEvent.objects.filter(workspace=env["workspace"], resource_id=task["id"])
            .order_by("created_at")
            .values_list("action", flat=True)
        ) == ["task.create", "task.complete", "task.reopen", "task.complete"]

    def test_advisor_or_pi_assignee_can_complete_without_task_review(self, env):
        task = _create(env, assignee=str(env["advisor"].id))
        assert task["status"] == "ASSIGNED"

        completed = _action(env, task["id"], "complete", client=env["advisor_client"])
        assert completed["status"] == "COMPLETED"
        assert not ResearchApprovalRoute.objects.filter(resource_id=task["id"]).exists()

    def test_only_current_assignee_can_complete_or_reopen(self, env):
        assigned = _create(env, assignee=str(env["group_member"].id))
        forbidden_complete = env["student_client"].post(
            _action_url(env, assigned["id"], "complete"),
            {"request_id": f"forbidden-complete-{uuid4()}"},
            format="json",
        )
        assert forbidden_complete.status_code == 403
        assert forbidden_complete.json()["error_code"] == "research_permission_denied"
        assert ResearchChainNodeTask.objects.get(pk=assigned["id"]).status == "ASSIGNED"

        _action(env, assigned["id"], "complete")
        forbidden_reopen = env["admin_client"].post(
            _action_url(env, assigned["id"], "reopen"),
            {"request_id": f"forbidden-reopen-{uuid4()}"},
            format="json",
        )
        assert forbidden_reopen.status_code == 403
        assert ResearchChainNodeTask.objects.get(pk=assigned["id"]).status == "COMPLETED"

    def test_task_approval_actions_and_route_are_no_longer_exposed(self, env):
        task = _create(env, assignee=str(env["group_member"].id))
        for action in ("submit", "withdraw", "return"):
            response = env["member_client"].post(
                _action_url(env, task["id"], action),
                {"request_id": f"legacy-{action}-{uuid4()}"},
                format="json",
            )
            assert response.status_code == 404
            assert response.json()["error_code"] == "research_chain_invalid"

        route = env["member_client"].get(
            _url(
                env,
                task["id"],
            ).rstrip("/")
            + "/approval-route/"
        )
        assert route.status_code in (404, 405)
        assert not ResearchApprovalRoute.objects.filter(resource_id=task["id"]).exists()

    def test_notification_members_continue_to_receive_task_updates(self, env):
        ProjectMember.objects.create(project=env["project"], member=env["descendant"], role=15)
        descendant_client = _client(env["descendant"])
        task = _create(env, assignee=str(env["group_member"].id))

        listed = env["student_client"].get(_notification_url(env, task["id"])).json()["data"]
        assert str(env["descendant"].id) in {item["id"] for item in listed["candidates"]}

        replaced = env["student_client"].put(
            _notification_url(env, task["id"]),
            {"user_ids": [str(env["descendant"].id)]},
            format="json",
        )
        assert replaced.status_code == 200, replaced.json()
        assert replaced.json()["data"]["cc_user_ids"] == [str(env["descendant"].id)]
        assert ResearchTaskSubscriber.objects.filter(
            task_id=task["id"], subscriber=env["descendant"], source="CC"
        ).exists()
        assert descendant_client.post(_notification_url(env, task["id"], "me/"), {}, format="json").status_code == 200

        _action(env, task["id"], "complete")
        assert Notification.objects.filter(
            entity_name="research_chain_task", receiver=env["descendant"], data__action="completed"
        ).exists()

    def test_notification_member_outside_boundary_is_rejected(self, env):
        task = _create(env)
        response = env["student_client"].put(
            _notification_url(env, task["id"]),
            {"user_ids": [str(env["guest"].id)]},
            format="json",
        )

        assert response.status_code == 422
        assert response.json()["error_code"] == "research_chain_invalid"
        assert not ResearchTaskSubscriber.objects.filter(task_id=task["id"], subscriber=env["guest"]).exists()

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

    def test_manager_can_cancel_task(self, env):
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

        _action(env, task["id"], "complete")
        _action(env, task["id"], "reopen")

        env["paper_node"].refresh_from_db()
        assert env["paper_node"].status == ResearchChainNode.Status.ACTIVE
        assert env["paper_node"].updated_at == before_updated_at
