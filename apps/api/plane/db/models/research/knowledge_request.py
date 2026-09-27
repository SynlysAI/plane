"""Plane projection of a per research chain knowledge base request."""

from django.db import models

from plane.db.models.base import BaseModel


class ResearchKnowledgeRequest(BaseModel):
    """Track administrator managed RAGPortal binding for one Chain."""

    class State(models.TextChoices):
        REQUESTED = "REQUESTED", "Requested"
        PENDING_ADMIN = "PENDING_ADMIN", "Pending administrator"
        NEEDS_INFO = "NEEDS_INFO", "Needs information"
        REJECTED = "REJECTED", "Rejected"
        CREATED_PENDING_BINDING = "CREATED_PENDING_BINDING", "Created pending binding"
        READY = "READY", "Ready"
        FAILED = "FAILED", "Failed"
        ARCHIVED = "ARCHIVED", "Archived"
        RESTORE_PENDING = "RESTORE_PENDING", "Restore pending"

    workspace = models.ForeignKey("db.Workspace", on_delete=models.CASCADE, related_name="research_knowledge_requests")
    chain = models.OneToOneField("db.ResearchChain", on_delete=models.PROTECT, related_name="knowledge_request")
    request_key = models.CharField(max_length=128, unique=True)
    state = models.CharField(max_length=32, choices=State.choices, default=State.REQUESTED)
    external_kb_id = models.CharField(max_length=128, blank=True, default="")
    external_kb_name = models.CharField(max_length=255, blank=True, default="")
    parameter_summary = models.JSONField(default=dict, blank=True)
    rejection_reason = models.TextField(blank=True, default="")
    last_error = models.TextField(blank=True, default="")
    processed_by = models.ForeignKey(
        "db.User", on_delete=models.SET_NULL, null=True, blank=True, related_name="processed_research_knowledge_requests"
    )
    processed_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        db_table = "research_knowledge_requests"
        ordering = ("-created_at",)
        indexes = [
            models.Index(fields=["workspace", "state"], name="rsch_kb_req_ws_state_idx"),
            models.Index(fields=["external_kb_id"], name="rsch_kb_req_external_idx"),
        ]
