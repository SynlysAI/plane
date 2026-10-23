"""Report comment threads with snapshot-scoped anchors and explicit HITL feedback."""

from django.db import transaction
from django.utils import timezone
from rest_framework import status
from rest_framework.response import Response

from plane.db.models import (
    PeriodicReportComment,
    PeriodicReportCommentFeedback,
    PeriodicReportCommentThread,
    ResearchAgentSession,
)
from plane.research.serializers import (
    PeriodicReportCommentFeedbackSerializer,
    PeriodicReportCommentSerializer,
    PeriodicReportCommentThreadSerializer,
)
from plane.research.services.report_comment_feedback import (
    build_feedback_payload,
    session_allows_report,
)
from plane.research.utils.acl import build_actor_context, check_access
from plane.research.utils.audit import ResearchAuditAction, ResearchResourceType, record_audit_event
from plane.research.utils.capabilities import NAV_REPORTS
from plane.research.utils.errors import research_error, research_not_found, research_permission_denied
from plane.research.utils.errors import ResearchErrorCode
from plane.research.utils.notifications import notify_report_comment
from plane.research.utils.report_comment_anchors import (
    ReportAnchorError,
    snapshot_content_hash,
    validate_report_anchor,
)
from plane.research.utils.reports import report_resource
from plane.research.utils.roles import is_research_admin
from plane.research.views.base import ResearchAPIView
from plane.research.views.reports import report_queryset
from plane.utils.html_processor import strip_tags


def _actor_context(request, workspace_id):
    """Build one request-scoped research ACL context."""
    return build_actor_context(request.user, workspace_id)


def _load_visible_report(view, request, slug, report_id):
    """Load a report or return the same not-found boundary as report detail."""
    workspace, error = view.get_workspace(section="reports")
    if error:
        return None, None, error
    report = report_queryset(workspace).filter(pk=report_id).first()
    if report is None:
        return None, None, research_not_found("report_not_found", "Report not found.")
    context = _actor_context(request, workspace.id)
    if not check_access(request.user, "view", report_resource(report), context=context):
        return None, None, research_not_found("report_not_found", "Report not found.")
    return report, context, None


def _latest_snapshot(report):
    """Return the newest immutable formal snapshot, if one exists."""
    return report.official_snapshots.order_by("-version_no").first()


def _thread_queryset(report):
    """Return active threads with all actor and feedback data prefetched."""
    return (
        PeriodicReportCommentThread.objects.filter(report=report, deleted_at__isnull=True)
        .select_related("report", "created_by", "status_updated_by")
        .prefetch_related(
            "comments__actor",
            "comments__ai_feedback",
        )
        .order_by("-last_activity_at", "-created_at")
    )


def _can_manage_thread(report, thread, user, context) -> bool:
    """Resolve thread-state permissions without granting comment edit rights."""
    return bool(
        report.owner_id == user.id
        or thread.created_by_id == user.id
        or is_research_admin(user, report.workspace_id)
        or check_access(user, "review", report_resource(report), context=context)
    )


def _serialize_thread(thread, request, context) -> dict:
    """Serialize a thread with its request-specific resolve capability."""
    return PeriodicReportCommentThreadSerializer(
        thread,
        context={"request": request, "can_resolve": _can_manage_thread(thread.report, thread, request.user, context)},
    ).data


def _audit_comment(report, thread, comment, request, action):
    """Append a compact audit fact for one report-comment operation."""
    record_audit_event(
        workspace=report.workspace,
        action=action,
        resource_type=ResearchResourceType.REPORT_COMMENT,
        resource_id=comment.pk,
        org_unit=report.org_unit,
        actor=request.user,
        metadata={
            "report": str(report.id),
            "thread": str(thread.id),
            "feedback_type": comment.feedback_type,
            "comment": comment.comment_stripped[:240],
        },
        request=request,
    )


