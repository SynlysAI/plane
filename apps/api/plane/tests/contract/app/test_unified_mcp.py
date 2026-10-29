"""Unified reads over isolated ORM data and a real TCP MCP SDK client."""
# ruff: noqa: F811

import asyncio
import json
from datetime import timedelta
from uuid import uuid4

import httpx
import pytest
from django.conf import settings as django_settings
from django.urls import resolve
from django.utils import timezone
from rest_framework.test import APIClient

from plane.db import models as db
from plane.tests.contract.app.test_research_chain_mvp import env  # noqa: F401
from plane.tests.contract.app.test_research_machine_access import machine, scoped_client  # noqa: F401
from plane.tests.research_fixtures import make_workspace

pytestmark = pytest.mark.contract
MANAGEMENT = "/api/mcp/connections/"


@pytest.fixture
def unified(machine):
    e = machine
    e["projects"], e["issues"] = [], []
    for index in range(2):
        project = db.Project.objects.create(workspace=e["workspace"], name="行政同名项目", identifier=f"ADM{index}")
        state = db.State.objects.create(workspace=e["workspace"], project=project, name="Todo", group="unstarted")
        issue = db.Issue.objects.create(
            workspace=e["workspace"],
            project=project,
            state=state,
            name=f"Administrative task {index}",
            description_html="<p>administrative body</p>",
        )
        e["projects"].append(project)
        e["issues"].append(issue)
    e["tasks"] = []
    for node in (e["node"], e["other"]):
        task = db.ResearchChainNodeTask.objects.create(
            workspace=e["workspace"],
            chain=e["chain"],
            node=node,
            title="Research task",
            instruction="<p>research body</p>",
            request_id=uuid4().hex,
            payload_hash="a" * 64,
        )
        e["tasks"].append(task)
    return e


def payload(e, future=True, domains=None):
    return {
        "name": "Synthetic unified connection",
        "workspaces": [
            {
                "workspace_id": str(e["workspace"].pk),
                "domains": domains or {"administrative": "read", "research": "read"},
            }
        ],
        "include_future_objects": future,
    }


def issued(e, **kwargs):
    response = e["owner_client"].post(MANAGEMENT, payload(e, **kwargs), format="json")
    assert response.status_code == 201, response.data
    result = response.json()
    client = APIClient()
    client.credentials(
        HTTP_AUTHORIZATION="Bearer " + result["secret"], HTTP_ACCEPT="application/json, text/event-stream"
    )
    return result, client


def reference(e, kind, obj, domain=None):
    return {
        "domain": domain or ("administrative" if kind in ("Project", "Issue") else "research"),
        "object_type": kind,
        "workspace_slug": e["workspace"].slug,
        "id": str(obj.pk),
    }


def rpc(client, method, params=None, identity=1):
    return client.post(
        "/api/mcp/", {"jsonrpc": "2.0", "id": identity, "method": method, "params": params or {}}, format="json"
    )


def invoke(client, name, arguments, error=None):
    response = rpc(client, "tools/call", {"name": name, "arguments": arguments})
    assert response.status_code == 200, response.data
    result = response.json()["result"]
    assert result["isError"] is bool(error), result
    assert json.loads(result["content"][0]["text"]) == result["structuredContent"]
    value = result["structuredContent"]
    if error:
        assert value["error_code"] == error
    return value


def collect(client, name, arguments):
    results, cursors = [], set()
    while True:
        value = invoke(client, name, arguments)
        results.extend(value["data"])
        page = value.get("page", {})
        if not page.get("has_more"):
            return results
        cursor = page["next_cursor"]
        assert cursor not in cursors
        cursors.add(cursor)
        arguments = {**arguments, "cursor": cursor}


