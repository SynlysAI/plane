from django.urls import path
from plane.app.views.workspace.context import WorkspaceContextEndpoint
from plane.app.views.workspace.todos import WorkspaceTodoEndpoint

urlpatterns = [
    path("workspaces/<str:slug>/context/", WorkspaceContextEndpoint.as_view()),
    path("workspaces/<str:slug>/todos/", WorkspaceTodoEndpoint.as_view()),
]
