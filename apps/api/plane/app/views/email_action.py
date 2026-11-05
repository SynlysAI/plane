"""Confirmation API for assignment-transfer email links."""

from django.conf import settings
from rest_framework import status
from rest_framework.response import Response

from plane.app.views.base import BaseAPIView
from plane.db.models import User
from plane.utils.assignment_transfer import (
    ISSUE_ENTITY,
    AssignmentTransferError,
    assignment_transfer_preview,
    execute_issue_assignment_transfer,
)


class AssignmentTransferEndpoint(BaseAPIView):
    """Preview and execute a signed assignment transfer for one email recipient."""

    def _payload(self, request):
        return request.query_params if request.method in {"GET", "HEAD", "OPTIONS"} else request.data

    def _candidate_id(self, request):
        data = self._payload(request)
        return data.get("candidate_id") or data.get("candidate")

    def get(self, request):
        return self._handle(request)

    def post(self, request):
        return self._handle(request)

    def _handle(self, request):
        if not getattr(settings, "NOTIFICATION_ASSIGNMENT_TRANSFER_EMAIL_ENABLED", True):
            return Response(
                {"error_code": "assignment_transfer_disabled", "message": "邮件转派功能未开启。"},
                status=status.HTTP_409_CONFLICT,
            )
        token = self._payload(request).get("token")
        candidate_id = self._candidate_id(request)
        if not token or not candidate_id:
            return Response(
                {"error_code": "assignment_transfer_invalid", "message": "转派链接无效。"},
                status=status.HTTP_400_BAD_REQUEST,
            )
        try:
            preview = assignment_transfer_preview(token, candidate_id, request.user)
            if request.method == "GET" or preview["status"] == "already_completed":
                return Response(preview)
            self._execute(request, preview, token)
            return Response(preview | {"status": "completed"})
        except AssignmentTransferError as exc:
            return Response({"error_code": exc.code, "message": exc.message}, status=exc.status)
        except Exception as exc:
            message = str(exc).lower()
            if "boundary" in message or "assignee" in message:
                return Response(
                    {"error_code": "assignment_candidate_invalid", "message": "候选负责人已失效。"},
                    status=status.HTTP_422_UNPROCESSABLE_ENTITY,
                )
            raise

    def _execute(self, request, preview, token):
        from plane.utils.assignment_transfer import load_assignment_transfer_token

        payload = load_assignment_transfer_token(token)
        candidate = User.objects.get(pk=preview["candidate"]["id"], is_active=True)
        if payload["entity_type"] == ISSUE_ENTITY:
            from plane.db.models import Issue

            issue = Issue.objects.select_related("project", "workspace").get(pk=payload["entity_id"])
            execute_issue_assignment_transfer(
                issue=issue, actor=request.user, candidate=candidate, request=request
            )
            return

        from plane.db.models import ResearchChainNodeTask
        from plane.research.services.chain_tasks import (
            ChainTaskPermissionError,
            ChainTaskStateError,
            ChainTaskValidationError,
            transfer_task_by_current_assignee,
        )

        task = ResearchChainNodeTask.objects.select_related("workspace", "chain", "node").get(
            pk=payload["entity_id"]
        )
        try:
            transfer_task_by_current_assignee(
                task=task, actor=request.user, assignee_id=candidate.id, request=request
            )
        except ChainTaskPermissionError as exc:
            raise AssignmentTransferError(
                "assignment_changed", "负责人或任务状态已变化，请到原生网页处理。", 409
            ) from exc
        except ChainTaskStateError as exc:
            raise AssignmentTransferError(
                "assignment_changed", "任务当前不可转派，请到原生网页处理。", 409
            ) from exc
        except ChainTaskValidationError as exc:
            raise AssignmentTransferError(
                "assignment_candidate_invalid", "候选负责人已失效，请在原生网页重新选择。", 422
            ) from exc
