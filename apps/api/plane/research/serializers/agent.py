"""Serializers for the Phase 0 Agent plugin BFF."""

from rest_framework import serializers

from plane.db.models import ResearchAgentRunEvent, ResearchAgentSession


class ResearchAgentSessionSerializer(serializers.ModelSerializer):
    """Return session scope and state without exposing the context token."""

    schema_version = serializers.SerializerMethodField()
    context_id = serializers.SerializerMethodField()
    context_hash = serializers.SerializerMethodField()
    context_expires_at = serializers.SerializerMethodField()
    project_name = serializers.SerializerMethodField()
    chain_node_title = serializers.SerializerMethodField()

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

    def get_project_name(self, obj):
        """Return the human-readable topic name for fixed UI context."""
        return obj.project.name

    def get_chain_node_title(self, obj):
        """Return the current node title for fixed UI context."""
        return obj.chain_node.title


class ResearchAgentRunEventSerializer(serializers.ModelSerializer):
    """Serialize one stable run event."""

    schema_version = serializers.SerializerMethodField()

    class Meta:
        model = ResearchAgentRunEvent
        fields = ["schema_version", "run_id", "seq", "event_type", "payload", "request_id", "created_at"]
        read_only_fields = fields

    def get_schema_version(self, _obj):
        return "agent-plugin.v1"
