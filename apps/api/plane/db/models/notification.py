# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

import uuid

# Django imports
from django.conf import settings
from django.db import models
from django.utils import timezone

# Module imports
from .base import BaseModel


class SystemAnnouncement(BaseModel):
    """Canonical announcement content shared by all recipient notifications."""

    workspace = models.ForeignKey(
        "db.Workspace",
        related_name="system_announcements",
        on_delete=models.CASCADE,
    )
    title = models.CharField(max_length=255)
    body = models.TextField()
    recipient_count = models.PositiveIntegerField(default=0)
    published_at = models.DateTimeField(null=True)
    idempotency_key = models.CharField(max_length=255, blank=True, default="")

    class Meta:
        verbose_name = "System Announcement"
        verbose_name_plural = "System Announcements"
        db_table = "system_announcements"
        ordering = ("-published_at", "-created_at")
        constraints = [
            models.UniqueConstraint(
                fields=["workspace", "idempotency_key"],
                condition=~models.Q(idempotency_key=""),
                name="sys_announcement_ws_key_unique",
            )
        ]

    def __str__(self):
        """Return the announcement title and workspace name."""
        return f"{self.title} <{self.workspace.name}>"


class Notification(BaseModel):
    workspace = models.ForeignKey("db.Workspace", related_name="notifications", on_delete=models.CASCADE)
    project = models.ForeignKey("db.Project", related_name="notifications", on_delete=models.CASCADE, null=True)
    announcement = models.ForeignKey(
        "db.SystemAnnouncement",
        related_name="notifications",
        on_delete=models.CASCADE,
        null=True,
    )
    data = models.JSONField(null=True)
    entity_identifier = models.UUIDField(null=True)
    entity_name = models.CharField(max_length=255)
    title = models.TextField()
    message = models.JSONField(null=True)
    message_html = models.TextField(blank=True, default="<p></p>")
    message_stripped = models.TextField(blank=True, null=True)
    sender = models.CharField(max_length=255)
    triggered_by = models.ForeignKey(
        "db.User",
        related_name="triggered_notifications",
        on_delete=models.SET_NULL,
        null=True,
    )
    receiver = models.ForeignKey("db.User", related_name="received_notifications", on_delete=models.CASCADE)
    read_at = models.DateTimeField(null=True)
    snoozed_till = models.DateTimeField(null=True)
    archived_at = models.DateTimeField(null=True)

    class Meta:
        verbose_name = "Notification"
        verbose_name_plural = "Notifications"
        db_table = "notifications"
        ordering = ("-created_at",)
        indexes = [
            models.Index(fields=["entity_identifier"], name="notif_entity_identifier_idx"),
            models.Index(fields=["entity_name"], name="notif_entity_name_idx"),
            models.Index(fields=["read_at"], name="notif_read_at_idx"),
            models.Index(fields=["receiver", "read_at"], name="notif_entity_idx"),
            models.Index(
                fields=["receiver", "workspace", "read_at", "created_at"],
                name="notif_receiver_status_idx",
            ),
            models.Index(
                fields=["receiver", "workspace", "entity_name", "read_at"],
                name="notif_receiver_entity_idx",
            ),
            models.Index(
                fields=["receiver", "workspace", "snoozed_till", "archived_at"],
                name="notif_receiver_state_idx",
            ),
            models.Index(
                fields=["receiver", "workspace", "sender"],
                name="notif_receiver_sender_idx",
            ),
            models.Index(
                fields=["receiver", "workspace", "announcement"],
                name="notif_recv_ws_announce_idx",
            ),
            models.Index(
                fields=["workspace", "entity_identifier", "entity_name"],
                name="notif_entity_lookup_idx",
            ),
        ]

    def __str__(self):
        """Return name of the notifications"""
        return f"{self.receiver.email} <{self.workspace.name}>"


