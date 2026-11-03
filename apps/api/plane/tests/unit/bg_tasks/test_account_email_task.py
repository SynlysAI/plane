"""Regression tests for SMTP outcomes in account and invitation emails."""

import smtplib
from unittest.mock import MagicMock

import pytest

from plane.utils.account_email import (
    AccountEmailDeliveryError,
    handle_account_email_error,
    send_account_email,
)


def make_email_message():
    """Create a minimal email double with a separate SMTP connection double."""
    message = MagicMock()
    message.connection = MagicMock()
    return message


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

