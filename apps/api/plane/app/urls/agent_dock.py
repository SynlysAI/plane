# Copyright (c) 2023-present Plane Software, Inc. contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

from django.urls import path

from plane.app.views.agent_dock import (
    AgentDockContextDetailEndpoint,
    AgentDockContextResolveEndpoint,
    AgentDockRunCancelEndpoint,
    AgentDockRunEventEndpoint,
    AgentDockSessionCollectionEndpoint,
    AgentDockSessionDetailEndpoint,
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
        "workspaces/<str:slug>/agent-dock/sessions/<uuid:session_id>/messages/",
        AgentDockSessionMessageEndpoint.as_view(),
        name="agent-dock-session-message",
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
]
