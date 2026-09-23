"""Research Chain foundation models and append-only evidence records."""

import uuid

from django.db import models

from plane.db.models.base import BaseModel

from .append_only import AppendOnlyModel


class ResearchChain(BaseModel):
    """A versioned research process attached one-to-one to a Plane project."""

    class Status(models.TextChoices):
        ACTIVE = "ACTIVE", "Active"
        ARCHIVED = "ARCHIVED", "Archived"
        COMPLETED = "COMPLETED", "Completed"

    project = models.OneToOneField("db.Project", on_delete=models.PROTECT, related_name="research_chain")
    workspace = models.ForeignKey("db.Workspace", on_delete=models.CASCADE, related_name="research_chains")
    owner = models.ForeignKey("db.User", on_delete=models.PROTECT, related_name="owned_research_chains")
    status = models.CharField(max_length=16, choices=Status.choices, default=Status.ACTIVE)
    visibility = models.CharField(max_length=16, choices=(
        ("PRIVATE", "Private"), ("MEMBERS", "Members"), ("ORG", "Organisation"), ("WORKSPACE", "Workspace")
    ), default="PRIVATE")
    request_id = models.CharField(max_length=128, unique=True)
    payload_hash = models.CharField(max_length=64)

    class Meta:
        db_table = "research_chains"
        indexes = [models.Index(fields=["workspace", "status"], name="rsch_chain_ws_status_idx")]


class ResearchChainNode(BaseModel):
    """Mutable node projection; evidence is stored in append-only children."""

    class Status(models.TextChoices):
        DRAFT = "DRAFT", "Draft"
        ACTIVE = "ACTIVE", "Active"
        WAITING_HUMAN = "WAITING_HUMAN", "Waiting human"
        NEEDS_REVISION = "NEEDS_REVISION", "Needs revision"
        COMPLETED = "COMPLETED", "Completed"
        FAILED = "FAILED", "Failed"
        ARCHIVED = "ARCHIVED", "Archived"

    chain = models.ForeignKey(ResearchChain, on_delete=models.PROTECT, related_name="nodes")
    node_type = models.CharField(max_length=64)
    title = models.CharField(max_length=500)
    parent_node = models.ForeignKey("self", on_delete=models.PROTECT, null=True, blank=True, related_name="children")
    loop_iteration = models.PositiveIntegerField(default=0)
    status = models.CharField(max_length=20, choices=Status.choices, default=Status.DRAFT)
    assignee = models.ForeignKey("db.User", on_delete=models.SET_NULL, null=True, blank=True, related_name="research_chain_nodes")
    request_id = models.CharField(max_length=128, unique=True)
    payload_hash = models.CharField(max_length=64)

    class Meta:
        db_table = "research_chain_nodes"
        constraints = [models.UniqueConstraint(fields=["chain", "parent_node", "loop_iteration"], name="rsch_node_uq_loop")]
        indexes = [models.Index(fields=["chain", "status"], name="rsch_node_chain_status_idx")]


class ResearchChainEvent(AppendOnlyModel):
    """Immutable process fact with event and request idempotency keys."""

    chain = models.ForeignKey(ResearchChain, on_delete=models.PROTECT, related_name="events")
    node = models.ForeignKey(ResearchChainNode, on_delete=models.PROTECT, related_name="events")
    event_id = models.CharField(max_length=128, unique=True)
    request_id = models.CharField(max_length=128, unique=True)
    actor = models.ForeignKey("db.User", on_delete=models.SET_NULL, null=True, blank=True, related_name="research_chain_events")
    actor_type = models.CharField(max_length=32, default="USER")
    source_system = models.CharField(max_length=24, default="PLANE")
    event_type = models.CharField(max_length=64)
    occurred_at = models.DateTimeField()
    trace_id = models.CharField(max_length=128, blank=True, default="")
    refs = models.JSONField(default=list, blank=True)
    summary = models.TextField(blank=True, default="")
    content_hash = models.CharField(max_length=64, blank=True, default="")

    class Meta:
        db_table = "research_chain_events"
        indexes = [models.Index(fields=["chain", "occurred_at", "event_id"], name="rsch_event_chain_time_idx")]


class ResearchChainSnapshot(AppendOnlyModel):
    """Immutable point-in-time references for a node."""

    chain = models.ForeignKey(ResearchChain, on_delete=models.PROTECT, related_name="snapshots")
    node = models.ForeignKey(ResearchChainNode, on_delete=models.PROTECT, related_name="snapshots")
    snapshot_id = models.UUIDField(default=uuid.uuid4, unique=True, editable=False)
    version = models.PositiveIntegerField(default=1)
    source_versions = models.JSONField(default=list)
    resources = models.JSONField(default=list, blank=True)
    event_range = models.JSONField(default=dict, blank=True)
    summary = models.TextField(blank=True, default="")
    created_by = models.ForeignKey("db.User", on_delete=models.SET_NULL, null=True, blank=True, related_name="research_chain_snapshots")
    content_hash = models.CharField(max_length=64, blank=True, default="")
    immutable = models.BooleanField(default=True)
    request_id = models.CharField(max_length=128, unique=True)

    class Meta:
        db_table = "research_chain_snapshots"
        constraints = [models.UniqueConstraint(fields=["node", "version"], name="rsch_snapshot_uq_node_version")]


class ResearchReflectionLog(AppendOnlyModel):
    """Immutable reflection recorded after an iteration."""

    chain = models.ForeignKey(ResearchChain, on_delete=models.PROTECT, related_name="reflections")
    node = models.ForeignKey(ResearchChainNode, on_delete=models.PROTECT, related_name="reflections")
    summary = models.TextField()
    failure_reason = models.TextField(blank=True, default="")
    next_actions = models.JSONField(default=list, blank=True)
    created_by = models.ForeignKey("db.User", on_delete=models.SET_NULL, null=True, blank=True, related_name="research_reflections")

    class Meta:
        db_table = "research_reflection_logs"
