"""Research Chain stage approval models."""

from django.db import models
from django.db.models import Q

from plane.db.models.base import BaseModel

from .append_only import AppendOnlyModel


class ResearchChainStage(BaseModel):
    """One fixed thirteen-stage approval record on a research chain."""

    class StageCode(models.TextChoices):
        LITERATURE_REVIEW = "LITERATURE_REVIEW", "Literature review"
        TOPIC_SELECTION = "TOPIC_SELECTION", "Topic selection"
        TOPIC_EVALUATION = "TOPIC_EVALUATION", "Topic evaluation"
        PRE_EXPERIMENT = "PRE_EXPERIMENT", "Pre-experiment"
        ANALYSIS_PRE_EXPERIMENT = "ANALYSIS_PRE_EXPERIMENT", "Pre-experiment analysis"
        OPENING = "OPENING", "Opening"
        EXPERIMENT = "EXPERIMENT", "Experiment"
        ANALYSIS_EXPERIMENT = "ANALYSIS_EXPERIMENT", "Experiment analysis"
        ITERATION = "ITERATION", "Iteration"
        SUMMARY = "SUMMARY", "Summary"
        PAPER_WRITING = "PAPER_WRITING", "Paper writing"
        COMPLETION = "COMPLETION", "Completion"
        TRANSFER = "TRANSFER", "Transfer"

    class Status(models.TextChoices):
        NOT_STARTED = "NOT_STARTED", "Not started"
        IN_PROGRESS = "IN_PROGRESS", "In progress"
        AWAITING_ADVISOR = "AWAITING_ADVISOR", "Awaiting advisor"
        AWAITING_PI = "AWAITING_PI", "Awaiting principal investigator"
        NEEDS_REVISION = "NEEDS_REVISION", "Needs revision"
        APPROVED = "APPROVED", "Approved"

    workspace = models.ForeignKey(
        "db.Workspace",
        on_delete=models.CASCADE,
        related_name="research_chain_stages",
    )
    chain = models.ForeignKey(
        "db.ResearchChain",
        on_delete=models.PROTECT,
        related_name="stage_approvals",
    )
    stage_code = models.CharField(max_length=32, choices=StageCode.choices)
    sort_order = models.PositiveSmallIntegerField()
    status = models.CharField(max_length=24, choices=Status.choices, default=Status.NOT_STARTED)
    requires_pi = models.BooleanField(default=False)
    escalation_reason = models.TextField(blank=True, default="")
    attempt_count = models.PositiveSmallIntegerField(default=0)
    submitted_node = models.ForeignKey(
        "db.ResearchChainNode",
        on_delete=models.SET_NULL,
        related_name="submitted_stage_approvals",
        null=True,
        blank=True,
    )
    submitted_at = models.DateTimeField(null=True, blank=True)
    approved_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        verbose_name = "Research Chain Stage"
        verbose_name_plural = "Research Chain Stages"
        db_table = "research_chain_stages"
        ordering = ("chain", "sort_order")
        constraints = [
            models.UniqueConstraint(
                fields=["chain", "stage_code"],
                condition=Q(deleted_at__isnull=True),
                name="rsch_chain_stage_uq_code",
            ),
        ]
        indexes = [
            models.Index(fields=["workspace", "status"], name="rsch_chain_stage_ws_idx"),
            models.Index(fields=["chain", "sort_order"], name="rsch_chain_stage_order_idx"),
        ]

    def __str__(self):
        return f"{self.chain_id} <{self.stage_code}:{self.status}>"


class ResearchChainStageMaterialRequirement(BaseModel):
    """A hard material requirement attached to one research chain stage."""

    stage = models.ForeignKey(
        ResearchChainStage,
        on_delete=models.CASCADE,
        related_name="material_requirements",
    )
    code = models.CharField(max_length=64)
    title = models.CharField(max_length=255)
    minimum_count = models.PositiveSmallIntegerField(default=1)
    sort_order = models.PositiveSmallIntegerField(default=1)

    class Meta:
        verbose_name = "Research Chain Stage Material Requirement"
        verbose_name_plural = "Research Chain Stage Material Requirements"
        db_table = "research_chain_stage_material_requirements"
        ordering = ("stage", "sort_order")
        constraints = [
            models.UniqueConstraint(
                fields=["stage", "code"],
                condition=Q(deleted_at__isnull=True),
                name="rsch_chain_stage_mat_uq",
            ),
        ]

    def __str__(self):
        return f"{self.stage_id} <{self.code}>"


