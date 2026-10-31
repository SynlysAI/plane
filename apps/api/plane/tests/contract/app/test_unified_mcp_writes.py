"""Administrative direct writes, native side effects and real network SDK recovery."""
# ruff: noqa: F811, F401

import asyncio
import json
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from types import SimpleNamespace
from unittest.mock import patch
from uuid import uuid4

import httpx
import pytest
from django.conf import settings as django_settings
from django.db import close_old_connections
from django.utils import timezone
from rest_framework.test import APIClient

from plane.db import models as db
from plane.tests.contract.app.test_unified_mcp import (
    MANAGEMENT,
    collect,
    env,
    invoke,
    issued,
    machine,
    payload,
    reference,
    rpc,
    unified,
)

pytestmark = [pytest.mark.contract, pytest.mark.django_db(transaction=True)]


@pytest.fixture
def writable(unified):
    e = unified
    for project in e["projects"]:
        for key, role in (("owner", 20), ("collaborator", 15)):
            db.ProjectMember.objects.create(workspace=e["workspace"], project=project, member=e[key], role=role)
    e["done"] = db.State.objects.create(
        workspace=e["workspace"], project=e["projects"][0], name="Done", group="completed"
    )
    value, client = issued(e, domains={"administrative": "read_write", "research": "read"})
    return {**e, "connection": value, "client": client}


@pytest.fixture
def native_effects(monkeypatch):
    """Execute real existing tasks; substitute only their Redis origin hint, never business logic."""
    from plane.bgtasks import issue_activities_task
    from plane.bgtasks.issue_description_version_task import issue_description_version_task
    from plane.bgtasks.notification_task import notifications
    from plane.bgtasks.webhook_task import model_activity

    # Run the unchanged native task bodies synchronously after actual DB commit.
    # This is an execution adapter, not a substitute for activities/notification rules.
    for task in (issue_activities_task.issue_activity, notifications, model_activity, issue_description_version_task):
        monkeypatch.setattr(task, "delay", task.run)
    hints = {}
    monkeypatch.setattr(
        issue_activities_task,
        "redis_instance",
        lambda: SimpleNamespace(set=lambda key, value, **kw: hints.update({key: value})),
    )
    yield hints


def create_args(e, request_id="new-task", **fields):
    return {
        "parent": reference(e, "Project", e["projects"][0]),
        "request_id": request_id,
        "name": "Unified synthetic task",
        **fields,
    }


def created(e, **fields):
    result = invoke(e["client"], "plane_create_task", create_args(e, **fields))
    assert result["status"] == "COMMITTED" and result["readback"] == "verified", result
    return db.Issue.objects.get(pk=result["object_id"]), result


def test_permanent_connection_writes_and_rechecks_current_membership(writable, native_effects):
    """永久行政连接可写入，但成员资格撤回后立即失去写权限。"""
    e = writable
    db.UnifiedMCPConnection.objects.filter(pk=e["connection"]["id"]).update(expires_at=None)
    task, _ = created(e)
    db.WorkspaceMember.objects.filter(workspace=e["workspace"], member=e["owner"]).update(is_active=False)
    invoke(
        e["client"],
        "plane_update_task",
        {
            "target": reference(e, "Issue", task),
            "changes": {"name": "不应写入"},
        },
        error="scope_denied",
    )
    task.refresh_from_db()
    assert task.name == "Unified synthetic task"