def test_single_connection_discovers_two_projects_two_nodes_and_reads_native_bodies(unified):
    e = unified
    value, client = issued(e)
    assert len(json.loads(value["sciencediscovery_json"])["mcpServers"]) == 1
    assert value["codex_toml"].count("[mcp_servers.") == 1
    record = db.UnifiedMCPConnection.objects.get(pk=value["id"])
    assert value["secret"] != record.token_hash and len(record.token_hash) == 64
    containers = collect(client, "plane_list_containers", {"workspace_slug": e["workspace"].slug, "limit": 1})
    assert {x["id"] for x in containers if x["domain"] == "administrative"} == {str(x.pk) for x in e["projects"]}
    nodes = collect(client, "plane_list_nodes", {"container": reference(e, "ResearchChain", e["chain"]), "limit": 1})
    assert {x["id"] for x in nodes} == {str(e["node"].pk), str(e["other"].pk)}
    for project, issue in zip(e["projects"], e["issues"]):
        tasks = collect(client, "plane_list_tasks", {"parent": reference(e, "Project", project)})
        assert [x["id"] for x in tasks] == [str(issue.pk)]
        body = invoke(
            client,
            "plane_read_resource",
            {"parent": reference(e, "Issue", issue), "kind": "issue_description", "resource_id": str(issue.pk)},
        )
        assert "administrative body" in body["data"]["text"]
    for node, task in zip((e["node"], e["other"]), e["tasks"]):
        tasks = collect(client, "plane_list_tasks", {"parent": reference(e, "ResearchChainNode", node)})
        assert [x["id"] for x in tasks] == [str(task.pk)]
        body = invoke(
            client,
            "plane_read_resource",
            {"parent": reference(e, "ResearchChainNode", node), "kind": "task", "resource_id": str(task.pk)},
        )
        assert "research body" in body["data"]["text"]
    assert db.UnifiedMCPConnection.objects.get(pk=value["id"]).last_used_at is not None
    assert db.ResearchContextGrant.objects.count() == 0  # No hidden per-node credentials.


def test_dynamic_and_snapshot_scope_future_objects_and_later_links(unified):
    e = unified
    old_external = db.ResearchExternalReference.objects.create(
        workspace=e["workspace"],
        system="RAGPORTAL",
        external_type="URL",
        external_id=uuid4().hex,
        title="Old unlinked reference",
        acl_hint={"public": True},
    )
    _, dynamic = issued(e)
    _, snapshot = issued(e, future=False)
    project = db.Project.objects.create(workspace=e["workspace"], name="Future administrative", identifier="FUTURE")
    node = db.ResearchChainNode.objects.create(
        chain=e["chain"], node_type="ANALYSIS", title="Future node", request_id=uuid4().hex, payload_hash="a" * 64
    )
    task = db.ResearchChainNodeTask.objects.create(
        workspace=e["workspace"],
        chain=e["chain"],
        node=e["node"],
        title="Future task",
        request_id=uuid4().hex,
        payload_hash="a" * 64,
    )
    db.ResearchChainEvent.objects.create(
        chain=e["chain"],
        node=e["node"],
        event_id=uuid4().hex,
        request_id=uuid4().hex,
        occurred_at=timezone.now(),
        event_type="OUTPUT",
        refs=[{"kind": "external_reference", "id": str(old_external.pk)}],
    )
    for client, expected in ((dynamic, True), (snapshot, False)):
        containers = collect(client, "plane_list_containers", {"workspace_slug": e["workspace"].slug})
        assert (str(project.pk) in {x["id"] for x in containers}) is expected
        nodes = collect(client, "plane_list_nodes", {"container": reference(e, "ResearchChain", e["chain"])})
        assert (str(node.pk) in {x["id"] for x in nodes}) is expected
        tasks = collect(client, "plane_list_tasks", {"parent": reference(e, "ResearchChainNode", e["node"])})
        assert (str(task.pk) in {x["id"] for x in tasks}) is expected
        resources = collect(
            client,
            "plane_get_context",
            {
                "target": reference(e, "ResearchChainNode", e["node"]),
                "section": "resources",
                "resource_kind": "external_reference",
            },
        )
        assert (str(old_external.pk) in {x["id"] for x in resources}) is expected


