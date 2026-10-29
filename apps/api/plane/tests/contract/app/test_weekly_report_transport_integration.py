"""Real TCP MCP clients and a STDIO child process against an isolated Django server.

Run with pytest-django's live_server and a disposable PostgreSQL test database.
No deployed server, production credentials or browser session is accepted here.
"""

import asyncio
import os
import sys
from datetime import timedelta
from pathlib import Path
from unittest.mock import patch
from uuid import uuid4

import httpx
import pytest
from django.conf import settings as django_settings
from rest_framework.test import APIClient

from plane.db import models as db
from plane.tests.contract.app.test_research_reports import env as report_env, research_module_on  # noqa: F401

pytestmark = [pytest.mark.contract, pytest.mark.django_db(transaction=True)]


@pytest.mark.parametrize("transport", ["http", "stdio"])
def test_real_mcp_client_create_submit_recover_and_revoke(report_env, live_server, settings, transport):  # noqa: F811
    sdk = pytest.importorskip("mcp", reason="Install the demo MCP runtime to run real transport acceptance.")
    ClientSession, StdioServerParameters = sdk.ClientSession, sdk.StdioServerParameters
    stdio_client = pytest.importorskip("mcp.client.stdio").stdio_client
    streamablehttp_client = pytest.importorskip("mcp.client.streamable_http").streamablehttp_client
    settings.RESEARCH_WEEKLY_REPORT_MCP_ENABLED = True
    env = report_env
    # The session is synthetic, but all management requests traverse real TCP,
    # SessionAuthentication and CSRF validation, without force_authenticate.
    login = APIClient()
    login.force_login(env["student"])
    cookie = login.cookies[django_settings.SESSION_COOKIE_NAME].value
    management = f"{live_server.url}/api/research/workspaces/{env['workspace'].slug}/mcp/weekly-report/"
    with httpx.Client(cookies={django_settings.SESSION_COOKIE_NAME: cookie}, timeout=30, trust_env=False) as human:
        options = human.get(management + "options/")
        assert options.status_code == 200
        csrf = options.json()["csrf_token"]
        payload = {"label": f"Live {transport}", "actions": ["save_draft", "submit"], "ttl_days": 1}
        denied = human.post(management + "connections/", json=payload)
        assert denied.status_code == 403
        issued = human.post(management + "connections/", json=payload, headers={"X-CSRFToken": csrf})
        assert issued.status_code == 201
        grant = issued.json()
        root = Path(__file__).resolve().parents[6]
        proxy = root / "demos/sciencediscovery-plane-mcp/weekly_report_mcp.py"
        assert proxy.is_file()
        stderr = root / ".runtime/weekly-report-phase4" / f"stdio-{uuid4().hex}.log"
        stderr.parent.mkdir(parents=True, exist_ok=True)

        async def scenario(session):
            initialized = await session.initialize()
            assert initialized.serverInfo.name == "plane-weekly-report"
            catalogue = (await session.list_tools()).tools
            assert {tool.name for tool in catalogue} == {
                "get_weekly_report_context",
                "prepare_weekly_report_operation",
                "execute_weekly_report_operation",
                "get_weekly_report_operation",
                "cancel_weekly_report_operation",
            }

            async def call(name, arguments):
                response = await session.call_tool(name, arguments)
                assert not response.isError, "Real MCP call rejected; inspect sanitized server error locally."
                return response.structuredContent

            context = await call("get_weekly_report_context", {"period_offset": -1})
            prepared = await call(
                "prepare_weekly_report_operation",
                {
                    "request_id": str(uuid4()),
                    "action": "save_draft",
                    "period_key": context["period"]["key"],
                    "expected_revision": context["revision"],
                    "body_markdown": (
                        f"## 本周完成\n\n通过真实 {transport.upper()} 客户端提交。\n\n## 下周计划\n\n继续验证。"
                    ),
                    "source_refs": [],
                },
            )
            assert prepared["report_id"] is None
            operation = {"operation_id": prepared["operation_id"]}
            draft = await call("execute_weekly_report_operation", operation)
            assert draft["result"]["status"] == "DRAFT" and draft["result"]["snapshot_version"] is None

            async def prepare_submission():
                current = await call("get_weekly_report_context", {"period_offset": -1})
                return await call(
                    "prepare_weekly_report_operation",
                    {
                        "request_id": str(uuid4()),
                        "action": "submit",
                        "period_key": current["period"]["key"],
                        "expected_revision": current["revision"],
                        "body_markdown": f"## 本周完成\n\n通过真实 {transport.upper()} 客户端提交。",
                        "reviewer_id": current["approval"]["default_reviewer_id"],
                        "cc_user_ids": [],
                    },
                )

            stale = await prepare_submission()
            web_edit = human.patch(
                f"{live_server.url}/api/research/workspaces/{env['workspace'].slug}/reports/{draft['report_id']}/",
                json={
                    "description_json": {
                        "type": "doc",
                        "content": [{"type": "paragraph", "content": [{"type": "text", "text": "网页同时修改"}]}],
                    },
                    "description_html": "<p>网页同时修改</p>",
                },
                headers={"X-CSRFToken": csrf},
            )
            assert web_edit.status_code == 200
            conflict = await session.call_tool(
                "execute_weekly_report_operation", {"operation_id": stale["operation_id"]}
            )
            assert conflict.isError and conflict.structuredContent["error_code"] == "report_revision_conflict"

            fresh = await prepare_submission()
            operation = {"operation_id": fresh["operation_id"]}
            # Inject a server-side notification fault; TCP reports an ambiguous
            # failure. Recover the same proposal, never issue a replacement ID.
            with patch(
                "plane.research.services.report_workflow.notify_report_submitted",
                side_effect=RuntimeError("acceptance notification fault"),
            ):
                failed = httpx.post(
                    f"{live_server.url}/api/research/workspaces/{env['workspace'].slug}/weekly-report-agent/tools/execute_weekly_report_operation/",
                    json=operation,
                    headers=grant["headers"],
                    timeout=30,
                    trust_env=False,
                )
            assert failed.status_code == 503
            recovered = await call("get_weekly_report_operation", operation)
            assert recovered["status"] == "PROPOSED" and recovered["result"] is None
            with patch.object(
                db.PeriodicReportSnapshot.objects, "get", side_effect=RuntimeError("acceptance readback fault")
            ):
                committed = await call("execute_weekly_report_operation", operation)
            assert committed["status"] == "COMMITTED" and committed["readback"] == "pending"
            assert committed["result"]["snapshot_version"] == 1
            assert (await call("execute_weekly_report_operation", operation))["result"] == committed["result"]
            assert (await call("get_weekly_report_operation", operation))["result"] == committed["result"]
            assert (await call("get_weekly_report_operation", operation))["readback"] == "verified"
            return committed

        async def run():
            if transport == "http":
                async with streamablehttp_client(
                    live_server.url + grant["mcp_path"], headers=grant["headers"], timeout=30
                ) as streams:
                    async with ClientSession(
                        streams[0], streams[1], read_timeout_seconds=timedelta(seconds=30)
                    ) as session:
                        return await scenario(session)
            child_env = {
                **os.environ,
                "PLANE_BASE_URL": live_server.url,
                "PLANE_WORKSPACE_SLUG": env["workspace"].slug,
                "WEEKLY_REPORT_TOKEN": grant["headers"]["X-Weekly-Report-Token"],
                "NO_PROXY": "127.0.0.1,localhost",
                "PYTHONIOENCODING": "utf-8",
            }
            with stderr.open("w", encoding="utf-8") as errlog:
                async with stdio_client(
                    StdioServerParameters(command=sys.executable, args=[str(proxy)], env=child_env), errlog=errlog
                ) as streams:
                    async with ClientSession(*streams, read_timeout_seconds=timedelta(seconds=30)) as session:
                        return await scenario(session)

        result = asyncio.run(run())
        report_id = result["result"]["report_id"]
        # Existing web REST reads the exact official snapshot, through TCP too.
        detail = human.get(f"{live_server.url}/api/research/workspaces/{env['workspace'].slug}/reports/{report_id}/")
        assert detail.status_code == 200
        assert detail.json()["status"] == "SUBMITTED"
        assert detail.json()["latest_official_version"] == 1
        snapshot = db.PeriodicReportSnapshot.objects.get(report_id=report_id, version_no=1)
        assert snapshot.description_json == detail.json()["draft_content"]["description_json"]
        assert transport.upper() in snapshot.description_stripped
        assert db.PeriodicReportSnapshot.objects.filter(report_id=report_id).count() == 1
        assert db.ReportReviewLog.objects.filter(report_id=report_id, action="SUBMIT").count() == 1
        assert db.Notification.objects.filter(entity_identifier=report_id).count() == 1
        revoked = human.post(management + f"connections/{grant['id']}/revoke/", json={}, headers={"X-CSRFToken": csrf})
        assert revoked.status_code == 200
        denied = httpx.get(
            live_server.url + grant["mcp_path"].replace("mcp/", "tools/"), headers=grant["headers"], timeout=30
        )
        assert denied.status_code == 403
        if stderr.exists():
            assert grant["headers"]["X-Weekly-Report-Token"] not in stderr.read_text(encoding="utf-8")


