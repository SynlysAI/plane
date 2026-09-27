# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Project topic materials stored as FileAsset rows, separate from report cards."""

import uuid

from rest_framework import status
from rest_framework.response import Response

from plane.db.models import FileAsset, WorkspaceResearchSetting
from plane.research.utils.errors import ResearchErrorCode, research_error, research_not_found, research_permission_denied
from plane.research.utils.projects import can_create_research_content
from plane.research.views.base import ResearchAPIView
from plane.research.views.projects import can_read_project_research_metadata, profile_queryset
from plane.settings.storage import S3Storage
from plane.utils.path_validator import sanitize_filename

SECTION = "stages"
TOPIC_MATERIAL = "RESEARCH_TOPIC_MATERIAL"
ALLOWED_EXTENSIONS = (".pdf", ".md", ".markdown")


def _allowed_name(file_name: str) -> bool:
    """只接受 PDF 和 Markdown 文件名。"""
    return file_name.lower().endswith(ALLOWED_EXTENSIONS)


def _readable_profile(request, workspace, project_id):
    """返回当前用户可读的课题，找不到时给出 404。"""
    profile = profile_queryset(workspace).filter(project_id=project_id).select_related("project").first()
    if profile is None or not can_read_project_research_metadata(workspace, request.user, profile):
        return None, research_not_found(ResearchErrorCode.PROJECT_NOT_FOUND, "Research project not found.")
    return profile, None


def _size_limit_bytes(workspace, file_name: str) -> int:
    """按平台配置返回该文件类型的字节上限，未配置时不限制。"""
    setting = WorkspaceResearchSetting.objects.filter(workspace=workspace, deleted_at__isnull=True).first()
    if setting is None:
        return 0
    limit_mb = setting.pdf_max_mb if file_name.lower().endswith(".pdf") else setting.markdown_max_mb
    return int(limit_mb or 0) * 1024 * 1024


def _serialize(asset, project) -> dict:
    """把课题资料整理成列表项，并带上所属课题。"""
    return {
        "id": str(asset.id),
        "file_name": str((asset.attributes or {}).get("name") or ""),
        "content_type": str((asset.attributes or {}).get("type") or ""),
        "size": asset.size,
        "project": str(project.id),
        "project_name": project.name,
    }


class ResearchTopicMaterialListCreateEndpoint(ResearchAPIView):
    """列出或确认一个课题的 PDF/Markdown 资料。"""

    def get(self, request, slug, project_id):
        workspace, error = self.get_workspace(section=SECTION)
        if error:
            return error
        profile, error = _readable_profile(request, workspace, project_id)
        if error:
            return error
        assets = FileAsset.objects.filter(
            workspace=workspace,
            project_id=project_id,
            entity_type=TOPIC_MATERIAL,
            entity_identifier=str(project_id),
            is_uploaded=True,
            is_deleted=False,
        ).order_by("-created_at")
        return Response(
            {"results": [_serialize(asset, profile.project) for asset in assets], "count": assets.count()},
            status=status.HTTP_200_OK,
        )

    def post(self, request, slug, project_id):
        workspace, error = self.get_workspace(section=SECTION)
        if error:
            return error
        profile, error = _readable_profile(request, workspace, project_id)
        if error:
            return error
        if not can_create_research_content(request.user, workspace, profile):
            return research_permission_denied()
        asset = FileAsset.objects.filter(
            pk=request.data.get("asset_id"),
            workspace=workspace,
            project_id=project_id,
            entity_type=TOPIC_MATERIAL,
            entity_identifier=str(project_id),
            is_deleted=False,
        ).first()
        if asset is None:
            return research_not_found(ResearchErrorCode.ATTACHMENT_NOT_FOUND, "The uploaded topic material was not found.")
        file_name = str((asset.attributes or {}).get("name") or "")
        if not _allowed_name(file_name):
            return research_error(
                ResearchErrorCode.FILE_TYPE_NOT_ALLOWED,
                "Only PDF and Markdown topic materials are allowed.",
                status.HTTP_422_UNPROCESSABLE_ENTITY,
            )
        if not asset.is_uploaded:
            try:
                metadata = S3Storage(request=request).get_object_metadata(object_name=asset.asset.name)
            except Exception:
                metadata = None
            if not metadata:
                return research_error(
                    ResearchErrorCode.ATTACHMENT_NOT_FOUND,
                    "The upload did not complete. Please retry the upload.",
                    status.HTTP_409_CONFLICT,
                )
            asset.is_uploaded = True
            asset.save(update_fields=["is_uploaded", "updated_at"])
        return Response(_serialize(asset, profile.project), status=status.HTTP_201_CREATED)


class ResearchTopicMaterialPresignEndpoint(ResearchAPIView):
    """为课题资料创建直传槽位，不创建成果行。"""

    def post(self, request, slug, project_id):
        workspace, error = self.get_workspace(section=SECTION)
        if error:
            return error
        profile, error = _readable_profile(request, workspace, project_id)
        if error:
            return error
        if not can_create_research_content(request.user, workspace, profile):
            return research_permission_denied()
        file_name = sanitize_filename(str(request.data.get("file_name") or ""))
        content_type = str(request.data.get("content_type") or "application/octet-stream")
        try:
            size = int(request.data.get("size") or 0)
        except (TypeError, ValueError):
            size = 0
        if not file_name or not _allowed_name(file_name):
            return research_error(
                ResearchErrorCode.FILE_TYPE_NOT_ALLOWED,
                "Only PDF and Markdown topic materials are allowed.",
                status.HTTP_422_UNPROCESSABLE_ENTITY,
            )
        limit = _size_limit_bytes(workspace, file_name)
        if limit and size > limit:
            return research_error(
                ResearchErrorCode.FILE_TYPE_NOT_ALLOWED,
                "The file is larger than the configured limit.",
                status.HTTP_422_UNPROCESSABLE_ENTITY,
            )
        key = f"{workspace.id}/research/topic-materials/{project_id}/{uuid.uuid4().hex}-{file_name}"
        presigned = S3Storage(request=request).generate_presigned_post(
            object_name=key, file_type=content_type, file_size=size
        )
        if presigned is None:
            return research_error(
                ResearchErrorCode.UPSTREAM_DEGRADED,
                "Unable to prepare the upload.",
                status.HTTP_503_SERVICE_UNAVAILABLE,
            )
        asset = FileAsset.objects.create(
            attributes={"name": file_name, "type": content_type, "size": size},
            asset=key,
            size=size,
            workspace=workspace,
            project_id=project_id,
            user=request.user,
            created_by=request.user,
            entity_type=TOPIC_MATERIAL,
            entity_identifier=str(project_id),
            is_uploaded=False,
        )
        return Response({"asset_id": str(asset.id), "upload_data": presigned}, status=status.HTTP_200_OK)