@pytest.mark.parametrize("change", ["revoke", "expire", "owner", "member", "org", "feature"])
def test_every_call_rechecks_identity_membership_revoke_and_policy(unified, settings, change):
    e = unified
    value, client = issued(e)
    args = {"target": reference(e, "ResearchChainNode", e["node"]), "section": "details"}
    invoke(client, "plane_get_context", args)
    if change == "revoke":
        db.UnifiedMCPConnection.objects.filter(pk=value["id"]).update(revoked_at=timezone.now())
    elif change == "expire":
        db.UnifiedMCPConnection.objects.filter(pk=value["id"]).update(expires_at=timezone.now() - timedelta(seconds=1))
    elif change == "owner":
        db.User.objects.filter(pk=e["owner"].pk).update(is_active=False)
    elif change == "member":
        db.WorkspaceMember.objects.filter(workspace=e["workspace"], member=e["owner"]).update(is_active=False)
    elif change == "org":
        # Administrators legitimately bypass the research org gate. Exercise
        # the gate as an ordinary, still seated chain owner instead.
        db.WorkspaceMember.objects.filter(workspace=e["workspace"], member=e["owner"]).update(role=15)
        db.OrgUnitMember.objects.filter(workspace=e["workspace"], user=e["owner"]).update(deleted_at=timezone.now())
    else:
        settings.RESEARCH_MCP_ENABLED = False
    if change in ("revoke", "expire", "owner"):
        assert rpc(client, "ping").status_code == 401
    else:
        invoke(client, "plane_get_context", args, error="scope_denied")


def test_scope_domain_wrong_type_workspace_and_soft_deleted_research_shell(unified):
    e = unified
    _, client = issued(e, domains={"administrative": "read"})
    invoke(
        client,
        "plane_get_context",
        {"target": reference(e, "ResearchChainNode", e["node"]), "section": "details"},
        error="scope_denied",
    )
    _, all_client = issued(e)
    foreign = make_workspace(e["owner"])
    invoke(all_client, "plane_list_containers", {"workspace_slug": foreign.slug}, error="not_found")
    for soft_delete in (False, True):
        if soft_delete:
            db.ResearchChain.all_objects.filter(pk=e["chain"].pk).update(deleted_at=timezone.now())
            db.ResearchProjectProfile.all_objects.filter(pk=e["private_profile"].pk).update(deleted_at=timezone.now())
        candidates = collect(
            all_client, "plane_list_containers", {"workspace_slug": e["workspace"].slug, "domain": "administrative"}
        )
        assert str(e["private_project"].pk) not in {x["id"] for x in candidates}
        invoke(
            all_client,
            "plane_get_context",
            {"target": reference(e, "Project", e["private_project"]), "section": "details"},
            error="not_found",
        )
    invoke(
        all_client,
        "plane_get_context",
        {"target": reference(e, "Issue", e["node"]), "section": "details"},
        error="not_found",
    )


def test_bound_pagination_and_content_revision(unified):
    e = unified
    _, first = issued(e)
    _, other = issued(e)
    args = {"workspace_slug": e["workspace"].slug, "limit": 1}
    cursor = invoke(first, "plane_list_containers", args)["page"]["next_cursor"]
    invoke(other, "plane_list_containers", {**args, "cursor": cursor}, error="invalid_cursor")
    invoke(first, "plane_list_containers", {**args, "cursor": cursor, "query": "changed"}, error="invalid_cursor")
    issue = e["issues"][0]
    db.Issue.objects.filter(pk=issue.pk).update(description_html="<p>" + "long content " * 200 + "</p>")
    args = {
        "parent": reference(e, "Issue", issue),
        "resource_id": str(issue.pk),
        "kind": "issue_description",
        "max_chars": 256,
    }
    result = invoke(first, "plane_read_resource", args)
    assert result["truncated"]
    db.Issue.objects.filter(pk=issue.pk).update(description_html="changed body")
    invoke(first, "plane_read_resource", {**args, "cursor": result["page"]["next_cursor"]}, error="version_changed")


