# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

from rest_framework import status
from rest_framework.response import Response

from plane.db.models import PeriodicReportReadReceipt
from plane.research.serializers import PeriodicReportReadReceiptSerializer
from plane.research.services.report_read_receipt import ReportReadUnavailable, record_report_read
from plane.research.utils.acl import build_actor_context, check_access
from plane.research.utils.capabilities import NAV_REPORTS
from plane.research.utils.errors import (
    ResearchErrorCode,
    research_conflict,
    research_not_found,
    research_permission_denied,
)
from plane.research.utils.reports import report_resource
from plane.research.views.base import ResearchAPIView
from plane.research.views.reports import report_queryset


class ResearchReportReadEndpoint(ResearchAPIView):
    """``POST /api/research/workspaces/<slug>/reports/<report_id>/read/``"""

    nav_capability = NAV_REPORTS

    def post(self, request, slug, report_id):
        workspace, error = self.get_workspace(section="reports")
        if error:
            return error
        report = report_queryset(workspace).filter(pk=report_id).first()
        if report is None:
            return research_not_found(ResearchErrorCode.REPORT_NOT_FOUND, "Report not found.")

        context = build_actor_context(request.user, workspace.id)
        resource = report_resource(report)
        can_read = check_access(request.user, "view", resource, context=context) or check_access(
            request.user, "review", resource, context=context
        )
        if not can_read:
            return research_not_found(ResearchErrorCode.REPORT_NOT_FOUND, "Report not found.")
        if report.owner_id == request.user.id:
            return research_permission_denied()

        try:
            receipt = record_report_read(report=report, actor=request.user)
        except ReportReadUnavailable:
            return research_conflict(
                ResearchErrorCode.REPORT_STATE_CONFLICT,
                "An official report version is required before recording a read.",
            )

        latest_receipts = list(
            PeriodicReportReadReceipt.objects.filter(
                report=report,
                snapshot_version=receipt.snapshot_version,
            ).order_by("-read_at")
        )
        return Response(
            {
                "has_read": True,
                "read_at": receipt.read_at,
                "snapshot_version": receipt.snapshot_version,
                "read_count": len(latest_receipts),
                "latest_read_at": latest_receipts[0].read_at,
            },
            status=status.HTTP_200_OK,
        )


class ResearchReportReadReceiptListEndpoint(ResearchAPIView):
    """``GET /api/research/workspaces/<slug>/reports/<report_id>/read-receipts/``"""

    nav_capability = NAV_REPORTS

    def get(self, request, slug, report_id):
        workspace, error = self.get_workspace(section="reports")
        if error:
            return error
        report = report_queryset(workspace).filter(pk=report_id).first()
        if report is None:
            return research_not_found(ResearchErrorCode.REPORT_NOT_FOUND, "Report not found.")

        context = build_actor_context(request.user, workspace.id)
        resource = report_resource(report)
        if not context.is_workspace_admin and not check_access(request.user, "view", resource, context=context):
            return research_not_found(ResearchErrorCode.REPORT_NOT_FOUND, "Report not found.")
        can_see_summary = (
            report.owner_id == request.user.id
            or context.is_workspace_admin
            or context.is_main_pi
            or check_access(request.user, "review", resource, context=context)
        )
        if not can_see_summary:
            return research_permission_denied()

        receipts = list(
            PeriodicReportReadReceipt.objects.filter(report=report).select_related("reader").order_by("-read_at")
        )
        return Response(
            {
                "results": PeriodicReportReadReceiptSerializer(receipts, many=True).data,
                "count": len(receipts),
            },
            status=status.HTTP_200_OK,
        )
