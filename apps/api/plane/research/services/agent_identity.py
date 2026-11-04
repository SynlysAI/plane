"""Server-side Synlora personal API key identity bindings."""

from __future__ import annotations

import hashlib
import logging
from dataclasses import dataclass
from urllib.parse import urlsplit, urlunsplit

import httpx
from django.conf import settings
from django.db import IntegrityError, transaction
from django.utils import timezone

from plane.db.models import ResearchAgentBackendConnection, ResearchAgentIdentityBinding
from plane.license.utils.encryption import decrypt_data, encrypt_data

_LOGGER = logging.getLogger(__name__)


class SynloraIdentityError(Exception):
    """Raised when a Synlora personal API key cannot be verified."""


class SynloraIdentityConflict(Exception):
    """Raised when a key or Synlora account is already bound to another user."""


@dataclass(frozen=True)
class SynloraIdentity:
    """Verified Synlora user identity returned by ``/auth/me``."""

    user_id: str
    username: str
    deployment_id: str


def normalize_synlora_base_url(base_url: str) -> str:
    """Normalize a Synlora base URL without treating aliases as deployment identity."""

    parsed = urlsplit(str(base_url or "").strip())
    if parsed.scheme.lower() not in {"http", "https"} or not parsed.hostname:
        raise SynloraIdentityError("invalid_synlora_base_url")
    if parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise SynloraIdentityError("invalid_synlora_base_url")
    scheme = parsed.scheme.lower()
    host = parsed.hostname.lower()
    port = parsed.port
    if (scheme == "http" and port == 80) or (scheme == "https" and port == 443):
        port = None
    netloc = f"{host}:{port}" if port is not None else host
    path = parsed.path.rstrip("/")
    return urlunsplit((scheme, netloc, path, "", ""))


def verify_synlora_api_key(
    *,
    base_url: str,
    token: str,
    timeout_seconds: float = 5.0,
    transport: httpx.BaseTransport | None = None,
) -> SynloraIdentity:
    """Verify a Synlora yxkey and return its owning user identity.

    Args:
        base_url: Normalized Synlora base URL.
        token: Personal API key plaintext; it is never logged or persisted as plaintext.
        timeout_seconds: Upstream verification timeout.
        transport: Optional test transport.

    Raises:
        SynloraIdentityError: The key is malformed, unreachable, invalid, or incomplete.
    """
    if not token.startswith("yxkey_"):
        raise SynloraIdentityError("invalid_synlora_key")
    try:
        with httpx.Client(transport=transport) as client:
            response = client.get(
                f"{normalize_synlora_base_url(base_url)}/api/v1/auth/me",
                headers={"Authorization": f"Bearer {token}"},
                timeout=timeout_seconds,
            )
    except httpx.HTTPError as exc:
        raise SynloraIdentityError("synlora_unavailable") from exc
    if response.status_code in (401, 403):
        raise SynloraIdentityError("invalid_synlora_key")
    if response.status_code >= 400:
        raise SynloraIdentityError("synlora_unavailable")
    try:
        payload = response.json()
        user_id = str(payload.get("sub") or "")
        username = str(payload.get("username") or "")
        deployment_id = str(payload.get("deployment_id") or "")
    except ValueError as exc:
        raise SynloraIdentityError("invalid_synlora_response") from exc
    if not user_id or not deployment_id:
        raise SynloraIdentityError("invalid_synlora_response")
    return SynloraIdentity(user_id=user_id, username=username, deployment_id=deployment_id)


def _active_binding(**filters) -> ResearchAgentIdentityBinding | None:
    return (
        ResearchAgentIdentityBinding.objects.filter(deleted_at__isnull=True, **filters).order_by("-created_at").first()
    )