def test_known_links_ancestry_and_no_arbitrary_url(unified, settings):
    e = unified
    _, client = issued(e)
    issue = e["issues"][0]
    ref = reference(e, "Issue", issue)
    ref.pop("id")
    ref["url"] = f"{settings.WEB_URL}/{e['workspace'].slug}/projects/{issue.project_id}/issues/{issue.pk}"
    assert invoke(client, "plane_get_context", {"target": ref, "section": "details"})["data"]["id"] == str(issue.pk)
    for url in (
        "http://evil.invalid/private",
        ref["url"] + "?node=unexpected",
        ref["url"].replace(str(issue.project_id), str(e["projects"][1].pk)),
    ):
        invoke(
            client,
            "plane_get_context",
            {"target": {**ref, "url": url}, "section": "details"},
            error="not_found" if str(e["projects"][1].pk) in url else "invalid_reference",
        )


def test_admin_has_no_fake_nodes_and_no_business_writes(unified):
    e = unified
    _, client = issued(e)
    result = invoke(client, "plane_list_nodes", {"container": reference(e, "Project", e["projects"][0])})
    assert result["applicability"] == "not_applicable" and result["next_tool"]["name"] == "plane_list_tasks"
    before = db.Issue.objects.count()
    invoke(client, "plane_create_task", {"parent": reference(e, "Project", e["projects"][0]),
           "request_id": "readonly-create", "name": "must not be written"}, error="scope_denied")
    assert db.Issue.objects.count() == before
    response = e["owner_client"].post(MANAGEMENT, payload(e, domains={"research": "read_write"}), format="json")
    assert response.status_code == 404 and response.data["error_code"] == "disabled"


def test_snapshot_does_not_acquire_preexisting_projects_after_new_membership(unified):
    e = {**unified, "owner_client": unified["collaborator_client"]}
    _, dynamic = issued(e, domains={"administrative": "read"})
    _, snapshot = issued(e, future=False, domains={"administrative": "read"})
    project = e["projects"][0]
    db.ProjectMember.objects.create(workspace=e["workspace"], project=project, member=e["collaborator"], role=15)
    for client, expected in ((dynamic, True), (snapshot, False)):
        rows = collect(client, "plane_list_containers", {"workspace_slug": e["workspace"].slug})
        assert (str(project.pk) in {row["id"] for row in rows}) is expected


def test_native_guest_only_sees_own_tasks_and_cannot_read_hidden_parent(unified):
    e = unified
    project, own = e["projects"][0], e["issues"][0]
    db.Project.objects.filter(pk=project.pk).update(guest_view_all_features=False)
    db.ProjectMember.objects.create(workspace=e["workspace"], project=project, member=e["collaborator"], role=5)
    hidden = db.Issue.objects.create(
        workspace=e["workspace"], project=project, state=own.state, name="Hidden guest task"
    )
    db.Issue.objects.filter(pk=own.pk).update(created_by=e["collaborator"], parent=hidden)
    _, client = issued({**e, "owner_client": e["collaborator_client"]}, domains={"administrative": "read"})
    tasks = collect(client, "plane_list_tasks", {"parent": reference(e, "Project", project)})
    assert [task["id"] for task in tasks] == [str(own.pk)]
    assert tasks[0]["parent_outside_scope"] and tasks[0]["parent"]["object_type"] == "Project"
    invoke(
        client, "plane_get_context", {"target": reference(e, "Issue", hidden), "section": "details"}, error="not_found"
    )


