# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

from django.db import models
from django.db.models import Q

from plane.db.models.base import BaseModel

from .report import PeriodicReport
from .task import ResearchChainNodeTask, ResearchTaskComment


class ReportAttachment(BaseModel):
    """Attachment registered against a report (P0-FILE-02).

    The file itself lives in the shared ``FileAsset`` + S3 pipeline, so report
    attachments never introduce a second storage path.
    """

    class Kind(models.TextChoices):
        IMAGE = "IMAGE", "Image"
        PDF = "PDF", "PDF"
        MARKDOWN = "MARKDOWN", "Markdown"
        OFFICE = "OFFICE", "Office document"
        OTHER = "OTHER", "Other"

    report = models.ForeignKey(
        PeriodicReport,
        on_delete=models.CASCADE,
        related_name="attachments",
    )
    asset = models.ForeignKey(
        "db.FileAsset",
        on_delete=models.CASCADE,
        related_name="research_report_attachments",
    )
    kind = models.CharField(max_length=16, choices=Kind.choices, default=Kind.OTHER)
    file_name = models.CharField(max_length=255, blank=True, default="")
    file_size = models.BigIntegerField(default=0)
    content_type = models.CharField(max_length=255, blank=True, default="")
    uploaded_by = models.ForeignKey(
        "db.User",
        on_delete=models.SET_NULL,
        related_name="research_report_attachments",
        null=True,
    )
    official_version_no = models.PositiveIntegerField(null=True, blank=True, db_index=True)

    class Meta:
        verbose_name = "Report Attachment"
        verbose_name_plural = "Report Attachments"
        db_table = "research_report_attachments"
        ordering = ("-created_at",)
        constraints = [
            models.UniqueConstraint(
                fields=["report", "asset"],
                condition=Q(deleted_at__isnull=True),
                name="rsch_attachment_uq_report_asset",
            ),
        ]
        indexes = [
            models.Index(fields=["report", "kind"], name="rsch_attachment_report_idx"),
        ]

    def __str__(self):
        return f"{self.file_name} <{self.report_id}>"


class ResearchTaskCommentAttachment(BaseModel):
    """File asset attached to a research task comment."""

    comment = models.ForeignKey(
        ResearchTaskComment,
        on_delete=models.CASCADE,
        related_name="attachments",
    )
    asset = models.ForeignKey(
        "db.FileAsset",
        on_delete=models.CASCADE,
        related_name="research_task_comment_attachments",
    )
    file_name = models.CharField(max_length=500, blank=True, default="")
    file_size = models.BigIntegerField(default=0)
    content_type = models.CharField(max_length=255, blank=True, default="")
    uploaded_by = models.ForeignKey(
        "db.User",
        on_delete=models.SET_NULL,
        related_name="research_task_comment_attachments",
        null=True,
    )

    class Meta:
        verbose_name = "Research Task Comment Attachment"
        verbose_name_plural = "Research Task Comment Attachments"
        db_table = "research_task_comment_attachments"
        ordering = ("created_at", "id")
        constraints = [
            models.UniqueConstraint(
                fields=["comment", "asset"],
                condition=Q(deleted_at__isnull=True),
                name="rsch_task_comment_attachment_uq",
            ),
        ]
        indexes = [
            models.Index(fields=["comment", "asset"], name="rsch_task_comment_att_idx"),
        ]

    def __str__(self):
        return f"{self.file_name} <{self.comment_id}>"


class ResearchChainNodeTaskAttachment(BaseModel):
    """File asset attached directly to a research task description."""

    task = models.ForeignKey(
        ResearchChainNodeTask,
        on_delete=models.CASCADE,
        related_name="instruction_attachments",
    )
    asset = models.ForeignKey(
        "db.FileAsset",
        on_delete=models.CASCADE,
        related_name="research_task_instruction_attachments",
    )
    file_name = models.CharField(max_length=500, blank=True, default="")
    file_size = models.BigIntegerField(default=0)
    content_type = models.CharField(max_length=255, blank=True, default="")
    uploaded_by = models.ForeignKey(
        "db.User",
        on_delete=models.SET_NULL,
        related_name="research_task_instruction_attachments",
        null=True,
    )

    class Meta:
        verbose_name = "Research Chain Node Task Attachment"
        verbose_name_plural = "Research Chain Node Task Attachments"
        db_table = "research_chain_node_task_attachments"
        ordering = ("created_at", "id")
        constraints = [
            models.UniqueConstraint(
                fields=["task", "asset"],
                condition=Q(deleted_at__isnull=True),
                name="rsch_task_instruction_attachment_uq",
            ),
        ]
        indexes = [
            models.Index(fields=["task", "asset"], name="rsch_task_instr_att_idx"),
        ]

    def __str__(self):
        return f"{self.file_name} <{self.task_id}>"