def test_native_create_edit_state_comment_effects_and_web_readback(writable, native_effects):
    e = writable
    task, result = created(
        e,
        description_html="<p>First body</p><script>alert(1)</script>",
        assignee_ids=[str(e["collaborator"].pk)],
        priority="high",
    )
    assert task.created_by_id == e["owner"].pk
    assert "<script" not in task.description_html
    assert task.description_stripped
    assert db.IssueActivity.objects.filter(issue=task).exists()
    assert db.Notification.objects.filter(entity_identifier=task.pk, receiver=e["collaborator"]).exists()
    assert db.EmailNotificationLog.objects.filter(entity_identifier=task.pk, receiver=e["collaborator"]).exists()
    ref = reference(e, "Issue", task)
    changes = {
        "name": "Edited synthetic task",
        "description_html": "<p>Updated body</p>",
        "priority": "urgent",
        "assignee_ids": [str(e["owner"].pk)],
        "start_date": "2026-10-28",
        "target_date": "2026-10-30",
    }
    edited = invoke(e["client"], "plane_update_task", {"target": ref, "changes": changes})
    assert edited["readback"] == "verified"
    transitioned = invoke(
        e["client"], "plane_transition_task", {"target": ref, "action": "set_state", "state_id": str(e["done"].pk)}
    )
    assert transitioned["readback"] == "verified"
    task.refresh_from_db()
    assert task.state_id == e["done"].pk and task.completed_at is not None
    comment = invoke(
        e["client"],
        "plane_add_comment",
        {"target": ref, "request_id": "comment-once", "comment_html": "<p>Visible comment</p>"},
    )
    assert comment["readback"] == "verified"
    assert db.IssueComment.objects.get(pk=comment["object_id"]).actor_id == e["owner"].pk
    assert db.IssueActivity.objects.filter(issue=task, field="comment").exists()
    root = f"/api/workspaces/{e['workspace'].slug}/projects/{task.project_id}/issues/{task.pk}/"
    detail = e["owner_client"].get(root)
    assert detail.status_code == 200, detail.data
    assert detail.data["name"] == changes["name"]
    assert "Updated body" in detail.data["description_html"]
    comments = e["owner_client"].get(root + "comments/")
    assert comments.status_code == 200 and "Visible comment" in comments.content.decode()
    activities = e["owner_client"].get(root + "history/", {"activity_type": "issue-property"})
    assert activities.status_code == 200 and "priority" in activities.content.decode()
    assert db.UnifiedMCPWriteResult.objects.count() == 2  # No receipts for ordinary edits/state changes.


def test_project_lifecycle_and_task_deletion_use_native_roles(writable):
    """项目生命周期与任务删除均要求动态写权限和精确确认。"""
    e = writable
    args = {
        "workspace_slug": e["workspace"].slug,
        "request_id": "create-project-once",
        "name": "MCP 行政项目",
        "identifier": "MCPADM",
    }
    created = invoke(e["client"], "plane_create_project", args)
    assert created["status"] == "COMMITTED" and created["readback"] == "verified", created
    project_id = created["target"]["id"]
    project = db.Project.objects.get(pk=project_id)
    assert project.name == "MCP 行政项目" and project.identifier == "MCPADM"
    assert db.State.objects.filter(project=project).count() >= 3
    assert invoke(e["client"], "plane_create_project", args)["object_id"] == project_id
    looked_up = invoke(
        e["client"],
        "plane_get_write_result",
        {"workspace_slug": e["workspace"].slug, "request_id": args["request_id"]},
    )
    assert looked_up["object_id"] == project_id and looked_up["issue_id"] is None

    updated = invoke(
        e["client"],
        "plane_update_project",
        {
            "workspace_slug": e["workspace"].slug,
            "project_id": project_id,
            "request_id": "update-project",
            "changes": {"name": "MCP 行政项目更新"},
        },
    )
    assert updated["readback"] == "verified"
    project.refresh_from_db()
    invoke(
        e["client"],
        "plane_archive_project",
        {"workspace_slug": e["workspace"].slug, "project_id": project_id, "request_id": "archive-project"},
    )
    project.refresh_from_db()
    assert project.archived_at is not None
    invoke(
        e["client"],
        "plane_restore_project",
        {"workspace_slug": e["workspace"].slug, "project_id": project_id, "request_id": "restore-project"},
    )
    project.refresh_from_db()
    assert project.archived_at is None

    issue = e["issues"][0]
    invoke(
        e["client"],
        "plane_delete_task",
        {
            "target": reference(e, "Issue", issue),
            "request_id": "delete-task",
            "confirm_name": "wrong-name",
        },
        error="invalid_arguments",
    )
    invoke(
        e["client"],
        "plane_delete_task",
        {"target": reference(e, "Issue", issue), "request_id": "delete-task", "confirm_name": issue.name},
    )
    assert not db.Issue.objects.filter(pk=issue.pk).exists()
    invoke(
        e["client"],
        "plane_delete_project",
        {
            "workspace_slug": e["workspace"].slug,
            "project_id": project_id,
            "request_id": "delete-project",
            "confirm_name": project.name,
        },
    )
    assert not db.Project.objects.filter(pk=project_id).exists()