def bind_synlora_api_key(
    workspace,
    *,
    user,
    base_url: str,
    token: str,
    connection: ResearchAgentBackendConnection | None = None,
    transport: httpx.BaseTransport | None = None,
) -> ResearchAgentIdentityBinding:
    """Verify and persist a one-to-one Plane/Synlora identity binding.

    Args:
        workspace: Plane workspace used for the optional workspace connection.
        user: Plane user who owns the key.
        base_url: Synlora deployment base URL.
        token: New personal API key plaintext.
        connection: Optional workspace connection to link to the binding.
        transport: Optional test transport.

    Returns:
        The active global identity binding.

    Raises:
        SynloraIdentityError: Verification failed.
        SynloraIdentityConflict: The key or Synlora user belongs to another Plane user.
    """
    normalized_base_url = normalize_synlora_base_url(base_url)
    identity = verify_synlora_api_key(
        base_url=normalized_base_url,
        token=token,
        timeout_seconds=float(getattr(settings, "SYNLORA_TIMEOUT_SECONDS", 5)),
        transport=transport,
    )
    credential_hash = hashlib.sha256(token.encode()).hexdigest()
    if connection is not None and (connection.workspace_id != workspace.id or connection.user_id != user.id):
        raise SynloraIdentityConflict("connection_owner_mismatch")

    with transaction.atomic():
        by_key = _active_binding(
            system="SYNLORA",
            deployment_id=identity.deployment_id,
            credential_hash=credential_hash,
        )
        by_external = _active_binding(
            system="SYNLORA",
            deployment_id=identity.deployment_id,
            external_user_id=identity.user_id,
        )
        own = _active_binding(user=user, system="SYNLORA", deployment_id=identity.deployment_id)
        if own is None:
            # Bindings created before deployment_id was available used a stable
            # URL-derived marker. Adopt the same owner during the one-time upgrade.
            legacy_own = (
                ResearchAgentIdentityBinding.objects.filter(
                    user=user,
                    system="SYNLORA",
                    deleted_at__isnull=True,
                    deployment_id__startswith="url:",
                )
                .order_by("-created_at")
                .first()
            )
            if legacy_own is not None and str(legacy_own.external_user_id) == identity.user_id:
                own = legacy_own
        if (by_key is not None and by_key.user_id != user.id) or (
            by_external is not None and by_external.user_id != user.id
        ):
            raise SynloraIdentityConflict("synlora_identity_bound_to_other_plane_user")
        if own is not None and own.external_user_id != identity.user_id:
            raise SynloraIdentityConflict("plane_user_bound_to_other_synlora_user")

        binding = own or by_key or by_external
        if binding is None:
            binding = ResearchAgentIdentityBinding(
                user=user,
                system="SYNLORA",
                base_url=normalized_base_url,
                deployment_id=identity.deployment_id,
                external_user_id=identity.user_id,
                external_username=identity.username,
                credential_hash=credential_hash,
                credential_encrypted=encrypt_data(token),
                created_by=user,
            )
            try:
                binding.save(disable_auto_set_user=True)
            except IntegrityError as exc:
                raise SynloraIdentityConflict("synlora_identity_race") from exc
        else:
            binding.user = user
            binding.base_url = normalized_base_url
            binding.deployment_id = identity.deployment_id
            binding.external_user_id = identity.user_id
            binding.external_username = identity.username
            binding.credential_hash = credential_hash
            binding.credential_encrypted = encrypt_data(token)
            binding.updated_by = user
            try:
                binding.save(
                    update_fields=[
                        "base_url",
                        "deployment_id",
                        "external_user_id",
                        "external_username",
                        "credential_hash",
                        "credential_encrypted",
                        "updated_by",
                        "updated_at",
                    ]
                )
            except IntegrityError as exc:
                raise SynloraIdentityConflict("synlora_identity_race") from exc

        if connection is not None:
            connection.identity_binding = binding
            connection.save(update_fields=["identity_binding", "updated_at"])
    return binding


def ensure_synlora_identity_binding(workspace, user) -> ResearchAgentIdentityBinding | None:
    """Return the user's verified binding, migrating one legacy stored key if needed.

    Args:
        workspace: Plane workspace.
        user: Plane user.

    Returns:
        Active binding, or ``None`` when no usable key is configured.
    """
    connection = (
        ResearchAgentBackendConnection.objects.filter(
            workspace=workspace,
            user=user,
            system="SYNLORA",
            deleted_at__isnull=True,
            is_enabled=True,
        )
        .order_by("-created_at")
        .first()
    )
    if connection is None:
        return None
    linked_binding = connection.identity_binding
    if (
        linked_binding is not None
        and linked_binding.deleted_at is None
        and not str(linked_binding.deployment_id).startswith("url:")
    ):
        return linked_binding

    base_url = (
        connection.base_url
        or (linked_binding.base_url if linked_binding is not None else "")
        or settings.SYNLORA_BASE_URL
    ).rstrip("/")
    credential_encrypted = connection.credential_encrypted or (
        linked_binding.credential_encrypted if linked_binding is not None else ""
    )
    if not base_url or not credential_encrypted:
        return None

    try:
        return bind_synlora_api_key(
            workspace,
            user=user,
            base_url=base_url,
            token=decrypt_data(credential_encrypted),
            connection=connection,
        )
    except (SynloraIdentityError, SynloraIdentityConflict):
        _LOGGER.warning("Synlora identity binding failed user=%s workspace=%s", user.id, workspace.id)
        return None


