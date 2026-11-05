"""Regression tests for SMTP outcomes in account and invitation emails."""

import smtplib
from unittest.mock import MagicMock

import pytest
from django.core.mail import EmailMultiAlternatives

from plane.utils.account_email import (
    AccountEmailDeliveryError,
    handle_account_email_error,
    send_account_email,
)

pytestmark = pytest.mark.django_db


def make_email_message():
    """Create a minimal email double with a separate SMTP connection double."""
    message = EmailMultiAlternatives(to=["member@example.com"], connection=MagicMock())
    message.send = MagicMock(return_value=1)
    return message


@pytest.mark.parametrize("field", ["to", "cc", "bcc"])
def test_blocked_account_email_is_skipped_without_smtp_or_retry(field, monkeypatch):
    """账号邮件仅有被屏蔽收件人时，直接结束且不建立 SMTP 连接。

    Args:
        field: 被屏蔽地址所在的收件人列表。
        monkeypatch: pytest 属性替换工具。
    """
    message = make_email_message()
    message.to = []
    setattr(message, field, ["Admin <ADMIN@AI4MS.LOCAL>"])
    task = MagicMock()
    monkeypatch.setattr("plane.utils.account_email.current_task", task)

    assert send_account_email(message) == 0
    assert message.recipients() == []
    message.connection.open.assert_not_called()
    message.connection.close.assert_not_called()
    message.send.assert_not_called()
    task.retry.assert_not_called()


def test_mixed_account_email_sends_only_to_allowed_recipients():
    """账号邮件移除被屏蔽地址后仍向其余收件人正常发送。"""
    message = make_email_message()
    message.to = ["admin@ai4ms.local"]
    message.cc = ["ops.admin@ai4ms.local"]
    message.bcc = ["Admin <ADMIN@AI4MS.LOCAL>", "member@example.com"]

    assert send_account_email(message) == 1
    assert message.recipients() == ["ops.admin@ai4ms.local", "member@example.com"]
    message.connection.open.assert_called_once()
    message.send.assert_called_once()
    message.connection.close.assert_called_once()


def test_connection_failure_is_retryable_before_submission():
    """An SMTP connect failure is known to happen before message submission."""
    message = make_email_message()
    message.connection.open.side_effect = smtplib.SMTPConnectError(421, b"try again")

    with pytest.raises(AccountEmailDeliveryError) as error:
        send_account_email(message)

    assert error.value.code == "smtp_connection_failed"
    assert error.value.retryable is True
    message.send.assert_not_called()
    message.connection.close.assert_called_once()


def test_temporary_smtp_rejection_is_retryable():
    """A temporary SMTP response confirms that the server rejected the message."""
    message = make_email_message()
    message.send.side_effect = smtplib.SMTPDataError(451, b"try again")

    with pytest.raises(AccountEmailDeliveryError) as error:
        send_account_email(message)

    assert error.value.code == "smtp_temporary_rejection"
    assert error.value.retryable is True
    message.connection.close.assert_called_once()


def test_zero_acceptance_count_is_retryable_before_submission():
    """A backend returning zero accepted recipients cannot be logged as sent."""
    message = make_email_message()
    message.send.return_value = 0

    with pytest.raises(AccountEmailDeliveryError) as error:
        send_account_email(message)

    assert error.value.code == "smtp_no_recipient_accepted"
    assert error.value.retryable is True


def test_authentication_and_permanent_rejection_are_not_retryable():
    """Configuration errors and permanent SMTP refusals do not cause retry storms."""
    for exception, expected_code in (
        (smtplib.SMTPAuthenticationError(535, b"denied"), "smtp_authentication_failed"),
        (smtplib.SMTPDataError(550, b"rejected"), "smtp_message_rejected"),
    ):
        message = make_email_message()
        if isinstance(exception, smtplib.SMTPAuthenticationError):
            message.connection.open.side_effect = exception
        else:
            message.send.side_effect = exception

        with pytest.raises(AccountEmailDeliveryError) as error:
            send_account_email(message)

        assert error.value.code == expected_code
        assert error.value.retryable is False


def test_disconnect_after_submission_starts_is_not_retried():
    """A lost connection during send may follow SMTP acceptance, so it stays uncertain."""
    message = make_email_message()
    message.send.side_effect = smtplib.SMTPServerDisconnected("connection closed")

    with pytest.raises(AccountEmailDeliveryError) as error:
        send_account_email(message)

    assert error.value.code == "smtp_submission_result_unknown"
    assert error.value.retryable is False


def test_notification_tasks_route_to_dedicated_queues():
    """Outbox generation and notification email tasks have dedicated consumers."""
    from plane.celery import app

    routes = app.conf.task_routes

    assert routes["plane.bgtasks.issue_activities_task.process_notification_generation_outbox"]["queue"] == (
        "notification-generation"
    )
    assert routes["plane.bgtasks.email_notification_task.*"]["queue"] == "notification-email"


def test_retryable_error_uses_bounded_celery_retry(monkeypatch):
    """Known pre-acceptance failures use the first bounded retry delay."""
    error = AccountEmailDeliveryError("smtp_connection_failed", retryable=True)
    task = MagicMock()
    task.request.id = "task-id"
    task.request.retries = 0
    task.retry.side_effect = RuntimeError("retry scheduled")
    monkeypatch.setattr("plane.utils.account_email.current_task", task)

    with pytest.raises(RuntimeError, match="retry scheduled"):
        handle_account_email_error(error)

    task.retry.assert_called_once_with(exc=error, countdown=60)


def test_permanent_account_email_error_surfaces_as_failed_task():
    """Permanent SMTP failures remain visible in Celery task state."""
    error = AccountEmailDeliveryError("smtp_authentication_failed")

    with pytest.raises(AccountEmailDeliveryError, match="smtp_authentication_failed"):
        handle_account_email_error(error)
