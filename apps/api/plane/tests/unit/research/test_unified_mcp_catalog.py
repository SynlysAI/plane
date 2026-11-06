"""The implemented read contract stays aligned with the frozen phase-1 inputs."""

import json
from copy import deepcopy
from pathlib import Path
from types import SimpleNamespace

import pytest

from plane.mcp.catalog import CREATE_SCHEMA, READ_TOOL_NAMES, SCHEMAS, matches, tools_for, validate
from plane.mcp.schema_compat import project_schema
from plane.research.services.mcp_catalog import ResearchReadError

pytestmark = pytest.mark.unit


def test_frozen_read_inputs_and_connection_schema_match_the_implementation():
    """保留冻结 v1 契约，并仅允许新增两种附件资源枚举。"""
    contract = json.loads(
        (Path(__file__).resolve().parents[6] / "docs/plans/unified-mcp-v1.schemas.json").read_text(encoding="utf-8")
    )
    assert CREATE_SCHEMA == contract["connection_create_schema"]
    for tool in contract["tools"]:
        if tool["name"] in READ_TOOL_NAMES:
            expected = tool["inputSchema"]
            current = deepcopy(SCHEMAS[tool["name"]])

            def without_new_attachment_kinds(value):
                """仅移除新增附件枚举，以验证历史请求边界没有其他漂移。

                Args:
                    value: 当前输入 Schema 的任一节点。
                """
                if isinstance(value, dict):
                    if "enum" in value:
                        value["enum"] = [
                            item for item in value["enum"]
                            if item not in {"task_attachment", "task_comment_attachment"}
                        ]
                    for child in value.values():
                        without_new_attachment_kinds(child)
                elif isinstance(value, list):
                    for child in value:
                        without_new_attachment_kinds(child)

            without_new_attachment_kinds(current)
            assert current == expected
    for example in contract["valid_examples"]:
        if example["tool"] in READ_TOOL_NAMES:
            validate(example["tool"], example["arguments"])
    for example in contract["invalid_examples"]:
        if example["tool"] in READ_TOOL_NAMES:
            with pytest.raises(ResearchReadError):
                validate(example["tool"], example["arguments"])


def test_bools_unknown_fields_and_missing_future_semantics_are_rejected():
    assert not matches(SCHEMAS["plane_list_workspaces"], {"limit": True})
    assert not matches(SCHEMAS["plane_list_workspaces"], {"arbitrary_sql": "SELECT 1"})
    assert not matches(CREATE_SCHEMA, {"name": "Connection", "workspaces": []})


@pytest.mark.parametrize("tool", ["plane_get_context", "plane_read_resource"])
def test_research_content_examples_match_incremental_read_schema(tool):
    """代码内示例可直接通过当前输入校验。"""
    from plane.mcp.api_documentation import UNIFIED_EXAMPLES

    validate(tool, UNIFIED_EXAMPLES[tool])


def test_full_catalogue_is_complete_client_safe_and_still_strictly_validated():
    """最大授权一次性暴露全部工具，但对外 Schema 不改变内部严格校验。"""
    connection = SimpleNamespace(
        scope={"workspaces": [{"domains": {"administrative": "read_write", "research": "read_write"}}]}
    )
    tools = tools_for(connection)
    assert {tool["name"] for tool in tools} == set(SCHEMAS)

    def schemas(value):
        if isinstance(value, dict):
            yield value
            for item in value.values():
                yield from schemas(item)
        elif isinstance(value, list):
            for item in value:
                yield from schemas(item)

    assert not [
        (tool["name"], key)
        for tool in tools
        for schema in schemas(tool["inputSchema"])
        for key in ("anyOf", "oneOf", "const")
        if key in schema
    ]
    assert not [
        schema["type"]
        for tool in tools
        for schema in schemas(tool["inputSchema"])
        if isinstance(schema.get("type"), list)
    ]
    target = project_schema(SCHEMAS["plane_get_context"])["properties"]["target"]
    assert "id" not in target["required"] and "url" not in target["required"]
    assert "Choose one supported branch" in target["description"]
    assert "description" not in project_schema(SCHEMAS["plane_list_workspaces"])
    due_at = project_schema(SCHEMAS["plane_update_task"])["properties"]["changes"]["properties"]["due_at"]
    assert "type" not in due_at and "nullable" not in due_at
    assert "A null value is allowed." in due_at["description"]
    projected_conflict = project_schema(
        {
            "anyOf": [
                {
                    "type": "object",
                    "description": "First input.",
                    "properties": {"value": {"type": "string", "pattern": "^a", "minLength": 1}},
                    "required": ["value"],
                    "additionalProperties": False,
                },
                {
                    "type": "object",
                    "description": "Second input.",
                    "properties": {"value": {"type": "integer", "pattern": "^b"}, "other": {"type": "string"}},
                    "required": ["other"],
                    "additionalProperties": False,
                },
            ]
        }
    )
    assert "type" not in projected_conflict["properties"]["value"]
    assert "pattern" not in projected_conflict["properties"]["value"]
    assert "minLength" not in projected_conflict["properties"]["value"]
    assert "First input. Second input." in projected_conflict["description"]
    assert "Choose one supported branch" in projected_conflict["description"]
    with pytest.raises(ResearchReadError):
        validate(
            "plane_get_context",
            {
                "target": {"domain": "administrative", "workspace_slug": "public", "object_type": "Issue"},
                "section": "details",
            },
        )
    with pytest.raises(ResearchReadError):
        validate("plane_list_workspaces", {"unexpected": True})


@pytest.mark.parametrize("path", ["/api/mcp/", "/api/mcp/connections/", "/api/mcp/connections/any/revoke/"])
def test_unified_credentials_and_tool_content_do_not_enter_api_token_body_logs(path, rf):
    from unittest.mock import patch

    from django.http import HttpResponse

    from plane.middleware.logger import APITokenLogMiddleware

    request = rf.post(
        path, data='{"secret":"test-only-canary"}', content_type="application/json", HTTP_X_API_KEY="unrelated-test-key"
    )
    with patch("plane.middleware.logger.process_logs") as process_logs:
        APITokenLogMiddleware(lambda request: None).process_request(
            request, HttpResponse(b'{"secret":"test-only-canary"}'), request.body
        )
        process_logs.delay.assert_not_called()
