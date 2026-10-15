"""End-to-end Phase 1 acceptance scenario with deterministic external doubles."""

from hashlib import sha256
from unittest.mock import patch
from uuid import uuid4

import pytest
from django.core.files.uploadedfile import SimpleUploadedFile
from django.utils import timezone
from rest_framework.test import APIClient

from plane.db.models import (
    ExternalSystemConnection,
    MentorBinding,
    OrgUnit,
    OrgUnitMember,
    Project,
    ResearchChainEvent,
    ResearchChainSnapshot,
    ResearchGroupKnowledgeBinding,
    ResearchProjectProfile,
    ResearchUserProfile,
)
from plane.research.services.integrations.base import IntegrationResult
from plane.tests.research_fixtures import add_workspace_member, enable_research, make_user, make_workspace

pytestmark = pytest.mark.contract


def _client(user):
    client = APIClient()
    client.force_authenticate(user=user)
    return client


def _team(workspace, owner):
    """Create the student's shared team.

    Args:
        workspace: Workspace that owns the team.
        owner: Student who belongs to the team.

    Returns:
        The TEAM org unit.
    """
    unit = OrgUnit.objects.create(workspace=workspace, name="电池", unit_type=OrgUnit.UnitType.TEAM, path="")
    unit.path = f"/{unit.id.hex}/"
    unit.save(update_fields=["path"])
    OrgUnitMember.objects.create(
        workspace=workspace,
        org_unit=unit,
        user=owner,
        org_role=OrgUnitMember.OrgRole.REVIEWER,
        is_primary=True,
    )
    return unit


def _profile(workspace, owner, name, visibility, org_unit):
    suffix = uuid4().hex[:6]
    project = Project.objects.create(
        workspace=workspace,
        name=f"{name} {suffix}",
        identifier=f"{name[:2].upper()}{suffix}",
        network=0,
        created_by=owner,
    )
    return project, ResearchProjectProfile.objects.create(
        project=project,
        workspace=workspace,
        owner=owner,
        org_unit=org_unit,
        chain_kind=ResearchProjectProfile.ChainKind.RESEARCH_CHAIN,
        chain_visibility=visibility,
        created_by=owner,
    )