class InboxTodoState(BaseModel):
    """Store per-user presentation state for dynamically projected todos."""

    workspace = models.ForeignKey(
        "db.Workspace",
        related_name="inbox_todo_states",
        on_delete=models.CASCADE,
    )
    receiver = models.ForeignKey(
        "db.User",
        related_name="inbox_todo_states",
        on_delete=models.CASCADE,
    )
    source = models.CharField(max_length=64)
    object_id = models.CharField(max_length=255)
    dedupe_key = models.CharField(max_length=512)
    payload_hash = models.CharField(max_length=128)
    read_at = models.DateTimeField(null=True)
    archived_at = models.DateTimeField(null=True)
    snoozed_till = models.DateTimeField(null=True)
    last_seen_at = models.DateTimeField(null=True)
    last_reminder_key = models.CharField(max_length=255, blank=True, default="")
    last_reminder_at = models.DateTimeField(null=True)

    class Meta:
        verbose_name = "Inbox Todo State"
        verbose_name_plural = "Inbox Todo States"
        db_table = "inbox_todo_states"
        ordering = ("-updated_at",)
        constraints = [
            models.UniqueConstraint(
                fields=["workspace", "receiver", "source", "object_id"],
                name="inbox_todo_state_unique_item",
            )
        ]
        indexes = [
            models.Index(
                fields=["workspace", "receiver", "read_at"],
                name="inbox_todo_state_read_idx",
            ),
            models.Index(
                fields=["workspace", "receiver", "archived_at", "snoozed_till"],
                name="inbox_todo_state_state_idx",
            ),
        ]

    def __str__(self):
        """Return the receiver and stable todo identifier."""
        return f"{self.receiver.email} <{self.dedupe_key}>"


def get_default_preference():
    return {
        "property_change": {"email": True},
        "state": {"email": True},
        "comment": {"email": True},
        "mentions": {"email": True},
    }


class UserNotificationPreference(BaseModel):
    # user it is related to
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="notification_preferences",
    )
    # workspace if it is applicable
    workspace = models.ForeignKey(
        "db.Workspace",
        on_delete=models.CASCADE,
        related_name="workspace_notification_preferences",
        null=True,
    )
    # project
    project = models.ForeignKey(
        "db.Project",
        on_delete=models.CASCADE,
        related_name="project_notification_preferences",
        null=True,
    )

    # preference fields
    property_change = models.BooleanField(default=True)
    state_change = models.BooleanField(default=True)
    comment = models.BooleanField(default=True)
    mention = models.BooleanField(default=True)
    issue_completed = models.BooleanField(default=True)
    assignment = models.BooleanField(default=True)
    research_property_change = models.BooleanField(default=True)
    research_state_change = models.BooleanField(default=True)
    research_comment = models.BooleanField(default=True)
    research_mention = models.BooleanField(default=True)
    research_completion = models.BooleanField(default=True)

    class Meta:
        verbose_name = "UserNotificationPreference"
        verbose_name_plural = "UserNotificationPreferences"
        db_table = "user_notification_preferences"
        ordering = ("-created_at",)
        constraints = [models.UniqueConstraint(fields=["user"], name="notification_preference_unique_user")]

    def __str__(self):
        """Return the user"""
        return f"<{self.user}>"


class WorkspaceNotificationPolicy(BaseModel):
    """Store an administrator's channel policy for one notification category."""

    class Category(models.TextChoices):
        PROPERTY_CHANGE = "property_change", "Property change"
        STATE_CHANGE = "state_change", "State change"
        COMPLETION = "completion", "Completion"
        ASSIGNMENT = "assignment", "Assignment"
        COMMENT = "comment", "Comment"
        MENTION = "mention", "Mention"
        RESEARCH_PROPERTY_CHANGE = "research_property_change", "Research property change"
        RESEARCH_STATE_CHANGE = "research_state_change", "Research state change"
        RESEARCH_COMPLETION = "research_completion", "Research completion"
        RESEARCH_COMMENT = "research_comment", "Research comment"
        RESEARCH_MENTION = "research_mention", "Research mention"
        SYSTEM_ANNOUNCEMENT = "system_announcement", "System announcement"

    workspace = models.ForeignKey(
        "db.Workspace",
        on_delete=models.CASCADE,
        related_name="notification_policies",
    )
    category = models.CharField(max_length=64, choices=Category.choices)
    in_app_enabled = models.BooleanField(default=True)
    email_enabled = models.BooleanField(default=True)

    class Meta:
        verbose_name = "WorkspaceNotificationPolicy"
        verbose_name_plural = "WorkspaceNotificationPolicies"
        db_table = "workspace_notification_policies"
        ordering = ("workspace", "category")
        constraints = [
            models.UniqueConstraint(fields=["workspace", "category"], name="workspace_notification_policy_uq")
        ]

    def __str__(self):
        """Return the workspace and notification category."""
        return f"{self.workspace}:{self.category}"


