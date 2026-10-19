"""Workspace context independent of optional research features."""

from django.db import transaction
from rest_framework.response import Response
from plane.db.models import WorkspaceMember, WorkspaceResearchSetting, AdministrativeOrganizationMember
from plane.research.views.identity import ResearchIdentityMeEndpoint
from plane.research.utils.roles import is_system_admin
from plane.research.utils.org import ensure_root_org_unit


class WorkspaceContextEndpoint(ResearchIdentityMeEndpoint):
    def get(self, request, slug):
        response = super().get(request, slug)
        if response.status_code != 200:
            return response
        workspace, error = self.get_workspace(require_enabled=False)
        if error:
            return error
        from plane.utils.project_domains import research_admitted
        if not research_admitted(request.user, workspace):
            response.data["capabilities"]["nav"] = []
        admin = is_system_admin(request.user) or WorkspaceMember.objects.filter(
            workspace=workspace, member=request.user, is_active=True, role=20
        ).exists()
        organization_manager = AdministrativeOrganizationMember.objects.filter(
            workspace=workspace, member=request.user, role="ADMIN", is_active=True,
            organization__deleted_at__isnull=True,
        ).exists()
        response.data["navigation"] = {
            "administrative": True,
            "approvals": True,
            "management": admin or organization_manager or any(
                response.data["capabilities"]["management"].values()
            ),
            "workspace_settings": admin,
            "administrative_organizations": admin or organization_manager,
        }
        response.data["workspace"]["research_enabled"] = bool(
            getattr(getattr(workspace, "research_setting", None), "module_enabled", False)
        )
        return response

    @transaction.atomic
    def patch(self, request, slug):
        workspace, error = self.get_workspace(require_enabled=False)
        if error:
            return error
        if not (is_system_admin(request.user) or WorkspaceMember.objects.filter(
            workspace=workspace, member=request.user, is_active=True, role=20
        ).exists()):
            return Response({"message": "只有工作区管理员可以修改科研模块。"}, status=403)
        enabled = request.data.get("research_enabled")
        if type(enabled) is not bool:
            return Response({"research_enabled": "必须为布尔值。"}, status=400)
        setting, _ = WorkspaceResearchSetting.objects.select_for_update().get_or_create(workspace=workspace)
        if setting.purpose == "PI_PRIVATE" and enabled:
            return Response({"message": "主 PI 私有工作区仅支持行政项目。"}, status=422)
        setting.module_enabled = enabled
        setting.research_chain_enabled = True
        setting.save(update_fields=["module_enabled", "research_chain_enabled", "updated_at"])
        if enabled:
            ensure_root_org_unit(workspace, actor=request.user)
        return self.get(request, slug)