def _request_id_error(request):
    """Validate the idempotency key required for all comment creation calls."""
    request_id = str(request.data.get("request_id") or "")
    if not request_id or len(request_id) > 128:
        return None, research_error(
            ResearchErrorCode.REPORT_COMMENT_INVALID,
            "A request_id of at most 128 characters is required.",
        )
    return request_id, None


def _feedback_type_error(request):
    """Keep new report discussions generic while retaining legacy read values."""
    feedback_type = request.data.get("feedback_type")
    if feedback_type is None or feedback_type == PeriodicReportComment.FeedbackType.DISCUSSION:
        return None
    return research_error(
        ResearchErrorCode.REPORT_COMMENT_INVALID,
        "feedback_type must be DISCUSSION.",
    )


class ResearchReportCommentThreadListCreateEndpoint(ResearchAPIView):
    """``GET/POST /api/research/workspaces/<slug>/reports/<report_id>/comment-threads/``"""

    nav_capability = NAV_REPORTS

    def get(self, request, slug, report_id):
        report, context, error = _load_visible_report(self, request, slug, report_id)
        if error:
            return error
        status_filter = str(request.GET.get("status") or "OPEN").upper()
        if status_filter not in {"OPEN", "RESOLVED", "ALL"}:
            return research_error(ResearchErrorCode.REPORT_COMMENT_INVALID, "status must be OPEN, RESOLVED, or ALL.")
        queryset = _thread_queryset(report)
        if status_filter != "ALL":
            queryset = queryset.filter(status=status_filter)
        threads = list(queryset)
        snapshot = _latest_snapshot(report)
        return Response(
            {
                "results": [_serialize_thread(thread, request, context) for thread in threads],
                "count": len(threads),
                "status_filter": status_filter,
                "can_comment": snapshot is not None,
                "snapshot_version": snapshot.version_no if snapshot else None,
            }
        )

    def post(self, request, slug, report_id):
        report, context, error = _load_visible_report(self, request, slug, report_id)
        if error:
            return error
        snapshot = _latest_snapshot(report)
        if snapshot is None:
            return research_error(
                ResearchErrorCode.REPORT_COMMENT_NO_SNAPSHOT,
                "A report must have an official snapshot before it can be discussed.",
                status.HTTP_409_CONFLICT,
            )
        request_id, error = _request_id_error(request)
        if error:
            return error
        existing = (
            PeriodicReportComment.objects.select_related("thread", "actor", "thread__report")
            .prefetch_related("ai_feedback")
            .filter(
                thread__report=report,
                actor=request.user,
                request_id=request_id,
                parent__isnull=True,
                deleted_at__isnull=True,
            )
            .first()
        )
        if existing is not None:
            return Response(_serialize_thread(existing.thread, request, context), status=status.HTTP_200_OK)

        error = _feedback_type_error(request)
        if error:
            return error
        anchor = request.data.get("anchor")
        quoted_text = ""
        if anchor is not None:
            try:
                anchor = validate_report_anchor(snapshot.description_json, anchor)
            except ReportAnchorError as exc:
                return research_error(
                    ResearchErrorCode.REPORT_COMMENT_ANCHOR_INVALID,
                    str(exc),
                    status.HTTP_422_UNPROCESSABLE_ENTITY,
                )
            quoted_text = anchor["selected_text"]

        payload = {
            "comment_html": request.data.get("comment_html"),
        }
        serializer = PeriodicReportCommentSerializer(data=payload, context={"request": request})
        if not serializer.is_valid():
            return research_error(
                ResearchErrorCode.REPORT_COMMENT_INVALID,
                "A non-empty, valid comment is required.",
            )

        with transaction.atomic():
            thread = PeriodicReportCommentThread.objects.create(
                report=report,
                anchor=anchor,
                quoted_text=quoted_text,
                snapshot_version=snapshot.version_no,
                content_hash=snapshot_content_hash(snapshot),
                created_by=request.user,
                status_updated_by=request.user,
            )
            comment = serializer.save(
                thread=thread,
                actor=request.user,
                comment_stripped=strip_tags(serializer.validated_data["comment_html"]),
                request_id=request_id,
                created_by=request.user,
            )

        _audit_comment(report, thread, comment, request, ResearchAuditAction.REPORT_COMMENT_CREATE)
        notify_report_comment(report, thread, comment, request.user, action="created")
        thread = _thread_queryset(report).get(pk=thread.pk)
        return Response(_serialize_thread(thread, request, context), status=status.HTTP_201_CREATED)


