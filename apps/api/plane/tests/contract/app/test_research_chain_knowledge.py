"""Phase 1 scoped RAGPortal upload and reference contract tests."""

from unittest.mock import patch
from uuid import uuid4

import pytest
from django.core.files.uploadedfile import SimpleUploadedFile
from rest_framework.test import APIClient

from plane.db.models import (
    ExternalSystemConnection,
    Project,
    ResearchChain,
    ResearchChainEvent,
    ResearchChainNode,
    ResearchChainUpload,
    ResearchExternalReference,
    ResearchProjectProfile,
    ResearchUserProfile,
    WorkspaceResearchSetting,
)
from plane.research.services.integrations.base import IntegrationResult
from plane.tests.research_fixtures import add_workspace_member, enable_research, make_user, make_workspace

pytestmark = pytest.mark.contract


def _client(user):
    """Return an authenticated Django REST client."""
    client = APIClient()
    client.force_authenticate(user=user)
    return client


def _project(workspace, owner, name):
    """Create a research project for one Chain."""
    suffix = uuid4().hex[:6]
    project = Project.objects.create(
        workspace=workspace,
        name=f"{name} {suffix}",
        identifier=f"{name[:2].upper()}{suffix}",
        network=0,
        created_by=owner,
    )
    ResearchProjectProfile.objects.create(
        project=project,
        workspace=workspace,
        owner=owner,
        chain_kind=ResearchProjectProfile.ChainKind.RESEARCH_CHAIN,
        chain_visibility=ResearchProjectProfile.ChainVisibility.PRIVATE,
        created_by=owner,
    )
    return project


def _chain(workspace, owner, project):
    """Create a Chain and its first node directly for focused BFF tests."""
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
    return chain, node


def _result(**kwargs):
    """Build an integration result with sensible defaults."""
    return IntegrationResult(system="RAGPORTAL", operation="upload_document", **kwargs)


@pytest.fixture
def env(db, settings):
    """Build a private Chain, a collaborator, and an enabled RAG connection."""
    settings.RESEARCH_MODULE_ENABLED = True
    owner = make_user(first_name="Knowledge owner")
    collaborator = make_user(first_name="Knowledge collaborator")
    workspace = make_workspace(owner)
    add_workspace_member(workspace, collaborator)
    ResearchUserProfile.objects.create(user=collaborator, student_no=f"knowledge-{uuid4().hex[:12]}")
    enable_research(
        workspace,
        research_chain_enabled=True,
        research_agent_enabled=True,
        research_external_rag_enabled=True,
    )
    ExternalSystemConnection.objects.create(
        workspace=workspace,
        system="RAGPORTAL",
        display_name="RAGPortal",
        base_url="https://ragportal.example.com",
        auth_mode="NONE",
        is_enabled=True,
    )
    project = _project(workspace, owner, "Knowledge")
    chain, node = _chain(workspace, owner, project)
    return {
        "owner": owner,
        "collaborator": collaborator,
        "workspace": workspace,
        "project": project,
        "chain": chain,
        "node": node,
        "owner_client": _client(owner),
        "collaborator_client": _client(collaborator),
    }


def test_chain_knowledge_bases_use_ragportal_result(env):
    """Knowledge bases are delegated without widening Chain ACL."""
    with patch(
        "plane.research.services.integrations.adapters.RagPortalClient.knowledge_bases",
        return_value=_result(
            items=[{"external_id": "kb-1", "title": "Materials", "external_parent_id": ""}],
            request_id="req-kb",
        ),
    ):
        response = env["owner_client"].get(
            f"/api/research/workspaces/{env['workspace'].slug}/chains/{env['chain'].id}/knowledge-bases/"
        )
    assert response.status_code == 200, response.json()
    assert response.json()["items"][0]["external_id"] == "kb-1"
    assert response.json()["chain_id"] == str(env["chain"].id)


