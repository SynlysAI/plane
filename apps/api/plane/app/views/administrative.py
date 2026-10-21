"""Project-scoped administrative approval API."""

from django.db import transaction
from django.db.models import Q
from rest_framework.exceptions import NotFound, PermissionDenied, ValidationError
from rest_framework.response import Response
from plane.app.views.base import BaseAPIView
from plane.db.models import (
    AdministrativeApprovalFlow,
    AdministrativeOrganization,
    AdministrativeOrganizationMember,
    AdministrativeProjectApprovalSetting,
    Workspace,
    WorkspaceMember,
    User,
)
from plane.utils.workspace_access import user_can_access_workspace
from plane.utils.administrative_projects import visible_administrative_projects
from plane.utils.administrative_projects import user_can_manage_administrative_organization
from plane.utils.administrative_approvals import (
    approver_options,
    can_manage_project,
    flow_payload,
    project_role,
    request_payload,
    related_requests,
    save_flow,
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


class AdministrativeFlowEndpoint(AdministrativeBaseEndpoint):
    def get(self, request, slug):
        workspace = self.workspace(request, slug)
        visible = visible_administrative_projects(request.user, slug)
        organization_ids = AdministrativeOrganizationMember.objects.filter(
            workspace=workspace, member=request.user, is_active=True
        ).values("organization_id")
        flows = AdministrativeApprovalFlow.objects.filter(workspace=workspace, is_active=True, is_template=True)
        if not WorkspaceMember.objects.filter(
            workspace=workspace, member=request.user, is_active=True, role=20
        ).exists():
            flows = flows.filter(
                Q(organization_id__in=organization_ids)
                | Q(organization_id__in=visible.values("administrative_organization_id"))
            )
        if request.GET.get("organization_id"):
            flows = flows.filter(organization_id=request.GET["organization_id"])
        return Response({"results": [flow_payload(flow) for flow in flows.prefetch_related("steps").order_by("name")]})

    def post(self, request, slug):
        workspace = self.workspace(request, slug)
        organization = AdministrativeOrganization.objects.filter(
            pk=request.data.get("organization_id"), workspace=workspace
        ).first()
        if organization is None:
            raise ValidationError("请选择当前工作区的行政组织。")
        return Response(flow_payload(save_flow(workspace, request.user, organization, request.data)), status=201)


class AdministrativeFlowDetailEndpoint(AdministrativeBaseEndpoint):
    def patch(self, request, slug, flow_id):
        workspace = self.workspace(request, slug)
        flow = (
            AdministrativeApprovalFlow.objects.filter(pk=flow_id, workspace=workspace, is_template=True)
            .select_related("organization")
            .first()
        )
        if flow is None:
            raise NotFound()
        return Response(
            flow_payload(save_flow(workspace, request.user, flow.organization, request.data, original=flow))
        )


class AdministrativeApproverOptionsEndpoint(AdministrativeBaseEndpoint):
    def get(self, request, slug, organization_id):
        workspace = self.workspace(request, slug)
        organization = AdministrativeOrganization.objects.filter(pk=organization_id, workspace=workspace).first()
        if organization is None:
            raise NotFound()
        if not user_can_manage_administrative_organization(request.user, slug, organization_id):
            raise PermissionDenied()
        users = User.objects.filter(
            member_workspace__workspace=workspace,
            member_workspace__is_active=True,
            member_workspace__deleted_at__isnull=True,
            is_active=True,
        )
        if not organization.is_default:
            users = users.filter(
                id__in=AdministrativeOrganizationMember.objects.filter(
                    organization=organization, is_active=True
                ).values("member_id")
            )
        return Response(
            [
                {"id": str(user.id), "name": user.display_name or user.email, "email": user.email}
                for user in users.distinct().order_by("display_name", "id")
            ]
        )


class AdministrativeProjectApprovalEndpoint(AdministrativeBaseEndpoint):
    def get(self, request, slug, project_id):
        self.workspace(request, slug)
        project = self.project(request, slug, project_id)
        setting = AdministrativeProjectApprovalSetting.objects.filter(project=project).select_related("flow").first()
        can_submit = (project_role(request.user, project) or 0) >= 15 and not project.archived_at
        return Response(
            {
                "flow_id": str(setting.flow_id) if setting else None,
                "can_manage": can_manage_project(request.user, project),
                "can_submit": can_submit,
                "approvers": [
                    {"id": str(actor.id), "name": actor.display_name or actor.email}
                    for actor in approver_options(project)
                ]
                if can_submit
                else [],
                "organization_id": str(project.administrative_organization_id)
                if project.administrative_organization_id
                else None,
            }
        )

    @transaction.atomic
    def patch(self, request, slug, project_id):
        workspace = self.workspace(request, slug)
        project = self.project(request, slug, project_id)
        if not can_manage_project(request.user, project) or project.archived_at:
            raise PermissionDenied()
        flow = AdministrativeApprovalFlow.objects.filter(
            pk=request.data.get("flow_id"),
            workspace=workspace,
            organization_id=project.administrative_organization_id,
            is_active=True,
            is_template=True,
        ).first()
        if flow is None:
            raise ValidationError("请选择当前行政组织的有效审批流程。")
        AdministrativeProjectApprovalSetting.objects.update_or_create(project=project, defaults={"flow": flow})
        return self.get(request, slug, project_id)


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
