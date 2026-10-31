"""Final single-credential acceptance: both native domains and real lost-response recovery."""
# ruff: noqa: F401, F811

import asyncio
import json
from datetime import timedelta
from threading import Event, Thread
from unittest.mock import patch
from uuid import uuid4

import httpx
import pytest
from django.conf import settings as django_settings
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
from plane.tests.contract.app.test_unified_mcp_writes import native_effects, writable
from plane.tests.research_fixtures import make_workspace

pytestmark = [pytest.mark.contract, pytest.mark.django_db(transaction=True)]


def test_real_sdk_one_configuration_both_domains_and_live_scope_changes(
    unified,
    settings,
    native_effects,
    live_server,
    record_property,
):
    from asgiref.sync import sync_to_async
    from mcp import ClientSession
    from mcp.client.streamable_http import streamable_http_client

    e = unified
    settings.RESEARCH_MCP_WRITE_ENABLED = True
    settings.RESEARCH_MCP_PUBLIC_BASE_URL = live_server.url
    db.WorkspaceResearchSetting.objects.filter(workspace=e["workspace"]).update(research_mcp_write_enabled=True)
    for project in [*e["projects"], e["private_project"]]:
        db.ProjectMember.objects.get_or_create(
            workspace=e["workspace"],
            project=project,
            member=e["owner"],
            defaults={"role": 20},
        )
    second = make_workspace(e["owner"], name="Second selected workspace")
    project2 = db.Project.objects.create(workspace=second, name="行政同名项目", identifier="P6SECOND")
    db.ProjectMember.objects.create(workspace=second, project=project2, member=e["owner"], role=20)
    db.State.objects.create(workspace=second, project=project2, name="Todo", group="unstarted", default=True)
    done = db.State.objects.create(workspace=e["workspace"], project=e["projects"][0], name="Done", group="completed")
    login = APIClient()
    login.force_login(e["owner"])
    with httpx.Client(
        base_url=live_server.url,
        trust_env=False,
        cookies={django_settings.SESSION_COOKIE_NAME: login.cookies[django_settings.SESSION_COOKIE_NAME].value},
    ) as human:
        csrf = human.get(MANAGEMENT).json()["csrf_token"]
        scope = payload(e, domains={"administrative": "read_write", "research": "read_write"})
        scope["workspaces"].append({"workspace_id": str(second.pk), "domains": {"administrative": "read_write"}})
        response = human.post(MANAGEMENT, json=scope, headers={"X-CSRFToken": csrf})
        assert response.status_code == 201, response.text
        issued_value = response.json()
        servers = json.loads(issued_value["sciencediscovery_json"])["mcpServers"]
        assert list(servers) == ["Synthetic unified connection"]
        server = servers["Synthetic unified connection"]
        later = db.ResearchChainNode.objects.create(
            chain=e["chain"],
            node_type="ANALYSIS",
            title="Added after issuance",
            request_id=uuid4().hex,
            payload_hash="c" * 64,
        )

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
                        assert len(names) == 30

                        async def call(name, args, error=None):
                            result = await session.call_tool(name, args)
                            value = result.structuredContent
                            if error:
                                assert result.isError and value["error_code"] == error, result
                            else:
                                assert not result.isError, result
                            return value

                        async def pages(name, args):
                            rows, cursor = [], None
                            while True:
                                value = await call(name, {**args, "limit": 1, **({"cursor": cursor} if cursor else {})})
                                rows.extend(value["data"])
                                cursor = value["page"]["next_cursor"]
                                if not cursor:
                                    return rows

                        workspaces = await pages("plane_list_workspaces", {})
                        assert {w["id"] for w in workspaces} == {str(e["workspace"].pk), str(second.pk)}
                        candidates = await pages(
                            "plane_list_containers", {"workspace_slug": e["workspace"].slug, "query": "行政同名项目"}
                        )
                        assert len(candidates) == 2 and len({p["id"] for p in candidates}) == 2
                        assert str(e["private_project"].pk) not in {p["id"] for p in candidates}
                        for target in (
                            reference(e, "Project", e["private_project"]),
                            reference(e, "Issue", e["node"]),
                            {**reference(e, "Project", project2), "workspace_slug": e["workspace"].slug},
                            reference(e, "Project", e["projects"][0], domain="research"),
                        ):
                            if target["domain"] == "research":
                                result = await session.call_tool(
                                    "plane_get_context", {"target": target, "section": "details"}
                                )
                                assert result.isError
                            else:
                                await call(
                                    "plane_get_context", {"target": target, "section": "details"}, error="not_found"
                                )
                        admin = await call(
                            "plane_create_task",
                            {
                                "parent": reference(e, "Project", e["projects"][0]),
                                "request_id": "phase6-admin-create",
                                "name": "Phase 6 SDK administrative task",
                                "description_html": "<p>Native body</p>",
                            },
                        )
                        ref = {**reference(e, "Issue", e["issues"][0]), "id": admin["object_id"]}
                        replay = await call(
                            "plane_create_task",
                            {
                                "parent": reference(e, "Project", e["projects"][0]),
                                "request_id": "phase6-admin-create",
                                "name": "Phase 6 SDK administrative task",
                                "description_html": "<p>Native body</p>",
                            },
                        )
                        assert replay["object_id"] == ref["id"]
                        await call(
                            "plane_update_task",
                            {
                                "target": ref,
                                "changes": {
                                    "assignee_ids": [str(e["owner"].pk)],
                                    "start_date": "2026-10-29",
                                    "target_date": "2026-11-05",
                                },
                            },
                        )
                        await call(
                            "plane_transition_task", {"target": ref, "action": "set_state", "state_id": str(done.pk)}
                        )
                        for _ in range(2):
                            await call(
                                "plane_add_comment",
                                {
                                    "target": ref,
                                    "request_id": "phase6-admin-comment",
                                    "comment_html": "<p>Phase 6 comment</p>",
                                },
                            )
                        assert "Phase 6 comment" in json.dumps(
                            await call("plane_get_context", {"target": ref, "section": "comments"})
                        )
                        second_ref = {
                            "domain": "administrative",
                            "object_type": "Project",
                            "workspace_slug": second.slug,
                            "id": str(project2.pk),
                        }
                        cross = await call(
                            "plane_create_task",
                            {
                                "parent": second_ref,
                                "request_id": "phase6-second-create",
                                "name": "Second workspace task",
                            },
                        )
                        nodes = await pages(
                            "plane_list_nodes", {"container": reference(e, "ResearchChain", e["chain"])}
                        )
                        assert str(later.pk) in {n["id"] for n in nodes}
                        research = []
                        for index, node in enumerate((e["node"], later)):
                            node_ref = reference(e, "ResearchChainNode", node)
                            proposal = await call(
                                "plane_prepare_research_operation",
                                {
                                    "node": node_ref,
                                    "request_id": f"phase6-research-{index}",
                                    "action": "create_task",
                                    "payload": {"title": "Phase 6 SDK research task"},
                                },
                            )
                            args = {"workspace_slug": e["workspace"].slug, "operation_id": proposal["operation_id"]}
                            committed = await call("plane_execute_research_operation", args)
                            assert (await call("plane_execute_research_operation", args))["result"][
                                "object_id"
                            ] == committed["result"]["object_id"]
                            task_ref = {
                                **node_ref,
                                "object_type": "ResearchChainNodeTask",
                                "id": committed["result"]["object_id"],
                            }
                            await call(
                                "plane_update_task",
                                {
                                    "target": task_ref,
                                    "changes": {
                                        "title": "Phase 6 edited research",
                                        "assignee": str(e["owner"].pk),
                                        "due_at": "2026-11-05T09:00:00+08:00",
                                    },
                                },
                            )
                            comment = await call(
                                "plane_prepare_research_operation",
                                {
                                    "node": node_ref,
                                    "request_id": f"phase6-research-comment-{index}",
                                    "action": "append_task_comment",
                                    "payload": {"task_id": task_ref["id"], "text": "Phase 6 research comment"},
                                },
                            )
                            await call(
                                "plane_execute_research_operation", {**args, "operation_id": comment["operation_id"]}
                            )
                            transition = {
                                "target": task_ref,
                                "action": "cancel",
                                "request_id": f"phase6-cancel-{index}",
                                "reason": "Isolated acceptance",
                            }
                            await call("plane_transition_task", transition)
                            await call("plane_transition_task", transition)
                            await call(
                                "plane_transition_task",
                                {**transition, "reason": "Changed"},
                                error="idempotency_conflict",
                            )
                            assert "Phase 6 research comment" in json.dumps(
                                await call("plane_get_context", {"target": task_ref, "section": "comments"})
                            )
                            research.append((str(node.pk), task_ref["id"]))
                        # Membership changes take effect in this already-initialized SDK session.
                        await sync_to_async(
                            db.WorkspaceMember.objects.filter(workspace=second, member=e["owner"]).update
                        )(is_active=False)
                        workspace_rows = await pages("plane_list_workspaces", {})
                        assert {str(e["workspace"].pk), str(second.pk)} <= {w["id"] for w in workspace_rows}
                        assert next(w for w in workspace_rows if w["id"] == str(second.pk))["live_access"] is False
                        await call(
                            "plane_get_context",
                            {
                                "target": {**second_ref, "object_type": "Issue", "id": cross["object_id"]},
                                "section": "details",
                            },
                            error="scope_denied",
                        )
                        return ref["id"], research

        admin_id, research = asyncio.run(scenario())
        web = f"/api/workspaces/{e['workspace'].slug}/projects/{e['projects'][0].pk}/issues/{admin_id}/"
        assert human.get(web).json()["state_id"] == str(done.pk)
        assert "Phase 6 comment" in human.get(web + "comments/").text
        assert "state" in human.get(web + "history/", params={"activity_type": "issue-property"}).text
        for node_id, task_id in research:
            web = (
                f"/api/research/workspaces/{e['workspace'].slug}/chains/{e['chain'].pk}/"
                f"nodes/{node_id}/tasks/{task_id}/"
            )
            assert human.get(web).json()["data"]["title"] == "Phase 6 edited research"
        assert db.UnifiedMCPConnection.objects.count() == 1
        assert not db.ResearchContextGrant.objects.exists() and not db.ResearchAgentWriteGrant.objects.exists()
        assert db.IssueComment.objects.filter(issue_id=admin_id).count() == 1
        assert db.ResearchAgentOperation.objects.count() == 4
        revoke = human.post(f"{MANAGEMENT}{issued_value['id']}/revoke/", json={}, headers={"X-CSRFToken": csrf})
        assert revoke.status_code == 200
        assert (
            human.post(
                "/api/mcp/", headers=server["headers"], json={"jsonrpc": "2.0", "id": 1, "method": "ping"}
            ).status_code
            == 401
        )
    record_property(
        "phase6_single_configuration",
        json.dumps(
            {
                "transport": "real SDK TCP",
                "servers": 1,
                "credentials": 1,
                "tools": 15,
                "workspaces": 2,
                "same_name_candidates": 2,
                "research_nodes_written": 2,
                "future_node_written": True,
                "native_rest_readback": True,
                "member_exit_live": True,
                "revoked_401": True,
            }
        ),
    )


