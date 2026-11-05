"""验证各邮件发送入口一致执行管理员邮箱过滤。"""

import importlib
import json
import logging
from io import StringIO
from types import SimpleNamespace
from unittest.mock import MagicMock
from uuid import uuid4

import pytest

from plane.bgtasks import analytic_plot_export, webhook_task
from plane.db.management.commands import test_email as test_email_command
from plane.license.api.views import configuration
from plane.license.models import InstanceConfiguration
from plane.utils.email_recipient_filters import EMAIL_RECIPIENT_FILTERS_KEY

pytestmark = pytest.mark.django_db


EMAIL_CONFIGURATION = ("smtp.example.com", "test-user", "test-password", "587", "1", "0", "from@example.com")
RECIPIENTS = ["Admin <ADMIN@AI4MS.LOCAL>", "ops.admin@ai4ms.local"]
ACCOUNT_TASKS = [
    ("forgot_password_task", "forgot_password", ("成员", RECIPIENTS[0], "uid", "token", "https://plane.example")),
    ("magic_link_code_task", "magic_link", (RECIPIENTS[0], "key", "token")),
    ("user_email_update_task", "send_email_update_magic_code", (RECIPIENTS[0], "token")),
    ("user_email_update_task", "send_email_update_confirmation", (RECIPIENTS[0],)),
    ("user_activation_email_task", "user_activation_email", ("https://plane.example", "user-id")),
    ("user_deactivation_email_task", "user_deactivation_email", ("https://plane.example", "user-id")),
    ("project_add_user_email_task", "project_add_user_email", ("https://plane.example", "member-id", "inviter-id")),
    (
        "project_invitation_task",
        "project_invitation",
        (RECIPIENTS[0], "project-id", "token", "https://plane.example", "inviter@example.com"),
    ),
    (
        "workspace_invitation_task",
        "workspace_invitation",
        (RECIPIENTS[0], "workspace-id", "token", "https://plane.example", "inviter@example.com"),
    ),
]


def mock_email_delivery(monkeypatch, module):
    """替换邮件配置和连接，使入口测试不接触 SMTP 或共享配置。

    Args:
        monkeypatch: pytest 属性替换工具。
        module: 要测试的邮件入口模块。

    Returns:
        配置读取、连接创建及 SMTP 连接的三个模拟对象。
    """
    get_configuration = MagicMock(return_value=EMAIL_CONFIGURATION)
    connection = MagicMock()
    connection.send_messages.return_value = 1
    get_connection = MagicMock(return_value=connection)
    monkeypatch.setattr(module, "get_email_configuration", get_configuration)
    monkeypatch.setattr(module, "get_connection", get_connection)
    return get_configuration, get_connection, connection


@pytest.mark.parametrize(("module_name", "task_name", "args"), ACCOUNT_TASKS)
@pytest.mark.parametrize("blocked", [True, False])
def test_account_tasks_filter_recipients_and_log_actual_outcome(
    module_name, task_name, args, blocked, monkeypatch, caplog
):
    """各账号任务共用过滤逻辑，跳过时不重试也不记录发送成功。

    Args:
        module_name: 邮件任务所在模块。
        task_name: 邮件任务名称。
        args: 任务的示例参数。
        blocked: 是否使用被屏蔽的管理员地址。
        monkeypatch: pytest 属性替换工具。
        caplog: pytest 日志捕获工具。
    """
    module = importlib.import_module(f"plane.bgtasks.{module_name}")
    email = RECIPIENTS[0] if blocked else RECIPIENTS[1]
    args = tuple(email if arg == RECIPIENTS[0] else arg for arg in args)
    _, _, connection = mock_email_delivery(monkeypatch, module)
    monkeypatch.setattr(module, "render_to_string", MagicMock(return_value="<p>邮件正文</p>"))
    error_handler = MagicMock()
    monkeypatch.setattr(module, "handle_account_email_error", error_handler)
    for model_name in ("User", "Project", "Workspace", "ProjectMemberInvite", "WorkspaceMemberInvite", "ProjectMember"):
        model = getattr(module, model_name, None)
        if model is not None:
            record = MagicMock()
            record.email = email
            record.member.email = email
            monkeypatch.setattr(model.objects, "get", MagicMock(return_value=record))

    with caplog.at_level(logging.INFO, logger="plane.worker"):
        getattr(module, task_name).run(*args)

    error_handler.assert_not_called()
    if blocked:
        connection.open.assert_not_called()
        connection.send_messages.assert_not_called()
        assert "recipient_email_blocked" in caplog.text
        assert "successfully" not in caplog.text
    else:
        connection.open.assert_called_once()
        connection.send_messages.assert_called_once()
        assert connection.send_messages.call_args.args[0][0].to == [email]
        assert "successfully" in caplog.text


@pytest.mark.parametrize("email", RECIPIENTS)
def test_export_email_filters_system_admin(email, monkeypatch):
    """导出邮件在读取发送配置前排除系统管理员地址。

    Args:
        email: 本次导出邮件的收件地址。
        monkeypatch: pytest 属性替换工具。
    """
    get_configuration, get_connection, connection = mock_email_delivery(monkeypatch, analytic_plot_export)

    analytic_plot_export.send_export_email(email, "workspace", StringIO("value\n"), [])

    if email == RECIPIENTS[0]:
        get_configuration.assert_not_called()
        get_connection.assert_not_called()
        connection.send_messages.assert_not_called()
    else:
        connection.send_messages.assert_called_once()