def test_scoped_upload_is_idempotent_and_creates_reference_event(env):
    """A successful upload writes upload, reference and Chain event once."""
    url = f"/api/research/workspaces/{env['workspace'].slug}/chains/{env['chain'].id}/uploads/"
    payload = {
        "node_id": str(env["node"].id),
        "kb_id": "kb-1",
    }
    file = SimpleUploadedFile("paper.md", b"# paper", content_type="text/markdown")
    receipt = {
        "external_id": "knowledge-1",
        "external_type": "KNOWLEDGE_ENTRY",
        "external_parent_id": "kb-1",
        "title": "paper.md",
        "summary": "pending",
        "source_url": "/api/uploads/7",
        "acl_hint": {},
        "metadata": {
            "upload_id": "7",
            "task_id": "task-1",
            "parse_status": "pending",
            "file_hash": "source-hash",
        },
    }
    with patch(
        "plane.research.services.integrations.adapters.RagPortalClient.upload",
        return_value=_result(items=[receipt], request_id="req-upload"),
    ) as upload_mock:
        created = env["owner_client"].post(
            url,
            {**payload, "file": file},
            format="multipart",
            HTTP_X_REQUEST_ID="req-upload",
        )
        replay_file = SimpleUploadedFile("paper.md", b"# paper", content_type="text/markdown")
        replay = env["owner_client"].post(
            url,
            {**payload, "file": replay_file},
            format="multipart",
            HTTP_X_REQUEST_ID="req-upload",
        )
    assert created.status_code == 201, created.json()
    assert replay.status_code == 200
    assert upload_mock.call_count == 1
    assert upload_mock.call_args.kwargs["metadata"]["research_project_id"] == str(env["project"].id)
    assert upload_mock.call_args.kwargs["metadata"]["chain_node_id"] == str(env["node"].id)
    upload = ResearchChainUpload.objects.get(request_id="req-upload")
    assert upload.status == ResearchChainUpload.Status.PENDING
    assert upload.knowledge_id == "knowledge-1"
    assert ResearchExternalReference.objects.filter(external_id="knowledge-1").exists()
    assert ResearchChainEvent.objects.filter(request_id="req-upload", event_type="DATA_CHANGE").count() == 1


def test_upload_status_refresh_updates_projection_and_appends_fact(env):
    """Polling the BFF refreshes RAGPortal status without duplicating facts."""
    upload = ResearchChainUpload.objects.create(
        workspace=env["workspace"],
        chain=env["chain"],
        node=env["node"],
        request_id=f"upload-{uuid4().hex}",
        payload_hash=uuid4().hex,
        external_upload_id="7",
        knowledge_id="knowledge-1",
        knowledge_base_id="kb-1",
        file_name="paper.md",
        file_type="md",
        file_size=7,
        file_hash=uuid4().hex,
        status=ResearchChainUpload.Status.PENDING,
        created_by=env["owner"],
    )
    with patch(
        "plane.research.services.integrations.adapters.RagPortalClient.upload_detail",
        return_value=_result(
            items=[{"external_id": "knowledge-1", "title": "paper.md", "metadata": {"parse_status": "success"}}],
            request_id="req-status",
        ),
    ):
        response = env["owner_client"].get(
            f"/api/research/workspaces/{env['workspace'].slug}/chains/{env['chain'].id}/uploads/{upload.id}/"
        )
    assert response.status_code == 200, response.json()
    assert response.json()["data"]["status"] == "SUCCESS"
    assert ResearchChainEvent.objects.filter(event_type="DATA_CHANGE", summary="Upload status: SUCCESS").exists()

    listed = env["owner_client"].get(
        f"/api/research/workspaces/{env['workspace'].slug}/chains/{env['chain'].id}/uploads/",
        {"node_id": str(env["node"].id)},
    )
    denied = env["collaborator_client"].get(
        f"/api/research/workspaces/{env['workspace'].slug}/chains/{env['chain'].id}/uploads/",
        {"node_id": str(env["node"].id)},
    )
    assert listed.status_code == 200, listed.json()
    assert [item["id"] for item in listed.json()["data"]] == [str(upload.id)]
    assert denied.status_code == 404


def test_archived_chain_upload_status_refresh_is_readonly(env):
    """Archived Chains return the local projection without upstream refresh."""
    upload = ResearchChainUpload.objects.create(
        workspace=env["workspace"],
        chain=env["chain"],
        node=env["node"],
        request_id=f"upload-{uuid4().hex}",
        payload_hash=uuid4().hex,
        external_upload_id="9",
        knowledge_base_id="kb-1",
        file_name="paper.md",
        file_type="md",
        file_size=7,
        file_hash=uuid4().hex,
        status=ResearchChainUpload.Status.PENDING,
        created_by=env["owner"],
    )
    ResearchChain.objects.filter(pk=env["chain"].pk).update(status=ResearchChain.Status.ARCHIVED)
    with patch("plane.research.services.integrations.adapters.RagPortalClient.upload_detail") as detail_mock:
        response = env["owner_client"].get(
            f"/api/research/workspaces/{env['workspace'].slug}/chains/{env['chain'].id}/uploads/{upload.id}/"
        )

    assert response.status_code == 200, response.json()
    assert response.json()["data"]["status"] == "PENDING"
    assert detail_mock.call_count == 0
    assert not ResearchChainEvent.objects.filter(event_type="DATA_CHANGE", summary="Upload status: SUCCESS").exists()


