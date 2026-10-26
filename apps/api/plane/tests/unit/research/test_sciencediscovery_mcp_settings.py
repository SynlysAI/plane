"""Plane's external MCP and SD's connector registration are independent."""

from types import SimpleNamespace
from unittest.mock import Mock, patch
from uuid import uuid4

import pytest

from plane.research.services.agent_orchestrator import AgentAssembly, create_science_discovery_session
from plane.research.services.mcp_catalog import TOOL_NAMES
from plane.research.services.sciencediscovery import ScienceDiscoveryError

pytestmark = pytest.mark.unit


@pytest.fixture
def sd_session():
    profile = SimpleNamespace(project_id=uuid4(), project=SimpleNamespace(name="Research"))
    node = SimpleNamespace(
        id=uuid4(),
        title="Node",
        node_type="GENERAL_RESEARCH",
        chain=SimpleNamespace(project=SimpleNamespace(research_profile=profile)),
    )
    assembly = AgentAssembly(
        persona="research-general",
        enabled_plugins=[],
        allowed_tools=[],
        allowed_knowledge_base_ids=[],
        allowed_file_ids=[],
        unavailable_reasons=["policy_blocked"],
        policy_id="node-policy",
    )
    grant = Mock(revoked_at=None)
    client = Mock(configured=True)
    client.create_project.return_value = "project"
    client.create_session.return_value = "session"
    binding = {"server_id": "custom-111111111111", "source_id": "custom-111111111111"}
    client.create_research_connector.return_value = binding
    with (
        patch("plane.research.services.agent_orchestrator.assemble_agent", return_value=assembly),
        patch(
            "plane.research.services.agent_orchestrator.issue_agent_context", return_value=(grant, "secret")
        ) as issue,
        patch("plane.research.services.agent_orchestrator.specialist_id_for_node", return_value=None),
        patch("plane.research.services.chain_context.node_report_selections", return_value=[]) as reports,
    ):
        yield SimpleNamespace(
            kwargs=dict(
                workspace=SimpleNamespace(slug="lab"),
                user=SimpleNamespace(id=uuid4()),
                node=node,
                request_id="request",
                client=client,
            ),
            assembly=assembly,
            grant=grant,
            client=client,
            binding=binding,
            issue=issue,
            reports=reports,
        )


@pytest.mark.parametrize("external_mcp,sd_binding", [(True, False), (False, True), (False, False)])
def test_sd_without_binding_never_calls_connector_api(settings, sd_session, external_mcp, sd_binding):
    settings.RESEARCH_MCP_ENABLED = external_mcp
    settings.SCIENCE_DISCOVERY_RESEARCH_MCP_ENABLED = sd_binding
    # A Plane callback origin is not required without an SD connector.
    settings.RESEARCH_MCP_PUBLIC_BASE_URL = ""
    sd_session.client.create_research_connector.side_effect = ScienceDiscoveryError(
        "science_discovery_session_failed",
        "ScienceDiscovery returned 404.",
        502,
    )

    result = create_science_discovery_session(**sd_session.kwargs)

    assert result["sd_session_id"] == "session"
    assert "research_mcp" not in result["assembly"]
    assert result["assembly"]["policy_version"] == "research-agent-policy.v1"
    assert settings.RESEARCH_MCP_ENABLED is external_mcp
    sd_session.client.create_research_connector.assert_not_called()
    sd_session.client.create_session.assert_called_once_with(project_id="project", title="Research · Node")
    sd_session.reports.assert_not_called()
    assert sd_session.issue.call_args.kwargs["allowed_reports"] is None
    sd_session.grant.save.assert_not_called()


def test_enabled_binding_still_registers_and_selects_scoped_connector(settings, sd_session):
    settings.RESEARCH_MCP_ENABLED = True
    settings.SCIENCE_DISCOVERY_RESEARCH_MCP_ENABLED = True
    settings.RESEARCH_MCP_PUBLIC_BASE_URL = "https://plane.example"

    result = create_science_discovery_session(**sd_session.kwargs)

    assert result["assembly"]["research_mcp"] == sd_session.binding
    assert set(result["assembly"]["allowed_tools"]) == TOOL_NAMES
    sd_session.client.create_research_connector.assert_called_once_with(
        workspace=sd_session.kwargs["workspace"],
        user=sd_session.kwargs["user"],
        grant=sd_session.grant,
        token="secret",
        url="https://plane.example/api/research/workspaces/lab/agent-access/mcp/",
    )
    sd_session.client.create_session.assert_called_once_with(
        project_id="project",
        title="Research · Node",
        connector_ids=[sd_session.binding["source_id"]],
    )


def test_enabled_binding_failure_remains_explicit_and_revokes_grant(settings, sd_session):
    settings.RESEARCH_MCP_ENABLED = True
    settings.SCIENCE_DISCOVERY_RESEARCH_MCP_ENABLED = True
    settings.RESEARCH_MCP_PUBLIC_BASE_URL = "https://plane.example"
    sd_session.client.create_research_connector.side_effect = ScienceDiscoveryError(
        "science_discovery_session_failed",
        "ScienceDiscovery returned 404.",
        502,
    )

    with pytest.raises(ScienceDiscoveryError, match="404"):
        create_science_discovery_session(**sd_session.kwargs)

    assert sd_session.grant.revoked_at is not None
    sd_session.grant.save.assert_called_once()
    sd_session.client.create_project.assert_not_called()
    sd_session.client.create_session.assert_not_called()
