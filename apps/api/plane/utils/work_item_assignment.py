"""Single-assignee persistence for Plane work items."""

from django.db import transaction

from crum import get_current_user
from rest_framework.exceptions import ValidationError

from plane.db.models import (
    AdministrativeApprovalAction,
    AdministrativeApprovalRequest,
    DraftIssue,
    DraftIssueAssignee,
    Issue,
    Project,
    IssueAssignee,
)
from plane.utils.administrative_projects import administrative_project_filter, assignable_project_member_ids


ASSIGNMENT_APPROVAL_COMMENT = "负责人指派后自动完成审批。"


def validate_single_assignee(assignees, field_name):
    """Reject assignment payloads that contain more than one responsible user.

    Args:
        assignees: Parsed user instances or identifiers from the request.
        field_name: Serializer field reported to API clients.

    Raises:
        ValidationError: 如果请求包含多名负责人。
    """
    if assignees is not None and len(assignees) > 1:
        raise ValidationError({field_name: "每个工作项只能指定一名负责人。"})


def replace_issue_assignee(issue, assignee_id, *, actor=None):
    """Replace an Issue owner and close a pending administrative approval.

    Args:
        issue: Work item whose owner is being replaced.
        assignee_id: New owner ID, or ``None`` to clear the owner.
        actor: User performing the assignment for approval audit records.
    """
    with transaction.atomic():
        Issue.objects.select_for_update().get(pk=issue.pk)
        actor = actor or get_current_user()
        if assignee_id is not None and not assignable_project_member_ids(issue.project).filter(id=assignee_id).exists():
            raise ValidationError({"assignee_ids": "负责人不是当前项目的有效成员。"})
        current_ids = list(IssueAssignee.objects.filter(issue=issue).values_list("assignee_id", flat=True))
        if current_ids == ([assignee_id] if assignee_id else []):
            if assignee_id is not None:
                _complete_administrative_approval(issue, actor)
            return
        IssueAssignee.objects.filter(issue=issue).delete()
        if assignee_id is not None:
            IssueAssignee.objects.create(
                issue=issue,
                assignee_id=assignee_id,
                project_id=issue.project_id,
                workspace_id=issue.workspace_id,
                created_by_id=getattr(actor, "id", None) or issue.created_by_id,
                updated_by_id=getattr(actor, "id", None) or issue.updated_by_id,
            )
            _complete_administrative_approval(issue, actor)


def replace_draft_issue_assignee(draft_issue, assignee_id, *, actor=None):
    """Replace a DraftIssue owner while preserving the array-based API contract.

    Args:
        draft_issue: Draft work item whose owner is being replaced.
        assignee_id: New owner ID, or ``None`` to clear the owner.
        actor: User performing the update.
    """
    with transaction.atomic():
        DraftIssue.objects.select_for_update().get(pk=draft_issue.pk)
        actor = actor or get_current_user()
        if (
            assignee_id is not None
            and not assignable_project_member_ids(draft_issue.project).filter(id=assignee_id).exists()
        ):
            raise ValidationError({"assignee_ids": "负责人不是当前项目的有效成员。"})
        DraftIssueAssignee.objects.filter(draft_issue=draft_issue).delete()
        if assignee_id is not None:
            DraftIssueAssignee.objects.create(
                draft_issue=draft_issue,
                assignee_id=assignee_id,
                project_id=draft_issue.project_id,
                workspace_id=draft_issue.workspace_id,
                created_by_id=getattr(actor, "id", None) or draft_issue.created_by_id,
                updated_by_id=getattr(actor, "id", None) or draft_issue.updated_by_id,
            )


def _complete_administrative_approval(issue, actor):
    """Approve one pending administrative request after a direct assignment."""
    if not Project.objects.filter(pk=issue.project_id).filter(administrative_project_filter()).exists():
        return
    approval = AdministrativeApprovalRequest.objects.select_for_update().filter(issue=issue, status="PENDING").first()
    if approval is None:
        return
    if actor is None or not getattr(actor, "is_authenticated", False):
        raise ValidationError("完成行政审批需要记录当前指派人。")
    approval.status = "APPROVED"
    approval.save(update_fields=["status", "updated_at"])
    AdministrativeApprovalAction.objects.create(
        request=approval,
        actor=actor,
        step_order=approval.current_step_order,
        action="APPROVE",
        comment=ASSIGNMENT_APPROVAL_COMMENT,
    )
