"""Shared fixtures for research application contract tests."""

from uuid import uuid4

import pytest

from plane.db.models import (
    Project,
    ResearchAgentBackendConnection,
    ResearchAgentSession,
    ResearchChain,
    ResearchChainNode,
    ResearchProjectProfile,
)
from plane.license.utils.encryption import encrypt_data
from plane.research.services.agent_orchestrator import AgentAssembly, issue_agent_context
from plane.tests.research_fixtures import enable_research, make_org_member, make_user, make_workspace


@pytest.fixture
def sd_session(db, settings):
    """Build one Agent session pinned to the ScienceDiscovery provider."""
    settings.RESEARCH_MODULE_ENABLED = True
    owner = make_user(first_name="SD owner")
    workspace = make_workspace(owner)
    enable_research(workspace, research_agent_enabled=True, research_chain_enabled=True)
    # 215a0f8d04 起所有 research 视图要求科研组织树有效成员。
    make_org_member(workspace, owner)
    suffix = uuid4().hex[:6]
    project = Project.objects.create(
        workspace=workspace,
        name=f"SD {suffix}",
        identifier=f"SD{suffix}",
        network=0,
        created_by=owner,
    )
    profile = ResearchProjectProfile.objects.create(
        project=project,
        workspace=workspace,
        owner=owner,
        chain_kind=ResearchProjectProfile.ChainKind.RESEARCH_CHAIN,
        created_by=owner,
    )
    chain = ResearchChain.objects.create(
        project=project,
        workspace=workspace,
        owner=owner,
        request_id=f"chain-{uuid4().hex}",
        payload_hash=uuid4().hex,
        created_by=owner,
    )
    node = ResearchChainNode.objects.create(
        chain=chain,
        node_type="GENERAL_RESEARCH",
        title="SD node",
        request_id=f"node-{uuid4().hex}",
        payload_hash=uuid4().hex,
        created_by=owner,
    )
    assembly = AgentAssembly(
        persona="research-general",
        enabled_plugins=[],
        allowed_tools=["read_file", "list_files"],
        allowed_knowledge_base_ids=[],
        allowed_file_ids=[],
        unavailable_reasons=[],
        policy_id=f"plane-node:{node.id}",
    )
    grant, _token = issue_agent_context(
        workspace=workspace,
        user=owner,
        profile=profile,
        node=node,
        assembly=assembly,
        request_id=f"agent:{uuid4().hex}",
    )
    session = ResearchAgentSession.objects.create(
        workspace=workspace,
        user=owner,
        project_id=project.id,
        chain_node=node,
        context_grant=grant,
        status=ResearchAgentSession.Status.STREAMING,
        provider=ResearchAgentSession.Provider.SCIENCE_DISCOVERY,
        sd_project_id="sd-project-1",
        sd_session_id="sd-session-1",
        sd_run_id="sd-run-1",
        assembly={},
        request_id=f"session-{uuid4().hex}",
        payload_hash=uuid4().hex,
        created_by=owner,
    )
    # 唯一连接来源是用户级连接（§5）：夹具直接挂一条真实加密连接。
    session.backend_connection = ResearchAgentBackendConnection.objects.create(
        workspace=workspace,
        user=owner,
        base_url="http://192.168.1.10:5300",
        credential_encrypted=encrypt_data("sd-secret-token"),
        is_enabled=True,
        created_by=owner,
    )
    session.save(update_fields=["backend_connection", "updated_at"])
    return session
