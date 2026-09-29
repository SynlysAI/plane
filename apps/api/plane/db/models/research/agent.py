"""Persistent Agent plugin sessions and append-only run events."""

import uuid

from django.db import models

from plane.db.models.base import BaseModel

from .append_only import AppendOnlyModel


class ResearchAgentSession(BaseModel):
    """A scoped Plane BFF session; the browser never receives its context token."""

    class Status(models.TextChoices):
        INITIALIZING = "INITIALIZING", "Initializing"
        READY = "READY", "Ready"
        STREAMING = "STREAMING", "Streaming"
        WAITING_APPROVAL = "WAITING_APPROVAL", "Waiting approval"
        SAVING = "SAVING", "Saving"
        DEGRADED = "DEGRADED", "Degraded"
        ERROR = "ERROR", "Error"
        CLOSED = "CLOSED", "Closed"

    session_id = models.UUIDField(default=uuid.uuid4, unique=True, editable=False)
    run_id = models.UUIDField(default=uuid.uuid4, unique=True, editable=False)
    workspace = models.ForeignKey("db.Workspace", on_delete=models.CASCADE, related_name="research_agent_sessions")
    user = models.ForeignKey("db.User", on_delete=models.PROTECT, related_name="research_agent_sessions")
    project = models.ForeignKey("db.Project", on_delete=models.PROTECT, related_name="research_agent_sessions")
    chain_node = models.ForeignKey("ResearchChainNode", on_delete=models.PROTECT, related_name="agent_sessions")
    context_grant = models.OneToOneField(
        "ResearchContextGrant",
        on_delete=models.PROTECT,
        related_name="agent_session",
    )
    status = models.CharField(max_length=24, choices=Status.choices, default=Status.INITIALIZING)
    last_error = models.CharField(max_length=255, blank=True, default="")
    synlora_session_id = models.CharField(max_length=128, blank=True, default="")
    synlora_run_id = models.CharField(max_length=128, blank=True, default="")
    delegated_subject = models.CharField(max_length=255, blank=True, default="")
    assembly = models.JSONField(default=dict, blank=True)
    request_id = models.CharField(max_length=128, unique=True)
    payload_hash = models.CharField(max_length=64)

    class Meta:
        db_table = "research_agent_sessions"
        ordering = ("-created_at",)
        indexes = [models.Index(fields=["workspace", "user", "status"], name="rsch_agent_ws_user_idx")]


class ResearchAgentRunEvent(AppendOnlyModel):
    """Stable ordered event stream returned by the BFF."""

    session = models.ForeignKey(ResearchAgentSession, on_delete=models.PROTECT, related_name="run_events")
    run_id = models.UUIDField(db_index=True)
    seq = models.PositiveIntegerField()
    event_type = models.CharField(max_length=64)
    payload = models.JSONField(default=dict, blank=True)
    request_id = models.CharField(max_length=128, unique=True)

    class Meta:
        db_table = "research_agent_run_events"
        constraints = [models.UniqueConstraint(fields=["run_id", "seq"], name="rsch_agent_event_uq_seq")]
        indexes = [models.Index(fields=["run_id", "event_type"], name="rsch_agent_event_type_idx")]
