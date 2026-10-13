"""Discussion scoped to the same workspace, chain, node and task ACL as its parent."""

from django.db import transaction
from django.utils import timezone
from rest_framework import status
from rest_framework.response import Response

from plane.db.models import ResearchChainNodeTask, ResearchTaskComment
from plane.research.serializers.task_comment import ResearchTaskCommentSerializer
from plane.research.services.idempotency import request_id_from
from plane.research.utils.audit import record_audit_event, ResearchResourceType
from plane.research.utils.capabilities import NAV_RESEARCH_CHAIN
from plane.research.utils.errors import research_error, research_not_found, research_permission_denied
from plane.research.views.base import ResearchAPIView
from plane.research.views.chain_foundation import _chain_readonly_error
from plane.research.views.chain_tasks import _task_context
from plane.utils.html_processor import strip_tags


def serialize(comment, request):
    return ResearchTaskCommentSerializer(comment, context={"request": request}).data


def comment_audit(task, comment, request, action):
    record_audit_event(
        workspace=task.workspace,
        action=f"task.comment.{action}",
        resource_type=ResearchResourceType.RESEARCH_CHAIN_NODE_TASK,
        resource_id=task.pk,
        actor=request.user,
        metadata={"comment": str(comment.pk)},
        request=request,
    )


class ResearchTaskCommentListEndpoint(ResearchAPIView):
    nav_capability = NAV_RESEARCH_CHAIN

    def get(self, request, slug, chain_id, node_id, task_id):
        workspace, chain, node, task = _task_context(self, request, slug, chain_id, node_id, task_id)
        if workspace is None:
            return task
        comments = task.comments.select_related("actor", "task__chain").order_by("created_at", "id")
        return Response(
            {"results": [serialize(comment, request) for comment in comments], "can_comment": chain.status == "ACTIVE"}
        )

    def post(self, request, slug, chain_id, node_id, task_id):
        workspace, chain, node, task = _task_context(self, request, slug, chain_id, node_id, task_id)
        if workspace is None:
            return task
        error = _chain_readonly_error(chain)
        if error:
            return error
        request_id = request_id_from(request)
        if not request_id or len(request_id) > 128:
            return research_error("research_comment_invalid", "A request_id of at most 128 characters is required.")
        serializer = ResearchTaskCommentSerializer(data={"comment_html": request.data.get("comment_html")})
        if not serializer.is_valid():
            return research_error("research_comment_invalid", "A non-empty, valid comment is required.")
        html = serializer.validated_data["comment_html"]
        with transaction.atomic():
            ResearchChainNodeTask.objects.select_for_update().get(pk=task.pk)
            previous = ResearchTaskComment.all_objects.filter(
                task=task, actor=request.user, request_id=request_id
            ).first()
            if previous:
                if previous.deleted_at or previous.comment_html != html:
                    return research_error(
                        "idempotency_conflict", "This request_id was already used.", status.HTTP_409_CONFLICT
                    )
                comment, created = previous, False
            else:
                comment = ResearchTaskComment.objects.create(
                    task=task,
                    actor=request.user,
                    request_id=request_id,
                    comment_html=html,
                    comment_stripped=strip_tags(html),
                )
                created = True
                comment_audit(task, comment, request, "create")
        return Response(serialize(comment, request), status=201 if created else 200)


class ResearchTaskCommentDetailEndpoint(ResearchAPIView):
    nav_capability = NAV_RESEARCH_CHAIN

    def _comment(self, request, slug, chain_id, node_id, task_id, comment_id):
        workspace, chain, node, task = _task_context(self, request, slug, chain_id, node_id, task_id)
        if workspace is None:
            return None, task
        error = _chain_readonly_error(chain)
        if error:
            return None, error
        comment = (
            ResearchTaskComment.objects.filter(task=task, pk=comment_id).select_related("actor", "task__chain").first()
        )
        if comment is None:
            return None, research_not_found("research_comment_not_found", "Comment not found.")
        if comment.actor_id != request.user.id:
            return None, research_permission_denied()
        return comment, None

    def patch(self, request, slug, chain_id, node_id, task_id, comment_id):
        comment, error = self._comment(request, slug, chain_id, node_id, task_id, comment_id)
        if error:
            return error
        serializer = ResearchTaskCommentSerializer(comment, data={"comment_html": request.data.get("comment_html")})
        if not serializer.is_valid():
            return research_error("research_comment_invalid", "A non-empty, valid comment is required.")
        with transaction.atomic():
            comment = (
                ResearchTaskComment.objects.select_for_update()
                .select_related("actor", "task__chain")
                .filter(pk=comment.pk)
                .first()
            )
            if comment is None:
                return research_not_found("research_comment_not_found", "Comment not found.")
            html = serializer.validated_data["comment_html"]
            comment.comment_html = html
            comment.comment_stripped = strip_tags(html)
            comment.edited_at = timezone.now()
            comment.save(update_fields=["comment_html", "comment_stripped", "edited_at", "updated_at"])
            comment_audit(comment.task, comment, request, "update")
        return Response(serialize(comment, request))

    def delete(self, request, slug, chain_id, node_id, task_id, comment_id):
        comment, error = self._comment(request, slug, chain_id, node_id, task_id, comment_id)
        if error:
            return error
        with transaction.atomic():
            comment = (
                ResearchTaskComment.objects.select_for_update()
                .select_related("actor", "task__chain")
                .filter(pk=comment.pk)
                .first()
            )
            if comment is None:
                return research_not_found("research_comment_not_found", "Comment not found.")
            comment.deleted_at = timezone.now()
            comment.save(update_fields=["deleted_at", "updated_at"])
            comment_audit(comment.task, comment, request, "delete")
        return Response(status=status.HTTP_204_NO_CONTENT)
