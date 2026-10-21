# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Server-side unified research todo projection contracts."""

from datetime import timedelta
from hashlib import sha256
from uuid import uuid4

import pytest
from django.utils import timezone
from rest_framework.test import APIClient

from plane.db.models import (
    ApprovalFlow,
    ApprovalFlowStep,
    ApprovalRequest,
    Issue,
    OrgUnitMember,
    Page,
    PeriodicReport,
    ProjectMember,
    ResearchChainNodeTask,
    ResearchPaperReview,
    ResearchAgentRunEvent,
    ResearchAgentSession,
    ResearchContextGrant,
    ResearchStageInstance,
    StageReview,
    ReviewerRole,
    StageReviewerAssignment,
    StageType,
)
from plane.tests.research_fixtures import make_research_boundary_fixture

pytestmark = pytest.mark.contract


def _client(user):
    client = APIClient()
    client.force_authenticate(user=user)
    return client


def _digest(*parts):
    return sha256(":".join(str(part) for part in parts).encode()).hexdigest()


def _task(env, status, *, due=None, title="节点任务"):
    return ResearchChainNodeTask.objects.create(
        workspace=env["workspace"],
        chain=env["chain"],
        node=env["paper_node"],
        title=title,
        status=status,
        assignee=env["group_member"],
        assigned_by=env["student"],
        due_at=due,
        request_id=f"todo-task-{uuid4()}",
        payload_hash=_digest(uuid4()),
    )


def _owned_task(env, status, *, assignee=None, assigned_by=None, created_by=None, title="责任任务"):
    """Create one task with explicit initiator and owner audit fields."""
    return ResearchChainNodeTask.objects.create(
        workspace=env["workspace"],
        chain=env["chain"],
        node=env["paper_node"],
        title=title,
        status=status,
        assignee=assignee,
        assigned_by=assigned_by,
        created_by=created_by,
        request_id=f"todo-responsibility-{uuid4()}",
        payload_hash=_digest(uuid4()),
    )


def _paper(env, status, *, due=None):
    return ResearchPaperReview.objects.create(
        workspace=env["workspace"],
        chain=env["chain"],
        node=env["paper_node"],
        owner=env["student"],
        status=status,
        current_version_no=1,
        final_reviewer=env["advisor"],
        due_at=due,
        request_id=f"todo-paper-{uuid4()}",
        payload_hash=_digest(uuid4()),
    )


def _revision_report(env):
    page = Page.objects.create(
        workspace=env["workspace"],
        name="2026-W42 revision report",
        description_json={"type": "doc", "content": []},
        owned_by=env["student"],
        access=Page.PRIVATE_ACCESS,
    )
    report = PeriodicReport.objects.create(
        workspace=env["workspace"],
        project=env["project"],
        owner=env["student"],
        org_unit=env["group_a1"],
        page=page,
        report_type=PeriodicReport.ReportType.WEEKLY,
        period_key="2026-W42",
        period_start=timezone.localdate(),
        period_end=timezone.localdate() + timedelta(days=6),
        status=PeriodicReport.Status.NEEDS_REVISION,
        submitted_at=timezone.now(),
    )
    report.official_snapshots.create(
        version_no=1,
        snapshot_status=PeriodicReport.Status.SUBMITTED,
        description_json=page.description_json,
        description_html="",
        description_stripped="",
        submitted_by=env["student"],
    )
    return report


def _stage(env):
    stage = ResearchStageInstance.objects.create(
        workspace=env["workspace"],
        project=env["project"],
        stage=StageType.PRE_OPENING,
        status=ResearchStageInstance.Status.SUBMITTED,
        sort_order=1,
        org_unit=env["group_a1"],
        submitted_at=timezone.now(),
    )
    StageReviewerAssignment.objects.create(
        stage_instance=stage,
        reviewer=env["advisor"],
        reviewer_role=ReviewerRole.DIRECT_ADVISOR,
        assigned_by=env["student"],
    )
    return stage


def _office_approval(env):
    issue = Issue.objects.create(
        name="Purchase a conference ticket",
        project=env["project"],
        workspace=env["workspace"],
        created_by=env["student"],
    )
    flow = ApprovalFlow.objects.create(
        workspace=env["workspace"],
        org_unit=env["group_a1"],
        approval_type="PURCHASE",
        name="Group purchase",
        created_by=env["student"],
    )
    ApprovalFlowStep.objects.create(
        flow=flow,
        order=1,
        approver_user=env["advisor"],
        created_by=env["student"],
    )
    return ApprovalRequest.objects.create(
        issue=issue,
        flow=flow,
        approval_type="PURCHASE",
        status=ApprovalRequest.Status.PENDING,
        current_step_order=1,
        requested_by=env["student"],
        org_unit=env["group_a1"],
        research_project=env["project"],
        created_by=env["student"],
    )


