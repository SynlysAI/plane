"""Administrative approval records, independent of research workflows."""

import uuid
from django.db import models
from plane.db.models.base import BaseModel


class AdministrativeApprovalFlow(BaseModel):
    workspace = models.ForeignKey("db.Workspace", on_delete=models.CASCADE)
    organization = models.ForeignKey("db.AdministrativeOrganization", on_delete=models.PROTECT)
    family_id = models.UUIDField(default=uuid.uuid4)
    version = models.PositiveIntegerField(default=1)
    name = models.CharField(max_length=255)
    is_active = models.BooleanField(default=True)

    class Meta:
        db_table = "administrative_approval_flows"
        constraints = [models.UniqueConstraint(fields=["family_id", "version"], name="admin_flow_version_uq")]


class AdministrativeApprovalStep(BaseModel):
    flow = models.ForeignKey(AdministrativeApprovalFlow, on_delete=models.CASCADE, related_name="steps")
    order = models.PositiveSmallIntegerField()
    approver_kind = models.CharField(max_length=16, choices=[("ORG_ADMIN", "Organization admin"), ("USER", "User")])
    approver = models.ForeignKey("db.User", on_delete=models.PROTECT, null=True, blank=True)

    class Meta:
        db_table = "administrative_approval_steps"
        ordering = ["order"]
        constraints = [models.UniqueConstraint(fields=["flow", "order"], name="admin_step_order_uq")]


class AdministrativeProjectApprovalSetting(BaseModel):
    project = models.OneToOneField("db.Project", on_delete=models.CASCADE, related_name="administrative_approval_setting")
    flow = models.ForeignKey(AdministrativeApprovalFlow, on_delete=models.PROTECT)

    class Meta:
        db_table = "administrative_project_approval_settings"


class AdministrativeApprovalRequest(BaseModel):
    workspace = models.ForeignKey("db.Workspace", on_delete=models.CASCADE)
    project = models.ForeignKey("db.Project", on_delete=models.CASCADE)
    issue = models.ForeignKey("db.Issue", on_delete=models.CASCADE, related_name="administrative_approvals")
    flow = models.ForeignKey(AdministrativeApprovalFlow, on_delete=models.PROTECT, related_name="requests")
    requested_by = models.ForeignKey("db.User", on_delete=models.PROTECT, related_name="administrative_approval_requests")
    status = models.CharField(max_length=16, default="PENDING")
    current_step_order = models.PositiveSmallIntegerField(default=1)

    class Meta:
        db_table = "administrative_approval_requests"
        constraints = [models.UniqueConstraint(
            fields=["issue"], condition=models.Q(status="PENDING", deleted_at__isnull=True), name="admin_issue_pending_uq"
        )]
        indexes = [models.Index(fields=["workspace", "status"], name="admin_approval_ws_status_idx")]


class AdministrativeApprovalAction(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    request = models.ForeignKey(AdministrativeApprovalRequest, on_delete=models.CASCADE, related_name="actions")
    actor = models.ForeignKey("db.User", on_delete=models.PROTECT)
    step_order = models.PositiveSmallIntegerField()
    action = models.CharField(max_length=16)
    comment = models.TextField(default="", blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "administrative_approval_actions"
        ordering = ["created_at", "id"]
