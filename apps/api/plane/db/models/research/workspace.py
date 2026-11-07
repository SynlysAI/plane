"""AI-Native Research Workspace resource models."""

from django.db import models

from plane.db.models.base import BaseModel

from .append_only import AppendOnlyModel


class StudyWorkspace(BaseModel):
    """The stable study-level identity shared by Plane, Runner, and Synlora."""

    class Status(models.TextChoices):
        ACTIVE = "ACTIVE", "Active"
        DISABLED = "DISABLED", "Disabled"
        FAILED = "FAILED", "Failed"

    workspace = models.ForeignKey(
        "db.Workspace",
        on_delete=models.CASCADE,
        related_name="study_workspaces",
    )
    chain = models.ForeignKey(
        "db.ResearchChain",
        on_delete=models.PROTECT,
        related_name="study_workspaces",
    )
    name = models.CharField(max_length=255)
    status = models.CharField(max_length=16, choices=Status.choices, default=Status.ACTIVE)
    is_enabled = models.BooleanField(default=True)
    request_id = models.CharField(max_length=128, unique=True)
    payload_hash = models.CharField(max_length=64)

    class Meta:
        db_table = "study_workspaces"
        ordering = ("-created_at",)
        constraints = [
            models.UniqueConstraint(
                fields=["chain"],
                condition=models.Q(deleted_at__isnull=True),
                name="rws_study_uq_chain",
            ),
        ]
        indexes = [models.Index(fields=["workspace", "status"], name="rws_study_ws_status_idx")]

    def __str__(self):
        return f"{self.chain_id} <{self.status}>"

    @property
    def resource_uri(self):
        """Return the stable non-secret URI representing this study workspace."""
        return f"plane-rws://study-workspaces/{self.id}"

    @property
    def default_working_copy(self):
        """Return the active default persistent copy, if one exists."""
        return self.working_copies.filter(is_default=True, deleted_at__isnull=True).first()


class WorkspaceWorkingCopy(BaseModel):
    """A logical persistent checkout owned by one StudyWorkspace."""

    class Status(models.TextChoices):
        PENDING = "PENDING", "Pending"
        READY = "READY", "Ready"
        DISABLED = "DISABLED", "Disabled"
        FAILED = "FAILED", "Failed"

    study = models.ForeignKey(
        StudyWorkspace,
        on_delete=models.PROTECT,
        related_name="working_copies",
    )
    owner = models.ForeignKey(
        "db.User",
        on_delete=models.PROTECT,
        related_name="owned_workspace_working_copies",
    )
    branch = models.CharField(max_length=255, default="main")
    storage_key = models.CharField(max_length=512, unique=True)
    base_commit = models.CharField(max_length=64, blank=True, default="")
    head_commit = models.CharField(max_length=64, blank=True, default="")
    status = models.CharField(max_length=16, choices=Status.choices, default=Status.PENDING)
    is_default = models.BooleanField(default=False)

    class Meta:
        db_table = "workspace_working_copies"
        ordering = ("-is_default", "created_at")
        constraints = [
            models.UniqueConstraint(
                fields=["study", "branch"],
                condition=models.Q(deleted_at__isnull=True),
                name="rws_copy_uq_study_branch",
            ),
            models.UniqueConstraint(
                fields=["study"],
                condition=models.Q(is_default=True, deleted_at__isnull=True),
                name="rws_copy_uq_default",
            ),
        ]
        indexes = [models.Index(fields=["study", "status"], name="rws_copy_study_status_idx")]

    def __str__(self):
        return f"{self.study_id} <{self.branch}>"

    @property
    def resource_uri(self):
        """Return the stable logical URI of this working copy."""
        return f"plane-rws://working-copies/{self.id}"


class WorkspaceOperation(BaseModel):
    """An idempotent control-plane intent and its reconcilable outcome."""

    class Status(models.TextChoices):
        PENDING = "PENDING", "Pending"
        RUNNING = "RUNNING", "Running"
        SUCCEEDED = "SUCCEEDED", "Succeeded"
        FAILED = "FAILED", "Failed"

    class ActorType(models.TextChoices):
        USER = "USER", "User"
        AGENT = "AGENT", "Agent"
        SERVICE = "SERVICE", "Service"

    workspace = models.ForeignKey(
        "db.Workspace",
        on_delete=models.CASCADE,
        related_name="workspace_operations",
    )
    study = models.ForeignKey(
        StudyWorkspace,
        on_delete=models.PROTECT,
        related_name="operations",
        null=True,
        blank=True,
    )
    working_copy = models.ForeignKey(
        WorkspaceWorkingCopy,
        on_delete=models.PROTECT,
        related_name="operations",
        null=True,
        blank=True,
    )
    actor = models.ForeignKey(
        "db.User",
        on_delete=models.SET_NULL,
        related_name="workspace_operations",
        null=True,
        blank=True,
    )
    actor_type = models.CharField(max_length=16, choices=ActorType.choices, default=ActorType.USER)
    kind = models.CharField(max_length=64)
    request_id = models.CharField(max_length=128, unique=True)
    payload_hash = models.CharField(max_length=64)
    expected_head = models.CharField(max_length=64, blank=True, default="")
    status = models.CharField(max_length=16, choices=Status.choices, default=Status.PENDING)
    error_code = models.CharField(max_length=128, blank=True, default="")
    error_message = models.TextField(blank=True, default="")
    result = models.JSONField(default=dict, blank=True)

    class Meta:
        db_table = "workspace_operations"
        ordering = ("-created_at",)
        indexes = [
            models.Index(fields=["workspace", "kind", "status"], name="rws_op_ws_kind_status_idx"),
            models.Index(fields=["study", "created_at"], name="rws_op_study_time_idx"),
        ]

    def __str__(self):
        return f"{self.kind} <{self.request_id}>"


