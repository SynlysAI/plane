from django.urls import path
from plane.app.views.workspace.context import WorkspaceContextEndpoint
from plane.app.views.workspace.todos import WorkspaceTodoEndpoint
from plane.app.views.administrative import (
    AdministrativeRequestDetailEndpoint,
    AdministrativeRequestEndpoint,
)

urlpatterns = [
    path("workspaces/<str:slug>/context/", WorkspaceContextEndpoint.as_view()),
    path("workspaces/<str:slug>/todos/", WorkspaceTodoEndpoint.as_view()),
    path("workspaces/<str:slug>/administrative/approval-requests/", AdministrativeRequestEndpoint.as_view()),
    path("workspaces/<str:slug>/administrative/approval-requests/<uuid:request_id>/", AdministrativeRequestDetailEndpoint.as_view()),
]
