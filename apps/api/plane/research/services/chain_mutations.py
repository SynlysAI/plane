"""Shared transactional append services for the web and Agent adapters."""

from django.db import transaction

from plane.db.models import ResearchAnalysisResult, ResearchChain, ResearchChainNode, ResearchChainNodeTask, ResearchTaskComment
from plane.research.serializers.task_comment import ResearchTaskCommentSerializer
from plane.research.services.chain_tasks import _ensure_task_parent_writable
from plane.research.services.idempotency import payload_hash
from plane.research.services.task_comment_attachments import (
    attachment_ids_for_comment,
    lock_task_comment_attachments,
    sync_task_comment_attachments,
)
from plane.research.services.mcp_catalog import ResearchReadError
from plane.research.utils.audit import record_audit_event
from plane.utils.html_processor import strip_tags


def lock_parent(node):
    chain = ResearchChain.objects.select_for_update().get(pk=node.chain_id)
    locked_node = ResearchChainNode.objects.select_for_update().get(pk=node.pk)
    _ensure_task_parent_writable(chain, locked_node)
    return chain, locked_node


@transaction.atomic
def append_task_comment(*, task, actor, request_id, html, attachment_ids=None, request=None):
    chain, node = lock_parent(task.node)
    locked = ResearchChainNodeTask.objects.select_for_update().filter(pk=task.pk, chain=chain, node=node).first()
    if locked is None:
        raise ResearchReadError("not_found", "Task not found.", 404)
    requested_attachments = list(attachment_ids or [])
    serializer = ResearchTaskCommentSerializer(
        data={"comment_html": html, "attachment_ids": requested_attachments},
        context={"task": task, "request": request},
    )
    if not serializer.is_valid():
        raise ResearchReadError("invalid_arguments", "A non-empty valid comment is required.")
    html = serializer.validated_data["comment_html"]
    previous = ResearchTaskComment.all_objects.filter(task=locked, actor=actor, request_id=request_id).first()
    if previous:
        previous_attachments = attachment_ids_for_comment(previous)
        if (
            previous.deleted_at
            or previous.comment_html != html
            or set(previous_attachments) != set(requested_attachments)
        ):
            raise ResearchReadError("idempotency_conflict", "This request_id was already used.", 409)
        return previous, False
    assets = lock_task_comment_attachments(requested_attachments, task=locked, user=actor)
    comment = ResearchTaskComment.objects.create(task=locked, actor=actor, request_id=request_id,
                                                comment_html=html, comment_stripped=strip_tags(html))
    sync_task_comment_attachments(comment, assets, task=locked, user=actor, request=request)
    record_audit_event(workspace=task.workspace, actor=actor, action="task.comment.create",
                       resource_type="research_chain_node_task", resource_id=task.pk,
                       metadata={"comment": str(comment.pk)}, request=request)
    return comment, True


@transaction.atomic
def save_analysis_draft(*, workspace, node, actor, payload, request_id, digest=None):
    chain, node = lock_parent(node)
    # Imported lazily to avoid the web view/service import cycle.
    from plane.research.views.chain_foundation import _node_operator

    if not _node_operator(workspace, actor, node):
        raise ResearchReadError("permission_denied", "Only node operators can submit analyses.", 403)
    digest = digest or payload_hash(payload)
    previous = ResearchAnalysisResult.all_objects.filter(request_id=request_id).first()
    if previous:
        if previous.deleted_at or previous.node_id != node.id or previous.operator_id != actor.id or previous.payload_hash != digest:
            raise ResearchReadError("idempotency_conflict", "Analysis request_id was already used.", 409)
        return previous, False
    result = ResearchAnalysisResult.objects.create(
        workspace=workspace, chain=chain, node=node, method=payload["method"], summary=payload["summary"],
        conclusion=str(payload.get("conclusion") or ""), input_refs=payload.get("input_refs") or [],
        metrics=payload.get("metrics") or {}, quality=payload.get("quality") or {},
        operator=actor, tool_version=str(payload.get("tool_version") or ""), status="DRAFT",
        request_id=request_id, payload_hash=digest, created_by=actor)
    return result, True
