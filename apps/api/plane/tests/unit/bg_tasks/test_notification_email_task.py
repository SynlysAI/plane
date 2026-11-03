"""Regression tests for durable notification email delivery."""

import smtplib
from io import StringIO
from unittest.mock import patch
from uuid import uuid4

import pytest
from django.core.management import call_command
from django.test import override_settings
from django.utils import timezone

from plane.bgtasks.email_notification_task import (
    _lease_and_enqueue_research_email_notifications,
    _smtp_error_details,
    _smtp_failure,
    _update_email_log_state,
    stack_email_notification,
)
from plane.db.models import (
    EmailNotificationLog,
    NotificationEmailDelivery,
    NotificationEvent,
)


def test_smtp_error_details_extracts_recipient_refusal():
    """Recipient refusal responses retain their SMTP status for classification."""
    error = smtplib.SMTPRecipientsRefused(
        {"member@example.com": (550, b"User has no permission")}
    )

    code, message = _smtp_error_details(error)

    assert code == 550
    assert "user has no permission" in message


@pytest.mark.django_db
def test_research_delivery_scanner_enqueues_every_recipient_entity_group(workspace, create_user):
    """Successful enqueueing continues across every recipient and entity group."""
    receiver = create_user
    events = [
        NotificationEvent.objects.create(
            idempotency_key=f"research-scan-{uuid4()}",
            workspace=workspace,
            receiver=receiver,
            entity_name="research_report",
            entity_identifier=uuid4(),
            action="returned",
            category=NotificationEvent.Category.RESEARCH_STATE_CHANGE,
            title="Report returned",
        )
        for _ in range(2)
    ]
    for event in events:
        NotificationEmailDelivery.objects.create(
            event=event,
            status=NotificationEmailDelivery.Status.PENDING,
            available_at=timezone.now(),
        )

    with patch("plane.bgtasks.email_notification_task.send_research_notification_email.delay") as enqueue:
        queued = _lease_and_enqueue_research_email_notifications()

    assert queued == 2
    assert enqueue.call_count == 2


@pytest.mark.django_db
def test_disabling_notification_email_delivery_keeps_pending_rows(workspace, create_user):
    """The delivery kill switch leaves queued notification records untouched."""
    event = NotificationEvent.objects.create(
        idempotency_key=f"paused-{uuid4()}",
        workspace=workspace,
        receiver=create_user,
        entity_name="issue",
        entity_identifier=uuid4(),
        action="updated",
        category=NotificationEvent.Category.PROPERTY_CHANGE,
        title="Issue updated",
    )
    log = EmailNotificationLog.objects.create(
        receiver=create_user,
        triggered_by=create_user,
        entity_identifier=event.entity_identifier,
        entity_name="issue",
        data={},
        entity="issue",
    )
    delivery = NotificationEmailDelivery.objects.create(
        event=event,
        source_log=log,
        status=NotificationEmailDelivery.Status.PENDING,
        available_at=timezone.now(),
    )

    with override_settings(NOTIFICATION_EMAIL_DELIVERY_ENABLED=False):
        with patch("plane.bgtasks.email_notification_task.send_email_notification.delay") as enqueue:
            assert stack_email_notification.run() == 0

    delivery.refresh_from_db()
    log.refresh_from_db()
    assert delivery.status == NotificationEmailDelivery.Status.PENDING
    assert log.delivery_status == EmailNotificationLog.DeliveryStatus.PENDING
    enqueue.assert_not_called()


