# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

from django.db import IntegrityError, transaction
from django.db.models import Q
from django.utils import timezone
from rest_framework import status
from rest_framework.response import Response

from plane.db.models import (
    OrgUnit,
    Page,
    PeriodicReport,
    PeriodicReportProjectReference,
    ProjectPage,
    ReportAccessGrant,
    ReportAttachment,
    ReportReviewLog,
)
from plane.research.services.report_workflow import (
    ReportWorkflowError,
    create_report_draft,
    report_queryset,
    save_report_body,
    submit_report,
)
from plane.research.serializers import (
    PeriodicReportSerializer,
    ReportAccessGrantSerializer,
    ReportReviewLogSerializer,
)
from plane.research.services.approval_routes import (
    actor_can_review_route,
    active_approval_route_map,
    approval_route_payload,
    close_active_route,
    routed_resource_ids,
)
from plane.research.utils.acl import (
    build_actor_context,
    can_narrow,
    check_access,
    direct_advisor_ids,
    org_unit_ancestry,
    org_unit_scope_ids,
    visibility_breadth,
)
from plane.research.utils.audit import (
    ResearchAuditAction,
    ResearchResourceType,
    record_audit_event,
)
from plane.research.utils.capabilities import NAV_REPORTS
from plane.research.utils.roles import is_research_admin
from plane.research.utils.errors import (
    ResearchErrorCode,
    research_conflict,
    research_error,
    research_not_found,
    research_permission_denied,
)
from plane.research.utils.notifications import (
    notify_report_accepted,
    notify_report_returned,
    notify_report_withdrawn,
)
from plane.research.utils.roles import is_research_admin
from plane.research.utils.reports import can_transition, report_resource, visible_reports_queryset
from plane.research.utils.settings import default_visibility_for
from plane.research.views.base import ResearchAPIView, parse_date, parse_uuid, resolve_user, truthy


def serialize_report(
    report,
    request,
    context=None,
    *,
    include_draft_content=False,
    mentor_cache=None,
    confidential_cache=None,
    approval_route_cache=None,
):
    context = context if context is not None else build_actor_context(request.user, report.workspace_id)
    confidential_cache = confidential_cache if confidential_cache is not None else {}
    approval_route_cache = approval_route_cache if approval_route_cache is not None else {}
    return PeriodicReportSerializer(
        report,
        context={
            "request": request,
            "actor_context": context,
            "include_draft_content": include_draft_content,
            "mentor_cache": mentor_cache,
            "confidential_cache": confidential_cache,
            "_research_report_approval_routes": approval_route_cache,
        },
    ).data


def grant_is_within_visibility(report, default_visibility, grantee_user, grantee_unit_id):
    """Validate a custom recipient against the policy's actual recipient set."""
    if default_visibility == "WORKSPACE":
        if grantee_user is not None:
            return grantee_user.member_workspace.filter(
                workspace_id=report.workspace_id,
                is_active=True,
            ).exists()
        return bool(grantee_unit_id)
    if default_visibility == "DIRECT_ADVISOR":
        return grantee_user is not None and grantee_user.id in direct_advisor_ids(
            report.owner_id,
            report.workspace_id,
            report.org_unit_id,
        )
    if default_visibility == "UNIT":
        allowed_units = {str(item) for item in org_unit_scope_ids(report.org_unit_id, report.workspace_id)}
        if grantee_unit_id:
            return str(grantee_unit_id) in allowed_units
        return (
            grantee_user.research_org_memberships.filter(
                workspace_id=report.workspace_id,
                org_unit_id__in=allowed_units,
                deleted_at__isnull=True,
            ).exists()
            if grantee_user is not None
            else False
        )
    if default_visibility == "ANCESTRY":
        allowed_units = {str(item) for item in org_unit_ancestry(report.org_unit_id, report.workspace_id)}
        if grantee_unit_id:
            return str(grantee_unit_id) in allowed_units
        return (
            grantee_user.research_org_memberships.filter(
                workspace_id=report.workspace_id,
                org_unit_id__in=allowed_units,
                deleted_at__isnull=True,
            ).exists()
            if grantee_user is not None
            else False
        )
    return False


