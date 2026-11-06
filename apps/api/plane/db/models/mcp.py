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
                        "plane_prepare_file_upload",
                        "plane_upload_markdown",
                        "plane_submit_paper_version",
                    ]
                ),
                name="unified_mcp_receipt_tool_ck",
            ),
        ]


class UnifiedMCPFileTransfer(BaseModel):
    """保存连接作用域内的文件传输、业务登记及恢复状态。"""

    connection = models.ForeignKey(UnifiedMCPConnection, on_delete=models.CASCADE, related_name="file_transfers")
    workspace = models.ForeignKey("db.Workspace", on_delete=models.CASCADE)
    direction = models.CharField(max_length=8)
    request_id = models.CharField(max_length=128, null=True, blank=True)
    request_hash = models.CharField(max_length=64, blank=True, default="")
    target = models.JSONField()
    location = models.CharField(max_length=32)
    file_ref = models.JSONField(default=dict)
    file_name = models.CharField(max_length=255, blank=True, default="")
    content_type = models.CharField(max_length=255, blank=True, default="")
    size = models.PositiveBigIntegerField(default=0)
    sha256 = models.CharField(max_length=64, blank=True, default="")
    received_bytes = models.PositiveBigIntegerField(default=0)
    state = models.CharField(max_length=24, default="RECEIVING", db_index=True)
    transport = models.CharField(max_length=16, blank=True, default="")
    staging_key = models.CharField(max_length=800, blank=True, default="")
    final_key = models.CharField(max_length=800, blank=True, default="")
    asset = models.ForeignKey("db.FileAsset", null=True, blank=True, on_delete=models.SET_NULL)
    result = models.JSONField(default=dict)
    error_code = models.CharField(max_length=128, blank=True, default="")
    worker_token = models.UUIDField(null=True, blank=True)
    lease_until = models.DateTimeField(null=True, blank=True)
    expires_at = models.DateTimeField(db_index=True)

    class Meta:
        db_table = "unified_mcp_file_transfers"
        constraints = [
            models.UniqueConstraint(
                fields=["connection", "workspace", "request_id"], name="unified_mcp_file_request_uq"
            ),
            models.CheckConstraint(condition=models.Q(direction__in=["upload", "download"]), name="mcp_file_direction_ck"),
        ]


class UnifiedMCPFileChunk(BaseModel):
    """记录已确认的上传块；字节内容保存在共享对象存储中。"""

    transfer = models.ForeignKey(UnifiedMCPFileTransfer, on_delete=models.CASCADE, related_name="chunks")
    offset = models.PositiveBigIntegerField()
    size = models.PositiveIntegerField()
    sha256 = models.CharField(max_length=64)
    object_key = models.CharField(max_length=800)

    class Meta:
        db_table = "unified_mcp_file_chunks"
        constraints = [models.UniqueConstraint(fields=["transfer", "offset"], name="unified_mcp_file_chunk_uq")]
