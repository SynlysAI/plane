"""Independent, personal weekly-report capabilities and immutable proposals."""

from django.db import models
from plane.db.models.base import BaseModel


def weekly_actions():
    return ["save_draft"]


class ReportAgentGrant(BaseModel):
    workspace = models.ForeignKey("db.Workspace", on_delete=models.PROTECT)
    user = models.ForeignKey("db.User", on_delete=models.PROTECT)
    purpose = models.CharField(max_length=24, default="weekly_report", editable=False)
    report_type = models.CharField(max_length=16, default="WEEKLY", editable=False)
    label = models.CharField(max_length=100)
    allowed_actions = models.JSONField(default=weekly_actions)
    period_policy = models.CharField(max_length=64, default="current_and_previous_week.v1")
    token_hash = models.CharField(max_length=64, unique=True)
    token_encrypted = models.TextField(blank=True, default="")
    expires_at = models.DateTimeField(db_index=True, null=True, blank=True)
    revoked_at = models.DateTimeField(null=True, blank=True)
    last_used_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        db_table = "research_report_agent_grants"
        constraints = [
            models.CheckConstraint(
                condition=models.Q(purpose="weekly_report", report_type="WEEKLY"), name="rsch_report_grant_purpose"
            )
        ]
        indexes = [models.Index(fields=["workspace", "user", "created_at"], name="rsch_report_grant_user_idx")]


class ReportAgentOperation(BaseModel):
    workspace = models.ForeignKey("db.Workspace", on_delete=models.PROTECT)
    user = models.ForeignKey("db.User", on_delete=models.PROTECT)
    grant = models.ForeignKey(ReportAgentGrant, on_delete=models.PROTECT)
    report = models.ForeignKey("db.PeriodicReport", on_delete=models.PROTECT, null=True, blank=True)
    request_id = models.CharField(max_length=128)
    action = models.CharField(max_length=16)
    period_key = models.CharField(max_length=16)
    payload = models.JSONField(default=dict)
    expected_revision = models.CharField(max_length=2048)
    preconditions = models.JSONField(default=dict)
    request_hash = models.CharField(max_length=64)
    proposal_hash = models.CharField(max_length=64)
    expires_at = models.DateTimeField()
    status = models.CharField(max_length=20, default="PROPOSED")
    result = models.JSONField(default=dict)
    failure = models.JSONField(null=True, blank=True)

    class Meta:
        db_table = "research_report_agent_operations"
        constraints = [
            models.UniqueConstraint(fields=["workspace", "user", "request_id"], name="rsch_report_agent_request_uq")
        ]
        indexes = [models.Index(fields=["grant", "created_at"], name="rsch_report_op_grant_idx")]
