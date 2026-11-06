# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

import logging
import re
import smtplib
import uuid
from collections import defaultdict
from datetime import timedelta

from bs4 import BeautifulSoup

# Third party imports
from celery import shared_task
from django.conf import settings
from django.core.mail import EmailMultiAlternatives, get_connection
from django.db import transaction
from django.db.models import Case, F, When
from django.template.loader import render_to_string

# Django imports
from django.utils import timezone
from django.utils.dateparse import parse_datetime

# Module imports
from plane.db.models import (
    EmailNotificationLog,
    Issue,
    NotificationEmailCircuit,
    NotificationEmailDelivery,
    NotificationEvent,
    User,
    UserNotificationPreference,
    WorkspaceNotificationPolicy,
)
from plane.db.models.research.task import ResearchChainNodeTask
from plane.license.utils.instance_value import get_email_configuration
from plane.utils.administrative_projects import project_member_roster
from plane.utils.email import is_email_recipient_blocked
from plane.utils.email_recipient_filters import EmailRecipientFilterConfigurationError
from plane.utils.notification_outbox import issue_notification_category
from plane.utils.assignment_transfer import assignment_transfer_email_context

MAX_EMAIL_DELIVERY_ATTEMPTS = 6
EMAIL_DELIVERY_MAX_AGE = timedelta(hours=24)
EMAIL_DELIVERY_RETRY_DELAYS = (1, 5, 15, 60, 360)


def remove_unwanted_characters(input_text):
    # Remove only control characters and potentially problematic characters for email subjects
    processed_text = re.sub(r"[\x00-\x1F\x7F-\x9F]", "", input_text)
    return processed_text


def _notification_email_delivery_enabled():
    """Return whether durable notification email delivery is enabled."""
    return bool(getattr(settings, "NOTIFICATION_EMAIL_DELIVERY_ENABLED", True))


def _delivery_row_exhausted(attempts, created_at, now):
    """Decide whether an already-recorded delivery attempt exhausted its budget.

    Args:
        attempts: Attempts already recorded before this requeue.
        created_at: Delivery creation time.
        now: Current aware timestamp.

    Returns:
        True when the recorded attempts reached the cap or the age window.
    """
    return attempts >= MAX_EMAIL_DELIVERY_ATTEMPTS or now - created_at >= EMAIL_DELIVERY_MAX_AGE


def _bounded_next_attempt_count():
    """Increment a retry count without crossing the configured maximum."""
    return Case(
        When(attempts__lt=MAX_EMAIL_DELIVERY_ATTEMPTS, then=F("attempts") + 1),
        default=MAX_EMAIL_DELIVERY_ATTEMPTS,
    )


def _recover_expired_delivery_claims(queryset, *, now, source_logs=False):
    """Fence expired worker claims and apply the bounded retry budget.

    Args:
        queryset: Expired processing deliveries to recover.
        now: Current aware timestamp.
        source_logs: Whether matching issue source logs should be updated.
    """
    rows = list(
        queryset.select_for_update(skip_locked=True).values(
            "id",
            "source_log_id",
            "attempts",
            "created_at",
        )
    )
    retry_ids = []
    failed_ids = []
    retry_log_ids = []
    failed_log_ids = []
    for row in rows:
        if _delivery_row_exhausted(row["attempts"], row["created_at"], now):
            failed_ids.append(row["id"])
            if row["source_log_id"]:
                failed_log_ids.append(row["source_log_id"])
        else:
            retry_ids.append(row["id"])
            if row["source_log_id"]:
                retry_log_ids.append(row["source_log_id"])

    if retry_ids:
        NotificationEmailDelivery.objects.filter(pk__in=retry_ids).update(
            status=NotificationEmailDelivery.Status.RETRY,
            available_at=now,
            lease_until=None,
            lease_token="",
            attempts=F("attempts") + 1,
            last_error_code="delivery_lease_expired",
            last_error_at=now,
            updated_at=now,
        )
    if failed_ids:
        NotificationEmailDelivery.objects.filter(pk__in=failed_ids).update(
            status=NotificationEmailDelivery.Status.FAILED,
            available_at=now,
            lease_until=None,
            lease_token="",
            attempts=_bounded_next_attempt_count(),
            last_error_code="delivery_lease_expired",
            last_error_at=now,
            updated_at=now,
        )
    if source_logs:
        if retry_log_ids:
            EmailNotificationLog.objects.filter(pk__in=retry_log_ids).update(
                delivery_status=EmailNotificationLog.DeliveryStatus.RETRY,
                available_at=now,
                lease_until=None,
                attempts=F("attempts") + 1,
                last_error_code="delivery_lease_expired",
                updated_at=now,
            )
        if failed_log_ids:
            EmailNotificationLog.objects.filter(pk__in=failed_log_ids).update(
                delivery_status=EmailNotificationLog.DeliveryStatus.FAILED,
                available_at=now,
                processed_at=now,
                lease_until=None,
                attempts=_bounded_next_attempt_count(),
                last_error_code="delivery_lease_expired",
                updated_at=now,
            )


def _mark_queue_publish_failed(delivery_ids, lease_token, *, now):
    """Bounded-requeue deliveries whose Celery publish failed after claiming.

    Args:
        delivery_ids: Delivery rows claimed by the current scanner.
        lease_token: Lease token owned by the current scanner.
        now: Current aware timestamp.
    """
    with transaction.atomic():
        rows = list(
            NotificationEmailDelivery.objects.select_for_update()
            .filter(
                pk__in=delivery_ids,
                status=NotificationEmailDelivery.Status.PROCESSING,
                lease_token=lease_token,
            )
            .values("id", "source_log_id", "attempts", "created_at")
        )
        retry_ids = []
        failed_ids = []
        retry_log_ids = []
        failed_log_ids = []
        for row in rows:
            if _delivery_row_exhausted(row["attempts"] + 1, row["created_at"], now):
                failed_ids.append(row["id"])
                if row["source_log_id"]:
                    failed_log_ids.append(row["source_log_id"])
            else:
                retry_ids.append(row["id"])
                if row["source_log_id"]:
                    retry_log_ids.append(row["source_log_id"])

        available_at = now + timedelta(minutes=1)
        common_delivery = {
            "available_at": available_at,
            "lease_until": None,
            "lease_token": "",
            "attempts": _bounded_next_attempt_count(),
            "last_error_code": "queue_publish_failed",
            "last_error_at": now,
            "updated_at": now,
        }
        if retry_ids:
            NotificationEmailDelivery.objects.filter(pk__in=retry_ids).update(
                status=NotificationEmailDelivery.Status.RETRY,
                **common_delivery,
            )
        if failed_ids:
            NotificationEmailDelivery.objects.filter(pk__in=failed_ids).update(
                status=NotificationEmailDelivery.Status.FAILED,
                available_at=now,
                **{key: value for key, value in common_delivery.items() if key != "available_at"},
            )
        common_log = {
            "available_at": available_at,
            "lease_until": None,
            "attempts": F("attempts") + 1,
            "last_error_code": "queue_publish_failed",
            "updated_at": now,
        }
        if retry_log_ids:
            EmailNotificationLog.objects.filter(pk__in=retry_log_ids).update(
                delivery_status=EmailNotificationLog.DeliveryStatus.RETRY,
                **common_log,
            )
        if failed_log_ids:
            EmailNotificationLog.objects.filter(pk__in=failed_log_ids).update(
                delivery_status=EmailNotificationLog.DeliveryStatus.FAILED,
                available_at=now,
                processed_at=now,
                **{key: value for key, value in common_log.items() if key != "available_at"},
            )