@pytest.fixture
def env(db, settings):
    settings.RESEARCH_MODULE_ENABLED = True
    fixture = make_research_boundary_fixture()
    now = timezone.now()
    fixture.update(
        {
            "assigned_task": _task(
                fixture,
                ResearchChainNodeTask.Status.ASSIGNED,
                due=now + timedelta(days=2),
                title="补充实验图表",
            ),
            "submitted_task": _task(
                fixture,
                ResearchChainNodeTask.Status.SUBMITTED,
                due=now - timedelta(hours=1),
                title="提交论文对照说明",
            ),
            "returned_task": _task(
                fixture,
                ResearchChainNodeTask.Status.NEEDS_REVISION,
                due=now + timedelta(days=1),
                title="修订技术路线说明",
            ),
            "waiting_paper": _paper(fixture, ResearchPaperReview.Status.WAITING_REVIEW),
            "returned_paper": _paper(fixture, ResearchPaperReview.Status.NEEDS_REVISION),
            "revision_report": _revision_report(fixture),
            "stage": _stage(fixture),
            "office_approval": _office_approval(fixture),
            "student_client": _client(fixture["student"]),
            "member_client": _client(fixture["group_member"]),
            "advisor_client": _client(fixture["advisor"]),
            "admin_client": _client(fixture["workspace_admin"]),
            "empty_client": _client(fixture["descendant"]),
        }
    )
    return fixture


def _get(env, user_key, query=""):
    client = env[f"{user_key}_client"]
    return client.get(f"/api/research/workspaces/{env['workspace'].slug}/research-todos/{query}")


def _payload(response):
    assert response.status_code == 200, response.json()
    return response.json()


def _items(payload):
    return payload["results"]


def _by_source(items):
    return {item["source"]: item for item in items}


