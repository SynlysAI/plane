"""Serializers for the Research Chain foundation API."""

from django.db.models import Case, Count, Min, Prefetch, Q, Value, When
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
    "delete",
    "restore",
)
NODE_ACTIONS = ("view", "edit", "transition", "upload", "agent_review", "delete")
OPEN_NODE_TASK_STATUSES = ("DRAFT", "ASSIGNED", "SUBMITTED", "NEEDS_REVISION")
TASK_COUNT_NODE_STATUSES = tuple(
    status for status in ResearchChainNode.Status.values if status != ResearchChainNode.Status.ARCHIVED
)


def current_node_order():
    """Return the database expression that mirrors frontend node priority."""
    return Case(
        When(status="WAITING_HUMAN", then=Value(0)),
        When(status="NEEDS_REVISION", then=Value(1)),
        When(status="FAILED", then=Value(2)),
        When(status="ACTIVE", then=Value(3)),
        When(status="DRAFT", then=Value(4)),
        When(status="COMPLETED", then=Value(5)),
        default=Value(6),
    )


def annotate_chain_summaries(queryset):
    """Annotate chain summaries without issuing one query per list row.

    Args:
        queryset: A ``ResearchChain`` queryset already constrained to visible rows.

    Returns:
        The queryset with open-task aggregates and a prefetched current node.
    """
    open_tasks = Q(
        node_tasks__status__in=OPEN_NODE_TASK_STATUSES,
        node_tasks__deleted_at__isnull=True,
        node_tasks__node__deleted_at__isnull=True,
        node_tasks__node__status__in=TASK_COUNT_NODE_STATUSES,
    )
    return queryset.annotate(
        open_task_count=Count("node_tasks", filter=open_tasks, distinct=True),
        next_due_at=Min("node_tasks__due_at", filter=open_tasks),
    ).prefetch_related(
        Prefetch(
            "nodes",
            queryset=ResearchChainNode.objects.filter(deleted_at__isnull=True).order_by(
                current_node_order(),
                "-updated_at",
                "id",
            ),
            to_attr="summary_nodes",
        )
    )


def _request_actor(serializer):
    """Return the authenticated actor supplied by DRF serializer context."""
    request = serializer.context.get("request")
    actor = getattr(request, "user", None)
    return actor if getattr(actor, "is_authenticated", False) else None


def _request_context(serializer, workspace_id):
    """Reuse a view supplied ACL context to avoid one query set per row."""
    context = serializer.context.get("actor_context")
    return context if context is not None and context.workspace_id == workspace_id else None


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
    context = _request_context(serializer, chain.workspace_id) or build_actor_context(actor, chain.workspace_id)
    resource = _node_resource(obj) if is_node else _chain_resource(obj)
    decisions = {
        action: check_access(actor, action, resource, context=context)
        for action in ("view", "edit", "review", "accept", "return", "export")
    }
    writable = chain.status == ResearchChain.Status.ACTIVE
    for action in ("edit", "review", "accept", "return"):
        decisions[action] = decisions[action] and writable
    if is_node:
        from plane.research.views.chain_foundation import _chain_writer, _chain_manager, _node_operator

        decisions.update(
            delete=writable and obj.status == "DRAFT" and _chain_manager(chain.workspace, actor, chain),
            transition=writable and _node_operator(chain.workspace, actor, obj),
            upload=writable and _chain_writer(chain.workspace, actor, chain),
            agent_review=writable and decisions["view"] and (decisions["review"] or actor.id == chain.owner_id),
        )
        return capability_map(NODE_ACTIONS, decisions)
    from plane.research.views.chain_foundation import _chain_manager, _chain_writer

    decisions.update(
        upload=writable and _chain_writer(chain.workspace, actor, chain),
        archive=_chain_manager(chain.workspace, actor, chain) and chain.status not in ("ARCHIVED", "DELETED"),
        delete=_chain_manager(chain.workspace, actor, chain) and chain.status != "DELETED",
        restore=_chain_manager(chain.workspace, actor, chain) and chain.status in ("ARCHIVED", "DELETED"),
        agent_review=writable and decisions["view"] and (decisions["review"] or actor.id == chain.owner_id),
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
    open_task_count = serializers.SerializerMethodField()
    next_due_at = serializers.SerializerMethodField()
    current_node = serializers.SerializerMethodField()

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
            "open_task_count",
            "next_due_at",
            "current_node",
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

    def get_open_task_count(self, obj):
        """Return the number of open tasks attached to the chain."""
        value = getattr(obj, "open_task_count", None)
        if value is None:
            value = obj.node_tasks.filter(
                status__in=OPEN_NODE_TASK_STATUSES,
                deleted_at__isnull=True,
                node__deleted_at__isnull=True,
                node__status__in=TASK_COUNT_NODE_STATUSES,
            ).count()
        return value

    def get_next_due_at(self, obj):
        """Return the earliest open-task due timestamp."""
        value = getattr(obj, "next_due_at", None)
        if value is None:
            value = (
                obj.node_tasks.filter(
                    status__in=OPEN_NODE_TASK_STATUSES,
                    deleted_at__isnull=True,
                    node__deleted_at__isnull=True,
                    node__status__in=TASK_COUNT_NODE_STATUSES,
                    due_at__isnull=False,
                )
                .order_by("due_at")
                .values_list("due_at", flat=True)
                .first()
            )
        return value.isoformat() if value is not None else None

    def get_current_node(self, obj):
        """Return the most attention-worthy node projected with the chain."""
        nodes = getattr(obj, "summary_nodes", None)
        if nodes is None:
            nodes = list(
                obj.nodes.filter(deleted_at__isnull=True).order_by(
                    current_node_order(),
                    "-updated_at",
                    "id",
                )
            )
        node = nodes[0] if nodes else None
        if node is None:
            return None
        return {
            "id": str(node.id),
            "title": node.title,
            "status": node.status,
            "node_type": node.node_type,
            "updated_at": node.updated_at.isoformat() if node.updated_at else None,
        }

    def get_capabilities(self, obj):
        """Return explicit action decisions for the current actor."""
        return _capabilities(self, obj)


class ResearchChainNodeSerializer(serializers.ModelSerializer):
    """Expose node metadata and parent relationship."""

    schema_version = serializers.SerializerMethodField()
    capabilities = serializers.SerializerMethodField()

    class Meta:
        model = ResearchChainNode
        fields = [
            "schema_version",
            "id",
            "chain",
            "node_type",
            "title",
            "parent_node",
            "loop_iteration",
            "status",
            "assignee",
            "capabilities",
            "created_at",
            "updated_at",
        ]

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
        fields = [
            "schema_version",
            "event_id",
            "node",
            "actor",
            "actor_type",
            "source_system",
            "request_id",
            "trace_id",
            "event_type",
            "occurred_at",
            "refs",
            "summary",
            "content_hash",
        ]

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