class ResearchReportCommentThreadCommentEndpoint(ResearchAPIView):
    """``POST /api/research/workspaces/<slug>/reports/<report_id>/comment-threads/<thread_id>/comments/``"""

    nav_capability = NAV_REPORTS

    def post(self, request, slug, report_id, thread_id):
        report, context, error = _load_visible_report(self, request, slug, report_id)
        if error:
            return error
        thread = _thread_queryset(report).filter(pk=thread_id).first()
        if thread is None:
            return research_not_found(ResearchErrorCode.REPORT_COMMENT_NOT_FOUND, "Comment thread not found.")
        request_id, error = _request_id_error(request)
        if error:
            return error
        existing = (
            PeriodicReportComment.objects.select_related("thread", "actor")
            .prefetch_related("ai_feedback")
            .filter(thread__report=report, actor=request.user, request_id=request_id, deleted_at__isnull=True)
            .first()
        )
        if existing is not None:
            if existing.thread_id != thread.id:
                return research_error(
                    ResearchErrorCode.REPORT_COMMENT_REQUEST_CONFLICT,
                    "request_id was already used with another comment.",
                    status.HTTP_409_CONFLICT,
                )
            return Response(PeriodicReportCommentSerializer(existing, context={"request": request}).data)

        error = _feedback_type_error(request)
        if error:
            return error
        parent_id = request.data.get("parent")
        parent = None
        if parent_id:
            parent = thread.comments.filter(pk=parent_id, deleted_at__isnull=True).first()
            if parent is None:
                return research_error(
                    ResearchErrorCode.REPORT_COMMENT_INVALID,
                    "Parent comment must belong to this thread.",
                )

        payload = {
            "comment_html": request.data.get("comment_html"),
        }
        serializer = PeriodicReportCommentSerializer(data=payload, context={"request": request})
        if not serializer.is_valid():
            return research_error(
                ResearchErrorCode.REPORT_COMMENT_INVALID,
                "A non-empty, valid comment is required.",
            )

        with transaction.atomic():
            comment = serializer.save(
                thread=thread,
                parent=parent,
                actor=request.user,
                comment_stripped=strip_tags(serializer.validated_data["comment_html"]),
                request_id=request_id,
                created_by=request.user,
            )
            thread.last_activity_at = comment.created_at
            thread.save(update_fields=["last_activity_at", "updated_at"])

        _audit_comment(report, thread, comment, request, ResearchAuditAction.REPORT_COMMENT_CREATE)
        notify_report_comment(report, thread, comment, request.user, action="created")
        return Response(PeriodicReportCommentSerializer(comment, context={"request": request}).data, status=201)


