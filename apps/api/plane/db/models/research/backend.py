"""User-level Research Agent runtime backend connections (§5)."""

from django.db.models import Q
from django.db import models

from plane.db.models.base import BaseModel


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
    base_url = models.URLField(max_length=500)
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
                fields=["workspace", "user"],
                condition=Q(deleted_at__isnull=True),
                name="rsch_agent_backend_uq_ws_user",
            ),
        ]
        indexes = [
            models.Index(fields=["workspace", "user", "is_enabled"], name="rsch_agent_backend_ws_user_idx"),
        ]

    def __str__(self):
        return f"{self.workspace_id}:{self.user_id}"
