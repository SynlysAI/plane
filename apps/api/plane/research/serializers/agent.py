"""Serializers for the Phase 0 Agent plugin BFF."""

from rest_framework import serializers

from plane.db.models import ResearchAgentRunEvent, ResearchAgentSession


class ResearchAgentSessionSerializer(serializers.ModelSerializer):
    """Return session scope and state without exposing the context token."""

    schema_version = serializers.SerializerMethodField()
    context_id = serializers.SerializerMethodField()
    context_hash = serializers.SerializerMethodField()

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
            "status",
            "last_error",
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


class ResearchAgentRunEventSerializer(serializers.ModelSerializer):
    """Serialize one stable run event."""

    schema_version = serializers.SerializerMethodField()

    class Meta:
        model = ResearchAgentRunEvent
        fields = ["schema_version", "run_id", "seq", "event_type", "payload", "request_id", "created_at"]
        read_only_fields = fields

    def get_schema_version(self, _obj):
        return "agent-plugin.v1"
