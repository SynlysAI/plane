"""Durable, node-scoped Agent proposals; approval is separate from machine auth."""

from django.db import models

from plane.db.models.base import BaseModel


class ResearchAgentWriteGrant(BaseModel):
    context = models.OneToOneField("db.ResearchContextGrant", on_delete=models.PROTECT, related_name="write_grant")
    allowed_actions = models.JSONField(default=list)
    agent_label = models.CharField(max_length=100, default="Local Agent")

    class Meta:
        db_table = "research_agent_write_grants"


class ResearchAgentOperation(BaseModel):
    workspace = models.ForeignKey("db.Workspace", on_delete=models.PROTECT)
    user = models.ForeignKey("db.User", on_delete=models.PROTECT)
    node = models.ForeignKey("db.ResearchChainNode", on_delete=models.PROTECT)
    original_grant = models.ForeignKey("db.ResearchAgentWriteGrant", on_delete=models.PROTECT, null=True, blank=True)
    original_connection = models.ForeignKey("db.UnifiedMCPConnection", on_delete=models.PROTECT, null=True, blank=True)
    request_id = models.CharField(max_length=128)
    action = models.CharField(max_length=40)
    payload = models.JSONField(default=dict)
    source_refs = models.JSONField(default=list)
    preconditions = models.JSONField(default=dict)
    proposal_hash = models.CharField(max_length=64)
    request_hash = models.CharField(max_length=64)
    agent_label = models.CharField(max_length=100)
    expires_at = models.DateTimeField()
    status = models.CharField(max_length=20, default="PROPOSED")
    result = models.JSONField(default=dict)

    class Meta:
        db_table = "research_agent_operations"
        constraints = [
            models.UniqueConstraint(fields=["workspace", "user", "request_id"], name="rsch_op_request_uq"),
            models.CheckConstraint(
                condition=(
                    models.Q(original_grant__isnull=False, original_connection__isnull=True)
                    | models.Q(original_grant__isnull=True, original_connection__isnull=False)
                ),
                name="rsch_op_one_source_ck",
            ),
        ]
        indexes = [models.Index(fields=["node", "user", "created_at"], name="rsch_op_node_user_idx")]


class ResearchAgentOperationApproval(BaseModel):
    operation = models.OneToOneField(ResearchAgentOperation, on_delete=models.PROTECT, related_name="approval")
    actor = models.ForeignKey("db.User", on_delete=models.PROTECT)
    proposal_hash = models.CharField(max_length=64)
    decision = models.CharField(max_length=16)
    expires_at = models.DateTimeField()

    class Meta:
        db_table = "research_agent_operation_approvals"