def validate_report_access_update(report, workspace, payload):
    """Validate a visibility/grant mutation against the locked report state."""
    default_visibility = default_visibility_for(report.report_type, workspace, report.org_unit)
    workspace_default_visibility = default_visibility_for(report.report_type, workspace)
    confidential_policy = default_visibility != workspace_default_visibility
    requested_visibility = report.visibility
    if "visibility" in payload:
        requested_visibility = str(payload.get("visibility") or "").strip().upper()
        if not requested_visibility or not can_narrow(default_visibility, requested_visibility):
            return (
                None,
                None,
                default_visibility,
                research_error(
                    ResearchErrorCode.REPORT_VISIBILITY_EXCEEDS_DEFAULT,
                    "The visibility cannot be wider than the workspace default.",
                    status.HTTP_422_UNPROCESSABLE_ENTITY,
                ),
            )

    validated_grants = None
    if "grants" in payload:
        if visibility_breadth(requested_visibility) == 0 or confidential_policy:
            return (
                None,
                None,
                default_visibility,
                research_error(
                    ResearchErrorCode.REPORT_VISIBILITY_EXCEEDS_DEFAULT,
                    "Custom grants are not available for private reports.",
                    status.HTTP_422_UNPROCESSABLE_ENTITY,
                ),
            )
        raw_grants = payload.get("grants") or []
        if not isinstance(raw_grants, list):
            return (
                None,
                None,
                default_visibility,
                research_error(
                    ResearchErrorCode.REPORT_VISIBILITY_EXCEEDS_DEFAULT,
                    "grants must be a list.",
                ),
            )
        validated_grants = []
        for entry in raw_grants:
            if not isinstance(entry, dict):
                return (
                    None,
                    None,
                    default_visibility,
                    research_error(
                        ResearchErrorCode.REPORT_VISIBILITY_EXCEEDS_DEFAULT,
                        "Each grant must be an object.",
                    ),
                )
            grantee_user = resolve_user(entry.get("grantee_user")) if entry.get("grantee_user") else None
            grantee_unit_id = entry.get("grantee_org_unit") or None
            if (
                grantee_unit_id
                and not OrgUnit.objects.filter(
                    workspace=workspace,
                    pk=grantee_unit_id,
                    deleted_at__isnull=True,
                ).exists()
            ):
                return (
                    None,
                    None,
                    default_visibility,
                    research_error(
                        ResearchErrorCode.ORG_UNIT_NOT_FOUND,
                        "Grant organisation not found.",
                    ),
                )
            if grantee_user is None and not grantee_unit_id:
                return (
                    None,
                    None,
                    default_visibility,
                    research_error(
                        ResearchErrorCode.REPORT_VISIBILITY_EXCEEDS_DEFAULT,
                        "Each grant needs a user or an org unit.",
                    ),
                )
            if grantee_user is not None and grantee_user.id == report.owner_id:
                continue
            if not grant_is_within_visibility(
                report,
                default_visibility,
                grantee_user,
                grantee_unit_id,
            ):
                return (
                    None,
                    None,
                    default_visibility,
                    research_error(
                        ResearchErrorCode.REPORT_VISIBILITY_EXCEEDS_DEFAULT,
                        "A custom grant must stay within the default audience.",
                        status.HTTP_422_UNPROCESSABLE_ENTITY,
                    ),
                )
            validated_grants.append((grantee_user, grantee_unit_id))
    return requested_visibility, validated_grants, default_visibility, None


