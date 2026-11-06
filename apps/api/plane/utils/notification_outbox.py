# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Persist issue notification snapshots and their durable email work."""

import hashlib
import json
from datetime import timedelta
from collections import defaultdict

from django.db import transaction
from django.utils import timezone

from plane.db.models import (
    EmailNotificationLog,
    Notification,
    NotificationEmailDelivery,
    NotificationEvent,
    Project,
    WorkspaceNotificationPolicy,
    Workspace,
)


def issue_notification_category(activity, issue_data, reason=""):
    """Resolve the email preference category for one issue activity."""
    field = activity.get("field")
    if reason == "mentioned" or field == "mention":
        return NotificationEvent.Category.MENTION
    if field == "assignees":
        return NotificationEvent.Category.ASSIGNMENT
    if field == "comment":
        return NotificationEvent.Category.COMMENT
    if field == "state":
        if issue_data.get("state_group") == "completed":
            return NotificationEvent.Category.COMPLETION
        return NotificationEvent.Category.STATE_CHANGE
    return NotificationEvent.Category.PROPERTY_CHANGE


def workspace_policy_map(workspace_ids):
    """Load channel policies for several workspaces with safe defaults.

    Args:
        workspace_ids: Workspace IDs that may appear in a notification batch.

    Returns:
        A mapping of workspace ID to category-specific enabled-channel flags.
    """
    policies = defaultdict(lambda: defaultdict(lambda: {"in_app_enabled": True, "email_enabled": True}))
    rows = WorkspaceNotificationPolicy.objects.filter(
        workspace_id__in=workspace_ids,
        deleted_at__isnull=True,
    ).values("workspace_id", "category", "in_app_enabled", "email_enabled")
    for row in rows:
        policies[row["workspace_id"]][row["category"]] = {
            "in_app_enabled": row["in_app_enabled"] or row["category"] in {"mention", "research_mention"},
            "email_enabled": row["email_enabled"],
        }
    return policies


def _event_key(entity_name, entity_id, receiver_id, activity_id, category, fallback):
    """Build a stable key for the same recipient-specific source activity."""
    identity = activity_id or json.dumps(fallback, sort_keys=True, default=str, separators=(",", ":"))
    source = f"{entity_name}:{entity_id}:{receiver_id}:{identity}:{category}"
    return hashlib.sha256(source.encode("utf-8")).hexdigest()


def _notification_values(notification):
    """Copy concrete notification fields while letting the model set timestamps."""
    return {
        field.attname: getattr(notification, field.attname)
        for field in Notification._meta.concrete_fields
        if field.name not in {"created_at", "updated_at", "deleted_at"}
    }


def _event_defaults(notification, category, reason, route, immediate):
    """Build the immutable event snapshot associated with an inbox row."""
    data = notification.data or {}
    activity = data.get("issue_activity") or {}
    return {
        "workspace_id": notification.workspace_id,
        "project_id": notification.project_id,
        "receiver_id": notification.receiver_id,
        "triggered_by_id": notification.triggered_by_id,
        "entity_name": notification.entity_name,
        "entity_identifier": notification.entity_identifier,
        "action": activity.get("verb")
        or (notification.message.get("action", "updated") if isinstance(notification.message, dict) else "updated"),
        "category": category,
        "recipient_reason": reason,
        "title": notification.title,
        "summary": activity.get("new_value") or notification.title,
        "route": route,
        "payload": data,
        "immediate": immediate,
    }


