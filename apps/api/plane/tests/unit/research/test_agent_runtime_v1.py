# Copyright (c) 2023-present Plane Software, Inc. contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Synlora v1 runtime adapter unit tests."""

from plane.research.services.agent_runtime import project_synlora_events


def test_projects_synlora_events_without_user_text_or_reasoning():
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
        (3, "tool.started"),
        (4, "tool.completed"),
        (5, "run.completed"),
    ]
    assert all("secret question" not in str(item) for item in projected)
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
