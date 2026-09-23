"""Phase 1 Synlora automatic assembly and delegated Context tests."""

from uuid import uuid4

import pytest
from django.utils import timezone

from plane.db.models import (
    AccountLink,
    Project,
    ResearchChain,
    ResearchChainNode,
    ResearchChainUpload,
    ResearchProjectProfile,
)
from plane.research.services.agent_orchestrator import assemble_agent, create_synlora_session
from plane.tests.research_fixtures import enable_research, make_user, make_workspace

pytestmark = pytest.mark.contract


@pytest.fixture
def env(db, settings):
    """Build one literature node with an active Synlora link."""
    settings.RESEARCH_MODULE_ENABLED = True
    owner = make_user(first_name="Orchestrator owner")
    workspace = make_workspace(owner)
    enable_research(workspace, research_agent_enabled=True, research_chain_enabled=True)
    suffix = uuid4().hex[:6]
    project = Project.objects.create(
        workspace=workspace,
        name=f"Orchestrator {suffix}",
        identifier=f"OR{suffix}",
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
        node_type="LITERATURE_REVIEW",
        title="文献调研",
        request_id=f"node-{uuid4().hex}",
        payload_hash=uuid4().hex,
        created_by=owner,
    )
    ResearchChainUpload.objects.create(
        workspace=workspace,
        chain=chain,
        node=node,
        request_id=f"upload-{uuid4().hex}",
        payload_hash=uuid4().hex,
        external_upload_id="upload-1",
        knowledge_id="knowledge-1",
        knowledge_base_id="kb-1",
        file_name="paper.pdf",
        file_type="pdf",
        file_size=4,
        file_hash=uuid4().hex,
        status=ResearchChainUpload.Status.SUCCESS,
        created_by=owner,
    )
    link = AccountLink.objects.create(
        local_user=owner,
        provider="SYNLORA",
        canonical_identity=f"synlora-{uuid4().hex}",
        external_subject="u_synlora",
        status=AccountLink.Status.ACTIVE,
        verified_at=timezone.now(),
        request_id=f"link-{uuid4().hex}",
        payload_hash=uuid4().hex,
        created_by=owner,
    )
    return {"owner": owner, "workspace": workspace, "profile": profile, "node": node, "link": link}


class FakeClient:
    """Capture delegated calls without network access."""

    def __init__(self):
        self.created = None

    def exchange_delegated_token(self, **kwargs):
        """Return a fake short-lived user token."""
        self.exchange = kwargs
        return {"token": "delegated-token", "subject": "u_synlora"}

    def capabilities(self, _token):
        """Return a defensive capability fixture."""
        return {
            "plugins": [{"id": "rag", "auto_load": True, "health": "OK"}],
            "tools": [
                {"name": "knowledge.search"},
                {"name": "knowledge.list"},
                {"name": "file.write"},
            ],
        }

    def create_session(self, **kwargs):
        """Record the exact Synlora session payload."""
        self.created = kwargs
        return {"_id": "synlora-session-1"}


def test_assemble_agent_uses_registry_and_node_policy(env):
    """Final tools are the node policy and Synlora registry intersection."""
    assembly = assemble_agent(
        node=env["node"],
        manifest={
            "plugins": [{"id": "rag", "auto_load": True, "health": "OK"}],
            "tools": [{"name": "knowledge.search"}, {"name": "knowledge.list"}, {"name": "file.write"}],
        },
    )
    assert assembly.persona == "research-literature"
    assert assembly.allowed_tools == ["knowledge.list", "knowledge.search"]
    assert assembly.allowed_knowledge_base_ids == ["kb-1"]
    assert assembly.allowed_file_ids == ["upload-1"]
    assert assembly.unavailable_reasons == []


def test_create_synlora_session_carries_v2_without_tokens(env):
    """The external session receives v2 scope but never a delegated or Context token."""
    client = FakeClient()
    orchestrated = create_synlora_session(
        workspace=env["workspace"],
        user=env["owner"],
        node=env["node"],
        request_id="request-1",
        client=client,
    )
    assert orchestrated["synlora_session_id"] == "synlora-session-1"
    metadata = client.created["payload"]["research_context"]
    assert metadata["schema_version"] == "agent-context.v2"
    assert metadata["allowed_tools"] == ["knowledge.list", "knowledge.search"]
    assert metadata["allowed_knowledge_base_ids"] == ["kb-1"]
    assert "token" not in metadata
    assert "exchange_token" not in client.created["payload"]
    assert orchestrated["grant"].allowed_tools == ["knowledge.list", "knowledge.search"]