@pytest.mark.parametrize("tool", ["plane_create_task", "plane_add_comment"])
def test_duplicate_replay_conflict_and_result_lookup(writable, native_effects, tool):
    e = writable
    args = (
        create_args(e)
        if tool == "plane_create_task"
        else {
            "target": reference(e, "Issue", e["issues"][0]),
            "request_id": "one-comment",
            "comment_html": "<p>Once</p>",
        }
    )
    first = invoke(e["client"], tool, args)
    counts = (
        db.Issue.objects.count(),
        db.IssueComment.objects.count(),
        db.IssueActivity.objects.count(),
        db.Notification.objects.count(),
    )
    replay = invoke(e["client"], tool, args)
    assert replay["object_id"] == first["object_id"]
    assert counts == (
        db.Issue.objects.count(),
        db.IssueComment.objects.count(),
        db.IssueActivity.objects.count(),
        db.Notification.objects.count(),
    )
    key = "name" if tool == "plane_create_task" else "comment_html"
    invoke(e["client"], tool, {**args, key: "different"}, error="idempotency_conflict")
    looked_up = invoke(
        e["client"], "plane_get_write_result", {"workspace_slug": e["workspace"].slug, "request_id": args["request_id"]}
    )
    assert looked_up["object_id"] == first["object_id"]
    _, other = issued(e, domains={"administrative": "read_write"})
    invoke(
        other,
        "plane_get_write_result",
        {"workspace_slug": e["workspace"].slug, "request_id": args["request_id"]},
        error="not_found",
    )


@pytest.mark.parametrize("tool", ["plane_create_task", "plane_add_comment"])
def test_concurrent_identical_requests_commit_once(writable, tool):
    e = writable
    args = (
        create_args(e)
        if tool == "plane_create_task"
        else {
            "target": reference(e, "Issue", e["issues"][0]),
            "request_id": "concurrent",
            "comment_html": "<p>Once</p>",
        }
    )

    def worker():
        close_old_connections()
        try:
            client = APIClient()
            client.credentials(
                HTTP_AUTHORIZATION="Bearer " + e["connection"]["secret"],
                HTTP_ACCEPT="application/json, text/event-stream",
            )
            return invoke(client, tool, args)
        finally:
            close_old_connections()

    with ThreadPoolExecutor(max_workers=2) as pool:
        values = list(pool.map(lambda _: worker(), range(2)))
    assert values[0]["object_id"] == values[1]["object_id"]
    assert db.UnifiedMCPWriteResult.objects.count() == 1


@pytest.mark.parametrize(
    "changes",
    [
        {"assignee_ids": [str(uuid4()), str(uuid4())]},
        {"assignee_ids": [str(uuid4())]},
        {"priority": "invalid"},
        {"start_date": "2026-10-31", "target_date": "2026-10-28"},
        {"start_date": "2026-02-30"},
        {"state_id": str(uuid4())},
        {"parent_id": str(uuid4())},
        {"name": " "},
        {"description_html": "x" * 30001},
    ],
)
def test_invalid_closed_fields_and_native_validation_roll_back(writable, changes):
    e = writable
    before = db.Issue.objects.count()
    invoke(e["client"], "plane_create_task", create_args(e, **changes), error="invalid_arguments")
    assert db.Issue.objects.count() == before and not db.UnifiedMCPWriteResult.objects.exists()


def test_partial_dates_clear_assignment_and_cross_project_state(writable):
    e = writable
    task, _ = created(e, start_date="2026-10-28", target_date="2026-10-30")
    ref = reference(e, "Issue", task)
    invoke(
        e["client"],
        "plane_update_task",
        {"target": ref, "changes": {"target_date": "2026-10-27"}},
        error="invalid_arguments",
    )
    invoke(
        e["client"],
        "plane_transition_task",
        {"target": ref, "action": "set_state", "state_id": str(e["issues"][1].state_id)},
        error="invalid_arguments",
    )
    invoke(
        e["client"],
        "plane_update_task",
        {"target": ref, "changes": {"start_date": None, "target_date": None, "assignee_ids": []}},
    )
    task.refresh_from_db()
    assert task.start_date is None and task.target_date is None and not task.assignees.exists()


def test_capabilities_paginate_assignable_people_and_native_states(writable):
    e = writable
    args = {"target": reference(e, "Issue", e["issues"][0]), "section": "capabilities", "limit": 1}
    people, states, actions, cursor = set(), set(), set(), None
    while True:
        result = invoke(e["client"], "plane_get_context", {**args, **({"cursor": cursor} if cursor else {})})
        data = result["data"]
        actions.update(data["allowed_actions"])
        people.update(person["id"] for person in data["assignable_users"])
        states.update(state["id"] for state in data["state_options"])
        cursor = result["page"]["next_cursor"]
        if not cursor:
            break
    assert people == {str(e[key].pk) for key in ("owner", "collaborator")}
    assert states == {str(e["issues"][0].state_id), str(e["done"].pk)}
    assert {"update_task", "set_state", "add_comment"} <= actions
    _, ro = issued(e)
    caps = invoke(ro, "plane_get_context", args)["data"]
    assert caps["allowed_actions"] == [] and caps["assignable_users"] == []


