"""Notification-member projection and writes for research node tasks."""

from uuid import UUID

from django.db import transaction
from django.utils import timezone

from plane.db.models import ResearchTaskSubscriber, User
from plane.research.services.chain_tasks import (
    ChainTaskPermissionError,
    ChainTaskValidationError,
    _candidate_items,
    actor_can_manage_chain_tasks,
)
from plane.research.utils.audit import ResearchAuditAction, ResearchResourceType, record_audit_event
from plane.research.utils.collaboration_notifications import notify_task_cc_added

NOTIFICATION_RECIPIENTS_SCHEMA_VERSION = "task-notification-recipients.v1"


def _user_projection(user):
    """Project one selectable user without account-sensitive fields."""
    return {
        "id": str(user.id),
        "display_name": user.display_name or user.username or user.email,
        "email": user.email,
        "avatar_url": user.avatar_url,
    }


def _candidates(workspace, chain):
    """Build searchable candidates and their stable display groups."""
    items = _candidate_items(workspace, chain)
    users = {
        user.id: user
        for user in User.objects.filter(
            id__in=[UUID(item["user_id"]) for item in items],
            is_active=True,
        )
    }
    groups = {}
    candidates = []
    for item in items:
        user = users.get(UUID(item["user_id"]))
        if user is None:
            continue
        group_id = item["org_unit_id"] or "collaborators"
        group_name = item["org_unit_name"] or "跨组织协作者"
        if group_id not in groups:
            groups[group_id] = group_name
        candidate = _user_projection(user)
        candidate["group_ids"] = [group_id]
        candidates.append(candidate)
    return {
        "groups": [
            {"id": group_id, "name": group_name}
            for group_id, group_name in sorted(groups.items(), key=lambda entry: entry[1])
        ],
        "candidates": candidates,
    }


def _subscriptions(task):
    """Return active subscription rows attached to one task."""
    return list(
        task.notification_subscribers.select_related("subscriber").filter(deleted_at__isnull=True)
    )


def _recipient_payload(workspace, chain, task, actor):
    """Build the versioned notification-member response for one task."""
    rows = _subscriptions(task)
    candidate_ids = {item["user_id"] for item in _candidate_items(workspace, chain)}
    fixed_ids = {
        row.subscriber_id
        for row in rows
        if row.source == ResearchTaskSubscriber.Source.SELF and str(row.subscriber_id) in candidate_ids
    }
    cc_ids = {
        row.subscriber_id
        for row in rows
        if row.source == ResearchTaskSubscriber.Source.CC and str(row.subscriber_id) in candidate_ids
    }
    if task.assignee_id:
        if str(task.assignee_id) in candidate_ids:
            fixed_ids.add(task.assignee_id)

    payload = {
        "schema_version": NOTIFICATION_RECIPIENTS_SCHEMA_VERSION,
        **_candidates(workspace, chain),
        "selected_user_ids": [str(user_id) for user_id in sorted(fixed_ids | cc_ids)],
        "cc_user_ids": [str(user_id) for user_id in sorted(cc_ids)],
        "fixed_user_ids": [str(user_id) for user_id in sorted(fixed_ids)],
        "recipient_user_ids": [str(user_id) for user_id in sorted(fixed_ids | cc_ids)],
        "current_user_subscribed": actor.id in fixed_ids or actor.id in cc_ids,
        "current_user_self_subscribed": actor.id in fixed_ids,
        "can_manage": actor_can_manage_chain_tasks(workspace, chain, actor),
    }
    return payload


def research_task_notification_recipients(workspace, chain, task, actor):
    """Return notification candidates and current recipients for a visible task."""
    return _recipient_payload(workspace, chain, task, actor)


