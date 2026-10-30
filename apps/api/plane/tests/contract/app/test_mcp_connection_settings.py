"""项目与周报连接的配置回看、重置和长期授权回归。"""
# ruff: noqa: F401, F811

import json
from datetime import timedelta
from unittest.mock import Mock, patch

import pytest
from django.utils import timezone
from django.utils.dateparse import parse_datetime
from django.http import HttpResponse
from django.test import RequestFactory
from rest_framework.test import APIClient

from plane.db import models as db
from plane.mcp.credentials import CredentialStorageError, recover_credential
from plane.middleware.logger import APITokenLogMiddleware
from plane.tests.contract.app.test_unified_mcp import env, machine, unified, payload, rpc
from plane.tests.contract.app.test_weekly_report_agent import report_env, research_module_on, proposal
from plane.research.services.weekly_report_operations import WeeklyReportService
from plane.tests.research_fixtures import make_workspace

pytestmark = [pytest.mark.contract, pytest.mark.django_db]


@pytest.fixture(params=["project", "weekly"])
def connection_case(request, settings):
    """为两类连接提供相同的管理与机器鉴权验收接口。"""
    weekly = request.param == "weekly"
    settings.RESEARCH_WEEKLY_REPORT_MCP_ENABLED = True
    source = request.getfixturevalue("report_env" if weekly else "unified")
    user = source["student" if weekly else "owner"]
    other = source["advisor" if weekly else "collaborator"]
    workspace = source["workspace"]
    client = APIClient(enforce_csrf_checks=True)
    client.force_login(user)
    root = (
        f"/api/research/workspaces/{workspace.slug}/mcp/weekly-report/connections/"
        if weekly
        else "/api/mcp/connections/"
    )
    csrf = client.get(root).json()["csrf_token"]
    data = (
        {"label": "回看测试", "actions": ["save_draft", "submit"], "ttl_days": 365}
        if weekly
        else {
            **payload(source),
            "ttl_days": 365,
        }
    )

    def post(path="", body=None, **headers):
        """使用真实会话与 CSRF 请求管理接口。"""
        return client.post(root + path, data if body is None else body, format="json", HTTP_X_CSRFTOKEN=csrf, **headers)

    def secret(value):
        """从两类完整配置响应中提取合成测试密钥。"""
        return value["headers"]["X-Weekly-Report-Token"] if weekly else value["secret"]

    def ping(raw):
        """用独立无会话客户端检查机器凭据。"""
        machine_client = APIClient()
        if weekly:
            return machine_client.post(
                f"/api/research/workspaces/{workspace.slug}/weekly-report-agent/mcp/",
                {"jsonrpc": "2.0", "id": 1, "method": "ping"},
                format="json",
                HTTP_X_WEEKLY_REPORT_TOKEN=raw,
            )
        machine_client.credentials(
            HTTP_AUTHORIZATION="Bearer " + raw, HTTP_ACCEPT="application/json, text/event-stream"
        )
        return rpc(machine_client, "ping")

    return {
        "weekly": weekly,
        "source": source,
        "user": user,
        "other": other,
        "workspace": workspace,
        "client": client,
        "root": root,
        "data": data,
        "post": post,
        "secret": secret,
        "ping": ping,
        "model": db.ReportAgentGrant if weekly else db.UnifiedMCPConnection,
    }


