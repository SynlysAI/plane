"""Explicit external account binding without merging native identities."""

from django.db import models

from plane.db.models.base import BaseModel


class AccountLink(BaseModel):
    """A pending or active link between a Plane identity and an external subject."""

    class Status(models.TextChoices):
        PENDING = "PENDING", "Pending"
        ACTIVE = "ACTIVE", "Active"
        REVOKED = "REVOKED", "Revoked"
        UNLINKED = "UNLINKED", "Unlinked"

    canonical_identity = models.CharField(max_length=255)
    provider = models.CharField(max_length=64)
    external_subject = models.CharField(max_length=255)
    local_user = models.ForeignKey("db.User", on_delete=models.PROTECT, related_name="research_account_links")
    status = models.CharField(max_length=16, choices=Status.choices, default=Status.PENDING)
    verified_at = models.DateTimeField(null=True, blank=True)
    bound_by = models.ForeignKey("db.User", on_delete=models.SET_NULL, null=True, blank=True, related_name="research_account_links_created")
    unlinked_at = models.DateTimeField(null=True, blank=True)
    audit_event_id = models.UUIDField(null=True, blank=True)
    request_id = models.CharField(max_length=128, unique=True)
    payload_hash = models.CharField(max_length=64)
    verification_hash = models.CharField(max_length=64, blank=True, default="")
    verification_expires_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        db_table = "research_account_links"
        constraints = [
            models.UniqueConstraint(fields=["provider", "external_subject"], condition=models.Q(deleted_at__isnull=True), name="rsch_account_link_uq_subject"),
        ]
        indexes = [
            models.Index(fields=["local_user", "status"], name="rsch_account_link_user_idx"),
            models.Index(fields=["provider", "canonical_identity"], name="rsch_account_link_identity_idx"),
        ]