class EmailNotificationLog(BaseModel):
    class DeliveryStatus(models.TextChoices):
        PENDING = "pending", "Pending"
        PROCESSING = "processing", "Processing"
        RETRY = "retry", "Waiting to retry"
        ACCEPTED = "accepted", "Accepted by SMTP"
        SUPPRESSED = "suppressed", "Suppressed"
        FAILED = "failed", "Failed"
        UNCERTAIN = "uncertain", "Result uncertain"
        LEGACY = "legacy", "Legacy record"

    # receiver
    receiver = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="email_notifications",
    )
    triggered_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="triggered_emails",
    )
    # entity - can be issues, pages, etc.
    entity_identifier = models.UUIDField(null=True)
    entity_name = models.CharField(max_length=255)
    # data
    data = models.JSONField(null=True)
    # sent at
    processed_at = models.DateTimeField(null=True)
    sent_at = models.DateTimeField(null=True)
    delivery_status = models.CharField(max_length=16, choices=DeliveryStatus.choices, default=DeliveryStatus.PENDING)
    available_at = models.DateTimeField(default=timezone.now)
    lease_until = models.DateTimeField(null=True)
    attempts = models.PositiveSmallIntegerField(default=0)
    last_error_code = models.CharField(max_length=128, blank=True, default="")
    immediate = models.BooleanField(default=False)
    entity = models.CharField(max_length=200)
    old_value = models.CharField(max_length=300, blank=True, null=True)
    new_value = models.CharField(max_length=300, blank=True, null=True)

    class Meta:
        verbose_name = "Email Notification Log"
        verbose_name_plural = "Email Notification Logs"
        db_table = "email_notification_logs"
        ordering = ("-created_at",)


class NotificationPreferenceMigrationAudit(BaseModel):
    """Record preference rows consolidated before enforcing one row per user."""

    user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="notification_preference_migration_audits",
    )
    source_row_count = models.PositiveIntegerField()
    merged_disabled_fields = models.JSONField(default=list)

    class Meta:
        db_table = "notification_preference_migration_audits"
        ordering = ("-created_at",)


class NotificationGenerationOutbox(BaseModel):
    """Persist issue-activity generation requests beside the business write."""

    class Status(models.TextChoices):
        PENDING = "pending", "Pending"
        PROCESSING = "processing", "Processing"
        RETRY = "retry", "Waiting to retry"
        COMPLETED = "completed", "Completed"
        FAILED = "failed", "Failed"

    idempotency_key = models.CharField(max_length=255, unique=True)
    workspace = models.ForeignKey(
        "db.Workspace",
        on_delete=models.CASCADE,
        related_name="notification_generation_events",
        null=True,
    )
    payload = models.JSONField(default=dict)
    status = models.CharField(max_length=16, choices=Status.choices, default=Status.PENDING)
    available_at = models.DateTimeField(default=timezone.now)
    lease_until = models.DateTimeField(null=True)
    lease_token = models.CharField(max_length=64, blank=True, default="")
    attempts = models.PositiveSmallIntegerField(default=0)
    processed_at = models.DateTimeField(null=True)
    last_error_code = models.CharField(max_length=128, blank=True, default="")

    class Meta:
        db_table = "notification_generation_outbox"
        indexes = [
            models.Index(fields=["status", "available_at"], name="notif_gen_due_idx"),
            models.Index(fields=["status", "lease_until"], name="notif_gen_lease_idx"),
        ]


