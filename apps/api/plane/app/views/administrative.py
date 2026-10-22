"""Read-only administrative approval history API."""

from rest_framework.exceptions import NotFound, PermissionDenied, ValidationError
from rest_framework.response import Response
from plane.app.views.base import BaseAPIView
from plane.db.models import Workspace, WorkspaceMember
from plane.utils.workspace_access import user_can_access_workspace
from plane.utils.administrative_projects import visible_administrative_projects
from plane.utils.administrative_approvals import (
    request_payload,
    related_requests,
    visible_requests,
)


class AdministrativeBaseEndpoint(BaseAPIView):
    def workspace(self, request, slug):
        workspace = Workspace.objects.filter(slug=slug).first()
        if workspace is None:
            raise NotFound()
        if (
            not user_can_access_workspace(request.user, workspace_slug=slug)
            or not WorkspaceMember.objects.filter(workspace=workspace, member=request.user, is_active=True).exists()
        ):
            raise PermissionDenied()
        return workspace

    def project(self, request, slug, project_id):
        project = (
            visible_administrative_projects(request.user, slug)
            .filter(pk=project_id)
            .select_related("workspace", "administrative_organization")
            .first()
        )
        if project is None:
            raise NotFound("行政项目不存在或无权访问。")
        return project


class AdministrativeRequestEndpoint(AdministrativeBaseEndpoint):
    def get(self, request, slug):
        workspace = self.workspace(request, slug)
        approvals = visible_requests(workspace, request.user)
        project_id = request.GET.get("project_id")
        if project_id:
            project = self.project(request, slug, project_id)
            approvals = approvals.filter(project=project)
        else:
            approvals = related_requests(approvals, workspace, request.user)
        status = request.GET.get("status")
        if status:
            if status == "completed":
                approvals = approvals.exclude(status="PENDING")
            elif status in ("PENDING", "APPROVED", "REJECTED", "WITHDRAWN", "CANCELLED"):
                approvals = approvals.filter(status=status)
            else:
                raise ValidationError("审批状态无效。")
        if request.GET.get("search"):
            approvals = approvals.filter(issue__name__icontains=request.GET["search"])
        scope = request.GET.get("scope", "to_me")
        if scope not in ("to_me", "mine", "related", "visible", "completed"):
            raise ValidationError("审批范围无效。")
        if scope == "related" and project_id:
            approvals = related_requests(approvals, workspace, request.user)
        if scope == "mine":
            approvals = approvals.filter(requested_by=request.user)
        elif scope == "completed":
            approvals = approvals.exclude(status="PENDING")
        elif scope == "to_me":
            approvals = approvals.filter(status="PENDING")
        results = [request_payload(item, request.user) for item in approvals.order_by("-created_at", "id")]
        if scope == "to_me":
            results = [item for item in results if item["can_act"]]
        return Response({"results": results})

    def post(self, request, slug):
        self.workspace(request, slug)
        raise ValidationError("行政工作项审批已改为直接指派负责人后自动完成。")


class AdministrativeRequestDetailEndpoint(AdministrativeBaseEndpoint):
    def get(self, request, slug, request_id):
        workspace = self.workspace(request, slug)
        approvals = visible_requests(workspace, request.user)
        project_id = request.GET.get("project_id")
        if project_id:
            project = self.project(request, slug, project_id)
            approvals = approvals.filter(project=project)
        else:
            approvals = related_requests(approvals, workspace, request.user)
        approval = approvals.filter(pk=request_id).first()
        if approval is None:
            raise NotFound()
        return Response(request_payload(approval, request.user, history=True))

    def post(self, request, slug, request_id):
        self.workspace(request, slug)
        raise ValidationError("行政审批历史仅供查看；请直接指定负责人完成工作项。")