@pytest.mark.parametrize("email", RECIPIENTS)
def test_webhook_email_filters_system_admin(email, monkeypatch):
    """Webhook 停用邮件正确区分被屏蔽和正常的收件地址。

    Args:
        email: Webhook 通知的收件地址。
        monkeypatch: pytest 属性替换工具。
    """
    get_configuration, get_connection, connection = mock_email_delivery(monkeypatch, webhook_task)
    monkeypatch.setattr(webhook_task.User.objects, "get", MagicMock(return_value=SimpleNamespace(email=email)))
    webhook_get = MagicMock(return_value=MagicMock())
    monkeypatch.setattr(webhook_task.Webhook.objects, "get", webhook_get)

    webhook_task.send_webhook_deactivation_email.run("webhook-id", "user-id", "https://plane.example", "failed")

    if email == RECIPIENTS[0]:
        get_configuration.assert_not_called()
        get_connection.assert_not_called()
        webhook_get.assert_not_called()
        connection.send_messages.assert_not_called()
    else:
        connection.send_messages.assert_called_once()


@pytest.mark.parametrize("email", RECIPIENTS)
def test_test_email_endpoint_reports_blocked_recipient(email, monkeypatch):
    """测试邮件接口对被屏蔽的收件人返回明确错误码。

    Args:
        email: 接口接收到的测试邮件地址。
        monkeypatch: pytest 属性替换工具。
    """
    get_configuration, get_connection, connection = mock_email_delivery(monkeypatch, configuration)

    response = configuration.EmailCredentialCheckEndpoint().post(SimpleNamespace(data={"receiver_email": email}))

    if email == RECIPIENTS[0]:
        assert response.status_code == 400
        assert response.data == {"error": "recipient_email_blocked"}
        get_configuration.assert_not_called()
        get_connection.assert_not_called()
        connection.send_messages.assert_not_called()
    else:
        assert response.status_code == 200
        connection.send_messages.assert_called_once()


@pytest.mark.parametrize("email", RECIPIENTS)
def test_test_email_command_reports_suppression(email, monkeypatch):
    """命令行测试邮件明确提示跳过，避免误报发送成功。

    Args:
        email: 命令行指定的收件地址。
        monkeypatch: pytest 属性替换工具。
    """
    get_configuration, get_connection, connection = mock_email_delivery(monkeypatch, test_email_command)
    output = StringIO()

    test_email_command.Command(stdout=output).handle(to_email=email)

    if email == RECIPIENTS[0]:
        assert "收件人已屏蔽，跳过发送" in output.getvalue()
        assert "successfully" not in output.getvalue()
        get_configuration.assert_not_called()
        get_connection.assert_not_called()
        connection.send_messages.assert_not_called()
    else:
        assert "Email successfully sent" in output.getvalue()
        connection.send_messages.assert_called_once()


@pytest.mark.parametrize("entrypoint", ["account", "export", "webhook", "api", "command"])
@pytest.mark.parametrize("enabled", [True, False])
def test_saved_domain_policy_applies_to_all_email_entrypoints(entrypoint, enabled, monkeypatch):
    """独立发送入口下次检查即使用数据库域名规则，并尊重总开关。"""
    email = "member@configured.local"
    InstanceConfiguration.objects.create(
        key=EMAIL_RECIPIENT_FILTERS_KEY,
        category="SMTP",
        value=json.dumps(
            {
                "enabled": enabled,
                "rules": [
                    {"id": str(uuid4()), "type": "domain", "value": "configured.local", "note": "", "enabled": True}
                ],
            }
        ),
    )
    if entrypoint == "account":
        from django.core.mail import EmailMultiAlternatives
        from plane.utils.account_email import send_account_email

        connection = MagicMock()
        connection.send_messages.return_value = 1
        assert send_account_email(EmailMultiAlternatives(to=[email], connection=connection)) == (0 if enabled else 1)
    else:
        module = {
            "export": analytic_plot_export,
            "webhook": webhook_task,
            "api": configuration,
            "command": test_email_command,
        }[entrypoint]
        _, _, connection = mock_email_delivery(monkeypatch, module)
        if entrypoint == "export":
            analytic_plot_export.send_export_email(email, "workspace", StringIO("value\n"), [])
        elif entrypoint == "webhook":
            monkeypatch.setattr(module.User.objects, "get", MagicMock(return_value=SimpleNamespace(email=email)))
            monkeypatch.setattr(module.Webhook.objects, "get", MagicMock(return_value=MagicMock()))
            webhook_task.send_webhook_deactivation_email.run("webhook-id", "user-id", "https://plane.example", "failed")
        elif entrypoint == "api":
            response = configuration.EmailCredentialCheckEndpoint().post(
                SimpleNamespace(data={"receiver_email": email})
            )
            assert response.status_code == (400 if enabled else 200)
        else:
            test_email_command.Command(stdout=StringIO()).handle(to_email=email)
    assert connection.send_messages.call_count == (0 if enabled else 1)
