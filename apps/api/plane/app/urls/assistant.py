# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

from django.urls import path

from plane.app.views.assistant import (
    AssistantChatEndpoint,
    AssistantHistoryEndpoint,
    AssistantRunCancelEndpoint,
    AssistantRunEventsEndpoint,
    AssistantRunResultEndpoint,
    AssistantSessionEndpoint,
    AssistantStatusEndpoint,
)

urlpatterns = [
    path(
        "workspaces/<str:slug>/assistant/status/",
        AssistantStatusEndpoint.as_view(),
        name="assistant-status",
    ),
    path(
        "workspaces/<str:slug>/assistant/session/",
        AssistantSessionEndpoint.as_view(),
        name="assistant-session",
    ),
    path(
        "workspaces/<str:slug>/assistant/chat/",
        AssistantChatEndpoint.as_view(),
        name="assistant-chat",
    ),
    path(
        "workspaces/<str:slug>/assistant/runs/<uuid:run_id>/events/",
        AssistantRunEventsEndpoint.as_view(),
        name="assistant-run-events",
    ),
    path(
        "workspaces/<str:slug>/assistant/runs/<uuid:run_id>/result/",
        AssistantRunResultEndpoint.as_view(),
        name="assistant-run-result",
    ),
    path(
        "workspaces/<str:slug>/assistant/runs/<uuid:run_id>/cancel/",
        AssistantRunCancelEndpoint.as_view(),
        name="assistant-run-cancel",
    ),
    path(
        "workspaces/<str:slug>/assistant/history/",
        AssistantHistoryEndpoint.as_view(),
        name="assistant-history",
    ),
]