class ResearchReportListCreateEndpoint(ResearchAPIView):
    """``GET``/``POST /api/research/workspaces/<slug>/reports/``"""

    nav_capability = NAV_REPORTS

    def get(self, request, slug):
        workspace, error = self.get_workspace(section="reports")
        if error:
            return error

        scope = request.GET.get("scope", "all")
        if scope not in ("all", "mine", "review", "deleted"):
            return Response({"error_code": "invalid_scope"}, status=400)

        queryset = report_queryset(workspace, include_deleted=scope == "deleted")
        if scope == "deleted":
            queryset = queryset.filter(deleted_at__isnull=False)
        if request.GET.get("period_key"):
            queryset = queryset.filter(period_key=request.GET["period_key"])
        if request.GET.get("status"):
            queryset = queryset.filter(status=str(request.GET["status"]).upper())
        if request.GET.get("report_type"):
            queryset = queryset.filter(report_type=str(request.GET["report_type"]).upper())
        org_unit_id, error = parse_uuid(request.GET.get("org_unit"), "org_unit")
        if error:
            return error
        owner_id, error = parse_uuid(request.GET.get("owner"), "owner")
        if error:
            return error
        date_from, error = parse_date(request.GET.get("date_from"), "date_from")
        if error:
            return error
        date_to, error = parse_date(request.GET.get("date_to"), "date_to")
        if error:
            return error
        if date_from and date_to and date_from > date_to:
            return research_error(
                ResearchErrorCode.ORG_MEMBER_INVALID,
                "date_from must not be after date_to.",
            )
        if org_unit_id:
            queryset = queryset.filter(org_unit_id=org_unit_id)
        if owner_id:
            queryset = queryset.filter(owner_id=owner_id)
        # A report only needs to overlap the selected range; weekly and monthly
        # periods can start before or end after the user's filter boundary.
        if date_from:
            queryset = queryset.filter(period_end__gte=date_from)
        if date_to:
            queryset = queryset.filter(period_start__lte=date_to)
        if truthy(request.GET.get("mine")):
            queryset = queryset.filter(owner=request.user)

        context = build_actor_context(request.user, workspace.id)
        confidential_cache = {}
        if scope == "deleted":
            visible_queryset = queryset if context.is_workspace_admin else queryset.filter(owner=request.user)
        else:
            visible_queryset = visible_reports_queryset(queryset, context, confidential_cache=confidential_cache)
        keyword = str(request.GET.get("q") or "").strip()[:200]
        if keyword:
            visible_queryset = visible_queryset.filter(
                Q(page__name__icontains=keyword)
                | Q(period_key__icontains=keyword)
                | Q(owner__display_name__icontains=keyword)
                | Q(owner__first_name__icontains=keyword)
            )
        if scope == "mine":
            visible_queryset = visible_queryset.filter(owner=request.user)
        elif scope == "review":
            visible_queryset = visible_queryset.filter(status="SUBMITTED").exclude(owner=request.user)
            if not is_research_admin(request.user, workspace.id):
                visible_queryset = visible_queryset.filter(
                    id__in=routed_resource_ids(workspace.id, "PERIODIC_REPORT", request.user)
                )
        elif scope == "deleted":
            pass
        elif scope != "all":
            return Response({"error_code": "invalid_scope"}, status=400)
        mentor_cache = {}
        approval_route_cache = {}

        def serialize_page(reports):
            approval_route_cache.update(
                active_approval_route_map("PERIODIC_REPORT", [report.id for report in reports], workspace.id)
            )
            return [
                serialize_report(
                    report,
                    request,
                    context,
                    mentor_cache=mentor_cache,
                    confidential_cache=confidential_cache,
                    approval_route_cache=approval_route_cache,
                )
                for report in reports
            ]

        return self.paginate(
            request=request,
            queryset=visible_queryset,
            on_results=serialize_page,
            default_per_page=50,
            max_per_page=100,
        )

    def post(self, request, slug):
        workspace, error = self.get_workspace(section="reports")
        if error:
            return error

        try:
            report = create_report_draft(workspace=workspace, actor=request.user, payload=request.data, request=request)
        except ReportWorkflowError as error:
            return Response(error.data, status=error.status_code)
        return Response(
            serialize_report(report, request, include_draft_content=True),
            status=status.HTTP_201_CREATED,
        )


