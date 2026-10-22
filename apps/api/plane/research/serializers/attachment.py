# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

from rest_framework import serializers

from plane.db.models import ReportAttachment


from plane.preview.access import report_preview_url


class ReportAttachmentSerializer(serializers.ModelSerializer):
    asset_url = serializers.SerializerMethodField()
    preview_url = serializers.SerializerMethodField()

    class Meta:
        model = ReportAttachment
        fields = [
            "id",
            "report",
            "asset",
            "asset_url",
            "preview_url",
            "kind",
            "file_name",
            "file_size",
            "content_type",
            "uploaded_by",
            "official_version_no",
            "created_at",
        ]
        read_only_fields = fields

    def get_asset_url(self, obj):
        return (
            f"/api/research/workspaces/{obj.report.workspace.slug}/"
            f"reports/{obj.report_id}/attachments/{obj.id}/download/"
        )

    def get_preview_url(self, obj):
        """返回绑定报告附件登记的预览入口。"""
        return report_preview_url(obj)
