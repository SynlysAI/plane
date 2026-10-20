"""Image and file upload endpoints for research task comments."""

import uuid

from django.http import HttpResponseRedirect
from django.utils import timezone
from rest_framework import status
from rest_framework.response import Response

from plane.db.models import FileAsset
from plane.research.utils.audit import ResearchAuditAction, record_audit_event
from plane.research.utils.capabilities import NAV_RESEARCH_CHAIN
from plane.research.utils.errors import research_not_found
from plane.research.utils.files import inspect_uploaded_asset, validate_attachment
from plane.research.utils.settings import get_workspace_research_settings
from plane.research.views.chain_foundation import _chain_readonly_error
from plane.research.views.chain_tasks import _task_context
from plane.research.views.base import ResearchAPIView
from plane.settings.storage import S3Storage
from plane.utils.comment_attachments import comment_attachment_limits, resolve_comment_attachment_limit
from plane.utils.path_validator import sanitize_filename

FILE_ASSET_TYPE = FileAsset.EntityTypeContext.RESEARCH_TASK_COMMENT_ATTACHMENT
IMAGE_ASSET_TYPE = FileAsset.EntityTypeContext.RESEARCH_TASK_COMMENT_IMAGE
IMAGE_TYPES = {"image/jpeg": {".jpg", ".jpeg"}, "image/png": {".png"}, "image/webp": {".webp"}, "image/gif": {".gif"}}


def _task_for_write(view, request, slug, chain_id, node_id, task_id):
    """Resolve a visible task and reject non-ACTIVE chains."""
    workspace, chain, node, task = _task_context(view, request, slug, chain_id, node_id, task_id)
    if workspace is None:
        return None, None, task
    error = _chain_readonly_error(chain)
    if error:
        return None, error, task
    return task, None, None


def _limits_payload(workspace):
    """Serialize the four workspace attachment quota categories."""
    return {
        category: {"max_mb": max_mb, "max_bytes": int(max_mb) * 1024 * 1024}
        for category, max_mb in comment_attachment_limits(workspace).items()
    }


class ResearchTaskCommentAttachmentLimitsEndpoint(ResearchAPIView):
    """Return comment attachment quotas for one visible task."""

    nav_capability = NAV_RESEARCH_CHAIN

    def get(self, request, slug, chain_id, node_id, task_id):
        workspace, _chain, _node, task = _task_context(self, request, slug, chain_id, node_id, task_id)
        if workspace is None:
            return task
        return Response(_limits_payload(workspace))


class ResearchTaskCommentAttachmentPresignEndpoint(ResearchAPIView):
    """Create a direct-to-storage upload slot for a task comment file."""

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
            limit = resolve_comment_attachment_limit(file_name, content_type, comment_attachment_limits(task.workspace))
        except (TypeError, ValueError):
            return Response({"error_code": "file_size_exceeded"}, status=status.HTTP_400_BAD_REQUEST)
        if size <= 0 or size > limit.max_bytes:
            record_audit_event(
                workspace=task.workspace,
                action=ResearchAuditAction.TASK_COMMENT_ATTACHMENT_DENIED,
                resource_type="research_chain_node_task",
                resource_id=task.pk,
                actor=request.user,
                metadata={"reason": "file_size_exceeded", "category": limit.category},
                request=request,
            )
            return Response(
                {
                    "error_code": "comment_attachment_size_exceeded",
                    "category": limit.category,
                    "limit_mb": limit.max_mb,
                    "limit_bytes": limit.max_bytes,
                },
                status=status.HTTP_400_BAD_REQUEST,
            )
        key = f"{task.workspace.id}/research/tasks/{task.id}/comment-attachments/{uuid.uuid4().hex}-{file_name}"
        upload = S3Storage(request=request).generate_presigned_post(
            object_name=key,
            file_type=content_type,
            file_size=size,
        )
        if not upload:
            return Response(
                {"error_code": "research_upload_storage_failed"},
                status=status.HTTP_503_SERVICE_UNAVAILABLE,
            )
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


class ResearchTaskCommentAttachmentSlotEndpoint(ResearchAPIView):
    """Confirm, discard, or download one task comment file slot."""

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
        if asset is None:
            return research_not_found("attachment_not_found", "Attachment not found.")
        if asset.created_by_id != request.user.id:
            return Response({"error_code": "research_permission_denied"}, status=status.HTTP_403_FORBIDDEN)
        storage = S3Storage(request=request)
        metadata = storage.get_object_metadata(object_name=asset.asset.name)
        if not metadata:
            return Response({"error_code": "attachment_not_found"}, status=status.HTTP_409_CONFLICT)
        try:
            actual_size = int(metadata.get("ContentLength") or 0)
        except (TypeError, ValueError):
            actual_size = 0
        file_name = str(asset.attributes.get("name") or asset.asset.name)
        content_type = str(metadata.get("ContentType") or asset.attributes.get("type") or "application/octet-stream")
        try:
            limit = resolve_comment_attachment_limit(file_name, content_type, comment_attachment_limits(task.workspace))
        except ValueError:
            return Response({"error_code": "file_size_exceeded"}, status=status.HTTP_400_BAD_REQUEST)
        if actual_size <= 0 or actual_size > limit.max_bytes:
            return Response(
                {"error_code": "comment_attachment_size_exceeded"},
                status=status.HTTP_422_UNPROCESSABLE_ENTITY,
            )
        asset.size = actual_size
        asset.storage_metadata = metadata
        asset.is_uploaded = True
        asset.attributes = {**asset.attributes, "type": content_type.split(";", 1)[0].lower(), "size": actual_size}
        asset.save(update_fields=["size", "storage_metadata", "is_uploaded", "attributes", "updated_at"])
        return Response(
            {
                "asset_id": str(asset.id),
                "name": file_name,
                "type": asset.attributes["type"],
                "size": actual_size,
            },
            status=status.HTTP_200_OK,
        )

    def delete(self, request, slug, chain_id, node_id, task_id, asset_id):
        task, error, early = _task_for_write(self, request, slug, chain_id, node_id, task_id)
        if error or early:
            return error or early
        asset = self._asset(task, asset_id)
        if asset is None or asset.created_by_id != request.user.id:
            return research_not_found("attachment_not_found", "Attachment not found.")
        if asset.research_task_comment_attachments.filter(deleted_at__isnull=True).exists():
            return Response({"error_code": "attachment_in_use"}, status=status.HTTP_409_CONFLICT)
        asset.is_deleted = True
        asset.deleted_at = timezone.now()
        asset.save(update_fields=["is_deleted", "deleted_at", "updated_at"])
        return Response(status=status.HTTP_204_NO_CONTENT)


