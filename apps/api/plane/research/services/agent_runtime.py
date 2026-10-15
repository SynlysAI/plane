# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Synlora (Yuxi) Run API adapter for the research agent workbench.

The workbench speaks one event vocabulary — the ScienceDiscovery run-stream
contract (``assistant.delta`` / ``run.completed`` / ``permission.required`` …).
This adapter drives the cloud Synlora runtime and translates its SSE frames
into that same vocabulary, so projection, session-status convergence and the
frontend message merge stay provider-agnostic.

Credentials come from the workspace integration connection (shared mode);
the token never leaves the backend.
"""

import json
import time

import httpx

from plane.app.views.assistant.client import resolve_assistant_config
from plane.db.models import Workspace

# How long one polling pull may read from the Synlora SSE stream before
# returning the batch to the caller (the workbench polls again).
PULL_BUDGET_SECONDS = 1.5


class SynloraRuntimeError(Exception):
    """A fail-closed Synlora runtime error, mirroring ScienceDiscoveryError."""

    def __init__(self, code, message, status_code=503):
        super().__init__(message)
        self.code = code
        self.message = message
        self.status_code = status_code


class SynloraRuntimeClient:
    """Minimal Run API client producing SD-shaped events."""

    def __init__(self, config):
        self.config = config
        self._headers = {"Authorization": f"Bearer {config.token}"}

    # ------------------------------------------------------------------
    # run lifecycle
    # ------------------------------------------------------------------
    def create_session(self, *, title):
        response = httpx.post(
            f"{self.config.base_url}/api/chat/thread",
            headers=self._headers,
            json={"agent_id": self.config.agent_slug, "title": title},
            timeout=self.config.timeout_seconds,
        )
        if response.status_code >= 400:
            raise SynloraRuntimeError("synlora_thread_failed", "Synlora thread creation failed.", 502)
        thread_id = response.json().get("id") or response.json().get("_id") or ""
        if not thread_id:
            raise SynloraRuntimeError("synlora_thread_failed", "Synlora returned no thread id.", 502)
        return str(thread_id)

    def start_run(self, *, thread_id, content, request_id):
        response = httpx.post(
            f"{self.config.base_url}/api/agent/runs",
            headers=self._headers,
            json={
                "query": content,
                "agent_slug": self.config.agent_slug,
                "thread_id": thread_id,
                "queue_policy": "enqueue",
                "meta": {"request_id": request_id},
            },
            timeout=self.config.timeout_seconds,
        )
        if response.status_code == 404:
            raise SynloraRuntimeError("synlora_thread_not_found", "Synlora thread no longer exists.", 404)
        if response.status_code >= 400:
            raise SynloraRuntimeError("synlora_run_failed", "Synlora run submission failed.", 502)
        run_id = response.json().get("run_id") or ""
        if not run_id:
            raise SynloraRuntimeError("synlora_run_failed", "Synlora returned no run id.", 502)
        return str(run_id)

    def cancel(self, *, run_id):
        httpx.post(
            f"{self.config.base_url}/api/agent/runs/{run_id}/cancel",
            headers=self._headers,
            timeout=self.config.timeout_seconds,
        )

    def close_session(self, *, thread_id):
        """Best-effort thread delete; closing stays fail-open in the caller."""
        httpx.delete(
            f"{self.config.base_url}/api/chat/thread/{thread_id}",
            headers=self._headers,
            timeout=self.config.timeout_seconds,
        )

    def resume(self, *, run_id, approved, request_id):
        """Resume an interrupted run with one approval decision."""
        httpx.post(
            f"{self.config.base_url}/api/agent/runs",
            headers=self._headers,
            json={
                "agent_slug": self.config.agent_slug,
                "resume": {"decisions": [{"type": "approve" if approved else "reject"}]},
                "meta": {"request_id": request_id},
            },
            timeout=self.config.timeout_seconds,
        )

    # ------------------------------------------------------------------
    # event stream: Synlora SSE frames -> SD-shaped run-stream events
    # ------------------------------------------------------------------
    def pull_events(self, *, run_id, last_event_id=None, sequence_base=0, budget_seconds=PULL_BUDGET_SECONDS):
        """Read the run SSE stream for a bounded budget.

        Returns ``(events, last_event_id, terminal)`` where ``events`` are
        SD-shaped ``{"sequence": int, "event": {type, ...}}`` entries with
        globally increasing sequences (callers pass the last ``remote_seq``),
        ``last_event_id`` is the Synlora cursor for the next pull, and
        ``terminal`` is one of ``completed|failed|cancelled|interrupted``
        or ``None`` while the run continues.
        """
        headers = dict(self._headers)
        headers["Accept"] = "text/event-stream"
        if last_event_id:
            headers["Last-Event-ID"] = last_event_id
        events: list[dict] = []
        sequence = sequence_base
        terminal = None
        cursor = last_event_id
        deadline = time.monotonic() + budget_seconds
        try:
            with httpx.stream(
                "GET",
                f"{self.config.base_url}/api/agent/runs/{run_id}/events",
                params={"verbose": "false"},
                headers=headers,
                timeout=httpx.Timeout(
                    connect=self.config.timeout_seconds,
                    read=budget_seconds + 0.5,
                    write=self.config.timeout_seconds,
                    pool=self.config.timeout_seconds,
                ),
            ) as stream:
                for frame in _iter_sse_frames(stream, deadline):
                    cursor = frame.get("id") or cursor
                    for shaped in _translate_frame(frame, sequence):
                        sequence += 1
                        events.append({"sequence": sequence, "event": shaped})
                        event_type = shaped.get("type")
                        if event_type == "run.completed":
                            terminal = "completed"
                        elif event_type == "run.failed":
                            terminal = "failed"
                        elif event_type == "run.cancelled":
                            terminal = "cancelled"
                        elif event_type == "permission.required":
                            terminal = "interrupted"
                    if terminal is not None:
                        break
        except (httpx.HTTPError, OSError):
            # the cursor keeps the next pull resumable; surfaced as empty batch
            pass
        return events, cursor, terminal


def resolve_synlora_runtime(workspace: Workspace, user=None) -> SynloraRuntimeClient | None:
    """Return a configured runtime client, or ``None`` when unavailable."""
    config = resolve_assistant_config(workspace, user=user)
    if not config.base_url or not config.token or not config.is_enabled:
        return None
    return SynloraRuntimeClient(config)


# ----------------------------------------------------------------------
# SSE parsing and frame translation (pure helpers)
# ----------------------------------------------------------------------
def _iter_sse_frames(stream, deadline):
    """Yield parsed ``{event, data, id}`` frames from an SSE byte stream."""
    buffer = ""
    current = {"event": None, "data": [], "id": None}
    for chunk in stream.iter_text():
        buffer += chunk
        while "\n" in buffer:
            line, buffer = buffer.split("\n", 1)
            line = line.rstrip("\r")
            if line == "":
                if current["data"]:
                    yield {
                        "event": current["event"],
                        "data": "\n".join(current["data"]),
                        "id": current["id"],
                    }
                current = {"event": None, "data": [], "id": None}
            elif line.startswith(":"):
                continue
            elif time.monotonic() > deadline:
                return
            else:
                field, _, value = line.partition(":")
                value = value[1:] if value.startswith(" ") else value
                if field == "event":
                    current["event"] = value
                elif field == "data":
                    current["data"].append(value)
                elif field == "id":
                    current["id"] = value


def _translate_frame(frame, base_sequence):
    """Map one Synlora SSE frame onto SD-shaped event dicts (without sequence)."""
    event_type = frame.get("event")
    try:
        data = json.loads(frame.get("data") or "{}")
    except json.JSONDecodeError:
        return []
    payload = data.get("payload") or {}
    shaped: list[dict] = []

    if event_type == "messages":
        items = list(payload.get("items") or [])
        if payload.get("chunk"):
            items.append(payload["chunk"])
        for item in items:
            stream_event = (item or {}).get("stream_event") or {}
            if stream_event.get("type") != "message_delta":
                continue
            if stream_event.get("content"):
                shaped.append({"type": "assistant.delta", "delta": stream_event["content"]})
            if stream_event.get("reasoning_content"):
                shaped.append({"type": "assistant.thinking.delta", "delta": stream_event["reasoning_content"]})
            tool_name = stream_event.get("name")
            if stream_event.get("type") in ("tool_call", "tool_call_delta") and tool_name:
                shaped.append({"type": "tool.started", "name": str(tool_name)})
    elif event_type == "custom":
        name = str(payload.get("name") or "")
        if name:
            shaped.append({"type": "agent.phase", "phase": name})
    elif event_type == "interrupt":
        shaped.append(
            {
                "type": "permission.required",
                "request": {
                    "id": str(frame.get("id") or f"interrupt:{base_sequence}"),
                    "summary": str(payload.get("reason") or "Synlora approval required."),
                },
            }
        )
    elif event_type == "error":
        shaped.append({"type": "run.failed", "error": str(payload.get("error") or "Synlora run failed.")})
    elif event_type == "end":
        status = str(payload.get("status") or "completed")
        if status == "failed":
            shaped.append({"type": "run.failed", "error": "Synlora run failed."})
        elif status == "cancelled":
            shaped.append({"type": "run.cancelled"})
        else:
            shaped.append({"type": "run.completed", "message": {"content": ""}})
    return shaped
