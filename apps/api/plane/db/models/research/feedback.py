# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Plane-native research feedback records and screenshot registrations."""

from django.db import models
from django.db.models import Q

from plane.db.models.base import BaseModel


class ResearchFeedback(BaseModel):
    """A user feedback item owned and managed by a Plane workspace."""

    class FeedbackType(models.TextChoices):
        BUG = "bug", "Bug"
        UX = "ux", "User experience"
        IDEA = "idea", "Idea"
        OTHER = "other", "Other"

    class FeedbackStatus(models.TextChoices):
        OPEN = "open", "Open"
        IN_PROGRESS = "in_progress", "In progress"
        DONE = "done", "Done"
        CLOSED = "closed", "Closed"

    workspace = models.ForeignKey(
        "db.Workspace",
        on_delete=models.PROTECT,
        related_name="research_feedbacks",
    )
    org_unit = models.ForeignKey(
        "db.OrgUnit",
        on_delete=models.SET_NULL,
        related_name="research_feedbacks",
        null=True,
        blank=True,
    )
    username = models.CharField(max_length=100)
    feedback_type = models.CharField(max_length=16, choices=FeedbackType.choices)
    content = models.TextField()
    path = models.CharField(max_length=2048, default="/")
    browser = models.CharField(max_length=500, blank=True, default="")
    module = models.CharField(max_length=100, default="plane")
    status = models.CharField(max_length=16, choices=FeedbackStatus.choices, default=FeedbackStatus.OPEN)
    idempotency_key = models.CharField(max_length=128)
    payload_hash = models.CharField(max_length=64)
    legacy_feedback_id = models.CharField(max_length=64, null=True, blank=True)

    class Meta:
        verbose_name = "Research Feedback"
        verbose_name_plural = "Research Feedback"
        db_table = "research_feedbacks"
        ordering = ("-created_at",)
        constraints = [
            models.UniqueConstraint(
                fields=["workspace", "created_by", "idempotency_key"],
                condition=Q(deleted_at__isnull=True),
                name="rsch_fb_uq_idempotency",
            ),
            models.UniqueConstraint(
                fields=["workspace", "legacy_feedback_id"],
                condition=Q(legacy_feedback_id__isnull=False, deleted_at__isnull=True),
                name="rsch_fb_uq_legacy",
            ),
        ]
        indexes = [
            models.Index(fields=["workspace", "created_at"], name="rsch_fb_ws_created_idx"),
            models.Index(
                fields=["workspace", "org_unit", "status", "created_at"],
                name="rsch_fb_ws_org_status_idx",
            ),
            models.Index(fields=["workspace", "created_by", "created_at"], name="rsch_fb_ws_user_idx"),
        ]

    def __str__(self):
        return f"{self.workspace_id} <{self.feedback_type}:{self.status}>"


class ResearchFeedbackScreenshot(BaseModel):
    """An ordered screenshot asset registration owned by a feedback item."""

    feedback = models.ForeignKey(
        ResearchFeedback,
        on_delete=models.CASCADE,
        related_name="screenshots",
    )
    asset = models.ForeignKey(
        "db.FileAsset",
        on_delete=models.PROTECT,
        related_name="research_feedback_screenshots",
    )
    position = models.PositiveSmallIntegerField(default=0)

    class Meta:
        verbose_name = "Research Feedback Screenshot"
        verbose_name_plural = "Research Feedback Screenshots"
        db_table = "research_feedback_screenshots"
        ordering = ("position", "created_at")
        constraints = [
            models.UniqueConstraint(fields=["feedback", "asset"], name="rsch_fb_shot_uq_asset"),
        ]
        indexes = [
            models.Index(fields=["feedback", "position"], name="rsch_fb_shot_feedback_idx"),
        ]

    def __str__(self):
        return f"{self.feedback_id} <{self.asset_id}>"
