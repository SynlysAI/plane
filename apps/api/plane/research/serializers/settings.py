# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

from rest_framework import serializers

from plane.db.models import WorkspaceResearchSetting


class WorkspaceResearchSettingSerializer(serializers.ModelSerializer):
    main_pi_name = serializers.SerializerMethodField()
    # Deprecated switches are read-only compatibility values.
    research_ia_v2 = serializers.SerializerMethodField()
    research_chain_enabled = serializers.SerializerMethodField()
    org_enabled = serializers.SerializerMethodField()
    report_enabled = serializers.SerializerMethodField()
    approval_enabled = serializers.SerializerMethodField()

    def get_research_ia_v2(self, obj):
        return True

    get_research_chain_enabled = get_research_ia_v2
    get_org_enabled = get_research_ia_v2
    get_report_enabled = get_research_ia_v2
    get_approval_enabled = get_research_ia_v2

    class Meta:
        model = WorkspaceResearchSetting
        fields = [
            "id",
            "workspace",
            "purpose",
            "main_pi",
            "main_pi_name",
            "required_reporter_categories",
            "module_enabled",
            "org_enabled",
            "report_enabled",
            "approval_enabled",
            "research_chain_enabled",
            "research_agent_enabled",
            "research_agent_user_backend_enabled",
            "research_trace_enabled",
            "research_account_link_enabled",
            "research_external_rag_enabled",
            "research_ia_v2",
            "allow_multiple_projects",
            "default_report_visibility",
            "weekly_default_visibility",
            "monthly_default_visibility",
            "image_max_mb",
            "pdf_max_mb",
            "markdown_max_mb",
            "office_max_mb",
            "timezone",
            "audit_retention_days",
            "created_at",
            "updated_at",
        ]
        read_only_fields = ["id", "workspace", "purpose", "main_pi_name", "created_at", "updated_at"]

    def get_main_pi_name(self, obj):
        """返回已任命主 PI 的显示名，不把账号 ID 当作名字。"""
        user = getattr(obj, "main_pi", None)
        if user is None:
            return None
        name = str(getattr(user, "display_name", "") or "").strip()
        return name or None
