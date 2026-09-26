"""Phase 1 scoped RAGPortal upload and reference contract tests."""

from unittest.mock import patch
from uuid import uuid4

import pytest
from django.core.files.uploadedfile import SimpleUploadedFile
from rest_framework.test import APIClient

from plane.db.models import (
    ExternalSystemConnection,
    OrgUnit,
    OrgUnitMember,
    Project,
    ResearchChain,
    ResearchChainEvent,
    ResearchChainNode,
    ResearchChainUpload,
    ResearchExternalReference,
    ResearchGroupKnowledgeBinding,
    ResearchKnowledgeRequest,
    ResearchProjectProfile,
    ResearchUserProfile,
    WorkspaceResearchSetting,
)
from plane.research.services.group_knowledge import migrate_pending_chain_requests
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


def _mark_ready(env, kb_id="kb-1"):
    """Bind one direct-created Chain to an administrator-ready external KB."""
    return ResearchKnowledgeRequest.objects.create(
        workspace=env["workspace"],
        chain=env["chain"],
        request_key=f"chain:{env['chain'].id}",
        state=ResearchKnowledgeRequest.State.READY,
        external_kb_id=kb_id,
        external_kb_name=f"Ready {kb_id}",
        created_by=env["owner"],
    )


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


def test_chain_knowledge_bases_return_only_the_bound_library(env):
    """A ready chain exposes its one bound library, not the upstream catalogue."""
    _mark_ready(env)
    response = env["owner_client"].get(
        f"/api/research/workspaces/{env['workspace'].slug}/chains/{env['chain'].id}/knowledge-bases/"
    )
    assert response.status_code == 200, response.json()
    assert response.json()["items"] == [
        {"external_id": "kb-1", "title": "Ready kb-1", "external_parent_id": ""}
    ]
    assert response.json()["scope"] == "LEGACY_CHAIN"
    assert response.json()["chain_id"] == str(env["chain"].id)


def test_chain_knowledge_request_blocks_new_upload_until_admin_binding(env):
    """A newly created chain exposes its request and gates external writes."""
    request = ResearchKnowledgeRequest.objects.create(
        workspace=env["workspace"],
        chain=env["chain"],
        request_key=f"chain:{env['chain'].id}",
        state=ResearchKnowledgeRequest.State.PENDING_ADMIN,
        created_by=env["owner"],
    )
    bases = env["owner_client"].get(
        f"/api/research/workspaces/{env['workspace'].slug}/chains/{env['chain'].id}/knowledge-bases/"
    )
    assert bases.status_code == 200
    assert bases.json()["state"] == ResearchKnowledgeRequest.State.PENDING_ADMIN
    response = env["owner_client"].post(
        f"/api/research/workspaces/{env['workspace'].slug}/chains/{env['chain'].id}/uploads/",
        {
            "node_id": str(env["node"].id),
            "kb_id": "kb-1",
            "file": SimpleUploadedFile("pending.md", b"pending", content_type="text/markdown"),
        },
        format="multipart",
        HTTP_X_REQUEST_ID="req-pending-kb",
    )
    assert response.status_code == 409
    assert response.json()["error_code"] == "KB_NOT_READY"
    assert request.state == ResearchKnowledgeRequest.State.PENDING_ADMIN


def test_scoped_upload_is_idempotent_and_creates_reference_event(env):
    _mark_ready(env)
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
    _mark_ready(env)
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
    _mark_ready(env)
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
    _mark_ready(env)
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


def _team(workspace, name):
    """Create one TEAM org unit.

    Args:
        workspace: Workspace that owns the team.
        name: Team name.

    Returns:
        The created org unit.
    """
    unit = OrgUnit.objects.create(workspace=workspace, name=name, unit_type=OrgUnit.UnitType.TEAM, path="")
    unit.path = f"/{unit.id.hex}/"
    unit.save(update_fields=["path"])
    return unit


def _member(workspace, unit, user):
    """Add a user to a team."""
    OrgUnitMember.objects.create(
        workspace=workspace,
        org_unit=unit,
        user=user,
        org_role=OrgUnitMember.OrgRole.REVIEWER,
        is_primary=True,
    )


def _research_project(workspace, owner, unit, name):
    """Create a research project owned by one team member."""
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
        org_unit=unit,
        chain_kind=ResearchProjectProfile.ChainKind.RESEARCH_CHAIN,
        chain_visibility=ResearchProjectProfile.ChainVisibility.WORKSPACE,
        created_by=owner,
    )
    return project


