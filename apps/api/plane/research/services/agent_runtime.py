# Copyright (c) 2023-present Plane Software, Inc. contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Synlora v1 Sessions adapter for the research agent workbench.

Plane keeps the browser, Synlora credentials, and Research Context token behind
its BFF. The adapter exchanges a delegated service credential for a short-lived
Synlora user token, starts background runs, and projects Synlora's stable event
stream into the event vocabulary already consumed by Plane's append-only store.
"""

from __future__ import annotations

import json
import time
from typing import Any

import httpx

from plane.app.views.assistant.client import resolve_assistant_config
from plane.db.models import Workspace

DELEGATED_SUBJECT_PREFIX = "plane-ws"


class SynloraRuntimeError(Exception):
    """A fail-closed Synlora runtime error."""

    def __init__(self, code, message, status_code=503):
        super().__init__(message)
        self.code = code
        self.message = message
        self.status_code = status_code


class SynloraRuntimeClient:
    """Minimal stateless client over Synlora ``/api/v1/sessions``."""

    def __init__(self, config, workspace=None, user=None):
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
        """Build a workspace-isolated stable Synlora subject."""
        if self.workspace is None or self.user is None:
            return ""
        return f"{DELEGATED_SUBJECT_PREFIX}-{self.workspace.id}-user-{self.user.id}"

    def _ensure_delegated_token(self) -> str:
        """Exchange the backend service credential for a short-lived user token.

        The returned token is kept only in this request-scoped client and is
        never persisted, logged, or returned to the browser.
        """
        if self._delegated_token and time.time() < self._delegated_expires_at - 300:
            return self._delegated_token
        if self.workspace is None or self.user is None:
            return self.config.token
        service_token = getattr(self.config, "service_token", "") or self.config.token
        subject = self._delegated_subject()
        try:
            response = httpx.post(
                f"{self.config.base_url}/api/v1/research/delegated-token",
                headers={"Authorization": f"Bearer {service_token}"},
                json={
                    "schema_version": "plane-delegated-auth.v1",
                    "account_link_id": f"plane-{self.workspace.id}-{self.user.id}",
                    "workspace_id": str(self.workspace.id),
                    "plane_user_id": str(self.user.id),
                    "external_subject": subject,
                },
                timeout=self.config.timeout_seconds,
            )
        except httpx.HTTPError as exc:
            raise SynloraRuntimeError(
                "synlora_delegation_failed", "Synlora delegated authentication failed.", 502
            ) from exc
        if response.status_code >= 400:
            raise SynloraRuntimeError(
                "synlora_delegation_failed", "Synlora delegated authentication failed.", 502
            )
        payload = response.json()
        token = str(payload.get("token") or "")
        expires_in = int(payload.get("expires_in") or 3600)
        if not token:
            raise SynloraRuntimeError(
                "synlora_delegation_failed", "Synlora returned no delegated token.", 502
            )
        self._delegated_token = token
        self._delegated_expires_at = time.time() + expires_in
        return token

    def _headers(self, context_token: str | None = None) -> dict[str, str]:
        headers = {"Authorization": f"Bearer {self._ensure_delegated_token()}"}
        if context_token:
            headers["X-Research-Context-Token"] = context_token
        return headers

    def create_session(
        self,
        *,
        title: str,
        research_context: dict[str, Any] | None = None,
        context_token: str | None = None,
    ) -> str:
        """Create a Synlora v1 session and bind optional Plane research context."""
        body: dict[str, Any] = {"title": title}
        if research_context is not None:
            body["research_context"] = research_context
        try:
            response = httpx.post(
                f"{self.config.base_url}/api/v1/sessions",
                headers=self._headers(context_token),
                json=body,
                timeout=self.config.timeout_seconds,
            )
        except httpx.HTTPError as exc:
            raise SynloraRuntimeError(
                "synlora_session_failed", "Synlora session creation failed.", 502
            ) from exc
        if response.status_code >= 400:
            raise SynloraRuntimeError(
                "synlora_session_failed", "Synlora session creation failed.", 502
            )
        session_id = response.json().get("_id") or response.json().get("id")
        if not session_id:
            raise SynloraRuntimeError(
                "synlora_session_failed", "Synlora returned no session id.", 502
            )
        return str(session_id)

    def start_run(
        self,
        *,
        thread_id: str,
        content: str,
        request_id: str,
        research_context: dict[str, Any] | None = None,
        context_token: str | None = None,
    ) -> str:
        """Start a background Synlora run and return its stable run id."""
        try:
            response = httpx.post(
                f"{self.config.base_url}/api/v1/sessions/{thread_id}/runs",
                headers=self._headers(context_token),
                json={"text": content, **({"research_context": research_context} if research_context else {})},
                timeout=self.config.timeout_seconds,
            )
        except httpx.HTTPError as exc:
            raise SynloraRuntimeError(
                "synlora_run_failed", "Synlora run submission failed.", 502
            ) from exc
        if response.status_code == 404:
            raise SynloraRuntimeError(
                "synlora_session_not_found", "Synlora session no longer exists.", 404
            )
        if response.status_code >= 400:
            raise SynloraRuntimeError(
                "synlora_run_failed", "Synlora run submission failed.", 502
            )
        run_id = response.json().get("run_id")
        if not run_id:
            raise SynloraRuntimeError("synlora_run_failed", "Synlora returned no run id.", 502)
        return str(run_id)

    def pull_events(self, *, session_id: str, after_seq: int = -1):
        """Read durable session events after a Synlora sequence cursor."""
        try:
            response = httpx.get(
                f"{self.config.base_url}/api/v1/sessions/{session_id}/events",
                headers=self._headers(),
                params={"after_seq": after_seq},
                timeout=self.config.timeout_seconds,
            )
        except httpx.HTTPError as exc:
            raise SynloraRuntimeError(
                "synlora_events_failed", "Synlora event replay failed.", 502
            ) from exc
        if response.status_code >= 400:
            raise SynloraRuntimeError(
                "synlora_events_failed", "Synlora event replay failed.", 502
            )
        events = response.json() if isinstance(response.json(), list) else []
        projected = project_synlora_events(events)
        cursor = max((int(event.get("seq") or 0) for event in events), default=after_seq)
        terminal = None
        if projected:
            terminal = {
                "run.completed": "completed",
                "run.failed": "failed",
                "run.cancelled": "cancelled",
                "permission.required": "interrupted",
            }.get(str(projected[-1]["event"].get("type")))
        return projected, cursor, terminal

    def cancel(self, *, run_id: str):
        """Explicitly cancel one run; closing a Plane panel never calls this."""
        httpx.post(
            f"{self.config.base_url}/api/v1/runs/{run_id}/cancel",
            headers=self._headers(),
            timeout=self.config.timeout_seconds,
        )

    def close_session(self, *, thread_id: str):
        """Best-effort Synlora session delete."""
        httpx.delete(
            f"{self.config.base_url}/api/v1/sessions/{thread_id}",
            headers=self._headers(),
            timeout=self.config.timeout_seconds,
        )

    def answer(self, *, run_id: str, approved: bool):
        """Resolve a pending Synlora approval using its existing answer API."""
        httpx.post(
            f"{self.config.base_url}/api/v1/runs/{run_id}/answer",
            headers=self._headers(),
            json={"text": "允许" if approved else "拒绝"},
            timeout=self.config.timeout_seconds,
        )


def resolve_synlora_runtime(workspace: Workspace, user=None) -> SynloraRuntimeClient | None:
    """Return a configured v1 runtime client, or ``None`` when unavailable."""
    config = resolve_assistant_config(workspace, user=user)
    if not config.base_url or not config.token or not config.is_enabled:
        return None
    return SynloraRuntimeClient(config, workspace=workspace, user=user)


def synlora_research_context(workspace, user, node, grant) -> dict[str, Any]:
    """Build an agent-context.v3 metadata object from a Plane grant."""
    return {
        "schema_version": "agent-context.v3",
        "context_id": str(grant.context_id),
        "context_hash": grant.context_hash,
        "expires_at": grant.expires_at.isoformat(),
        "target": {
            "type": "RESEARCH_CHAIN_NODE",
            "workspace_id": str(workspace.id),
            "workspace_slug": workspace.slug,
            "project_id": str(grant.project_id),
            "research_chain_id": str(node.chain_id),
            "chain_node_id": str(node.id),
        },
        "subject": {
            "plane_user_id": str(user.id),
            "delegated_subject": f"{DELEGATED_SUBJECT_PREFIX}-{workspace.id}-user-{user.id}",
            "scope_kind": grant.scope_kind,
            "scope_source": grant.scope_source,
        },
        "policy": {
            "policy_id": grant.policy_id,
            "policy_hash": grant.policy_hash,
            "policy_version": grant.policy_version,
            "visibility_scope": grant.visibility_scope,
            "allowed_tools": grant.allowed_tools,
            "allowed_plugins": grant.allowed_plugins,
            "allowed_mcp_ids": [],
            "allowed_knowledge_base_ids": grant.allowed_knowledge_base_ids,
            "allowed_file_ids": grant.allowed_file_ids,
        },
    }


def _safe_preview(value: Any, limit: int = 600) -> Any:
    """Redact common credential fields and bound preview sizes."""
    if isinstance(value, dict):
        safe = {}
        for key, item in value.items():
            key_text = str(key).lower()
            sensitive_markers = ("password", "token", "secret", "api_key", "authorization", "cookie")
            if any(marker in key_text for marker in sensitive_markers):
                safe[str(key)] = "[REDACTED]"
            else:
                safe[str(key)] = _safe_preview(item, limit)
        return safe
    if isinstance(value, list):
        return [_safe_preview(item, limit) for item in value[:20]]
    if isinstance(value, str) and len(value) > limit:
        return value[:limit] + "…"
    return value


def _safe_json_preview(value: str) -> str:
    """Redact a JSON argument preview without expanding non-JSON text."""
    try:
        parsed = json.loads(value)
    except (TypeError, json.JSONDecodeError):
        return value[:600]
    return json.dumps(_safe_preview(parsed), ensure_ascii=False)[:600]


def project_synlora_events(events: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Project durable Synlora v1 events onto Plane's existing run vocabulary."""
    projected: list[dict[str, Any]] = []
    for event in events:
        remote_type = str(event.get("type") or "")
        payload = event.get("payload") if isinstance(event.get("payload"), dict) else {}
        seq = int(event.get("seq") or 0)
        shaped_type = ""
        shaped_payload: dict[str, Any] = {}

        if remote_type == "turn/start":
            shaped_type = "run.started"
        elif remote_type == "assistant/message":
            shaped_type = "assistant.snapshot"
            shaped_payload["content"] = str(payload.get("content") or "")
        elif remote_type == "tool/call":
            call = payload.get("tool_call") if isinstance(payload.get("tool_call"), dict) else {}
            shaped_type = "tool.started"
            shaped_payload.update(
                {
                    "name": str(call.get("name") or ""),
                    "tool_call_id": str(call.get("id") or ""),
                    "arguments": _safe_preview(call.get("arguments") or {}),
                }
            )
        elif remote_type == "tool/result":
            shaped_type = "tool.completed"
            shaped_payload.update(
                {
                    "name": str(payload.get("name") or ""),
                    "tool_call_id": str(payload.get("tool_call_id") or ""),
                    "status": "COMPLETED" if payload.get("ok", True) else "FAILED",
                    "summary": str(payload.get("content") or "")[:2000],
                }
            )
            if payload.get("error"):
                shaped_payload["error"] = str(payload.get("error"))
        elif remote_type == "ask/user" and payload.get("kind") == "approval":
            shaped_type = "permission.required"
            shaped_payload.update(
                {
                    "requires_approval": True,
                    "request": {
                        "id": str(payload.get("tool_call_id") or seq),
                        "summary": str(payload.get("query") or "Synlora approval required."),
                        "args_preview": _safe_json_preview(str(payload.get("args_preview") or "")),
                    },
                    "tool_call_id": str(payload.get("tool_call_id") or ""),
                }
            )
        elif remote_type == "file/send":
            shaped_type = "artifact.upserted"
            shaped_payload.update(
                {
                    "summary": str(payload.get("note") or "Synlora artifact generated."),
                    "refs": [{"kind": "file", "id": str(payload.get("file_id") or payload.get("path") or "")}],
                }
            )
        elif remote_type == "error":
            shaped_type = "run.failed"
            shaped_payload["error"] = str(payload.get("message") or payload.get("code") or "Synlora run failed.")
        elif remote_type == "turn/end":
            shaped_type = "run.completed"
            shaped_payload["message"] = {"content": ""}
        elif remote_type == "turn/aborted":
            shaped_type = "run.cancelled"
        else:
            # User text, transient deltas, and finalized reasoning are not exported.
            continue

        projected.append({"sequence": seq, "event": {"type": shaped_type, **shaped_payload}})
    return projected