def test_readonly_scope_research_shell_wrong_workspace_and_role_loss(writable):
    e = writable
    _, ro = issued(e)
    invoke(ro, "plane_create_task", create_args(e), error="scope_denied")
    args = create_args(e)
    args["parent"] = reference(e, "Project", e["private_project"])
    invoke(e["client"], "plane_create_task", args, error="not_found")
    args["parent"] = reference(e, "ResearchChainNode", e["node"])
    invoke(e["client"], "plane_create_task", args, error="invalid_arguments")
    args["parent"] = {**reference(e, "Project", e["projects"][0]), "workspace_slug": "outside-connection"}
    invoke(e["client"], "plane_create_task", args, error="not_found")
    guest = {**e, "owner_client": e["collaborator_client"]}
    _, rw = issued(guest, domains={"administrative": "read_write"})
    db.ProjectMember.objects.filter(project=e["projects"][0], member=e["collaborator"]).update(role=5)
    invoke(rw, "plane_create_task", create_args(e), error="permission_denied")


def test_snapshot_rw_rejected_and_research_write_follows_deployment_policy(writable):
    e = writable
    for future, domains in ((False, {"administrative": "read_write"}), (True, {"research": "read_write"})):
        response = e["owner_client"].post(MANAGEMENT, payload(e, future=future, domains=domains), format="json")
        expected = (409, "capability_unavailable") if not future else (404, "disabled")
        assert (response.status_code, response.data["error_code"]) == expected
    assert (
        rpc(e["client"], "tools/call", {"name": "plane_prepare_proposal", "arguments": {}}).json()["error"]["code"]
        == -32602
    )


def test_nonempty_comment_rollback_and_no_postcommit_on_failure(writable):
    e = writable
    invoke(
        e["client"],
        "plane_add_comment",
        {"target": reference(e, "Issue", e["issues"][0]), "request_id": "empty", "comment_html": "<p></p>"},
        error="invalid_arguments",
    )
    with (
        patch(
            "plane.mcp.writing.UnifiedWriteService.receipt",
            side_effect=__import__("django.db", fromlist=["IntegrityError"]).IntegrityError,
        ),
        patch("plane.utils.issue_mutations.issue_activity.delay") as activity,
    ):
        invoke(e["client"], "plane_create_task", create_args(e), error="state_conflict")
        activity.assert_not_called()
    assert db.Issue.objects.count() == 2 and not db.UnifiedMCPWriteResult.objects.exists()


def test_committed_but_readback_failed_recovers_without_duplicate(writable):
    e = writable
    with patch(
        "plane.mcp.reading.UnifiedReadService.issue_data", side_effect=RuntimeError("synthetic readback outage")
    ):
        response = invoke(e["client"], "plane_create_task", create_args(e))
    assert response["status"] == "COMMITTED" and response["readback"] == "pending" and response["data"] is None
    task, recovered = created(e)
    assert db.Issue.objects.count() == 3 and recovered["readback"] == "verified"
    db.Issue.objects.filter(pk=task.pk).update(name="Later native edit")
    result = invoke(
        e["client"], "plane_get_write_result", {"workspace_slug": e["workspace"].slug, "request_id": "new-task"}
    )
    assert result["readback"] == "changed" and result["commit"]["name"] != "Later native edit"


def test_broker_publish_failure_does_not_report_committed_write_as_failure(writable):
    e = writable
    with (
        patch("plane.utils.issue_mutations.issue_activity.delay", side_effect=RuntimeError("synthetic broker outage")),
        patch("plane.utils.issue_mutations.model_activity.delay") as webhook,
    ):
        created(e)
        webhook.assert_called_once()
    assert db.Issue.objects.count() == 3 and db.UnifiedMCPWriteResult.objects.count() == 1


def test_result_and_replay_recheck_current_scope_and_revocation(writable):
    e = writable
    _, first = created(e)
    guest = {**e, "owner_client": e["collaborator_client"]}
    value, client = issued(guest, domains={"administrative": "read_write"})
    invoke(client, "plane_create_task", create_args(e))
    db.ProjectMember.objects.filter(project=e["projects"][0], member=e["collaborator"]).update(is_active=False)
    invoke(
        client,
        "plane_get_write_result",
        {"workspace_slug": e["workspace"].slug, "request_id": "new-task"},
        error="not_found",
    )
    db.UnifiedMCPConnection.objects.filter(pk=e["connection"]["id"]).update(revoked_at=timezone.now())
    assert rpc(e["client"], "tools/call", {"name": "plane_create_task", "arguments": create_args(e)}).status_code == 401


