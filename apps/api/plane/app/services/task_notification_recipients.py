"""Notification-member projection and writes for administrative work items."""

from uuid import UUID

from django.db import transaction
from django.utils import timezone

from plane.db.models import IssueSubscriber, User
from plane.db.models.project import ROLE
from plane.utils.administrative_projects import effective_project_member, project_member_roster

NOTIFICATION_RECIPIENTS_SCHEMA_VERSION = "task-notification-recipients.v1"


def _candidate_payload(project):
    """Build administrative project candidates grouped by membership source."""
    roster = project_member_roster(project)
    user_ids = [UUID(row["member"]) for row in roster]
    users = {user.id: user for user in User.objects.filter(id__in=user_ids, is_active=True)}
    candidates = []
    for row in roster:
        user = users.get(UUID(row["member"]))
        if user is None:
            continue
        group_ids = ["project-members"]
        if row["inherits_organization"]:
            group_ids.append("organization-members")
        candidates.append(
            {
                "id": str(user.id),
                "display_name": user.display_name or user.username or user.email,
                "email": user.email,
                "avatar_url": user.avatar_url,
                "group_ids": group_ids,
            }
        )
    candidates.sort(key=lambda item: item["display_name"].lower())
    return {
        "groups": [
            {"id": "project-members", "name": "项目成员"},
            {"id": "organization-members", "name": "组织成员"},
        ],
        "candidates": candidates,
    }


def _candidate_ids(project):
    """Return the server-authoritative selectable user IDs."""
    return {row["member"] for row in project_member_roster(project)}


def _can_manage(project, actor):
    member = effective_project_member(actor, project.workspace.slug, project.id)
    return bool(member is not None and member.role >= ROLE.MEMBER.value)


def _rows(issue):
    return list(
        issue.issue_subscribers.select_related("subscriber").filter(deleted_at__isnull=True)
    )


def _payload(project, issue, actor):
    """Build the versioned notification-member response for one work item."""
    rows = _rows(issue)
    candidate_ids = _candidate_ids(project)
    fixed_ids = {
        row.subscriber_id
        for row in rows
        if row.source in (IssueSubscriber.Source.SYSTEM, IssueSubscriber.Source.SELF)
        and str(row.subscriber_id) in candidate_ids
    }
    cc_ids = {
        row.subscriber_id
        for row in rows
        if row.source == IssueSubscriber.Source.CC and str(row.subscriber_id) in candidate_ids
    }
    fixed_ids.update(
        user_id
        for user_id in issue.assignees.values_list("id", flat=True)
        if str(user_id) in candidate_ids
    )

    return {
        "schema_version": NOTIFICATION_RECIPIENTS_SCHEMA_VERSION,
        **_candidate_payload(project),
        "selected_user_ids": [str(user_id) for user_id in sorted(fixed_ids | cc_ids)],
        "cc_user_ids": [str(user_id) for user_id in sorted(cc_ids)],
        "fixed_user_ids": [str(user_id) for user_id in sorted(fixed_ids)],
        "recipient_user_ids": [str(user_id) for user_id in sorted(fixed_ids | cc_ids)],
        "current_user_subscribed": actor.id in fixed_ids or actor.id in cc_ids,
        "current_user_self_subscribed": any(
            row.subscriber_id == actor.id and row.source == IssueSubscriber.Source.SELF for row in rows
        ),
        "can_manage": _can_manage(project, actor),
    }


def issue_notification_recipients(project, issue, actor):
    """Return notification candidates and recipients for an administrative issue."""
    return _payload(project, issue, actor)


def replace_issue_cc(*, project, issue, actor, user_ids):
    """Replace carbon-copy subscriptions while preserving system and self rows."""
    if not isinstance(user_ids, list):
        raise ValueError("user_ids must be an array of UUIDs.")
    candidate_ids = _candidate_ids(project)
    desired = []
    seen = set()
    for value in user_ids:
        user_id = str(value)
        if user_id not in candidate_ids:
            raise ValueError("One or more notification members are outside the project boundary.")
        if user_id not in seen:
            seen.add(user_id)
            desired.append(user_id)
    desired_ids = set(desired)

    with transaction.atomic():
        type(issue).objects.select_for_update().get(pk=issue.pk)
        rows = _rows(issue)
        existing_ids = {row.subscriber_id for row in rows}
        current_cc_ids = {row.subscriber_id for row in rows if row.source == IssueSubscriber.Source.CC}
        added_ids = desired_ids - existing_ids
        removed_ids = current_cc_ids - desired_ids

        if added_ids or removed_ids:
            IssueSubscriber.objects.filter(
                issue=issue,
                subscriber_id__in=removed_ids,
                source=IssueSubscriber.Source.CC,
                deleted_at__isnull=True,
            ).update(deleted_at=timezone.now(), updated_at=timezone.now(), updated_by=actor)
            IssueSubscriber.objects.bulk_create(
                [
                    IssueSubscriber(
                        workspace=project.workspace,
                        project=project,
                        issue=issue,
                        subscriber_id=user_id,
                        source=IssueSubscriber.Source.CC,
                        created_by=actor,
                        updated_by=actor,
                    )
                    for user_id in sorted(added_ids)
                ],
                batch_size=100,
            )
    return _payload(project, issue, actor)


def set_issue_self_subscription(*, project, issue, actor, subscribed):
    """Toggle only the current user's self subscription."""
    with transaction.atomic():
        type(issue).objects.select_for_update().get(pk=issue.pk)
        if subscribed:
            if not issue.issue_subscribers.filter(subscriber=actor, deleted_at__isnull=True).exists():
                IssueSubscriber.objects.create(
                    workspace=project.workspace,
                    project=project,
                    issue=issue,
                    subscriber=actor,
                    source=IssueSubscriber.Source.SELF,
                    created_by=actor,
                    updated_by=actor,
                )
        else:
            issue.issue_subscribers.filter(
                subscriber=actor,
                source=IssueSubscriber.Source.SELF,
                deleted_at__isnull=True,
            ).update(deleted_at=timezone.now(), updated_at=timezone.now(), updated_by=actor)
    return _payload(project, issue, actor)
