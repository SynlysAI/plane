"""Serializers for the Phase 0 Agent plugin BFF."""

from rest_framework import serializers

from plane.db.models import ResearchAgentRunEvent, ResearchAgentSession


class ResearchAgentSessionSerializer(serializers.ModelSerializer):
    """Return session scope and state without exposing the context token."""

    schema_version = serializers.SerializerMethodField()
    context_id = serializers.SerializerMethodField()
    context_hash = serializers.SerializerMethodField()
    context_expires_at = serializers.SerializerMethodField()
    scope_kind = serializers.SerializerMethodField()
    scope_source = serializers.SerializerMethodField()
    policy_version = serializers.SerializerMethodField()
    project_name = serializers.SerializerMethodField()
    chain_node_title = serializers.SerializerMethodField()
    report_sources = serializers.SerializerMethodField()

    class Meta:
        model = ResearchAgentSession
        fields = [
            "schema_version",
            "session_id",
            "run_id",
            "workspace",
            "user",
            "project",
            "chain_node",
            "context_id",
            "context_hash",
            "context_expires_at",
            "project_name",
            "chain_node_title",
            "report_sources",
            "status",
            "last_error",
            "synlora_session_id",
            "synlora_run_id",
            "delegated_subject",
            "assembly",
            "scope_kind",
            "scope_source",
            "policy_version",
            "created_at",
            "updated_at",
        ]
        read_only_fields = fields

    def get_schema_version(self, _obj):
        return "agent-plugin.v1"

    def get_context_id(self, obj):
        return str(obj.context_grant.context_id)

    def get_context_hash(self, obj):
        return obj.context_grant.context_hash

    def get_context_expires_at(self, obj):
        """Return the public Context expiry without exposing its token."""
        return obj.context_grant.expires_at

    def get_scope_kind(self, obj):
        """Return the explicit owner/review scope stored on the Context grant."""
        return obj.context_grant.scope_kind

    def get_scope_source(self, obj):
        """Return the authorization source that produced the Context grant."""
        return obj.context_grant.scope_source

    def get_policy_version(self, obj):
        """Return the read-only tool policy version."""
        return obj.context_grant.policy_version

    def get_project_name(self, obj):
        """Return the human-readable topic name for fixed UI context."""
        return obj.project.name

    def get_chain_node_title(self, obj):
        """Return the current node title for fixed UI context."""
        return obj.chain_node.title

    def get_report_sources(self, obj):
        """显示正式报告 ID 与固定版本，不在会话元数据中返回正文。"""
        return obj.context_grant.allowed_reports


class ResearchAgentRunEventSerializer(serializers.ModelSerializer):
    """Serialize one stable run event."""

    schema_version = serializers.SerializerMethodField()

    class Meta:
        model = ResearchAgentRunEvent
        fields = ["schema_version", "run_id", "seq", "event_type", "payload", "request_id", "created_at"]
        read_only_fields = fields

    def get_schema_version(self, _obj):
        return "agent-plugin.v1"
