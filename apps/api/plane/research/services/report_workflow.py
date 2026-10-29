# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Shared report creation, body editing and official submission workflow.

The caller resolves the workspace/feature gate and authenticated actor. These
functions enforce the existing report ACL and state machine. Every write entry
owns an atomic block; failures must escape it as exceptions. They can be nested
inside an Agent operation transaction so its durable result commits with them.
"""

from dataclasses import dataclass
from datetime import date

from django.db import IntegrityError, transaction
from django.db.models import Q
from django.utils import timezone
from rest_framework import status

from plane.app.serializers import PageBinaryUpdateSerializer
from plane.db.models import (
    OrgUnit,
    Page,
    PeriodicReport,
    PeriodicReportProjectReference,
    PeriodicReportSnapshot,
    Project,
    ProjectPage,
    ReportAttachment,
    ReportReviewLog,
    ReportTemplate,
    ResearchProjectProfile,
)
from plane.research.services.approval_routes import ApprovalRouteError, create_approval_route
from plane.research.utils.acl import build_actor_context, can_narrow, check_access
from plane.research.utils.audit import ResearchAuditAction, ResearchResourceType, record_audit_event
from plane.research.utils.errors import ResearchErrorCode
from plane.research.utils.notifications import notify_report_submitted
from plane.research.utils.periods import InvalidPeriod, current_period, parse_period
from plane.research.utils.roles import is_research_admin
from plane.research.utils.reports import can_transition, is_editable, report_resource
from plane.research.utils.settings import default_visibility_for, report_timezone_for
from plane.research.utils.templates import find_report_template, resolve_variables, template_target_key, template_values


class ReportWorkflowError(Exception):
    """Transport-neutral failure; catch only outside the workflow transaction."""

    def __init__(self, error_code=None, message=None, http_status=400, *, data=None):
        super().__init__(message or str(data))
        self.data = data if data is not None else {"error_code": error_code, "message": message}
        self.status_code = http_status

    @classmethod
    def conflict(cls, code, message):
        return cls(code, message, 409)

    @classmethod
    def not_found(cls, code, message):
        return cls(code, message, 404)

    @classmethod
    def permission_denied(cls):
        return cls(ResearchErrorCode.PERMISSION_DENIED, "You don't have the required permissions.", 403)


@dataclass(frozen=True)
class ReportContext:
    report_type: str
    report_timezone: str
    period_key: str
    period_start: date
    period_end: date
    profile: ResearchProjectProfile | None
    report_org_unit: OrgUnit | None
    team_projects: list
    current_key: str
    requested_visibility: str
    template: ReportTemplate | None
    template_content: dict


def report_queryset(workspace, include_deleted=False):
    """Build shared report queries; deleted rows require explicit caller opt-in.

    Callers using ``include_deleted`` must apply their own deleted-state and
    permission filters. Normal report and MCP queries retain the active manager.
    """
    manager = PeriodicReport.all_objects if include_deleted else PeriodicReport.objects
    return (
        manager.filter(workspace=workspace)
        .select_related("owner", "org_unit", "page", "project", "template")
        .prefetch_related(
            "team_projects",
            "attachments",
            "page__project_pages",
            "official_snapshots",
            "read_receipts",
            "access_grants",
        )
        .order_by("-period_start", "-created_at")
    )


def create_report_snapshot(report, actor):
    """Append the current draft body as the next immutable official version."""
    latest_version = (
        PeriodicReportSnapshot.objects.filter(report=report)
        .order_by("-version_no")
        .values_list("version_no", flat=True)
        .first()
        or 0
    )
    page = report.page
    attachment_manifest = [
        {
            "attachment_id": str(attachment.id),
            "asset_id": str(attachment.asset_id),
            "file_name": attachment.file_name,
            "file_size": attachment.file_size,
            "content_type": attachment.content_type,
            "kind": attachment.kind,
        }
        for attachment in ReportAttachment.objects.filter(
            report=report,
            deleted_at__isnull=True,
        ).order_by("created_at", "id")
    ]
    from plane.research.utils.report_images import image_manifest

    return PeriodicReportSnapshot.objects.create(
        report=report,
        version_no=latest_version + 1,
        snapshot_status=PeriodicReport.Status.SUBMITTED,
        description_json=page.description_json,
        description_html=page.description_html,
        description_stripped=page.description_stripped,
        description_binary=page.description_binary,
        attachment_manifest=attachment_manifest,
        image_manifest=image_manifest(report),
        submitted_by=actor,
    )


def resolve_report_context(*, workspace, actor, payload):
    report_type = str(payload.get("report_type") or "WEEKLY").strip().upper()
    if report_type not in PeriodicReport.ReportType.values:
        raise ReportWorkflowError(ResearchErrorCode.REPORT_PERIOD_CONFLICT, "Unknown report type.")

    report_timezone = report_timezone_for(workspace)
    try:
        period_key, period_start, period_end = parse_period(report_type, payload.get("period_key"), report_timezone)
    except InvalidPeriod as error:
        raise ReportWorkflowError(ResearchErrorCode.REPORT_PERIOD_CONFLICT, str(error))

    profile = (
        ResearchProjectProfile.objects.filter(
            workspace=workspace,
            owner=actor,
            research_type__in=(
                ResearchProjectProfile.ResearchType.PHD,
                ResearchProjectProfile.ResearchType.MASTER,
                ResearchProjectProfile.ResearchType.POSTDOC,
            ),
            is_active=True,
            workflow_status=ResearchProjectProfile.WorkflowStatus.ACTIVE,
        )
        .select_related("project", "org_unit")
        .first()
    )
    primary_membership = (
        actor.research_org_memberships.filter(
            workspace=workspace,
            is_primary=True,
            deleted_at__isnull=True,
            effective_from__lte=timezone.localdate(),
        )
        .filter(Q(effective_to__isnull=True) | Q(effective_to__gte=timezone.localdate()))
        .select_related("org_unit")
        .first()
    )
    if profile is None and primary_membership is None:
        raise ReportWorkflowError(
            ResearchErrorCode.PROJECT_NOT_FOUND,
            "A primary organisation assignment is required before creating reports.",
        )
    report_org_unit = (
        profile.org_unit
        if profile is not None and profile.org_unit_id
        else (primary_membership.org_unit if primary_membership is not None else None)
    )

    raw_team_projects = payload.get("team_projects") or []
    if not isinstance(raw_team_projects, list):
        raise ReportWorkflowError(ResearchErrorCode.PROJECT_NOT_FOUND, "team_projects must be a list.")
    eligible_team_projects = Project.objects.filter(
        workspace=workspace,
        research_profile__research_type=ResearchProjectProfile.ResearchType.RESEARCH_PROJECT,
        project_projectmember__member=actor,
        project_projectmember__is_active=True,
        deleted_at__isnull=True,
    ).distinct()
    team_projects = list(eligible_team_projects.filter(id__in=raw_team_projects))
    if len(team_projects) != len({str(item) for item in raw_team_projects}):
        raise ReportWorkflowError.permission_denied()

    current_key, _, _ = current_period(report_type, timezone_name=report_timezone)
    default_visibility = default_visibility_for(report_type, workspace, report_org_unit)
    requested_visibility = str(payload.get("visibility") or default_visibility).strip().upper()
    if not can_narrow(default_visibility, requested_visibility):
        raise ReportWorkflowError(
            ResearchErrorCode.REPORT_VISIBILITY_EXCEEDS_DEFAULT,
            "The visibility cannot be wider than the workspace default.",
            status.HTTP_422_UNPROCESSABLE_ENTITY,
        )

    template = None
    if payload.get("template"):
        template = ReportTemplate.objects.filter(
            workspace=workspace,
            pk=payload["template"],
            scope=ReportTemplate.Scope.REPORT,
            report_type=report_type,
            target_key=template_target_key(ReportTemplate.Scope.REPORT, report_type=report_type),
            is_active=True,
            deleted_at__isnull=True,
        ).first()
        if template is None:
            raise ReportWorkflowError(ResearchErrorCode.TEMPLATE_NOT_FOUND, "Template not found.")
    else:
        template = find_report_template(workspace, report_type)

    template_content = template.content_json if template is not None else {"type": "doc", "content": []}
    if template is not None:
        resolved, unresolved = resolve_variables(
            template_content,
            template_values(
                user=actor,
                project=profile.project if profile else None,
                stage="",
                org_unit=str(report_org_unit.id) if report_org_unit else "",
                period=period_key,
            ),
        )
        if unresolved:
            raise ReportWorkflowError(
                ResearchErrorCode.TEMPLATE_VARIABLES_UNRESOLVED,
                f"Unresolved template variables: {', '.join(unresolved)}.",
                status.HTTP_422_UNPROCESSABLE_ENTITY,
            )
        template_content = resolved

    return ReportContext(
        report_type=report_type,
        report_timezone=report_timezone,
        period_key=period_key,
        period_start=period_start,
        period_end=period_end,
        profile=profile,
        report_org_unit=report_org_unit,
        team_projects=team_projects,
        current_key=current_key,
        requested_visibility=requested_visibility,
        template=template,
        template_content=template_content,
    )


@transaction.atomic
def create_report_draft(*, workspace, actor, payload, request=None):
    context = resolve_report_context(workspace=workspace, actor=actor, payload=payload)
    report_type = context.report_type
    report_timezone = context.report_timezone
    period_key = context.period_key
    period_start = context.period_start
    period_end = context.period_end
    profile = context.profile
    report_org_unit = context.report_org_unit
    team_projects = context.team_projects
    current_key = context.current_key
    requested_visibility = context.requested_visibility
    template = context.template
    template_content = context.template_content

    if PeriodicReport.objects.filter(
        workspace=workspace,
        owner=actor,
        report_type=report_type,
        period_key=period_key,
    ).exists():
        raise ReportWorkflowError.conflict(
            ResearchErrorCode.REPORT_PERIOD_CONFLICT,
            "A report already exists for this period.",
        )

    try:
        with transaction.atomic():
            page = Page.objects.create(
                workspace=workspace,
                name=f"{period_key} {report_type}",
                description_json=template_content,
                description_html="<p></p>",
                owned_by=actor,
                access=Page.PRIVATE_ACCESS,
                created_by=actor,
            )
            # Plane ``Page`` does not require a ``ProjectPage``. Reports
            # without a cultivation project keep their private draft Page
            # inside the research flow so no arbitrary team project becomes
            # its owner and no synthetic project leaks into project lists.
            if profile is not None:
                ProjectPage.objects.create(
                    project=profile.project,
                    page=page,
                    workspace=workspace,
                    created_by=actor,
                )
            report = PeriodicReport.objects.create(
                workspace=workspace,
                project=profile.project if profile else None,
                owner=actor,
                org_unit=report_org_unit,
                page=page,
                template=template,
                report_type=report_type,
                period_key=period_key,
                period_start=period_start,
                period_end=period_end,
                timezone=report_timezone,
                visibility=requested_visibility,
                is_backfill=period_key != current_key,
                created_by=actor,
            )
            PeriodicReportProjectReference.objects.bulk_create(
                [
                    PeriodicReportProjectReference(
                        report=report,
                        project=team_project,
                        created_by=actor,
                    )
                    for team_project in team_projects
                ]
            )
    except IntegrityError:
        raise ReportWorkflowError.conflict(
            ResearchErrorCode.REPORT_PERIOD_CONFLICT,
            "A report already exists for this period.",
        )

    record_audit_event(
        workspace=workspace,
        action=ResearchAuditAction.REPORT_CREATE,
        resource_type=ResearchResourceType.REPORT,
        resource_id=report.id,
        org_unit=report.org_unit,
        actor=actor,
        metadata={
            "report_type": report_type,
            "period_key": period_key,
            "is_backfill": report.is_backfill,
            "template": str(template.id) if template else None,
        },
        request=request,
    )
    return report


def _save_page_body(report, payload, *, image_error_status):
    from plane.research.utils.report_images import body_image_ids

    body_payload = {
        field: payload[field]
        for field in ("description_json", "description_html", "description_binary")
        if field in payload
    }
    if not body_payload:
        return
    # PATCH historically returns a research image error (422). Submit leaves
    # this to the serializer (400), after field types have been validated.
    if image_error_status == 422:
        try:
            body_image_ids(report, body_payload)
        except ValueError as error:
            raise ReportWorkflowError("file_type_not_allowed", str(error), 422) from error
    # A replacement without a Yjs update must not resurrect the previous body.
    body_payload.setdefault("description_binary", "")
    serializer = PageBinaryUpdateSerializer(report.page, data=body_payload, partial=True)
    if not serializer.is_valid():
        raise ReportWorkflowError(data=serializer.errors)
    serializer.save()


@transaction.atomic
def save_report_body(*, workspace, actor, report_id, payload):
    report = report_queryset(workspace).select_for_update(of=("self",)).filter(pk=report_id).first()
    if report is None or not check_access(
        actor, "edit", report_resource(report), context=build_actor_context(actor, workspace.id)
    ):
        raise ReportWorkflowError.not_found(ResearchErrorCode.REPORT_NOT_FOUND, "Report not found.")
    report.page = Page.objects.select_for_update().get(pk=report.page_id)
    if not is_editable(report):
        raise ReportWorkflowError.conflict(
            ResearchErrorCode.REPORT_READ_ONLY,
            "A submitted report is read only. Return it before editing.",
        )

    # The body lives in the linked Page. A report without a cultivation
    # project has no ProjectPage route, so its author edits the same Page
    # through this research endpoint.
    if payload.get("template"):
        template = ReportTemplate.objects.filter(
            workspace=workspace,
            pk=payload["template"],
            scope=ReportTemplate.Scope.REPORT,
            report_type=report.report_type,
            target_key=template_target_key(ReportTemplate.Scope.REPORT, report_type=report.report_type),
            is_active=True,
            deleted_at__isnull=True,
        ).first()
        if template is None:
            raise ReportWorkflowError(ResearchErrorCode.TEMPLATE_NOT_FOUND, "Template not found.")
        resolved, unresolved = resolve_variables(
            template.content_json,
            template_values(
                user=actor,
                project=report.project,
                stage="",
                org_unit=str(report.org_unit_id or ""),
                period=report.period_key,
            ),
        )
        if unresolved:
            raise ReportWorkflowError(
                ResearchErrorCode.TEMPLATE_VARIABLES_UNRESOLVED,
                f"Unresolved template variables: {', '.join(unresolved)}.",
                status.HTTP_422_UNPROCESSABLE_ENTITY,
            )
        report.page.description_json = resolved
        report.page.save(update_fields=["description_json", "updated_at"])
        if report.template_id != template.id:
            report.template = template
            report.save(update_fields=["template", "updated_at"])

    _save_page_body(report, payload, image_error_status=422)

    if "is_backfill" in payload:
        report.is_backfill = str(payload.get("is_backfill")).strip().lower() in ("1", "true", "yes", "on")
        report.save(update_fields=["is_backfill", "updated_at"])

    return report


@transaction.atomic
def submit_report(*, workspace, actor, report_id, payload, request=None):
    target = PeriodicReport.Status.SUBMITTED
    report = report_queryset(workspace).select_for_update(of=("self",)).filter(pk=report_id).first()
    if report is None or (report.owner_id != actor.id and not is_research_admin(actor, workspace.id)):
        raise ReportWorkflowError.not_found(ResearchErrorCode.REPORT_NOT_FOUND, "Report not found.")
    if report.org_unit_id is None:
        raise ReportWorkflowError(
            ResearchErrorCode.ORG_UNIT_NOT_FOUND,
            "A report must have an organisation assignment before submission.",
            status.HTTP_422_UNPROCESSABLE_ENTITY,
        )
    if not can_transition(report.status, target):
        raise ReportWorkflowError.conflict(
            ResearchErrorCode.REPORT_STATE_CONFLICT,
            "The report status does not allow this action.",
        )

    report.page = Page.objects.select_for_update().get(pk=report.page_id)
    _save_page_body(report, payload, image_error_status=400)

    previous = report.status
    try:
        snapshot = create_report_snapshot(report, actor)
    except ValueError as error:
        raise ReportWorkflowError("file_type_not_allowed", str(error), 422) from error
    try:
        route = create_approval_route(
            workspace=workspace,
            resource_type="PERIODIC_REPORT",
            resource=report,
            submitted_by=actor,
            reviewer_id=payload.get("reviewer_id"),
            cc_user_ids=payload.get("cc_user_ids", []),
            request_id=f"report-{report.id}-v{snapshot.version_no}",
        )
    except ApprovalRouteError as error:
        raise ReportWorkflowError(error.error_code, error.message, status.HTTP_422_UNPROCESSABLE_ENTITY) from error
    ReportAttachment.objects.filter(
        report=report,
        deleted_at__isnull=True,
    ).update(official_version_no=snapshot.version_no)
    report.status = target
    report.submitted_at = timezone.now()
    report.save(update_fields=["status", "submitted_at", "updated_at"])
    ReportReviewLog.objects.create(
        report=report,
        actor=actor,
        action=ReportReviewLog.Action.SUBMIT,
        from_status=previous,
        to_status=target,
        comment=str(payload.get("comment") or ""),
        snapshot_version=str(snapshot.version_no),
    )
    report._prefetched_objects_cache.pop("official_snapshots", None)
    report._prefetched_objects_cache.pop("attachments", None)

    record_audit_event(
        workspace=workspace,
        action=ResearchAuditAction.REPORT_SUBMIT,
        resource_type=ResearchResourceType.REPORT,
        resource_id=report.id,
        org_unit=report.org_unit,
        actor=actor,
        metadata={
            "period_key": report.period_key,
            "report_type": report.report_type,
            "approval_route": str(route.id),
            "reviewer": str(route.reviewer_id),
        },
        request=request,
    )
    report._workflow_approval_route = route
    report._workflow_notifications = notify_report_submitted(report, actor, route=route)
    return report