def test_comments_events_snapshots_and_subtasks_keep_real_ancestry(unified):
    e = unified
    issue = e["issues"][0]
    child = db.Issue.objects.create(
        workspace=e["workspace"], project=issue.project, state=issue.state, name="Child", parent=issue
    )
    comment = db.IssueComment.objects.create(
        workspace=e["workspace"],
        project=issue.project,
        issue=issue,
        actor=e["owner"],
        comment_html="<p>Native discussion</p>",
    )
    db.IssueActivity.objects.create(
        workspace=e["workspace"],
        project=issue.project,
        issue=issue,
        actor=e["owner"],
        verb="updated",
        comment="Native activity",
    )
    task = e["tasks"][0]
    research_comment = db.ResearchTaskComment.objects.create(
        task=task,
        actor=e["owner"],
        comment_html="<p>Research discussion</p>",
        comment_stripped="Research discussion",
        request_id=uuid4().hex,
    )
    event = db.ResearchChainEvent.objects.create(
        chain=e["chain"],
        node=e["node"],
        event_id=uuid4().hex,
        request_id=uuid4().hex,
        occurred_at=timezone.now(),
        event_type="OUTPUT",
        summary="Visible event",
        refs=[{"kind": "task", "id": str(task.pk)}],
    )
    snapshot = db.ResearchChainSnapshot.objects.create(
        chain=e["chain"],
        node=e["node"],
        version=1,
        summary="Snapshot summary",
        source_versions=[],
        resources=[],
        event_range={},
        request_id=uuid4().hex,
        content_hash="b" * 64,
    )
    _, client = issued(e)
    children = collect(client, "plane_list_tasks", {"parent": reference(e, "Issue", issue)})
    assert [row["id"] for row in children] == [str(child.pk)]
    comments = collect(client, "plane_get_context", {"target": reference(e, "Issue", issue), "section": "comments"})
    assert comments[0]["id"] == str(comment.pk) and "Native discussion" in comments[0]["text"]
    events = collect(client, "plane_get_context", {"target": reference(e, "Issue", issue), "section": "events"})
    assert events[0]["comment"] == "Native activity"
    comments = collect(
        client, "plane_get_context", {"target": reference(e, "ResearchChainNodeTask", task), "section": "comments"}
    )
    assert comments[0]["id"] == str(research_comment.pk)
    events = collect(
        client, "plane_get_context", {"target": reference(e, "ResearchChainNodeTask", task), "section": "events"}
    )
    assert events[0]["id"] == str(event.pk) and events[0]["summary"] == "Visible event"
    snapshots = collect(
        client, "plane_get_context", {"target": reference(e, "ResearchChainNode", e["node"]), "section": "snapshots"}
    )
    assert snapshots[0]["id"] == str(snapshot.snapshot_id) and snapshots[0]["summary"] == "Snapshot summary"
    invoke(
        client,
        "plane_read_resource",
        {"parent": reference(e, "Issue", e["issues"][1]), "kind": "issue_comment", "resource_id": str(comment.pk)},
        error="not_found",
    )


def test_extended_resources_reuse_native_acl_and_public_event_projection(unified):
    from plane.tests.contract.app.test_research_mcp_extended import CANARY, build_extended

    e = build_extended(unified)
    _, client = issued(e)
    for kind, resource in e["targets"].items():
        rows = collect(
            client,
            "plane_get_context",
            {
                "target": reference(e, "ResearchChainNode", e["node"]),
                "section": "resources",
                "resource_kind": kind,
                "limit": 1,
            },
        )
        assert len(rows) == 1 and rows[0]["id"] == str(resource.pk)
        assert CANARY not in json.dumps(rows)
        result = invoke(
            client,
            "plane_read_resource",
            {"parent": reference(e, "ResearchChainNode", e["node"]), "kind": kind, "resource_id": str(resource.pk)},
            error=None if kind == "agent_event" else "unsupported_content",
        )
        assert CANARY not in json.dumps(result)
    reference_record = e["targets"]["external_reference"]
    reference_record.status = "REVOKED"
    reference_record.save(update_fields=["status"])
    invoke(
        client,
        "plane_read_resource",
        {
            "parent": reference(e, "ResearchChainNode", e["node"]),
            "kind": "external_reference",
            "resource_id": str(reference_record.pk),
        },
        error="not_found",
    )


