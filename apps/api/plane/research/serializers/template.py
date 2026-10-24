# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

from rest_framework import serializers

from plane.db.models import ReportTemplate


class ReportTemplateSerializer(serializers.ModelSerializer):
    class Meta:
        model = ReportTemplate
        fields = [
            "id",
            "scope",
            "report_type",
            "stage",
            "material_type",
            "name",
            "content_json",
            "variables",
            "sections_json",
            "target_key",
            "is_default",
            "is_active",
            "created_at",
            "updated_at",
        ]
        read_only_fields = ["id", "target_key", "created_at", "updated_at"]


class ReportTemplateOptionSerializer(serializers.ModelSerializer):
    """Minimal template fields exposed to report authors."""

    class Meta:
        model = ReportTemplate
        fields = ["id", "report_type", "name", "is_default", "is_active", "target_key"]


class ReportTemplateGuideSerializer(serializers.ModelSerializer):
    """Template fields needed while an author keeps filling a report."""

    class Meta:
        model = ReportTemplate
        fields = ["id", "name", "sections_json"]
        read_only_fields = fields