def revoke_synlora_identity_connection(workspace, user, connection) -> None:
    """Remove one workspace's usable credential while preserving audit lineage.

    Args:
        workspace: Plane workspace owning the connection.
        user: Plane user who owns the credential.
        connection: Active Synlora workspace connection about to be soft-deleted.
    """

    binding = connection.identity_binding
    has_other_connection = (
        ResearchAgentBackendConnection.objects.filter(
            identity_binding=binding,
            system="SYNLORA",
            deleted_at__isnull=True,
            is_enabled=True,
        )
        .exclude(pk=connection.pk)
        .exists()
    )
    connection.identity_binding = None
    connection.credential_encrypted = ""
    connection.save(update_fields=["identity_binding", "credential_encrypted", "updated_at"])
    if binding is not None and not has_other_connection:
        binding.deleted_at = timezone.now()
        binding.credential_encrypted = ""
        binding.updated_by = user
        binding.save(update_fields=["deleted_at", "credential_encrypted", "updated_by", "updated_at"])


def repair_synlora_account_links(*, dry_run: bool = False, transport: httpx.BaseTransport | None = None) -> dict:
    """Idempotently send verified bindings to Synlora's historical alias endpoint.

    Args:
        dry_run: Only report work items without calling Synlora.
        transport: Optional test transport.

    Returns:
        Repair counts for operational reporting.
    """
    service_token = str(getattr(settings, "SYNLORA_SERVICE_TOKEN", "") or "")
    if not service_token:
        return {"submitted": 0, "conflicts": 0, "failed": 0, "reason": "service_token_missing"}

    if not dry_run:
        legacy_connections = (
            ResearchAgentBackendConnection.objects.filter(
                system="SYNLORA",
                deleted_at__isnull=True,
                is_enabled=True,
            )
            .select_related("workspace", "user")
            .order_by("workspace_id", "user_id")
        )
        for connection in legacy_connections:
            ensure_synlora_identity_binding(connection.workspace, connection.user)

    submitted = conflicts = failed = 0
    connections = (
        ResearchAgentBackendConnection.objects.filter(
            system="SYNLORA",
            deleted_at__isnull=True,
            identity_binding__deleted_at__isnull=True,
        )
        .select_related("workspace", "user", "identity_binding")
        .order_by("workspace_id", "user_id")
    )
    seen = set()
    for connection in connections:
        key = (connection.workspace_id, connection.user_id)
        if key in seen:
            continue
        seen.add(key)
        binding = connection.identity_binding
        payload = {
            "schema_version": "plane-account-link-repair.v1",
            "account_link_id": f"plane-{connection.workspace_id}-{connection.user_id}",
            "workspace_id": str(connection.workspace_id),
            "plane_user_id": str(connection.user_id),
            "external_subject": f"plane-ws-{connection.workspace_id}-user-{connection.user_id}",
            "synlora_user_id": binding.external_user_id,
            "synlora_username": binding.external_username,
            "workspace_slug": connection.workspace.slug,
            "workspace_name": connection.workspace.name,
        }
        if dry_run:
            submitted += 1
            continue
        try:
            with httpx.Client(transport=transport) as client:
                response = client.post(
                    f"{binding.base_url.rstrip('/')}/api/v1/research/account-links",
                    headers={"Authorization": f"Bearer {service_token}"},
                    json=payload,
                    timeout=float(getattr(settings, "SYNLORA_TIMEOUT_SECONDS", 5)),
                )
            if response.status_code == 409:
                conflicts += 1
            elif response.status_code >= 400:
                failed += 1
            else:
                submitted += 1
        except httpx.HTTPError:
            failed += 1
    return {"submitted": submitted, "conflicts": conflicts, "failed": failed}
