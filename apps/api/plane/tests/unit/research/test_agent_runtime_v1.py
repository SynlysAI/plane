# Copyright (c) 2023-present Plane Software, Inc. contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Synlora v1 runtime adapter unit tests."""

from types import SimpleNamespace

from plane.research.services import agent_runtime
from plane.research.services.agent_runtime import (
    SynloraRuntimeClient,
    project_synlora_events,
    resolve_synlora_runtime,
)
from plane.research.services.agent_dock_sessions import _project_synlora_replay_event


def test_runtime_uses_verified_personal_api_key_for_plane_user(monkeypatch):
    """有 Plane 用户身份时必须使用个人 yxkey，不能回落全局服务令牌。"""
    workspace = object()
    user = object()
    config = SimpleNamespace(
        base_url="https://synlora.example",
        token="",
        service_token="plane-service-token",
        is_enabled=True,
        timeout_seconds=5,
    )
    binding = SimpleNamespace(
        base_url="https://synlora.example",
        credential_encrypted="encrypted-yxkey",
    )
    monkeypatch.setattr(agent_runtime, "resolve_assistant_config", lambda *_args, **_kwargs: config)
    monkeypatch.setattr(agent_runtime, "decrypt_data", lambda _value: "yxkey_private")
    monkeypatch.setattr(agent_runtime, "ensure_synlora_identity_binding", lambda *_args, **_kwargs: binding)

    runtime = resolve_synlora_runtime(workspace, user=user)

    assert isinstance(runtime, SynloraRuntimeClient)
    assert runtime.workspace is workspace
    assert runtime.user is user
    assert runtime.auth_mode == "PERSONAL_API_KEY"
    assert runtime._headers() == {"Authorization": "Bearer yxkey_private"}


def test_runtime_rejects_plane_user_without_personal_binding(monkeypatch):
    """全局 delegated 服务令牌不能再替代缺失的个人身份绑定。"""
    workspace = object()
    user = object()
    config = SimpleNamespace(
        base_url="https://synlora.example",
        token="",
        service_token="plane-service-token",
        is_enabled=True,
    )
    monkeypatch.setattr(agent_runtime, "resolve_assistant_config", lambda *_args, **_kwargs: config)
    monkeypatch.setattr(agent_runtime, "ensure_synlora_identity_binding", lambda *_args, **_kwargs: None)

    assert resolve_synlora_runtime(workspace, user=user) is None


def test_runtime_without_delegated_identity_requires_legacy_token(monkeypatch):
    """缺少 Plane 用户身份时仍要求旧式会话 token。"""
    config = SimpleNamespace(
        base_url="https://synlora.example",
        token="",
        service_token="plane-service-token",
        is_enabled=True,
    )
    monkeypatch.setattr(agent_runtime, "resolve_assistant_config", lambda *_args, **_kwargs: config)

    assert resolve_synlora_runtime(object()) is None


def test_projects_synlora_events_with_bounded_user_text_without_reasoning():
    """v1 durable events map to the existing Plane run vocabulary safely."""
    projected = project_synlora_events(
        [
            {"seq": 0, "type": "turn/start", "payload": {"run_id": "run-1"}},
            {"seq": 1, "type": "user/message", "payload": {"text": "secret question"}},
            {"seq": 2, "type": "assistant/reasoning", "payload": {"content": "internal thought"}},
            {
                "seq": 3,
                "type": "tool/call",
                "payload": {"tool_call": {"id": "call-1", "name": "search", "arguments": {"q": "polymer"}}},
            },
            {
                "seq": 4,
                "type": "tool/result",
                "payload": {"tool_call_id": "call-1", "name": "search", "ok": True, "content": "12 results"},
            },
            {"seq": 5, "type": "turn/end", "payload": {}},
        ]
    )

    assert [(item["sequence"], item["event"]["type"]) for item in projected] == [
        (0, "run.started"),
        (1, "user.message"),
        (3, "tool.started"),
        (4, "tool.completed"),
        (5, "run.completed"),
    ]
    assert projected[1]["event"]["content"] == "secret question"
    assert all("internal thought" not in str(item) for item in projected)


def test_projects_approval_and_redacts_sensitive_arguments():
    """审批卡保留操作信息，但常见凭证字段不进入 Plane 事件负载。"""
    projected = project_synlora_events(
        [
            {
                "seq": 7,
                "type": "ask/user",
                "payload": {
                    "kind": "approval",
                    "tool_call_id": "call-secret",
                    "tool": "http.request",
                    "query": "请求执行工具 http.request，是否允许？",
                    "args_preview": '{"api_key":"should-not-appear"}',
                },
            }
        ]
    )

    assert projected[0]["event"]["type"] == "permission.required"
    assert projected[0]["event"]["request"]["id"] == "call-secret"
    assert "should-not-appear" not in str(projected)
    # args_preview originates from Synlora's bounded preview; Plane does not
    # expand it again. Tool/call arguments themselves are recursively redacted.
    redacted = project_synlora_events(
        [
            {
                "seq": 8,
                "type": "tool/call",
                "payload": {
                    "tool_call": {
                        "id": "call-2",
                        "name": "http.request",
                        "arguments": {"api_key": "sk-test", "headers": {"Authorization": "Bearer x"}},
                    }
                },
            }
        ]
    )
    assert redacted[0]["event"]["arguments"] == {
        "api_key": "[REDACTED]",
        "headers": {"Authorization": "[REDACTED]"},
    }


def test_json_replay_normalizes_context_access_and_terminal_events():
    """JSON replay retains context evidence and terminal state from Synlora events."""
    started = _project_synlora_replay_event(
        "tool.started",
        {"name": "file.read", "tool_call_id": "call-1", "arguments": {"file_id": "file-1"}},
    )
    completed = _project_synlora_replay_event(
        "tool.completed",
        {
            "name": "knowledge.read",
            "tool_call_id": "call-2",
            "status": "COMPLETED",
            "context_access": True,
            "resource_id": "kb-1",
            "summary": "Context resource read completed.",
        },
    )
    terminal = _project_synlora_replay_event("run.completed", {"message": {"content": ""}})

    assert started == (
        "context.accessed",
        {
            "name": "file.read",
            "tool_call_id": "call-1",
            "status": "running",
            "context_access": True,
            "resource_id": "file-1",
        },
    )
    assert completed is not None and completed[0] == "context.accessed"
    assert completed[1]["resource_id"] == "kb-1"
    assert terminal == ("run.completed", {"message": {"content": ""}})