class ResearchReportDetailEndpoint(ResearchAPIView):
    """``GET``/``PATCH /api/research/workspaces/<slug>/reports/<report_id>/``"""

    nav_capability = NAV_REPORTS
    research_membership_required = False

    def _visible_report(self, request, workspace, report_id, action="view"):
        report = report_queryset(workspace).filter(pk=report_id).first()
        if report is None:
            return None, research_not_found(ResearchErrorCode.REPORT_NOT_FOUND, "Report not found.")
        context = build_actor_context(request.user, workspace.id)
        if not check_access(request.user, action, report_resource(report), context=context):
            return None, research_not_found(ResearchErrorCode.REPORT_NOT_FOUND, "Report not found.")
        return report, None

    def get(self, request, slug, report_id):
        workspace, error = self.get_workspace(section="reports", nav=None, research_member=False)
        if error:
            return error
        report, error = self._visible_report(request, workspace, report_id)
        if error:
            return error
        return Response(
            serialize_report(report, request, include_draft_content=True),
            status=status.HTTP_200_OK,
        )

    def patch(self, request, slug, report_id):
        workspace, error = self.get_workspace(section="reports", nav=None, research_member=False)
        if error:
            return error
        try:
            report = save_report_body(
                workspace=workspace, actor=request.user, payload=request.data, report_id=report_id
            )
        except ReportWorkflowError as error:
            return Response(error.data, status=error.status_code)
        return Response(
            serialize_report(report, request, include_draft_content=True),
            status=status.HTTP_200_OK,
        )

    def delete(self, request, slug, report_id):
        from plane.research.utils.deletion import report_deletion_reason

        workspace, error = self.get_workspace(section="reports")
        if error:
            return error
        report, error = self._visible_report(request, workspace, report_id, action="delete")
        if error:
            return error
        with transaction.atomic():
            report = PeriodicReport.objects.select_for_update().get(pk=report.pk)
            reason = report_deletion_reason(report)
            if reason:
                return research_conflict("research_delete_blocked", reason)
            deleted_at = timezone.now()
            report.deleted_at = deleted_at
            report.save(update_fields=["deleted_at", "updated_at"])
            report.page.deleted_at = deleted_at
            report.page.save(update_fields=["deleted_at", "updated_at"])
            report.page.project_pages.update(deleted_at=deleted_at)
            report.team_project_references.update(deleted_at=deleted_at)
            report.attachments.update(deleted_at=deleted_at)
            record_audit_event(
                workspace=workspace,
                action="report.delete",
                resource_type=ResearchResourceType.REPORT,
                resource_id=report.pk,
                actor=request.user,
                metadata={"period_key": report.period_key},
                request=request,
            )
        return Response(status=status.HTTP_204_NO_CONTENT)


class ResearchReportRestoreEndpoint(ResearchAPIView):
    """``POST /api/research/workspaces/<slug>/reports/<report_id>/restore/``"""

    nav_capability = NAV_REPORTS

    @staticmethod
    def _restore_batch(queryset):
        """Clear soft deletion on every object locked in a restore batch.

        Args:
            queryset: A select-for-update queryset containing related objects.

        Returns:
            Number of related objects restored by this call.
        """
        restored = 0
        for item in queryset:
            item.deleted_at = None
            item.save(update_fields=["deleted_at", "updated_at"])
            restored += 1
        return restored

    def post(self, request, slug, report_id):
        workspace, error = self.get_workspace(section="reports")
        if error:
            return error

        report = (
            PeriodicReport.all_objects.select_related("owner", "org_unit", "page", "project", "template")
            .filter(workspace=workspace, pk=report_id, deleted_at__isnull=False)
            .first()
        )
        if report is None:
            return research_not_found(ResearchErrorCode.REPORT_NOT_FOUND, "Report not found.")

        context = build_actor_context(request.user, workspace.id)
        if not context.is_workspace_admin and report.owner_id != request.user.id:
            return research_not_found(ResearchErrorCode.REPORT_NOT_FOUND, "Report not found.")

        try:
            with transaction.atomic():
                report = PeriodicReport.all_objects.select_for_update().get(pk=report.pk)
                if report.deleted_at is None:
                    return research_not_found(ResearchErrorCode.REPORT_NOT_FOUND, "Report not found.")

                conflict = (
                    PeriodicReport.objects.select_for_update()
                    .filter(
                        workspace=workspace,
                        owner_id=report.owner_id,
                        report_type=report.report_type,
                        period_key=report.period_key,
                    )
                    .exclude(pk=report.pk)
                    .exists()
                )
                if conflict:
                    return research_conflict(
                        ResearchErrorCode.REPORT_PERIOD_CONFLICT,
                        "A report already exists for this period.",
                    )

                deleted_at = report.deleted_at
                report.deleted_at = None
                report.save(update_fields=["deleted_at", "updated_at"])

                page = Page.all_objects.select_for_update().get(pk=report.page_id)
                if page.deleted_at == deleted_at:
                    page.deleted_at = None
                    page.save(update_fields=["deleted_at", "updated_at"])

                self._restore_batch(
                    ProjectPage.all_objects.select_for_update().filter(
                        page_id=page.id,
                        deleted_at=deleted_at,
                    )
                )
                self._restore_batch(
                    PeriodicReportProjectReference.all_objects.select_for_update().filter(
                        report_id=report.id,
                        deleted_at=deleted_at,
                    )
                )
                self._restore_batch(
                    ReportAttachment.all_objects.select_for_update().filter(
                        report_id=report.id,
                        deleted_at=deleted_at,
                    )
                )
        except IntegrityError:
            return research_conflict(
                ResearchErrorCode.REPORT_PERIOD_CONFLICT,
                "A report already exists for this period.",
            )

        record_audit_event(
            workspace=workspace,
            action=ResearchAuditAction.REPORT_RESTORE,
            resource_type=ResearchResourceType.REPORT,
            resource_id=report.pk,
            org_unit=report.org_unit,
            actor=request.user,
            metadata={"report_type": report.report_type, "period_key": report.period_key},
            request=request,
        )
        return Response(
            serialize_report(report, request, include_draft_content=True),
            status=status.HTTP_200_OK,
        )


