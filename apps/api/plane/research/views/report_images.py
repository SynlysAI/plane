"""报告正文图片上传、读取与草稿移除接口。"""

import uuid

from django.http import HttpResponseRedirect
from rest_framework.response import Response

from plane.db.models import FileAsset
from plane.research.utils.files import inspect_uploaded_asset, validate_attachment
from plane.research.utils.report_images import can_read_report_image
from plane.research.utils.reports import is_editable
from plane.research.utils.settings import get_workspace_research_settings
from plane.research.views.reports import ResearchReportDetailEndpoint
from plane.settings.storage import S3Storage
from plane.utils.path_validator import sanitize_filename

IMAGE_TYPES = {"image/jpeg": {".jpg", ".jpeg"}, "image/png": {".png"}, "image/webp": {".webp"}, "image/gif": {".gif"}}


class ResearchReportImageEndpoint(ResearchReportDetailEndpoint):
    """复用报告权限，正文图片不登记为附件。"""

    nav_capability = None

    def post(self, request, slug, report_id, asset_id=None):
        """准备图片直传，或实际校验并登记已上传的图片。"""
        workspace, error = self.get_workspace(section="reports")
        if error:
            return error
        report, error = self._visible_report(request, workspace, report_id, action="edit")
        if error:
            return error
        if not is_editable(report):
            return Response({"error_code": "report_read_only"}, status=409)
        storage = S3Storage(request=request)
        limits = get_workspace_research_settings(workspace)
        if asset_id:
            asset = FileAsset.objects.filter(
                pk=asset_id,
                workspace=workspace,
                entity_identifier=str(report.id),
                entity_type=FileAsset.EntityTypeContext.REPORT_IMAGE,
                created_by=request.user,
            ).first()
            if asset is None:
                return Response({"error_code": "attachment_not_found"}, status=404)
            try:
                error, metadata = inspect_uploaded_asset(storage, asset, limits)
            except Exception:
                return Response(
                    {"error_code": "attachment_not_found", "message": "图片上传未完成，请重试。"}, status=409
                )
            if error or metadata.get("ContentType") not in IMAGE_TYPES:
                return Response({"error_code": error or "file_type_not_allowed"}, status=422)
            asset.size = metadata["ContentLength"]
            asset.storage_metadata = metadata
            asset.is_uploaded = True
            asset.is_deleted = False
            asset.save(update_fields=["size", "storage_metadata", "is_uploaded", "is_deleted", "updated_at"])
            return Response({"asset_id": str(asset.id)}, status=201)
        file_name = str(request.data.get("file_name") or "")
        content_type = str(request.data.get("content_type") or "")
        try:
            size = int(request.data.get("size") or 0)
        except (TypeError, ValueError):
            size = 0
        from plane.research.utils.files import extension_of

        error = validate_attachment(file_name=file_name, content_type=content_type, size_bytes=size, limits=limits)
        if error or extension_of(file_name) not in IMAGE_TYPES.get(content_type, set()):
            return Response({"error_code": error or "file_type_not_allowed"}, status=422)
        key = f"{workspace.id}/research/{report.id}/images/{uuid.uuid4().hex}-{sanitize_filename(file_name)}"
        upload = storage.generate_presigned_post(object_name=key, file_type=content_type, file_size=size)
        if not upload:
            return Response({"error_code": "upload_unavailable"}, status=503)
        asset = FileAsset.objects.create(
            workspace=workspace,
            user=request.user,
            created_by=request.user,
            attributes={"name": file_name, "type": content_type, "size": size},
            size=size,
            asset=key,
            entity_type=FileAsset.EntityTypeContext.REPORT_IMAGE,
            entity_identifier=str(report.id),
        )
        return Response({"asset_id": str(asset.id), "upload_data": upload})

    def get(self, request, slug, report_id, asset_id):
        """重新检查报告权限后签发图片读取地址。"""
        workspace, error = self.get_workspace(section="reports")
        if error:
            return error
        asset = FileAsset.objects.filter(
            pk=asset_id,
            workspace=workspace,
            entity_identifier=str(report_id),
            entity_type=FileAsset.EntityTypeContext.REPORT_IMAGE,
        ).first()
        if asset is None or not can_read_report_image(request.user, asset):
            return Response({"error_code": "attachment_not_found"}, status=404)
        url = S3Storage(request=request).generate_presigned_url(object_name=asset.asset.name)
        if not url:
            return Response({"error_code": "download_unavailable"}, status=503)
        return HttpResponseRedirect(url)

    def delete(self, request, slug, report_id, asset_id):
        """仅移除草稿资源标记，保留被正式快照引用的实际文件。"""
        workspace, error = self.get_workspace(section="reports")
        if error:
            return error
        report, error = self._visible_report(request, workspace, report_id, action="edit")
        if error:
            return error
        if not is_editable(report):
            return Response({"error_code": "report_read_only"}, status=409)
        asset = FileAsset.objects.filter(
            pk=asset_id,
            workspace=workspace,
            entity_identifier=str(report.id),
            entity_type=FileAsset.EntityTypeContext.REPORT_IMAGE,
        ).first()
        if asset is None:
            return Response({"error_code": "attachment_not_found"}, status=404)
        asset.is_deleted = True
        asset.save(update_fields=["is_deleted", "updated_at"])
        return Response(status=204)