def test_page_table_contention_returns_retryable_failure_then_recovers_same_operation(
    report_env,  # noqa: F811
    live_server,
    settings,
    record_property,
):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Event
    from time import perf_counter

    from django.db import close_old_connections, connection, transaction

    from plane.research.services.weekly_report_operations import WeeklyReportService
    from plane.research.services.weekly_report_policy import issue_grant

    settings.RESEARCH_WEEKLY_REPORT_MCP_ENABLED = True
    env = report_env
    grant, token = issue_grant(
        workspace=env["workspace"], user=env["student"], label="Lock probe", actions=["submit"], ttl_days=1
    )
    service = WeeklyReportService(grant=grant)
    context = service.execute("get_weekly_report_context", {"period_offset": -1})
    prepared = service.execute(
        "prepare_weekly_report_operation",
        {
            "request_id": str(uuid4()),
            "action": "submit",
            "period_key": context["period"]["key"],
            "expected_revision": context["revision"],
            "body_markdown": "## 本周完成\n\n锁争用恢复验收。",
            "reviewer_id": context["approval"]["default_reviewer_id"],
            "cc_user_ids": [],
        },
    )
    operation = {"operation_id": prepared["operation_id"]}
    acquired, release = Event(), Event()

    def legacy_page_writer():
        close_old_connections()
        try:
            with transaction.atomic(), connection.cursor() as cursor:
                # A writer in any workspace takes this table lock. This probe
                # deliberately demonstrates the current cross-workspace limit.
                cursor.execute(f"LOCK TABLE {connection.ops.quote_name(db.Page._meta.db_table)} IN ROW EXCLUSIVE MODE")
                acquired.set()
                assert release.wait(timeout=15)
        finally:
            close_old_connections()

    endpoint = (
        f"{live_server.url}/api/research/workspaces/{env['workspace'].slug}"
        "/weekly-report-agent/tools/execute_weekly_report_operation/"
    )
    with ThreadPoolExecutor(max_workers=1) as pool:
        blocker = pool.submit(legacy_page_writer)
        assert acquired.wait(timeout=10)
        try:
            started = perf_counter()
            response = httpx.post(
                endpoint, headers={"X-Weekly-Report-Token": token}, json=operation, timeout=30, trust_env=False
            )
            elapsed = round(perf_counter() - started, 3)
        finally:
            release.set()
            blocker.result(timeout=20)
    record_property("page_lock_timeout_seconds", elapsed)
    print(f"\nGlobal Page lock contention: retryable response after {elapsed}s")
    assert response.status_code == 503 and response.json()["retryable"] is True
    assert db.ReportAgentOperation.objects.get(pk=operation["operation_id"]).status == "PROPOSED"
    assert not db.PeriodicReport.objects.filter(workspace=env["workspace"]).exists()
    recovered = httpx.post(
        endpoint, headers={"X-Weekly-Report-Token": token}, json=operation, timeout=30, trust_env=False
    )
    assert recovered.status_code == 200 and recovered.json()["status"] == "COMMITTED"
    assert db.PeriodicReportSnapshot.objects.filter(report_id=recovered.json()["report_id"]).count() == 1