@transaction.atomic
def persist_issue_notification_batch(notifications, email_logs):
    """Write issue inbox events and email delivery snapshots idempotently.

    Args:
        notifications: Unsaved inbox notifications for one issue activity batch.
        email_logs: Unsaved email snapshots matching those notifications.
    """
    project_id = notifications[0].project_id if notifications else None
    project = Project.objects.select_related("workspace").filter(pk=project_id).first() if project_id else None
    policies = workspace_policy_map([project.workspace_id] if project else [])

    for notification in notifications:
        data = notification.data or {}
        activity = data.get("issue_activity") or {}
        issue_data = data.get("issue") or {}
        reason = str(notification.sender or "subscribed").rsplit(":", 1)[-1]
        category = issue_notification_category(activity, issue_data, reason)
        channel_policy = policies[notification.workspace_id][category]
        if not channel_policy["in_app_enabled"] and not channel_policy["email_enabled"]:
            continue
        activity_id = activity.get("id")
        key = _event_key(
            notification.entity_name,
            notification.entity_identifier,
            notification.receiver_id,
            activity_id,
            category,
            data,
        )
        route = (
            f"/{project.workspace.slug}/projects/{project.pk}/issues/{notification.entity_identifier}"
            if project
            else ""
        )
        if data.get("comment_id"):
            route += f"#comment-{data['comment_id']}"
        notification.data = {**data, "route": route}
        event, created = NotificationEvent.objects.get_or_create(
            idempotency_key=key,
            defaults=_event_defaults(
                notification,
                category,
                reason,
                route,
                immediate=category in (NotificationEvent.Category.ASSIGNMENT, NotificationEvent.Category.MENTION),
            ),
        )
        if created:
            workspace_policy = policies[notification.workspace_id][category]
            if workspace_policy["in_app_enabled"]:
                inbox_row = Notification.objects.create(**_notification_values(notification))
                NotificationEvent.objects.filter(pk=event.pk).update(notification=inbox_row)
                notification.pk = inbox_row.pk
        elif event.notification_id:
            notification.pk = event.notification_id

    for email_log in email_logs:
        data = email_log.data or {}
        activity = data.get("issue_activity") or {}
        issue_data = data.get("issue") or {}
        activity_id = activity.get("id")
        categories = {issue_notification_category(activity, issue_data)}
        if activity.get("field") == "description":
            categories.add(NotificationEvent.Category.MENTION)
        event_keys = [
            _event_key(
                email_log.entity_name,
                email_log.entity_identifier,
                email_log.receiver_id,
                activity_id,
                category,
                data,
            )
            for category in categories
        ]
        candidates = {
            candidate.category: candidate
            for candidate in NotificationEvent.objects.filter(idempotency_key__in=event_keys)
        }
        primary_category = issue_notification_category(activity, issue_data)
        event = next(
            (
                candidates[category]
                for category in (NotificationEvent.Category.MENTION, primary_category)
                if category in candidates and policies[candidates[category].workspace_id][category]["email_enabled"]
            ),
            None,
        )
        if event is None:
            continue
        delivery, delivery_created = NotificationEmailDelivery.objects.get_or_create(
            event=event,
            defaults={
                "status": NotificationEmailDelivery.Status.PENDING,
                "available_at": email_log.available_at or timezone.now(),
            },
        )
        if delivery_created:
            source_log = EmailNotificationLog.objects.create(
                receiver_id=email_log.receiver_id,
                triggered_by_id=email_log.triggered_by_id,
                entity_identifier=email_log.entity_identifier,
                entity_name=email_log.entity_name,
                data=email_log.data,
                available_at=delivery.available_at,
                immediate=email_log.immediate,
                entity=email_log.entity,
                old_value=email_log.old_value,
                new_value=email_log.new_value,
            )
            delivery.source_log = source_log
            delivery.save(update_fields=["source_log", "updated_at"])


def _research_route(notification, data, workspace_slug):
    """Resolve a server-relative link from the notification's entity snapshot."""
    route = data.get("href") or data.get("route")
    if route:
        if not route.startswith("/") or route.startswith("//"):
            return ""
        return f"/{workspace_slug}{route}" if route.startswith("/research/") else route
    if data.get("issue_id"):
        return f"/{workspace_slug}/projects/{notification.project_id}/issues/{data['issue_id']}?tab=approvals"
    if data.get("report_id"):
        query = (
            f"?thread={data['thread_id']}&comment={data['comment_id']}"
            if data.get("thread_id") and data.get("comment_id")
            else ""
        )
        return f"/{workspace_slug}/research/reports/{data['report_id']}{query}"
    if data.get("experiment_id"):
        if data.get("amendment_id"):
            return (
                f"/{workspace_slug}/research/chains?view=experiments"
                f"&experiment={data['experiment_id']}&amendment={data['amendment_id']}"
            )
        return f"/{workspace_slug}/research/chains?view=experiments&experiment={data['experiment_id']}"
    if data.get("task_id") and data.get("chain_id"):
        query = f"node={data['node_id']}&task={data['task_id']}" if data.get("node_id") else f"task={data['task_id']}"
        if data.get("comment_id"):
            query += f"&comment={data['comment_id']}"
        return f"/{workspace_slug}/research/chains/{data['chain_id']}?{query}"
    if data.get("stage_id") and data.get("chain_id"):
        stage_code = str(data.get("stage_code") or "").lower()
        suffix = f"&stage={stage_code}" if stage_code else ""
        return f"/{workspace_slug}/research/chains/{data['chain_id']}?tab=nodes{suffix}"
    if data.get("stage_id") and data.get("stage"):
        stage_code = str(data["stage"]).lower()
        return f"/{workspace_slug}/research/projects/{notification.project_id}/stages/{stage_code}"
    if data.get("chain_id"):
        return f"/{workspace_slug}/research/chains/{data['chain_id']}"
    if notification.entity_name == "issue":
        return f"/{workspace_slug}/projects/{notification.project_id}/issues/{notification.entity_identifier}"
    return f"/{workspace_slug}/research"