def test_configuration_is_recoverable_encrypted_owner_only_and_csrf_protected(connection_case):
    """原密钥可按需回看，列表、日志与其他账号均不可获得密钥。"""
    c = connection_case
    issued = c["post"]()
    assert issued.status_code == 201, issued.data
    value = issued.json()
    raw = c["secret"](value)
    row = c["model"].objects.get(pk=value["id"])
    assert row.token_encrypted and raw not in row.token_encrypted and recover_credential(row) == raw
    listing = c["client"].get(c["root"]).json()
    assert listing["results"][0]["configuration_available"] is True
    assert raw not in json.dumps(listing) and "token_encrypted" not in json.dumps(listing)
    path = value["id"] + "/configuration/"
    recovered = c["post"](path, {})
    assert recovered.status_code == 200 and c["secret"](recovered.json()) == raw
    assert recovered["Cache-Control"] == "no-store" and recovered["Referrer-Policy"] == "no-referrer"
    stranger = APIClient()
    stranger.force_login(c["other"])
    anonymous = APIClient()
    for action in ("configuration", "rotate"):
        path = value["id"] + f"/{action}/"
        assert c["client"].post(c["root"] + path, {}, format="json").status_code == 403
        assert stranger.post(c["root"] + path, {}, format="json").status_code == 404
        assert anonymous.post(c["root"] + path, {}, format="json").status_code in (401, 403)
        anonymous.credentials(HTTP_AUTHORIZATION="Bearer " + raw, HTTP_X_WEEKLY_REPORT_TOKEN=raw)
        assert anonymous.post(c["root"] + path, {}, format="json").status_code in (401, 403)
    assert raw not in json.dumps(list(db.ResearchAuditEvent.objects.values("metadata")), default=str)


def test_rotation_preserves_scope_and_deadline_and_revokes_old_secret(connection_case):
    """旧连接确认重置后启用回看，旧密钥无法继续调用。"""
    c = connection_case
    value = c["post"]().json()
    row = c["model"].objects.get(pk=value["id"])
    c["model"].objects.filter(pk=row.pk).update(token_encrypted="")
    assert c["post"](value["id"] + "/configuration/", {}).status_code == 409
    rotated = c["post"](value["id"] + "/rotate/", {})
    assert rotated.status_code == 200, rotated.data
    new = rotated.json()
    assert c["secret"](new) != c["secret"](value)
    row.refresh_from_db()
    assert row.expires_at.isoformat() == value["expires_at"] and new["id"] == value["id"]
    assert new.get("scope", new.get("actions")) == value.get("scope", value.get("actions"))
    assert c["ping"](c["secret"](value)).status_code in (401, 403)
    assert c["ping"](c["secret"](new)).status_code == 200
    assert c["secret"](c["post"](value["id"] + "/configuration/", {}).json()) == c["secret"](new)


def test_encryption_failure_rolls_back_creation_and_rotation(connection_case):
    """加密失败不新增连接，重置失败保留原凭据。"""
    c = connection_case
    module = "plane.research.services.weekly_report_policy" if c["weekly"] else "plane.mcp.authorization"
    with patch(module + ".seal_credential", side_effect=CredentialStorageError()):
        response = c["post"]()
        assert response.status_code == 503
    assert not c["model"].objects.exists()
    value = c["post"]().json()
    module = "plane.research.views.weekly_report_agent" if c["weekly"] else "plane.mcp.endpoints"
    with patch(module + ".seal_credential", side_effect=CredentialStorageError()):
        assert c["post"](value["id"] + "/rotate/", {}).status_code == 503
    assert c["ping"](c["secret"](value)).status_code == 200
    assert c["secret"](c["post"](value["id"] + "/configuration/", {}).json()) == c["secret"](value)


def test_audit_failure_rolls_back_creation_and_rotation(connection_case):
    """审计失败时整笔事务回滚，避免出现未记录的连接或密钥变更。"""
    c = connection_case
    c["client"].raise_request_exception = False
    module = "plane.research.services.weekly_report_policy" if c["weekly"] else "plane.mcp.authorization"
    with patch(module + ".record_audit_event", side_effect=RuntimeError("synthetic audit failure")):
        assert c["post"]().status_code >= 500
    assert not c["model"].objects.exists()
    value = c["post"]().json()
    module = "plane.research.views.weekly_report_agent" if c["weekly"] else "plane.mcp.endpoints"
    with patch(module + ".record_audit_event", side_effect=RuntimeError("synthetic audit failure")):
        assert c["post"](value["id"] + "/rotate/", {}).status_code >= 500
    assert c["ping"](c["secret"](value)).status_code == 200
    assert c["secret"](c["post"](value["id"] + "/configuration/", {}).json()) == c["secret"](value)


