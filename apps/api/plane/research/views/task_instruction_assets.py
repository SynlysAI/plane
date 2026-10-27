"""Image and file upload endpoints for research task descriptions."""

import uuid

from django.db import transaction
from django.http import HttpResponseRedirect
from django.utils import timezone
from rest_framework import status
from rest_framework.response import Response

from plane.db.models import FileAsset, ResearchChainNodeTask, ResearchChainNodeTaskAttachment
from plane.research.services.chain_tasks import actor_can_manage_chain_tasks
from plane.research.utils.audit import ResearchAuditAction, record_audit_event
from plane.research.utils.capabilities import NAV_RESEARCH_CHAIN
from plane.research.utils.errors import research_not_found
from plane.research.utils.files import inspect_uploaded_asset, validate_attachment
from plane.research.utils.settings import get_workspace_research_settings
from plane.research.views.chain_foundation import _chain_readonly_error
from plane.research.views.chain_tasks import _task_context
from plane.research.views.base import ResearchAPIView
from plane.settings.storage import S3Storage
from plane.utils.comment_attachments import (
    MAX_FILE_ATTACHMENTS,
    comment_attachment_limits,
    resolve_comment_attachment_limit,
)
from plane.utils.path_validator import sanitize_filename

FILE_ASSET_TYPE = FileAsset.EntityTypeContext.RESEARCH_TASK_INSTRUCTION_ATTACHMENT
IMAGE_ASSET_TYPE = FileAsset.EntityTypeContext.RESEARCH_TASK_INSTRUCTION_IMAGE
IMAGE_TYPES = {"image/jpeg": {".jpg", ".jpeg"}, "image/png": {".png"}, "image/webp": {".webp"}, "image/gif": {".gif"}}
EDITABLE_TASK_STATUSES = {
    "DRAFT",
    "ASSIGNED",
    "NEEDS_REVISION",
}


def _active_instruction_asset_count(task_id):
    """Return the number of active file slots owned by one task description."""
    return FileAsset.objects.filter(
        entity_type=FILE_ASSET_TYPE,
        entity_identifier=str(task_id),
        is_deleted=False,
        deleted_at__isnull=True,
    ).count()


def _task_attachment_limit_response():
    """Build the shared response for exceeding a task-description attachment count."""
    return Response(
        {"error_code": "attachment_count_exceeded", "limit": MAX_FILE_ATTACHMENTS},
        status=status.HTTP_400_BAD_REQUEST,
    )


def _task_for_write(view, request, slug, chain_id, node_id, task_id):
    """Resolve an editable task owned by a chain writer.

    Returns:
        A ``(task, error, early_response)`` tuple; exactly one mutable value is set.
    """
    workspace, chain, _node, task_or_error = _task_context(view, request, slug, chain_id, node_id, task_id)
    if workspace is None:
        return None, None, task_or_error
    task = task_or_error
    readonly_error = _chain_readonly_error(chain)
    if readonly_error:
        return None, readonly_error, None
    if task.status not in EDITABLE_TASK_STATUSES:
        return (
            None,
            Response({"error_code": "research_task_read_only"}, status=status.HTTP_409_CONFLICT),
            None,
        )
    if not actor_can_manage_chain_tasks(workspace, chain, request.user):
        return None, Response({"error_code": "research_permission_denied"}, status=status.HTTP_403_FORBIDDEN), None
    return task, None, None


def _deny_upload(task, request, reason, **metadata):
    """Record and return one task-description upload rejection."""
    record_audit_event(
        workspace=task.workspace,
        action=ResearchAuditAction.TASK_INSTRUCTION_ATTACHMENT_DENIED,
        resource_type="research_chain_node_task",
        resource_id=task.pk,
        actor=request.user,
        metadata={"reason": reason, **metadata},
        request=request,
    )


def _limits_error(task, request, file_name, content_type, size):
    """Validate a description file before creating a storage slot."""
    try:
        limit = resolve_comment_attachment_limit(
            file_name,
            content_type,
            comment_attachment_limits(task.workspace),
        )
    except (TypeError, ValueError):
        return Response({"error_code": "file_size_exceeded"}, status=status.HTTP_400_BAD_REQUEST), None
    if size <= 0 or size > limit.max_bytes:
        _deny_upload(task, request, "file_size_exceeded", category=limit.category)
        return (
            Response(
                {
                    "error_code": "comment_attachment_size_exceeded",
                    "category": limit.category,
                    "limit_mb": limit.max_mb,
                    "limit_bytes": limit.max_bytes,
                },
                status=status.HTTP_400_BAD_REQUEST,
            ),
            None,
        )
    return None, limit


