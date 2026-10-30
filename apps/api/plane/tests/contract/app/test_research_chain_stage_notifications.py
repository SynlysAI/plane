"""Contract tests for Research Chain stage notifications and owner progress."""

from uuid import uuid4

import pytest
from django.utils import timezone
from rest_framework.test import APIClient

from plane.db.models import (
    MentorBinding,
    Notification,
    OrgUnit,
    OrgUnitMember,
    Project,
    ResearchChain,
    ResearchChainNode,
    ResearchChainUpload,
    ResearchProjectProfile,
)
from plane.research.services.chain_stage_approvals import initialize_chain_stages
from plane.tests.research_fixtures import add_workspace_member, enable_research, make_user, make_workspace

pytestmark = pytest.mark.contract


@pytest.fixture
def env(db):
    owner = make_user(first_name="Notify owner")
    advisor = make_user(first_name="Notify advisor")
    principal = make_user(first_name="Notify PI")
    workspace = make_workspace(owner)
    add_workspace_member(workspace, advisor)
    add_workspace_member(workspace, principal)
    enable_research(workspace, research_chain_enabled=True)
    suffix = uuid4().hex[:6].upper()
    project = Project.objects.create(
        workspace=workspace,
        name=f"Notify {suffix}",
        identifier=f"NT{suffix}",
        network=0,
        created_by=owner,
    )
    unit = OrgUnit.objects.create(
        workspace=workspace,
        name="Notify unit",
        unit_type=OrgUnit.UnitType.GROUP,
        depth=0,
        path="/notify/",
    )
    ResearchProjectProfile.objects.create(
        project=project,
        workspace=workspace,
        owner=owner,
        org_unit=unit,
        chain_kind=ResearchProjectProfile.ChainKind.RESEARCH_CHAIN,
        created_by=owner,
    )
    OrgUnitMember.objects.create(
        workspace=workspace,
        org_unit=unit,
        user=principal,
        org_role=OrgUnitMember.OrgRole.PI,
        is_primary=True,
    )
    OrgUnitMember.objects.create(
        workspace=workspace,
        org_unit=unit,
        user=advisor,
        org_role=OrgUnitMember.OrgRole.ADVISOR,
    )
    MentorBinding.objects.create(
        workspace=workspace,
        mentee=owner,
        mentor=advisor,
        org_unit=unit,
        is_primary_advisor=True,
    )
    chain = ResearchChain.objects.create(
        workspace=workspace,
        project=project,
        owner=owner,
        request_id=f"chain-{uuid4().hex}",
        payload_hash=uuid4().hex,
        created_by=owner,
    )
    initialize_chain_stages(chain, owner)

    def client(user):
        api_client = APIClient()
        api_client.force_authenticate(user=user)
        return api_client

    return {
        "owner": owner,
        "advisor": advisor,
        "principal": principal,
        "workspace": workspace,
        "chain": chain,
        "owner_client": client(owner),
        "advisor_client": client(advisor),
        "principal_client": client(principal),
    }


def url(env, suffix=""):
    return f"/api/research/workspaces/{env['workspace'].slug}/chains/{env['chain'].id}/stage-approvals/{suffix}"


def notifications(env, receiver):
    return Notification.objects.filter(entity_name="research_chain_stage", receiver=receiver)


def prepare_stage(env, stage_code):
    stage = env["chain"].stage_approvals.get(stage_code=stage_code)
    stage.status = "IN_PROGRESS"
    stage.save(update_fields=["status", "updated_at"])
    node = ResearchChainNode.objects.create(
        chain=env["chain"],
        node_type=stage_code if not stage_code.startswith("ANALYSIS_") else "ANALYSIS",
        title=f"{stage_code} notify node",
        request_id=f"node-{uuid4().hex}",
        payload_hash=uuid4().hex,
        created_by=env["owner"],
    )
    for requirement in stage.material_requirements.all():
        upload = ResearchChainUpload.objects.create(
            workspace=env["workspace"],
            chain=env["chain"],
            node=node,
            request_id=f"upload-{uuid4().hex}",
            payload_hash=uuid4().hex,
            knowledge_id=f"knowledge-{uuid4().hex[:8]}",
            knowledge_base_id="kb-notify",
            file_name=f"{requirement.code}.pdf",
            file_type="pdf",
            file_size=128,
            file_hash=uuid4().hex,
            status=ResearchChainUpload.Status.SUCCESS,
            created_by=env["owner"],
        )
        response = env["owner_client"].post(
            url(env, f"{stage_code}/materials/"),
            {
                "request_id": f"material-{upload.id}",
                "requirement_code": requirement.code,
                "upload_id": str(upload.id),
            },
            format="json",
        )
        assert response.status_code == 201, response.json()
    return stage, node


