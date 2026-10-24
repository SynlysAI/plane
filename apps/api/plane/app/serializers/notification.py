# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

# Module imports
from .base import BaseSerializer
from .user import UserLiteSerializer
from plane.db.models import Notification, SystemAnnouncement, UserNotificationPreference

# Third Party imports
from rest_framework import serializers


class SystemAnnouncementSerializer(BaseSerializer):
    """Serialize published announcements for workspace administrators."""

    created_by_details = UserLiteSerializer(read_only=True, source="created_by")
    delivery_status = serializers.SerializerMethodField()

    class Meta:
        model = SystemAnnouncement
        fields = (
            "id",
            "workspace",
            "title",
            "body",
            "recipient_count",
            "published_at",
            "idempotency_key",
            "created_by",
            "created_by_details",
            "created_at",
            "updated_at",
            "delivery_status",
        )

    def get_delivery_status(self, obj):
        """Return the immutable delivery state supported by the initial release."""
        return "published" if obj.published_at else "pending"


class NotificationSerializer(BaseSerializer):
    triggered_by_details = UserLiteSerializer(read_only=True, source="triggered_by")
    announcement_details = SystemAnnouncementSerializer(read_only=True, source="announcement")
    is_inbox_issue = serializers.BooleanField(read_only=True)
    is_intake_issue = serializers.BooleanField(read_only=True)
    is_mentioned_notification = serializers.BooleanField(read_only=True)

    class Meta:
        model = Notification
        fields = "__all__"


class SystemAnnouncementCreateSerializer(serializers.Serializer):
    """Validate the plain-text payload used to publish an announcement."""

    title = serializers.CharField(max_length=255, trim_whitespace=True)
    body = serializers.CharField(trim_whitespace=True)
    idempotency_key = serializers.CharField(max_length=255, required=False, allow_blank=True, trim_whitespace=False)


class UserNotificationPreferenceSerializer(BaseSerializer):
    class Meta:
        model = UserNotificationPreference
        fields = "__all__"
