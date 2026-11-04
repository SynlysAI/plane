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
from typing import Any, Iterator

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
        if not self.config.service_token:
            raise SynloraRuntimeError(
                "synlora_service_token_missing",
                "Synlora delegated service credential is not configured.",
                503,
            )
        if self.workspace is None or self.user is None:
            return self.config.token
        service_token = self.config.service_token
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
                    "subject_username": str(getattr(self.user, "username", "") or ""),
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

    @staticmethod
    def _runtime_headers(context_token: str | None, mcp_token: str | None) -> dict[str, str]:
        """Build scoped runtime headers without copying delegated credentials."""
        headers: dict[str, str] = {}
        if context_token:
            headers["X-Research-Context-Token"] = context_token
        if mcp_token:
            headers["X-Plane-MCP-Token"] = mcp_token
        return headers

    def create_session(
        self,
        *,
        title: str,
        research_context: dict[str, Any] | None = None,
        context_token: str | None = None,
        plane_mcp: dict[str, Any] | None = None,
        mcp_token: str | None = None,
    ) -> str:
        """Create a Synlora v1 session and bind optional Plane research context."""
        body: dict[str, Any] = {"title": title}
        if research_context is not None:
            body["research_context"] = research_context
        if plane_mcp is not None:
            body["plane_mcp"] = plane_mcp
        try:
            response = httpx.post(
                f"{self.config.base_url}/api/v1/sessions",
                headers={**self._headers(), **self._runtime_headers(context_token, mcp_token)},
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
        plane_mcp: dict[str, Any] | None = None,
        mcp_token: str | None = None,
        page_context: dict[str, Any] | None = None,
        external_run_id: str = "",
    ) -> str:
        """Start a background Synlora run and return its stable run id."""
        try:
            response = httpx.post(
                f"{self.config.base_url}/api/v1/sessions/{thread_id}/runs",
                headers={**self._headers(), **self._runtime_headers(context_token, mcp_token)},
                json={
                    "text": content,
                    **({"research_context": research_context} if research_context else {}),
                    **({"plane_mcp": plane_mcp} if plane_mcp else {}),
                    **({"page_context": page_context} if page_context else {}),
                    **({"external_run_id": external_run_id} if external_run_id else {}),
                },
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
        body = response.json()
        events = body if isinstance(body, list) else []
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

    def stream_events(self, *, session_id: str, after_seq: int = -1) -> Iterator[dict[str, Any]]:
        """订阅 Synlora 持久事件 SSE，并逐帧返回原始事件。

        Synlora 负责在注册订阅后先回放 ``after_seq`` 之后的持久事件，随后
        推送实时事件；Plane 只把该迭代器用于 BFF 流式投影，不向浏览器暴露凭证。
        """
        url = f"{self.config.base_url}/api/v1/sessions/{session_id}/events/stream"
        try:
            with httpx.stream(
                "GET",
                url,
                headers={**self._headers(), "Accept": "text/event-stream"},
                params={"after_seq": max(-1, int(after_seq))},
                timeout=self._timeout(stream=True),
            ) as response:
                if response.status_code >= 400:
                    raise SynloraRuntimeError(
                        "synlora_stream_failed", "Synlora event stream failed.", 502
                    )
                event_name = ""
                data_lines: list[str] = []
                frame_id: str | None = None
                for raw_line in response.iter_lines():
                    line = raw_line.decode("utf-8") if isinstance(raw_line, bytes) else raw_line
                    if line == "":
                        if data_lines:
                            try:
                                payload = json.loads("\n".join(data_lines))
                            except json.JSONDecodeError:
                                payload = None
                            if isinstance(payload, dict):
                                payload.setdefault("type", event_name)
                                if frame_id is not None:
                                    payload.setdefault("seq", int(frame_id))
                                yield payload
                        event_name = ""
                        data_lines = []
                        frame_id = None
                        continue
                    if line.startswith(":"):
                        yield {"_heartbeat": True}
                        continue
                    field, _, value = line.partition(":")
                    value = value[1:] if value.startswith(" ") else value
                    if field == "event":
                        event_name = value
                    elif field == "data":
                        data_lines.append(value)
                    elif field == "id":
                        frame_id = value
                # Some proxies close an SSE response without a trailing blank
                # line.  Flush that final frame so a completed answer is not
                # lost during reconnect or graceful upstream shutdown.
                if data_lines:
                    try:
                        payload = json.loads("\n".join(data_lines))
                    except json.JSONDecodeError:
                        payload = None
                    if isinstance(payload, dict):
                        payload.setdefault("type", event_name)
                        if frame_id is not None:
                            payload.setdefault("seq", int(frame_id))
                        yield payload
        except httpx.HTTPError as exc:
            raise SynloraRuntimeError(
                "synlora_stream_failed", "Synlora event stream disconnected.", 502
            ) from exc

    def cancel(self, *, run_id: str):
        """Explicitly cancel one run; closing a Plane panel never calls this."""
        try:
            response = httpx.post(
                f"{self.config.base_url}/api/v1/runs/{run_id}/cancel",
                headers=self._headers(),
                timeout=self.config.timeout_seconds,
            )
        except httpx.HTTPError as exc:
            raise SynloraRuntimeError(
                "synlora_cancel_failed", "Synlora could not cancel the active run.", 502
            ) from exc
        if response.status_code >= 400:
            raise SynloraRuntimeError(
                "synlora_cancel_failed", "Synlora could not cancel the active run.", 502
            )
        try:
            body = response.json()
        except ValueError:
            return True
        return bool(body.get("ok", True)) if isinstance(body, dict) else True

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
    has_delegated_identity = workspace is not None and user is not None
    has_credentials = bool(config.service_token) if has_delegated_identity else bool(config.token)
    if not config.base_url or not has_credentials or not config.is_enabled:
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


def _is_context_access_tool(name: str) -> bool:
    """识别直接读取上下文资源的工具名称。"""
    normalized = name.lower().replace("/", ".")
    return any(
        part in {"list", "read", "context", "knowledge"}
        for part in normalized.split(".")
    )


def synlora_event_run_id(payload: dict[str, Any]) -> str:
    """提取 Synlora 事件关联的远端运行标识。"""
    return str(payload.get("run_id") or payload.get("runId") or "")


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
            shaped_payload["remote_run_id"] = synlora_event_run_id(payload)
        elif remote_type == "llm/delta":
            shaped_type = "assistant.delta"
            shaped_payload["content"] = str(payload.get("text") or "")
        elif remote_type == "reasoning/delta":
            shaped_type = "assistant.thinking.delta"
            shaped_payload["reasoning"] = str(payload.get("text") or "")
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
            name = str(payload.get("name") or "")
            context_access = _is_context_access_tool(name)
            shaped_type = "tool.completed"
            shaped_payload.update(
                {
                    "name": name,
                    "tool_call_id": str(payload.get("tool_call_id") or ""),
                    "status": "COMPLETED" if payload.get("ok", True) else "FAILED",
                    "summary": (
                        "Context resource read completed."
                        if context_access and payload.get("ok", True)
                        else "Context resource read failed."
                        if context_access
                        else str(payload.get("content") or "")[:2000]
                    ),
                    **({"context_access": True} if context_access else {}),
                }
            )
            if context_access:
                resource_id = payload.get("resource_id") or payload.get("file_id") or ""
                if resource_id:
                    shaped_payload["resource_id"] = str(resource_id)
            if payload.get("error"):
                shaped_payload["error"] = str(payload.get("error"))
        elif remote_type == "ask/user" and payload.get("kind") == "approval":
            shaped_type = "permission.required"
            shaped_payload.update(
                {
                    "requires_approval": True,
                    "tool": str(payload.get("tool") or "tool"),
                    "args_preview": _safe_json_preview(str(payload.get("args_preview") or "")),
                    "request": {
                        "id": str(payload.get("tool_call_id") or seq),
                        "summary": str(payload.get("query") or "Synlora approval required."),
                        "args_preview": _safe_json_preview(str(payload.get("args_preview") or "")),
                    },
                    "tool_call_id": str(payload.get("tool_call_id") or ""),
                }
            )
        elif remote_type == "ask/user":
            shaped_type = "agent.phase"
            shaped_payload["phase"] = "waiting_user"
            shaped_payload["summary"] = str(payload.get("query") or "Synlora is waiting for input.")
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

        remote_run_id = synlora_event_run_id(payload)
        if remote_run_id and "remote_run_id" not in shaped_payload:
            shaped_payload["remote_run_id"] = remote_run_id
        projected.append({"sequence": seq, "event": {"type": shaped_type, **shaped_payload}})
    return projected


def project_synlora_stream_event(
    event: dict[str, Any], *, run_id: str, created_at: str
) -> dict[str, Any] | None:
    """将一个 Synlora SSE 事件封装为 Plane Agent Dock 事件。

    ``source_seq`` 始终沿用 Synlora 会话事件序号，瞬态 delta 也使用该序号，
    浏览器因此可以在重连时用同一游标去重；Plane 本地 ``seq`` 只作为兼容字段。
    """
    remote_type = str(event.get("type") or "")
    payload = event.get("payload") if isinstance(event.get("payload"), dict) else {}
    source_seq = int(event.get("seq") or 0)
    remote_run_id = synlora_event_run_id(payload)
    shaped_payload = {"remote_run_id": remote_run_id} if remote_type == "turn/start" else _safe_preview(payload)
    event_type = {
        "turn/start": "run.started",
        "llm/delta": "output.delta",
        "reasoning/delta": "output.delta",
        "assistant/reasoning": "output.delta",
        "assistant/message": "output.delta",
        "tool/call": "tool.started",
        "tool/result": "tool.completed",
        "file/send": "tool.completed",
        "turn/end": "run.completed",
        "turn/aborted": "run.cancelled",
        "error": "run.failed",
    }.get(remote_type)
    if remote_type == "ask/user":
        event_type = "approval.required" if payload.get("kind") == "approval" else "run.progress"
    if event_type is None:
        return None

    if remote_type == "llm/delta":
        shaped_payload = {"content": str(payload.get("text") or ""), "delta": True}
    elif remote_type == "reasoning/delta":
        event_type = "run.progress"
        shaped_payload = {"phase": "thinking"}
    elif remote_type == "assistant/reasoning":
        event_type = "run.progress"
        shaped_payload = {"phase": "thinking"}
    elif remote_type == "assistant/message":
        shaped_payload = {"content": str(payload.get("content") or ""), "final": True}
    elif remote_type == "tool/call":
        call = payload.get("tool_call") if isinstance(payload.get("tool_call"), dict) else payload
        tool_name = str(call.get("name") or "tool")
        arguments = call.get("arguments") if isinstance(call.get("arguments"), dict) else {}
        shaped_payload = {
            "name": tool_name,
            "tool_call_id": str(call.get("id") or ""),
            "arguments": _safe_preview(arguments),
            "context_access": _is_context_access_tool(tool_name),
        }
        if shaped_payload["context_access"]:
            event_type = "context.accessed"
            shaped_payload["status"] = "running"
            resource_id = next(
                (
                    str(arguments[key])
                    for key in ("resource_id", "file_id", "knowledge_base_id", "kb_id")
                    if arguments.get(key)
                ),
                "",
            )
            if resource_id:
                shaped_payload["resource_id"] = resource_id
    elif remote_type == "tool/result":
        name = str(payload.get("name") or "tool")
        context_access = _is_context_access_tool(name)
        shaped_payload = {
            "name": name,
            "tool_call_id": str(payload.get("tool_call_id") or ""),
            "status": "completed" if payload.get("ok", True) else "failed",
            "context_access": context_access,
        }
        if context_access:
            # Access evidence records outcome and identity only; tool output may
            # contain the full body of a Plane file or knowledge resource.
            shaped_payload["resource_id"] = str(payload.get("resource_id") or payload.get("file_id") or "")
            event_type = "context.accessed"
        else:
            shaped_payload["result"] = _safe_preview(payload.get("content") or payload.get("data") or "")
    elif remote_type == "file/send":
        shaped_payload = {
            "name": "file/send",
            "status": "completed",
            "result": str(payload.get("note") or "Artifact created."),
            "resource_id": str(payload.get("file_id") or payload.get("path") or ""),
        }
    elif remote_type == "ask/user":
        shaped_payload = {
            "kind": str(payload.get("kind") or "question"),
            "summary": str(payload.get("query") or "Synlora is waiting for input."),
            "tool_call_id": str(payload.get("tool_call_id") or ""),
        }
        if payload.get("kind") == "approval":
            shaped_payload.update(
                {
                    "tool": str(payload.get("tool") or "tool"),
                    "args_preview": _safe_json_preview(str(payload.get("args_preview") or "")),
                    "query": str(payload.get("query") or ""),
                }
            )
        else:
            shaped_payload = {"phase": "waiting_user"}
    elif remote_type == "error":
        shaped_payload = {"error": str(payload.get("message") or payload.get("code") or "Synlora run failed.")}
    elif remote_type == "turn/end":
        shaped_payload = {"status": "completed"}
    elif remote_type == "turn/aborted":
        shaped_payload = {"reason": str(payload.get("reason") or "cancelled")}

    if remote_run_id and "remote_run_id" not in shaped_payload:
        shaped_payload["remote_run_id"] = remote_run_id

    return {
        "schema_version": "agent-dock-event.v1",
        "run_id": run_id,
        "seq": source_seq,
        "source_seq": source_seq,
        "created_at": created_at,
        "event_type": event_type,
        "raw_event_type": remote_type,
        "payload": shaped_payload,
    }
