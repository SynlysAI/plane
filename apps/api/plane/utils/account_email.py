"""Shared SMTP error handling for account and invitation email tasks."""

import logging
import smtplib
import socket

from celery import current_task

from plane.utils.exception_logger import log_exception

logger = logging.getLogger("plane.worker")


class AccountEmailDeliveryError(Exception):
    """Represent an account-email failure without retaining SMTP response text."""

    def __init__(self, code, *, retryable=False):
        """Initialize the safe error code and whether SMTP confirmed rejection.

        Args:
            code: Stable diagnostic code without raw server response text.
            retryable: Whether the failure happened before message acceptance.
        """
        super().__init__(code)
        self.code = code
        self.retryable = retryable


def send_account_email(message):
    """Send one account email and classify SMTP errors by submission certainty.

    Args:
        message: A configured Django ``EmailMessage`` instance.

    Returns:
        The number of messages accepted by the configured SMTP backend.
    """
    connection = message.connection
    try:
        try:
            connection.open()
        except smtplib.SMTPAuthenticationError as error:
            raise AccountEmailDeliveryError("smtp_authentication_failed") from error
        except (
            smtplib.SMTPConnectError,
            smtplib.SMTPServerDisconnected,
            OSError,
            socket.timeout,
            TimeoutError,
        ) as error:
            raise AccountEmailDeliveryError("smtp_connection_failed", retryable=True) from error

        return message.send()
    except smtplib.SMTPAuthenticationError as error:
        raise AccountEmailDeliveryError("smtp_authentication_failed") from error
    except smtplib.SMTPRecipientsRefused as error:
        codes = [response[0] for response in error.recipients.values()]
        retryable = bool(codes) and all(400 <= code < 500 for code in codes)
        code = "smtp_temporary_recipient_rejection" if retryable else "smtp_recipient_rejected"
        raise AccountEmailDeliveryError(code, retryable=retryable) from error
    except smtplib.SMTPResponseException as error:
        retryable = 400 <= error.smtp_code < 500
        code = "smtp_temporary_rejection" if retryable else "smtp_message_rejected"
        raise AccountEmailDeliveryError(code, retryable=retryable) from error
    except (smtplib.SMTPServerDisconnected, OSError, socket.timeout, TimeoutError) as error:
        raise AccountEmailDeliveryError("smtp_submission_result_unknown") from error
    finally:
        try:
            connection.close()
        except Exception:
            logger.debug("Failed to close account-email SMTP connection", exc_info=True)


def handle_account_email_error(error):
    """Log account-email failures safely and retry only known pre-acceptance errors.

    Args:
        error: The exception raised while preparing or sending an account email.
    """
    if not isinstance(error, AccountEmailDeliveryError):
        log_exception(error)
        return

    if error.retryable:
        retries = getattr(getattr(current_task, "request", None), "retries", 0)
        task_id = getattr(getattr(current_task, "request", None), "id", None)
        if task_id and retries < 2:
            retry_delays = (60, 300)
            raise current_task.retry(exc=error, countdown=retry_delays[retries])
        logger.error("Account email delivery exhausted retries: %s", error.code)
        raise error

    logger.error("Account email delivery failed: %s", error.code)
    raise error
