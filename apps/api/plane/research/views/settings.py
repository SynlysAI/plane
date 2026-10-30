# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

import pytz
from django.conf import settings as django_settings
from rest_framework import status
from rest_framework.response import Response

from plane.db.models import ReportVisibility, ResearchUserProfile, WorkspaceResearchSetting
from plane.research.serializers import WorkspaceResearchSettingSerializer
from plane.research.utils.audit import (
    ResearchAuditAction,
    ResearchResourceType,
    record_audit_event,
)
from plane.research.utils.capabilities import NAV_PLATFORM
from plane.research.utils.errors import (
    ResearchErrorCode,
    research_error,
    research_permission_denied,
)
from plane.research.utils.org import ensure_root_org_unit
from plane.research.utils.roles import is_research_admin
from plane.research.utils.settings import default_workspace_research_settings
from plane.research.views.base import ResearchAPIView, truthy

BOOLEAN_FIELDS = (
    "allow_multiple_projects",
    "research_mcp_write_enabled",
    "research_agent_enabled",
    "research_agent_user_backend_enabled",
    "research_trace_enabled",
    "research_account_link_enabled",
    "research_external_rag_enabled",
)

VISIBILITY_FIELDS = (
    "default_report_visibility",
    "weekly_default_visibility",
    "monthly_default_visibility",
)

LIMIT_FIELDS = (
    "image_max_mb",
    "pdf_max_mb",
    "markdown_max_mb",
    "office_max_mb",
    "audit_retention_days",
)


def get_or_create_setting(workspace, actor=None):
    setting = WorkspaceResearchSetting.objects.filter(workspace=workspace).first()
    if setting is None:
        setting = WorkspaceResearchSetting.objects.create(
            workspace=workspace,
            created_by=actor,
            # Opening this page must not flip a workspace off unnoticed: a fresh
            # row inherits the deployment switch instead of the model default.
            module_enabled=default_workspace_research_settings()["module_enabled"],
        )
    return setting