def test_submission_approval_and_replay_create_expected_notifications(env):
    stage, node = prepare_stage(env, "PRE_EXPERIMENT")
    request_id = f"submit-{uuid4().hex}"
    submitted = env["owner_client"].post(
        url(env, "PRE_EXPERIMENT/submit/"),
        {"request_id": request_id, "node_id": str(node.id)},
        format="json",
    )
    assert submitted.status_code == 200, submitted.json()
    assert notifications(env, env["advisor"]).filter(data__action="submitted").count() == 1

    review_id = f"review-{uuid4().hex}"
    reviewed = env["advisor_client"].post(
        url(env, "PRE_EXPERIMENT/review/"),
        {"request_id": review_id, "action": "APPROVE"},
        format="json",
    )
    assert reviewed.status_code == 200, reviewed.json()
    assert notifications(env, env["owner"]).filter(data__action="approved").count() == 1

    replay = env["advisor_client"].post(
        url(env, "PRE_EXPERIMENT/review/"),
        {"request_id": review_id, "action": "APPROVE"},
        format="json",
    )
    assert replay.status_code == 200
    assert notifications(env, env["owner"]).filter(data__action="approved").count() == 1
    stage.refresh_from_db()
    assert stage.status == "APPROVED"


def test_conditional_approval_false_finishes_without_pi_and_notifies_owner(env):
    _, node = prepare_stage(env, "EXPERIMENT")
    submitted = env["owner_client"].post(
        url(env, "EXPERIMENT/submit/"),
        {"request_id": f"submit-{uuid4().hex}", "node_id": str(node.id), "requires_pi": False},
        format="json",
    )
    assert submitted.status_code == 200, submitted.json()
    reviewed = env["advisor_client"].post(
        url(env, "EXPERIMENT/review/"),
        {"request_id": f"review-{uuid4().hex}", "action": "APPROVE", "escalate_to_pi": False},
        format="json",
    )
    assert reviewed.status_code == 200, reviewed.json()
    assert reviewed.json()["data"]["status"] == "APPROVED"
    assert notifications(env, env["principal"]).filter(data__action="escalated").count() == 0
    assert notifications(env, env["owner"]).filter(data__action="approved").count() == 1


def test_mine_todo_projects_pending_returned_and_approved_stages(env):
    stage, node = prepare_stage(env, "PRE_EXPERIMENT")
    env["owner_client"].post(
        url(env, "PRE_EXPERIMENT/submit/"),
        {"request_id": f"submit-{uuid4().hex}", "node_id": str(node.id)},
        format="json",
    )
    env["advisor_client"].post(
        url(env, "PRE_EXPERIMENT/review/"),
        {"request_id": f"review-{uuid4().hex}", "action": "RETURN", "comment": "请补充材料"},
        format="json",
    )
    returned = env["chain"].stage_approvals.get(stage_code="PRE_EXPERIMENT")
    approved_stage = env["chain"].stage_approvals.get(stage_code="SUMMARY")
    approved_stage.status = "APPROVED"
    approved_stage.submitted_at = timezone.now()
    approved_stage.save(update_fields=["status", "submitted_at", "updated_at"])

    mine = env["owner_client"].get(
        f"/api/research/workspaces/{env['workspace'].slug}/research-todos/",
        {"scope": "mine", "limit": 100},
    )
    assert mine.status_code == 200, mine.json()
    items = [item for item in mine.json()["results"] if item["source"] == "CHAIN_STAGE_APPROVAL"]
    by_status = {item["business_status"]: item for item in items}
    assert by_status[returned.status]["handling_status"] == "RETURNED"
    assert by_status[approved_stage.status]["handling_status"] == "DONE"

    to_me = env["advisor_client"].get(
        f"/api/research/workspaces/{env['workspace'].slug}/research-todos/",
        {"scope": "to_me", "limit": 100},
    )
    advisor_items = [
        item
        for item in to_me.json()["results"]
        if item["source"] == "CHAIN_STAGE_APPROVAL" and item["object_id"] == str(approved_stage.id)
    ]
    assert advisor_items == []