class ResearchReportCommentDetailEndpoint(ResearchAPIView):
    """``PATCH/DELETE /api/research/workspaces/<slug>/reports/<report_id>/comments/<comment_id>/``"""

    nav_capability = NAV_REPORTS

    def _comment(self, request, slug, report_id, comment_id):
        report, context, error = _load_visible_report(self, request, slug, report_id)
        if error:
            return None, None, None, error
        comment = (
            PeriodicReportComment.objects.select_related("thread", "thread__report", "actor")
            .prefetch_related("ai_feedback")
            .filter(thread__report=report, pk=comment_id, deleted_at__isnull=True)
            .first()
        )
        if comment is None:
            return (
                None,
                None,
                None,
                research_not_found(
                    ResearchErrorCode.REPORT_COMMENT_NOT_FOUND,
                    "Comment not found.",
                ),
            )
        if comment.actor_id != request.user.id:
            return None, None, None, research_permission_denied()
        return report, comment.thread, comment, None

    def patch(self, request, slug, report_id, comment_id):
        report, thread, comment, error = self._comment(request, slug, report_id, comment_id)
        if error:
            return error
        error = _feedback_type_error(request)
        if error:
            return error
        if "comment_html" not in request.data:
            return Response(PeriodicReportCommentSerializer(comment, context={"request": request}).data)
        payload = {"comment_html": request.data.get("comment_html")}
        serializer = PeriodicReportCommentSerializer(
            comment,
            data=payload,
            partial=True,
            context={"request": request},
        )
        if not serializer.is_valid():
            return research_error(
                ResearchErrorCode.REPORT_COMMENT_INVALID,
                "A non-empty, valid comment is required.",
            )
        with transaction.atomic():
            comment = serializer.save(edited_at=timezone.now(), updated_by=request.user)
            if "comment_html" in serializer.validated_data:
                comment.comment_stripped = strip_tags(comment.comment_html)
                comment.save(update_fields=["comment_stripped", "updated_at"])
            thread.last_activity_at = comment.updated_at
            thread.save(update_fields=["last_activity_at", "updated_at"])

        _audit_comment(report, thread, comment, request, ResearchAuditAction.REPORT_COMMENT_UPDATE)
        notify_report_comment(report, thread, comment, request.user, action="updated")
        return Response(PeriodicReportCommentSerializer(comment, context={"request": request}).data)

    def delete(self, request, slug, report_id, comment_id):
        report, thread, comment, error = self._comment(request, slug, report_id, comment_id)
        if error:
            return error
        with transaction.atomic():
            now = timezone.now()
            comment.deleted_at = now
            comment.updated_by = request.user
            comment.save(update_fields=["deleted_at", "updated_by", "updated_at"])
            feedback = getattr(comment, "ai_feedback", None)
            if feedback is not None and feedback.status != PeriodicReportCommentFeedback.Status.WITHDRAWN:
                feedback.status = PeriodicReportCommentFeedback.Status.WITHDRAWN
                feedback.save(update_fields=["status", "updated_at"])

        _audit_comment(report, thread, comment, request, ResearchAuditAction.REPORT_COMMENT_DELETE)
        return Response(status=status.HTTP_204_NO_CONTENT)


class ResearchReportCommentThreadStatusEndpoint(ResearchAPIView):
    """``POST /api/research/workspaces/<slug>/reports/<report_id>/comment-threads/<thread_id>/status/``"""

    nav_capability = NAV_REPORTS

    def post(self, request, slug, report_id, thread_id):
        report, context, error = _load_visible_report(self, request, slug, report_id)
        if error:
            return error
        thread = _thread_queryset(report).filter(pk=thread_id).first()
        if thread is None:
            return research_not_found(ResearchErrorCode.REPORT_COMMENT_NOT_FOUND, "Comment thread not found.")
        if not _can_manage_thread(report, thread, request.user, context):
            return research_permission_denied()
        requested = str(request.data.get("status") or "").upper()
        if requested not in {PeriodicReportCommentThread.Status.OPEN, PeriodicReportCommentThread.Status.RESOLVED}:
            return research_error(ResearchErrorCode.REPORT_COMMENT_INVALID, "status must be OPEN or RESOLVED.")
        if requested == thread.status:
            return Response(_serialize_thread(thread, request, context))

        action = (
            ResearchAuditAction.REPORT_COMMENT_RESOLVE
            if requested == PeriodicReportCommentThread.Status.RESOLVED
            else ResearchAuditAction.REPORT_COMMENT_REOPEN
        )
        with transaction.atomic():
            thread.status = requested
            thread.status_updated_at = timezone.now()
            thread.status_updated_by = request.user
            thread.last_activity_at = thread.status_updated_at
            thread.save(
                update_fields=[
                    "status",
                    "status_updated_at",
                    "status_updated_by",
                    "last_activity_at",
                    "updated_at",
                ]
            )

        record_audit_event(
            workspace=report.workspace,
            action=action,
            resource_type=ResearchResourceType.REPORT_COMMENT,
            resource_id=thread.pk,
            org_unit=report.org_unit,
            actor=request.user,
            metadata={"report": str(report.id), "thread": str(thread.id), "status": requested},
            request=request,
        )
        latest = thread.comments.filter(deleted_at__isnull=True).order_by("-created_at", "-id").first()
        if latest is not None:
            notify_report_comment(
                report,
                thread,
                latest,
                request.user,
                action="resolved" if requested == "RESOLVED" else "reopened",
            )
        return Response(_serialize_thread(thread, request, context))


