"""邮箱过滤配置的权限、持久化、规范化及发送链路契约测试。"""

import json
from copy import deepcopy
from unittest.mock import MagicMock, patch
from uuid import uuid4

import pytest
from django.core.mail import EmailMultiAlternatives
from django.db import DatabaseError

from plane.license.models import InstanceConfiguration
from plane.tests.research_fixtures import make_instance_admin
from plane.utils.account_email import AccountEmailDeliveryError, send_account_email
from plane.utils.email import filter_email_recipients, is_email_recipient_blocked
from plane.utils.email_recipient_filters import (
    DEFAULT_EMAIL_RECIPIENT_FILTERS,
    EMAIL_RECIPIENT_FILTERS_KEY,
    EmailRecipientFilterConfigurationError,
    get_email_recipient_filters,
)

pytestmark = pytest.mark.django_db
URL = "/api/instances/email-recipient-filters/"


def policy(value="@Example.com", rule_type="domain", enabled=True, rule_enabled=True):
    """构造带稳定标识的独立测试策略。"""
    return {
        "enabled": enabled,
        "rules": [{"id": str(uuid4()), "type": rule_type, "value": value, "note": "测试规则", "enabled": rule_enabled}],
    }


@pytest.fixture
def admin_client(session_client, create_user):
    """授予实例管理员权限，复用当前测试会话。"""
    make_instance_admin(create_user)
    return session_client


def test_default_save_refresh_and_remove_last_rule(admin_client):
    """首次读取用默认值；保存和删除最后一条规则后立即生效。"""
    assert admin_client.get(URL).json() == DEFAULT_EMAIL_RECIPIENT_FILTERS
    draft = policy()
    saved = admin_client.put(URL, draft, format="json")
    assert saved.status_code == 200
    assert saved.json()["rules"][0]["value"] == "example.com"
    assert saved.json()["rules"][0]["id"] == draft["rules"][0]["id"]
    assert admin_client.get(URL).json() == saved.json()
    assert is_email_recipient_blocked("Person <USER@EXAMPLE.COM>")
    assert not is_email_recipient_blocked("user@team.example.com")
    assert not is_email_recipient_blocked("admin@ai4ms.local")
    assert admin_client.put(URL, {"enabled": True, "rules": []}, format="json").status_code == 200
    assert get_email_recipient_filters() == {"enabled": True, "rules": []}
    assert not is_email_recipient_blocked("admin@ai4ms.local")


@pytest.mark.parametrize(("enabled", "rule_enabled"), [(False, True), (True, False), (False, False)])
def test_switches_are_respected(admin_client, enabled, rule_enabled):
    """总开关和规则开关独立控制匹配。"""
    assert admin_client.put(URL, policy(enabled=enabled, rule_enabled=rule_enabled), format="json").status_code == 200
    assert not is_email_recipient_blocked("user@example.com")


@pytest.mark.parametrize(
    ("value", "rule_type"),
    [
        ("bad", "email"),
        ("a@example.com,b@example.com", "email"),
        ("*example.com", "domain"),
        ("*.example.com", "domain"),
        ("https://example.com", "domain"),
        ("@@example.com", "domain"),
        ("a\r\nBcc: b@example.com", "email"),
        ("example.com", "regex"),
    ],
)
def test_invalid_rules_do_not_overwrite_existing_configuration(admin_client, value, rule_type):
    """非法草稿整体拒绝，不部分写入。"""
    saved = policy()
    admin_client.put(URL, saved, format="json")
    before = get_email_recipient_filters()
    response = admin_client.put(URL, policy(value, rule_type), format="json")
    assert response.status_code == 400
    assert response.json()["detail"]["rules"][0]["index"] == 0
    assert get_email_recipient_filters() == before


def test_normalized_duplicates_and_duplicate_ids_are_rejected(admin_client):
    """重复规则按规范化值判断，停用规则也不能重复。"""
    draft = policy()
    draft["rules"] += policy("example.com", rule_enabled=False)["rules"]
    assert admin_client.put(URL, draft, format="json").status_code == 400
    draft["rules"][1]["value"] = "other.com"
    draft["rules"][1]["id"] = draft["rules"][0]["id"]
    assert admin_client.put(URL, draft, format="json").status_code == 400


def test_draft_check_never_persists_or_sends(admin_client):
    """检查草稿使用同一套后端规则，不修改已生效策略。"""
    with patch("django.core.mail.backends.smtp.EmailBackend.open") as smtp:
        result = admin_client.post(
            URL + "check/", {"email": "  人员 <USER@EXAMPLE.COM> ", "policy": policy()}, format="json"
        )
    assert result.status_code == 200
    assert result.json()["email"] == "user@example.com"
    assert result.json()["blocked"] is True
    assert result.json()["matched_rule"]["value"] == "example.com"
    assert not InstanceConfiguration.objects.filter(key=EMAIL_RECIPIENT_FILTERS_KEY).exists()
    smtp.assert_not_called()
    assert admin_client.post(URL + "check/", {"email": "invalid", "policy": policy()}, format="json").status_code == 400


