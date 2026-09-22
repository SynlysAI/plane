"""Persistent grants for short-lived Research Context tokens."""

import uuid

from django.db import models

from plane.db.models.base import BaseModel


class ResearchContextGrant(BaseModel):
    """One short-lived, revocable grant issued by the Plane Context API."""

    context_id = models.UUIDField(default=uuid.uuid4, unique=True, editable=False)
    workspace = models.ForeignKey("db.Workspace", on_delete=models.CASCADE, related_name="research_context_grants")
    user = models.ForeignKey("db.User", on_delete=models.CASCADE, related_name="research_context_grants")
    project = models.ForeignKey("db.Project", on_delete=models.PROTECT, related_name="research_context_grants")
    chain_node = models.ForeignKey(
        "db.ResearchChainNode",
        on_delete=models.PROTECT,
        related_name="context_grants",
        null=True,
        blank=True,
    )
    visibility_scope = models.CharField(max_length=32, default="PRIVATE")
    context_hash = models.CharField(max_length=64)
    token_hash = models.CharField(max_length=64, unique=True)
    expires_at = models.DateTimeField(db_index=True)
    revoked_at = models.DateTimeField(null=True, blank=True)
    last_used_at = models.DateTimeField(null=True, blank=True)
    request_id = models.CharField(max_length=128, unique=True)

    class Meta:
        db_table = "research_context_grants"
        ordering = ("-created_at",)
        indexes = [
            models.Index(fields=["workspace", "user", "project"], name="rsch_ctx_ws_user_proj_idx"),
            models.Index(fields=["workspace", "revoked_at"], name="rsch_ctx_ws_revoked_idx"),
        ]

    def __str__(self):
        return str(self.context_id)
