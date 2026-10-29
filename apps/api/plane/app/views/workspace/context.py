"""Workspace context independent of optional research features."""

from django.db import transaction
from rest_framework.response import Response
from plane.db.models import WorkspaceResearchSetting, AdministrativeOrganizationMember
from plane.research.views.identity import ResearchIdentityMeEndpoint
from plane.research.utils.org import ensure_root_org_unit
from plane.utils.administrative_projects import (
    administrative_settings_admin_only,
    is_administrative_settings_admin,
)


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
        admin = is_administrative_settings_admin(request.user, workspace)
        organization_manager = AdministrativeOrganizationMember.objects.filter(
            workspace=workspace,
            member=request.user,
            role="ADMIN",
            is_active=True,
            organization__deleted_at__isnull=True,
        ).exists()
        response.data["navigation"] = {
            "administrative": True,
            "approvals": True,
            "management": admin or organization_manager or any(response.data["capabilities"]["management"].values()),
            "workspace_settings": admin,
            "administrative_organizations": admin or organization_manager,
        }
        response.data["workspace"]["research_enabled"] = bool(
            getattr(getattr(workspace, "research_setting", None), "module_enabled", False)
        )
        response.data["workspace"]["administrative_settings_admin_only"] = administrative_settings_admin_only(workspace)
        return response

    @transaction.atomic
    def patch(self, request, slug):
        workspace, error = self.get_workspace(require_enabled=False)
        if error:
            return error
        if not is_administrative_settings_admin(request.user, workspace):
            return Response({"message": "只有工作区管理员可以修改工作区配置。"}, status=403)
        enabled = request.data.get("research_enabled")
        administrative_only = request.data.get("administrative_settings_admin_only")
        update_fields = []
        if "research_enabled" in request.data:
            if type(enabled) is not bool:
                return Response({"research_enabled": "必须为布尔值。"}, status=400)
            update_fields.append("module_enabled")
        if "administrative_settings_admin_only" in request.data:
            if type(administrative_only) is not bool:
                return Response({"administrative_settings_admin_only": "必须为布尔值。"}, status=400)
            update_fields.append("administrative_settings_admin_only")
        if not update_fields:
            return Response({"research_enabled": "必须为布尔值。"}, status=400)
        setting, _ = WorkspaceResearchSetting.objects.select_for_update().get_or_create(workspace=workspace)
        if "research_enabled" in request.data and setting.purpose == "PI_PRIVATE" and enabled:
            return Response({"message": "主 PI 私有工作区仅支持行政项目。"}, status=422)
        if "research_enabled" in request.data:
            setting.module_enabled = enabled
            setting.research_chain_enabled = True
            update_fields.append("research_chain_enabled")
        if "administrative_settings_admin_only" in request.data:
            setting.administrative_settings_admin_only = administrative_only
        setting.save(update_fields=[*update_fields, "updated_at"])
        if "research_enabled" in request.data and enabled:
            ensure_root_org_unit(workspace, actor=request.user)
        return self.get(request, slug)