def test_actual_http_timeout_recovers_committed_write_without_reissuing(writable, live_server, record_property):
    """Hold a response after the real transaction commits, time out, then recover by request_id."""
    from plane.mcp.writing import UnifiedWriteService

    e = writable
    entered, release, finished = Event(), Event(), Event()
    original = UnifiedWriteService.present
    errors = []

    def held_response(service, receipt, strict=False):
        entered.set()
        assert release.wait(10), "Test response gate was not released"
        return original(service, receipt, strict=strict)

    def client_call():
        try:
            with httpx.Client(timeout=0.3, trust_env=False) as http:
                http.post(
                    live_server.url + "/api/mcp/",
                    headers={
                        "Authorization": "Bearer " + e["connection"]["secret"],
                        "Accept": "application/json, text/event-stream",
                    },
                    json={
                        "jsonrpc": "2.0",
                        "id": 1,
                        "method": "tools/call",
                        "params": {
                            "name": "plane_create_task",
                            "arguments": {
                                "parent": reference(e, "Project", e["projects"][0]),
                                "request_id": "phase6-lost-response",
                                "name": "Committed despite client timeout",
                            },
                        },
                    },
                )
        except httpx.ReadTimeout:
            errors.append("real_read_timeout")
        finally:
            finished.set()

    with patch.object(UnifiedWriteService, "present", held_response):
        thread = Thread(target=client_call, daemon=True)
        thread.start()
        try:
            assert entered.wait(8), "Write did not reach postcommit response"
            assert finished.wait(5), "Client did not time out"
            assert errors == ["real_read_timeout"]
        finally:
            release.set()
            thread.join(5)
    recovered = invoke(
        e["client"],
        "plane_get_write_result",
        {"workspace_slug": e["workspace"].slug, "request_id": "phase6-lost-response"},
    )
    assert recovered["status"] == "COMMITTED" and recovered["readback"] == "verified"
    assert db.Issue.objects.filter(name="Committed despite client timeout").count() == 1
    assert db.UnifiedMCPWriteResult.objects.filter(request_id="phase6-lost-response").count() == 1
    record_property(
        "phase6_actual_timeout",
        json.dumps(
            {
                "real_http_read_timeout": True,
                "write_committed_before_response": True,
                "recovered_by_request_id": True,
                "create_requests": 1,
                "objects": 1,
            }
        ),
    )


def test_codex_progress_metadata_keeps_catalogue_paging_and_closed_business_arguments(unified):
    _, client = issued(unified)
    cursor, names = None, []
    while True:
        params = {"_meta": {"progressToken": "codex-list", "trace": {"request": "synthetic"}}}
        if cursor:
            params["cursor"] = cursor
        response = rpc(client, "tools/list", params).json()
        assert "error" not in response, response
        result = response["result"]
        names.extend(tool["name"] for tool in result["tools"])
        cursor = result.get("nextCursor")
        if not cursor:
            break
    assert len(names) == len(set(names)) == 6
    response = rpc(
        client, "tools/call", {"name": "plane_list_workspaces", "arguments": {}, "_meta": {"progressToken": 42}}
    ).json()
    assert not response["result"]["isError"]
    assert rpc(client, "tools/list", {"_meta": {}, "unknown": True}).json()["error"]["code"] == -32602
    response = rpc(
        client, "tools/call", {"name": "plane_list_workspaces", "arguments": {"_meta": {}}, "_meta": {}}
    ).json()
    assert response["result"]["isError"]
    for invalid in (None, [], "text", False, 1):
        assert rpc(client, "tools/list", {"_meta": invalid}).json()["error"]["code"] == -32602