def test_native_web_create_edit_and_comment_use_shared_saves(writable, native_effects):
    e = writable
    root = f"/api/workspaces/{e['workspace'].slug}/projects/{e['projects'][0].pk}/issues/"
    response = e["owner_client"].post(
        root, {"name": "Native Web task", "assignee_ids": [str(e["collaborator"].pk)]}, format="json"
    )
    assert response.status_code == 201, response.data
    task = db.Issue.objects.get(pk=response.data["id"])
    assert db.IssueActivity.objects.filter(issue=task).exists()
    response = e["owner_client"].patch(root + str(task.pk) + "/", {"priority": "high"}, format="json")
    assert response.status_code == 204, response.data
    response = e["owner_client"].post(
        root + str(task.pk) + "/comments/", {"comment_html": "<p>Web comment</p>", "attachment_ids": []}, format="json"
    )
    assert response.status_code == 201, response.data
    assert db.IssueActivity.objects.filter(issue=task, field="comment").exists()


def test_native_default_assignee_and_subtask_parent_are_preserved(writable):
    e = writable
    db.Project.objects.filter(pk=e["projects"][0].pk).update(default_assignee=e["collaborator"])
    task, _ = created(e, parent=reference(e, "Issue", e["issues"][0]))
    assert task.parent_id == e["issues"][0].pk
    assert list(task.assignees.values_list("pk", flat=True)) == [e["collaborator"].pk]
    result = invoke(e["client"], "plane_create_task", create_args(e, request_id="explicit-empty", assignee_ids=[]))
    assert not db.Issue.objects.get(pk=result["object_id"]).assignees.exists()


def test_repeated_absolute_state_edit_emits_no_duplicate_activity(writable, native_effects):
    e = writable
    task, _ = created(e)
    args = {"target": reference(e, "Issue", task), "action": "set_state", "state_id": str(e["done"].pk)}
    invoke(e["client"], "plane_transition_task", args)
    before = db.IssueActivity.objects.filter(issue=task).count()
    invoke(e["client"], "plane_transition_task", args)
    assert db.IssueActivity.objects.filter(issue=task).count() == before
    assert db.UnifiedMCPWriteResult.objects.count() == 1


def test_native_domain_admission_precedes_creator_and_guest_exceptions(writable):
    e = writable
    _, client = issued({**e, "owner_client": e["collaborator_client"]}, domains={"administrative": "read_write"})
    result = invoke(client, "plane_create_task", create_args(e))
    ref = {**reference(e, "Issue", e["issues"][0]), "id": result["object_id"]}
    db.ProjectMember.objects.filter(project=e["projects"][0], member=e["collaborator"]).update(role=5)
    invoke(
        client,
        "plane_update_task",
        {"target": ref, "changes": {"name": "Creator cannot bypass admission"}},
        error="permission_denied",
    )
    invoke(
        client,
        "plane_update_task",
        {"target": reference(e, "Issue", e["issues"][0]), "changes": {"name": "Guest cannot edit others"}},
        error="not_found",
    )
    invoke(
        client,
        "plane_add_comment",
        {"target": ref, "request_id": "guest-own", "comment_html": "<p>Own comment</p>"},
        error="permission_denied",
    )
    root = f"/api/workspaces/{e['workspace'].slug}/projects/{e['projects'][0].pk}/issues/{ref['id']}/"
    assert e["collaborator_client"].patch(root, {"name": "Web also denies"}, format="json").status_code == 403
    assert (
        e["collaborator_client"]
        .post(root + "comments/", {"comment_html": "<p>Web also denies</p>"}, format="json")
        .status_code
        == 403
    )
    caps = invoke(client, "plane_get_context", {"target": ref, "section": "capabilities"})
    assert caps["data"]["allowed_actions"] == []


