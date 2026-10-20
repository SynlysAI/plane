# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

from django.shortcuts import get_object_or_404
from rest_framework.response import Response

from plane.app.permissions import ROLE, allow_permission
from plane.app.views.base import BaseAPIView
from plane.db.models import Project
from plane.utils.comment_attachments import comment_attachment_limits


class ProjectCommentAttachmentLimitsEndpoint(BaseAPIView):
    """返回项目所属工作区的评论附件分类额度。

    该接口只要求项目访问权限，不要求科研组织成员或科研平台管理权限，
    也不会暴露除四类额度以外的科研设置。
    """

    @allow_permission([ROLE.ADMIN, ROLE.MEMBER, ROLE.GUEST])
    def get(self, request, slug, project_id):
        """读取当前项目的四类评论附件额度。

        Args:
            request: 当前请求。
            slug: 项目所属工作区标识。
            project_id: 项目 ID。

        Returns:
            图片、PDF、Markdown、办公及其他附件的 MB 与字节限额。
        """
        project = get_object_or_404(
            Project,
            pk=project_id,
            workspace__slug=slug,
            archived_at__isnull=True,
        )
        limits = comment_attachment_limits(project.workspace)
        return Response(
            {
                category: {
                    "max_mb": max_mb,
                    "max_bytes": int(max_mb) * 1024 * 1024,
                }
                for category, max_mb in limits.items()
            }
        )
