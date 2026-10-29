# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Submission-scoped approval routing for research objects."""

from django.db import models
from django.db.models import Q

from plane.db.models.base import BaseModel


class ResearchApprovalRoute(BaseModel):
    """One immutable routing decision for a submitted research object."""

    class ResourceType(models.TextChoices):
        PERIODIC_REPORT = "PERIODIC_REPORT", "Periodic report"

    class Status(models.TextChoices):
        ACTIVE = "ACTIVE", "Active"
        SUPERSEDED = "SUPERSEDED", "Superseded"

    class ReviewerRole(models.TextChoices):
        PRIMARY_ADVISOR = "PRIMARY_ADVISOR", "Primary advisor"
        ADVISOR = "ADVISOR", "Direct advisor"
        MAIN_PI = "MAIN_PI", "Main principal investigator"
        UNIT_OWNER = "UNIT_OWNER", "Unit owner"
        UNIT_PI = "UNIT_PI", "Unit principal investigator"
        UNIT_ADMIN = "UNIT_ADMIN", "Unit administrator"

    workspace = models.ForeignKey(
        "db.Workspace",
        on_delete=models.PROTECT,
        related_name="research_approval_routes",
    )
    resource_type = models.CharField(max_length=32, choices=ResourceType.choices, db_index=True)
    resource_id = models.UUIDField(db_index=True)
    submitted_by = models.ForeignKey(
        "db.User",
        on_delete=models.PROTECT,
        related_name="submitted_research_approval_routes",
    )
    reviewer = models.ForeignKey(
        "db.User",
        on_delete=models.PROTECT,
        related_name="reviewing_research_approval_routes",
    )
    reviewer_role = models.CharField(max_length=32, choices=ReviewerRole.choices)
    cc_user_ids = models.JSONField(default=list, blank=True)
    candidate_snapshot = models.JSONField(default=list, blank=True)
    status = models.CharField(max_length=16, choices=Status.choices, default=Status.ACTIVE, db_index=True)
    request_id = models.CharField(max_length=128, unique=True)
    superseded_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        verbose_name = "Research Approval Route"
        verbose_name_plural = "Research Approval Routes"
        db_table = "research_approval_routes"
        ordering = ("created_at", "id")
        indexes = [
            models.Index(fields=["workspace", "resource_type", "resource_id"], name="rsch_route_resource_idx"),
            models.Index(fields=["reviewer", "status"], name="rsch_route_reviewer_idx"),
            models.Index(fields=["status", "superseded_at"], name="rsch_route_status_idx"),
        ]
        constraints = [
            models.UniqueConstraint(
                fields=["resource_type", "resource_id"],
                condition=Q(status="ACTIVE", deleted_at__isnull=True),
                name="rsch_route_one_active_uq",
            ),
        ]

    def __str__(self):
        return f"{self.resource_type} <{self.resource_id}> {self.reviewer_role}"