def _research_category(category, action, reason):
    """Resolve generic research actions to the preference category they represent."""
    if category != NotificationEvent.Category.RESEARCH_ACTION:
        return category
    if reason in {"mentioned", "mention"} or "mention" in str(action).lower():
        return NotificationEvent.Category.RESEARCH_MENTION
    action = str(action).lower()
    if action.startswith("comment") or action == "commented":
        return NotificationEvent.Category.RESEARCH_COMMENT
    if action in {"completed", "accepted", "passed", "amendment_approved"}:
        return NotificationEvent.Category.RESEARCH_COMPLETION
    if action in {"submitted", "returned", "withdrawn", "reopened", "cancelled", "escalated", "amendment_rejected"}:
        return NotificationEvent.Category.RESEARCH_STATE_CHANGE
    return NotificationEvent.Category.RESEARCH_PROPERTY_CHANGE


@transaction.atomic
def persist_research_notification_batch(notifications, *, category, email_policy=None):
    """Persist research inbox events and selected durable email deliveries.

    Args:
        notifications: Unsaved inbox notifications for a research action.
        category: Default preference category for each event.
        email_policy: Optional receiver-id keyed email delivery policy.
    """
    email_policy = email_policy or {}
    workspace_ids = {notification.workspace_id for notification in notifications}
    workspace_slugs = dict(Workspace.objects.filter(pk__in=workspace_ids).values_list("id", "slug"))
    policies = workspace_policy_map(workspace_ids)

    for notification in notifications:
        data = notification.data if isinstance(notification.data, dict) else {}
        message = notification.message if isinstance(notification.message, dict) else {}
        action = data.get("action") or message.get("action") or "updated"
        receiver_key = str(notification.receiver_id)
        policy = email_policy.get(receiver_key)
        event_category = _research_category(
            (policy or {}).get("category", category),
            action,
            (policy or {}).get("reason", "research"),
        )
        channel_policy = policies[notification.workspace_id][event_category]
        if not channel_policy["in_app_enabled"] and not channel_policy["email_enabled"]:
            continue
        stable_data = dict(data)
        stable_data.pop("at", None)
        identity_payload = {
            "action": action,
            "category": event_category,
            "data": stable_data,
            "title": notification.title,
        }
        key = _event_key(
            notification.entity_name,
            notification.entity_identifier,
            receiver_key,
            data.get("event_id"),
            event_category,
            identity_payload,
        )
        workspace_slug = workspace_slugs.get(notification.workspace_id, "")
        route = _research_route(notification, data, workspace_slug)
        notification.data = {**data, "route": route}
        event, created = NotificationEvent.objects.get_or_create(
            idempotency_key=key,
            defaults={
                "workspace_id": notification.workspace_id,
                "project_id": notification.project_id,
                "receiver_id": notification.receiver_id,
                "triggered_by_id": notification.triggered_by_id,
                "entity_name": notification.entity_name,
                "entity_identifier": notification.entity_identifier,
                "action": action,
                "category": event_category,
                "recipient_reason": (policy or {}).get("reason", "research"),
                "title": notification.title,
                "summary": str(data.get("summary") or notification.title)[:2000],
                "route": route,
                "payload": data,
                "immediate": bool((policy or {}).get("immediate", False)),
            },
        )
        if created:
            if policies[notification.workspace_id][event_category]["in_app_enabled"]:
                inbox_row = Notification.objects.create(**_notification_values(notification))
                NotificationEvent.objects.filter(pk=event.pk).update(notification=inbox_row)
        if policy and policies[notification.workspace_id][event_category]["email_enabled"]:
            NotificationEmailDelivery.objects.get_or_create(
                event=event,
                defaults={
                    "status": NotificationEmailDelivery.Status.PENDING,
                    "available_at": timezone.now()
                    if policy.get("immediate")
                    else timezone.now() + timedelta(minutes=5),
                },
            )