def _lease_and_enqueue_email_notifications():
    """Lease at most 100 durable email deliveries and enqueue by receiver and issue."""
    now = timezone.now()
    lease_until = now + timedelta(minutes=5)
    with transaction.atomic():
        _recover_expired_delivery_claims(
            NotificationEmailDelivery.objects.filter(
                status=NotificationEmailDelivery.Status.PROCESSING,
                source_log__isnull=False,
                lease_until__lte=now,
            ),
            now=now,
            source_logs=True,
        )
        deliveries = list(
            NotificationEmailDelivery.objects.select_for_update(skip_locked=True)
            .select_related("source_log")
            .filter(
                status__in=(
                    NotificationEmailDelivery.Status.PENDING,
                    NotificationEmailDelivery.Status.RETRY,
                ),
                available_at__lte=now,
                source_log__entity_name="issue",
                source_log__entity_identifier__isnull=False,
            )
            .order_by("created_at")[:100]
        )
        if not deliveries:
            return 0
        delivery_ids = [row.pk for row in deliveries]
        log_ids = [row.source_log_id for row in deliveries]
        lease_token = uuid.uuid4().hex
        NotificationEmailDelivery.objects.filter(pk__in=delivery_ids).update(
            status=NotificationEmailDelivery.Status.PROCESSING,
            lease_until=lease_until,
            lease_token=lease_token,
        )
        EmailNotificationLog.objects.filter(pk__in=log_ids).update(
            delivery_status=EmailNotificationLog.DeliveryStatus.PROCESSING,
            lease_until=lease_until,
        )

    grouped = defaultdict(list)
    delivery_by_log_id = {row.source_log_id: row.pk for row in deliveries}
    for row in (delivery.source_log for delivery in deliveries):
        grouped[(str(row.receiver_id), str(row.entity_identifier))].append(row)

    queued_count = 0
    for (receiver_id, issue_id), batch in grouped.items():
        notification_data = defaultdict(list)
        for row in batch:
            notification_data[str(row.triggered_by_id)].append(row.data or {})
        ids = [row.pk for row in batch]
        try:
            send_email_notification.delay(
                issue_id=issue_id,
                notification_data=dict(notification_data),
                receiver_id=receiver_id,
                email_notification_ids=ids,
                lease_token=lease_token,
            )
            queued_count += len(ids)
        except Exception as exc:
            claimed_delivery_ids = [delivery_by_log_id[log_id] for log_id in ids]
            _mark_queue_publish_failed(claimed_delivery_ids, lease_token, now=now)
            logging.getLogger("plane.worker").exception("Failed to enqueue notification email", exc_info=exc)
    return queued_count


@shared_task
def stack_email_notification():
    if not _notification_email_delivery_enabled():
        return 0
    issue_count = _lease_and_enqueue_email_notifications()
    research_count = _lease_and_enqueue_research_email_notifications()
    return issue_count + research_count


def _lease_and_enqueue_research_email_notifications():
    """Lease and enqueue due research emails independently from issue digests."""
    now = timezone.now()
    lease_until = now + timedelta(minutes=5)
    with transaction.atomic():
        _recover_expired_delivery_claims(
            NotificationEmailDelivery.objects.filter(
                status=NotificationEmailDelivery.Status.PROCESSING,
                source_log__isnull=True,
                event__entity_name__startswith="research_",
                lease_until__lte=now,
            ),
            now=now,
        )
        deliveries = list(
            NotificationEmailDelivery.objects.select_for_update(skip_locked=True)
            .select_related("event")
            .filter(
                status__in=(NotificationEmailDelivery.Status.PENDING, NotificationEmailDelivery.Status.RETRY),
                source_log__isnull=True,
                event__entity_name__startswith="research_",
                available_at__lte=now,
            )
            .order_by("created_at")[:100]
        )
        if not deliveries:
            return 0
        lease_token = uuid.uuid4().hex
        delivery_ids = [delivery.pk for delivery in deliveries]
        NotificationEmailDelivery.objects.filter(pk__in=delivery_ids).update(
            status=NotificationEmailDelivery.Status.PROCESSING,
            lease_until=lease_until,
            lease_token=lease_token,
        )

    grouped = defaultdict(list)
    for delivery in deliveries:
        event = delivery.event
        grouped[(str(event.receiver_id), event.entity_name, str(event.entity_identifier))].append(delivery.pk)

    queued_count = 0
    for (_receiver_id, _entity_name, _entity_id), ids in grouped.items():
        try:
            send_research_notification_email.delay(delivery_ids=ids, lease_token=lease_token)
            queued_count += len(ids)
        except Exception as exc:
            _mark_queue_publish_failed(ids, lease_token, now=now)
            logging.getLogger("plane.worker").exception("Failed to enqueue research notification email", exc_info=exc)
    return queued_count


def create_payload(notification_data):
    # return format {"actor_id":  { "key": { "old_value": [], "new_value": [] } }}
    data = {}
    for actor_id, changes in notification_data.items():
        for change in changes:
            issue_activity = change.get("issue_activity")
            if issue_activity:  # Ensure issue_activity is not None
                field = issue_activity.get("field")
                old_value = str(issue_activity.get("old_value"))
                new_value = str(issue_activity.get("new_value"))

                # Append old_value if it's not empty and not already in the list
                if old_value:
                    (
                        data.setdefault(actor_id, {})
                        .setdefault(field, {})
                        .setdefault("old_value", [])
                        .append(old_value)
                        if old_value not in data.setdefault(actor_id, {}).setdefault(field, {}).get("old_value", [])
                        else None
                    )

                # Append new_value if it's not empty and not already in the list
                if new_value:
                    (
                        data.setdefault(actor_id, {})
                        .setdefault(field, {})
                        .setdefault("new_value", [])
                        .append(new_value)
                        if new_value not in data.setdefault(actor_id, {}).setdefault(field, {}).get("new_value", [])
                        else None
                    )

                actor_data = data.setdefault(actor_id, {})
                if not actor_data.get("activity_time"):
                    actor_data["activity_time"] = issue_activity.get("activity_time") or timezone.now().isoformat()

    return data


def process_mention(mention_component):
    soup = BeautifulSoup(mention_component, "html.parser")
    mentions = soup.find_all("mention-component")
    for mention in mentions:
        user_id = mention["entity_identifier"]
        user = User.objects.filter(pk=user_id).only("id", "first_name", "last_name", "username").first()
        user_name = user.display_name if user else "已删除用户"
        highlighted_name = f"@{user_name}"
        mention.replace_with(highlighted_name)
    return str(soup)


def process_html_content(content):
    if content is None:
        return None
    processed_content_list = []
    for html_content in content:
        processed_content = process_mention(html_content)
        processed_content_list.append(processed_content)
    return processed_content_list


def _display_value(value):
    """Convert an email activity value to a concise localized string."""
    if value is None:
        return ""
    if isinstance(value, (list, tuple, set)):
        return "、".join(str(item) for item in value if str(item) not in {"", "None"})
    return "" if value in {None, "", "None"} else str(value)


