"""Serializers for the Research Chain foundation API."""

from rest_framework import serializers

from plane.db.models import ResearchChain, ResearchChainEvent, ResearchChainNode, ResearchChainSnapshot


class ResearchChainSerializer(serializers.ModelSerializer):
    """Expose chain metadata without leaking project internals."""

    schema_version = serializers.SerializerMethodField()

    class Meta:
        model = ResearchChain
        fields = ["schema_version", "id", "project", "workspace", "owner", "status", "visibility", "created_at", "updated_at"]

    def get_schema_version(self, _obj):
        return "research-chain.v1"


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
