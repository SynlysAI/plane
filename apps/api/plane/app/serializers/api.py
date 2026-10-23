# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

from .base import BaseSerializer
from plane.db.models import APIToken, APIActivityLog
from rest_framework import serializers
from django.utils import timezone


class APITokenSerializer(BaseSerializer):
    class Meta:
        model = APIToken
        fields = "__all__"
        read_only_fields = [
            "token",
            "expired_at",
            "created_at",
            "updated_at",
            "workspace",
            "user",
            "is_active",
            "last_used",
            "user_type",
            "allowed_rate_limit",
        ]


class APITokenCreateSerializer(serializers.Serializer):
    """Validate user-supplied API token metadata before creating a credential."""

    label = serializers.CharField(max_length=255, required=False, allow_blank=False, trim_whitespace=True)
    description = serializers.CharField(required=False, allow_blank=True, allow_null=True, trim_whitespace=False)
    expired_at = serializers.DateTimeField(required=False, allow_null=True)


class APITokenReadSerializer(BaseSerializer):
    is_active = serializers.SerializerMethodField()
    masked_token = serializers.SerializerMethodField()

    class Meta:
        model = APIToken
        exclude = ("token",)

    def get_is_active(self, obj: APIToken) -> bool:
        return obj.is_active and (obj.expired_at is None or timezone.now() < obj.expired_at)

    def get_masked_token(self, obj: APIToken) -> str:
        # Reveal only an identifying fragment, never a usable credential.
        if len(obj.token) <= 22:
            return "********"
        return f"{obj.token[:14]}********{obj.token[-4:]}"


class APIActivityLogSerializer(BaseSerializer):
    class Meta:
        model = APIActivityLog
        fields = "__all__"