def _issue_change_rows(data):
    """Normalize grouped issue changes into template-ready rows.

    Args:
        data: Actor-keyed activity data produced by ``create_payload``.

    Returns:
        Flat rows containing actor, time, field label, old value, and new value.
    """
    labels = {
        "name": "名称",
        "priority": "优先级",
        "state": "状态",
        "assignees": "负责人",
        "labels": "标签",
        "start_date": "开始日期",
        "target_date": "截止日期",
        "estimate": "估算",
    }
    rows = []
    for actor_id, changes in data.items():
        actor = User.objects.filter(pk=actor_id).only("id", "first_name", "last_name", "display_name", "email").first()
        actor_name = actor.display_name if actor else "已删除用户"
        activity_time = changes.get("activity_time")
        parsed = parse_datetime(str(activity_time)) if activity_time else None
        if parsed is None:
            parsed = timezone.now()
        formatted_time = timezone.localtime(parsed).strftime("%m-%d %H:%M")
        for field, change in changes.items():
            if field == "activity_time" or not isinstance(change, dict):
                continue
            rows.append(
                {
                    "actor_name": actor_name,
                    "activity_time": formatted_time,
                    "field_label": labels.get(field, field),
                    "old_value": _display_value(change.get("old_value")),
                    "new_value": _display_value(change.get("new_value")),
                }
            )
    return rows


def _assignment_transfer_context(entity_type, entity, receiver, base_url):
    """Build the transfer block only when email actions are enabled."""
    if not getattr(settings, "NOTIFICATION_ASSIGNMENT_TRANSFER_EMAIL_ENABLED", True):
        return {}
    return assignment_transfer_email_context(entity_type, entity, receiver, base_url)


def audit_email_image_resources(html_content):
    """Reject rendered email HTML that contains fragile image resources.

    Args:
        html_content: Rendered notification HTML.

    Raises:
        ValueError: When an image source is empty, relative, external S3, or non-image.
    """
    soup = BeautifulSoup(html_content, "html.parser")
    for image in soup.find_all("img"):
        source = (image.get("src") or "").strip()
        if not source:
            raise ValueError("email image src is empty")
        if source.startswith("/"):
            raise ValueError("email image src is relative")
        if "plane-marketing.s3" in source:
            raise ValueError("email uses an external Plane marketing image")
        if not source.lower().split("?", 1)[0].endswith((".png", ".jpg", ".jpeg", ".gif", ".webp")):
            raise ValueError("email image src does not point to an image asset")


def _claim_smtp_probe():
    """Claim the single database lease allowed to probe an open SMTP circuit."""
    now = timezone.now()
    with transaction.atomic():
        circuit, _ = NotificationEmailCircuit.objects.get_or_create(key="smtp")
        circuit = NotificationEmailCircuit.objects.select_for_update().get(pk=circuit.pk)
        if circuit.opened_at is None:
            return True, None, None
        if circuit.next_probe_at and circuit.next_probe_at > now:
            return False, None, circuit.next_probe_at - now
        if circuit.probe_lease_until and circuit.probe_lease_until > now:
            return False, None, circuit.probe_lease_until - now

        lease_token = uuid.uuid4().hex
        NotificationEmailCircuit.objects.filter(pk=circuit.pk).update(
            probe_lease_token=lease_token,
            probe_lease_until=now + timedelta(minutes=2),
        )
        return True, lease_token, None


def _open_smtp_circuit(reason_code, *, retry_after=timedelta(minutes=15)):
    """Open or extend the shared SMTP circuit after a service-level failure."""
    now = timezone.now()
    NotificationEmailCircuit.objects.update_or_create(
        key="smtp",
        defaults={
            "opened_at": now,
            "reason_code": reason_code,
            "next_probe_at": now + retry_after,
            "probe_lease_until": None,
            "probe_lease_token": "",
        },
    )


def _clear_smtp_circuit_probe(probe_token):
    """Close the circuit only when the caller owns the active probe lease."""
    if probe_token:
        NotificationEmailCircuit.objects.filter(
            key="smtp",
            probe_lease_token=probe_token,
        ).update(
            opened_at=None,
            reason_code="",
            next_probe_at=None,
            probe_lease_until=None,
            probe_lease_token="",
        )


def _owned_issue_deliveries(notification_ids, lease_token):
    """Return only processing rows fenced by this task's current lease token."""
    if not lease_token:
        return NotificationEmailDelivery.objects.none()
    return NotificationEmailDelivery.objects.filter(
        source_log_id__in=notification_ids,
        lease_token=lease_token,
        status__in=(
            NotificationEmailDelivery.Status.PROCESSING,
            NotificationEmailDelivery.Status.UNCERTAIN,
        ),
    )


def _update_email_log_state(
    notification_ids,
    status,
    *,
    lease_token,
    now=None,
    error_code="",
    available_at=None,
):
    """Update only the frozen batch still owned by the caller's lease."""
    now = now or timezone.now()
    with transaction.atomic():
        deliveries = list(_owned_issue_deliveries(notification_ids, lease_token).select_for_update())
        owned_log_ids = [row.source_log_id for row in deliveries]
        if not owned_log_ids:
            return 0
        EmailNotificationLog.objects.filter(
            pk__in=owned_log_ids,
            delivery_status__in=(
                EmailNotificationLog.DeliveryStatus.PROCESSING,
                EmailNotificationLog.DeliveryStatus.UNCERTAIN,
            ),
        ).update(
            delivery_status=status,
            processed_at=now
            if status
            in (
                EmailNotificationLog.DeliveryStatus.ACCEPTED,
                EmailNotificationLog.DeliveryStatus.SUPPRESSED,
                EmailNotificationLog.DeliveryStatus.FAILED,
            )
            else None,
            sent_at=now if status == EmailNotificationLog.DeliveryStatus.ACCEPTED else None,
            lease_until=None,
            available_at=available_at or now,
            last_error_code=error_code,
        )
        delivery_updates = {
            "status": status,
            "lease_until": None,
            "lease_token": "",
            "available_at": available_at or now,
            "last_error_code": error_code,
        }
        if status == EmailNotificationLog.DeliveryStatus.ACCEPTED:
            delivery_updates["smtp_accepted_at"] = now
        if error_code:
            delivery_updates["last_error_at"] = now
        return _owned_issue_deliveries(notification_ids, lease_token).update(**delivery_updates)


def _retry_email_batch(notification_ids, error_code, *, lease_token, retry_after=None):
    """Schedule known unaccepted mail failures or close exhausted records."""
    now = timezone.now()
    with transaction.atomic():
        deliveries = list(_owned_issue_deliveries(notification_ids, lease_token).select_for_update())
        for delivery in deliveries:
            row = EmailNotificationLog.objects.filter(pk=delivery.source_log_id).first()
            if row is None:
                continue
            age = now - row.created_at
            if delivery.attempts >= MAX_EMAIL_DELIVERY_ATTEMPTS or age >= EMAIL_DELIVERY_MAX_AGE:
                next_attempt = now
                status = EmailNotificationLog.DeliveryStatus.FAILED
            elif retry_after is not None:
                next_attempt = now + retry_after
                status = EmailNotificationLog.DeliveryStatus.RETRY
            else:
                delay_index = max(0, min(delivery.attempts - 1, len(EMAIL_DELIVERY_RETRY_DELAYS) - 1))
                next_attempt = now + timedelta(minutes=EMAIL_DELIVERY_RETRY_DELAYS[delay_index])
                status = EmailNotificationLog.DeliveryStatus.RETRY
            EmailNotificationLog.objects.filter(pk=row.pk).update(
                delivery_status=status,
                processed_at=now if status == EmailNotificationLog.DeliveryStatus.FAILED else None,
                lease_until=None,
                available_at=next_attempt,
                last_error_code=error_code,
            )
            _owned_issue_deliveries([row.pk], lease_token).filter(pk=delivery.pk).update(
                status=status,
                available_at=next_attempt,
                lease_until=None,
                lease_token="",
                last_error_code=error_code,
                last_error_at=now,
            )