def test_snapshot_limit_rolls_back_issuance_without_partial_connection(unified, monkeypatch):
    monkeypatch.setattr("plane.mcp.authorization.SNAPSHOT_LIMIT", 1)
    before = db.UnifiedMCPConnection.objects.count()
    response = unified["owner_client"].post(MANAGEMENT, payload(unified, future=False), format="json")
    assert response.status_code == 413 and response.data["error_code"] == "scope_too_large"
    assert db.UnifiedMCPConnection.objects.count() == before


def test_formal_report_versions_obey_snapshot_scope_without_weekly_write_upgrade(unified):
    from plane.tests.contract.app.test_research_mcp_extended import link

    e = unified
    page = db.Page.objects.create(workspace=e["workspace"], name="Formal report", owned_by=e["owner"])
    report = db.PeriodicReport.objects.create(
        workspace=e["workspace"],
        project=e["private_project"],
        owner=e["owner"],
        org_unit=e["group"],
        page=page,
        report_type="WEEKLY",
        period_key="2026-W42",
        period_start="2026-10-12",
        period_end="2026-10-18",
        status="SUBMITTED",
        submitted_at=timezone.now(),
    )
    db.PeriodicReportSnapshot.objects.create(
        report=report,
        version_no=1,
        snapshot_status="SUBMITTED",
        description_html="<p>Formal v1</p>",
        description_stripped="Formal v1",
    )
    link(e, "report", report)
    _, dynamic = issued(e)
    value, snapshot = issued(e, future=False)
    args = {"parent": reference(e, "ResearchChainNode", e["node"]), "kind": "report", "resource_id": str(report.pk)}
    assert "Formal v1" in invoke(snapshot, "plane_read_resource", {**args, "version": 1})["data"]["text"]
    db.PeriodicReportSnapshot.objects.create(
        report=report,
        version_no=2,
        snapshot_status="SUBMITTED",
        description_html="<p>Formal v2</p>",
        description_stripped="Formal v2",
    )
    args = {"parent": reference(e, "ResearchChainNode", e["node"]), "kind": "report", "resource_id": str(report.pk)}
    invoke(dynamic, "plane_read_resource", args, error="version_required")
    invoke(snapshot, "plane_read_resource", {**args, "version": 1}, error="report_context_version_changed")
    assert "Formal v2" in invoke(dynamic, "plane_read_resource", {**args, "version": 2})["data"]["text"]
    invoke(snapshot, "plane_read_resource", {**args, "version": 2}, error="scope_denied")
    for client, version in ((dynamic, 2), (snapshot, 1)):
        resources = collect(
            client,
            "plane_get_context",
            {"target": reference(e, "ResearchChainNode", e["node"]), "section": "resources", "resource_kind": "report"},
        )
        assert resources[0]["version"] == version
        if client is snapshot:
            assert not resources[0]["content_available"] and resources[0]["content_state"] == "version_changed"
    assert (
        rpc(dynamic, "tools/call", {"name": "prepare_weekly_report_operation", "arguments": {}}).json()["error"]["code"]
        == -32602
    )
    assert db.ReportAgentGrant.objects.count() == 0
    weekly = APIClient()
    weekly.credentials(HTTP_X_WEEKLY_REPORT_TOKEN=value["secret"])
    denied = weekly.post(
        f"/api/research/workspaces/{e['workspace'].slug}/weekly-report-agent/mcp/",
        {"jsonrpc": "2.0", "id": 1, "method": "initialize"},
        format="json",
    )
    assert denied.status_code in (401, 403)


