# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

from django.urls import path


from plane.app.views import (
    InboxItemActionEndpoint,
    InboxListEndpoint,
    InboxMarkAllReadEndpoint,
    InboxUnreadEndpoint,
    NotificationViewSet,
    SystemAnnouncementEndpoint,
    UnreadNotificationEndpoint,
    MarkAllReadNotificationViewSet,
    UserNotificationPreferenceEndpoint,
)


urlpatterns = [
    path(
        "workspaces/<str:slug>/users/inbox/",
        InboxListEndpoint.as_view(),
        name="unified-inbox",
    ),
    path(
        "workspaces/<str:slug>/users/inbox/unread/",
        InboxUnreadEndpoint.as_view(),
        name="unified-inbox-unread",
    ),
    path(
        "workspaces/<str:slug>/users/inbox/items/<str:item_id>/<str:action>/",
        InboxItemActionEndpoint.as_view(),
        name="unified-inbox-item-action",
    ),
    path(
        "workspaces/<str:slug>/users/inbox/mark-all-read/",
        InboxMarkAllReadEndpoint.as_view(),
        name="unified-inbox-mark-all-read",
    ),
    path(
        "workspaces/<str:slug>/system-announcements/",
        SystemAnnouncementEndpoint.as_view({"get": "list", "post": "create"}),
        name="system-announcements",
    ),
    path(
        "workspaces/<str:slug>/users/notifications/",
        NotificationViewSet.as_view({"get": "list"}),
        name="notifications",
    ),
    path(
        "workspaces/<str:slug>/users/notifications/<uuid:pk>/",
        NotificationViewSet.as_view({"get": "retrieve", "patch": "partial_update", "delete": "destroy"}),
        name="notifications",
    ),
    path(
        "workspaces/<str:slug>/users/notifications/<uuid:pk>/read/",
        NotificationViewSet.as_view({"post": "mark_read", "delete": "mark_unread"}),
        name="notifications",
    ),
    path(
        "workspaces/<str:slug>/users/notifications/<uuid:pk>/archive/",
        NotificationViewSet.as_view({"post": "archive", "delete": "unarchive"}),
        name="notifications",
    ),
    path(
        "workspaces/<str:slug>/users/notifications/unread/",
        UnreadNotificationEndpoint.as_view(),
        name="unread-notifications",
    ),
    path(
        "workspaces/<str:slug>/users/notifications/mark-all-read/",
        MarkAllReadNotificationViewSet.as_view({"post": "create"}),
        name="mark-all-read-notifications",
    ),
    path(
        "users/me/notification-preferences/",
        UserNotificationPreferenceEndpoint.as_view(),
        name="user-notification-preferences",
    ),
]