def _smtp_error_details(error):
    """Extract a normalized SMTP response from direct and recipient-refusal errors."""
    response_code = getattr(error, "smtp_code", None)
    response_message = getattr(error, "smtp_error", b"")
    recipients = getattr(error, "recipients", None)
    if not recipients and isinstance(error, smtplib.SMTPRecipientsRefused) and error.args:
        recipients = error.args[0]
    if isinstance(recipients, dict) and recipients:
        responses = list(recipients.values())
        codes = [response[0] for response in responses if isinstance(response, tuple) and response]
        messages = [response[1] for response in responses if isinstance(response, tuple) and len(response) > 1]
        if response_code is None and codes and all(code == codes[0] for code in codes):
            response_code = codes[0]
        if not response_message and messages:
            response_message = b" ".join(
                message if isinstance(message, bytes) else str(message).encode("utf-8") for message in messages
            )
    if isinstance(response_message, bytes):
        response_message = response_message.decode("utf-8", errors="replace")
    return response_code, f"{response_message} {error}".lower()


def _smtp_error_code(error):
    """Return a safe error code without persisting SMTP response text."""
    response_code, _response_text = _smtp_error_details(error)
    return f"smtp_{response_code}" if response_code is not None else type(error).__name__[:128]


def _smtp_failure(
    notification_ids,
    error,
    *,
    lease_token,
    probe_token=None,
    acceptance_unknown=True,
):
    """Classify SMTP results and preserve uncertain outcomes for manual review."""
    deliveries = list(_owned_issue_deliveries(notification_ids, lease_token))
    owned_log_ids = [row.source_log_id for row in deliveries]
    if not owned_log_ids:
        return
    if not acceptance_unknown:
        with transaction.atomic():
            deliveries = list(_owned_issue_deliveries(notification_ids, lease_token).select_for_update())
            owned_log_ids = [row.source_log_id for row in deliveries]
            EmailNotificationLog.objects.filter(pk__in=owned_log_ids).update(attempts=F("attempts") + 1)
            _owned_issue_deliveries(notification_ids, lease_token).update(attempts=F("attempts") + 1)

    response_code, error_text = _smtp_error_details(error)
    error_code = _smtp_error_code(error)
    configuration_error = (
        isinstance(error, smtplib.SMTPAuthenticationError)
        or response_code in (530, 535)
        or (response_code == 550 and "user has no permission" in error_text)
    )
    if configuration_error:
        _open_smtp_circuit(error_code)
        _retry_email_batch(
            notification_ids,
            error_code,
            lease_token=lease_token,
            retry_after=timedelta(minutes=15),
        )
    elif response_code is not None and 400 <= int(response_code) < 500:
        _retry_email_batch(notification_ids, error_code, lease_token=lease_token)
    elif response_code is not None and int(response_code) >= 500:
        _update_email_log_state(
            notification_ids,
            EmailNotificationLog.DeliveryStatus.FAILED,
            lease_token=lease_token,
            error_code=error_code,
        )
    elif acceptance_unknown:
        _update_email_log_state(
            notification_ids,
            EmailNotificationLog.DeliveryStatus.UNCERTAIN,
            lease_token=lease_token,
            error_code=error_code,
        )
    else:
        _retry_email_batch(notification_ids, error_code, lease_token=lease_token)

    if probe_token and not configuration_error:
        if response_code is not None and int(response_code) >= 500:
            _clear_smtp_circuit_probe(probe_token)
        else:
            _open_smtp_circuit(error_code)


