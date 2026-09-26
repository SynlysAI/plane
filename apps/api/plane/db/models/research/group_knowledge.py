"""Shared knowledge-base binding for one research team."""

from django.db import models
from django.db.models import Q

from plane.db.models.base import BaseModel
from plane.db.models.research.knowledge_request import ResearchKnowledgeRequest


class ResearchGroupKnowledgeBinding(BaseModel):
    """One administrator-managed WeKnora knowledge base shared by a team."""

    State = ResearchKnowledgeRequest.State

    workspace = models.ForeignKey(
        "db.Workspace", on_delete=models.CASCADE, related_name="research_group_knowledge_bindings"
    )
    org_unit = models.ForeignKey(
        "db.OrgUnit", on_delete=models.PROTECT, related_name="group_knowledge_bindings"
    )
    request_key = models.CharField(max_length=128, unique=True)
    state = models.CharField(max_length=32, choices=State.choices, default=State.PENDING_ADMIN)
    external_kb_id = models.CharField(max_length=128, blank=True, default="")
    external_kb_name = models.CharField(max_length=255, blank=True, default="")
    parameter_summary = models.JSONField(default=dict, blank=True)
    rejection_reason = models.TextField(blank=True, default="")
    last_error = models.TextField(blank=True, default="")
    processed_by = models.ForeignKey(
        "db.User",
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="processed_research_group_knowledge_bindings",
    )
    processed_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        db_table = "research_group_knowledge_bindings"
        ordering = ("-created_at",)
        constraints = [
            models.UniqueConstraint(
                fields=["workspace", "org_unit"],
                condition=Q(deleted_at__isnull=True),
                name="rsch_grp_kb_ws_unit_uq",
            ),
        ]
        indexes = [
            models.Index(fields=["workspace", "state"], name="rsch_grp_kb_ws_state_idx"),
            models.Index(fields=["external_kb_id"], name="rsch_grp_kb_external_idx"),
        ]