class ResearchTaskCommentAttachmentDownloadEndpoint(ResearchAPIView):
    """Issue an authenticated download redirect for a saved comment file."""

    nav_capability = NAV_RESEARCH_CHAIN

    def get(self, request, slug, chain_id, node_id, task_id, asset_id):
        workspace, _chain, _node, task = _task_context(self, request, slug, chain_id, node_id, task_id)
        if workspace is None:
            return task
        asset = FileAsset.objects.filter(
            pk=asset_id,
            workspace=workspace,
            entity_type=FILE_ASSET_TYPE,
            entity_identifier=str(task.id),
            is_uploaded=True,
            is_deleted=False,
            deleted_at__isnull=True,
        ).first()
        if (
            asset is None
            or not asset.research_task_comment_attachments.filter(deleted_at__isnull=True, comment__task=task).exists()
        ):
            return research_not_found("attachment_not_found", "Attachment not found.")
        url = S3Storage(request=request).generate_presigned_url(
            object_name=asset.asset.name,
            disposition="attachment",
            filename=str(asset.attributes.get("name") or asset.asset.name),
        )
        return HttpResponseRedirect(url)


class ResearchTaskCommentImageEndpoint(ResearchAPIView):
    """Presign, validate, read, and remove task comment inline images."""

    nav_capability = NAV_RESEARCH_CHAIN

    def _asset(self, task, asset_id, *, uploaded=None, include_deleted=False):
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

    def post(self, request, slug, chain_id, node_id, task_id, asset_id=None):
        task, error, early = _task_for_write(self, request, slug, chain_id, node_id, task_id)
        if error or early:
            return error or early
        limits = get_workspace_research_settings(task.workspace)
        if asset_id:
            asset = self._asset(task, asset_id, include_deleted=bool(request.data.get("restore")))
            if asset is None or asset.created_by_id != request.user.id:
                return Response({"error_code": "attachment_not_found"}, status=status.HTTP_404_NOT_FOUND)
            if request.data.get("restore") and asset.is_uploaded:
                if not asset.is_deleted:
                    return Response({"asset_id": str(asset.id)}, status=status.HTTP_200_OK)
                asset.is_deleted = False
                asset.deleted_at = None
                asset.save(update_fields=["is_deleted", "deleted_at", "updated_at"])
                return Response({"asset_id": str(asset.id)}, status=status.HTTP_200_OK)
            storage = S3Storage(request=request)
            try:
                error_code, metadata = inspect_uploaded_asset(storage, asset, limits)
            except Exception:
                return Response({"error_code": "attachment_not_found"}, status=status.HTTP_409_CONFLICT)
            if error_code or metadata.get("ContentType") not in IMAGE_TYPES:
                return Response({"error_code": error_code or "file_type_not_allowed"}, status=422)
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
            return Response({"error_code": error_code or "file_type_not_allowed"}, status=422)
        key = f"{task.workspace.id}/research/tasks/{task.id}/comment-images/{uuid.uuid4().hex}-{file_name}"
        upload = S3Storage(request=request).generate_presigned_post(
            object_name=key,
            file_type=content_type,
            file_size=size,
        )
        if not upload:
            return Response(
                {"error_code": "research_upload_storage_failed"},
                status=status.HTTP_503_SERVICE_UNAVAILABLE,
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
        workspace, _chain, _node, task = _task_context(self, request, slug, chain_id, node_id, task_id)
        if workspace is None:
            return task
        asset = self._asset(task, asset_id, uploaded=True)
        if asset is None:
            return Response({"error_code": "attachment_not_found"}, status=status.HTTP_404_NOT_FOUND)
        url = S3Storage(request=request).generate_presigned_url(object_name=asset.asset.name)
        return HttpResponseRedirect(url)

    def delete(self, request, slug, chain_id, node_id, task_id, asset_id):
        task, error, early = _task_for_write(self, request, slug, chain_id, node_id, task_id)
        if error or early:
            return error or early
        asset = self._asset(task, asset_id)
        if asset is None or asset.created_by_id != request.user.id:
            return Response({"error_code": "attachment_not_found"}, status=status.HTTP_404_NOT_FOUND)
        asset.is_deleted = True
        asset.save(update_fields=["is_deleted", "updated_at"])
        return Response(status=status.HTTP_204_NO_CONTENT)