def test_management_ownership_one_time_secret_and_real_csrf(unified):
    e = unified
    session = APIClient(enforce_csrf_checks=True)
    session.force_login(e["owner"])
    listing = session.get(MANAGEMENT)
    csrf = listing.json()["csrf_token"]
    assert session.post(MANAGEMENT, payload(e), format="json").status_code == 403
    response = session.post(MANAGEMENT, payload(e), format="json", HTTP_X_CSRFTOKEN=csrf)
    assert response.status_code == 201
    value = response.json()
    assert value["secret"] not in json.dumps(session.get(MANAGEMENT).json())
    assert "token_hash" not in json.dumps(session.get(MANAGEMENT).json())
    stranger = APIClient()
    stranger.force_login(e["collaborator"])
    assert stranger.post(MANAGEMENT + value["id"] + "/revoke/", {}, format="json").status_code == 404
    for _ in range(2):
        assert (
            session.post(MANAGEMENT + value["id"] + "/revoke/", {}, format="json", HTTP_X_CSRFTOKEN=csrf).status_code
            == 200
        )


def test_legacy_authentication_not_upgraded_and_limit_not_bypassed(unified):
    e = unified
    _, old_grant, raw = scoped_client(e)
    assert db.ResearchContextGrant.objects.filter(pk=old_grant.pk).exists()
    client = APIClient()
    client.credentials(
        HTTP_AUTHORIZATION="Bearer " + raw,
        HTTP_X_API_KEY=e["token"].token,
        HTTP_ACCEPT="application/json, text/event-stream",
    )
    assert rpc(client, "ping").status_code == 401
    assert client.get(MANAGEMENT).status_code in (401, 403)
    for _ in range(5):
        issued(e, domains={"research": "read"})
    response = e["owner_client"].post(MANAGEMENT, payload(e), format="json")
    assert response.status_code == 409 and response.data["error_code"] == "grant_limit"
    response = e["owner_client"].post(
        f"/api/research/workspaces/{e['workspace'].slug}/mcp/connections/",
        {"node_id": str(e["node"].pk), "label": "cannot bypass", "mode": "read", "actions": []},
        format="json",
    )
    assert response.status_code == 409


def test_transport_negotiation_methods_notifications_batch_and_origin(unified):
    e = unified
    value, client = issued(e)
    result = rpc(
        client,
        "initialize",
        {"protocolVersion": "2025-11-25", "capabilities": {}, "clientInfo": {"name": "probe", "version": "1"}},
    )
    assert result.json()["result"]["protocolVersion"] == "2025-03-26"
    assert not result.has_header("Mcp-Session-Id")
    assert client.get("/api/mcp/").status_code == 405
    assert client.delete("/api/mcp/").status_code == 405
    assert (
        client.post("/api/mcp/", {"jsonrpc": "2.0", "method": "notifications/initialized"}, format="json").status_code
        == 202
    )
    batch = client.post(
        "/api/mcp/",
        [{"jsonrpc": "2.0", "id": 0, "method": "ping"}, {"jsonrpc": "2.0", "method": "notifications/initialized"}],
        format="json",
    )
    assert batch.json() == [{"jsonrpc": "2.0", "id": 0, "result": {}}]
    assert rpc(client, "ping", identity=False).json()["error"]["code"] == -32600
    assert client.post("/api/mcp/", {}, format="json", HTTP_ORIGIN="http://evil.invalid").status_code == 403
    client.credentials(HTTP_AUTHORIZATION="Bearer " + value["secret"], HTTP_ACCEPT="application/json")
    assert client.post("/api/mcp/", {}, format="json").status_code == 406
    assert resolve("/api/mcp/").url_name == "unified-mcp"
    assert resolve("/api/mcp/native/options/").url_name == "native-mcp-bridge"


