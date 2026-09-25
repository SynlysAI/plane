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
from plane.research.utils.action_capabilities import capability_map
from plane.research.utils.acl import ResearchResource, build_actor_context, check_access


CHAIN_ACTIONS = (
    "view",
    "edit",
    "review",
    "accept",
    "return",
    "export",
    "upload",
    "agent_review",
    "archive",
    "restore",
)
NODE_ACTIONS = ("view", "edit", "transition", "upload", "agent_review")


def _request_actor(serializer):
    """Return the authenticated actor supplied by DRF serializer context."""
    request = serializer.context.get("request")
    actor = getattr(request, "user", None)
    return actor if getattr(actor, "is_authenticated", False) else None


def _chain_resource(obj):
    """Project a Chain into the shared ACL resource shape."""
    profile = getattr(obj.project, "research_profile", None)
    visibility = {"MEMBERS": "UNIT", "ORG": "ANCESTRY"}.get(obj.visibility, obj.visibility)
    return ResearchResource(
        kind="research_chain",
        workspace_id=obj.workspace_id,
        owner_id=obj.owner_id,
        org_unit_id=getattr(profile, "org_unit_id", None),
        visibility=visibility,
        state=obj.status,
        project_id=obj.project_id,
        is_team_content=obj.visibility != "PRIVATE",
    )


def _node_resource(obj):
    """Project a node into the shared ACL resource shape."""
    resource = _chain_resource(obj.chain)
    resource.kind = "research_chain_node"
    resource.owner_id = obj.chain.owner_id
    resource.state = obj.status
    return resource


def _capabilities(serializer, obj, *, is_node=False):
    """Resolve capabilities without exposing content outside the ACL."""
    actor = _request_actor(serializer)
    if actor is None:
        return capability_map(NODE_ACTIONS if is_node else CHAIN_ACTIONS, {})
    chain = obj.chain if is_node else obj
    context = build_actor_context(actor, chain.workspace_id)
    resource = _node_resource(obj) if is_node else _chain_resource(obj)
    decisions = {action: check_access(actor, action, resource, context=context) for action in ("view", "edit", "review", "accept", "return", "export")}
    if is_node:
        from plane.research.views.chain_foundation import _chain_writer, _chain_manager, _node_operator

        decisions.update(
            transition=_node_operator(chain.workspace, actor, obj),
            upload=_chain_writer(chain.workspace, actor, chain),
            agent_review=decisions["view"] and (decisions["review"] or actor.id == chain.owner_id),
        )
        return capability_map(NODE_ACTIONS, decisions)
    from plane.research.views.chain_foundation import _chain_manager, _chain_writer

    decisions.update(
        upload=_chain_writer(chain.workspace, actor, chain),
        archive=_chain_manager(chain.workspace, actor, chain),
        restore=_chain_manager(chain.workspace, actor, chain),
        agent_review=decisions["view"] and (decisions["review"] or actor.id == chain.owner_id),
    )
    return capability_map(CHAIN_ACTIONS, decisions)


class ResearchChainSerializer(serializers.ModelSerializer):
    """Expose chain metadata without leaking project internals."""

    schema_version = serializers.SerializerMethodField()
    project_name = serializers.SerializerMethodField()
    owner_name = serializers.SerializerMethodField()
    capabilities = serializers.SerializerMethodField()
    project_identifier = serializers.SerializerMethodField()
    org_unit_name = serializers.SerializerMethodField()

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
            "project_identifier",
            "org_unit_name",
            "status",
            "visibility",
            "capabilities",
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

    def get_project_identifier(self, obj):
        """Return the stable Plane project identifier for navigation."""
        return obj.project.identifier

    def get_org_unit_name(self, obj):
        """Return the owning organisation label when it is available."""
        profile = getattr(obj.project, "research_profile", None)
        unit = getattr(profile, "org_unit", None)
        return unit.name if unit else None

    def get_capabilities(self, obj):
        """Return explicit action decisions for the current actor."""
        return _capabilities(self, obj)


class ResearchChainNodeSerializer(serializers.ModelSerializer):
    """Expose node metadata and parent relationship."""

    schema_version = serializers.SerializerMethodField()
    capabilities = serializers.SerializerMethodField()

    class Meta:
        model = ResearchChainNode
        fields = ["schema_version", "id", "chain", "node_type", "title", "parent_node", "loop_iteration", "status", "assignee", "capabilities", "created_at", "updated_at"]

    def get_schema_version(self, _obj):
        return "research-node.v1"

    def get_capabilities(self, obj):
        """Return explicit node action decisions for the current actor."""
        return _capabilities(self, obj, is_node=True)


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