def _create_chain_via_api(env, project):
    """Create a chain through the research API."""
    response = env["owner_client"].post(
        f"/api/research/workspaces/{env['workspace'].slug}/chains/",
        {"request_id": f"chain-{uuid4().hex}", "project_id": str(project.id)},
        format="json",
    )
    assert response.status_code == 201, response.json()
    return response.json()["data"]


def test_two_members_share_one_group_binding_and_upload_after_ready(env):
    """Chains in one team reuse a single binding and the same external KB."""
    team = _team(env["workspace"], "电池")
    second = make_user(first_name="Second student")
    add_workspace_member(env["workspace"], second)
    _member(env["workspace"], team, env["owner"])
    _member(env["workspace"], team, second)
    first_project = _research_project(env["workspace"], env["owner"], team, "BatteryA")
    second_project = _research_project(env["workspace"], second, team, "BatteryB")
    first_chain = _create_chain_via_api(env, first_project)
    second_chain = _create_chain_via_api(env, second_project)
    assert ResearchGroupKnowledgeBinding.objects.filter(org_unit=team).count() == 1
    assert ResearchKnowledgeRequest.objects.filter(chain_id__in=[first_chain["id"], second_chain["id"]]).count() == 0
    blocked = env["owner_client"].post(
        f"/api/research/workspaces/{env['workspace'].slug}/chains/{first_chain['id']}/uploads/",
        {
            "node_id": str(uuid4()),
            "kb_id": "kb-team",
            "file": SimpleUploadedFile("pending.md", b"pending", content_type="text/markdown"),
        },
        format="multipart",
        HTTP_X_REQUEST_ID="req-group-pending",
    )
    assert blocked.status_code == 422 or blocked.json()["error_code"] == "KB_NOT_READY"
    if blocked.status_code != 422:
        assert blocked.json()["error_code"] == "KB_NOT_READY"
    binding = ResearchGroupKnowledgeBinding.objects.get(org_unit=team)
    ready = env["owner_client"].patch(
        f"/api/research/workspaces/{env['workspace'].slug}/group-knowledge-bindings/{binding.id}/",
        {"external_kb_id": "kb-team", "external_kb_name": "电池"},
        format="json",
    )
    assert ready.status_code == 200, ready.json()
    node = ResearchChainNode.objects.create(
        chain_id=first_chain["id"],
        node_type="LITERATURE_REVIEW",
        title="文献",
        request_id=f"node-{uuid4().hex}",
        payload_hash=uuid4().hex,
        created_by=env["owner"],
    )
    other_node = ResearchChainNode.objects.create(
        chain_id=second_chain["id"],
        node_type="LITERATURE_REVIEW",
        title="文献",
        request_id=f"node-{uuid4().hex}",
        payload_hash=uuid4().hex,
        created_by=second,
    )
    def _receipt(knowledge_id):
        return _result(
            items=[
                {
                    "external_id": knowledge_id,
                    "external_parent_id": "kb-team",
                    "title": f"{knowledge_id}.md",
                    "source_url": f"/api/uploads/{knowledge_id}",
                    "metadata": {"upload_id": knowledge_id, "parse_status": "pending"},
                }
            ],
            request_id=knowledge_id,
        )

    with patch(
        "plane.research.services.integrations.adapters.RagPortalClient.upload",
        side_effect=[_receipt("knowledge-a"), _receipt("knowledge-b")],
    ) as upload_mock:
        first = env["owner_client"].post(
            f"/api/research/workspaces/{env['workspace'].slug}/chains/{first_chain['id']}/uploads/",
            {
                "node_id": str(node.id),
                "kb_id": "kb-team",
                "file": SimpleUploadedFile("paper.md", b"# paper", content_type="text/markdown"),
            },
            format="multipart",
            HTTP_X_REQUEST_ID="req-group-upload-a",
        )
        second_response = _client(second).post(
            f"/api/research/workspaces/{env['workspace'].slug}/chains/{second_chain['id']}/uploads/",
            {
                "node_id": str(other_node.id),
                "kb_id": "kb-team",
                "file": SimpleUploadedFile("notes.md", b"# notes", content_type="text/markdown"),
            },
            format="multipart",
            HTTP_X_REQUEST_ID="req-group-upload-b",
        )
    assert first.status_code == 201, first.json()
    assert second_response.status_code == 201, second_response.json()
    assert upload_mock.call_count == 2
    assert upload_mock.call_args_list[0].kwargs["metadata"]["org_unit_id"] == str(team.id)
    assert upload_mock.call_args_list[0].kwargs["metadata"]["org_unit_name"] == "电池"
    assert upload_mock.call_args_list[0].kwargs["metadata"]["chain_id"] == first_chain["id"]