@pytest.fixture
def env(db, settings, monkeypatch):
    """Build the Phase 1 pilot cast and deterministic Synlora/RAG doubles."""
    settings.RESEARCH_MODULE_ENABLED = True
    student = make_user(first_name="Student")
    mentor = make_user(first_name="Mentor")
    guest = make_user(first_name="Guest")
    workspace = make_workspace(student)
    add_workspace_member(workspace, mentor)
    add_workspace_member(workspace, guest)
    ResearchUserProfile.objects.create(user=student, student_no=f"e2e-{uuid4().hex[:12]}")
    ResearchUserProfile.objects.create(user=mentor, category=ResearchUserProfile.Category.ADVISOR)
    MentorBinding.objects.create(workspace=workspace, mentee=student, mentor=mentor, is_primary_advisor=True)
    enable_research(
        workspace,
        research_chain_enabled=True,
        research_account_link_enabled=True,
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
    team = _team(workspace, student)
    project_a, profile_a = _profile(workspace, student, "Public", "WORKSPACE", team)
    project_b, profile_b = _profile(workspace, student, "Private", "PRIVATE", team)

    return {
        "student": student,
        "mentor": mentor,
        "guest": guest,
        "workspace": workspace,
        "project_a": project_a,
        "profile_a": profile_a,
        "project_b": project_b,
        "profile_b": profile_b,
        "student_client": _client(student),
        "mentor_client": _client(mentor),
        "guest_client": _client(guest),
    }


def _create_chain(env, project):
    return (
        env["student_client"]
        .post(
            f"/api/research/workspaces/{env['workspace'].slug}/chains/",
            {"request_id": f"chain-{uuid4().hex}", "project_id": str(project.id)},
            format="json",
        )
        .json()["data"]
    )


def _mark_knowledge_ready(env, chain_id, kb_id="kb-1"):
    """Promote the shared team binding to the test-ready state."""
    binding = ResearchGroupKnowledgeBinding.objects.get(workspace=env["workspace"])
    binding.state = ResearchGroupKnowledgeBinding.State.READY
    binding.external_kb_id = kb_id
    binding.external_kb_name = f"Ready {kb_id}"
    binding.save(update_fields=["state", "external_kb_id", "external_kb_name", "updated_at"])
    return binding


def _create_node(env, chain_id, node_type, title):
    return (
        env["student_client"]
        .post(
            f"/api/research/workspaces/{env['workspace'].slug}/chains/{chain_id}/nodes/",
            {"request_id": f"node-{uuid4().hex}", "node_type": node_type, "title": title},
            format="json",
        )
        .json()["data"]
    )


def test_phase1_student_research_loop_and_guardrails(env):
    """Run the Phase 1 pilot loop across public and private chains."""
    chain_a = _create_chain(env, env["project_a"])
    chain_b = _create_chain(env, env["project_b"])
    node_a = _create_node(env, chain_a["id"], "LITERATURE_REVIEW", "课题 A 调研")
    _create_node(env, chain_b["id"], "EXPERIMENT", "课题 B 实验")
    assert ResearchGroupKnowledgeBinding.objects.filter(
        workspace=env["workspace"], state=ResearchGroupKnowledgeBinding.State.PENDING_ADMIN
    ).count() == 1
    _mark_knowledge_ready(env, chain_a["id"])

    visible = env["guest_client"].get(f"/api/research/workspaces/{env['workspace'].slug}/chains/")
    assert visible.status_code == 200
    visible_ids = {item["id"] for item in visible.json()["data"]}
    assert str(chain_a["id"]) in visible_ids
    assert str(chain_b["id"]) not in visible_ids
    private_detail = env["guest_client"].get(
        f"/api/research/workspaces/{env['workspace'].slug}/chains/{chain_b['id']}/"
    )
    assert private_detail.status_code in (403, 404)

    receipt = {
        "external_id": "knowledge-e2e",
        "external_type": "KNOWLEDGE_ENTRY",
        "external_parent_id": "kb-1",
        "title": "paper.md",
        "summary": "pending",
        "source_url": "/api/uploads/7",
        "metadata": {"upload_id": "7", "parse_status": "pending"},
    }
    with patch(
        "plane.research.services.integrations.adapters.RagPortalClient.upload",
        return_value=IntegrationResult(
            system="RAGPORTAL",
            operation="upload_document",
            items=[receipt],
            request_id="req-e2e-upload",
        ),
    ):
        uploaded = env["student_client"].post(
            f"/api/research/workspaces/{env['workspace'].slug}/chains/{chain_a['id']}/uploads/",
            {
                "node_id": node_a["id"],
                "kb_id": "kb-1",
                "file": SimpleUploadedFile("paper.md", b"paper", content_type="text/markdown"),
            },
            format="multipart",
            HTTP_X_REQUEST_ID="req-e2e-upload",
        )
    assert uploaded.status_code == 201, uploaded.json()

    plan = env["student_client"].post(
        f"/api/research/workspaces/{env['workspace'].slug}/chains/{chain_a['id']}/analyses/",
        {
            "request_id": f"artifact-{uuid4().hex}",
            "node_id": node_a["id"],
            "method": "research plan consolidation",
            "summary": "Confirmed research plan",
            "metrics": {},
            "confirmed": True,
        },
        format="json",
    )
    assert plan.status_code == 201, plan.json()
    analysis = env["student_client"].post(
        f"/api/research/workspaces/{env['workspace'].slug}/chains/{chain_a['id']}/analyses/",
        {
            "request_id": f"analysis-{uuid4().hex}",
            "node_id": node_a["id"],
            "method": "literature synthesis",
            "summary": "Research direction is feasible",
            "metrics": {"papers": 12},
            "confirmed": True,
        },
        format="json",
    )
    assert analysis.status_code == 201, analysis.json()

    experiment = env["student_client"].post(
        f"/api/research/workspaces/{env['workspace'].slug}/projects/{env['project_b'].id}/experiments/",
        {
            "title": "Manual failed run",
            "molecular_system": "PEO/LiTFSI",
            "method": "GPC",
            "parameters": {"T": 25},
        },
        format="json",
    )
    assert experiment.status_code == 201, experiment.json()
    record_id = experiment.json()["id"]
    assert (
        env["student_client"]
        .post(
            f"/api/research/workspaces/{env['workspace'].slug}/experiments/{record_id}/status/",
            {"status": "RUNNING"},
            format="json",
        )
        .status_code
        == 200
    )
    failed = env["student_client"].post(
        f"/api/research/workspaces/{env['workspace'].slug}/experiments/{record_id}/status/",
        {"status": "FAILED", "failure_reason": "instrument unavailable"},
        format="json",
    )
    assert failed.status_code == 200, failed.json()

    exported = env["student_client"].get(
        f"/api/research/workspaces/{env['workspace'].slug}/projects/{env['project_a'].id}/chain/export/"
    )
    assert exported.status_code == 200
    body = exported.content.decode("utf-8")
    assert "NODE_CREATED" in body
    assert "Confirmed research plan" in body
    assert body.index("NODE_CREATED") < body.index("Confirmed research plan")
    assert exported["X-Research-Chain-SHA256"] == sha256(exported.content).hexdigest()

    assert ResearchChainSnapshot.objects.filter(snapshot_type="ANALYSIS_RESULT").exists()