def _image_asset(task, asset_id, *, uploaded=None, include_deleted=False):
    """Return one task-scoped description image asset."""
    query = {
        "pk": asset_id,
        "workspace": task.workspace,
        "entity_type": IMAGE_ASSET_TYPE,
        "entity_identifier": str(task.id),
        "deleted_at__isnull": True,
    }
    if not include_deleted:
        query["is_deleted"] = False
    if uploaded is not None:
        query["is_uploaded"] = uploaded
    return FileAsset.objects.filter(**query).first()


class ResearchTaskInstructionAttachmentPresignEndpoint(ResearchAPIView):
    """Create a direct-to-storage upload slot for a task-description file."""

    nav_capability = NAV_RESEARCH_CHAIN

    def post(self, request, slug, chain_id, node_id, task_id):
        task, error, early = _task_for_write(self, request, slug, chain_id, node_id, task_id)
        if error or early:
            return error or early
        file_name = sanitize_filename(str(request.data.get("file_name") or "")) or "attachment"
        content_type = str(request.data.get("content_type") or "application/octet-stream").split(";", 1)[0]
        content_type = content_type.strip().lower() or "application/octet-stream"
        try:
            size = int(request.data.get("size") or 0)
        except (TypeError, ValueError):
            size = 0
        error_response, _limit = _limits_error(task, request, file_name, content_type, size)
        if error_response:
            return error_response
        validation_error = validate_attachment(
            file_name=file_name,
            content_type=content_type,
            size_bytes=size,
            limits=get_workspace_research_settings(task.workspace),
        )
        if validation_error:
            _deny_upload(task, request, validation_error)
            return Response({"error_code": validation_error}, status=status.HTTP_422_UNPROCESSABLE_ENTITY)

        if _active_instruction_asset_count(task.id) >= MAX_FILE_ATTACHMENTS:
            _deny_upload(task, request, "attachment_count_exceeded", limit=MAX_FILE_ATTACHMENTS)
            return _task_attachment_limit_response()

        key = f"{task.workspace.id}/research/tasks/{task.id}/instruction-attachments/{uuid.uuid4().hex}-{file_name}"
        upload = S3Storage(request=request).generate_presigned_post(
            object_name=key,
            file_type=content_type,
            file_size=size,
        )
        if not upload:
            return Response(
                {"error_code": "research_upload_storage_failed"}, status=status.HTTP_503_SERVICE_UNAVAILABLE
            )
        with transaction.atomic():
            ResearchChainNodeTask.objects.select_for_update().get(pk=task.pk)
            if _active_instruction_asset_count(task.id) >= MAX_FILE_ATTACHMENTS:
                _deny_upload(task, request, "attachment_count_exceeded", limit=MAX_FILE_ATTACHMENTS)
                return _task_attachment_limit_response()
            asset = FileAsset.objects.create(
                workspace=task.workspace,
                user=request.user,
                created_by=request.user,
                attributes={"name": file_name, "type": content_type, "size": size},
                size=size,
                asset=key,
                entity_type=FILE_ASSET_TYPE,
                entity_identifier=str(task.id),
            )
        return Response({"asset_id": str(asset.id), "upload_data": upload})