def _send_email_notification(issue_id, notification_data, receiver_id, email_notification_ids, lease_token=None):
    """Render and send one frozen per-recipient, per-issue email batch."""
    if not lease_token:
        return False
    now = timezone.now()
    notification_ids = list(email_notification_ids)
    with transaction.atomic():
        logs = list(
            EmailNotificationLog.objects.select_for_update().filter(
                pk__in=notification_ids,
                receiver_id=receiver_id,
                entity_identifier=issue_id,
                delivery_status=EmailNotificationLog.DeliveryStatus.PROCESSING,
                lease_until__gt=now,
            )
        )
        if not logs:
            return False
        if len(logs) != len(set(notification_ids)):
            return False
        delivery_query = NotificationEmailDelivery.objects.filter(
            source_log_id__in=notification_ids,
            status=NotificationEmailDelivery.Status.PROCESSING,
            lease_until__gt=now,
        )
        delivery_query = delivery_query.filter(lease_token=lease_token)
        if delivery_query.count() != len(set(notification_ids)):
            return False

    if not _notification_email_delivery_enabled():
        _update_email_log_state(
            notification_ids,
            EmailNotificationLog.DeliveryStatus.PENDING,
            lease_token=lease_token,
        )
        return False

    receiver = User.objects.filter(pk=receiver_id, is_active=True).first()
    issue = Issue.objects.select_related("project", "project__workspace").filter(pk=issue_id).first()
    if (
        receiver is None
        or not receiver.email
        or issue is None
        or issue.deleted_at is not None
        or issue.archived_at is not None
        or issue.project.archived_at is not None
    ):
        _update_email_log_state(
            notification_ids,
            EmailNotificationLog.DeliveryStatus.SUPPRESSED,
            lease_token=lease_token,
            error_code=(
                "recipient_inactive"
                if receiver is None
                else "recipient_email_missing"
                if not receiver.email
                else "issue_unavailable"
            ),
        )
        return False

    try:
        blocked = is_email_recipient_blocked(receiver.email)
    except EmailRecipientFilterConfigurationError:
        _retry_email_batch(
            notification_ids,
            "email_recipient_filters_unavailable",
            lease_token=lease_token,
            retry_after=timedelta(minutes=15),
        )
        return False
    if blocked:
        _update_email_log_state(
            notification_ids,
            EmailNotificationLog.DeliveryStatus.SUPPRESSED,
            lease_token=lease_token,
            error_code="recipient_email_blocked",
        )
        return False

    allowed_ids = {str(row["member"]) for row in project_member_roster(issue.project)}
    if str(receiver.id) not in allowed_ids:
        _update_email_log_state(
            notification_ids,
            EmailNotificationLog.DeliveryStatus.SUPPRESSED,
            lease_token=lease_token,
            error_code="project_access_revoked",
        )
        return False

    preference = UserNotificationPreference.objects.filter(user_id=receiver_id).first()
    preference = preference or UserNotificationPreference(user_id=receiver_id)
    workspace_policies = _workspace_email_policy_map(
        issue.project.workspace_id,
        {
            NotificationEvent.Category.PROPERTY_CHANGE,
            NotificationEvent.Category.STATE_CHANGE,
            NotificationEvent.Category.COMPLETION,
            NotificationEvent.Category.ASSIGNMENT,
            NotificationEvent.Category.COMMENT,
            NotificationEvent.Category.MENTION,
        },
    )
    eligible_logs = []
    for row in logs:
        activity = (row.data or {}).get("issue_activity") or {}
        field = activity.get("field")
        completed = False
        if field == "state":
            state_id = activity.get("new_identifier")
            completed = Issue.objects.filter(pk=issue_id, state_id=state_id, state__group="completed").exists()
        issue_data = {"state_group": "completed" if completed else "in_progress"}
        category = issue_notification_category(activity, issue_data)
        enabled = workspace_policies[category]
        if enabled and field == "mention":
            enabled = preference.mention
        elif enabled and field == "comment":
            enabled = preference.comment
        elif enabled and field == "assignees":
            enabled = preference.assignment
        elif enabled and field == "state":
            enabled = preference.issue_completed if completed else preference.state_change
        elif enabled:
            enabled = preference.property_change
        if enabled:
            eligible_logs.append(row)
        else:
            _update_email_log_state(
                [row.pk],
                EmailNotificationLog.DeliveryStatus.SUPPRESSED,
                lease_token=lease_token,
                error_code=(
                    f"workspace_policy_disabled_{category}"
                    if not workspace_policies[category]
                    else f"preference_disabled_{field or 'property_change'}"
                ),
            )

    if not eligible_logs:
        return False
    eligible_ids = [row.pk for row in eligible_logs]

    circuit_allowed, probe_token, circuit_retry_after = _claim_smtp_probe()
    if not circuit_allowed:
        _retry_email_batch(
            eligible_ids,
            "smtp_circuit_open",
            lease_token=lease_token,
            retry_after=circuit_retry_after or timedelta(minutes=1),
        )
        return False

    base_api = (getattr(settings, "WEB_URL", None) or getattr(settings, "APP_BASE_URL", None) or "").rstrip("/")
    if not base_api:
        _update_email_log_state(
            eligible_ids,
            EmailNotificationLog.DeliveryStatus.FAILED,
            lease_token=lease_token,
            error_code="site_base_url_unconfigured",
        )
        return False

    filtered_data = defaultdict(list)
    for row in eligible_logs:
        filtered_data[str(row.triggered_by_id)].append(row.data or {})
    data = create_payload(dict(filtered_data))

    try:
        (
            email_host,
            email_host_user,
            email_host_password,
            email_port,
            email_use_tls,
            email_use_ssl,
            email_from,
            *_optional,
        ) = get_email_configuration()
    except Exception as exc:
        logging.getLogger("plane.worker").exception("Notification email configuration unavailable", exc_info=exc)
        _open_smtp_circuit("email_configuration_unavailable")
        _retry_email_batch(
            eligible_ids,
            "email_configuration_unavailable",
            lease_token=lease_token,
            retry_after=timedelta(minutes=15),
        )
        return False

    change_rows = _issue_change_rows(data)
    comments = []
    actor_names = []
    for actor_id, changes in data.items():
        actor = User.objects.filter(pk=actor_id).first()
        if actor is None:
            continue
        changes = dict(changes)
        comment = changes.pop("comment", False)
        mention = changes.pop("mention", False)
        actor_names.append(actor.display_name)
        actor_detail = {
            "name": actor.display_name,
            "initial": (actor.first_name or actor.display_name or "?")[:1].upper(),
        }
        if comment:
            comments.append({"actor_comments": comment, "actor_detail": actor_detail})
        if mention:
            mention["new_value"] = process_html_content(mention.get("new_value"))
            mention["old_value"] = process_html_content(mention.get("old_value"))
            comments.append({"actor_comments": mention, "actor_detail": actor_detail})
    issue_url = f"{base_api}/{issue.project.workspace.slug}/projects/{issue.project_id}/issues/{issue.id}"
    assignment_transfer = {}
    if any(
        (row.data or {}).get("issue_activity", {}).get("field") == "assignees"
        and str((row.data or {}).get("issue_activity", {}).get("new_identifier")) == str(receiver.id)
        for row in eligible_logs
    ):
        assignment_transfer = _assignment_transfer_context("issue", issue, receiver, base_api)
    context = {
        "heading": "行政工作项更新",
        "item_identifier": f"{issue.project.identifier}-{issue.sequence_id}",
        "item_title": issue.name,
        "summary": "以下人员更新了行政工作项：",
        "actor_summary": "、".join(dict.fromkeys(actor_names)),
        "change_rows": change_rows,
        "comments": comments,
        "receiver": {"email": receiver.email},
        "current_site": base_api,
        "issue_url": issue_url,
        "project_url": f"{base_api}/{issue.project.workspace.slug}/projects/{issue.project_id}/issues/",
        "workspace": str(issue.project.workspace.slug),
        "project": str(issue.project.name),
        "user_preference": f"{base_api}/{issue.project.workspace.slug}/settings/account/notifications/",
        "entity_type": "行政工作项",
        "assignment_transfer": assignment_transfer,
    }
    html_content = render_to_string("emails/notifications/issue-updates.html", context)
    audit_email_image_resources(html_content)
    text_content = render_to_string("emails/notifications/issue-updates.txt", context)
    connection = get_connection(
        host=email_host,
        port=int(email_port),
        username=email_host_user,
        password=email_host_password,
        use_tls=email_use_tls == "1",
        use_ssl=email_use_ssl == "1",
        timeout=15,
    )
    message = EmailMultiAlternatives(
        subject=(
            f"行政工作项更新：{issue.project.identifier}-{issue.sequence_id} "
            f"{remove_unwanted_characters(issue.name)}"
        ),
        body=text_content,
        from_email=email_from,
        to=[receiver.email],
        connection=connection,
    )
    message.attach_alternative(html_content, "text/html")

    try:
        # 连接失败由异常报告，open() 返回值不代表邮件是否投递成功。
        connection.open()
    except Exception as exc:
        logging.getLogger("plane.worker").exception("Notification SMTP connection failed", exc_info=exc)
        _smtp_failure(
            eligible_ids,
            exc,
            lease_token=lease_token,
            probe_token=probe_token,
            acceptance_unknown=False,
        )
        connection.close()
        return False

    if not _notification_email_delivery_enabled():
        connection.close()
        _update_email_log_state(
            eligible_ids,
            EmailNotificationLog.DeliveryStatus.PENDING,
            lease_token=lease_token,
        )
        return False

    # A fencing token prevents an expired task from submitting a reclaimed batch.
    with transaction.atomic():
        claim_now = timezone.now()
        log_claim = EmailNotificationLog.objects.select_for_update().filter(
            pk__in=eligible_ids,
            delivery_status=EmailNotificationLog.DeliveryStatus.PROCESSING,
        )
        delivery_claim = NotificationEmailDelivery.objects.select_for_update().filter(
            source_log_id__in=eligible_ids,
            status=NotificationEmailDelivery.Status.PROCESSING,
            lease_until__gt=claim_now,
        )
        delivery_claim = delivery_claim.filter(lease_token=lease_token)
        if log_claim.count() != len(eligible_ids) or delivery_claim.count() != len(eligible_ids):
            claim_valid = False
        else:
            delivery_claim.update(
                status=NotificationEmailDelivery.Status.UNCERTAIN,
                attempts=F("attempts") + 1,
                lease_until=None,
                last_error_code="smtp_submission_started",
                last_error_at=claim_now,
            )
            log_claim.update(
                delivery_status=EmailNotificationLog.DeliveryStatus.UNCERTAIN,
                attempts=F("attempts") + 1,
                lease_until=None,
                last_error_code="smtp_submission_started",
            )
            claim_valid = True
    if not claim_valid:
        connection.close()
        return False

    try:
        sent = message.send()
        if sent != 1:
            raise smtplib.SMTPException("SMTP did not accept the notification message")
    except Exception as exc:
        logging.getLogger("plane.worker").exception("Notification email submission failed", exc_info=exc)
        _smtp_failure(
            eligible_ids,
            exc,
            lease_token=lease_token,
            probe_token=probe_token,
        )
        connection.close()
        return False

    _update_email_log_state(
        eligible_ids,
        EmailNotificationLog.DeliveryStatus.ACCEPTED,
        lease_token=lease_token,
    )
    connection.close()
    _clear_smtp_circuit_probe(probe_token)
    logging.getLogger("plane.worker").info("Notification email accepted by SMTP")
    return True