@pytest.mark.django_db
def test_expired_task_cannot_update_a_reclaimed_delivery(workspace, create_user):
    """A task with an old lease token cannot overwrite the current delivery state."""
    event = NotificationEvent.objects.create(
        idempotency_key=f"test-{uuid4()}",
        workspace=workspace,
        receiver=create_user,
        entity_name="issue",
        entity_identifier=uuid4(),
        action="updated",
        category=NotificationEvent.Category.PROPERTY_CHANGE,
        title="Updated issue",
    )
    log = EmailNotificationLog.objects.create(
        receiver=create_user,
        triggered_by=create_user,
        entity_identifier=event.entity_identifier,
        entity_name="issue",
        data={},
        entity="issue",
    )
    delivery = NotificationEmailDelivery.objects.create(
        event=event,
        source_log=log,
        status=NotificationEmailDelivery.Status.PROCESSING,
        available_at=timezone.now(),
        lease_until=timezone.now(),
        lease_token="new-lease-token",
    )

    updated = _update_email_log_state(
        [log.pk],
        EmailNotificationLog.DeliveryStatus.ACCEPTED,
        lease_token="expired-lease-token",
    )

    delivery.refresh_from_db()
    log.refresh_from_db()
    assert updated == 0
    assert delivery.status == NotificationEmailDelivery.Status.PROCESSING
    assert delivery.lease_token == "new-lease-token"
    assert log.delivery_status == EmailNotificationLog.DeliveryStatus.PENDING


@pytest.mark.django_db
def test_550_permission_error_is_retried_and_stored_as_a_safe_code(workspace, create_user):
    """The SMTP permission failure is diagnosable without persisting response text."""
    event = NotificationEvent.objects.create(
        idempotency_key=f"smtp-{uuid4()}",
        workspace=workspace,
        receiver=create_user,
        entity_name="issue",
        entity_identifier=uuid4(),
        action="assigned",
        category=NotificationEvent.Category.ASSIGNMENT,
        title="Issue assigned",
    )
    log = EmailNotificationLog.objects.create(
        receiver=create_user,
        triggered_by=create_user,
        entity_identifier=event.entity_identifier,
        entity_name="issue",
        data={},
        entity="issue",
        delivery_status=EmailNotificationLog.DeliveryStatus.UNCERTAIN,
    )
    delivery = NotificationEmailDelivery.objects.create(
        event=event,
        source_log=log,
        status=NotificationEmailDelivery.Status.UNCERTAIN,
        available_at=timezone.now(),
        lease_token="current-token",
    )
    error = smtplib.SMTPRecipientsRefused({"member@example.com": (550, b"User has no permission")})

    with patch("plane.bgtasks.email_notification_task._open_smtp_circuit"):
        _smtp_failure([log.pk], error, lease_token="current-token")

    delivery.refresh_from_db()
    log.refresh_from_db()
    assert delivery.status == NotificationEmailDelivery.Status.RETRY
    assert delivery.last_error_code == "smtp_550"
    assert "permission" not in delivery.last_error_code
    assert log.delivery_status == EmailNotificationLog.DeliveryStatus.RETRY


@pytest.mark.django_db
def test_manual_retry_requires_failed_state_and_records_operator_audit(
    workspace, create_user, django_capture_on_commit_callbacks
):
    """A staff operator can retry a failed delivery with a durable reason record."""
    from plane.db.models import NotificationDeliveryAudit

    create_user.is_staff = True
    create_user.save(update_fields=["is_staff"])
    event = NotificationEvent.objects.create(
        idempotency_key=f"retry-{uuid4()}",
        workspace=workspace,
        receiver=create_user,
        entity_name="research_report",
        entity_identifier=uuid4(),
        action="returned",
        category=NotificationEvent.Category.RESEARCH_STATE_CHANGE,
        title="Report returned",
    )
    delivery = NotificationEmailDelivery.objects.create(
        event=event,
        status=NotificationEmailDelivery.Status.FAILED,
        available_at=timezone.now(),
        last_error_code="smtp_550",
    )

    with patch("plane.db.management.commands.retry_notification_delivery.stack_email_notification.delay") as enqueue:
        with django_capture_on_commit_callbacks(execute=True):
            call_command(
                "retry_notification_delivery",
                delivery_id=str(delivery.pk),
                actor_id=str(create_user.pk),
                reason="SMTP sender permission corrected",
                stdout=StringIO(),
            )

    delivery.refresh_from_db()
    assert delivery.status == NotificationEmailDelivery.Status.PENDING
    audit = NotificationDeliveryAudit.objects.get(delivery_identifier=delivery.pk)
    assert audit.workspace_id == workspace.pk
    assert audit.previous_status == NotificationEmailDelivery.Status.FAILED
    assert audit.new_status == NotificationEmailDelivery.Status.PENDING
    assert audit.reason == "SMTP sender permission corrected"
    enqueue.assert_called_once_with()