def test_connection_paging_is_stable_for_equal_creation_times(connection_case):
    """创建时间相同时按 ID 稳定倒序分页，翻页不遗漏也不重复。"""
    c = connection_case
    value = c["post"]().json()
    base = (
        {"workspace": c["workspace"], "user": c["user"], "allowed_actions": ["save_draft"]}
        if c["weekly"]
        else {
            "owner": c["user"],
            "scope": c["model"].objects.get(pk=value["id"]).scope,
            "name": "分页连接",
        }
    )
    c["model"].objects.bulk_create([c["model"](**base, token_hash=f"{i:064x}", expires_at=None) for i in range(32)])
    c["model"].objects.update(created_at=timezone.now())
    seen, cursor = [], None
    while True:
        response = c["client"].get(c["root"], {"cursor": cursor} if cursor else {})
        assert response.status_code == 200
        page = response.json()
        seen.extend(item["id"] for item in page["results"])
        cursor = page["next_cursor"]
        if cursor is None:
            break
    expected = [str(pk) for pk in c["model"].objects.order_by("-created_at", "-pk").values_list("pk", flat=True)]
    assert seen == expected and len(seen) == len(set(seen)) == 33


@pytest.mark.parametrize(
    "path",
    [
        "/api/mcp/connections/synthetic/configuration/",
        "/api/mcp/connections/synthetic/rotate/",
        "/api/research/workspaces/synthetic/mcp/weekly-report/connections/synthetic/configuration/",
        "/api/research/workspaces/synthetic/mcp/weekly-report/connections/synthetic/rotate/",
    ],
)
def test_configuration_routes_do_not_log_credentials(path):
    """配置与重置接口沿用摘要审计，禁止请求日志存储密钥响应。"""
    request = RequestFactory().post(path, {}, content_type="application/json", HTTP_X_API_KEY="synthetic-key")
    middleware = APITokenLogMiddleware(Mock())
    with patch("plane.middleware.logger.process_logs") as logs:
        middleware.process_request(request, HttpResponse(b'{"secret":"synthetic-secret"}'), request.body)
    logs.delay.assert_not_called()


@pytest.mark.parametrize("lifetime", [1, 7, 30, 365, None])
def test_supported_lifetimes_and_never_expiring_authentication(connection_case, lifetime):
    """所有有效期可签发，永久连接可正常鉴权及撤销。"""
    c = connection_case
    response = c["post"](body={**c["data"], "ttl_days": lifetime})
    assert response.status_code == 201, response.data
    value = response.json()
    if lifetime is None:
        assert value["expires_at"] is None
    else:
        remaining = parse_datetime(value["expires_at"]) - timezone.now()
        assert timedelta(days=lifetime) - timedelta(seconds=10) < remaining <= timedelta(days=lifetime)
    assert c["ping"](c["secret"](value)).status_code == 200
    assert c["post"](value["id"] + "/revoke/", {}).status_code == 200
    assert not c["model"].objects.get(pk=value["id"]).token_encrypted
    for action in ("configuration", "rotate"):
        assert c["post"](value["id"] + f"/{action}/", {}).status_code == 409
    assert c["ping"](c["secret"](value)).status_code in (401, 403)


@pytest.mark.parametrize("lifetime", [True, False, 0, -1, 366, "365"])
def test_invalid_lifetimes_rejected(connection_case, lifetime):
    """不能通过布尔值、字符串或未提供的天数绕过期限校验。"""
    c = connection_case
    assert c["post"](body={**c["data"], "ttl_days": lifetime}).status_code == 400


def test_expired_credentials_cannot_reveal_or_rotate(connection_case):
    """到期后保留元数据但不允许读取配置或重置。"""
    c = connection_case
    value = c["post"]().json()
    c["model"].objects.filter(pk=value["id"]).update(expires_at=timezone.now() - timedelta(seconds=1))
    for action in ("configuration", "rotate"):
        assert c["post"](value["id"] + f"/{action}/", {}).status_code == 409
    assert len(c["client"].get(c["root"]).json()["results"]) == 1


