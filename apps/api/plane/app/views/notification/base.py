# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

# Django imports
from django.db.models import Count, Exists, OuterRef, Q, Case, When, BooleanField
from django.utils import timezone

# Third party imports
from rest_framework import status
from rest_framework.response import Response

from plane.app.serializers import (
    NotificationSerializer,
    UserNotificationPreferenceSerializer,
)
from plane.db.models import (
    Issue,
    IssueAssignee,
    IssueSubscriber,
    Notification,
    UserNotificationPreference,
    WorkspaceMember,
)
from plane.utils.paginator import BasePaginator
from plane.utils.order_queryset import NOTIFICATION_ORDER_BY_ALLOWLIST, sanitize_order_by
from plane.app.permissions import allow_permission, ROLE

# Module imports
from ..base import BaseAPIView, BaseViewSet


def parse_request_flag(value, default=False):
    """Convert a query or JSON flag to a boolean.

    Args:
        value: Raw value received from the client.
        default: Value used when the client omits the flag.

    Returns:
        Parsed boolean flag.
    """
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    return str(value).lower() in {"true", "1", "yes"}


def renderable_issue_notifications(workspace_slug, receiver_id):
    """Return notifications that the workspace inbox can render and open.

    The inbox currently renders work item activity only. Research and future
    system notifications must stay out of unread counts until card rendering and
    navigation are added for their entity types.

    Args:
        workspace_slug: Workspace slug from the request.
        receiver_id: User whose notifications are being read.

    Returns:
        Notification queryset scoped to valid, renderable work item activity.
    """
    linked_issue = Issue.objects.filter(
        pk=OuterRef("entity_identifier"),
        project=OuterRef("project"),
        workspace__slug=workspace_slug,
        archived_at__isnull=True,
        project__archived_at__isnull=True,
        is_draft=False,
    )
    intake_issue = Issue.objects.filter(
        pk=OuterRef("entity_identifier"),
        workspace__slug=workspace_slug,
        issue_intake__status__in=[0, 2, -2],
    )

    return (
        Notification.objects.filter(
            workspace__slug=workspace_slug,
            receiver_id=receiver_id,
            entity_name="issue",
            project__isnull=False,
            entity_identifier__isnull=False,
            data__issue__id__isnull=False,
            data__issue_activity__field__isnull=False,
        )
        .exclude(data__issue__id="")
        .exclude(data__issue_activity__field="")
        .annotate(is_inbox_issue=Exists(intake_issue))
        .annotate(is_intake_issue=Exists(intake_issue))
        .annotate(
            is_mentioned_notification=Case(
                When(sender__icontains="mentioned", then=True),
                default=False,
                output_field=BooleanField(),
            )
        )
        .annotate(is_renderable_issue=Exists(linked_issue))
        .filter(is_renderable_issue=True)
        .select_related("workspace", "project", "triggered_by", "receiver")
    )


def filter_notifications_by_state(notifications, snoozed=False, archived=False):
    """Apply mutually understood snooze and archive filters to notifications.

    Args:
        notifications: Base notification queryset.
        snoozed: Whether snoozed notifications should be returned.
        archived: Whether archived notifications should be returned.

    Returns:
        Filtered notification queryset.
    """
    notifications = notifications.filter(
        snoozed_till__isnull=not snoozed,
        archived_at__isnull=not archived,
    )
    return notifications


