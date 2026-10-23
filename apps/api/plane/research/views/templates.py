# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

from django.db import IntegrityError, transaction
from django.utils import timezone
from rest_framework import status
from rest_framework.response import Response

from plane.db.models import MATERIAL_TYPES_BY_STAGE, ReportTemplate, StageType
from plane.research.serializers import ReportTemplateOptionSerializer, ReportTemplateSerializer
from plane.research.utils.audit import (
    ResearchAuditAction,
    ResearchResourceType,
    record_audit_event,
)
from plane.research.utils.capabilities import NAV_REPORTS, NAV_TEMPLATES
from plane.research.utils.errors import (
    ResearchErrorCode,
    research_error,
    research_not_found,
    research_permission_denied,
)
from plane.research.utils.roles import is_research_admin
from plane.research.utils.templates import template_target_key, validate_template_sections
from plane.research.views.base import ResearchAPIView, truthy

REPORT_TYPES = ("WEEKLY", "MONTHLY")


def template_target_payload(scope, report_type, stage, material_type):
    """Normalize and validate the business object a template applies to.

    Args:
        scope: Template scope from the request.
        report_type: Periodic report type from the request.
        stage: Research stage code from the request.
        material_type: Stage material or experiment material code.

    Returns:
        ``(scope, report_type, stage, material_type, target_key, error)``.
    """
    scope = str(scope or ReportTemplate.Scope.REPORT).upper()
    report_type = str(report_type or "WEEKLY").strip().upper()
    stage = str(stage or "").strip().upper()
    material_type = str(material_type or "").strip().upper()
    if scope not in ReportTemplate.Scope.values:
        return None, None, None, None, None, research_error(
            ResearchErrorCode.TEMPLATE_NOT_FOUND, "Unknown template scope."
        )
    if scope == ReportTemplate.Scope.REPORT:
        if report_type not in REPORT_TYPES:
            return None, None, None, None, None, research_error(
                ResearchErrorCode.TEMPLATE_NOT_FOUND, "Unknown report type."
            )
    elif scope == ReportTemplate.Scope.STAGE_MATERIAL:
        if stage not in StageType.values:
            return None, None, None, None, None, research_error(
                ResearchErrorCode.TEMPLATE_NOT_FOUND, "Unknown research stage."
            )
        if material_type not in MATERIAL_TYPES_BY_STAGE.get(stage, ()):
            return None, None, None, None, None, research_error(
                ResearchErrorCode.TEMPLATE_NOT_FOUND, "Unknown stage material type."
            )
    elif not material_type:
        return None, None, None, None, None, research_error(
            ResearchErrorCode.TEMPLATE_NOT_FOUND, "material_type is required."
        )

    target_key = template_target_key(
        scope, report_type=report_type, stage=stage, material_type=material_type
    )
    return scope, report_type, stage, material_type, target_key, None