@pytest.mark.parametrize("same_operation", [False, True])
def test_two_tcp_agents_commit_one_snapshot(report_env, live_server, settings, same_operation):  # noqa: F811
    from concurrent.futures import ThreadPoolExecutor
    from threading import Barrier

    from plane.research.services.weekly_report_operations import WeeklyReportService
    from plane.research.services.weekly_report_policy import issue_grant

    settings.RESEARCH_WEEKLY_REPORT_MCP_ENABLED = True
    env = report_env
    grant, token = issue_grant(
        workspace=env["workspace"], user=env["student"], label="TCP competitors", actions=["submit"], ttl_days=1
    )
    service = WeeklyReportService(grant=grant)
    context = service.execute("get_weekly_report_context", {"period_offset": -1})
    operations = [
        service.execute(
            "prepare_weekly_report_operation",
            {
                "request_id": str(uuid4()),
                "action": "submit",
                "period_key": context["period"]["key"],
                "expected_revision": context["revision"],
                "body_markdown": "## 本周完成\n\n两个客户端竞争。",
                "reviewer_id": context["approval"]["default_reviewer_id"],
                "cc_user_ids": [],
            },
        )["operation_id"]
        for _ in range(2)
    ]
    endpoint = (
        f"{live_server.url}/api/research/workspaces/{env['workspace'].slug}"
        "/weekly-report-agent/tools/execute_weekly_report_operation/"
    )
    barrier = Barrier(2)

    def execute(identity):
        barrier.wait(timeout=15)
        response = httpx.post(
            endpoint,
            headers={"X-Weekly-Report-Token": token},
            json={"operation_id": identity},
            timeout=30,
            trust_env=False,
        )
        return response.status_code, response.json()

    with ThreadPoolExecutor(max_workers=2) as pool:
        outcomes = list(pool.map(execute, [operations[0], operations[0] if same_operation else operations[1]]))
    assert sorted(status for status, _ in outcomes) == ([200, 200] if same_operation else [200, 409])
    committed = [value for status, value in outcomes if status == 200]
    if same_operation:
        assert committed[0]["result"] == committed[1]["result"]
    else:
        assert next(value for status, value in outcomes if status == 409)["error_code"] == "report_revision_conflict"
    report_id = committed[0]["report_id"]
    assert db.PeriodicReport.objects.filter(workspace=env["workspace"]).count() == 1
    assert db.PeriodicReportSnapshot.objects.filter(report_id=report_id).count() == 1
    assert db.ReportReviewLog.objects.filter(report_id=report_id, action="SUBMIT").count() == 1
    assert db.Notification.objects.filter(entity_identifier=report_id).count() == 1
