# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Unified inbox projection for notifications and actionable research todos."""

import base64
import hashlib
import json
import logging
from datetime import datetime, timezone as datetime_timezone

from django.utils import timezone

from plane.db.models import InboxTodoState

logger = logging.getLogger("plane.api")

INBOX_SCHEMA_VERSION = "inbox.v1"
TODO_TO_ENTITY = {
    "CHAIN_TASK": "research_chain_task",
    "REPORT": "research_report",
    "PAPER_REVIEW": "research_paper_review",
    "STAGE_REVIEW": "research_stage_review",
}
TODO_ENTITY_ALIASES = {
    ("STAGE_REVIEW", "research_stage"),
}
REVIEW_ENTITY_NAMES = {
    "research_paper_review",
    "research_stage_review",
    "research_stage",
    "research_report",
}
APPROVAL_ENTITY_NAMES = {"research_approval"}
APPROVAL_TODO_SOURCES = {
    "AGENT_APPROVAL",
    "OFFICE_APPROVAL",
    "CHAIN_STAGE_APPROVAL",
}
INBOX_TABS = frozenset({"all", "mentions", "todos", "approvals", "reviews", "system"})


def collect_inbox_todos(workspace, user):
    """Collect the current user's actionable research todos.

    Args:
        workspace: Workspace whose todo projection is requested.
        user: Receiver whose ACL-filtered todos are required.

    Returns:
        A ``(todos, degraded_sources)`` tuple from the canonical collector.
    """
    from plane.research.services.research_todos import collect_research_todos

    return collect_research_todos(workspace, user, "to_me")