@shared_task
def send_email_notification(issue_id, notification_data, receiver_id, email_notification_ids, lease_token=None):
    return _send_email_notification(issue_id, notification_data, receiver_id, email_notification_ids, lease_token)


def _workspace_email_policy_map(workspace_id, categories):
    """Load administrator email switches for one workspace batch.

    Args:
        workspace_id: Workspace owning the queued deliveries.
        categories: Event categories that may appear in the batch.

    Returns:
        A category-to-enabled mapping with permissive defaults.
    """
    policy = {
        row["category"]: row["email_enabled"]
        for row in WorkspaceNotificationPolicy.objects.filter(
            workspace_id=workspace_id,
            category__in=categories,
            deleted_at__isnull=True,
        ).values("category", "email_enabled")
    }
    return defaultdict(lambda: True, policy)


def _research_preference_enabled(receiver_id, category):
    """Resolve a research event category to the user's current email switch."""
    preference = UserNotificationPreference.objects.filter(user_id=receiver_id).first()
    if preference is None:
        preference = UserNotificationPreference(user_id=receiver_id)
    field_by_category = {
        NotificationEvent.Category.ASSIGNMENT: "assignment",
        NotificationEvent.Category.RESEARCH_ACTION: "property_change",
        NotificationEvent.Category.RESEARCH_PROPERTY_CHANGE: "research_property_change",
        NotificationEvent.Category.RESEARCH_STATE_CHANGE: "research_state_change",
        NotificationEvent.Category.RESEARCH_COMMENT: "research_comment",
        NotificationEvent.Category.RESEARCH_MENTION: "research_mention",
        NotificationEvent.Category.RESEARCH_COMPLETION: "research_completion",
    }
    preference_field = field_by_category.get(category, "property_change")
    return bool(getattr(preference, preference_field, True))


def _research_event_currently_authorized(event, receiver):
    """Recheck the recipient's current workspace and entity access before send."""
    from plane.db.models import (
        ApprovalRequest,
        ExperimentAmendment,
        ExperimentRecord,
        PeriodicReport,
        ResearchChainNodeTask,
        ResearchChainStage,
        ResearchPaperReview,
        ResearchStageInstance,
        WorkspaceMember,
        Workspace,
    )
    from plane.research.services.chain_tasks import chain_resource, validate_assignable_user
    from plane.research.utils.acl import build_actor_context, check_access
    from plane.research.utils.chain_permissions import is_basic_research_chain
    from plane.research.utils.reports import report_resource
    from plane.research.utils.resource_projections import experiment_resource
    from plane.research.utils.stages import stage_resource

    if not WorkspaceMember.objects.filter(
        workspace_id=event.workspace_id,
        member_id=receiver.id,
        is_active=True,
        deleted_at__isnull=True,
    ).exists():
        return False

    payload = event.payload if isinstance(event.payload, dict) else {}
    action = event.action
    resource = None
    allowed_by_assignment = False

    if event.entity_name == "research_chain_task":
        task = (
            ResearchChainNodeTask.objects.select_related("workspace", "chain__project__research_profile__org_unit")
            .filter(
                pk=event.entity_identifier,
                workspace_id=event.workspace_id,
                deleted_at__isnull=True,
            )
            .first()
        )
        if task is None:
            return False
        if (
            is_basic_research_chain(getattr(task.chain.project, "research_profile", None))
            and not validate_assignable_user(task.workspace, task.chain, receiver.id)
        ):
            return False
        if action == "assigned" and task.assignee_id != receiver.id:
            return False
        if action == "completed" and task.status != "COMPLETED":
            return False
        if action == "reopened" and task.status != "ASSIGNED":
            return False
        if action == "cancelled" and task.status != "CANCELLED":
            return False
        allowed_by_assignment = receiver.id in {task.assignee_id, task.assigned_by_id}
        if action in {"updated", "commented"} and not allowed_by_assignment:
            allowed_by_assignment = task.notification_subscribers.filter(
                subscriber_id=receiver.id,
                deleted_at__isnull=True,
            ).exists()
        resource = chain_resource(task.chain)
    elif event.entity_name == "research_chain_stage":
        stage = (
            ResearchChainStage.objects.select_related("chain__project")
            .filter(
                pk=event.entity_identifier,
                deleted_at__isnull=True,
            )
            .first()
        )
        if stage is None:
            return False
        if action in {"submitted", "escalated"} and stage.status not in {"AWAITING_ADVISOR", "AWAITING_PI"}:
            return False
        if action in {"approved", "returned"} and stage.chain.owner_id != receiver.id:
            return False
        resource = chain_resource(stage.chain)
    elif event.entity_name in {"research_stage", "research_stage_review"}:
        stage_id = payload.get("stage_id") or event.entity_identifier
        stage = (
            ResearchStageInstance.objects.select_related("project", "workspace")
            .filter(
                pk=stage_id,
                deleted_at__isnull=True,
            )
            .first()
        )
        if stage is None:
            return False
        resource = stage_resource(stage, with_reviewers=True)
    elif event.entity_name == "research_report":
        report = (
            PeriodicReport.objects.select_related("workspace", "project", "owner")
            .filter(
                pk=payload.get("report_id") or event.entity_identifier,
                deleted_at__isnull=True,
            )
            .first()
        )
        if report is None:
            return False
        if action in {"returned", "accepted"} and report.owner_id != receiver.id:
            return False
        resource = report_resource(report)
    elif event.entity_name == "research_approval":
        request = (
            ApprovalRequest.objects.select_related("flow", "issue")
            .filter(
                pk=payload.get("approval_request_id"),
                issue_id=payload.get("issue_id") or event.entity_identifier,
            )
            .first()
        )
        if request is None:
            return False
        if action == "pending":
            from plane.research.utils.approvals import pending_approver_users

            if request.status != ApprovalRequest.Status.PENDING or receiver.id not in {
                user.id for user in pending_approver_users(request)
            }:
                return False
        elif request.requested_by_id != receiver.id:
            return False
        return True
    elif event.entity_name == "research_feedback":
        if action != "replied":
            return False
        from plane.research.services.feedback import visible_feedback_queryset

        workspace = Workspace.objects.filter(pk=event.workspace_id).first()
        if workspace is None:
            return False
        return (
            visible_feedback_queryset(receiver, workspace, scope="reply")
            .filter(
                pk=event.entity_identifier,
                deleted_at__isnull=True,
            )
            .exists()
        )
    elif event.entity_name == "research_paper_review":
        from plane.research.utils.acl import direct_advisor_ids

        review = (
            ResearchPaperReview.objects.select_related("chain__project")
            .filter(
                pk=event.entity_identifier,
                deleted_at__isnull=True,
            )
            .first()
        )
        if review is None:
            return False
        if action == "submitted":
            reviewer_ids = set(direct_advisor_ids(review.owner_id, review.workspace_id))
            if review.final_reviewer_id:
                reviewer_ids.add(review.final_reviewer_id)
            if review.status != ResearchPaperReview.Status.WAITING_REVIEW or receiver.id not in reviewer_ids:
                return False
        if action in {"returned", "accepted"} and review.owner_id != receiver.id:
            return False
        resource = chain_resource(review.chain)
    elif event.entity_name in {"research_experiment", "research_experiment_amendment"}:
        experiment_id = payload.get("experiment_id")
        if event.entity_name == "research_experiment_amendment":
            amendment = ExperimentAmendment.objects.filter(
                pk=payload.get("amendment_id") or event.entity_identifier
            ).first()
            if amendment is None:
                return False
            experiment_id = amendment.record_id
            if action.startswith("amendment_") and amendment.requested_by_id == receiver.id:
                allowed_by_assignment = action != "amendment_created"
        experiment = (
            ExperimentRecord.objects.select_related("workspace", "project")
            .filter(
                pk=experiment_id or event.entity_identifier,
                deleted_at__isnull=True,
            )
            .first()
        )
        if experiment is None:
            return False
        if action == "submitted" and experiment.status not in {"RUNNING", "COMPLETED", "FAILED"}:
            return False
        resource = experiment_resource(experiment)
    else:
        return False

    context = build_actor_context(receiver, event.workspace_id)
    return (
        allowed_by_assignment
        or check_access(receiver, "view", resource, context=context)
        or check_access(receiver, "review", resource, context=context)
    )