@pytest.mark.django_db(transaction=True)
def test_real_sdk_single_configuration_two_projects_two_nodes_readback_and_revocation(
    unified, live_server, record_property
):
    from mcp import ClientSession
    from mcp.client.streamable_http import streamable_http_client

    e = unified
    login = APIClient()
    login.force_login(e["owner"])
    cookie = login.cookies[django_settings.SESSION_COOKIE_NAME].value
    with httpx.Client(
        base_url=live_server.url, cookies={django_settings.SESSION_COOKIE_NAME: cookie}, trust_env=False
    ) as human:
        csrf = human.get(MANAGEMENT).json()["csrf_token"]
        assert human.post(MANAGEMENT, json=payload(e)).status_code == 403
        response = human.post(MANAGEMENT, json=payload(e), headers={"X-CSRFToken": csrf})
        assert response.status_code == 201
        value = response.json()
        config = json.loads(value["sciencediscovery_json"])["mcpServers"]
        assert len(config) == 1
        server = config["plane"]

        async def scenario():
            async with httpx.AsyncClient(headers=server["headers"], trust_env=False) as http:
                async with streamable_http_client(server["url"], http_client=http) as streams:
                    async with ClientSession(
                        streams[0], streams[1], read_timeout_seconds=timedelta(seconds=30)
                    ) as session:
                        initialized = await session.initialize()
                        assert initialized.serverInfo.name == "plane-unified-mcp"
                        names, cursor = [], None
                        while True:
                            page = await session.list_tools(cursor=cursor)
                            names.extend(tool.name for tool in page.tools)
                            cursor = page.nextCursor
                            if not cursor:
                                break
                        assert len(names) == 6 and "plane_read_resource" in names

                        async def call(name, args):
                            response = await session.call_tool(name, args)
                            assert not response.isError, response
                            return response.structuredContent

                        workspaces = await call("plane_list_workspaces", {})
                        assert [item["id"] for item in workspaces["data"]] == [str(e["workspace"].pk)]
                        containers = await call("plane_list_containers", {"workspace_slug": e["workspace"].slug})
                        assert {x["id"] for x in containers["data"] if x["domain"] == "administrative"} == {
                            str(p.pk) for p in e["projects"]
                        }
                        nodes = await call("plane_list_nodes", {"container": reference(e, "ResearchChain", e["chain"])})
                        assert {x["id"] for x in nodes["data"]} == {str(e["node"].pk), str(e["other"].pk)}
                        for project, issue in zip(e["projects"], e["issues"]):
                            listed = await call("plane_list_tasks", {"parent": reference(e, "Project", project)})
                            assert listed["data"][0]["id"] == str(issue.pk)
                            result = await call(
                                "plane_read_resource",
                                {
                                    "parent": reference(e, "Issue", issue),
                                    "kind": "issue_description",
                                    "resource_id": str(issue.pk),
                                },
                            )
                            assert "administrative body" in result["data"]["text"]
                        for node, task in zip((e["node"], e["other"]), e["tasks"]):
                            listed = await call("plane_list_tasks", {"parent": reference(e, "ResearchChainNode", node)})
                            assert listed["data"][0]["id"] == str(task.pk)
                            result = await call(
                                "plane_read_resource",
                                {
                                    "parent": reference(e, "ResearchChainNode", node),
                                    "kind": "task",
                                    "resource_id": str(task.pk),
                                },
                            )
                            assert "research body" in result["data"]["text"]
                        assert (
                            human.post(
                                MANAGEMENT + value["id"] + "/revoke/", json={}, headers={"X-CSRFToken": csrf}
                            ).status_code
                            == 200
                        )
                        assert (
                            await http.post(
                                server["url"],
                                json={"jsonrpc": "2.0", "id": 30, "method": "ping"},
                                headers={"Accept": "application/json, text/event-stream"},
                            )
                        ).status_code == 401
            return {
                "transport": "real TCP Streamable HTTP",
                "sdk": "mcp 1.28.1",
                "servers": 1,
                "administrative_projects": 2,
                "research_nodes": 2,
                "tools": len(names),
                "revoked": True,
            }

        record_property("single_configuration_proof", json.dumps(asyncio.run(scenario())))