def replace_research_task_cc(*, workspace, chain, task, actor, user_ids, request=None):
    """Replace only carbon-copy rows while preserving self subscriptions.

    Args:
        workspace: Workspace owning the research chain.
        chain: Research chain owning the task.
        task: Research Chain node task to update.
        actor: User requesting the update.
        user_ids: Desired carbon-copy user IDs.
        request: Optional HTTP request used for audit metadata.

    Returns:
        The refreshed ``task-notification-recipients.v1`` payload.

    Raises:
        ChainTaskPermissionError: When the actor cannot manage chain tasks.
        ChainTaskValidationError: When a requested user is outside the candidate boundary.
    """
    if not actor_can_manage_chain_tasks(workspace, chain, actor):
        raise ChainTaskPermissionError("Only chain writers can manage task notification members.")
    if not isinstance(user_ids, list):
        raise ChainTaskValidationError("user_ids must be an array of UUIDs.")

    candidate_ids = {item["user_id"] for item in _candidate_items(workspace, chain)}
    desired = []
    seen = set()
    for value in user_ids:
        user_id = str(value)
        if user_id not in candidate_ids:
            raise ChainTaskValidationError("One or more notification members are outside the chain boundary.")
        if user_id not in seen:
            seen.add(user_id)
            desired.append(user_id)
    desired_ids = set(desired)

    with transaction.atomic():
        locked_task = type(task).objects.select_for_update().get(pk=task.pk)
        rows = _subscriptions(locked_task)
        existing_ids = {row.subscriber_id for row in rows}
        current_cc_ids = {
            row.subscriber_id for row in rows if row.source == ResearchTaskSubscriber.Source.CC
        }
        added_ids = desired_ids - existing_ids
        removed_ids = current_cc_ids - desired_ids

        if added_ids or removed_ids:
            ResearchTaskSubscriber.objects.filter(
                task=locked_task,
                subscriber_id__in=removed_ids,
                source=ResearchTaskSubscriber.Source.CC,
                deleted_at__isnull=True,
            ).update(deleted_at=timezone.now(), updated_at=timezone.now(), updated_by=actor)

            ResearchTaskSubscriber.objects.bulk_create(
                [
                    ResearchTaskSubscriber(
                        workspace=workspace,
                        task=locked_task,
                        subscriber_id=user_id,
                        source=ResearchTaskSubscriber.Source.CC,
                        created_by=actor,
                        updated_by=actor,
                    )
                    for user_id in sorted(added_ids)
                ],
                batch_size=100,
            )
            record_audit_event(
                workspace=workspace,
                actor=actor,
                action=ResearchAuditAction.TASK_NOTIFICATION_MEMBERS_UPDATE,
                resource_type=ResearchResourceType.RESEARCH_CHAIN_NODE_TASK,
                resource_id=locked_task.pk,
                metadata={
                    "added": [str(user_id) for user_id in sorted(added_ids)],
                    "removed": [str(user_id) for user_id in sorted(removed_ids)],
                },
                request=request,
            )
            if added_ids:
                added_users = User.objects.filter(id__in=added_ids, is_active=True)
                notify_task_cc_added(locked_task, actor, added_users)

    return _recipient_payload(workspace, chain, task, actor)


def set_research_task_self_subscription(*, workspace, chain, task, actor, subscribed):
    """Toggle only the current user's self subscription for one task."""
    with transaction.atomic():
        locked_task = type(task).objects.select_for_update().get(pk=task.pk)
        if subscribed:
            if not locked_task.notification_subscribers.filter(
                subscriber=actor, deleted_at__isnull=True
            ).exists():
                ResearchTaskSubscriber.objects.create(
                    workspace=workspace,
                    task=locked_task,
                    subscriber=actor,
                    source=ResearchTaskSubscriber.Source.SELF,
                    created_by=actor,
                    updated_by=actor,
                )
        else:
            locked_task.notification_subscribers.filter(
                subscriber=actor,
                source=ResearchTaskSubscriber.Source.SELF,
                deleted_at__isnull=True,
            ).update(deleted_at=timezone.now(), updated_at=timezone.now(), updated_by=actor)
    return _recipient_payload(workspace, chain, task, actor)
