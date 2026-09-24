"""Serializers for the Research Chain foundation API."""

from rest_framework import serializers

from plane.db.models import (
    ResearchAnalysisResult,
    ResearchChain,
    ResearchChainEvent,
    ResearchChainNode,
    ResearchChainSnapshot,
    ResearchChainUpload,
)


class ResearchChainSerializer(serializers.ModelSerializer):
    """Expose chain metadata without leaking project internals."""

    schema_version = serializers.SerializerMethodField()
    project_name = serializers.SerializerMethodField()
    owner_name = serializers.SerializerMethodField()

    class Meta:
        model = ResearchChain
        fields = [
            "schema_version",
            "id",
            "project",
            "project_name",
            "workspace",
            "owner",
            "owner_name",
            "status",
            "visibility",
            "created_at",
            "updated_at",
        ]

    def get_schema_version(self, _obj):
        return "research-chain.v1"

    def get_project_name(self, obj):
        """Return the topic title for fixed Chain UI context."""
        return obj.project.name

    def get_owner_name(self, obj):
        """Return the owner display name without exposing a raw user ID."""
        return obj.owner.display_name or obj.owner.email


class ResearchChainNodeSerializer(serializers.ModelSerializer):
    """Expose node metadata and parent relationship."""

    schema_version = serializers.SerializerMethodField()

    class Meta:
        model = ResearchChainNode
        fields = ["schema_version", "id", "chain", "node_type", "title", "parent_node", "loop_iteration", "status", "assignee", "created_at", "updated_at"]

    def get_schema_version(self, _obj):
        return "research-node.v1"


class ResearchChainEventSerializer(serializers.ModelSerializer):
    """Serialize immutable chain events."""

    schema_version = serializers.SerializerMethodField()

    class Meta:
        model = ResearchChainEvent
        fields = ["schema_version", "event_id", "node", "actor", "actor_type", "source_system", "request_id", "trace_id", "event_type", "occurred_at", "refs", "summary", "content_hash"]

    def get_schema_version(self, _obj):
        return "research-event.v1"


class ResearchChainSnapshotSerializer(serializers.ModelSerializer):
    """Serialize immutable node snapshots."""

    schema_version = serializers.SerializerMethodField()

    class Meta:
        model = ResearchChainSnapshot
        fields = [
            "schema_version",
            "snapshot_id",
            "snapshot_type",
            "node",
            "version",
            "source_versions",
            "resources",
            "event_range",
            "summary",
            "created_by",
            "content_hash",
            "immutable",
            "created_at",
        ]

    def get_schema_version(self, _obj):
        return "research-snapshot.v1"


class ResearchChainUploadSerializer(serializers.ModelSerializer):
    """Serialize scoped upload metadata without echoing file content."""

    schema_version = serializers.SerializerMethodField()

    class Meta:
        model = ResearchChainUpload
        fields = [
            "schema_version",
            "id",
            "chain",
            "node",
            "reference",
            "request_id",
            "external_upload_id",
            "knowledge_id",
            "knowledge_base_id",
            "task_id",
            "file_name",
            "file_type",
            "file_size",
            "file_hash",
            "status",
            "error_code",
            "metadata",
            "created_at",
            "updated_at",
        ]
        read_only_fields = fields

    def get_schema_version(self, _obj):
        return "research-chain-upload.v1"


class ResearchAnalysisResultSerializer(serializers.ModelSerializer):
    """Serialize an analysis result without source business bodies."""

    schema_version = serializers.SerializerMethodField()

    class Meta:
        model = ResearchAnalysisResult
        fields = [
            "schema_version",
            "id",
            "chain",
            "node",
            "method",
            "input_refs",
            "summary",
            "metrics",
            "quality",
            "conclusion",
            "operator",
            "tool_version",
            "status",
            "created_at",
            "updated_at",
        ]
        read_only_fields = fields

    def get_schema_version(self, _obj):
        return "research-analysis.v1"
