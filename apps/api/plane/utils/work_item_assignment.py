"""Single-assignee persistence for Plane work items."""

from django.db import transaction

from crum import get_current_user
from rest_framework.exceptions import ValidationError

from plane.db.models import (
    DraftIssue,
    DraftIssueAssignee,
    Issue,
    IssueAssignee,
)
from plane.utils.administrative_projects import assignable_project_member_ids


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
    """Replace the single owner of a work item.

    Args:
        issue: Work item whose owner is being replaced.
        assignee_id: New owner ID, or ``None`` to clear the owner.
        actor: User performing the update.
    """
    with transaction.atomic():
        Issue.objects.select_for_update().get(pk=issue.pk)
        actor = actor or get_current_user()
        if assignee_id is not None and not assignable_project_member_ids(issue.project).filter(id=assignee_id).exists():
            raise ValidationError({"assignee_ids": "负责人不是当前项目的有效成员。"})
        current_ids = list(IssueAssignee.objects.filter(issue=issue).values_list("assignee_id", flat=True))
        if current_ids == ([assignee_id] if assignee_id else []):
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