@pytest.mark.django_db
class TestResearchTodoScopesAndAcl:
    def test_archived_chain_tasks_are_excluded_from_todos(self, env):
        env["chain"].status = "ARCHIVED"
        env["chain"].save(update_fields=["status", "updated_at"])
        env["project"].research_profile.workflow_status = "ARCHIVED"
        env["project"].research_profile.save(update_fields=["workflow_status", "is_active", "updated_at"])

        payload = _payload(_get(env, "student", "?scope=visible"))
        task_ids = {str(env[key].id) for key in ("assigned_task", "submitted_task", "returned_task")}

        assert task_ids.isdisjoint({item["object_id"] for item in _items(payload) if item["source"] == "CHAIN_TASK"})

    def test_all_six_sources_successfully_project_the_v2_contract(self, env):
        payload = _payload(_get(env, "student", "?scope=visible"))

        assert payload["schema_version"] == "research-todo.v2"
        assert set(_by_source(_items(payload))) == {
            "CHAIN_TASK",
            "REPORT",
            "PAPER_REVIEW",
            "STAGE_REVIEW",
            "OFFICE_APPROVAL",
        }
        assert all(item["schema_version"] == "research-todo.v2" for item in _items(payload))

    def test_chain_task_reassignment_moves_the_submit_todo(self, env):
        task = _owned_task(
            env,
            ResearchChainNodeTask.Status.ASSIGNED,
            assignee=env["group_member"],
            assigned_by=env["student"],
            created_by=env["student"],
        )

        before_group = _payload(_get(env, "member", "?scope=to_me"))
        before_advisor = _payload(_get(env, "advisor", "?scope=to_me"))
        assert str(task.id) in {item["object_id"] for item in before_group["results"] if item["source"] == "CHAIN_TASK"}
        assert str(task.id) not in {
            item["object_id"] for item in before_advisor["results"] if item["source"] == "CHAIN_TASK"
        }

        task.assignee = env["advisor"]
        task.save(update_fields=["assignee", "updated_at"])
        after_group = _payload(_get(env, "member", "?scope=to_me"))
        after_advisor = _payload(_get(env, "advisor", "?scope=to_me"))

        assert str(task.id) not in {
            item["object_id"] for item in after_group["results"] if item["source"] == "CHAIN_TASK"
        }
        assert str(task.id) in {
            item["object_id"] for item in after_advisor["results"] if item["source"] == "CHAIN_TASK"
        }

    def test_unassigned_or_invalid_chain_task_only_todos_its_initiator(self, env):
        unassigned = _owned_task(
            env,
            ResearchChainNodeTask.Status.DRAFT,
            assigned_by=env["student"],
            created_by=env["student"],
        )
        invalid_owner = _owned_task(
            env,
            ResearchChainNodeTask.Status.DRAFT,
            assignee=env["guest"],
            assigned_by=env["student"],
            created_by=env["student"],
        )

        student_items = _items(_payload(_get(env, "student", "?scope=to_me")))
        member_items = _items(_payload(_get(env, "member", "?scope=to_me")))
        student_tasks = {item["object_id"]: item for item in student_items if item["source"] == "CHAIN_TASK"}
        member_tasks = {item["object_id"] for item in member_items if item["source"] == "CHAIN_TASK"}

        assert student_tasks[str(unassigned.id)]["next_action"] == "ASSIGN"
        assert student_tasks[str(invalid_owner.id)]["next_action"] == "ASSIGN"
        assert {str(unassigned.id), str(invalid_owner.id)}.isdisjoint(member_tasks)

    def test_submitted_chain_task_only_todos_qualified_reviewers(self, env):
        student_items = _items(_payload(_get(env, "student", "?scope=to_me")))
        member_items = _items(_payload(_get(env, "member", "?scope=to_me")))
        advisor_items = _items(_payload(_get(env, "advisor", "?scope=to_me")))
        task_id = str(env["submitted_task"].id)

        assert task_id not in {item["object_id"] for item in student_items if item["source"] == "CHAIN_TASK"}
        assert task_id not in {item["object_id"] for item in member_items if item["source"] == "CHAIN_TASK"}
        assert task_id in {item["object_id"] for item in advisor_items if item["source"] == "CHAIN_TASK"}

    def test_mine_uses_actual_creator_and_historical_fallbacks(self, env):
        creator_task = _owned_task(
            env,
            ResearchChainNodeTask.Status.ASSIGNED,
            assignee=env["group_member"],
            assigned_by=env["student"],
        )
        ResearchChainNodeTask.objects.filter(pk=creator_task.pk).update(created_by=env["advisor"])
        fallback_task = _owned_task(
            env,
            ResearchChainNodeTask.Status.ASSIGNED,
            assignee=env["group_member"],
            assigned_by=env["student"],
        )
        ResearchChainNodeTask.objects.filter(pk=fallback_task.pk).update(created_by=None)
        owner_fallback = _owned_task(
            env,
            ResearchChainNodeTask.Status.ASSIGNED,
            assignee=env["group_member"],
        )
        ResearchChainNodeTask.objects.filter(pk=owner_fallback.pk).update(created_by=None, assigned_by=None)

        student_items = {item["object_id"] for item in _items(_payload(_get(env, "student", "?scope=mine")))}
        advisor_items = {item["object_id"] for item in _items(_payload(_get(env, "advisor", "?scope=mine")))}

        assert str(creator_task.id) not in student_items
        assert str(creator_task.id) in advisor_items
        assert str(fallback_task.id) in student_items
        assert str(owner_fallback.id) in student_items

    def test_non_responsible_visible_users_do_not_receive_other_research_todos(self, env):
        member_items = _items(_payload(_get(env, "member", "?scope=to_me")))
        sources = {item["source"] for item in member_items}

        assert "REPORT" not in sources
        assert "PAPER_REVIEW" not in sources
        assert "STAGE_REVIEW" not in sources
        assert "OFFICE_APPROVAL" not in sources

    def test_report_paper_and_stage_owners_or_current_reviewers_own_todos(self, env):
        student_items = {
            (item["source"], item["object_id"]): item for item in _items(_payload(_get(env, "student", "?scope=to_me")))
        }
        advisor_items = {
            (item["source"], item["object_id"]): item for item in _items(_payload(_get(env, "advisor", "?scope=to_me")))
        }

        assert ("REPORT", str(env["revision_report"].id)) in student_items
        assert ("REPORT", str(env["report"].id)) not in student_items
        assert ("REPORT", str(env["report"].id)) in advisor_items
        assert ("PAPER_REVIEW", str(env["returned_paper"].id)) in student_items
        assert ("PAPER_REVIEW", str(env["waiting_paper"].id)) not in student_items
        assert ("PAPER_REVIEW", str(env["waiting_paper"].id)) in advisor_items
        assert ("STAGE_REVIEW", str(env["stage"].id)) not in student_items
        assert ("STAGE_REVIEW", str(env["stage"].id)) in advisor_items

    def test_completed_stage_reviewer_keeps_history_access_without_a_todo(self, env):
        StageReview.objects.create(
            stage_instance=env["stage"],
            reviewer=env["advisor"],
            reviewer_role=ReviewerRole.DIRECT_ADVISOR,
            recommendation=StageReview.Recommendation.PASS,
            submitted_at=timezone.now(),
        )

        advisor_items = _items(_payload(_get(env, "advisor", "?scope=to_me")))

        assert str(env["stage"].id) not in {
            item["object_id"] for item in advisor_items if item["source"] == "STAGE_REVIEW"
        }

    def test_agent_approval_todo_is_limited_to_non_review_initiator(self, env):
        env["workspace"].research_setting.research_agent_enabled = True
        env["workspace"].research_setting.save(update_fields=["research_agent_enabled", "updated_at"])
        grant = ResearchContextGrant.objects.create(
            workspace=env["workspace"],
            user=env["student"],
            project=env["project"],
            chain_node=env["paper_node"],
            scope_kind="OWNER",
            context_hash=_digest("context"),
            token_hash=_digest("token"),
            expires_at=timezone.now() + timedelta(hours=1),
            request_id=f"todo-agent-grant-{uuid4()}",
        )
        session = ResearchAgentSession.objects.create(
            workspace=env["workspace"],
            user=env["student"],
            project=env["project"],
            chain_node=env["paper_node"],
            context_grant=grant,
            status=ResearchAgentSession.Status.WAITING_APPROVAL,
            request_id=f"todo-agent-session-{uuid4()}",
            payload_hash=_digest("session"),
        )
        ResearchAgentRunEvent.objects.create(
            session=session,
            run_id=session.run_id,
            seq=1,
            event_type="TOOL_CALL",
            payload={"tool_call_id": "tool-1", "input_summary": "检索文献"},
            request_id=f"todo-agent-event-{uuid4()}",
        )

        student_items = _items(_payload(_get(env, "student", "?scope=to_me")))
        member_items = _items(_payload(_get(env, "member", "?scope=to_me")))
        assert str(session.session_id) in {
            item["object_id"] for item in student_items if item["source"] == "AGENT_APPROVAL"
        }
        assert str(session.session_id) not in {
            item["object_id"] for item in member_items if item["source"] == "AGENT_APPROVAL"
        }

        ResearchContextGrant.objects.filter(pk=grant.pk).update(scope_kind="REVIEW")
        review_items = _items(_payload(_get(env, "student", "?scope=to_me")))
        assert str(session.session_id) not in {
            item["object_id"] for item in review_items if item["source"] == "AGENT_APPROVAL"
        }

    def test_to_me_returns_actionable_items_from_server_capabilities(self, env):
        payload = _payload(_get(env, "advisor", "?scope=to_me"))
        sources = set(_by_source(_items(payload)))
        assert sources == {"CHAIN_TASK", "REPORT", "PAPER_REVIEW", "STAGE_REVIEW", "OFFICE_APPROVAL"}

        report = _by_source(_items(payload))["REPORT"]
        assert report["next_action"] == "READ"
        assert report["capabilities"]["actions"]["read"]["allowed"] is True
        assert report["capabilities"]["actions"]["review"]["allowed"] is True

        task = next(item for item in _items(payload) if item["object_id"] == str(env["submitted_task"].id))
        assert task["handling_status"] == "IN_PROGRESS"
        assert task["next_action"] == "REVIEW"
        assert task["capabilities"]["actions"]["return"]["allowed"] is True

    def test_mine_returns_items_started_by_the_current_user(self, env):
        payload = _payload(_get(env, "student", "?scope=mine"))
        sources = set(_by_source(_items(payload)))
        assert sources == {
            "CHAIN_TASK",
            "REPORT",
            "PAPER_REVIEW",
            "STAGE_REVIEW",
            "OFFICE_APPROVAL",
        }
        assert all(item["requester"]["id"] == str(env["student"].id) for item in _items(payload))

    def test_visible_applies_the_original_object_acl(self, env):
        payload = _payload(_get(env, "empty", "?scope=visible"))
        object_ids = {item["object_id"] for item in _items(payload)}
        assert str(env["assigned_task"].id) not in object_ids
        assert str(env["waiting_paper"].id) not in object_ids
        assert str(env["revision_report"].id) not in object_ids
        assert str(env["stage"].id) not in object_ids

    def test_guest_cannot_bypass_workspace_membership(self, env):
        client = APIClient()
        client.force_authenticate(user=env["guest"])
        response = client.get(f"/api/research/workspaces/{env['workspace'].slug}/research-todos/")
        assert response.status_code == 403

    def test_workspace_admin_has_research_review_rights_without_org_relation(self, env):
        payload = _payload(_get(env, "admin", "?scope=visible"))
        sources = _by_source(_items(payload))

        assert "CHAIN_TASK" in sources
        assert "PAPER_REVIEW" in sources

        submitted = next(item for item in _items(payload) if item["object_id"] == str(env["submitted_task"].id))
        waiting = next(item for item in _items(payload) if item["object_id"] == str(env["waiting_paper"].id))
        assert submitted["capabilities"]["actions"]["review"]["allowed"] is True
        assert waiting["capabilities"]["actions"]["review"]["allowed"] is True

    def test_expired_org_member_and_invalid_project_member_cannot_act(self, env):
        OrgUnitMember.objects.filter(user=env["group_member"]).update(
            effective_to=timezone.localdate() - timedelta(days=1)
        )
        ProjectMember.objects.create(
            project=env["project"],
            member=env["descendant"],
            role=15,
            is_active=False,
            deleted_at=timezone.now(),
        )
        descendant_client = _client(env["descendant"])

        expired_response = _get(env, "member", "?scope=to_me")
        invalid_project_member = _payload(
            descendant_client.get(f"/api/research/workspaces/{env['workspace'].slug}/research-todos/?scope=to_me")
        )

        assert expired_response.status_code == 403
        assert expired_response.json()["error_code"] == "research_permission_denied"
        assert "CHAIN_TASK" not in _by_source(_items(invalid_project_member))
        assert "PAPER_REVIEW" not in _by_source(_items(invalid_project_member))
        assert "OFFICE_APPROVAL" not in _by_source(_items(invalid_project_member))