class ResearchReportSubmitEndpoint(ResearchAPIView):
    """``POST /api/research/workspaces/<slug>/reports/<report_id>/submit/``"""

    nav_capability = NAV_REPORTS

    def post(self, request, slug, report_id):
        """Submit a draft report and freeze its current official snapshot.

        Args:
            request: Authenticated request carrying optional final page content.
            slug: Workspace slug owning the report.
            report_id: Identifier of the report to submit.

        Returns:
            The submitted report representation with its draft content included.
        """
        workspace, error = self.get_workspace(section="reports")
        if error:
            return error
        try:
            report = submit_report(
                workspace=workspace, actor=request.user, payload=request.data, report_id=report_id, request=request
            )
        except ReportWorkflowError as error:
            return Response(error.data, status=error.status_code)
        return Response(
            serialize_report(report, request, include_draft_content=True),
            status=status.HTTP_200_OK,
        )


class ResearchReportWithdrawEndpoint(ResearchAPIView):
    """``POST /api/research/workspaces/<slug>/reports/<report_id>/withdraw/``"""

    nav_capability = NAV_REPORTS

    def post(self, request, slug, report_id):
        """Return a submitted report to its author for another editing round.

        Args:
            request: Authenticated request carrying an optional comment.
            slug: Workspace slug owning the report.
            report_id: Identifier of the submitted report.

        Returns:
            The draft report representation after a successful withdrawal.
        """
        workspace, error = self.get_workspace(section="reports")
        if error:
            return error

        target = PeriodicReport.Status.DRAFT
        comment = str(request.data.get("comment") or "").strip()
        with transaction.atomic():
            report = report_queryset(workspace).select_for_update(of=("self",)).filter(pk=report_id).first()
            if report is None:
                return research_not_found(ResearchErrorCode.REPORT_NOT_FOUND, "Report not found.")

            context = build_actor_context(request.user, workspace.id)
            if report.owner_id != request.user.id:
                if not check_access(request.user, "view", report_resource(report), context=context):
                    return research_not_found(ResearchErrorCode.REPORT_NOT_FOUND, "Report not found.")
                return research_permission_denied()
            if report.status != PeriodicReport.Status.SUBMITTED or not can_transition(report.status, target):
                return research_conflict(
                    ResearchErrorCode.REPORT_STATE_CONFLICT,
                    "The report status does not allow this action.",
                )

            snapshot_version = (
                report.official_snapshots.order_by("-version_no").values_list("version_no", flat=True).first()
            )
            previous = report.status
            route = close_active_route("PERIODIC_REPORT", report.id, report.workspace_id, request.user)
            report.status = target
            report.submitted_at = None
            report.accepted_at = None
            report.reviewer = None
            report.save(update_fields=["status", "submitted_at", "accepted_at", "reviewer", "updated_at"])
            ReportReviewLog.objects.create(
                report=report,
                actor=request.user,
                action=ReportReviewLog.Action.REOPEN,
                from_status=previous,
                to_status=target,
                comment=comment,
                snapshot_version=str(snapshot_version) if snapshot_version is not None else None,
            )

        record_audit_event(
            workspace=workspace,
            action=ResearchAuditAction.REPORT_WITHDRAW,
            resource_type=ResearchResourceType.REPORT,
            resource_id=report.id,
            org_unit=report.org_unit,
            actor=request.user,
            metadata={
                "period_key": report.period_key,
                "report_type": report.report_type,
                "snapshot_version": snapshot_version,
                "comment": comment[:240],
                "approval_route": str(route.id) if route else None,
            },
            request=request,
        )
        notify_report_withdrawn(report, request.user, comment, route=route)
        return Response(serialize_report(report, request, include_draft_content=True), status=status.HTTP_200_OK)


