"""Server-side Synlora personal API key identity bindings."""

from __future__ import annotations

import hashlib
import logging
from dataclasses import dataclass

import httpx
from django.conf import settings
from django.db import IntegrityError, transaction

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
                f"{base_url.rstrip('/')}/api/v1/auth/me",
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
    except ValueError as exc:
        raise SynloraIdentityError("invalid_synlora_response") from exc
    if not user_id:
        raise SynloraIdentityError("invalid_synlora_response")
    return SynloraIdentity(user_id=user_id, username=username)


def _active_binding(**filters) -> ResearchAgentIdentityBinding | None:
    return (
        ResearchAgentIdentityBinding.objects.filter(deleted_at__isnull=True, **filters)
        .order_by("-created_at")
        .first()
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
    normalized_base_url = base_url.rstrip("/")
    identity = verify_synlora_api_key(
        base_url=normalized_base_url,
        token=token,
        timeout_seconds=float(getattr(settings, "SYNLORA_TIMEOUT_SECONDS", 5)),
        transport=transport,
    )
    credential_hash = hashlib.sha256(token.encode()).hexdigest()
    if connection is not None and (
        connection.workspace_id != workspace.id or connection.user_id != user.id
    ):
        raise SynloraIdentityConflict("connection_owner_mismatch")

    with transaction.atomic():
        by_key = _active_binding(
            system="SYNLORA",
            base_url=normalized_base_url,
            credential_hash=credential_hash,
        )
        by_external = _active_binding(
            system="SYNLORA",
            base_url=normalized_base_url,
            external_user_id=identity.user_id,
        )
        own = _active_binding(user=user, system="SYNLORA", base_url=normalized_base_url)
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
            binding.external_user_id = identity.user_id
            binding.external_username = identity.username
            binding.credential_hash = credential_hash
            binding.credential_encrypted = encrypt_data(token)
            binding.updated_by = user
            binding.save(update_fields=[
                "external_user_id",
                "external_username",
                "credential_hash",
                "credential_encrypted",
                "updated_by",
                "updated_at",
            ])

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
    if connection.identity_binding_id is not None and connection.identity_binding.deleted_at is None:
        return connection.identity_binding

    base_url = (connection.base_url or settings.SYNLORA_BASE_URL or "").rstrip("/")
    if not base_url or not connection.credential_encrypted:
        return None
    existing = _active_binding(user=user, system="SYNLORA", base_url=base_url)
    if existing is not None:
        connection.identity_binding = existing
        connection.save(update_fields=["identity_binding", "updated_at"])
        return existing

    try:
        return bind_synlora_api_key(
            workspace,
            user=user,
            base_url=base_url,
            token=decrypt_data(connection.credential_encrypted),
            connection=connection,
        )
    except (SynloraIdentityError, SynloraIdentityConflict):
        _LOGGER.warning("Synlora identity binding failed user=%s workspace=%s", user.id, workspace.id)
        return None