class ResearchChainStageMaterialItem(BaseModel):
    """A student-submitted item satisfying one stage material requirement."""

    stage = models.ForeignKey(
        ResearchChainStage,
        on_delete=models.CASCADE,
        related_name="material_items",
    )
    requirement = models.ForeignKey(
        ResearchChainStageMaterialRequirement,
        on_delete=models.PROTECT,
        related_name="items",
    )
    title = models.CharField(max_length=500)
    description = models.TextField(blank=True, default="")
    source_node = models.ForeignKey(
        "db.ResearchChainNode",
        on_delete=models.SET_NULL,
        related_name="stage_material_items",
        null=True,
        blank=True,
    )
    external_reference = models.CharField(max_length=1000, blank=True, default="")
    request_id = models.CharField(max_length=128, unique=True)

    class Meta:
        verbose_name = "Research Chain Stage Material Item"
        verbose_name_plural = "Research Chain Stage Material Items"
        db_table = "research_chain_stage_material_items"
        ordering = ("requirement", "created_at")
        indexes = [
            models.Index(fields=["stage", "requirement"], name="rsch_chain_mat_item_idx"),
        ]

    def __str__(self):
        return f"{self.requirement_id} <{self.title}>"


class ResearchChainStageReviewAction(AppendOnlyModel):
    """An immutable advisor or principal-investigator stage decision."""

    class ReviewerRole(models.TextChoices):
        ADVISOR = "ADVISOR", "Direct advisor"
        PI = "PI", "Principal investigator"

    class Action(models.TextChoices):
        APPROVE = "APPROVE", "Approve"
        RETURN = "RETURN", "Return"

    stage = models.ForeignKey(
        ResearchChainStage,
        on_delete=models.PROTECT,
        related_name="review_actions",
    )
    attempt_no = models.PositiveSmallIntegerField()
    reviewer = models.ForeignKey("db.User", on_delete=models.PROTECT, related_name="research_chain_stage_actions")
    reviewer_role = models.CharField(max_length=16, choices=ReviewerRole.choices)
    action = models.CharField(max_length=16, choices=Action.choices)
    comment = models.TextField(blank=True, default="")
    escalated_to_pi = models.BooleanField(default=False)
    material_snapshot = models.JSONField(default=list, blank=True)
    declaration_snapshot = models.JSONField(default=dict, blank=True)
    request_id = models.CharField(max_length=128, unique=True)

    class Meta:
        db_table = "research_chain_stage_review_actions"
        ordering = ("created_at",)
        indexes = [
            models.Index(fields=["stage", "attempt_no"], name="rsch_chain_review_attempt_idx"),
            models.Index(fields=["reviewer", "created_at"], name="rsch_chain_review_user_idx"),
        ]

    def __str__(self):
        return f"{self.stage_id} <{self.reviewer_role}:{self.action}>"


class ResearchChainStagePrecheck(AppendOnlyModel):
    """An advisory AI precheck for a research chain stage submission."""

    class Status(models.TextChoices):
        READY = "READY", "Ready"
        WARNING = "WARNING", "Warning"
        FAILED = "FAILED", "Failed"

    stage = models.ForeignKey(
        ResearchChainStage,
        on_delete=models.PROTECT,
        related_name="prechecks",
    )
    status = models.CharField(max_length=16, choices=Status.choices, default=Status.READY)
    summary = models.TextField(blank=True, default="")
    checks = models.JSONField(default=list, blank=True)
    recommendations = models.JSONField(default=list, blank=True)
    generated_by = models.CharField(max_length=128, default="rule-based-research-precheck")
    model_version = models.CharField(max_length=128, default="1")
    request_id = models.CharField(max_length=128, unique=True)

    class Meta:
        db_table = "research_chain_stage_prechecks"
        ordering = ("-created_at",)
        indexes = [models.Index(fields=["stage", "created_at"], name="rsch_chain_precheck_idx")]

    def __str__(self):
        return f"{self.stage_id} <{self.status}>"
