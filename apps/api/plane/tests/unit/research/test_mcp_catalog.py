"""Input-boundary tests for the research read-only tool contract."""

from uuid import uuid4

import pytest

from plane.research.services.mcp_catalog import ResearchReadError, TOOL_NAMES, tools_for, validate_arguments

pytestmark = pytest.mark.unit


@pytest.mark.parametrize("arguments", [
    {"node_id": "not-a-uuid"},
    {"node_id": str(uuid4()), "limit": True},
    {"node_id": str(uuid4()), "limit": 51},
    {"node_id": str(uuid4()), "url": "https://example.com/private"},
    {"node_id": str(uuid4()), "action": "delete"},
])
def test_read_contract_rejects_invalid_or_expanding_arguments(arguments):
    with pytest.raises(ResearchReadError):
        validate_arguments("list_research_node_events", arguments)


def test_scoped_catalogue_cannot_advertise_ungranted_tools():
    from types import SimpleNamespace

    grant = SimpleNamespace(allowed_tools=["get_research_node_context"])
    result = tools_for(grant)
    assert [tool["name"] for tool in result] == ["get_research_node_context"]
    result[0]["inputSchema"]["properties"]["node_id"]["type"] = "object"
    assert tools_for(grant)[0]["inputSchema"]["properties"]["node_id"]["type"] == "string"
    assert len(TOOL_NAMES) == 11
    assert "list_research_report_feedback" in TOOL_NAMES
    assert all(tool["annotations"]["readOnlyHint"] for tool in tools_for())


def test_unknown_writes_are_not_read_tool_aliases():
    with pytest.raises(ResearchReadError):
        validate_arguments("publish_progress", {})
