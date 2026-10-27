"""Transactional ownership and synchronization for task comment attachments."""

from django.utils import timezone
from rest_framework.exceptions import ValidationError

from plane.db.models import FileAsset, ResearchTaskCommentAttachment
from plane.research.utils.audit import ResearchAuditAction, record_audit_event
from plane.utils.comment_attachments import MAX_FILE_ATTACHMENTS


def attachment_ids_for_comment(comment):
    """Return the active asset IDs attached to a comment in stable order."""
    return list(
        comment.attachments.filter(deleted_at__isnull=True).order_by("asset_id").values_list("asset_id", flat=True)
    )


def lock_task_comment_attachments(attachment_ids, *, task, user, comment=None):
    """Lock and validate the complete attachment list for one save.

    Args:
        attachment_ids: Asset IDs submitted by the client.
        task: Research task that owns the upload slots.
        user: Current actor.
        comment: Existing comment when editing; ``None`` when creating.

    Returns:
        Locked assets in stable ID order.
    """
    ids = list(attachment_ids)
    if len(ids) > MAX_FILE_ATTACHMENTS or len(set(ids)) != len(ids):
        raise ValidationError({"attachment_ids": f"每条评论最多附加 {MAX_FILE_ATTACHMENTS} 个不同文件。"})
    if not ids:
        return []
    existing_ids = set(attachment_ids_for_comment(comment)) if comment else set()
    assets = list(
        FileAsset.objects.select_for_update()
        .filter(
            id__in=ids,
            workspace_id=task.workspace_id,
            entity_type=FileAsset.EntityTypeContext.RESEARCH_TASK_COMMENT_ATTACHMENT,
            entity_identifier=str(task.id),
            created_by=user,
            is_uploaded=True,
            is_deleted=False,
            deleted_at__isnull=True,
        )
        .order_by("id")
    )
    allowed_assets = []
    for asset in assets:
        already_attached = asset.research_task_comment_attachments.filter(deleted_at__isnull=True).exists()
        if asset.id in existing_ids or not already_attached:
            allowed_assets.append(asset)
    if len(allowed_assets) != len(ids):
        raise ValidationError({"attachment_ids": "附件未上传完成、已失效或不属于当前评论。"})
    return allowed_assets


def sync_task_comment_attachments(comment, assets, *, task, user, request=None):
    """Atomically replace the active attachment set for one comment.

    Args:
        comment: Saved task comment.
        assets: Complete locked asset list for this save.
        task: Research task used for audit scope.
        user: Current actor.
        request: Current request used by the audit writer.
    """
    now = timezone.now()
    target_ids = {asset.id for asset in assets}
    current = list(comment.attachments.filter(deleted_at__isnull=True).select_related("asset"))
    removed = [row for row in current if row.asset_id not in target_ids]
    added = [asset for asset in assets if asset.id not in {row.asset_id for row in current}]

    for row in removed:
        row.deleted_at = now
        row.updated_by = user
        row.save(update_fields=["deleted_at", "updated_by", "updated_at"])
        row.asset.is_deleted = True
        row.asset.deleted_at = now
        row.asset.updated_by = user
        row.asset.save(update_fields=["is_deleted", "deleted_at", "updated_by", "updated_at"])

    for asset in added:
        ResearchTaskCommentAttachment.objects.create(
            comment=comment,
            asset=asset,
            file_name=str(asset.attributes.get("name") or asset.asset.name),
            file_size=int(asset.size or 0),
            content_type=str(asset.attributes.get("type") or ""),
            uploaded_by=user,
            created_by=user,
        )

    if added:
        record_audit_event(
            workspace=task.workspace,
            action=ResearchAuditAction.TASK_COMMENT_ATTACHMENT_ADD,
            resource_type="research_chain_node_task",
            resource_id=task.pk,
            actor=user,
            metadata={"comment": str(comment.pk), "assets": [str(asset.pk) for asset in added]},
            request=request,
        )
    if removed:
        record_audit_event(
            workspace=task.workspace,
            action=ResearchAuditAction.TASK_COMMENT_ATTACHMENT_DELETE,
            resource_type="research_chain_node_task",
            resource_id=task.pk,
            actor=user,
            metadata={"comment": str(comment.pk), "assets": [str(row.asset_id) for row in removed]},
            request=request,
        )


def soft_delete_task_comment_attachments(comment, *, task, user, request=None):
    """Soft-delete all active files owned by a comment being deleted."""
    now = timezone.now()
    rows = list(comment.attachments.filter(deleted_at__isnull=True).select_related("asset"))
    for row in rows:
        row.deleted_at = now
        row.updated_by = user
        row.save(update_fields=["deleted_at", "updated_by", "updated_at"])
        row.asset.is_deleted = True
        row.asset.deleted_at = now
        row.asset.updated_by = user
        row.asset.save(update_fields=["is_deleted", "deleted_at", "updated_by", "updated_at"])
    if rows:
        record_audit_event(
            workspace=task.workspace,
            action=ResearchAuditAction.TASK_COMMENT_ATTACHMENT_DELETE,
            resource_type="research_chain_node_task",
            resource_id=task.pk,
            actor=user,
            metadata={"comment": str(comment.pk), "assets": [str(row.asset_id) for row in rows]},
            request=request,
        )
