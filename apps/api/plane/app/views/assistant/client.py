# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Backend-only client for the Synlora (Yuxi) agent Run API.

The service token never leaves the backend: the browser talks to the Plane BFF
endpoints, which inject the workspace connection credential server-side.
"""

from dataclasses import dataclass

import time
from typing import Any

import httpx
from django.conf import settings

from plane.db.models import ExternalSystemConnection, IntegrationSystem


class AssistantNotConfigured(Exception):
    """The workspace has no usable Synlora connection (shared credential)."""


@dataclass
class AssistantConfig:
    base_url: str
    token: str
    service_token: str
    agent_slug: str
    timeout_seconds: float
    stream_read_timeout_seconds: float
    credential_mode: str
    is_enabled: bool
    auth_mode: str = "DELEGATED_SERVICE"


def resolve_assistant_config(workspace, user=None) -> AssistantConfig:
    """Resolve the Synlora connection for a workspace (and optional member).

    SHARED mode reads the stored shared credential. PERSONAL mode reads the
    requesting member's own connection from the user-level agent backend
    store (``ResearchAgentBackendConnection`` with ``system=SYNLORA``); its
    base URL overrides the platform address when provided.
    """
    connection = ExternalSystemConnection.objects.filter(
        workspace=workspace,
        system=IntegrationSystem.SYNLORA,
        deleted_at__isnull=True,
    ).first()
    base_url = (getattr(connection, "base_url", "") or settings.SYNLORA_BASE_URL or "").rstrip("/")
    token = ""
    credential_mode = ExternalSystemConnection.CredentialMode.SHARED
    auth_mode = "API_KEY" if connection is not None else "DELEGATED_SERVICE"
    is_enabled = connection is not None and connection.is_enabled
    if connection is not None:
        credential_mode = connection.credential_mode
        if credential_mode == ExternalSystemConnection.CredentialMode.SHARED:
            token = connection.get_credential()
            auth_mode = "API_KEY" if user is None else "DELEGATED_SERVICE"
        elif credential_mode == ExternalSystemConnection.CredentialMode.PERSONAL and user is not None:
            from plane.db.models import ResearchAgentBackendConnection
            from plane.license.utils.encryption import decrypt_data

            personal = (
                ResearchAgentBackendConnection.objects.filter(
                    workspace=workspace,
                    user=user,
                    system="SYNLORA",
                    deleted_at__isnull=True,
                    is_enabled=True,
                )
                .select_related("identity_binding")
                .order_by("-created_at")
                .first()
            )
            if personal is not None:
                if personal.identity_binding_id is not None and personal.identity_binding.deleted_at is None:
                    token = decrypt_data(personal.identity_binding.credential_encrypted)
                else:
                    token = decrypt_data(personal.credential_encrypted)
                if personal.base_url:
                    base_url = personal.base_url.rstrip("/")
                auth_mode = "PERSONAL_API_KEY"
        else:
            auth_mode = "DELEGATED_SERVICE" if user is not None else "API_KEY"
    return AssistantConfig(
        base_url=base_url,
        token=token,
        agent_slug=settings.SYNLORA_AGENT_SLUG,
        service_token=settings.SYNLORA_SERVICE_TOKEN,
        timeout_seconds=float(settings.SYNLORA_TIMEOUT_SECONDS),
        stream_read_timeout_seconds=float(settings.SYNLORA_STREAM_READ_TIMEOUT_SECONDS),
        credential_mode=credential_mode,
        is_enabled=is_enabled,
        auth_mode=auth_mode,
    )


def resolve_assistant_client(workspace, user=None) -> "SynloraAssistantClient":
    """Return a ready client or raise AssistantNotConfigured."""
    config = resolve_assistant_config(workspace, user=user)
    if not config.base_url or not config.token or not config.is_enabled:
        raise AssistantNotConfigured
    return SynloraAssistantClient(config, workspace=workspace, user=user)


class SynloraAssistantClient:
    """Sync client over Synlora v1 Sessions for the Plane assistant BFF."""

    def __init__(self, config: AssistantConfig, workspace=None, user=None):
        self.config = config
        self.workspace = workspace
        self.user = user
        self._delegated_token: str | None = None
        self._delegated_expires_at = 0.0

    def _timeout(self, stream: bool = False) -> httpx.Timeout:
        read = self.config.stream_read_timeout_seconds if stream else self.config.timeout_seconds
        return httpx.Timeout(
            connect=self.config.timeout_seconds,
            read=read,
            write=self.config.timeout_seconds,
            pool=self.config.timeout_seconds,
        )

    def _delegated_subject(self) -> str:
        """Build a stable subject isolated by Plane workspace and user."""
        if self.workspace is None or self.user is None:
            return ""
        return f"plane-ws-{self.workspace.id}-user-{self.user.id}"

    def _ensure_delegated_token(self) -> str:
        """Return a direct API key or exchange a short-lived delegated token."""
        if self.config.auth_mode in {"PERSONAL_API_KEY", "API_KEY"} and self.config.token:
            return self.config.token
        if self._delegated_token and time.time() < self._delegated_expires_at - 300:
            return self._delegated_token
        if not self.config.service_token:
            # v1 Sessions requires a Plane service credential for delegated user
            # identity. A browser-facing yxkey is not a valid substitute.
            raise AssistantNotConfigured
        if self.workspace is None or self.user is None:
            return self.config.token
        service_token = self.config.service_token
        response = httpx.post(
            f"{self.config.base_url}/api/v1/research/delegated-token",
            headers={"Authorization": f"Bearer {service_token}"},
            json={
                "schema_version": "plane-delegated-auth.v1",
                "account_link_id": f"plane-{self.workspace.id}-{self.user.id}",
                "workspace_id": str(self.workspace.id),
                "plane_user_id": str(self.user.id),
                "external_subject": self._delegated_subject(),
            },
            timeout=self._timeout(),
        )
        if response.status_code >= 400:
            raise AssistantNotConfigured
        payload = response.json()
        token = str(payload.get("token") or "")
        if not token:
            raise AssistantNotConfigured
        self._delegated_token = token
        self._delegated_expires_at = time.time() + int(payload.get("expires_in") or 3600)
        return token

    def _headers(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self._ensure_delegated_token()}"}

    def _request(self, method: str, path: str, *, json_body=None, params=None) -> httpx.Response:
        return httpx.request(
            method,
            f"{self.config.base_url}{path}",
            headers=self._headers(),
            json=json_body,
            params=params,
            timeout=self._timeout(),
        )

    def health(self) -> httpx.Response:
        """Check the public Synlora service-health endpoint without credentials."""
        return httpx.get(
            f"{self.config.base_url}/api/health",
            timeout=self._timeout(),
        )

    def verify_delegated_auth(self) -> str:
        """Verify the platform service credential can mint a delegated user token."""
        return self._ensure_delegated_token()

    def verify_personal_token(self) -> httpx.Response:
        """Verify a user-supplied Synlora Bearer token against the current-user API."""
        return httpx.get(
            f"{self.config.base_url}/api/v1/auth/me",
            headers={"Authorization": f"Bearer {self.config.token}"},
            timeout=self._timeout(),
        )

    def create_thread(self, title: str) -> httpx.Response:
        """Create a v1 session; no agent slug is accepted from the browser."""
        return self._request("POST", "/api/v1/sessions", json_body={"title": title})

    def start_run(self, *, query: str, thread_id: str, request_id: str) -> httpx.Response:
        """Start a durable background run and return its JSON response."""
        return self._request(
            "POST",
            f"/api/v1/sessions/{thread_id}/runs",
            json_body={"text": query, "meta": {"request_id": request_id}},
        )

    def get_history(self, thread_id: str, after_seq: int = -1) -> httpx.Response:
        """Read durable session events for replay."""
        return self._request(
            "GET",
            f"/api/v1/sessions/{thread_id}/events",
            params={"after_seq": after_seq},
        )

    def stream_session_events(self, thread_id: str):
        """Context manager yielding live SSE bytes from a Synlora session."""
        headers = {**self._headers(), "Accept": "text/event-stream"}
        return httpx.stream(
            "GET",
            f"{self.config.base_url}/api/v1/sessions/{thread_id}/events",
            headers=headers,
            timeout=self._timeout(stream=True),
        )

    def cancel_run(self, run_id: str) -> httpx.Response:
        return self._request("POST", f"/api/v1/runs/{run_id}/cancel")

    def answer_run(self, run_id: str, text: str) -> httpx.Response:
        """Resolve a pending approval or ask-user interaction."""
        return self._request("POST", f"/api/v1/runs/{run_id}/answer", json_body={"text": text})


def assistant_history_messages(events: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Project durable Synlora events to the assistant's history message shape."""
    messages = []
    for event in events:
        event_type = str(event.get("type") or "")
        payload = event.get("payload") if isinstance(event.get("payload"), dict) else {}
        if event_type == "user/message" and payload.get("text"):
            messages.append({"id": str(event.get("seq")), "role": "user", "content": str(payload["text"])})
        elif event_type == "assistant/message" and payload.get("content"):
            messages.append({"id": str(event.get("seq")), "role": "assistant", "content": str(payload["content"])})
    return messages
