# Copyright (c) 2023-present Plane Software, Inc. contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

from django.urls import path

from plane.app.views.agent_dock import (
    AgentDockContextDetailEndpoint,
    AgentDockContextResolveEndpoint,
    AgentDockRunCancelEndpoint,
    AgentDockRunEventEndpoint,
    AgentDockRunEventStreamEndpoint,
    AgentDockRunAnswerEndpoint,
    AgentDockSessionCollectionEndpoint,
    AgentDockSessionContextRefreshEndpoint,
    AgentDockSessionDetailEndpoint,
    AgentDockSessionEventEndpoint,
    AgentDockSessionMessageEndpoint,
)

urlpatterns = [
    path(
        "workspaces/<str:slug>/agent-dock/context/resolve/",
        AgentDockContextResolveEndpoint.as_view(),
        name="agent-dock-context-resolve",
    ),
    path(
        "workspaces/<str:slug>/agent-dock/context/<uuid:context_id>/",
        AgentDockContextDetailEndpoint.as_view(),
        name="agent-dock-context-detail",
    ),
    path(
        "workspaces/<str:slug>/agent-dock/sessions/",
        AgentDockSessionCollectionEndpoint.as_view(),
        name="agent-dock-sessions",
    ),
    path(
        "workspaces/<str:slug>/agent-dock/sessions/<uuid:session_id>/",
        AgentDockSessionDetailEndpoint.as_view(),
        name="agent-dock-session-detail",
    ),
    path(
        "workspaces/<str:slug>/agent-dock/sessions/<uuid:session_id>/context/refresh/",
        AgentDockSessionContextRefreshEndpoint.as_view(),
        name="agent-dock-session-context-refresh",
    ),
    path(
        "workspaces/<str:slug>/agent-dock/sessions/<uuid:session_id>/events/",
        AgentDockSessionEventEndpoint.as_view(),
        name="agent-dock-session-events",
    ),
    path(
        "workspaces/<str:slug>/agent-dock/sessions/<uuid:session_id>/messages/",
        AgentDockSessionMessageEndpoint.as_view(),
        name="agent-dock-session-message",
    ),
    path(
        "workspaces/<str:slug>/agent-dock/runs/<uuid:run_id>/events/stream/",
        AgentDockRunEventStreamEndpoint.as_view(),
        name="agent-dock-run-events-stream",
    ),
    path(
        "workspaces/<str:slug>/agent-dock/runs/<uuid:run_id>/events/",
        AgentDockRunEventEndpoint.as_view(),
        name="agent-dock-run-events",
    ),
    path(
        "workspaces/<str:slug>/agent-dock/runs/<uuid:run_id>/cancel/",
        AgentDockRunCancelEndpoint.as_view(),
        name="agent-dock-run-cancel",
    ),
    path(
        "workspaces/<str:slug>/agent-dock/runs/<uuid:run_id>/answer/",
        AgentDockRunAnswerEndpoint.as_view(),
        name="agent-dock-run-answer",
    ),
]