def todo_payload_hash(todo):
    """Build a stable fingerprint for todo changes that need attention.

    Args:
        todo: One ``research-todo.v2`` envelope.

    Returns:
        A SHA-256 digest of the mutable handling fields.
    """
    fingerprint = {
        "business_status": todo.get("business_status"),
        "handling_status": todo.get("handling_status"),
        "next_action": todo.get("next_action"),
        "due_at": todo.get("due_at"),
        "updated_at": todo.get("updated_at"),
        "assignees": todo.get("assignees"),
    }
    encoded = json.dumps(fingerprint, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def todo_dedupe_key(todo):
    """Return the stable inbox key for one projected todo.

    Args:
        todo: One ``research-todo.v2`` envelope.

    Returns:
        A ``todo:<source>:<object_id>`` identifier.
    """
    return f"todo:{todo['source']}:{todo['object_id']}"


def synchronize_todo_states(workspace, user, todos):
    """Create or refresh presentation state for projected todos.

    Args:
        workspace: Workspace owning the inbox.
        user: Receiver whose states should be synchronized.
        todos: Current ACL-filtered todo envelopes.

    Returns:
        States keyed by ``(source, object_id)``.
    """
    states = {}
    now = timezone.now()
    for todo in todos:
        source = todo["source"]
        object_id = str(todo["object_id"])
        fingerprint = todo_payload_hash(todo)
        state = InboxTodoState.objects.filter(
            workspace=workspace,
            receiver=user,
            source=source,
            object_id=object_id,
        ).first()
        if state is None:
            state = InboxTodoState.objects.create(
                workspace=workspace,
                receiver=user,
                source=source,
                object_id=object_id,
                dedupe_key=todo_dedupe_key(todo),
                payload_hash=fingerprint,
                last_seen_at=now,
                created_by=user,
                updated_by=user,
            )
        elif state.payload_hash != fingerprint:
            state.payload_hash = fingerprint
            state.read_at = None
            state.snoozed_till = None
            state.last_seen_at = now
            state.save(update_fields=["payload_hash", "read_at", "snoozed_till", "last_seen_at", "updated_at"])
        states[(source, object_id)] = state
    return states


def reminder_key_for_todo(todo, now=None):
    """Build one idempotent reminder key for a due todo.

    Args:
        todo: One ``research-todo.v2`` envelope.
        now: Current timezone-aware timestamp; defaults to the server clock.

    Returns:
        A stable key, or ``None`` when the todo needs no reminder now.
    """
    urgency = todo.get("urgency")
    due_at = todo.get("due_at")
    if not due_at or urgency not in {"DUE_SOON", "DUE_TODAY", "OVERDUE"}:
        return None
    try:
        due_date = datetime.fromisoformat(str(due_at).replace("Z", "+00:00")).date()
        current_date = (now or timezone.now()).date()
    except (TypeError, ValueError):
        return None
    reminder_type = "due_soon" if urgency == "DUE_SOON" else urgency.lower()
    # DUE_SOON is a one-time state transition; due/overdue reminders are daily.
    reminder_date = due_date if urgency == "DUE_SOON" else current_date
    return f"todo:{todo['source']}:{todo['object_id']}:reminder:{reminder_type}:{reminder_date.isoformat()}"


def generate_inbox_todo_reminders(workspace, user, now=None):
    """Reopen unread todo states for due reminders without business writes.

    Args:
        workspace: Workspace whose members' todos should be inspected.
        user: Receiver whose projected todos should be inspected.
        now: Current timezone-aware timestamp; defaults to the server clock.

    Returns:
        The number of reminder keys applied by this invocation.
    """
    current_time = now or timezone.now()
    todos, _ = collect_inbox_todos(workspace, user)
    states = synchronize_todo_states(workspace, user, todos)
    applied = 0
    for todo in todos:
        state = states[(todo["source"], str(todo["object_id"]))]
        key = reminder_key_for_todo(todo, current_time)
        if not key or state.archived_at is not None:
            continue
        if state.snoozed_till is not None and state.snoozed_till > current_time:
            continue
        if state.last_reminder_key == key:
            continue
        state.last_reminder_key = key
        state.last_reminder_at = current_time
        state.read_at = None
        state.save(update_fields=["last_reminder_key", "last_reminder_at", "read_at", "updated_at"])
        applied += 1
    return applied


def _iso(value):
    """Convert model timestamps to a stable API string.

    Args:
        value: Datetime or ``None``.

    Returns:
        ISO-8601 text, or ``None`` when no timestamp exists.
    """
    return value.isoformat() if value is not None else None


def _actor(user):
    """Project a notification actor without account contact fields.

    Args:
        user: Trigger user, optionally ``None``.

    Returns:
        A limited actor object, or ``None``.
    """
    if user is None:
        return None
    return {
        "id": str(user.id),
        "display_name": user.display_name or user.username or str(user.id),
        "avatar_url": user.avatar_url,
    }


def notification_category(notification):
    """Classify one notification for inbox tabs and unread counts.

    Args:
        notification: Notification row or serializer object.

    Returns:
        One canonical inbox category.
    """
    entity_name = notification.entity_name
    sender = notification.sender or ""
    if "mentioned" in sender.lower() or entity_name == "user_mention":
        return "mention"
    if notification.announcement_id is not None or entity_name == "system_announcement" or sender.startswith("system:"):
        return "system"
    if entity_name in APPROVAL_ENTITY_NAMES:
        return "approval"
    if entity_name in REVIEW_ENTITY_NAMES:
        return "review"
    return "work_item"


def todo_category(todo):
    """Classify one projected todo for inbox tabs and unread counts.

    Args:
        todo: One ``research-todo.v2`` envelope.

    Returns:
        One canonical inbox category.
    """
    if todo["source"] in APPROVAL_TODO_SOURCES:
        return "approval"
    if todo["source"] in {"PAPER_REVIEW", "STAGE_REVIEW"}:
        return "review"
    return "todo"


def _notification_route(notification):
    """Resolve a safe frontend route from notification payload data.

    Args:
        notification: Notification row.

    Returns:
        Internal route text, or ``None`` when no route is available.
    """
    data = notification.data or {}
    embedded_route = data.get("route") or data.get("href")
    if embedded_route:
        return embedded_route
    workspace_slug = notification.workspace.slug
    if notification.entity_name == "issue" and notification.project_id and notification.entity_identifier:
        return f"/{workspace_slug}/projects/{notification.project_id}/issues/{notification.entity_identifier}"
    entity_routes = {
        "research_report": f"/{workspace_slug}/research/reports/{notification.entity_identifier}",
        "research_approval": f"/{workspace_slug}/research/approvals",
        "research_chain_task": f"/{workspace_slug}/research/todos",
        "research_paper_review": f"/{workspace_slug}/research/reviews",
        "research_stage_review": f"/{workspace_slug}/research/reviews",
        "research_stage": f"/{workspace_slug}/research/todos",
        "research_experiment": f"/{workspace_slug}/research/todos",
        "research_experiment_amendment": f"/{workspace_slug}/research/todos",
    }
    return entity_routes.get(notification.entity_name)


def _notification_item(notification):
    """Project a notification row into the unified inbox contract.

    Args:
        notification: Notification row selected with its trigger user.

    Returns:
        One ``inbox.v1`` item dictionary.
    """
    data = notification.data or {}
    return {
        "id": f"notification:{notification.id}",
        "schema_version": INBOX_SCHEMA_VERSION,
        "kind": "system" if notification.announcement_id else "notification",
        "category": notification_category(notification),
        "source": notification.entity_name,
        "object_id": str(notification.entity_identifier or ""),
        "entity_name": notification.entity_name,
        "entity_identifier": str(notification.entity_identifier) if notification.entity_identifier else None,
        "dedupe_key": f"notification:{notification.id}",
        "title": notification.title,
        "summary": notification.message_stripped,
        "actor": _actor(notification.triggered_by),
        "action": data.get("action") or (notification.message or {}).get("action"),
        "route": _notification_route(notification),
        "due_at": None,
        "urgency": None,
        "status": (notification.message or {}).get("status"),
        "next_action": None,
        "created_at": _iso(notification.created_at),
        "updated_at": _iso(notification.updated_at),
        "read_at": _iso(notification.read_at),
        "archived_at": _iso(notification.archived_at),
        "snoozed_till": _iso(notification.snoozed_till),
    }


def _todo_item(todo, state):
    """Project one research todo and its receiver state into inbox contract.

    Args:
        todo: One ``research-todo.v2`` envelope.
        state: Receiver-specific inbox state for the todo.

    Returns:
        One ``inbox.v1`` item dictionary.
    """
    updated_at = todo.get("updated_at")
    requester = todo.get("requester")
    return {
        "id": f"todo:{todo['source']}:{todo['object_id']}",
        "schema_version": INBOX_SCHEMA_VERSION,
        "kind": "todo",
        "category": todo_category(todo),
        "source": todo["source"],
        "object_id": str(todo["object_id"]),
        "entity_name": TODO_TO_ENTITY.get(todo["source"], todo["source"].lower()),
        "entity_identifier": str(todo["object_id"]),
        "dedupe_key": todo_dedupe_key(todo),
        "title": todo["title"],
        "summary": todo.get("context"),
        "actor": requester and {**requester, "avatar_url": None},
        "action": todo.get("next_action"),
        "route": todo.get("href"),
        "due_at": todo.get("due_at"),
        "urgency": todo.get("urgency"),
        "status": todo.get("business_status"),
        "business_status": todo.get("business_status"),
        "handling_status": todo.get("handling_status"),
        "next_action": todo.get("next_action"),
        "created_at": updated_at,
        "updated_at": updated_at,
        "read_at": _iso(state.read_at) if state else None,
        "archived_at": _iso(state.archived_at) if state else None,
        "snoozed_till": _iso(state.snoozed_till) if state else None,
    }


def _is_active(item, archived=False, snoozed=False):
    """Apply mutually understood archive and snooze state filters.

    Args:
        item: Unified inbox item.
        archived: Whether archived items are requested.
        snoozed: Whether snoozed items are requested.

    Returns:
        ``True`` when the item belongs to the requested state bucket.
    """
    return (item["archived_at"] is not None) == archived and (item["snoozed_till"] is not None) == snoozed


def unread_counts(items):
    """Count unread items by canonical inbox category.

    Args:
        items: Active unified inbox items.

    Returns:
        A count object consumed by the badge and notification page.
    """
    counts = {
        "total_unread_count": 0,
        "mention_unread_count": 0,
        "todo_unread_count": 0,
        "approval_unread_count": 0,
        "review_unread_count": 0,
        "work_item_unread_count": 0,
        "system_unread_count": 0,
    }
    for item in items:
        if item["read_at"] is not None:
            continue
        counts["total_unread_count"] += 1
        if item["category"] == "mention":
            counts["mention_unread_count"] += 1
        elif item["category"] == "approval":
            counts["approval_unread_count"] += 1
        elif item["category"] == "review":
            counts["review_unread_count"] += 1
        elif item["category"] == "work_item":
            counts["work_item_unread_count"] += 1
        elif item["category"] == "system":
            counts["system_unread_count"] += 1
        else:
            counts["todo_unread_count"] += 1
    return counts


def _notification_query(workspace, user, archived=False, snoozed=False):
    """Return notifications in the requested archive/snooze bucket.

    Args:
        workspace: Workspace owning the inbox.
        user: Receiver whose notifications are requested.
        archived: Whether archived notifications are requested.
        snoozed: Whether snoozed notifications are requested.

    Returns:
        A renderable notification queryset.
    """
    from plane.app.views.notification.base import renderable_inbox_notifications

    del archived, snoozed
    return renderable_inbox_notifications(workspace.slug, user.id)


def _updated_at(item):
    """Parse an item timestamp for deterministic sorting.

    Args:
        item: Unified inbox item.

    Returns:
        A sortable datetime.
    """
    try:
        return datetime.fromisoformat(item["updated_at"].replace("Z", "+00:00"))
    except (AttributeError, TypeError, ValueError):
        return datetime.min.replace(tzinfo=datetime_timezone.utc)


def project_inbox(workspace, user):
    """Build all active unified inbox items for one receiver.

    Args:
        workspace: Workspace owning the inbox.
        user: Receiver whose ACL-filtered items are required.

    Returns:
        An ``(items, degraded_sources)`` tuple.
    """
    try:
        todos, degraded_sources = collect_inbox_todos(workspace, user)
    except Exception as error:
        logger.exception(
            "Unified inbox todo collection failed",
            extra={
                "event": "unified_inbox_todo_failed",
                "workspace_id": str(workspace.id),
                "user_id": str(user.id),
                "exception_type": type(error).__name__,
            },
        )
        todos, degraded_sources = [], []
    states = synchronize_todo_states(workspace, user, todos)
    todo_items = [_todo_item(todo, states.get((todo["source"], str(todo["object_id"])))) for todo in todos]
    notifications = _notification_query(workspace, user).select_related("triggered_by")
    todo_keys = {(todo["source"], str(todo["object_id"])) for todo in todos}
    notification_items = []
    for notification in notifications:
        category = notification_category(notification)
        entity_todo_source = next(
            (source for source, entity in TODO_TO_ENTITY.items() if entity == notification.entity_name),
            None,
        )
        duplicate_key = (entity_todo_source, str(notification.entity_identifier)) if entity_todo_source else None
        alias_source = next(
            (source for source, entity in TODO_ENTITY_ALIASES if entity == notification.entity_name),
            None,
        )
        alias_key = (alias_source, str(notification.entity_identifier)) if alias_source else None
        if category != "mention" and (duplicate_key in todo_keys or alias_key in todo_keys):
            continue
        notification_items.append(_notification_item(notification))

    items = [*todo_items, *notification_items]
    items.sort(key=lambda item: (item["read_at"] is not None, _updated_at(item)), reverse=True)
    return items, degraded_sources


def filter_inbox_items(items, tab="all", read="all", archived=False, snoozed=False):
    """Filter projected items for one API request.

    Args:
        items: All projected inbox items.
        tab: Logical inbox tab.
        read: ``all``, ``true`` or ``false``.
        archived: Whether archived items are requested.
        snoozed: Whether snoozed items are requested.

    Returns:
        Items matching every requested filter.
    """
    filtered = [item for item in items if _is_active(item, archived=archived, snoozed=snoozed)]
    if tab == "mentions":
        filtered = [item for item in filtered if item["category"] == "mention"]
    elif tab == "todos":
        filtered = [item for item in filtered if item["kind"] == "todo"]
    elif tab == "approvals":
        filtered = [item for item in filtered if item["category"] == "approval"]
    elif tab == "reviews":
        filtered = [item for item in filtered if item["category"] == "review"]
    elif tab == "system":
        filtered = [item for item in filtered if item["category"] == "system"]
    if read == "false":
        filtered = [item for item in filtered if item["read_at"] is None]
    elif read == "true":
        filtered = [item for item in filtered if item["read_at"] is not None]
    return filtered


def encode_inbox_cursor(offset):
    """Encode an inbox page offset as an opaque cursor.

    Args:
        offset: Zero-based offset into the stable projection ordering.

    Returns:
        URL-safe base64 cursor.
    """
    raw = json.dumps({"offset": offset}, separators=(",", ":")).encode("utf-8")
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def decode_inbox_cursor(value):
    """Decode an inbox pagination cursor.

    Args:
        value: Cursor supplied by the client.

    Returns:
        A ``(offset, error)`` pair with exactly one non-null side.
    """
    try:
        padded = value + "=" * (-len(value) % 4)
        payload = json.loads(base64.urlsafe_b64decode(padded.encode("ascii")))
        offset = payload["offset"]
        if not isinstance(offset, int) or isinstance(offset, bool) or offset < 0:
            raise ValueError("offset must be a non-negative integer")
        return offset, None
    except (KeyError, TypeError, ValueError, json.JSONDecodeError):
        return 0, ValueError("cursor is invalid")