class ResearchReportApprovalRouteEndpoint(ResearchAPIView):
    """``GET /api/research/workspaces/<slug>/reports/<report_id>/approval-route/``"""

    nav_capability = NAV_REPORTS

    def get(self, request, slug, report_id):
        """Return report approval candidates for the author or an administrator."""
        workspace, error = self.get_workspace(section="reports")
        if error:
            return error
        report = report_queryset(workspace).filter(pk=report_id).first()
        if report is None:
            return research_not_found(ResearchErrorCode.REPORT_NOT_FOUND, "Report not found.")
        if report.owner_id != request.user.id and not is_research_admin(request.user, workspace.id):
            return research_permission_denied()
        data = approval_route_payload("PERIODIC_REPORT", report, report.owner)
        return Response(
            {
                "schema_version": data["schema_version"],
                "data": data,
            }
        )


class ResearchReportReturnEndpoint(ResearchAPIView):
    """``POST /api/research/workspaces/<slug>/reports/<report_id>/return/``"""

    nav_capability = NAV_REPORTS

    def post(self, request, slug, report_id):
        workspace, error = self.get_workspace(section="reports")
        if error:
            return error
        comment = str(request.data.get("comment") or "").strip()
        if not comment:
            return research_error(
                ResearchErrorCode.REPORT_RETURN_REASON_REQUIRED,
                "A reason is required when returning a report.",
                status.HTTP_422_UNPROCESSABLE_ENTITY,
            )

        target = PeriodicReport.Status.NEEDS_REVISION
        with transaction.atomic():
            report = report_queryset(workspace).select_for_update(of=("self",)).filter(pk=report_id).first()
            if report is None:
                return research_not_found(ResearchErrorCode.REPORT_NOT_FOUND, "Report not found.")
            if not can_transition(report.status, target):
                return research_conflict(
                    ResearchErrorCode.REPORT_STATE_CONFLICT,
                    "The report status does not allow this action.",
                )
            if not actor_can_review_route(workspace, "PERIODIC_REPORT", report.id, request.user):
                return research_permission_denied()

            previous = report.status
            route = close_active_route("PERIODIC_REPORT", report.id, report.workspace_id, request.user)
            report.status = target
            report.reviewer = request.user
            report.save(update_fields=["status", "reviewer", "updated_at"])
            ReportReviewLog.objects.create(
                report=report,
                actor=request.user,
                action=ReportReviewLog.Action.RETURN,
                from_status=previous,
                to_status=target,
                comment=comment,
            )

        record_audit_event(
            workspace=workspace,
            action=ResearchAuditAction.REPORT_RETURN,
            resource_type=ResearchResourceType.REPORT,
            resource_id=report.id,
            org_unit=report.org_unit,
            actor=request.user,
            metadata={
                "period_key": report.period_key,
                "reason_provided": True,
                "approval_route": str(route.id) if route else None,
            },
            request=request,
        )
        notify_report_returned(report, request.user, comment, route=route)
        return Response(serialize_report(report, request, include_draft_content=True), status=status.HTTP_200_OK)


class ResearchReportAcceptEndpoint(ResearchAPIView):
    """``POST /api/research/workspaces/<slug>/reports/<report_id>/accept/``"""

    nav_capability = NAV_REPORTS

    def post(self, request, slug, report_id):
        workspace, error = self.get_workspace(section="reports")
        if error:
            return error
        target = PeriodicReport.Status.ACCEPTED
        with transaction.atomic():
            report = report_queryset(workspace).select_for_update(of=("self",)).filter(pk=report_id).first()
            if report is None:
                return research_not_found(ResearchErrorCode.REPORT_NOT_FOUND, "Report not found.")
            if not can_transition(report.status, target):
                return research_conflict(
                    ResearchErrorCode.REPORT_STATE_CONFLICT,
                    "The report status does not allow this action.",
                )
            if not actor_can_review_route(workspace, "PERIODIC_REPORT", report.id, request.user):
                return research_permission_denied()

            previous = report.status
            route = close_active_route("PERIODIC_REPORT", report.id, report.workspace_id, request.user)
            report.status = target
            report.accepted_at = timezone.now()
            report.reviewer = request.user
            report.save(update_fields=["status", "accepted_at", "reviewer", "updated_at"])
            ReportReviewLog.objects.create(
                report=report,
                actor=request.user,
                action=ReportReviewLog.Action.ACCEPT,
                from_status=previous,
                to_status=target,
                comment=str(request.data.get("comment") or ""),
            )

        record_audit_event(
            workspace=workspace,
            action=ResearchAuditAction.REPORT_ACCEPT,
            resource_type=ResearchResourceType.REPORT,
            resource_id=report.id,
            org_unit=report.org_unit,
            actor=request.user,
            metadata={
                "period_key": report.period_key,
                "report_type": report.report_type,
                "approval_route": str(route.id) if route else None,
            },
            request=request,
        )
        notify_report_accepted(report, request.user, route=route)
        return Response(serialize_report(report, request, include_draft_content=True), status=status.HTTP_200_OK)