class WorkspaceResourceReference(AppendOnlyModel):
    """An immutable content-addressed reference in the v1 cross-system contract."""

    class Kind(models.TextChoices):
        GIT = "git", "Git"
        LFS = "lfs", "Git LFS"
        ASSET = "asset", "Research asset"
        LEGACY_EXTERNAL = "legacy_external", "Legacy external"

    study = models.ForeignKey(
        StudyWorkspace,
        on_delete=models.PROTECT,
        related_name="resource_references",
    )
    schema_version = models.CharField(max_length=64)
    kind = models.CharField(max_length=24, choices=Kind.choices)
    digest = models.CharField(max_length=64, unique=True)
    repository_id = models.UUIDField(null=True, blank=True)
    commit = models.CharField(max_length=64, blank=True, default="")
    path = models.CharField(max_length=1024, blank=True, default="")
    blob_oid = models.CharField(max_length=64, blank=True, default="")
    lfs_oid = models.CharField(max_length=64, blank=True, default="")
    asset_revision_id = models.UUIDField(null=True, blank=True)
    logical_asset_id = models.UUIDField(null=True, blank=True)
    external_reference = models.CharField(max_length=1000, blank=True, default="")
    content_sha256 = models.CharField(max_length=64)
    size = models.BigIntegerField()
    source_system = models.CharField(max_length=64, blank=True, default="")
    source_run_id = models.CharField(max_length=128, blank=True, default="")
    payload = models.JSONField()

    class Meta:
        db_table = "workspace_resource_references"
        ordering = ("-created_at",)
        indexes = [
            models.Index(fields=["study", "kind"], name="rws_ref_study_kind_idx"),
            models.Index(fields=["content_sha256"], name="rws_ref_content_idx"),
        ]

    def __str__(self):
        return f"{self.study_id} <{self.digest}>"

    @property
    def resource_uri(self):
        """Return the stable display URI of this fixed reference."""
        return f"plane-rws://study-workspaces/{self.study_id}/resources/{self.digest}"


class WorkspaceAsset(BaseModel):
    """A projection of an immutable object-store asset owned by a study."""

    class Status(models.TextChoices):
        PENDING = "PENDING", "Pending"
        READY = "READY", "Ready"
        FAILED = "FAILED", "Failed"

    study = models.ForeignKey(
        StudyWorkspace,
        on_delete=models.PROTECT,
        related_name="assets",
    )
    logical_asset_id = models.UUIDField()
    current_revision_id = models.UUIDField()
    content_sha256 = models.CharField(max_length=64)
    size = models.BigIntegerField(default=0)
    media_type = models.CharField(max_length=255, blank=True, default="")
    storage_key = models.CharField(max_length=1024, blank=True, default="")
    status = models.CharField(max_length=16, choices=Status.choices, default=Status.PENDING)
    source_system = models.CharField(max_length=64, blank=True, default="")
    source_run_id = models.CharField(max_length=128, blank=True, default="")

    class Meta:
        db_table = "workspace_assets"
        ordering = ("-created_at",)
        constraints = [
            models.UniqueConstraint(
                fields=["study", "logical_asset_id"],
                condition=models.Q(deleted_at__isnull=True),
                name="rws_asset_uq_logical",
            ),
        ]
        indexes = [models.Index(fields=["study", "status"], name="rws_asset_study_status_idx")]

    def __str__(self):
        return f"{self.study_id} <{self.logical_asset_id}>"


class WorkspaceIndexProjection(BaseModel):
    """A rebuildable knowledge-index receipt projected from a fixed source."""

    class Status(models.TextChoices):
        PENDING = "PENDING", "Pending"
        PROCESSING = "PROCESSING", "Processing"
        READY = "READY", "Ready"
        STALE = "STALE", "Stale"
        FAILED = "FAILED", "Failed"

    study = models.ForeignKey(
        StudyWorkspace,
        on_delete=models.PROTECT,
        related_name="index_projections",
    )
    resource_reference = models.ForeignKey(
        WorkspaceResourceReference,
        on_delete=models.PROTECT,
        related_name="index_projections",
    )
    target_system = models.CharField(max_length=64, default="RAGPORTAL")
    source_digest = models.CharField(max_length=64)
    generation = models.PositiveIntegerField(default=1)
    status = models.CharField(max_length=16, choices=Status.choices, default=Status.PENDING)
    receipt = models.JSONField(default=dict, blank=True)

    class Meta:
        db_table = "workspace_index_projections"
        ordering = ("-created_at",)
        constraints = [
            models.UniqueConstraint(
                fields=["target_system", "source_digest"],
                condition=models.Q(deleted_at__isnull=True),
                name="rws_index_uq_source",
            ),
        ]
        indexes = [models.Index(fields=["study", "status"], name="rws_index_study_status_idx")]

    def __str__(self):
        return f"{self.target_system} <{self.source_digest}>"