class ResearchTaskInstructionAttachmentSlotEndpoint(ResearchAPIView):
    """Confirm or delete one task-description file slot."""

    nav_capability = NAV_RESEARCH_CHAIN

    def _asset(self, task, asset_id):
        return FileAsset.objects.filter(
            pk=asset_id,
            workspace=task.workspace,
            entity_type=FILE_ASSET_TYPE,
            entity_identifier=str(task.id),
            is_deleted=False,
            deleted_at__isnull=True,
        ).first()

    def post(self, request, slug, chain_id, node_id, task_id, asset_id):
        task, error, early = _task_for_write(self, request, slug, chain_id, node_id, task_id)
        if error or early:
            return error or early
        asset = self._asset(task, asset_id)
        if asset is None or asset.created_by_id != request.user.id:
            return research_not_found("attachment_not_found", "Attachment not found.")
        metadata = S3Storage(request=request).get_object_metadata(object_name=asset.asset.name)
        if not metadata:
            return Response({"error_code": "attachment_not_found"}, status=status.HTTP_409_CONFLICT)
        error_code, metadata = inspect_uploaded_asset(
            S3Storage(request=request), asset, get_workspace_research_settings(task.workspace)
        )
        if error_code:
            _deny_upload(task, request, error_code)
            return Response({"error_code": error_code}, status=status.HTTP_422_UNPROCESSABLE_ENTITY)

        actual_size = int(metadata.get("ContentLength") or 0)
        file_name = str(asset.attributes.get("name") or asset.asset.name)
        content_type = str(metadata.get("ContentType") or asset.attributes.get("type") or "")
        with transaction.atomic():
            ResearchChainNodeTask.objects.select_for_update().get(pk=task.pk)
            if _active_instruction_asset_count(task.id) > MAX_FILE_ATTACHMENTS:
                _deny_upload(task, request, "attachment_count_exceeded", limit=MAX_FILE_ATTACHMENTS)
                return _task_attachment_limit_response()
            asset.size = actual_size
            asset.storage_metadata = metadata
            asset.is_uploaded = True
            asset.attributes = {
                **asset.attributes,
                "type": content_type.split(";", 1)[0].lower(),
                "size": actual_size,
            }
            asset.save(update_fields=["size", "storage_metadata", "is_uploaded", "attributes", "updated_at"])
            attachment = ResearchChainNodeTaskAttachment.objects.create(
                task=task,
                asset=asset,
                file_name=file_name,
                file_size=actual_size,
                content_type=asset.attributes["type"],
                uploaded_by=request.user,
                created_by=request.user,
                updated_by=request.user,
            )
            record_audit_event(
                workspace=task.workspace,
                action=ResearchAuditAction.TASK_INSTRUCTION_ATTACHMENT_ADD,
                resource_type="research_chain_node_task",
                resource_id=task.pk,
                actor=request.user,
                metadata={"attachment": str(attachment.id), "asset": str(asset.id)},
                request=request,
            )
        return Response(
            {"asset_id": str(asset.id), "name": file_name, "type": asset.attributes["type"], "size": actual_size},
            status=status.HTTP_201_CREATED,
        )

    def delete(self, request, slug, chain_id, node_id, task_id, asset_id):
        task, error, early = _task_for_write(self, request, slug, chain_id, node_id, task_id)
        if error or early:
            return error or early
        asset = self._asset(task, asset_id)
        if asset is None or asset.created_by_id != request.user.id:
            return research_not_found("attachment_not_found", "Attachment not found.")
        now = timezone.now()
        with transaction.atomic():
            attachment = (
                ResearchChainNodeTaskAttachment.objects.select_for_update()
                .filter(task=task, asset=asset, deleted_at__isnull=True)
                .first()
            )
            if attachment:
                attachment.deleted_at = now
                attachment.updated_by = request.user
                attachment.save(update_fields=["deleted_at", "updated_by", "updated_at"])
            asset.is_deleted = True
            asset.deleted_at = now
            asset.updated_by = request.user
            asset.save(update_fields=["is_deleted", "deleted_at", "updated_by", "updated_at"])
            record_audit_event(
                workspace=task.workspace,
                action=ResearchAuditAction.TASK_INSTRUCTION_ATTACHMENT_DELETE,
                resource_type="research_chain_node_task",
                resource_id=task.pk,
                actor=request.user,
                metadata={"asset": str(asset.id)},
                request=request,
            )
        return Response(status=status.HTTP_204_NO_CONTENT)


class ResearchTaskInstructionAttachmentDownloadEndpoint(ResearchAPIView):
    """Issue an authenticated download redirect for a task-description file."""

    nav_capability = NAV_RESEARCH_CHAIN

    def get(self, request, slug, chain_id, node_id, task_id, asset_id):
        workspace, _chain, _node, early = _task_context(self, request, slug, chain_id, node_id, task_id)
        if workspace is None:
            return early
        attachment = (
            ResearchChainNodeTaskAttachment.objects.select_related("asset", "task")
            .filter(
                task_id=task_id,
                asset_id=asset_id,
                deleted_at__isnull=True,
                asset__is_uploaded=True,
                asset__is_deleted=False,
                asset__deleted_at__isnull=True,
            )
            .first()
        )
        if attachment is None:
            return research_not_found("attachment_not_found", "Attachment not found.")
        url = S3Storage(request=request).generate_presigned_url(
            object_name=attachment.asset.asset.name,
            disposition="attachment",
            filename=attachment.file_name,
        )
        return HttpResponseRedirect(url)


