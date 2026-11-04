"""User-level Research Agent runtime backend connections (§5)."""

from django.db.models import Q
from django.db import models

from plane.db.models.base import BaseModel


class ResearchAgentIdentityBinding(BaseModel):
    """A one-to-one external agent identity binding for one Plane user."""

    user = models.ForeignKey(
        "db.User",
        on_delete=models.CASCADE,
        related_name="research_agent_identity_bindings",
    )
    system = models.CharField(max_length=24, default="SYNLORA")
    base_url = models.URLField(max_length=500)
    deployment_id = models.CharField(max_length=128, default="")
    external_user_id = models.CharField(max_length=128)
    external_username = models.CharField(max_length=255, blank=True, default="")
    credential_hash = models.CharField(max_length=64)
    # Fernet ciphertext; the plaintext credential never leaves server-side calls.
    credential_encrypted = models.TextField()

    class Meta:
        db_table = "research_agent_identity_bindings"
        ordering = ("-created_at",)
        constraints = [
            models.UniqueConstraint(
                fields=["user", "system", "deployment_id"],
                condition=Q(deleted_at__isnull=True),
                name="rsch_agent_ident_uq_plane",
            ),
            models.UniqueConstraint(
                fields=["system", "deployment_id", "external_user_id"],
                condition=Q(deleted_at__isnull=True),
                name="rsch_agent_ident_uq_ext",
            ),
            models.UniqueConstraint(
                fields=["system", "deployment_id", "credential_hash"],
                condition=Q(deleted_at__isnull=True),
                name="rsch_agent_ident_uq_key",
            ),
        ]
        indexes = [
            models.Index(
                fields=["system", "deployment_id", "external_user_id"],
                name="rsch_agent_ident_ext_idx",
            ),
        ]

    def __str__(self):
        return f"{self.system}:{self.external_user_id}:{self.user_id}"


class ResearchAgentBackendConnection(BaseModel):
    """One self-service ScienceDiscovery runtime connection per member."""

    class HealthStatus(models.TextChoices):
        UNKNOWN = "UNKNOWN", "Unknown"
        OK = "OK", "Ok"
        DOWN = "DOWN", "Down"

    workspace = models.ForeignKey(
        "db.Workspace",
        on_delete=models.CASCADE,
        related_name="research_agent_backend_connections",
    )
    user = models.ForeignKey(
        "db.User",
        on_delete=models.CASCADE,
        related_name="research_agent_backend_connections",
    )
    system = models.CharField(max_length=24, default="SCIENCE_DISCOVERY")
    identity_binding = models.ForeignKey(
        "ResearchAgentIdentityBinding",
        on_delete=models.SET_NULL,
        related_name="workspace_connections",
        null=True,
        blank=True,
    )
    base_url = models.URLField(max_length=500, blank=True, default="")
    # Fernet ciphertext; never serialized to the browser (§5 令牌安全)。
    credential_encrypted = models.TextField(blank=True, default="")
    is_enabled = models.BooleanField(default=False)
    health_status = models.CharField(
        max_length=16,
        choices=HealthStatus.choices,
        default=HealthStatus.UNKNOWN,
    )
    last_health_at = models.DateTimeField(null=True, blank=True)
    last_error = models.CharField(max_length=255, blank=True, default="")

    class Meta:
        db_table = "research_agent_backend_connections"
        ordering = ("-created_at",)
        constraints = [
            # 软删除墓碑行不参与唯一性：条件索引避免「删除后无法重建连接」。
            models.UniqueConstraint(
                fields=["workspace", "user", "system"],
                condition=Q(deleted_at__isnull=True),
                name="rsch_agent_backend_uq_ws_user",
            ),
        ]
        indexes = [
            models.Index(fields=["workspace", "user", "is_enabled"], name="rsch_agent_backend_ws_user_idx"),
        ]

    def __str__(self):
        return f"{self.workspace_id}:{self.user_id}"
