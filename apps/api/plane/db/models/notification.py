# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

# Django imports
from django.conf import settings
from django.db import models

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

    class Meta:
        verbose_name = "UserNotificationPreference"
        verbose_name_plural = "UserNotificationPreferences"
        db_table = "user_notification_preferences"
        ordering = ("-created_at",)

    def __str__(self):
        """Return the user"""
        return f"<{self.user}>"


class EmailNotificationLog(BaseModel):
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
    entity = models.CharField(max_length=200)
    old_value = models.CharField(max_length=300, blank=True, null=True)
    new_value = models.CharField(max_length=300, blank=True, null=True)

    class Meta:
        verbose_name = "Email Notification Log"
        verbose_name_plural = "Email Notification Logs"
        db_table = "email_notification_logs"
        ordering = ("-created_at",)