def test_upload_degradation_preserves_manual_path(env):
    """A RAGPortal failure returns an explicit degraded and manual record state."""
    url = f"/api/research/workspaces/{env['workspace'].slug}/chains/{env['chain'].id}/uploads/"
    with patch(
        "plane.research.services.integrations.adapters.RagPortalClient.upload",
        return_value=_result(degraded=True, degraded_reason="transport_error", request_id="req-degraded"),
    ):
        response = env["owner_client"].post(
            url,
            {
                "node_id": str(env["node"].id),
                "kb_id": "kb-1",
                "file": SimpleUploadedFile("paper.md", b"paper", content_type="text/markdown"),
            },
            format="multipart",
            HTTP_X_REQUEST_ID="req-degraded",
        )
    assert response.status_code == 503
    assert response.json()["degraded_reason"] == "transport_error"
    assert response.json()["manual_record"] is True
    assert ResearchChainUpload.objects.filter(request_id="req-degraded", status="DEGRADED").exists()
    assert ResearchChainEvent.objects.filter(request_id="req-degraded", event_type="DEGRADED").exists()


def test_external_rag_switch_stops_upstream_upload_but_preserves_manual_path(env):
    """The Workspace switch, not only the connection, gates external calls."""
    WorkspaceResearchSetting.objects.filter(workspace=env["workspace"]).update(research_external_rag_enabled=False)
    with patch("httpx.Client.request") as upstream_request:
        response = env["owner_client"].post(
            f"/api/research/workspaces/{env['workspace'].slug}/chains/{env['chain'].id}/uploads/",
            {
                "node_id": str(env["node"].id),
                "kb_id": "kb-1",
                "file": SimpleUploadedFile("manual.md", b"manual", content_type="text/markdown"),
            },
            format="multipart",
            HTTP_X_REQUEST_ID="req-switch-off",
        )

    assert upstream_request.call_count == 0
    assert response.status_code == 503
    assert response.json()["manual_record"] is True
    assert ResearchChainUpload.objects.filter(request_id="req-switch-off", status="DEGRADED").exists()
    assert ResearchChainEvent.objects.filter(request_id="req-switch-off", event_type="DEGRADED").exists()


def test_reference_is_scoped_and_rejects_cross_chain_reuse(env):
    """A knowledge reference cannot be confirmed into another Chain."""
    reference = ResearchExternalReference.objects.create(
        workspace=env["workspace"],
        system="RAGPORTAL",
        external_type="KNOWLEDGE_ENTRY",
        external_id="knowledge-other",
        external_parent_id="kb-other",
        title="Other chain paper",
        source_url="https://ragportal.example.com/api/kb/knowledge-other",
        acl_hint={"workspace": env["workspace"].slug},
        metadata={"chain_id": str(uuid4())},
        created_by=env["owner"],
    )
    response = env["owner_client"].post(
        f"/api/research/workspaces/{env['workspace'].slug}/chains/{env['chain'].id}/references/",
        {
            "request_id": f"reference-{uuid4().hex}",
            "node_id": str(env["node"].id),
            "knowledge_id": reference.external_id,
            "kb_id": reference.external_parent_id,
            "query": "polymer",
        },
        format="json",
    )
    assert response.status_code == 403
    assert not ResearchChainEvent.objects.filter(event_type="ARTIFACT_CREATED", node=env["node"]).exists()


def test_upload_receipt_cannot_rebind_a_cross_chain_reference(env):
    """RAGPortal receipts carrying an existing knowledge id stay chain-scoped."""
    reference = ResearchExternalReference.objects.create(
        workspace=env["workspace"],
        system="RAGPORTAL",
        external_type=ResearchExternalReference.ExternalType.KNOWLEDGE_ENTRY,
        external_id="knowledge-owned",
        external_parent_id="kb-other",
        title="Owned paper",
        source_url="https://ragportal.example.com/api/kb/knowledge-owned",
        metadata={"chain_id": str(uuid4())},
        created_by=env["owner"],
    )
    receipt = {
        "external_id": reference.external_id,
        "external_type": "KNOWLEDGE_ENTRY",
        "external_parent_id": "kb-1",
        "title": "paper.md",
        "summary": "pending",
        "source_url": "/api/uploads/8",
        "metadata": {"upload_id": "8", "parse_status": "pending"},
    }
    with patch(
        "plane.research.services.integrations.adapters.RagPortalClient.upload",
        return_value=_result(items=[receipt], request_id="req-cross-chain"),
    ):
        response = env["owner_client"].post(
            f"/api/research/workspaces/{env['workspace'].slug}/chains/{env['chain'].id}/uploads/",
            {
                "node_id": str(env["node"].id),
                "kb_id": "kb-1",
                "file": SimpleUploadedFile("paper.md", b"paper", content_type="text/markdown"),
            },
            format="multipart",
            HTTP_X_REQUEST_ID="req-cross-chain",
        )

    assert response.status_code == 403, response.json()
    reference.refresh_from_db()
    assert reference.metadata["chain_id"] != str(env["chain"].id)
    assert ResearchChainUpload.objects.filter(request_id="req-cross-chain", error_code="cross_chain_reference").exists()
