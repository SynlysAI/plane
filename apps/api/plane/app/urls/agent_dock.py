# Copyright (c) 2023-present Plane Software, Inc. contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

from django.urls import path

from plane.app.views.agent_dock import (
    AgentDockContextDetailEndpoint,
    AgentDockContextResolveEndpoint,
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
]
