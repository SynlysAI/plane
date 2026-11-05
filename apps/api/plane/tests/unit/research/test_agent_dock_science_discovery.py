"""SD Dock 消息边界与现有 HTTP 客户端兼容性测试。"""

import json
from types import SimpleNamespace
from unittest.mock import patch
from uuid import uuid4

import pytest
from django.utils import timezone

from plane.research.services.agent_dock_science_discovery import MAX_CONTEXT_PREFIX_CHARS, build_sd_message
from plane.research.services.agent_dock_events import sd_event_envelope
from plane.research.services.sciencediscovery import ScienceDiscoveryClient

pytestmark = pytest.mark.unit


def test_message_prefix_is_bounded_valid_json_and_redacted():
    """转义膨胀后前缀仍是有效 JSON，并且不包含路由或文本中的凭据。"""
    message = build_sd_message(
        page_context={
            "route": "/lab/research?token=route-secret#fragment",
            "focus": {"title": "authorization=focus-secret"},
            "summary": "password=summary-secret " + "\x01" * 20000,
            "selected_text": "Bearer selection-secret",
            "hash": "page-hash",
        },
        allowed_tools=[],
        content="原始用户问题",
    )
    prefix = message.split("\n", 2)[1]
    assert len(prefix) <= MAX_CONTEXT_PREFIX_CHARS
    parsed = json.loads(prefix)
    assert parsed["page_context_hash"] == "page-hash"
    assert parsed["allowed_tools"] == []
    assert parsed["route"] == "/lab/research"
    assert "-secret" not in message
    assert message.endswith("原始用户问题")


def test_connector_rotation_preserves_other_session_overrides():
    """替换会话设置前先合并 overrides，模型和采样参数不被重置。"""
    client = ScienceDiscoveryClient()
    with patch.object(
        client,
        "_request",
        side_effect=[
            {
                "overrides": {"model": "user-selected", "temperature": 0.2, "enabledConnectorIds": ["old"]},
            },
            {},
        ],
    ) as request:
        client.set_session_connectors(session_id="session", connector_ids=["new"])
    assert request.call_args.kwargs["json_payload"] == {
        "model": "user-selected",
        "temperature": 0.2,
        "enabledConnectorIds": ["new"],
    }


def test_project_reuse_is_by_exact_workspace_name():
    """已有同名 project 时复用远端 ID。"""
    client = ScienceDiscoveryClient()
    with patch.object(client, "_request", return_value=[{"name": "Plane Dock · Lab", "id": "project"}]) as request:
        assert client.ensure_project(name="Plane Dock · Lab") == "project"
    request.assert_called_once_with("GET", "/api/projects")


def test_connector_discovery_accepts_explicit_expected_tool_set():
    """connector 工具校验使用调用者传入的集合，旧默认行为仍由既有测试覆盖。"""
    client = ScienceDiscoveryClient()
    grant = SimpleNamespace(context_id=uuid4(), expires_at=timezone.now(), context_hash="hash", allowed_tools=["old"])
    with patch.object(
        client,
        "_request",
        side_effect=[
            [],
            {"id": "custom-444444444444"},
            {
                "id": "custom-444444444444",
                "sourceId": "custom-444444444444",
                "status": "ready",
                "tools": [{"name": "dock-read"}],
            },
        ],
    ):
        binding = client.create_research_connector(
            workspace=SimpleNamespace(id=uuid4()),
            user=SimpleNamespace(id=uuid4()),
            grant=grant,
            token="secret",
            url="https://plane.test/mcp/",
            expected_tools={"dock-read"},
        )
    assert binding["server_id"] == "custom-444444444444"


def test_tool_output_without_trace_keeps_tool_identity_and_chunk():
    """SD 的无 trace 输出仍可合并到对应工具调用。"""
    envelope = sd_event_envelope(
        SimpleNamespace(
            payload={"remote_type": "tool.output", "remote_seq": 7, "toolCallId": "tool-42", "chunk": "计算中"},
            event_type="TOOL_CALL",
            run_id=uuid4(),
            seq=12,
            request_id="event-7",
            created_at=timezone.now(),
        )
    )
    assert envelope["event_type"] == "tool.output"
    assert envelope["payload"]["tool_call_id"] == "tool-42"
    assert envelope["payload"]["result"] == "计算中"