class ResearchReportHistoryEndpoint(ResearchAPIView):
    """``GET /api/research/workspaces/<slug>/reports/<report_id>/history/``"""

    nav_capability = NAV_REPORTS

    def get(self, request, slug, report_id):
        workspace, error = self.get_workspace(section="reports")
        if error:
            return error
        report = report_queryset(workspace).filter(pk=report_id).first()
        if report is None:
            return research_not_found(ResearchErrorCode.REPORT_NOT_FOUND, "Report not found.")
        context = build_actor_context(request.user, workspace.id)
        if not check_access(request.user, "view", report_resource(report), context=context):
            return research_not_found(ResearchErrorCode.REPORT_NOT_FOUND, "Report not found.")

        logs = list(ReportReviewLog.objects.filter(report=report).select_related("actor"))
        return Response(
            {"results": ReportReviewLogSerializer(logs, many=True).data, "count": len(logs)},
            status=status.HTTP_200_OK,
        )


class ResearchReportAccessEndpoint(ResearchAPIView):
    """``GET``/``PATCH /api/research/workspaces/<slug>/reports/<report_id>/access/``

    Authors may only narrow the workspace default and may only grant within that
    boundary (P0-ACL-04, P0-ACL-05).
    """

    nav_capability = NAV_REPORTS

    def _load(self, request, workspace, report_id, *, for_update=False):
        queryset = report_queryset(workspace)
        if for_update:
            queryset = queryset.select_for_update(of=("self",))
        report = queryset.filter(pk=report_id).first()
        if report is None:
            return None, research_not_found(ResearchErrorCode.REPORT_NOT_FOUND, "Report not found.")
        context = build_actor_context(request.user, workspace.id)
        if not check_access(request.user, "manage_access", report_resource(report), context=context):
            return None, research_not_found(ResearchErrorCode.REPORT_NOT_FOUND, "Report not found.")
        return report, None

    def _payload(self, workspace, report):
        default_visibility = default_visibility_for(report.report_type, workspace, report.org_unit)
        grants = list(ReportAccessGrant.objects.filter(report=report, is_revoked=False))
        return {
            "visibility": report.visibility,
            "default_visibility": default_visibility,
            "can_widen": False,
            "grants": ReportAccessGrantSerializer(grants, many=True).data,
        }

    def get(self, request, slug, report_id):
        workspace, error = self.get_workspace(section="reports")
        if error:
            return error
        report, error = self._load(request, workspace, report_id)
        if error:
            return error
        return Response(self._payload(workspace, report), status=status.HTTP_200_OK)

    def patch(self, request, slug, report_id):
        workspace, error = self.get_workspace(section="reports")
        if error:
            return error
        with transaction.atomic():
            report, error = self._load(request, workspace, report_id, for_update=True)
            if error:
                return error
            previous = {"visibility": report.visibility}
            requested_visibility, validated_grants, default_visibility, error = validate_report_access_update(
                report, workspace, request.data
            )
            if error:
                return error
            if validated_grants is not None:
                ReportAccessGrant.objects.filter(report=report, is_revoked=False).update(is_revoked=True)
                for grantee_user, grantee_unit_id in validated_grants:
                    ReportAccessGrant.objects.create(
                        report=report,
                        grantee_user=grantee_user,
                        grantee_org_unit_id=grantee_unit_id,
                        granted_by=request.user,
                    )
                report.visibility = "CUSTOM"
            else:
                report.visibility = requested_visibility
            report.save(update_fields=["visibility", "updated_at"])

        record_audit_event(
            workspace=workspace,
            action=ResearchAuditAction.REPORT_VISIBILITY_UPDATE,
            resource_type=ResearchResourceType.REPORT,
            resource_id=report.id,
            org_unit=report.org_unit,
            actor=request.user,
            metadata={
                "previous": previous,
                "visibility": report.visibility,
                "default_visibility": default_visibility,
            },
            request=request,
        )
        return Response(self._payload(workspace, report), status=status.HTTP_200_OK)