class ResearchReportTemplateListCreateEndpoint(ResearchAPIView):
    """``GET``/``POST /api/research/workspaces/<slug>/report-templates/``"""

    nav_capability = NAV_TEMPLATES

    def get(self, request, slug):
        workspace, error = self.get_workspace(section="reports")
        if error:
            return error
        templates = ReportTemplate.objects.filter(workspace=workspace)
        if request.GET.get("scope"):
            templates = templates.filter(scope=str(request.GET["scope"]).upper())
        if request.GET.get("report_type") and not request.GET.get("scope"):
            templates = templates.filter(
                scope=ReportTemplate.Scope.REPORT,
                report_type=str(request.GET["report_type"]).upper(),
            )
        if request.GET.get("stage"):
            templates = templates.filter(stage=str(request.GET["stage"]).upper())
        if request.GET.get("material_type"):
            templates = templates.filter(material_type=str(request.GET["material_type"]).upper())
        if not truthy(request.GET.get("include_inactive")):
            templates = templates.filter(is_active=True)
        data = list(templates.order_by("target_key", "name"))
        return Response(
            {"results": ReportTemplateSerializer(data, many=True).data, "count": len(data)},
            status=status.HTTP_200_OK,
        )

    def post(self, request, slug):
        workspace, error = self.get_workspace(section="reports")
        if error:
            return error
        if not is_research_admin(request.user, workspace.id):
            return research_permission_denied()

        name = str(request.data.get("name") or "").strip()
        if not name:
            return research_error(ResearchErrorCode.TEMPLATE_NOT_FOUND, "Template name is required.")
        scope, report_type, stage, material_type, target_key, error = template_target_payload(
            request.data.get("scope"),
            request.data.get("report_type"),
            request.data.get("stage"),
            request.data.get("material_type"),
        )
        if error:
            return error

        sections_json, section_error = validate_template_sections(request.data.get("sections_json"))
        if section_error:
            return research_error(ResearchErrorCode.TEMPLATE_NOT_FOUND, section_error)

        is_active = truthy(request.data.get("is_active"), default=True)
        is_default = truthy(request.data.get("is_default")) and is_active
        try:
            with transaction.atomic():
                if is_default:
                    ReportTemplate.objects.filter(
                        workspace=workspace, target_key=target_key, is_default=True
                    ).update(is_default=False)
                template = ReportTemplate.objects.create(
                    workspace=workspace,
                    name=name,
                    scope=scope,
                    report_type=report_type,
                    stage=stage,
                    material_type=material_type,
                    variables=list(request.data.get("variables") or []),
                    sections_json=sections_json,
                    content_json=(
                        {"type": "doc", "content": []}
                        if sections_json.get("sections")
                        else request.data.get("content_json") or {"type": "doc", "content": []}
                    ),
                    is_default=is_default,
                    is_active=is_active,
                )
        except IntegrityError:
            return research_error(
                ResearchErrorCode.TEMPLATE_NOT_FOUND,
                "A template with the same name already exists for this report type.",
            )

        record_audit_event(
            workspace=workspace,
            action=ResearchAuditAction.TEMPLATE_CREATE,
            resource_type=ResearchResourceType.REPORT_TEMPLATE,
            resource_id=template.id,
            actor=request.user,
            metadata={
                "name": name,
                "scope": scope,
                "target_key": target_key,
                "is_default": is_default,
            },
            request=request,
        )
        return Response(ReportTemplateSerializer(template).data, status=status.HTTP_201_CREATED)


class ResearchReportTemplateOptionListEndpoint(ResearchAPIView):
    """``GET /api/research/workspaces/<slug>/reports/template-options/``."""

    nav_capability = NAV_REPORTS

    def get(self, request, slug):
        workspace, error = self.get_workspace(section="reports")
        if error:
            return error
        templates = ReportTemplate.objects.filter(
            workspace=workspace,
            scope=ReportTemplate.Scope.REPORT,
            is_active=True,
        )
        if request.GET.get("report_type"):
            templates = templates.filter(report_type=str(request.GET["report_type"]).upper())
        data = list(templates.order_by("report_type", "name"))
        return Response(
            {"results": ReportTemplateOptionSerializer(data, many=True).data, "count": len(data)},
            status=status.HTTP_200_OK,
        )


