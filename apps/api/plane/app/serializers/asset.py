# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

from rest_framework import serializers

from .base import BaseSerializer
from plane.db.models import FileAsset


class FileAssetSerializer(BaseSerializer):
    def validate_entity_type(self, value):
        """要求反馈截图和评论附件使用各自的上传入口。

        Args:
            value: 请求指定的资产类型。

        Returns:
            可在通用接口使用的资产类型。
        """
        if value in (
            FileAsset.EntityTypeContext.FEEDBACK_SCREENSHOT,
            FileAsset.EntityTypeContext.COMMENT_ATTACHMENT,
        ):
            raise serializers.ValidationError("This asset type requires its dedicated upload endpoint.")
        return value

    class Meta:
        model = FileAsset
        fields = "__all__"
        read_only_fields = ["created_by", "updated_by", "created_at", "updated_at"]