def test_cross_team_binding_and_upload_conflict(env):
    """A knowledge base bound to one team cannot be reused by another team."""
    battery = _team(env["workspace"], "电池")
    silicon = _team(env["workspace"], "硅基")
    _member(env["workspace"], battery, env["owner"])
    battery_project = _research_project(env["workspace"], env["owner"], battery, "Battery")
    silicon_project = _research_project(env["workspace"], env["owner"], silicon, "Silicon")
    battery_chain = _create_chain_via_api(env, battery_project)
    silicon_chain = _create_chain_via_api(env, silicon_project)
    battery_binding = ResearchGroupKnowledgeBinding.objects.get(org_unit=battery)
    silicon_binding = ResearchGroupKnowledgeBinding.objects.get(org_unit=silicon)
    assert env["owner_client"].patch(
        f"/api/research/workspaces/{env['workspace'].slug}/group-knowledge-bindings/{battery_binding.id}/",
        {"external_kb_id": "kb-battery", "external_kb_name": "电池"},
        format="json",
    ).status_code == 200
    conflict = env["owner_client"].patch(
        f"/api/research/workspaces/{env['workspace'].slug}/group-knowledge-bindings/{silicon_binding.id}/",
        {"external_kb_id": "kb-battery", "external_kb_name": "硅基"},
        format="json",
    )
    assert conflict.status_code == 409
    assert conflict.json()["error_code"] == "KB_SCOPE_CONFLICT"
    ready = env["owner_client"].patch(
        f"/api/research/workspaces/{env['workspace'].slug}/group-knowledge-bindings/{silicon_binding.id}/",
        {"external_kb_id": "kb-silicon", "external_kb_name": "硅基"},
        format="json",
    )
    assert ready.status_code == 200, ready.json()
    node = ResearchChainNode.objects.create(
        chain_id=silicon_chain["id"],
        node_type="LITERATURE_REVIEW",
        title="文献",
        request_id=f"node-{uuid4().hex}",
        payload_hash=uuid4().hex,
        created_by=env["owner"],
    )
    response = env["owner_client"].post(
        f"/api/research/workspaces/{env['workspace'].slug}/chains/{silicon_chain['id']}/uploads/",
        {
            "node_id": str(node.id),
            "kb_id": "kb-battery",
            "file": SimpleUploadedFile("paper.md", b"# paper", content_type="text/markdown"),
        },
        format="multipart",
        HTTP_X_REQUEST_ID="req-cross-team",
    )
    assert response.status_code == 403
    assert response.json()["error_code"] == "KB_SCOPE_CONFLICT"
    assert ResearchChainUpload.objects.filter(chain_id=silicon_chain["id"]).count() == 0
    assert battery_chain["id"] != silicon_chain["id"]


def test_chain_without_team_does_not_create_a_personal_library(env):
    """A chain with no team stays unassigned instead of opening a personal KB."""
    response = env["owner_client"].post(
        f"/api/research/workspaces/{env['workspace'].slug}/chains/{env['chain'].id}/uploads/",
        {
            "node_id": str(env["node"].id),
            "kb_id": "kb-personal",
            "file": SimpleUploadedFile("paper.md", b"# paper", content_type="text/markdown"),
        },
        format="multipart",
        HTTP_X_REQUEST_ID="req-unassigned",
    )
    assert response.status_code == 409
    assert response.json()["error_code"] == "KB_GROUP_UNASSIGNED"
    assert ResearchGroupKnowledgeBinding.objects.count() == 0
    assert ResearchChainUpload.objects.filter(request_id="req-unassigned").count() == 0