def _update_research_delivery_state(
    delivery_ids,
    status,
    *,
    lease_token,
    error_code="",
    available_at=None,
):
    """Update only research deliveries still owned by the caller's lease."""
    now = timezone.now()
    updates = {
        "status": status,
        "available_at": available_at or now,
        "lease_until": None,
        "lease_token": "",
        "last_error_code": error_code,
    }
    if status == NotificationEmailDelivery.Status.ACCEPTED:
        updates["smtp_accepted_at"] = now
    if error_code:
        updates["last_error_at"] = now
    NotificationEmailDelivery.objects.filter(
        pk__in=delivery_ids,
        lease_token=lease_token,
        status__in=(NotificationEmailDelivery.Status.PROCESSING, NotificationEmailDelivery.Status.UNCERTAIN),
    ).update(**updates)


def _retry_research_delivery_batch(delivery_ids, error_code, *, lease_token, retry_after=None):
    """Retry known-unaccepted research mail or close exhausted deliveries."""
    now = timezone.now()
    with transaction.atomic():
        deliveries = list(
            NotificationEmailDelivery.objects.select_for_update().filter(
                pk__in=delivery_ids,
                lease_token=lease_token,
                status__in=(
                    NotificationEmailDelivery.Status.PROCESSING,
                    NotificationEmailDelivery.Status.UNCERTAIN,
                ),
            )
        )
        for delivery in deliveries:
            age = now - delivery.created_at
            if delivery.attempts >= MAX_EMAIL_DELIVERY_ATTEMPTS or age >= EMAIL_DELIVERY_MAX_AGE:
                status = NotificationEmailDelivery.Status.FAILED
                available_at = now
            else:
                status = NotificationEmailDelivery.Status.RETRY
                if retry_after is not None:
                    available_at = now + retry_after
                else:
                    index = max(0, min(delivery.attempts - 1, len(EMAIL_DELIVERY_RETRY_DELAYS) - 1))
                    available_at = now + timedelta(minutes=EMAIL_DELIVERY_RETRY_DELAYS[index])
            NotificationEmailDelivery.objects.filter(pk=delivery.pk, lease_token=lease_token).update(
                status=status,
                available_at=available_at,
                lease_until=None,
                lease_token="",
                last_error_code=error_code,
                last_error_at=now,
            )


def _research_smtp_failure(delivery_ids, error, *, lease_token, probe_token=None, acceptance_unknown):
    """Classify SMTP errors for recipient-specific research email batches."""
    with transaction.atomic():
        deliveries = list(
            NotificationEmailDelivery.objects.select_for_update().filter(
                pk__in=delivery_ids,
                lease_token=lease_token,
                status__in=(
                    NotificationEmailDelivery.Status.PROCESSING,
                    NotificationEmailDelivery.Status.UNCERTAIN,
                ),
            )
        )
        delivery_ids = [delivery.pk for delivery in deliveries]
        if not delivery_ids:
            return
        if not acceptance_unknown:
            NotificationEmailDelivery.objects.filter(pk__in=delivery_ids, lease_token=lease_token).update(
                attempts=F("attempts") + 1
            )
    response_code, error_text = _smtp_error_details(error)
    error_code = _smtp_error_code(error)
    configuration_error = (
        isinstance(error, smtplib.SMTPAuthenticationError)
        or response_code in (530, 535)
        or (response_code == 550 and "user has no permission" in error_text)
    )
    if configuration_error:
        _open_smtp_circuit(error_code)
        _retry_research_delivery_batch(
            delivery_ids,
            error_code,
            lease_token=lease_token,
            retry_after=timedelta(minutes=15),
        )
    elif response_code is not None and 400 <= int(response_code) < 500:
        _retry_research_delivery_batch(delivery_ids, error_code, lease_token=lease_token)
    elif response_code is not None and int(response_code) >= 500:
        _update_research_delivery_state(
            delivery_ids,
            NotificationEmailDelivery.Status.FAILED,
            lease_token=lease_token,
            error_code=error_code,
        )
    elif acceptance_unknown:
        _update_research_delivery_state(
            delivery_ids,
            NotificationEmailDelivery.Status.UNCERTAIN,
            lease_token=lease_token,
            error_code=error_code,
        )
    else:
        _retry_research_delivery_batch(delivery_ids, error_code, lease_token=lease_token)
    if probe_token and not configuration_error:
        if response_code is not None and int(response_code) >= 500:
            _clear_smtp_circuit_probe(probe_token)
        else:
            _open_smtp_circuit(error_code)