def test_private_workspace_admission_rechecked_for_machine_and_candidates(connection_case):
    """私有席位撤回后，机器调用和候选列表均拒绝该工作区。"""
    c = connection_case
    value = c["post"]().json()
    db.WorkspaceResearchSetting.objects.update_or_create(
        workspace=c["workspace"],
        defaults={
            "purpose": "PI_PRIVATE",
            "main_pi": c["other"],
        },
    )
    if c["weekly"]:
        assert c["ping"](c["secret"](value)).status_code == 403
        options = c["client"].get("/api/research/mcp/weekly-report/options/").json()["workspaces"]
        assert str(c["workspace"].pk) not in {w["id"] for w in options}
        assert c["post"]().status_code == 403
    else:
        from plane.mcp.authorization import workspace_access
        from plane.research.services.mcp_catalog import ResearchReadError

        with pytest.raises(ResearchReadError):
            workspace_access(c["user"], c["workspace"], "administrative")


def test_default_year_and_workspace_names_do_not_depend_on_options_paging(unified):
    """旧请求省略期限时默认一年，列表批量提供工作区名称。"""
    value = unified["owner_client"].post("/api/mcp/connections/", payload(unified), format="json").json()
    assert parse_datetime(value["expires_at"]) > timezone.now() + timedelta(days=364)
    page = unified["owner_client"].get("/api/mcp/connections/").json()
    assert page["results"][0]["scope"]["workspaces"][0]["workspace_name"] == unified["workspace"].name


def test_permanent_research_connections_count_toward_limit(unified):
    """永久连接不能绕过科研授权数量限制。"""
    for _ in range(5):
        response = unified["owner_client"].post(
            "/api/mcp/connections/", {**payload(unified), "ttl_days": None}, format="json"
        )
        assert response.status_code == 201
    assert unified["owner_client"].post("/api/mcp/connections/", payload(unified), format="json").status_code == 409


def test_permanent_weekly_connections_count_toward_limit(report_env, settings):
    """永久周报连接计入十条上限，撤销后才释放名额。"""
    from plane.research.services.weekly_report_policy import issue_grant
    from plane.research.services.weekly_report_errors import WeeklyReportError

    settings.RESEARCH_WEEKLY_REPORT_MCP_ENABLED = True
    args = {
        "workspace": report_env["workspace"],
        "user": report_env["student"],
        "label": "永久周报",
        "actions": ["save_draft"],
        "ttl_days": None,
    }
    for _ in range(10):
        grant, _ = issue_grant(**args)
    with pytest.raises(WeeklyReportError) as failure:
        issue_grant(**args)
    assert failure.value.code == "grant_limit"
    db.ReportAgentGrant.objects.filter(pk=grant.pk).update(revoked_at=timezone.now(), token_encrypted="")
    assert issue_grant(**args)[0].expires_at is None


def test_permanent_weekly_connection_does_not_extend_proposal_lifetime(report_env, settings):
    """永久连接的周报草稿及提交提案仍在十五分钟内失效。"""
    from plane.research.services.weekly_report_policy import issue_grant

    settings.RESEARCH_WEEKLY_REPORT_MCP_ENABLED = True
    grant, _ = issue_grant(
        workspace=report_env["workspace"],
        user=report_env["student"],
        label="永久周报",
        actions=["save_draft", "submit"],
        ttl_days=None,
    )
    service = WeeklyReportService(grant=grant)
    for action in ("save_draft", "submit"):
        prepared, _ = proposal(service, action=action)
        remaining = parse_datetime(prepared["expires_at"]) - timezone.now()
        assert timedelta(0) < remaining <= timedelta(minutes=15)
        result = service.execute("execute_weekly_report_operation", {"operation_id": prepared["operation_id"]})
        assert result["status"] == "COMMITTED"
