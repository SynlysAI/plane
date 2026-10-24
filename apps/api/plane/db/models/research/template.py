# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

from django.db import models
from django.db.models import Q

from plane.db.models.base import BaseModel


def get_default_template_content():
    return {"type": "doc", "content": []}


def get_default_template_sections():
    return {"version": 1, "guidance": "", "sections": []}


class ReportTemplate(BaseModel):
    """Weekly / monthly report template (P0-CFG-05).

    The template body reuses the Page rich-text structure so it can be handed to
    the shared editor without a second document format.
    """

    REPORT_TYPE_CHOICES = (("WEEKLY", "Weekly"), ("MONTHLY", "Monthly"))

    class Scope(models.TextChoices):
        REPORT = "REPORT", "Report"
        STAGE_MATERIAL = "STAGE_MATERIAL", "Stage material"
        EXPERIMENT = "EXPERIMENT", "Experiment"

    # Variables a template may declare; an unresolved variable blocks the
    # material from being written into the stage (P1-OPN-08).
    TEMPLATE_VARIABLES = ("user", "period", "project", "stage", "advisor", "org_unit")

    workspace = models.ForeignKey(
        "db.Workspace",
        on_delete=models.CASCADE,
        related_name="research_report_templates",
    )
    report_type = models.CharField(max_length=16, choices=REPORT_TYPE_CHOICES)
    name = models.CharField(max_length=255)
    content_json = models.JSONField(default=get_default_template_content, blank=True)
    is_default = models.BooleanField(default=False)
    is_active = models.BooleanField(default=True)
    scope = models.CharField(max_length=24, choices=Scope.choices, default=Scope.REPORT)
    material_type = models.CharField(max_length=48, blank=True, default="")
    stage = models.CharField(max_length=16, blank=True, default="")
    variables = models.JSONField(default=list, blank=True)
    sections_json = models.JSONField(default=get_default_template_sections, blank=True)
    target_key = models.CharField(max_length=128, default="", editable=False, db_index=True)

    class Meta:
        verbose_name = "Research Report Template"
        verbose_name_plural = "Research Report Templates"
        db_table = "research_report_templates"
        ordering = ("target_key", "name")
        constraints = [
            models.UniqueConstraint(
                fields=["workspace", "target_key", "name"],
                condition=Q(deleted_at__isnull=True),
                name="rsch_template_uq_ws_target_name",
            ),
            models.UniqueConstraint(
                fields=["workspace", "target_key"],
                condition=Q(is_default=True, deleted_at__isnull=True),
                name="rsch_template_uq_target_default",
            ),
        ]
        indexes = [
            models.Index(fields=["workspace", "report_type"], name="rsch_template_ws_type_idx"),
        ]

    def __str__(self):
        return f"{self.report_type} <{self.name}>"

    def save(self, *args, **kwargs):
        """保存前同步目标键，并让结构化章节生成稳定正文。"""
        from plane.research.utils.templates import sections_to_content, template_target_key

        self.target_key = template_target_key(
            self.scope,
            report_type=self.report_type,
            stage=self.stage,
            material_type=self.material_type,
        )
        if self.sections_json and self.sections_json.get("sections"):
            self.content_json = sections_to_content(self.sections_json)
        super().save(*args, **kwargs)
