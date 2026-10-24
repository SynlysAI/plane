"""Research Chain stage approval API contract tests."""

from uuid import uuid4

import pytest
from django.db import connection
from django.test.utils import CaptureQueriesContext
from rest_framework.test import APIClient

from plane.db.models import (
    MentorBinding,
    OrgUnit,
    OrgUnitMember,
    Project,
    ResearchChain,
    ResearchChainNode,
    ResearchProjectProfile,
)
from plane.research.services.chain_stage_approvals import initialize_chain_stages
from plane.tests.research_fixtures import add_workspace_member, enable_research, make_user, make_workspace

pytestmark = pytest.mark.contract


def _client(user):
    client = APIClient()
    client.force_authenticate(user=user)
    return client


@pytest.fixture
def env(db):
    owner = make_user(first_name="API owner")
    advisor = make_user(first_name="API advisor")
    principal = make_user(first_name="API PI")
    workspace = make_workspace(owner)
    add_workspace_member(workspace, advisor)
    add_workspace_member(workspace, principal)
    enable_research(workspace, research_chain_enabled=True)
    suffix = uuid4().hex[:6].upper()
    project = Project.objects.create(
        workspace=workspace,
        name=f"Stage API {suffix}",
        identifier=f"SC{suffix}",
        network=0,
        created_by=owner,
    )
    unit = OrgUnit.objects.create(
        workspace=workspace,
        name="Stage API unit",
        unit_type=OrgUnit.UnitType.GROUP,
        depth=0,
        path="/stage-api/",
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
    return {
        "owner": owner,
        "advisor": advisor,
        "principal": principal,
        "workspace": workspace,
        "chain": chain,
        "owner_client": _client(owner),
        "advisor_client": _client(advisor),
        "principal_client": _client(principal),
    }


def url(env, suffix=""):
    return f"/api/research/workspaces/{env['workspace'].slug}/chains/{env['chain'].id}/stage-approvals/{suffix}"


def test_stage_list_returns_thirteen_stages_and_progress(env):
    response = env["owner_client"].get(url(env))

    assert response.status_code == 200, response.json()
    data = response.json()["data"]
    assert len(data["stages"]) == 13
    assert data["progress"] == {
        "total": 13,
        "approved": 0,
        "awaiting_advisor": 0,
        "awaiting_pi": 0,
        "needs_revision": 0,
        "in_progress": 0,
        "not_started": 13,
    }


def test_stage_list_query_count_is_bounded(env):
    """Stage list serialization must not regress into per-stage N+1 queries."""
    assert env["owner_client"].get(url(env)).status_code == 200

    with CaptureQueriesContext(connection) as capture:
        response = env["owner_client"].get(url(env))

    assert response.status_code == 200, response.json()
    queries = [query["sql"] for query in capture.captured_queries]
    assert len(queries) < 40
    assert sum("research_chain_stage_material_requirements" in sql for sql in queries) <= 4
    assert sum("research_chain_stage_material_items" in sql for sql in queries) <= 4
    assert sum("mentor_bindings" in sql for sql in queries) <= 2
    assert sum("org_unit_members" in sql for sql in queries) <= 2


def test_creating_a_later_stage_node_does_not_require_earlier_approval(env):
    created = env["owner_client"].post(
        f"/api/research/workspaces/{env['workspace'].slug}/chains/{env['chain'].id}/nodes/",
        {
            "request_id": f"node-{uuid4().hex}",
            "node_type": "TRANSFER",
            "title": "提前启动转化",
        },
        format="json",
    )
    summary = env["owner_client"].get(url(env))

    assert created.status_code == 201, created.json()
    stages = {stage["stage_code"]: stage for stage in summary.json()["data"]["stages"]}
    assert stages["TRANSFER"]["status"] == "IN_PROGRESS"
    assert stages["LITERATURE_REVIEW"]["status"] == "NOT_STARTED"


def test_material_body_uses_bounded_ids_and_lengths(env):
    response = env["owner_client"].post(
        url(env, "PRE_EXPERIMENT/materials/"),
        {
            "request_id": "x" * 129,
            "requirement_code": "PRE_EXPERIMENT_PLAN",
            "title": "Too long request id",
        },
        format="json",
    )
    assert response.status_code == 422
    assert response.json()["error_code"] == "research_chain_invalid"


def test_material_submit_and_review_flow(env):
    node = ResearchChainNode.objects.create(
        chain=env["chain"],
        node_type="PRE_EXPERIMENT",
        title="API pre-experiment",
        request_id=f"node-{uuid4().hex}",
        payload_hash=uuid4().hex,
        created_by=env["owner"],
    )
    material = env["owner_client"].post(
        url(env, "PRE_EXPERIMENT/materials/"),
        {
            "request_id": f"material-{uuid4().hex}",
            "requirement_code": "PRE_EXPERIMENT_PLAN",
            "title": "Pre-experiment plan",
            "source_node_id": str(node.id),
        },
        format="json",
    )
    assert material.status_code == 201, material.json()

    submitted = env["owner_client"].post(
        url(env, "PRE_EXPERIMENT/submit/"),
        {"request_id": f"submit-{uuid4().hex}", "node_id": str(node.id)},
        format="json",
    )
    assert submitted.status_code == 200, submitted.json()
    assert submitted.json()["data"]["status"] == "AWAITING_ADVISOR"

    todos = env["advisor_client"].get(
        f"/api/research/workspaces/{env['workspace'].slug}/research-todos/",
        {"scope": "to_me"},
    )
    assert todos.status_code == 200, todos.json()
    approval_todos = [item for item in todos.json()["results"] if item["source"] == "CHAIN_STAGE_APPROVAL"]
    assert approval_todos[0]["href"].endswith("tab=nodes&stage=pre_experiment&approval=1")

    reviewed = env["advisor_client"].post(
        url(env, "PRE_EXPERIMENT/review/"),
        {"request_id": f"review-{uuid4().hex}", "action": "APPROVE"},
        format="json",
    )
    assert reviewed.status_code == 200, reviewed.json()
    assert reviewed.json()["data"]["status"] == "APPROVED"


def test_topic_evaluation_precheck_is_required_before_submission(env):
    stage = env["chain"].stage_approvals.get(stage_code="TOPIC_EVALUATION")
    node = ResearchChainNode.objects.create(
        chain=env["chain"],
        node_type="TOPIC_EVALUATION",
        title="API evaluation",
        request_id=f"node-{uuid4().hex}",
        payload_hash=uuid4().hex,
        created_by=env["owner"],
    )
    for requirement in stage.material_requirements.all():
        env["owner_client"].post(
            url(env, "TOPIC_EVALUATION/materials/"),
            {
                "request_id": f"material-{requirement.id}-{uuid4().hex[:8]}",
                "requirement_code": requirement.code,
                "title": requirement.title,
            },
            format="json",
        )
    submitted = env["owner_client"].post(
        url(env, "TOPIC_EVALUATION/submit/"),
        {"request_id": f"submit-{uuid4().hex}", "node_id": str(node.id)},
        format="json",
    )
    assert submitted.status_code == 422
    assert submitted.json()["error_code"] == "research_chain_stage_precheck_required"

    precheck = env["owner_client"].post(
        url(env, "TOPIC_EVALUATION/precheck/"),
        {"request_id": f"precheck-{uuid4().hex}"},
        format="json",
    )
    assert precheck.status_code == 201, precheck.json()
    assert precheck.json()["data"]["status"] == "READY"
    assert precheck.json()["data"]["material_version"]
    assert precheck.json()["data"]["is_current"] is True


def test_review_idempotency_replay_rejects_a_different_reviewer(env):
    node = ResearchChainNode.objects.create(
        chain=env["chain"],
        node_type="PRE_EXPERIMENT",
        title="Replay review",
        request_id=f"node-{uuid4().hex}",
        payload_hash=uuid4().hex,
        created_by=env["owner"],
    )
    env["owner_client"].post(
        url(env, "PRE_EXPERIMENT/materials/"),
        {
            "request_id": f"material-{uuid4().hex}",
            "requirement_code": "PRE_EXPERIMENT_PLAN",
            "title": "Pre-experiment plan",
        },
        format="json",
    )
    env["owner_client"].post(
        url(env, "PRE_EXPERIMENT/submit/"),
        {"request_id": f"submit-{uuid4().hex}", "node_id": str(node.id)},
        format="json",
    )
    review_payload = {"request_id": f"review-{uuid4().hex}", "action": "APPROVE"}
    reviewed = env["advisor_client"].post(url(env, "PRE_EXPERIMENT/review/"), review_payload, format="json")
    replay = env["principal_client"].post(url(env, "PRE_EXPERIMENT/review/"), review_payload, format="json")

    assert reviewed.status_code == 200, reviewed.json()
    assert replay.status_code == 403
    assert replay.json()["error_code"] == "research_permission_denied"


def test_legacy_node_transition_cannot_bypass_stage_approval(env):
    node = ResearchChainNode.objects.create(
        chain=env["chain"],
        node_type="PRE_EXPERIMENT",
        title="Legacy transition",
        status="WAITING_HUMAN",
        request_id=f"node-{uuid4().hex}",
        payload_hash=uuid4().hex,
        created_by=env["owner"],
    )
    response = env["owner_client"].post(
        f"/api/research/workspaces/{env['workspace'].slug}/nodes/{node.id}/transitions/",
        {"request_id": f"transition-{uuid4().hex}", "action": "APPROVE"},
        format="json",
    )
    assert response.status_code == 409
    assert response.json()["error_code"] == "research_chain_stage_state_conflict"
