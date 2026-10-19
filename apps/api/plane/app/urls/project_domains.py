from django.urls import path
from plane.app.views.workspace.context import WorkspaceContextEndpoint
from plane.app.views.workspace.todos import WorkspaceTodoEndpoint
from plane.app.views.administrative import (
    AdministrativeFlowEndpoint, AdministrativeFlowDetailEndpoint, AdministrativeProjectApprovalEndpoint,
    AdministrativeRequestEndpoint, AdministrativeRequestDetailEndpoint,
    AdministrativeApproverOptionsEndpoint,
)

urlpatterns = [
    path("workspaces/<str:slug>/context/", WorkspaceContextEndpoint.as_view()),
    path("workspaces/<str:slug>/todos/", WorkspaceTodoEndpoint.as_view()),
    path("workspaces/<str:slug>/administrative/approval-flows/", AdministrativeFlowEndpoint.as_view()),
    path("workspaces/<str:slug>/administrative/organizations/<uuid:organization_id>/approvers/", AdministrativeApproverOptionsEndpoint.as_view()),
    path("workspaces/<str:slug>/administrative/approval-flows/<uuid:flow_id>/", AdministrativeFlowDetailEndpoint.as_view()),
    path("workspaces/<str:slug>/administrative/approval-requests/", AdministrativeRequestEndpoint.as_view()),
    path("workspaces/<str:slug>/administrative/approval-requests/<uuid:request_id>/", AdministrativeRequestDetailEndpoint.as_view()),
    path("workspaces/<str:slug>/projects/<uuid:project_id>/approval-setting/", AdministrativeProjectApprovalEndpoint.as_view()),
]
