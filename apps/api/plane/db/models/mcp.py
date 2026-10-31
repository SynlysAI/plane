"""One revocable machine identity with an explicit, validated workspace scope."""

from django.db import models

from plane.db.models.base import BaseModel


class UnifiedMCPConnection(BaseModel):
    owner = models.ForeignKey("db.User", on_delete=models.CASCADE, related_name="unified_mcp_connections")
    name = models.CharField(max_length=100)
    token_hash = models.CharField(max_length=64, unique=True)
    token_encrypted = models.TextField(blank=True, default="")
    scope = models.JSONField()
    expires_at = models.DateTimeField(db_index=True, null=True, blank=True)
    revoked_at = models.DateTimeField(null=True, blank=True)
    last_used_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        db_table = "unified_mcp_connections"
        indexes = [models.Index(fields=["owner", "created_at"], name="unified_mcp_owner_created_idx")]


class UnifiedMCPWriteResult(BaseModel):
    """Commit receipts for retry-sensitive creates/comments, never approval tickets."""

    connection = models.ForeignKey(UnifiedMCPConnection, on_delete=models.CASCADE, related_name="write_results")
    workspace = models.ForeignKey("db.Workspace", on_delete=models.CASCADE)
    request_id = models.CharField(max_length=128)
    tool = models.CharField(max_length=64)
    request_hash = models.CharField(max_length=64)
    object_type = models.CharField(max_length=32)
    object_id = models.UUIDField()
    issue_id = models.UUIDField(null=True, blank=True)
    result = models.JSONField()

    class Meta:
        db_table = "unified_mcp_write_results"
        constraints = [
            models.UniqueConstraint(
                fields=["connection", "workspace", "request_id"], name="unified_mcp_write_request_uq"
            ),
            models.CheckConstraint(
                condition=models.Q(
                    tool__in=[
                        "plane_create_task",
                        "plane_add_comment",
                        "plane_create_project",
                        "plane_create_research_project",
                        "plane_create_research_chain",
                        "plane_create_research_node",
                    ]
                ),
                name="unified_mcp_receipt_tool_ck",
            ),
        ]