def test_revoked_after_commit_returns_no_hidden_content_or_retry_signal(writable):
    from plane.mcp.writing import UnifiedWriteService

    e = writable
    present = UnifiedWriteService.present

    def revoke_then_read(service, receipt, strict=False):
        db.UnifiedMCPConnection.objects.filter(pk=service.connection.pk).update(revoked_at=timezone.now())
        return present(service, receipt, strict=strict)

    with patch.object(UnifiedWriteService, "present", revoke_then_read):
        result = invoke(e["client"], "plane_create_task", create_args(e))
    assert result["status"] == "COMMITTED" and result["readback"] == "pending"
    assert result["data"] is None and "commit" not in result and "object_id" not in result
    assert db.UnifiedMCPWriteResult.objects.count() == 1 and db.Issue.objects.count() == 3


def test_real_sdk_administrative_write_flow_one_configuration(writable, native_effects, live_server, record_property):
    from mcp import ClientSession
    from mcp.client.streamable_http import streamable_http_client

    e = writable
    # Management returns a real single-server config pointing to this TCP server.
    login = APIClient()
    login.force_login(e["owner"])
    with httpx.Client(
        base_url=live_server.url,
        cookies={django_settings.SESSION_COOKIE_NAME: login.cookies[django_settings.SESSION_COOKIE_NAME].value},
        trust_env=False,
    ) as human:
        csrf = human.get(MANAGEMENT).json()["csrf_token"]
        response = human.post(
            MANAGEMENT,
            json=payload(e, domains={"administrative": "read_write", "research": "read"}),
            headers={"X-CSRFToken": csrf},
        )
        assert response.status_code == 201
        servers = json.loads(response.json()["sciencediscovery_json"])["mcpServers"]
        assert len(servers) == 1
        assert next(iter(servers)) == "Synthetic unified connection"
        server = next(iter(servers.values()))

        async def scenario():
            async with httpx.AsyncClient(headers=server["headers"], trust_env=False) as http:
                async with streamable_http_client(server["url"], http_client=http) as streams:
                    async with ClientSession(
                        streams[0], streams[1], read_timeout_seconds=timedelta(seconds=30)
                    ) as session:
                        await session.initialize()
                        names, cursor = [], None
                        while True:
                            page = await session.list_tools(cursor=cursor)
                            names.extend(tool.name for tool in page.tools)
                            cursor = page.nextCursor
                            if not cursor:
                                break
                        assert len(names) == 17

                        async def call(name, args):
                            result = await session.call_tool(name, args)
                            assert not result.isError, result
                            return result.structuredContent

                        containers = await call("plane_list_containers", {"workspace_slug": e["workspace"].slug})
                        assert len([row for row in containers["data"] if row["domain"] == "administrative"]) == 2
                        nodes = await call("plane_list_nodes", {"container": reference(e, "ResearchChain", e["chain"])})
                        assert len(nodes["data"]) == 2
                        result = await call(
                            "plane_create_task",
                            create_args(e, request_id="sdk-create", description_html="<p>SDK body</p>"),
                        )
                        task_ref = {**reference(e, "Issue", e["issues"][0]), "id": result["object_id"]}
                        await call(
                            "plane_update_task",
                            {
                                "target": task_ref,
                                "changes": {
                                    "assignee_ids": [str(e["collaborator"].pk)],
                                    "start_date": "2026-10-28",
                                    "target_date": "2026-11-02",
                                },
                            },
                        )
                        await call(
                            "plane_transition_task",
                            {"target": task_ref, "action": "set_state", "state_id": str(e["done"].pk)},
                        )
                        await call(
                            "plane_add_comment",
                            {"target": task_ref, "request_id": "sdk-comment", "comment_html": "<p>SDK comment</p>"},
                        )
                        comments = await call("plane_get_context", {"target": task_ref, "section": "comments"})
                        assert "SDK comment" in json.dumps(comments)
                        recovered = await call(
                            "plane_get_write_result",
                            {"workspace_slug": e["workspace"].slug, "request_id": "sdk-create"},
                        )
                        assert recovered["object_id"] == result["object_id"] and recovered["readback"] == "changed"
                        return result["object_id"]

        task_id = asyncio.run(scenario())
        root = f"/api/workspaces/{e['workspace'].slug}/projects/{e['projects'][0].pk}/issues/{task_id}/"
        assert human.get(root).json()["state_id"] == str(e["done"].pk)
        assert "SDK comment" in human.get(root + "comments/").text
        assert "state" in human.get(root + "history/", params={"activity_type": "issue-property"}).text
        record_property(
            "administrative_write_sdk_proof",
            json.dumps(
                {
                    "transport": "real TCP",
                    "sdk": "mcp 1.28.1",
                    "servers": 1,
                    "tools": 11,
                    "administrative_projects": 2,
                    "research_nodes": 2,
                    "native_web_readback": True,
                }
            ),
        )
