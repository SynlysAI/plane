"""The implemented read contract stays aligned with the frozen phase-1 inputs."""

import json
from pathlib import Path

import pytest

from plane.mcp.catalog import CREATE_SCHEMA, SCHEMAS, matches, validate
from plane.research.services.mcp_catalog import ResearchReadError

pytestmark = pytest.mark.unit


def test_frozen_read_inputs_and_connection_schema_match_the_implementation():
    contract = json.loads(
        (Path(__file__).resolve().parents[6] / "docs/plans/unified-mcp-v1.schemas.json").read_text(encoding="utf-8")
    )
    assert CREATE_SCHEMA == contract["connection_create_schema"]
    for tool in contract["tools"]:
        if tool["name"] in SCHEMAS:
            expected = tool["inputSchema"]
            assert SCHEMAS[tool["name"]] == expected
    for example in contract["valid_examples"]:
        if example["tool"] in SCHEMAS:
            validate(example["tool"], example["arguments"])
    for example in contract["invalid_examples"]:
        if example["tool"] in SCHEMAS:
            with pytest.raises(ResearchReadError):
                validate(example["tool"], example["arguments"])


def test_bools_unknown_fields_and_missing_future_semantics_are_rejected():
    assert not matches(SCHEMAS["plane_list_workspaces"], {"limit": True})
    assert not matches(SCHEMAS["plane_list_workspaces"], {"arbitrary_sql": "SELECT 1"})
    assert not matches(CREATE_SCHEMA, {"name": "Connection", "workspaces": []})


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