def filter_notifications_by_type(notifications, workspace_slug, receiver_id, notification_type):
    """Apply the inbox work item type filter to notifications.

    Args:
        notifications: Base notification queryset.
        workspace_slug: Workspace slug from the request.
        receiver_id: User whose notifications are being filtered.
        notification_type: Comma-separated type value used by the inbox.

    Returns:
        Filtered notification queryset.
    """
    types = {notification_type_part.strip() for notification_type_part in notification_type.split(",")}
    q_filters = Q()

    if "subscribed" in types:
        issue_ids = (
            IssueSubscriber.objects.filter(workspace__slug=workspace_slug, subscriber_id=receiver_id)
            .annotate(created=Exists(Issue.objects.filter(created_by=receiver_id, pk=OuterRef("issue_id"))))
            .annotate(assigned=Exists(IssueAssignee.objects.filter(pk=OuterRef("issue_id"), assignee=receiver_id)))
            .filter(created=False, assigned=False)
            .values_list("issue_id", flat=True)
        )
        q_filters |= Q(entity_identifier__in=issue_ids)

    if "assigned" in types:
        issue_ids = IssueAssignee.objects.filter(workspace__slug=workspace_slug, assignee_id=receiver_id).values_list(
            "issue_id", flat=True
        )
        q_filters |= Q(entity_identifier__in=issue_ids)

    if "created" in types:
        if WorkspaceMember.objects.filter(
            workspace__slug=workspace_slug,
            member_id=receiver_id,
            role__lt=15,
            is_active=True,
        ).exists():
            return notifications.none()
        issue_ids = Issue.objects.filter(workspace__slug=workspace_slug, created_by_id=receiver_id).values_list(
            "pk", flat=True
        )
        q_filters |= Q(entity_identifier__in=issue_ids)

    return notifications.filter(q_filters)


class NotificationViewSet(BaseViewSet, BasePaginator):
    model = Notification
    serializer_class = NotificationSerializer

    def get_queryset(self):
        return renderable_issue_notifications(
            self.kwargs.get("slug"),
            self.request.user.id,
        ).order_by("snoozed_till", "-created_at")

    @allow_permission(allowed_roles=[ROLE.ADMIN, ROLE.MEMBER, ROLE.GUEST], level="WORKSPACE")
    def list(self, request, slug):
        # Get query parameters
        snoozed = parse_request_flag(request.GET.get("snoozed"), False)
        archived = parse_request_flag(request.GET.get("archived"), False)
        read = request.GET.get("read", None)
        notification_type = request.GET.get("type", "all")
        mentioned = parse_request_flag(request.GET.get("mentioned"), False)

        notifications = self.get_queryset()
        notifications = filter_notifications_by_state(
            notifications,
            snoozed=snoozed,
            archived=archived,
        )

        if read == "false":
            notifications = notifications.filter(read_at__isnull=True)

        if read == "true":
            notifications = notifications.filter(read_at__isnull=False)

        if mentioned:
            notifications = notifications.filter(sender__icontains="mentioned")
        notifications = filter_notifications_by_type(
            notifications,
            workspace_slug=slug,
            receiver_id=request.user.id,
            notification_type=notification_type,
        )

        # Pagination
        if request.GET.get("per_page", False) and request.GET.get("cursor", False):
            return self.paginate(
                order_by=sanitize_order_by(
                    request.GET.get("order_by", "-created_at"),
                    NOTIFICATION_ORDER_BY_ALLOWLIST,
                    "-created_at",
                ),
                request=request,
                queryset=(notifications),
                on_results=lambda notifications: NotificationSerializer(notifications, many=True).data,
            )

        serializer = NotificationSerializer(notifications, many=True)
        return Response(serializer.data, status=status.HTTP_200_OK)

    @allow_permission(allowed_roles=[ROLE.ADMIN, ROLE.MEMBER, ROLE.GUEST], level="WORKSPACE")
    def partial_update(self, request, slug, pk):
        notification = self.get_queryset().get(pk=pk)
        # Only read_at and snoozed_till can be updated
        notification_data = {"snoozed_till": request.data.get("snoozed_till", None)}
        serializer = NotificationSerializer(notification, data=notification_data, partial=True)

        if serializer.is_valid():
            serializer.save()
            return Response(serializer.data, status=status.HTTP_200_OK)
        return Response(serializer.errors, status=status.HTTP_400_BAD_REQUEST)

    @allow_permission(allowed_roles=[ROLE.ADMIN, ROLE.MEMBER, ROLE.GUEST], level="WORKSPACE")
    def mark_read(self, request, slug, pk):
        notification = self.get_queryset().get(pk=pk)
        notification.read_at = timezone.now()
        notification.save()
        serializer = NotificationSerializer(notification)
        return Response(serializer.data, status=status.HTTP_200_OK)

    @allow_permission(allowed_roles=[ROLE.ADMIN, ROLE.MEMBER, ROLE.GUEST], level="WORKSPACE")
    def mark_unread(self, request, slug, pk):
        notification = self.get_queryset().get(pk=pk)
        notification.read_at = None
        notification.save()
        serializer = NotificationSerializer(notification)
        return Response(serializer.data, status=status.HTTP_200_OK)

    @allow_permission(allowed_roles=[ROLE.ADMIN, ROLE.MEMBER, ROLE.GUEST], level="WORKSPACE")
    def archive(self, request, slug, pk):
        notification = self.get_queryset().get(pk=pk)
        notification.archived_at = timezone.now()
        notification.save()
        serializer = NotificationSerializer(notification)
        return Response(serializer.data, status=status.HTTP_200_OK)

    @allow_permission(allowed_roles=[ROLE.ADMIN, ROLE.MEMBER, ROLE.GUEST], level="WORKSPACE")
    def unarchive(self, request, slug, pk):
        notification = self.get_queryset().get(pk=pk)
        notification.archived_at = None
        notification.save()
        serializer = NotificationSerializer(notification)
        return Response(serializer.data, status=status.HTTP_200_OK)


