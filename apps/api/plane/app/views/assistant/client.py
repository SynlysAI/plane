# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Backend-only client for the Synlora (Yuxi) agent Run API.

The service token never leaves the backend: the browser talks to the Plane BFF
endpoints, which inject the workspace connection credential server-side.
"""

from dataclasses import dataclass

import httpx
from django.conf import settings

from plane.db.models import ExternalSystemConnection, IntegrationSystem


class AssistantNotConfigured(Exception):
    """The workspace has no usable Synlora connection (shared credential)."""


@dataclass
class AssistantConfig:
    base_url: str
    token: str
    agent_slug: str
    timeout_seconds: float
    stream_read_timeout_seconds: float
    credential_mode: str
    is_enabled: bool


def resolve_assistant_config(workspace, user=None) -> AssistantConfig:
    """Resolve the Synlora connection for a workspace (and optional member).

    SHARED mode reads the stored shared credential. PERSONAL mode reads the
    requesting member's own connection from the user-level agent backend
    store (``ResearchAgentBackendConnection`` with ``system=SYNLORA``); its
    base URL overrides the platform address when provided.
    """
    connection = (
        ExternalSystemConnection.objects.filter(
            workspace=workspace,
            system=IntegrationSystem.SYNLORA,
            deleted_at__isnull=True,
        ).first()
    )
    base_url = (getattr(connection, "base_url", "") or settings.SYNLORA_BASE_URL or "").rstrip("/")
    token = ""
    credential_mode = ExternalSystemConnection.CredentialMode.SHARED
    is_enabled = connection is not None and connection.is_enabled
    if connection is not None:
        credential_mode = connection.credential_mode
        if credential_mode == ExternalSystemConnection.CredentialMode.SHARED:
            token = connection.get_credential()
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
                .order_by("-created_at")
                .first()
            )
            if personal is not None:
                token = decrypt_data(personal.credential_encrypted)
                if personal.base_url:
                    base_url = personal.base_url.rstrip("/")
    return AssistantConfig(
        base_url=base_url,
        token=token,
        agent_slug=settings.SYNLORA_AGENT_SLUG,
        timeout_seconds=float(settings.SYNLORA_TIMEOUT_SECONDS),
        stream_read_timeout_seconds=float(settings.SYNLORA_STREAM_READ_TIMEOUT_SECONDS),
        credential_mode=credential_mode,
        is_enabled=is_enabled,
    )


def resolve_assistant_client(workspace, user=None) -> "SynloraAssistantClient":
    """Return a ready client or raise AssistantNotConfigured."""
    config = resolve_assistant_config(workspace, user=user)
    if not config.base_url or not config.token or not config.is_enabled:
        raise AssistantNotConfigured
    return SynloraAssistantClient(config)


class SynloraAssistantClient:
    """Minimal sync client over the Synlora Run API used by the assistant BFF."""

    def __init__(self, config: AssistantConfig):
        self.config = config
        self._headers = {"Authorization": f"Bearer {config.token}"}

    # ------------------------------------------------------------------
    # transport helpers
    # ------------------------------------------------------------------
    def _timeout(self, stream: bool = False) -> httpx.Timeout:
        read = self.config.stream_read_timeout_seconds if stream else self.config.timeout_seconds
        return httpx.Timeout(
            connect=self.config.timeout_seconds,
            read=read,
            write=self.config.timeout_seconds,
            pool=self.config.timeout_seconds,
        )

    def _request(self, method: str, path: str, *, json=None, params=None) -> httpx.Response:
        return httpx.request(
            method,
            f"{self.config.base_url}{path}",
            headers=self._headers,
            json=json,
            params=params,
            timeout=self._timeout(),
        )

    # ------------------------------------------------------------------
    # Synlora Run API surface
    # ------------------------------------------------------------------
    def health(self) -> httpx.Response:
        return httpx.get(
            f"{self.config.base_url}/api/system/ready",
            headers=self._headers,
            timeout=self._timeout(),
        )

    def create_thread(self, title: str) -> httpx.Response:
        return self._request(
            "POST",
            "/api/chat/thread",
            json={"agent_id": self.config.agent_slug, "title": title},
        )

    def start_run(self, *, query: str, thread_id: str, request_id: str) -> httpx.Response:
        return self._request(
            "POST",
            "/api/agent/runs",
            json={
                "query": query,
                "agent_slug": self.config.agent_slug,
                "thread_id": thread_id,
                "queue_policy": "enqueue",
                "meta": {"request_id": request_id},
            },
        )

    def stream_run_events(self, run_id: str, last_event_id: str | None = None):
        """Context manager yielding raw SSE byte chunks from a run stream."""
        headers = dict(self._headers)
        headers["Accept"] = "text/event-stream"
        if last_event_id:
            headers["Last-Event-ID"] = last_event_id
        return httpx.stream(
            "GET",
            f"{self.config.base_url}/api/agent/runs/{run_id}/events",
            params={"verbose": "false"},
            headers=headers,
            timeout=self._timeout(stream=True),
        )

    def get_result(self, run_id: str) -> httpx.Response:
        return self._request("GET", f"/api/agent/runs/{run_id}/result")

    def cancel_run(self, run_id: str) -> httpx.Response:
        return self._request("POST", f"/api/agent/runs/{run_id}/cancel")

    def get_history(self, thread_id: str) -> httpx.Response:
        return self._request("GET", f"/api/chat/thread/{thread_id}/history")
