# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Research collaboration notifications on the existing notification pipeline."""

from html import escape

from django.utils import timezone

from plane.db.models import Notification, OrgUnitMember, User
from plane.research.utils.acl import direct_advisor_ids, org_unit_ancestry
from plane.research.utils.org import active_membership_q

RESEARCH_CHAIN_TASK_ENTITY = "research_chain_task"


def _notify(task, receivers, *, actor, action, title, extra=None):
    """Create task notifications without introducing a new delivery channel.

    Args:
        task: Research Chain node task being changed.
        receivers: Users that should receive the state transition.
        actor: User who performed the action.
        action: Stable notification action for clients.
        title: Short notification title.
        extra: Optional additional JSON metadata.

    Returns:
        The notification rows created for this action.
    """
    created = []
    for receiver in receivers:
        if receiver is None or receiver.id == actor.id:
            continue
        created.append(
            Notification(
                workspace_id=task.workspace_id,
                project_id=task.chain.project_id,
                data={
                    "task_id": str(task.id),
                    "action": action,
                    "status": task.status,
                    **(extra or {}),
                },
                entity_identifier=task.id,
                entity_name=RESEARCH_CHAIN_TASK_ENTITY,
                title=title,
                message={"action": action, "status": task.status, "at": timezone.now().isoformat()},
                message_html=f"<p>{escape(title)}</p>",
                message_stripped=title,
                sender="research",
                triggered_by=actor,
                receiver=receiver,
            )
        )
    if created:
        Notification.objects.bulk_create(created, batch_size=100)
    return created


def task_reviewer_users(task):
    """Resolve users holding the research review capability for a task.

    Args:
        task: Research Chain node task awaiting review.

    Returns:
        Active direct advisors, the main PI, and managing ancestor members.
    """
    workspace_id = task.workspace_id
    profile = getattr(task.chain.project, "research_profile", None)
    org_unit_id = getattr(profile, "org_unit_id", None)
    receiver_ids = set(direct_advisor_ids(task.chain.owner_id, workspace_id, org_unit_id))
    setting = task.chain.project.workspace.research_setting
    if setting.main_pi_id:
        receiver_ids.add(setting.main_pi_id)
    if org_unit_id:
        unit_ids = [org_unit_id, *org_unit_ancestry(org_unit_id, workspace_id)]
        receiver_ids.update(
            OrgUnitMember.objects.filter(
                active_membership_q(),
                workspace_id=workspace_id,
                org_unit_id__in=unit_ids,
                org_role__in=("OWNER", "PI", "UNIT_ADMIN"),
            ).values_list("user_id", flat=True)
        )
    receiver_ids.discard(task.chain.owner_id)
    return list(User.objects.filter(id__in=receiver_ids, is_active=True))


def notify_task_assigned(task, actor):
    """Notify a newly assigned user."""
    receiver = User.objects.filter(pk=task.assignee_id, is_active=True).first()
    return _notify(
        task,
        [receiver],
        actor=actor,
        action="assigned",
        title=f"科研节点任务已指派：{task.title}",
    )


def notify_task_submitted(task, actor):
    """Notify research reviewers that a task is awaiting review."""
    return _notify(
        task,
        task_reviewer_users(task),
        actor=actor,
        action="submitted",
        title=f"科研节点任务已提交：{task.title}",
    )


def notify_task_returned(task, actor, reason=""):
    """Notify the assignee that a submitted task needs revision."""
    receiver = User.objects.filter(pk=task.assignee_id, is_active=True).first()
    return _notify(
        task,
        [receiver],
        actor=actor,
        action="returned",
        title=f"科研节点任务被退回：{task.title}",
        extra={"reason": (reason or "")[:500]},
    )


def notify_task_completed(task, actor, comment=""):
    """Notify the assignee that a task has been accepted."""
    receiver = User.objects.filter(pk=task.assignee_id, is_active=True).first()
    return _notify(
        task,
        [receiver],
        actor=actor,
        action="completed",
        title=f"科研节点任务已完成：{task.title}",
        extra={"comment": (comment or "")[:500]},
    )


def notify_task_cancelled(task, actor, reason=""):
    """Notify the assignee that an open task has been cancelled."""
    receiver_user_id = task.assignee_id or task.created_by_id
    receiver = User.objects.filter(pk=receiver_user_id, is_active=True).first()
    return _notify(
        task,
        [receiver],
        actor=actor,
        action="cancelled",
        title=f"科研节点任务已取消：{task.title}",
        extra={"reason": (reason or "")[:500]},
    )