class UnreadNotificationEndpoint(BaseAPIView):
    # Keep the count on the primary database so it immediately reflects read,
    # archive, and snooze mutations for refreshes and multi-device clients.
    use_read_replica = False

    @allow_permission(allowed_roles=[ROLE.ADMIN, ROLE.MEMBER, ROLE.GUEST], level="WORKSPACE")
    def get(self, request, slug):
        unread_notifications = renderable_issue_notifications(slug, request.user.id).filter(
            read_at__isnull=True,
            archived_at__isnull=True,
            snoozed_till__isnull=True,
        )
        unread_notification_counts = unread_notifications.aggregate(
            total_unread_notifications_count=Count("id", distinct=True),
            mention_unread_notifications_count=Count(
                "id",
                distinct=True,
                filter=Q(sender__icontains="mentioned"),
            ),
        )

        return Response(
            {
                "total_unread_notifications_count": int(unread_notification_counts["total_unread_notifications_count"]),
                "mention_unread_notifications_count": int(
                    unread_notification_counts["mention_unread_notifications_count"]
                ),
            },
            status=status.HTTP_200_OK,
        )


class MarkAllReadNotificationViewSet(BaseViewSet):
    @allow_permission(allowed_roles=[ROLE.ADMIN, ROLE.MEMBER, ROLE.GUEST], level="WORKSPACE")
    def create(self, request, slug):
        snoozed = parse_request_flag(request.data.get("snoozed"), False)
        archived = parse_request_flag(request.data.get("archived"), False)
        notification_type = request.data.get("type", "all")
        mentioned = parse_request_flag(request.data.get("mentioned"), False)

        notifications = renderable_issue_notifications(slug, request.user.id).filter(
            read_at__isnull=True,
        )
        notifications = filter_notifications_by_state(
            notifications,
            snoozed=snoozed,
            archived=archived,
        )
        if mentioned:
            notifications = notifications.filter(sender__icontains="mentioned")
        notifications = filter_notifications_by_type(
            notifications,
            workspace_slug=slug,
            receiver_id=request.user.id,
            notification_type=notification_type,
        )

        updated_notifications = []
        for notification in notifications:
            notification.read_at = timezone.now()
            updated_notifications.append(notification)
        Notification.objects.bulk_update(updated_notifications, ["read_at"], batch_size=100)
        return Response({"message": "Successful"}, status=status.HTTP_200_OK)


class UserNotificationPreferenceEndpoint(BaseAPIView):
    model = UserNotificationPreference
    serializer_class = UserNotificationPreferenceSerializer

    # request the object
    def get(self, request):
        user_notification_preference = UserNotificationPreference.objects.get(user=request.user)
        serializer = UserNotificationPreferenceSerializer(user_notification_preference)
        return Response(serializer.data, status=status.HTTP_200_OK)

    # update the object
    def patch(self, request):
        user_notification_preference = UserNotificationPreference.objects.get(user=request.user)
        serializer = UserNotificationPreferenceSerializer(user_notification_preference, data=request.data, partial=True)
        if serializer.is_valid():
            serializer.save()
            return Response(serializer.data, status=status.HTTP_200_OK)
        return Response(serializer.errors, status=status.HTTP_400_BAD_REQUEST)
