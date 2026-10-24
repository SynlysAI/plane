# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details

"""Persistent discussion and explicit HITL feedback for periodic reports."""

from django.db import models
from django.utils import timezone

from plane.db.models.base import BaseModel


class PeriodicReportCommentThread(BaseModel):
    """A report discussion anchored to one immutable official snapshot."""

    class Status(models.TextChoices):
        OPEN = "OPEN", "Open"
        RESOLVED = "RESOLVED", "Resolved"

    report = models.ForeignKey(
        "db.PeriodicReport",
        on_delete=models.PROTECT,
        related_name="comment_threads",
    )
    anchor = models.JSONField(null=True, blank=True)
    quoted_text = models.TextField(blank=True, default="")
    snapshot_version = models.PositiveIntegerField()
    content_hash = models.CharField(max_length=64)
    status = models.CharField(max_length=16, choices=Status.choices, default=Status.OPEN)
    status_updated_at = models.DateTimeField(default=timezone.now)
    status_updated_by = models.ForeignKey(
        "db.User",
        on_delete=models.SET_NULL,
        related_name="research_report_threads_status_updated",
        null=True,
        blank=True,
    )
    last_activity_at = models.DateTimeField(default=timezone.now, db_index=True)

    class Meta:
        verbose_name = "Periodic Report Comment Thread"
        verbose_name_plural = "Periodic Report Comment Threads"
        db_table = "research_periodic_report_comment_threads"
        ordering = ("-last_activity_at", "-created_at")
        indexes = [
            models.Index(fields=["report", "status"], name="rsch_rct_report_status_idx"),
            models.Index(fields=["report", "snapshot_version"], name="rsch_rct_report_ver_idx"),
        ]

    def __str__(self):
        return f"{self.report_id} <{self.status}:{self.snapshot_version}>"


class PeriodicReportComment(BaseModel):
    """One sanitized rich-text contribution in a report comment thread."""

    class FeedbackType(models.TextChoices):
        DISCUSSION = "DISCUSSION", "Discussion"
        SUGGESTION = "SUGGESTION", "Suggestion"
        CORRECTION = "CORRECTION", "Correction"
        QUESTION = "QUESTION", "Question"
        APPROVAL = "APPROVAL", "Human approval"
        REJECTION = "REJECTION", "Human rejection"

    thread = models.ForeignKey(
        PeriodicReportCommentThread,
        on_delete=models.CASCADE,
        related_name="comments",
    )
    parent = models.ForeignKey(
        "self",
        on_delete=models.SET_NULL,
        related_name="replies",
        null=True,
        blank=True,
    )
    actor = models.ForeignKey(
        "db.User",
        on_delete=models.PROTECT,
        related_name="research_periodic_report_comments",
    )
    comment_html = models.TextField()
    comment_stripped = models.TextField()
    feedback_type = models.CharField(
        max_length=16,
        choices=FeedbackType.choices,
        default=FeedbackType.DISCUSSION,
    )
    edited_at = models.DateTimeField(null=True, blank=True)
    request_id = models.CharField(max_length=128)

    class Meta:
        verbose_name = "Periodic Report Comment"
        verbose_name_plural = "Periodic Report Comments"
        db_table = "research_periodic_report_comments"
        ordering = ("created_at", "id")
        constraints = [
            models.UniqueConstraint(
                fields=["thread", "actor", "request_id"],
                condition=models.Q(deleted_at__isnull=True),
                name="rsch_report_comment_request_uq",
            )
        ]
        indexes = [
            models.Index(fields=["thread", "created_at"], name="rsch_rc_thread_created_idx"),
        ]

    def __str__(self):
        return f"{self.thread_id} <{self.feedback_type}:{self.actor_id}>"


class PeriodicReportCommentFeedback(BaseModel):
    """An explicit, immutable human signal prepared for the AI plugin."""

    class Status(models.TextChoices):
        SUBMITTED = "SUBMITTED", "Submitted"
        CONSUMED = "CONSUMED", "Consumed"
        WITHDRAWN = "WITHDRAWN", "Withdrawn"

    comment = models.OneToOneField(
        PeriodicReportComment,
        on_delete=models.PROTECT,
        related_name="ai_feedback",
    )
    report = models.ForeignKey(
        "db.PeriodicReport",
        on_delete=models.PROTECT,
        related_name="comment_feedbacks",
    )
    thread = models.ForeignKey(
        PeriodicReportCommentThread,
        on_delete=models.PROTECT,
        related_name="feedbacks",
    )
    feedback_type = models.CharField(max_length=16, choices=PeriodicReportComment.FeedbackType.choices)
    status = models.CharField(max_length=16, choices=Status.choices, default=Status.SUBMITTED)
    payload = models.JSONField(default=dict)
    payload_hash = models.CharField(max_length=64)
    submitted_by = models.ForeignKey(
        "db.User",
        on_delete=models.PROTECT,
        related_name="research_report_comment_feedbacks",
    )
    submitted_at = models.DateTimeField(default=timezone.now)
    agent_session = models.ForeignKey(
        "db.ResearchAgentSession",
        on_delete=models.SET_NULL,
        related_name="report_comment_feedbacks",
        null=True,
        blank=True,
    )
    processed_at = models.DateTimeField(null=True, blank=True)
    last_error = models.TextField(blank=True, default="")

    class Meta:
        verbose_name = "Periodic Report Comment Feedback"
        verbose_name_plural = "Periodic Report Comment Feedback"
        db_table = "research_periodic_report_comment_fb"
        ordering = ("-submitted_at",)
        indexes = [
            models.Index(fields=["report", "status"], name="rsch_rcfb_report_status_idx"),
            models.Index(fields=["agent_session", "status"], name="rsch_rcfb_session_idx"),
        ]

    def __str__(self):
        return f"{self.report_id} <{self.feedback_type}:{self.status}>"