def test_general_configuration_endpoint_cannot_bypass_validation(admin_client):
    """通用配置接口禁止直接写入 JSON 策略。"""
    admin_client.put(URL, policy(), format="json")
    response = admin_client.patch("/api/instances/configurations/", {EMAIL_RECIPIENT_FILTERS_KEY: "{}"}, format="json")
    assert response.status_code == 400
    assert get_email_recipient_filters()["rules"][0]["value"] == "example.com"


@pytest.mark.parametrize("method", ["get", "put", "post"])
def test_only_instance_administrators_can_access_rules(session_client, workspace, method):
    """普通工作区成员及管理员均不能读取或修改实例规则。"""
    # workspace fixture 为当前用户授予工作区管理员角色，不授予实例管理权限。
    url = URL + "check/" if method == "post" else URL
    response = getattr(session_client, method)(url, policy(), format="json")
    assert response.status_code == 403


def test_anonymous_cannot_read_rules(api_client):
    """未登录用户无法读取实例邮箱规则。"""
    assert api_client.get(URL).status_code in (401, 403)


@pytest.mark.parametrize("value", ["{", "null", '{"enabled": true, "rules": null}', ""])
def test_invalid_stored_configuration_blocks_smtp_and_allows_repair(admin_client, value):
    """损坏配置阻止发信；管理员仍可完整覆盖修复。"""
    InstanceConfiguration.objects.create(key=EMAIL_RECIPIENT_FILTERS_KEY, value=value, category="SMTP")
    assert admin_client.get(URL).status_code == 503
    connection = MagicMock()
    with pytest.raises(AccountEmailDeliveryError) as error:
        send_account_email(EmailMultiAlternatives(to=["allowed@example.com"], connection=connection))
    assert error.value.code == "email_recipient_filters_unavailable"
    assert error.value.retryable
    connection.open.assert_not_called()
    with patch("plane.license.api.views.configuration.get_connection") as smtp:
        assert (
            admin_client.post(
                "/api/instances/email-credentials-check/", {"receiver_email": "a@example.com"}, format="json"
            ).status_code
            == 503
        )
        smtp.assert_not_called()
    assert admin_client.put(URL, {"enabled": False, "rules": []}, format="json").status_code == 200


def test_database_failure_does_not_fall_back_to_allowing():
    """数据库不可用时禁止回退，防止过滤配置失效后发送邮件。"""
    with patch.object(InstanceConfiguration.objects, "filter", side_effect=DatabaseError):
        with pytest.raises(EmailRecipientFilterConfigurationError):
            get_email_recipient_filters()


@pytest.mark.parametrize(
    "invalid",
    [
        {"enabled": "true", "rules": []},
        {"enabled": True, "rules": {}},
        {"rules": []},
        {"enabled": True, "rules": [], "unknown": True},
        [],
    ],
)
def test_invalid_policy_structure_is_rejected(admin_client, invalid):
    """严格校验策略结构，避免隐式转换总开关或空规则。"""
    assert admin_client.put(URL, invalid, format="json").status_code == 400


@pytest.mark.parametrize(("field", "value"), [("id", "invalid"), ("note", "x" * 501), ("enabled", "true")])
def test_invalid_rule_metadata_is_rejected(admin_client, field, value):
    """规则标识、备注长度与布尔开关必须符合契约。"""
    draft = policy()
    draft["rules"][0][field] = value
    assert admin_client.put(URL, draft, format="json").status_code == 400


def test_email_rule_normalization_and_environment_mode(admin_client, settings):
    """显示名称邮箱统一规范化；SMTP 使用环境变量时仍读取数据库策略。"""
    settings.SKIP_ENV_VAR = False
    response = admin_client.put(URL, policy("  管理员 <ADMIN@AI4MS.LOCAL> ", "email"), format="json")
    assert response.status_code == 200
    assert response.json()["rules"][0]["value"] == "admin@ai4ms.local"
    assert is_email_recipient_blocked("  ADMIN@AI4MS.LOCAL ")
    assert not is_email_recipient_blocked("another@ai4ms.local")


def test_one_database_read_per_message_and_immediate_policy_refresh(admin_client, django_assert_num_queries):
    """To/Cc/Bcc 共用一次策略读取，下一封邮件使用保存后的新策略。"""
    admin_client.put(URL, policy(), format="json")
    message = EmailMultiAlternatives(
        to=["A@EXAMPLE.COM", "other@ai4ms.local"], cc=["a@sub.example.com"], bcc=["B <b@example.com>"]
    )
    with django_assert_num_queries(1):
        assert filter_email_recipients(message) == 2
    assert message.recipients() == ["other@ai4ms.local", "a@sub.example.com"]
    draft = deepcopy(DEFAULT_EMAIL_RECIPIENT_FILTERS)
    admin_client.put(URL, draft, format="json")
    assert is_email_recipient_blocked("Admin <ADMIN@AI4MS.LOCAL>")
    assert not is_email_recipient_blocked("user@example.com")
    assert json.loads(InstanceConfiguration.objects.get(key=EMAIL_RECIPIENT_FILTERS_KEY).value) == draft
