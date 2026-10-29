# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Research collaboration notifications on the existing notification pipeline."""

from html import escape

from django.utils import timezone

from plane.db.models import Notification, ResearchTaskSubscriber, User
from plane.research.utils.acl import direct_advisor_ids

RESEARCH_CHAIN_TASK_ENTITY = "research_chain_task"
RESEARCH_PAPER_REVIEW_ENTITY = "research_paper_review"


def _notify(task, receivers, *, actor, action, title, extra=None, include_subscribers=True):
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
    receiver_users = {receiver.id: receiver for receiver in receivers if receiver is not None}
    if include_subscribers:
        receiver_users.update({receiver.id: receiver for receiver in task_subscriber_users(task)})

    created = []
    for receiver_id, receiver in receiver_users.items():
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


def task_subscriber_users(task):
    """Return active users persistently subscribed to a research task.

    Args:
        task: Research Chain node task whose subscribers are resolved.

    Returns:
        A list of active users receiving every subsequent task update.
    """
    from plane.research.services.chain_tasks import chain_assignable_user_ids

    candidate_ids = chain_assignable_user_ids(task.workspace, task.chain)
    return list(
        User.objects.filter(
            research_task_subscriptions__task_id=task.id,
            research_task_subscriptions__deleted_at__isnull=True,
            is_active=True,
            id__in=candidate_ids,
        ).distinct()
    )


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


def notify_task_completed(task, actor, comment=""):
    """Notify related participants that an assignee completed a task."""
    return _notify(
        task,
        [task.assigned_by],
        actor=actor,
        action="completed",
        title=f"科研节点任务已标记完成：{task.title}",
        extra={"comment": (comment or "")[:500]},
    )


def notify_task_reopened(task, actor, reason=""):
    """Notify related participants that an assignee reopened a task."""
    return _notify(
        task,
        [task.assigned_by],
        actor=actor,
        action="reopened",
        title=f"科研节点任务已回滚为未完成：{task.title}",
        extra={"reason": (reason or "")[:500]},
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


def notify_task_updated(task, actor, changed_fields):
    """Notify subscribers that editable task fields changed."""
    fields = sorted(set(changed_fields) - {"assignee"})
    if not fields:
        return []
    return _notify(
        task,
        [],
        actor=actor,
        action="updated",
        title=f"科研节点任务已更新：{task.title}",
        extra={"fields": fields},
    )


def notify_task_comment(task, actor, operation, comment_id=None):
    """Notify subscribers that a task comment was created, edited, or removed."""
    operation_labels = {
        "created": "有新评论",
        "updated": "评论已更新",
        "deleted": "评论已删除",
    }
    label = operation_labels.get(operation, "评论已更新")
    return _notify(
        task,
        [],
        actor=actor,
        action="commented",
        title=f"科研节点任务{label}：{task.title}",
        extra={"operation": operation, "comment_id": str(comment_id) if comment_id else None},
    )


def notify_task_cc_added(task, actor, receivers):
    """Tell newly carbon-copied members that they will receive task updates."""
    return _notify(
        task,
        receivers,
        actor=actor,
        action="cc_added",
        title=f"你已被加入科研节点任务通知：{task.title}",
        extra={"source": ResearchTaskSubscriber.Source.CC},
        include_subscribers=False,
    )


def _notify_paper(review, receivers, *, actor, action, title, extra=None):
    """Create paper-review notifications without a new delivery channel.

    Args:
        review: Paper review being changed.
        receivers: Users that should receive the transition.
        actor: User who performed the paper action.
        action: Stable notification action for clients.
        title: Short notification title.
        extra: Optional additional JSON metadata.

    Returns:
        The notification rows created for this action.
    """
    receiver_users = {
        receiver.id: receiver for receiver in receivers if receiver is not None and receiver.id != actor.id
    }
    rows = [
        Notification(
            workspace_id=review.workspace_id,
            project_id=review.chain.project_id,
            data={
                "chain_id": str(review.chain_id),
                "node_id": str(review.node_id),
                "review_id": str(review.id),
                "action": action,
                "status": review.status,
                "route": f"/research/paper-reviews/{review.id}",
                **(extra or {}),
            },
            entity_identifier=review.id,
            entity_name=RESEARCH_PAPER_REVIEW_ENTITY,
            title=title,
            message={"action": action, "status": review.status, "at": timezone.now().isoformat()},
            message_html=f"<p>{escape(title)}</p>",
            message_stripped=title,
            sender="research",
            triggered_by=actor,
            receiver=receiver_users[receiver_id],
        )
        for receiver_id in receiver_users
    ]
    if rows:
        Notification.objects.bulk_create(rows, batch_size=100)
    return rows


def notify_paper_version_submitted(review, actor):
    """Notify the direct advisor and explicit final reviewer."""
    receiver_ids = set(direct_advisor_ids(review.owner_id, review.workspace_id))
    if review.final_reviewer_id:
        receiver_ids.add(review.final_reviewer_id)
    receivers = User.objects.filter(id__in=receiver_ids, is_active=True)
    return _notify_paper(
        review,
        receivers,
        actor=actor,
        action="submitted",
        title="论文评审已提交新版本",
    )


def notify_paper_returned(review, actor, comment=""):
    """Notify the review owner that a version needs revision."""
    receiver = User.objects.filter(pk=review.owner_id, is_active=True).first()
    return _notify_paper(
        review,
        [receiver],
        actor=actor,
        action="returned",
        title="论文评审版本被退回",
        extra={"comment": (comment or "")[:500]},
    )


def notify_paper_accepted(review, actor, comment=""):
    """Notify the review owner, chain owner, and final reviewer."""
    receiver_ids = {review.owner_id, review.chain.owner_id, review.final_reviewer_id}
    receivers = User.objects.filter(id__in=receiver_ids, is_active=True)
    return _notify_paper(
        review,
        receivers,
        actor=actor,
        action="accepted",
        title="论文评审已最终确认",
        extra={"comment": (comment or "")[:500]},
    )
