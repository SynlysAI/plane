"""Paper review records and immutable submitted versions."""

from django.core.exceptions import ValidationError
from django.db import models

from plane.db.models.base import BaseModel

from .append_only import AppendOnlyModel


class ResearchPaperReview(BaseModel):
    """A review loop attached to a PAPER_WRITING chain node."""

    class Status(models.TextChoices):
        OPEN = "OPEN", "Open"
        WAITING_REVIEW = "WAITING_REVIEW", "Waiting review"
        NEEDS_REVISION = "NEEDS_REVISION", "Needs revision"
        ACCEPTED = "ACCEPTED", "Accepted"
        WITHDRAWN = "WITHDRAWN", "Withdrawn"

    workspace = models.ForeignKey(
        "db.Workspace",
        on_delete=models.PROTECT,
        related_name="research_paper_reviews",
    )
    chain = models.ForeignKey(
        "ResearchChain",
        on_delete=models.PROTECT,
        related_name="paper_reviews",
    )
    node = models.ForeignKey(
        "ResearchChainNode",
        on_delete=models.PROTECT,
        related_name="paper_reviews",
    )
    outcome = models.ForeignKey(
        "ResearchOutcome",
        on_delete=models.PROTECT,
        null=True,
        blank=True,
        related_name="paper_reviews",
    )
    owner = models.ForeignKey(
        "db.User",
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="owned_research_paper_reviews",
    )
    status = models.CharField(max_length=20, choices=Status.choices, default=Status.OPEN)
    current_version_no = models.PositiveIntegerField(default=0)
    final_reviewer = models.ForeignKey(
        "db.User",
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="final_research_paper_reviews",
    )
    due_at = models.DateTimeField(null=True, blank=True)
    request_id = models.CharField(max_length=128, unique=True)
    payload_hash = models.CharField(max_length=64)
    metadata = models.JSONField(default=dict, blank=True)

    class Meta:
        verbose_name = "Research Paper Review"
        verbose_name_plural = "Research Paper Reviews"
        db_table = "research_paper_reviews"
        ordering = ("-created_at",)
        indexes = [
            models.Index(fields=["chain", "status"], name="rsch_paper_review_chain_idx"),
            models.Index(fields=["node", "status"], name="rsch_paper_review_node_idx"),
            models.Index(fields=["owner", "status"], name="rsch_paper_review_owner_idx"),
        ]

    def __str__(self):
        return f"{self.node_id} <{self.status}>"

    def save(self, *args, **kwargs):
        """Run context validation before creating or updating a review."""
        self.clean()
        return super().save(*args, **kwargs)

    def clean(self):
        """Validate node type and chain context for the review."""
        super().clean()
        if not self.node_id:
            return
        node = self.node
        errors = {}
        if node.node_type != "PAPER_WRITING":
            errors["node"] = "Paper review must attach to a PAPER_WRITING node."
        if self.chain_id and node.chain_id != self.chain_id:
            errors["chain"] = "Paper review node must belong to the selected chain."
        workspace_matches = node.chain.workspace_id == self.workspace_id
        if self.workspace_id and node.chain_id and not workspace_matches:
            errors["workspace"] = "Paper review workspace must match the chain workspace."
        if errors:
            raise ValidationError(errors)


class ResearchPaperReviewVersion(AppendOnlyModel):
    """An immutable file version submitted to a paper review."""

    class Status(models.TextChoices):
        SUBMITTED = "SUBMITTED", "Submitted"
        SUPERSEDED = "SUPERSEDED", "Superseded"
        ACCEPTED = "ACCEPTED", "Accepted"

    review = models.ForeignKey(
        ResearchPaperReview,
        on_delete=models.PROTECT,
        related_name="versions",
    )
    version_no = models.PositiveIntegerField()
    asset = models.ForeignKey(
        "db.FileAsset",
        on_delete=models.PROTECT,
        related_name="research_paper_review_versions",
    )
    file_name = models.CharField(max_length=255)
    content_type = models.CharField(max_length=128)
    file_size = models.PositiveBigIntegerField()
    change_summary = models.TextField()
    status = models.CharField(max_length=16, choices=Status.choices, default=Status.SUBMITTED)
    submitted_by = models.ForeignKey(
        "db.User",
        on_delete=models.PROTECT,
        related_name="submitted_research_paper_review_versions",
    )
    submitted_at = models.DateTimeField()
    content_hash = models.CharField(max_length=64)
    request_id = models.CharField(max_length=128, unique=True)

    class Meta:
        verbose_name = "Research Paper Review Version"
        verbose_name_plural = "Research Paper Review Versions"
        db_table = "research_paper_review_versions"
        ordering = ("-version_no",)
        constraints = [
            models.UniqueConstraint(fields=["review", "version_no"], name="rsch_paper_version_uq"),
        ]
        indexes = [
            models.Index(
                fields=["review", "status", "submitted_at"],
                name="rsch_paper_version_idx",
            ),
        ]

    def __str__(self):
        return f"{self.review_id} v{self.version_no}"