class NotificationEvent(BaseModel):
    """Persist one recipient-specific notification event for durable delivery."""

    class Category(models.TextChoices):
        PROPERTY_CHANGE = "property_change", "Property change"
        STATE_CHANGE = "state_change", "State change"
        COMMENT = "comment", "Comment"
        MENTION = "mention", "Mention"
        COMPLETION = "completion", "Completion"
        ASSIGNMENT = "assignment", "Assignment"
        RESEARCH_PROPERTY_CHANGE = "research_property_change", "Research property change"
        RESEARCH_STATE_CHANGE = "research_state_change", "Research state change"
        RESEARCH_COMMENT = "research_comment", "Research comment"
        RESEARCH_MENTION = "research_mention", "Research mention"
        RESEARCH_COMPLETION = "research_completion", "Research completion"
        RESEARCH_ACTION = "research_action", "Research action"

    event_key = models.UUIDField(default=uuid.uuid4, unique=True, editable=False)
    idempotency_key = models.CharField(max_length=255, unique=True)
    workspace = models.ForeignKey("db.Workspace", on_delete=models.CASCADE, related_name="notification_events")
    project = models.ForeignKey("db.Project", on_delete=models.CASCADE, null=True, related_name="notification_events")
    receiver = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="notification_events",
    )
    triggered_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        related_name="triggered_notification_events",
    )
    entity_name = models.CharField(max_length=255)
    entity_identifier = models.UUIDField(null=True)
    action = models.CharField(max_length=100)
    category = models.CharField(max_length=64, choices=Category.choices)
    recipient_reason = models.CharField(max_length=64, blank=True, default="")
    title = models.TextField()
    summary = models.TextField(blank=True, default="")
    route = models.CharField(max_length=1024, blank=True, default="")
    payload = models.JSONField(default=dict)
    immediate = models.BooleanField(default=False)
    notification = models.OneToOneField(
        "db.Notification",
        related_name="durable_event",
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
    )

    class Meta:
        db_table = "notification_events"
        indexes = [
            models.Index(fields=["receiver", "created_at"], name="notif_event_receiver_idx"),
            models.Index(fields=["workspace", "entity_name", "entity_identifier"], name="notif_event_entity_idx"),
        ]


class NotificationEmailDelivery(BaseModel):
    """Track durable SMTP delivery independently from in-app notification state."""

    class Status(models.TextChoices):
        PENDING = "pending", "Pending"
        PROCESSING = "processing", "Processing"
        RETRY = "retry", "Waiting to retry"
        ACCEPTED = "accepted", "Accepted by SMTP"
        SUPPRESSED = "suppressed", "Suppressed"
        FAILED = "failed", "Failed"
        UNCERTAIN = "uncertain", "Result uncertain"

    event = models.OneToOneField(
        NotificationEvent,
        on_delete=models.CASCADE,
        related_name="email_delivery",
    )
    source_log = models.OneToOneField(
        EmailNotificationLog,
        on_delete=models.SET_NULL,
        related_name="durable_delivery",
        null=True,
        blank=True,
    )
    status = models.CharField(max_length=16, choices=Status.choices, default=Status.PENDING)
    available_at = models.DateTimeField()
    lease_until = models.DateTimeField(null=True)
    lease_token = models.CharField(max_length=64, blank=True, default="")
    attempts = models.PositiveSmallIntegerField(default=0)
    smtp_accepted_at = models.DateTimeField(null=True)
    last_error_code = models.CharField(max_length=128, blank=True, default="")
    last_error_at = models.DateTimeField(null=True)

    class Meta:
        db_table = "notification_email_deliveries"
        indexes = [
            models.Index(fields=["status", "available_at"], name="notif_mail_due_idx"),
            models.Index(fields=["status", "lease_until"], name="notif_mail_lease_idx"),
        ]


class NotificationDeliveryAudit(BaseModel):
    """Retain operator actions after a delivery is retried or cleaned up."""

    workspace = models.ForeignKey(
        "db.Workspace",
        on_delete=models.CASCADE,
        related_name="notification_delivery_audits",
    )
    delivery = models.ForeignKey(
        NotificationEmailDelivery,
        on_delete=models.SET_NULL,
        related_name="audit_entries",
        null=True,
        blank=True,
    )
    delivery_identifier = models.UUIDField()
    event_identifier = models.UUIDField(null=True, blank=True)
    actor = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        related_name="notification_delivery_audits",
        null=True,
    )
    action = models.CharField(max_length=32)
    previous_status = models.CharField(max_length=16)
    new_status = models.CharField(max_length=16)
    reason = models.TextField()

    class Meta:
        db_table = "notification_delivery_audits"
        ordering = ("-created_at",)


class NotificationEmailCircuit(BaseModel):
    """Persist a shared SMTP circuit breaker state."""

    key = models.CharField(max_length=64, unique=True, default="smtp")
    opened_at = models.DateTimeField(null=True)
    reason_code = models.CharField(max_length=128, blank=True, default="")
    next_probe_at = models.DateTimeField(null=True)
    probe_lease_until = models.DateTimeField(null=True)
    probe_lease_token = models.CharField(max_length=64, blank=True, default="")

    class Meta:
        db_table = "notification_email_circuits"