@shared_task
def send_research_notification_email(delivery_ids, lease_token):
    """Send one recipient/entity research digest after current ACL checks."""
    now = timezone.now()
    delivery_ids = list(delivery_ids)
    deliveries = list(
        NotificationEmailDelivery.objects.select_related("event").filter(
            pk__in=delivery_ids,
            source_log__isnull=True,
            status=NotificationEmailDelivery.Status.PROCESSING,
            lease_token=lease_token,
            lease_until__gt=now,
        )
    )
    if len(deliveries) != len(set(delivery_ids)) or not deliveries:
        return False
    if not _notification_email_delivery_enabled():
        _update_research_delivery_state(
            delivery_ids,
            NotificationEmailDelivery.Status.PENDING,
            lease_token=lease_token,
        )
        return False

    receiver = User.objects.filter(pk=deliveries[0].event.receiver_id, is_active=True).first()
    if receiver is None or not receiver.email:
        _update_research_delivery_state(
            delivery_ids,
            NotificationEmailDelivery.Status.SUPPRESSED,
            lease_token=lease_token,
            error_code="recipient_inactive" if receiver is None else "recipient_email_missing",
        )
        return False

    try:
        blocked = is_email_recipient_blocked(receiver.email)
    except EmailRecipientFilterConfigurationError:
        _retry_research_delivery_batch(
            delivery_ids,
            "email_recipient_filters_unavailable",
            lease_token=lease_token,
            retry_after=timedelta(minutes=15),
        )
        return False
    if blocked:
        _update_research_delivery_state(
            delivery_ids,
            NotificationEmailDelivery.Status.SUPPRESSED,
            lease_token=lease_token,
            error_code="recipient_email_blocked",
        )
        return False

    eligible = []
    workspace_policies = _workspace_email_policy_map(
        deliveries[0].event.workspace_id,
        {delivery.event.category for delivery in deliveries},
    )
    for delivery in deliveries:
        event = delivery.event
        if event.receiver_id != receiver.id:
            _update_research_delivery_state(
                [delivery.pk],
                NotificationEmailDelivery.Status.SUPPRESSED,
                lease_token=lease_token,
            )
        elif not workspace_policies[event.category]:
            _update_research_delivery_state(
                [delivery.pk],
                NotificationEmailDelivery.Status.SUPPRESSED,
                lease_token=lease_token,
                error_code=f"workspace_policy_disabled_{event.category}",
            )
        elif not _research_preference_enabled(receiver.id, event.category):
            _update_research_delivery_state(
                [delivery.pk],
                NotificationEmailDelivery.Status.SUPPRESSED,
                lease_token=lease_token,
                error_code="preference_disabled",
            )
        elif not _research_event_currently_authorized(event, receiver):
            _update_research_delivery_state(
                [delivery.pk],
                NotificationEmailDelivery.Status.SUPPRESSED,
                lease_token=lease_token,
                error_code="resource_access_revoked",
            )
        else:
            eligible.append(delivery)
    if not eligible:
        return False

    circuit_allowed, probe_token, circuit_retry_after = _claim_smtp_probe()
    if not circuit_allowed:
        _retry_research_delivery_batch(
            [delivery.pk for delivery in eligible],
            "smtp_circuit_open",
            lease_token=lease_token,
            retry_after=circuit_retry_after or timedelta(minutes=1),
        )
        return False

    base_url = (getattr(settings, "WEB_URL", None) or getattr(settings, "APP_BASE_URL", None) or "").rstrip("/")
    if not base_url:
        _update_research_delivery_state(
            [delivery.pk for delivery in eligible],
            NotificationEmailDelivery.Status.FAILED,
            lease_token=lease_token,
            error_code="site_base_url_unconfigured",
        )
        return False
    try:
        (
            email_host,
            email_host_user,
            email_host_password,
            email_port,
            email_use_tls,
            email_use_ssl,
            email_from,
            *_optional,
        ) = get_email_configuration()
    except Exception as exc:
        _open_smtp_circuit("email_configuration_unavailable")
        _retry_research_delivery_batch(
            [delivery.pk for delivery in eligible],
            "email_configuration_unavailable",
            lease_token=lease_token,
            retry_after=timedelta(minutes=15),
        )
        logging.getLogger("plane.worker").exception(
            "Research notification email configuration unavailable", exc_info=exc
        )
        return False

    events = [delivery.event for delivery in eligible]
    first_event = events[0]
    first_route = (
        first_event.route
        if first_event.route.startswith("/") and not first_event.route.startswith("//")
        else f"/{deliveries[0].event.workspace.slug}/research"
    )
    issue_url = f"{base_url}{first_route}"
    task = (
        ResearchChainNodeTask.objects.select_related(
            "workspace", "chain", "chain__project", "node"
        ).filter(pk=first_event.entity_identifier)
        .first()
    )
    assignment_transfer = {}
    if (
        task is not None
        and any(
            event.category == NotificationEvent.Category.ASSIGNMENT
            and event.action == "assigned"
            for event in events
        )
    ):
        assignment_transfer = _assignment_transfer_context(
            "research_chain_task", task, receiver, base_url
        )

    change_rows = []
    actor_names = []
    for event in events:
        actor_name = event.triggered_by.display_name if event.triggered_by else "系统"
        actor_names.append(actor_name)
        change_rows.append(
            {
                "actor_name": actor_name,
                "activity_time": timezone.localtime(event.created_at).strftime("%m-%d %H:%M"),
                "field_label": "动态",
                "old_value": "",
                "new_value": event.summary or event.title,
            }
        )
    context = {
        "heading": "科研工作项通知",
        "item_identifier": task.chain.project.identifier if task else "",
        "item_title": task.title if task else first_event.title,
        "summary": "以下科研工作项有新的动态：",
        "actor_summary": "、".join(dict.fromkeys(actor_names)),
        "change_rows": change_rows,
        "comments": [],
        "receiver": {"email": receiver.email},
        "current_site": base_url,
        "issue_url": issue_url,
        "project_url": f"{base_url}/{deliveries[0].event.workspace.slug}/research",
        "workspace": str(deliveries[0].event.workspace.slug),
        "project": task.chain.project.name if task else str(deliveries[0].event.workspace.name),
        "user_preference": (
            f"{base_url}/{deliveries[0].event.workspace.slug}/settings/account/notifications/"
        ),
        "entity_type": "科研工作项",
        "assignment_transfer": assignment_transfer,
    }
    html_content = render_to_string("emails/notifications/issue-updates.html", context)
    audit_email_image_resources(html_content)
    text_content = render_to_string("emails/notifications/issue-updates.txt", context)
    connection = get_connection(
        host=email_host,
        port=int(email_port),
        username=email_host_user,
        password=email_host_password,
        use_tls=email_use_tls == "1",
        use_ssl=email_use_ssl == "1",
        timeout=15,
    )
    message = EmailMultiAlternatives(
        subject=remove_unwanted_characters(first_event.title),
        body=text_content,
        from_email=email_from,
        to=[receiver.email],
        connection=connection,
    )
    message.attach_alternative(html_content, "text/html")
    try:
        # 连接失败由异常报告，open() 返回值不代表邮件是否投递成功。
        connection.open()
    except Exception as exc:
        _research_smtp_failure(
            [delivery.pk for delivery in eligible],
            exc,
            lease_token=lease_token,
            probe_token=probe_token,
            acceptance_unknown=False,
        )
        connection.close()
        return False

    eligible_ids = [delivery.pk for delivery in eligible]
    if not _notification_email_delivery_enabled():
        connection.close()
        _update_research_delivery_state(
            eligible_ids,
            NotificationEmailDelivery.Status.PENDING,
            lease_token=lease_token,
        )
        return False

    with transaction.atomic():
        claim_now = timezone.now()
        claim = NotificationEmailDelivery.objects.select_for_update().filter(
            pk__in=eligible_ids,
            status=NotificationEmailDelivery.Status.PROCESSING,
            lease_token=lease_token,
            lease_until__gt=claim_now,
        )
        if claim.count() != len(eligible_ids):
            claim_valid = False
        else:
            claim.update(
                status=NotificationEmailDelivery.Status.UNCERTAIN,
                attempts=F("attempts") + 1,
                lease_until=None,
                last_error_code="smtp_submission_started",
                last_error_at=claim_now,
            )
            claim_valid = True
    if not claim_valid:
        connection.close()
        return False

    try:
        sent = message.send()
        if sent != 1:
            raise smtplib.SMTPException("SMTP did not accept the notification message")
    except Exception as exc:
        logging.getLogger("plane.worker").exception("Research notification email submission failed", exc_info=exc)
        _research_smtp_failure(
            eligible_ids,
            exc,
            lease_token=lease_token,
            probe_token=probe_token,
            acceptance_unknown=True,
        )
        connection.close()
        return False

    _update_research_delivery_state(
        eligible_ids,
        NotificationEmailDelivery.Status.ACCEPTED,
        lease_token=lease_token,
    )
    connection.close()
    _clear_smtp_circuit_probe(probe_token)
    logging.getLogger("plane.worker").info("Research notification email accepted by SMTP")
    return True