class ResearchReportCommentFeedbackEndpoint(ResearchAPIView):
    """``POST /api/research/workspaces/<slug>/reports/<report_id>/comments/<comment_id>/ai-feedback/``"""

    nav_capability = NAV_REPORTS

    def post(self, request, slug, report_id, comment_id):
        report, context, error = _load_visible_report(self, request, slug, report_id)
        if error:
            return error
        comment = (
            PeriodicReportComment.objects.select_related("thread", "thread__report", "actor")
            .filter(thread__report=report, pk=comment_id, deleted_at__isnull=True)
            .first()
        )
        if comment is None:
            return research_not_found(ResearchErrorCode.REPORT_COMMENT_NOT_FOUND, "Comment not found.")
        if comment.actor_id != request.user.id:
            return research_permission_denied()
        if hasattr(comment, "ai_feedback"):
            return Response(PeriodicReportCommentFeedbackSerializer(comment.ai_feedback).data)

        snapshot = report.official_snapshots.filter(version_no=comment.thread.snapshot_version).first()
        if snapshot is None:
            return research_error(
                ResearchErrorCode.REPORT_COMMENT_NO_SNAPSHOT,
                "The comment snapshot is no longer available.",
                status.HTTP_409_CONFLICT,
            )

        agent_session = None
        requested_session = request.data.get("agent_session_id")
        if requested_session:
            agent_session = (
                ResearchAgentSession.objects.select_related("context_grant")
                .filter(session_id=requested_session)
                .first()
            )
            if agent_session is None or not session_allows_report(agent_session, report, snapshot.version_no):
                return research_error(
                    ResearchErrorCode.REPORT_COMMENT_AGENT_SESSION_INVALID,
                    "Agent session is invalid or not authorized for this report version.",
                    status.HTTP_422_UNPROCESSABLE_ENTITY,
                )

        submitted_at = timezone.now()
        payload, payload_hash = build_feedback_payload(
            report=report,
            thread=comment.thread,
            comment=comment,
            snapshot=snapshot,
            submitted_by=request.user,
            submitted_at=submitted_at,
            agent_session=agent_session,
        )
        with transaction.atomic():
            feedback = PeriodicReportCommentFeedback.objects.create(
                comment=comment,
                report=report,
                thread=comment.thread,
                feedback_type=comment.feedback_type,
                payload=payload,
                payload_hash=payload_hash,
                submitted_by=request.user,
                submitted_at=submitted_at,
                agent_session=agent_session,
                created_by=request.user,
            )

        record_audit_event(
            workspace=report.workspace,
            action=ResearchAuditAction.REPORT_COMMENT_FEEDBACK_SUBMIT,
            resource_type=ResearchResourceType.REPORT_COMMENT_FEEDBACK,
            resource_id=feedback.pk,
            org_unit=report.org_unit,
            actor=request.user,
            metadata={
                "report": str(report.id),
                "thread": str(comment.thread.id),
                "comment": str(comment.id),
                "snapshot_version": snapshot.version_no,
                "feedback_type": comment.feedback_type,
                "agent_session": str(agent_session.session_id) if agent_session else None,
            },
            request=request,
        )
        return Response(PeriodicReportCommentFeedbackSerializer(feedback).data, status=status.HTTP_201_CREATED)
