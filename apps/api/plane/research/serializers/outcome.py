# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

from rest_framework import serializers

from plane.db.models import ResearchOutcome, ResearchOutcomeLink


class ResearchOutcomeLinkSerializer(serializers.ModelSerializer):
    class Meta:
        model = ResearchOutcomeLink
        fields = ["id", "outcome", "target_type", "target_id", "created_at"]
        read_only_fields = ["id", "outcome", "created_at"]


class ResearchOutcomeSerializer(serializers.ModelSerializer):
    links = ResearchOutcomeLinkSerializer(many=True, read_only=True)
    attachments = serializers.SerializerMethodField()

    class Meta:
        model = ResearchOutcome
        fields = [
            "id",
            "workspace",
            "project",
            "output_type",
            "title",
            "authors",
            "venue",
            "doi",
            "external_url",
            "file_asset",
            "status",
            "published_at",
            "visibility",
            "links",
            "attachments",
            "created_at",
            "updated_at",
        ]
        read_only_fields = ["id", "workspace", "project", "created_at", "updated_at"]

    def get_attachments(self, obj):
        """Return attachment metadata and scoped download links."""
        request = self.context.get("request")
        slug = getattr(request, "parser_context", {}).get("kwargs", {}).get("slug", "") if request else ""
        return [
            {
                "id": str(item.id),
                "file_name": item.file_name,
                "content_type": item.content_type,
                "file_size": item.file_size,
                "download_url": f"/api/research/workspaces/{slug}/outcomes/{obj.id}/attachments/{item.id}/",
            }
            for item in obj.attachments.filter(deleted_at__isnull=True)
        ]
