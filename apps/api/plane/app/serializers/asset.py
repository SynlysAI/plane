# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

from rest_framework import serializers

from .base import BaseSerializer
from plane.db.models import FileAsset


class FileAssetSerializer(BaseSerializer):
    def validate_entity_type(self, value):
        """Reject feedback screenshots outside the dedicated feedback endpoint."""
        if value == FileAsset.EntityTypeContext.FEEDBACK_SCREENSHOT:
            raise serializers.ValidationError("Feedback screenshots must use the feedback endpoint.")
        return value

    class Meta:
        model = FileAsset
        fields = "__all__"
        read_only_fields = ["created_by", "updated_by", "created_at", "updated_at"]