def test_pending_chain_requests_migrate_without_touching_ready_bindings(env):
    """Unfinished chain requests collapse into the team binding; ready ones stay."""
    team = _team(env["workspace"], "多肽")
    _member(env["workspace"], team, env["owner"])
    project = _research_project(env["workspace"], env["owner"], team, "Peptide")
    chain, _node = _chain(env["workspace"], env["owner"], project)
    ResearchKnowledgeRequest.objects.create(
        workspace=env["workspace"],
        chain=chain,
        request_key=f"chain:{chain.id}",
        state=ResearchKnowledgeRequest.State.PENDING_ADMIN,
        created_by=env["owner"],
    )
    ready_project = _project(env["workspace"], env["owner"], "Legacy")
    ready_chain, _ready_node = _chain(env["workspace"], env["owner"], ready_project)
    ready = ResearchKnowledgeRequest.objects.create(
        workspace=env["workspace"],
        chain=ready_chain,
        request_key=f"chain:{ready_chain.id}",
        state=ResearchKnowledgeRequest.State.READY,
        external_kb_id="kb-legacy",
        external_kb_name="Legacy",
        created_by=env["owner"],
    )
    assert migrate_pending_chain_requests() == 1
    chain_request = ResearchKnowledgeRequest.objects.get(chain=chain)
    assert chain_request.state == ResearchKnowledgeRequest.State.ARCHIVED
    binding = ResearchGroupKnowledgeBinding.objects.get(org_unit=team)
    assert binding.state == ResearchGroupKnowledgeBinding.State.PENDING_ADMIN
    assert chain_request.parameter_summary["superseded_by_group_binding_id"] == str(binding.id)
    ready.refresh_from_db()
    assert ready.state == ResearchKnowledgeRequest.State.READY
    assert ready.external_kb_id == "kb-legacy"


def test_group_library_search_hides_documents_from_outside_collaborators(env):
    """Chain collaborators outside the team cannot read the shared library."""
    team = _team(env["workspace"], "光刻胶")
    _member(env["workspace"], team, env["collaborator"])
    binding = ResearchGroupKnowledgeBinding.objects.create(
        workspace=env["workspace"],
        org_unit=team,
        request_key=f"team:{team.id}",
        state=ResearchGroupKnowledgeBinding.State.READY,
        external_kb_id="kb-group",
        external_kb_name="光刻胶",
        created_by=env["owner"],
    )
    setting = env["workspace"].research_setting
    setting.integration_enabled = True
    setting.save(update_fields=["integration_enabled"])
    child = OrgUnit.objects.create(
        workspace=env["workspace"],
        name="光刻胶一组",
        unit_type=OrgUnit.UnitType.GROUP,
        parent=team,
        path="",
    )
    child.path = f"{team.path}{child.id.hex}/"
    child.save(update_fields=["path"])
    child_user = make_user(first_name="Child member")
    add_workspace_member(env["workspace"], child_user)
    _member(env["workspace"], child, child_user)
    items = [
        {
            "external_id": "group-doc",
            "title": "Group paper",
            "external_parent_id": binding.external_kb_id,
            "acl_hint": {"public": True},
            "metadata": {},
        },
        {
            "external_id": "private-group-doc",
            "title": "Private group paper",
            "external_parent_id": binding.external_kb_id,
            "acl_hint": {"users": ["someone-else"]},
            "metadata": {},
        },
        {
            "external_id": "public-doc",
            "title": "Public note",
            "external_parent_id": "",
            "acl_hint": {"public": True},
            "metadata": {},
        },
    ]
    with patch(
        "plane.research.services.integrations.adapters.RagPortalClient.search",
        return_value=_result(items=items),
    ):
        member = env["collaborator_client"].get(
            f"/api/research/workspaces/{env['workspace'].slug}/knowledge/entries/?q=paper"
        )
        child_response = _client(child_user).get(
            f"/api/research/workspaces/{env['workspace'].slug}/knowledge/entries/?q=paper"
        )
        outsider = make_user(first_name="Outside collaborator")
        add_workspace_member(env["workspace"], outsider)
        hidden = _client(outsider).get(
            f"/api/research/workspaces/{env['workspace'].slug}/knowledge/entries/?q=paper"
        )
    assert member.status_code == 200, member.json()
    assert {item["external_id"] for item in member.json()["items"]} == {"group-doc", "private-group-doc", "public-doc"}
    assert child_response.status_code == 200, child_response.json()
    assert {item["external_id"] for item in child_response.json()["items"]} == {
        "group-doc",
        "private-group-doc",
        "public-doc",
    }
    assert hidden.status_code == 200, hidden.json()
    assert {item["external_id"] for item in hidden.json()["items"]} == {"public-doc"}
