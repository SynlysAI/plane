"""Assignable tasks attached to research chain nodes."""

from django.core.exceptions import ValidationError
from django.db import models
from django.db.models import Q

from plane.db.models.base import BaseModel


class ResearchChainNodeTask(BaseModel):
    """A schedulable task that never drives its parent node lifecycle."""

    class Status(models.TextChoices):
        DRAFT = "DRAFT", "Draft"
        ASSIGNED = "ASSIGNED", "Assigned"
        COMPLETED = "COMPLETED", "Completed"
        CANCELLED = "CANCELLED", "Cancelled"

    class ResourceType(models.TextChoices):
        NONE = "NONE", "No resource"
        REPORT = "REPORT", "Periodic report"
        STAGE_MATERIAL = "STAGE_MATERIAL", "Stage material"
        OUTCOME = "OUTCOME", "Research outcome"
        PAPER_REVIEW = "PAPER_REVIEW", "Paper review"
        SNAPSHOT = "SNAPSHOT", "Chain snapshot"
        EXTERNAL_REF = "EXTERNAL_REF", "External reference"

    workspace = models.ForeignKey(
        "db.Workspace",
        on_delete=models.PROTECT,
        related_name="research_chain_node_tasks",
    )
    chain = models.ForeignKey(
        "ResearchChain",
        on_delete=models.PROTECT,
        related_name="node_tasks",
    )
    node = models.ForeignKey(
        "ResearchChainNode",
        on_delete=models.PROTECT,
        related_name="tasks",
    )
    title = models.CharField(max_length=500)
    instruction = models.TextField(blank=True, default="")
    status = models.CharField(max_length=20, choices=Status.choices, default=Status.DRAFT)
    assignee = models.ForeignKey(
        "db.User",
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="assigned_research_chain_tasks",
    )
    assigned_by = models.ForeignKey(
        "db.User",
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="assigned_by_research_chain_tasks",
    )
    completed_by = models.ForeignKey(
        "db.User",
        on_delete=models.SET_NULL,
        related_name="completed_research_chain_tasks",
        null=True,
        blank=True,
    )
    due_at = models.DateTimeField(null=True, blank=True)
    completed_at = models.DateTimeField(null=True, blank=True)
    resource_type = models.CharField(
        max_length=24,
        choices=ResourceType.choices,
        default=ResourceType.NONE,
    )
    resource_id = models.UUIDField(null=True, blank=True)
    request_id = models.CharField(max_length=128, unique=True)
    payload_hash = models.CharField(max_length=64)
    metadata = models.JSONField(default=dict, blank=True)

    class Meta:
        verbose_name = "Research Chain Node Task"
        verbose_name_plural = "Research Chain Node Tasks"
        db_table = "research_chain_node_tasks"
        ordering = ("-created_at",)
        constraints = [
            models.CheckConstraint(
                condition=~Q(resource_type="NONE") | Q(resource_id__isnull=True),
                name="rsch_task_resource_none_ck",
            ),
            models.CheckConstraint(
                # CHECK rejects false rows, so this constraint must explicitly
                # allow NONE; the preceding constraint rejects NONE with an ID.
                condition=Q(resource_type="NONE") | Q(resource_id__isnull=False),
                name="rsch_task_resource_ref_ck",
            ),
        ]
        indexes = [
            models.Index(fields=["workspace", "status", "due_at"], name="rsch_task_ws_status_idx"),
            models.Index(fields=["chain", "status"], name="rsch_task_chain_status_idx"),
            models.Index(fields=["node", "status"], name="rsch_task_node_status_idx"),
            models.Index(
                fields=["assignee", "status", "due_at"],
                name="rsch_task_assignee_due_idx",
            ),
        ]

    def __str__(self):
        return f"{self.node_id} <{self.status}:{self.title[:40]}>"

    def clean(self):
        """Validate that the task is attached to a node in its own chain."""
        super().clean()
        if not self.node_id:
            return
        node = self.node
        errors = {}
        if self.chain_id and node.chain_id != self.chain_id:
            errors["node"] = "Task node must belong to the selected chain."
        workspace_matches = node.chain.workspace_id == self.workspace_id
        if self.workspace_id and node.chain_id and not workspace_matches:
            errors["workspace"] = "Task workspace must match the chain workspace."
        if errors:
            raise ValidationError(errors)


class ResearchTaskComment(BaseModel):
    """Discussion attached to a research task, independent of its instruction."""

    task = models.ForeignKey(ResearchChainNodeTask, on_delete=models.CASCADE, related_name="comments")
    actor = models.ForeignKey("db.User", on_delete=models.PROTECT, related_name="research_task_comments")
    comment_html = models.TextField()
    comment_stripped = models.TextField()
    edited_at = models.DateTimeField(null=True, blank=True)
    request_id = models.CharField(max_length=128)

    class Meta:
        db_table = "research_task_comments"
        ordering = ("created_at", "id")
        constraints = [
            models.UniqueConstraint(fields=["task", "actor", "request_id"], name="rsch_task_comment_request_uq")
        ]


class ResearchTaskSubscriber(BaseModel):
    """Persistent notification subscription attached to a research task."""

    class Source(models.TextChoices):
        CC = "CC", "Carbon copy"
        SELF = "SELF", "Self subscription"

    workspace = models.ForeignKey(
        "db.Workspace",
        on_delete=models.PROTECT,
        related_name="research_task_subscribers",
    )
    task = models.ForeignKey(
        ResearchChainNodeTask,
        on_delete=models.CASCADE,
        related_name="notification_subscribers",
    )
    subscriber = models.ForeignKey(
        "db.User",
        on_delete=models.CASCADE,
        related_name="research_task_subscriptions",
    )
    source = models.CharField(max_length=8, choices=Source.choices, default=Source.CC)

    class Meta:
        verbose_name = "Research Task Subscriber"
        verbose_name_plural = "Research Task Subscribers"
        db_table = "research_task_subscribers"
        ordering = ("created_at", "id")
        constraints = [
            models.UniqueConstraint(
                fields=["task", "subscriber"],
                condition=Q(deleted_at__isnull=True),
                name="rsch_task_subscriber_uq",
            )
        ]
        indexes = [
            models.Index(fields=["workspace", "task"], name="rsch_task_sub_task_idx"),
            models.Index(fields=["subscriber", "source"], name="rsch_task_sub_user_idx"),
        ]

    def __str__(self):
        return f"{self.task_id} <{self.subscriber_id}:{self.source}>"