class ResearchSettingsEndpoint(ResearchAPIView):
    """``GET``/``PATCH /api/research/workspaces/<slug>/settings/``

    The deployment switch is the outer gate; this endpoint manages the
    workspace level switches, upload limits and the default visibility policy
    (P0-CFG-01 ~ P0-CFG-08).
    """

    nav_capability = NAV_PLATFORM

    def get(self, request, slug):
        workspace, error = self.get_workspace(require_enabled=False)
        if error:
            return error
        setting = get_or_create_setting(workspace, actor=request.user)
        payload = WorkspaceResearchSettingSerializer(setting).data
        # 只给系统管理员解析候选显示名。找不到或没有显示名时不回传原始账号 ID。
        lookup = str(request.GET.get("lookup_user") or "").strip()
        if lookup:
            from plane.research.utils.roles import is_system_admin
            from plane.research.views.base import resolve_user

            if not is_system_admin(request.user):
                return research_permission_denied()
            user = resolve_user(lookup)
            name = str(getattr(user, "display_name", "") or "").strip() if user is not None else ""
            payload["lookup_user_found"] = bool(name)
            payload["lookup_user_name"] = name or None
        return Response(payload, status=status.HTTP_200_OK)

    def patch(self, request, slug):
        workspace, error = self.get_workspace(require_enabled=False)
        if error:
            return error
        if not is_research_admin(request.user, workspace.id):
            return research_permission_denied()

        setting = get_or_create_setting(workspace, actor=request.user)
        if "module_enabled" in request.data:
            return Response({"message": "请在工作区设置中修改科研模块状态。"}, status=400)
        if (
            "research_mcp_write_enabled" in request.data
            and truthy(request.data.get("research_mcp_write_enabled"))
            and not (django_settings.RESEARCH_MCP_ENABLED and django_settings.RESEARCH_MCP_WRITE_ENABLED)
        ):
            return Response(
                {"message": "服务器全局科研 MCP 读写开关未开启，不能开启工作区写入。"},
                status=status.HTTP_409_CONFLICT,
            )
        previous = WorkspaceResearchSettingSerializer(setting).data
        changed = []

        for field in BOOLEAN_FIELDS:
            if field in request.data:
                setattr(setting, field, truthy(request.data.get(field)))
                changed.append(field)

        for field in VISIBILITY_FIELDS:
            if field in request.data:
                value = request.data.get(field)
                if value in (None, ""):
                    if field == "default_report_visibility":
                        return research_error(
                            ResearchErrorCode.REPORT_VISIBILITY_EXCEEDS_DEFAULT,
                            "The default visibility is required.",
                        )
                    setattr(setting, field, None)
                elif value not in ReportVisibility.values:
                    return research_error(
                        ResearchErrorCode.REPORT_VISIBILITY_EXCEEDS_DEFAULT,
                        "Unknown visibility level.",
                    )
                else:
                    setattr(setting, field, value)
                changed.append(field)

        for field in LIMIT_FIELDS:
            if field in request.data:
                try:
                    value = int(request.data.get(field))
                except (TypeError, ValueError):
                    return research_error(
                        ResearchErrorCode.FILE_SIZE_EXCEEDED,
                        f"{field} must be a positive integer.",
                    )
                if value < 0:
                    return research_error(
                        ResearchErrorCode.FILE_SIZE_EXCEEDED,
                        f"{field} must be a positive integer.",
                    )
                deployment_limit_mb = max(
                    int(
                        getattr(
                            django_settings,
                            "RESEARCH_CHAIN_UPLOAD_MAX_BYTES",
                            500 * 1024 * 1024,
                        )
                    )
                    // (1024 * 1024),
                    1,
                )
                if field in {"image_max_mb", "pdf_max_mb", "markdown_max_mb", "office_max_mb"} and value > deployment_limit_mb:
                    return research_error(
                        ResearchErrorCode.FILE_SIZE_EXCEEDED,
                        f"{field} cannot exceed the deployment limit of {deployment_limit_mb}MB.",
                        status.HTTP_400_BAD_REQUEST,
                    )
                setattr(setting, field, value)
                changed.append(field)

        if "timezone" in request.data:
            timezone_value = request.data.get("timezone") or None
            if timezone_value and timezone_value not in pytz.all_timezones:
                return research_error(
                    ResearchErrorCode.ORG_UNIT_TYPE_INVALID,
                    "Unknown timezone.",
                )
            setting.timezone = timezone_value
            changed.append("timezone")

        if "required_reporter_categories" in request.data:
            categories = request.data.get("required_reporter_categories")
            if not isinstance(categories, list) or any(
                item not in ResearchUserProfile.Category.values for item in categories
            ):
                return research_error(
                    ResearchErrorCode.ORG_MEMBER_INVALID,
                    "required_reporter_categories must contain known member categories.",
                )
            setting.required_reporter_categories = list(dict.fromkeys(categories))
            changed.append("required_reporter_categories")

        if "main_pi" in request.data:
            from plane.research.utils.roles import is_system_admin, sync_main_pi_workspace_seat
            from plane.research.views.base import resolve_user

            if not is_system_admin(request.user):
                return research_permission_denied()
            if setting.purpose not in (
                WorkspaceResearchSetting.Purpose.PUBLIC_RESEARCH,
                WorkspaceResearchSetting.Purpose.PI_PRIVATE,
            ):
                return research_error(
                    ResearchErrorCode.PERMISSION_DENIED,
                    "Main PI can only be appointed for the paired public and private research workspaces.",
                    status.HTTP_422_UNPROCESSABLE_ENTITY,
                )
            main_pi = resolve_user(request.data.get("main_pi")) if request.data.get("main_pi") else None
            if request.data.get("main_pi") and main_pi is None:
                return research_error(ResearchErrorCode.USER_NOT_FOUND, "Main PI user not found.")
            previous_main_pi = setting.main_pi
            setting.main_pi = main_pi
            changed.append("main_pi")
            setting.save(update_fields=["main_pi", "updated_at"])
            # The appointment is unique across the paired public/private
            # workspaces. Keep both settings in sync while preserving stable
            # workspace URLs and the private-space admission hook below.
            paired_purpose = (
                WorkspaceResearchSetting.Purpose.PI_PRIVATE
                if setting.purpose == WorkspaceResearchSetting.Purpose.PUBLIC_RESEARCH
                else WorkspaceResearchSetting.Purpose.PUBLIC_RESEARCH
            )
            paired = WorkspaceResearchSetting.objects.filter(
                purpose=paired_purpose,
                deleted_at__isnull=True,
            ).first()
            if paired is not None:
                paired.main_pi = main_pi
                paired.save(update_fields=["main_pi", "updated_at"])
            if previous_main_pi is not None:
                sync_main_pi_workspace_seat(previous_main_pi, actor=request.user)
            if main_pi is not None:
                sync_main_pi_workspace_seat(main_pi, actor=request.user)

        if not changed:
            return Response(WorkspaceResearchSettingSerializer(setting).data, status=status.HTTP_200_OK)

        setting.save()

        # enabling the module provisions the organisation root so the tree is
        # never empty (P0-ORG-01)
        if setting.module_enabled:
            ensure_root_org_unit(workspace, actor=request.user)

        record_audit_event(
            workspace=workspace,
            action=ResearchAuditAction.CONFIG_UPDATE,
            resource_type=ResearchResourceType.WORKSPACE_SETTING,
            resource_id=setting.id,
            actor=request.user,
            metadata={
                "changed": changed,
                "previous": {field: previous.get(field) for field in changed},
                "current": {field: getattr(setting, field) for field in changed},
            },
            request=request,
        )
        return Response(WorkspaceResearchSettingSerializer(setting).data, status=status.HTTP_200_OK)
