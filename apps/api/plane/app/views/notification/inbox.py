# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Unified inbox API for notifications and actionable research todos."""

from datetime import datetime

from django.db import transaction
from django.utils import timezone
from rest_framework import status
from rest_framework.response import Response

from plane.app.permissions import ROLE, allow_permission
from plane.app.services import inbox as inbox_service
from plane.app.services.inbox import (
    INBOX_SCHEMA_VERSION,
    INBOX_TABS,
    decode_inbox_cursor,
    encode_inbox_cursor,
    filter_inbox_items,
    unread_counts,
)
from plane.app.views.base import BaseAPIView
from plane.app.views.notification.base import renderable_inbox_notifications
from plane.db.models import InboxTodoState, Notification, Workspace

DEFAULT_INBOX_LIMIT = 25
MAX_INBOX_LIMIT = 100


def _parse_flag(value, default=False):
    """Parse a boolean query value.

    Args:
        value: Raw request value.
        default: Value used when the request omits the field.

    Returns:
        Parsed boolean value.
    """
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    return str(value).lower() in {"true", "1", "yes"}


class InboxListEndpoint(BaseAPIView):
    """List notifications and actionable todos in one projection."""

    @allow_permission(allowed_roles=[ROLE.ADMIN, ROLE.MEMBER, ROLE.GUEST], level="WORKSPACE")
    def get(self, request, slug):
        """Return one paginated unified inbox page."""
        workspace = Workspace.objects.get(slug=slug)
        tab = str(request.GET.get("tab") or "all")
        if tab not in INBOX_TABS:
            return Response({"error": "tab is invalid."}, status=status.HTTP_400_BAD_REQUEST)
        read = str(request.GET.get("read") or "all")
        if read not in {"all", "true", "false"}:
            return Response({"error": "read is invalid."}, status=status.HTTP_400_BAD_REQUEST)
        try:
            limit = int(request.GET.get("per_page") or DEFAULT_INBOX_LIMIT)
        except (TypeError, ValueError):
            return Response({"error": "per_page must be an integer."}, status=status.HTTP_400_BAD_REQUEST)
        if limit < 1 or limit > MAX_INBOX_LIMIT:
            return Response(
                {"error": f"per_page must be between 1 and {MAX_INBOX_LIMIT}."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        offset = 0
        cursor = request.GET.get("cursor")
        if cursor:
            offset, error = decode_inbox_cursor(cursor)
            if error:
                return Response({"error": str(error)}, status=status.HTTP_400_BAD_REQUEST)

        items, degraded_sources = inbox_service.project_inbox(workspace, request.user)
        active_items = filter_inbox_items(
            items,
            tab=tab,
            read=read,
            archived=_parse_flag(request.GET.get("archived")),
            snoozed=_parse_flag(request.GET.get("snoozed")),
        )
        page = active_items[offset : offset + limit]
        next_cursor = encode_inbox_cursor(offset + limit) if offset + limit < len(active_items) else None
        return Response(
            {
                "schema_version": INBOX_SCHEMA_VERSION,
                "results": page,
                "count": len(page),
                "total_count": len(active_items),
                "next_cursor": next_cursor,
                "unread_counts": unread_counts(filter_inbox_items(items)),
                "degraded_sources": degraded_sources,
            },
            status=status.HTTP_200_OK,
        )


class InboxUnreadEndpoint(BaseAPIView):
    """Return badge counts from the same projection as the inbox list."""

    @allow_permission(allowed_roles=[ROLE.ADMIN, ROLE.MEMBER, ROLE.GUEST], level="WORKSPACE")
    def get(self, request, slug):
        """Return canonical unread counts for the requesting user."""
        workspace = Workspace.objects.get(slug=slug)
        items, _ = inbox_service.project_inbox(workspace, request.user)
        return Response(unread_counts(filter_inbox_items(items)), status=status.HTTP_200_OK)


class InboxItemActionEndpoint(BaseAPIView):
    """Update presentation state for one notification or todo item."""

    @staticmethod
    def _parse_timestamp(request):
        """Parse an optional snooze timestamp.

        Args:
            request: Current DRF request.

        Returns:
            Timezone-aware datetime, or ``None`` when omitted.
        """
        value = request.data.get("snoozed_till")
        if not value:
            return None
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        return timezone.make_aware(parsed) if timezone.is_naive(parsed) else parsed

    @allow_permission(allowed_roles=[ROLE.ADMIN, ROLE.MEMBER, ROLE.GUEST], level="WORKSPACE")
    def post(self, request, slug, item_id, action):
        """Apply read, unread, archive, unarchive or snooze to one item."""
        if action not in {"read", "unread", "archive", "unarchive", "snooze"}:
            return Response({"error": "action is invalid."}, status=status.HTTP_400_BAD_REQUEST)
        workspace = Workspace.objects.get(slug=slug)
        parts = item_id.split(":", 2)
        now = timezone.now()
        snoozed_till = None
        if action == "snooze":
            try:
                snoozed_till = self._parse_timestamp(request)
            except (TypeError, ValueError):
                return Response({"error": "snoozed_till is invalid."}, status=status.HTTP_400_BAD_REQUEST)

        if parts[0] == "notification" and len(parts) == 2:
            notification = renderable_inbox_notifications(slug, request.user.id).filter(pk=parts[1]).first()
            if notification is None:
                return Response({"error": "Item not found."}, status=status.HTTP_404_NOT_FOUND)
            if action == "read":
                notification.read_at = now
            elif action == "unread":
                notification.read_at = None
            elif action == "archive":
                notification.archived_at = now
            elif action == "unarchive":
                notification.archived_at = None
            else:
                notification.snoozed_till = snoozed_till
            notification.save(update_fields=["read_at", "archived_at", "snoozed_till", "updated_at"])
        elif parts[0] == "todo" and len(parts) == 3:
            todos, _ = inbox_service.collect_inbox_todos(workspace, request.user)
            current = next(
                (todo for todo in todos if todo["source"] == parts[1] and str(todo["object_id"]) == parts[2]),
                None,
            )
            if current is None:
                return Response({"error": "Item not found."}, status=status.HTTP_404_NOT_FOUND)
            states = inbox_service.synchronize_todo_states(workspace, request.user, [current])
            state = states[(current["source"], str(current["object_id"]))]
            if action == "read":
                state.read_at = now
            elif action == "unread":
                state.read_at = None
            elif action == "archive":
                state.archived_at = now
            elif action == "unarchive":
                state.archived_at = None
            else:
                state.snoozed_till = snoozed_till
            state.save(update_fields=["read_at", "archived_at", "snoozed_till", "updated_at"])
        else:
            return Response({"error": "Item is invalid."}, status=status.HTTP_400_BAD_REQUEST)

        items, degraded_sources = inbox_service.project_inbox(workspace, request.user)
        return Response(
            {
                "schema_version": INBOX_SCHEMA_VERSION,
                "results": [],
                "unread_counts": unread_counts(filter_inbox_items(items)),
                "degraded_sources": degraded_sources,
            },
            status=status.HTTP_200_OK,
        )


class InboxMarkAllReadEndpoint(BaseAPIView):
    """Clear unread badges without changing any business todo state."""

    @allow_permission(allowed_roles=[ROLE.ADMIN, ROLE.MEMBER, ROLE.GUEST], level="WORKSPACE")
    def post(self, request, slug):
        """Mark active notifications and todos read in one transaction."""
        workspace = Workspace.objects.get(slug=slug)
        now = timezone.now()
        todos, degraded_sources = inbox_service.collect_inbox_todos(workspace, request.user)
        with transaction.atomic():
            notifications = list(
                renderable_inbox_notifications(slug, request.user.id).filter(
                    read_at__isnull=True,
                    archived_at__isnull=True,
                    snoozed_till__isnull=True,
                )
            )
            for notification in notifications:
                notification.read_at = now
            Notification.objects.bulk_update(
                notifications,
                ["read_at", "updated_at"],
                batch_size=100,
            )
            states = inbox_service.synchronize_todo_states(workspace, request.user, todos)
            active_state_ids = []
            for todo in todos:
                state = states[(todo["source"], str(todo["object_id"]))]
                if state.read_at is None and state.archived_at is None and state.snoozed_till is None:
                    active_state_ids.append(state.id)
            InboxTodoState.objects.filter(id__in=active_state_ids).update(
                read_at=now,
                updated_at=now,
            )

        items, _ = inbox_service.project_inbox(workspace, request.user)
        return Response(
            {
                "schema_version": INBOX_SCHEMA_VERSION,
                "results": [],
                "unread_counts": unread_counts(filter_inbox_items(items)),
                "degraded_sources": degraded_sources,
            },
            status=status.HTTP_200_OK,
        )
