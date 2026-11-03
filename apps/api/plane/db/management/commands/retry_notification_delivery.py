"""Retry a failed notification delivery with an explicit operator audit."""

from uuid import UUID

from django.core.management.base import BaseCommand, CommandError
from django.db import transaction
from django.db.models import Q
from django.utils import timezone

from plane.bgtasks.email_notification_task import stack_email_notification
from plane.db.models import (
    EmailNotificationLog,
    NotificationDeliveryAudit,
    NotificationEmailDelivery,
    User,
)


class Command(BaseCommand):
    """Requeue one permanently failed notification after an operator review."""

    help = "Retry one failed notification email delivery and record the operator action."

    def add_arguments(self, parser):
        """Register the delivery selector, operator, and required retry reason."""
        selector = parser.add_mutually_exclusive_group(required=True)
        selector.add_argument("--delivery-id", help="NotificationEmailDelivery UUID")
        selector.add_argument("--event-id", help="NotificationEvent UUID")
        parser.add_argument("--actor-id", required=True, help="Active staff user UUID responsible for the retry")
        parser.add_argument("--reason", required=True, help="Reason the failed delivery is safe to retry")

    def handle(self, *args, **options):
        """Requeue a failed delivery and wake the normal email scheduler."""
        try:
            actor_id = str(UUID(options["actor_id"]))
            delivery_id = str(UUID(options["delivery_id"])) if options.get("delivery_id") else None
            event_id = str(UUID(options["event_id"])) if options.get("event_id") else None
        except (TypeError, ValueError) as exc:
            raise CommandError("Actor, delivery, and event identifiers must be UUIDs") from exc

        reason = options["reason"].strip()
        if not reason:
            raise CommandError("--reason must not be empty")
        if len(reason) > 2000:
            raise CommandError("--reason must be 2000 characters or fewer")

        actor = User.objects.filter(pk=actor_id, is_active=True).filter(Q(is_staff=True) | Q(is_superuser=True)).first()
        if actor is None:
            raise CommandError("--actor-id must identify an active staff user")

        deliveries = NotificationEmailDelivery.objects.all()
        if delivery_id:
            deliveries = deliveries.filter(pk=delivery_id)
        else:
            deliveries = deliveries.filter(event__event_key=event_id)

        with transaction.atomic():
            delivery = deliveries.select_for_update().first()
            if delivery is None:
                raise CommandError("Notification delivery was not found")
            if delivery.status != NotificationEmailDelivery.Status.FAILED:
                raise CommandError(f"Only failed deliveries can be retried; current status is {delivery.status}")

            previous_status = delivery.status
            now = timezone.now()
            delivery.status = NotificationEmailDelivery.Status.PENDING
            delivery.available_at = now
            delivery.attempts = 0
            delivery.lease_until = None
            delivery.lease_token = ""
            delivery.smtp_accepted_at = None
            delivery.last_error_code = ""
            delivery.last_error_at = None
            delivery.save(
                update_fields=[
                    "status",
                    "available_at",
                    "attempts",
                    "lease_until",
                    "lease_token",
                    "smtp_accepted_at",
                    "last_error_code",
                    "last_error_at",
                    "updated_at",
                ]
            )
            if delivery.source_log_id:
                EmailNotificationLog.objects.filter(pk=delivery.source_log_id).update(
                    delivery_status=EmailNotificationLog.DeliveryStatus.PENDING,
                    available_at=now,
                    processed_at=None,
                    sent_at=None,
                    lease_until=None,
                    attempts=0,
                    last_error_code="",
                )
            NotificationDeliveryAudit.objects.create(
                workspace_id=delivery.event.workspace_id,
                delivery=delivery,
                delivery_identifier=delivery.pk,
                event_identifier=delivery.event.event_key,
                actor=actor,
                action="retry",
                previous_status=previous_status,
                new_status=delivery.status,
                reason=reason,
            )
            transaction.on_commit(lambda: stack_email_notification.delay(), robust=True)

        self.stdout.write(self.style.SUCCESS(f"Requeued notification delivery {delivery.pk}"))
