"""Workspace project navigation categories.

Categories are presentation metadata only. They never grant access to a
project and are deliberately separate from the research organisation tree.
"""

from django.db import models
from django.db.models import Q

from plane.db.models.base import BaseModel


class ProjectNavigationCategory(BaseModel):
    """A user-managed navigation category for one project channel."""

    class Scope(models.TextChoices):
        RESEARCH = "RESEARCH", "Research projects"
        ADMINISTRATIVE = "ADMINISTRATIVE", "Administrative projects"

    workspace = models.ForeignKey(
        "db.Workspace", on_delete=models.PROTECT, related_name="project_navigation_categories"
    )
    # Channel scope is intentionally separate from Project business type.
    name = models.CharField(max_length=255)
    scope = models.CharField(max_length=24, choices=Scope.choices)
    # Parent is another custom navigation category, never an OrgUnit FK.
    parent = models.ForeignKey(
        "self", on_delete=models.PROTECT, null=True, blank=True, related_name="children"
    )
    # Optional org anchor lets a research root be displayed under one org node.
    org_unit = models.ForeignKey(
        "db.OrgUnit", on_delete=models.PROTECT, null=True, blank=True, related_name="navigation_categories"
    )
    sort_order = models.FloatField(default=65535)

    class Meta:
        db_table = "project_navigation_categories"
        ordering = ("sort_order", "name", "created_at")
        constraints = [
            models.UniqueConstraint(
                fields=["workspace", "scope", "parent", "name"],
                condition=Q(deleted_at__isnull=True),
                name="nav_category_workspace_scope_parent_name_uq",
            ),
            models.UniqueConstraint(
                fields=["workspace", "scope", "name"],
                condition=Q(parent__isnull=True, deleted_at__isnull=True),
                name="nav_category_root_name_uq",
            ),
            models.UniqueConstraint(
                fields=["workspace", "scope", "parent", "name"],
                condition=Q(parent__isnull=False, deleted_at__isnull=True),
                name="nav_category_child_name_uq",
            ),
        ]
        indexes = [
            models.Index(fields=["workspace", "scope", "parent", "sort_order"], name="nav_category_tree_idx"),
        ]

    def __str__(self):
        return f"{self.scope}: {self.name}"