class ResearchTaskInstructionImageEndpoint(ResearchAPIView):
    """Presign, validate, read, restore, and remove task-description images."""

    nav_capability = NAV_RESEARCH_CHAIN

    def post(self, request, slug, chain_id, node_id, task_id, asset_id=None):
        task, error, early = _task_for_write(self, request, slug, chain_id, node_id, task_id)
        if error or early:
            return error or early
        limits = get_workspace_research_settings(task.workspace)
        if asset_id:
            asset = _image_asset(task, asset_id, include_deleted=bool(request.data.get("restore")))
            if asset is None or asset.created_by_id != request.user.id:
                return Response({"error_code": "attachment_not_found"}, status=status.HTTP_404_NOT_FOUND)
            if request.data.get("restore") and asset.is_uploaded:
                if not asset.is_deleted:
                    return Response({"asset_id": str(asset.id)}, status=status.HTTP_200_OK)
                asset.is_deleted = False
                asset.deleted_at = None
                asset.save(update_fields=["is_deleted", "deleted_at", "updated_at"])
                return Response({"asset_id": str(asset.id)}, status=status.HTTP_200_OK)
            try:
                error_code, metadata = inspect_uploaded_asset(S3Storage(request=request), asset, limits)
            except Exception:
                return Response({"error_code": "attachment_not_found"}, status=status.HTTP_409_CONFLICT)
            if error_code or metadata.get("ContentType") not in IMAGE_TYPES:
                denial = error_code or "file_type_not_allowed"
                _deny_upload(task, request, denial)
                return Response({"error_code": denial}, status=status.HTTP_422_UNPROCESSABLE_ENTITY)
            asset.size = int(metadata["ContentLength"])
            asset.storage_metadata = metadata
            asset.is_uploaded = True
            asset.save(update_fields=["size", "storage_metadata", "is_uploaded", "updated_at"])
            return Response({"asset_id": str(asset.id)}, status=status.HTTP_201_CREATED)

        file_name = sanitize_filename(str(request.data.get("file_name") or ""))
        content_type = str(request.data.get("content_type") or "").split(";", 1)[0].strip().lower()
        try:
            size = int(request.data.get("size") or 0)
        except (TypeError, ValueError):
            size = 0
        error_code = validate_attachment(
            file_name=file_name,
            content_type=content_type,
            size_bytes=size,
            limits=limits,
        )
        extension = f".{file_name.rsplit('.', 1)[-1].lower()}" if "." in file_name else ""
        if error_code or extension not in IMAGE_TYPES.get(content_type, set()):
            denial = error_code or "file_type_not_allowed"
            _deny_upload(task, request, denial)
            return Response({"error_code": denial}, status=status.HTTP_422_UNPROCESSABLE_ENTITY)
        key = f"{task.workspace.id}/research/tasks/{task.id}/instruction-images/{uuid.uuid4().hex}-{file_name}"
        upload = S3Storage(request=request).generate_presigned_post(
            object_name=key,
            file_type=content_type,
            file_size=size,
        )
        if not upload:
            return Response(
                {"error_code": "research_upload_storage_failed"}, status=status.HTTP_503_SERVICE_UNAVAILABLE
            )
        asset = FileAsset.objects.create(
            workspace=task.workspace,
            user=request.user,
            created_by=request.user,
            attributes={"name": file_name, "type": content_type, "size": size},
            size=size,
            asset=key,
            entity_type=IMAGE_ASSET_TYPE,
            entity_identifier=str(task.id),
        )
        return Response({"asset_id": str(asset.id), "upload_data": upload})

    def get(self, request, slug, chain_id, node_id, task_id, asset_id):
        workspace, _chain, _node, early = _task_context(self, request, slug, chain_id, node_id, task_id)
        if workspace is None:
            return early
        task = early
        asset = _image_asset(task, asset_id, uploaded=True)
        if asset is None:
            return Response({"error_code": "attachment_not_found"}, status=status.HTTP_404_NOT_FOUND)
        return HttpResponseRedirect(S3Storage(request=request).generate_presigned_url(object_name=asset.asset.name))

    def delete(self, request, slug, chain_id, node_id, task_id, asset_id):
        task, error, early = _task_for_write(self, request, slug, chain_id, node_id, task_id)
        if error or early:
            return error or early
        asset = _image_asset(task, asset_id)
        if asset is None or asset.created_by_id != request.user.id:
            return Response({"error_code": "attachment_not_found"}, status=status.HTTP_404_NOT_FOUND)
        with transaction.atomic():
            asset.is_deleted = True
            asset.save(update_fields=["is_deleted", "updated_at"])
            record_audit_event(
                workspace=task.workspace,
                action=ResearchAuditAction.TASK_INSTRUCTION_ATTACHMENT_DELETE,
                resource_type="research_chain_node_task",
                resource_id=task.pk,
                actor=request.user,
                metadata={"asset": str(asset.id), "kind": "image"},
                request=request,
            )
        return Response(status=status.HTTP_204_NO_CONTENT)