class ResearchReportTemplateDetailEndpoint(ResearchAPIView):
    """``GET``/``PATCH``/``DELETE /api/research/workspaces/<slug>/report-templates/<pk>/``"""

    nav_capability = NAV_TEMPLATES

    def _get_template(self, workspace, pk):
        return ReportTemplate.objects.filter(workspace=workspace, pk=pk).first()

    def get(self, request, slug, pk):
        workspace, error = self.get_workspace(section="reports")
        if error:
            return error
        template = self._get_template(workspace, pk)
        if template is None:
            return research_not_found(ResearchErrorCode.TEMPLATE_NOT_FOUND, "Template not found.")
        return Response(ReportTemplateSerializer(template).data, status=status.HTTP_200_OK)

    def patch(self, request, slug, pk):
        workspace, error = self.get_workspace(section="reports")
        if error:
            return error
        if not is_research_admin(request.user, workspace.id):
            return research_permission_denied()
        template = self._get_template(workspace, pk)
        if template is None:
            return research_not_found(ResearchErrorCode.TEMPLATE_NOT_FOUND, "Template not found.")

        fields = []
        target_changed = False
        scope = template.scope
        report_type = template.report_type
        stage = template.stage
        material_type = template.material_type
        for field in ("scope", "report_type", "stage", "material_type"):
            if field in request.data:
                target_changed = True
        if target_changed:
            scope, report_type, stage, material_type, target_key, error = template_target_payload(
                request.data.get("scope", template.scope),
                request.data.get("report_type", template.report_type),
                request.data.get("stage", template.stage),
                request.data.get("material_type", template.material_type),
            )
            if error:
                return error
            template.scope = scope
            template.report_type = report_type
            template.stage = stage
            template.material_type = material_type
            template.target_key = target_key
            fields.extend(["scope", "report_type", "stage", "material_type", "target_key"])

        if "name" in request.data:
            name = str(request.data.get("name") or "").strip()
            if not name:
                return research_error(ResearchErrorCode.TEMPLATE_NOT_FOUND, "Template name is required.")
            template.name = name
            fields.append("name")
        if "variables" in request.data:
            template.variables = list(request.data.get("variables") or [])
            fields.append("variables")
        if "sections_json" in request.data:
            sections_json, section_error = validate_template_sections(request.data.get("sections_json"))
            if section_error:
                return research_error(ResearchErrorCode.TEMPLATE_NOT_FOUND, section_error)
            template.sections_json = sections_json
            fields.append("sections_json")
            if sections_json.get("sections"):
                fields.append("content_json")
                template.content_json = {}
            elif "content_json" not in request.data:
                template.content_json = request.data.get("content_json") or {"type": "doc", "content": []}
                fields.append("content_json")
        if "content_json" in request.data:
            template.content_json = request.data.get("content_json") or {}
            fields.append("content_json")
        if "is_active" in request.data:
            template.is_active = truthy(request.data.get("is_active"))
            fields.append("is_active")
        if "is_default" in request.data:
            wants_default = truthy(request.data.get("is_default"))
            template.is_default = wants_default
            fields.append("is_default")
        if not template.is_active and template.is_default:
            template.is_default = False
            if "is_default" not in fields:
                fields.append("is_default")

        try:
            with transaction.atomic():
                if template.is_default:
                    ReportTemplate.objects.filter(
                        workspace=workspace,
                        target_key=template.target_key,
                        is_default=True,
                    ).exclude(pk=template.pk).update(is_default=False)
                if fields:
                    template.save(update_fields=[*fields, "updated_at"])
        except IntegrityError:
            return research_error(
                ResearchErrorCode.TEMPLATE_NOT_FOUND,
                "A template with the same name already exists for this report type.",
            )

        record_audit_event(
            workspace=workspace,
            action=ResearchAuditAction.TEMPLATE_UPDATE,
            resource_type=ResearchResourceType.REPORT_TEMPLATE,
            resource_id=template.id,
            actor=request.user,
            metadata={"changed": fields, "is_default": template.is_default},
            request=request,
        )
        return Response(ReportTemplateSerializer(template).data, status=status.HTTP_200_OK)

    def delete(self, request, slug, pk):
        workspace, error = self.get_workspace(section="reports")
        if error:
            return error
        if not is_research_admin(request.user, workspace.id):
            return research_permission_denied()
        template = self._get_template(workspace, pk)
        if template is None:
            return research_not_found(ResearchErrorCode.TEMPLATE_NOT_FOUND, "Template not found.")

        template.is_active = False
        template.is_default = False
        template.deleted_at = timezone.now()
        template.save(update_fields=["is_active", "is_default", "deleted_at", "updated_at"])
        record_audit_event(
            workspace=workspace,
            action=ResearchAuditAction.TEMPLATE_DELETE,
            resource_type=ResearchResourceType.REPORT_TEMPLATE,
            resource_id=template.id,
            actor=request.user,
            metadata={"name": template.name},
            request=request,
        )
        return Response(status=status.HTTP_204_NO_CONTENT)