@pytest.mark.django_db
class TestResearchTodoProjectionContract:
    def test_read_and_review_are_deduplicated_into_one_report_todo(self, env):
        response = _get(env, "advisor", "?scope=visible")
        payload = _payload(response)
        report_items = [
            item
            for item in _items(payload)
            if item["source"] == "REPORT" and item["object_id"] == str(env["report"].id)
        ]
        assert len(report_items) == 1
        report = report_items[0]
        assert report["schema_version"] == "research-todo.v2"
        assert report["id"] == f"REPORT:{env['report'].id}"
        assert report["business_status"] == "SUBMITTED"
        assert report["next_action"] == "READ"
        assert report["trace_ref"]["resource_type"] == "report"
        assert report["href"].endswith(f"/research/reports/{env['report'].id}")

        env["report"].read_receipts.create(
            reader=env["advisor"],
            snapshot_version=env["snapshot"].version_no,
        )
        after = _payload(_get(env, "advisor", "?scope=to_me"))
        after_report = next(
            item for item in _items(after) if item["source"] == "REPORT" and item["object_id"] == str(env["report"].id)
        )
        assert after_report["next_action"] == "REVIEW"

    def test_status_and_capability_mappings_cover_actionable_sources(self, env):
        payload = _payload(_get(env, "member", "?scope=visible"))
        items = {(item["object_id"], item["handling_status"], item["next_action"]) for item in _items(payload)}
        assert (str(env["assigned_task"].id), "TODO", "SUBMIT") in items
        assert (str(env["returned_task"].id), "RETURNED", "SUBMIT") in items

        assigned = next(item for item in _items(payload) if item["object_id"] == str(env["assigned_task"].id))
        assert assigned["capabilities"]["actions"]["submit"]["allowed"] is True
        assert assigned["capabilities"]["actions"]["return"]["allowed"] is False
        assert assigned["requester"]["id"] == str(env["student"].id)
        assert [user["id"] for user in assigned["assignees"]] == [str(env["group_member"].id)]

        student_payload = _payload(_get(env, "student", "?scope=to_me"))
        paper = next(item for item in _items(student_payload) if item["source"] == "PAPER_REVIEW")
        assert paper["business_status"] == "NEEDS_REVISION"
        assert paper["handling_status"] == "RETURNED"
        assert paper["next_action"] == "SUBMIT"
        assert paper["capabilities"]["actions"]["submit"]["allowed"] is True

    def test_stable_order_puts_overdue_before_future(self, env):
        payload = _payload(_get(env, "member", "?scope=visible"))
        ids = [item["id"] for item in _items(payload)]
        assert ids.index(f"CHAIN_TASK:{env['submitted_task'].id}") < ids.index(f"CHAIN_TASK:{env['assigned_task'].id}")
        assert len(ids) == len(set(ids))

    def test_urgency_is_projected_and_overdue_is_textually_unambiguous(self, env):
        payload = _payload(_get(env, "member", "?scope=visible"))
        items = {item["object_id"]: item for item in _items(payload)}

        assert items[str(env["submitted_task"].id)]["urgency"] == "OVERDUE"
        assert items[str(env["assigned_task"].id)]["urgency"] == "DUE_SOON"

    def test_cursor_continues_without_overlap(self, env):
        first = _payload(_get(env, "student", "?scope=visible&limit=2"))
        assert len(_items(first)) == 2
        assert first["next_cursor"]

        second = _payload(_get(env, "student", f"?scope=visible&limit=2&cursor={first['next_cursor']}"))
        all_ids = [item["id"] for item in _items(first)] + [item["id"] for item in _items(second)]
        assert len(all_ids) == len(set(all_ids))

    def test_empty_scope_has_an_explicit_empty_result(self, env):
        payload = _payload(_get(env, "empty", "?scope=to_me"))
        assert _items(payload) == []
        assert payload["next_cursor"] is None
        assert payload["degraded_sources"] == []

    def test_projection_endpoint_rejects_writes(self, env):
        response = env["student_client"].post(
            f"/api/research/workspaces/{env['workspace'].slug}/research-todos/",
            {"source": "REPORT"},
            format="json",
        )
        assert response.status_code == 405

    def test_response_contains_no_v1_contract_or_upload_source(self, env):
        response = _get(env, "student", "?scope=visible")
        rendered = response.content.decode()
        payload = _payload(response)

        assert '"target"' not in rendered
        assert '"kind"' not in rendered
        assert "research-todo-summary.v1" not in rendered
        assert "upload:uuid" not in rendered
        assert all(item["source"] != "upload" for item in _items(payload))

    @pytest.mark.parametrize(
        ("source", "collector_name"),
        [
            ("CHAIN_TASK", "collect_chain_task_todos"),
            ("REPORT", "collect_report_todos"),
            ("PAPER_REVIEW", "collect_paper_review_todos"),
            ("STAGE_REVIEW", "collect_stage_review_todos"),
            ("OFFICE_APPROVAL", "collect_office_approval_todos"),
        ],
    )
    def test_each_source_can_degrade_without_dropping_other_sources(
        self, env, monkeypatch, caplog, source, collector_name
    ):
        from plane.research.services import research_todos

        def broken(*_args, **_kwargs):
            raise RuntimeError(f"{source} upstream unavailable")

        monkeypatch.setattr(research_todos, collector_name, broken)
        with caplog.at_level("ERROR", logger="plane.api"):
            response = env["student_client"].get(
                f"/api/research/workspaces/{env['workspace'].slug}/research-todos/?scope=visible",
                HTTP_X_REQUEST_ID=f"todo-{source}",
            )

        payload = _payload(response)
        assert payload["schema_version"] == "research-todo.v2"
        assert payload["degraded_sources"] == [source]
        assert len(_items(payload)) > 0
        assert source not in _by_source(_items(payload))
        assert f"{source} upstream unavailable" not in response.content.decode()
        record = caplog.records[0]
        assert record.source == source
        assert record.workspace_id == str(env["workspace"].id)
        assert record.request_id == f"todo-{source}"
        assert record.exception_type == "RuntimeError"

    def test_aggregate_infrastructure_failure_returns_one_error_envelope(self, env, monkeypatch):
        from plane.research.views import research_todos as research_todo_view

        def broken(*_args, **_kwargs):
            raise RuntimeError("aggregate infrastructure failed")

        monkeypatch.setattr(research_todo_view, "collect_research_todos", broken)
        response = env["student_client"].get(
            f"/api/research/workspaces/{env['workspace'].slug}/research-todos/",
            HTTP_X_REQUEST_ID="todo-aggregate",
        )

        assert response.status_code == 500
        payload = response.json()
        assert set(payload) == {"error_code", "message"}
        assert payload["error_code"] == "UPSTREAM_DEGRADED"
        assert "aggregate infrastructure failed" not in response.content.decode()
