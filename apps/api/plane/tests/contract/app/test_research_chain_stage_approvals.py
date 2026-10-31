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
    ResearchChainUpload,
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


def make_upload(env, node, *, status="SUCCESS", name="stage-material.pdf"):
    """Create one scoped upload projection for stage-material contract tests."""
    suffix = uuid4().hex
    return ResearchChainUpload.objects.create(
        workspace=env["workspace"],
        chain=env["chain"],
        node=node,
        request_id=f"upload-{suffix}",
        payload_hash=uuid4().hex,
        knowledge_id=f"knowledge-{suffix[:8]}",
        knowledge_base_id="kb-stage",
        file_name=name,
        file_type="pdf",
        file_size=1024,
        file_hash=uuid4().hex,
        status=status,
        created_by=env["owner"],
    )


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


def test_reviewer_projection_reports_a_stable_reason_code(env):
    OrgUnitMember.objects.filter(user=env["principal"]).delete()

    summary = env["owner_client"].get(url(env)).json()["data"]
    stage = next(item for item in summary["stages"] if item["stage_code"] == "SUMMARY")
    assert stage["principal_investigator"]["user"] is None
    assert stage["principal_investigator"]["reason_code"] == "research_chain_stage_reviewer_not_configured"
    assert stage["advisor"]["reason_code"] is None


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


def test_material_body_requires_an_explicit_upload(env):
    response = env["owner_client"].post(
        url(env, "PRE_EXPERIMENT/materials/"),
        {
            "request_id": f"material-{uuid4().hex}",
            "requirement_code": "PRE_EXPERIMENT_PLAN",
            "title": "Legacy title-only material",
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
    upload = make_upload(env, node)
    material = env["owner_client"].post(
        url(env, "PRE_EXPERIMENT/materials/"),
        {
            "request_id": f"material-{uuid4().hex}",
            "requirement_code": "PRE_EXPERIMENT_PLAN",
            "upload_id": str(upload.id),
        },
        format="json",
    )
    assert material.status_code == 201, material.json()
    assert material.json()["data"]["title"] == "stage-material.pdf"
    assert material.json()["data"]["upload_detail"]["file_name"] == "stage-material.pdf"

    summary = env["owner_client"].get(url(env)).json()["data"]
    pre_experiment = next(item for item in summary["stages"] if item["stage_code"] == "PRE_EXPERIMENT")
    assert pre_experiment["materials"][0]["submitted_count"] == 1
    assert pre_experiment["materials"][0]["complete"] is True

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

    summary = env["owner_client"].get(url(env)).json()["data"]
    stage = next(item for item in summary["stages"] if item["stage_code"] == "PRE_EXPERIMENT")
    snapshot = stage["review_actions"][0]["material_snapshot"][0]
    assert snapshot["items"][0]["upload"]["file_name"] == "stage-material.pdf"
    assert snapshot["items"][0]["upload"]["download_url"].endswith("/download/")


def test_processing_upload_can_be_linked_but_does_not_satisfy_requirement(env):
    node = ResearchChainNode.objects.create(
        chain=env["chain"],
        node_type="PRE_EXPERIMENT",
        title="API processing material",
        request_id=f"node-{uuid4().hex}",
        payload_hash=uuid4().hex,
        created_by=env["owner"],
    )
    upload = make_upload(env, node, status="PROCESSING", name="processing-plan.pdf")
    linked = env["owner_client"].post(
        url(env, "PRE_EXPERIMENT/materials/"),
        {
            "request_id": f"material-{uuid4().hex}",
            "requirement_code": "PRE_EXPERIMENT_PLAN",
            "upload_id": str(upload.id),
        },
        format="json",
    )
    assert linked.status_code == 201, linked.json()

    summary = env["owner_client"].get(url(env)).json()["data"]
    material = next(stage for stage in summary["stages"] if stage["stage_code"] == "PRE_EXPERIMENT")["materials"][0]
    assert material["submitted_count"] == 0
    assert material["complete"] is False
    assert material["submission_state"] == "PROCESSING"
    assert material["processing_count"] == 1

    submitted = env["owner_client"].post(
        url(env, "PRE_EXPERIMENT/submit/"),
        {"request_id": f"submit-{uuid4().hex}", "node_id": str(node.id)},
        format="json",
    )
    assert submitted.status_code == 422
    assert submitted.json()["error_code"] == "research_chain_stage_material_incomplete"

    upload.status = ResearchChainUpload.Status.SUCCESS
    upload.save(update_fields=["status", "updated_at"])
    summary = env["owner_client"].get(url(env)).json()["data"]
    material = next(stage for stage in summary["stages"] if stage["stage_code"] == "PRE_EXPERIMENT")["materials"][0]
    assert material["submitted_count"] == 1
    assert material["submission_state"] == "READY"


def test_failed_upload_is_recoverable_and_reports_single_failed_state(env):
    node = ResearchChainNode.objects.create(
        chain=env["chain"],
        node_type="PRE_EXPERIMENT",
        title="API failed material",
        request_id=f"node-{uuid4().hex}",
        payload_hash=uuid4().hex,
        created_by=env["owner"],
    )
    upload = make_upload(env, node, status="PROCESSING", name="later-failed.pdf")
    assert (
        env["owner_client"]
        .post(
            url(env, "PRE_EXPERIMENT/materials/"),
            {
                "request_id": f"material-{uuid4().hex}",
                "requirement_code": "PRE_EXPERIMENT_PLAN",
                "upload_id": str(upload.id),
            },
            format="json",
        )
        .status_code
        == 201
    )
    upload.status = ResearchChainUpload.Status.FAILED
    upload.error_code = "parse_failed"
    upload.save(update_fields=["status", "error_code", "updated_at"])

    material = next(
        stage
        for stage in env["owner_client"].get(url(env)).json()["data"]["stages"]
        if stage["stage_code"] == "PRE_EXPERIMENT"
    )["materials"][0]
    assert material["submission_state"] == "FAILED"
    assert material["failed_count"] == 1
    assert material["submitted_count"] == 0


def test_conditional_review_requires_an_explicit_boolean_payload(env):
    from plane.db.models import ResearchChainStageMaterialItem

    node = ResearchChainNode.objects.create(
        chain=env["chain"],
        node_type="EXPERIMENT",
        title="API conditional review",
        request_id=f"node-{uuid4().hex}",
        payload_hash=uuid4().hex,
        created_by=env["owner"],
    )
    stage = env["chain"].stage_approvals.get(stage_code="EXPERIMENT")
    stage.status = "IN_PROGRESS"
    stage.save(update_fields=["status", "updated_at"])
    for requirement in stage.material_requirements.all():
        upload = make_upload(env, node, name=f"{requirement.code}.pdf")
        ResearchChainStageMaterialItem.objects.create(
            stage=stage,
            requirement=requirement,
            title=upload.file_name,
            source_node=node,
            upload=upload,
            request_id=f"material-{upload.id}",
            created_by=env["owner"],
        )
    submitted = env["owner_client"].post(
        url(env, "EXPERIMENT/submit/"),
        {
            "request_id": f"submit-{uuid4().hex}",
            "node_id": str(node.id),
            "requires_pi": False,
        },
        format="json",
    )
    assert submitted.status_code == 200, submitted.json()

    missing = env["advisor_client"].post(
        url(env, "EXPERIMENT/review/"),
        {"request_id": f"review-{uuid4().hex}", "action": "APPROVE"},
        format="json",
    )
    assert missing.status_code == 422
    assert missing.json()["error_code"] == "research_chain_stage_escalation_confirm_required"

    rejected = env["advisor_client"].post(
        url(env, "EXPERIMENT/review/"),
        {"request_id": f"review-{uuid4().hex}", "action": "APPROVE", "escalate_to_pi": "false"},
        format="json",
    )
    assert rejected.status_code == 422
    assert rejected.json()["error_code"] == "research_chain_stage_escalation_confirm_required"

    completed = env["advisor_client"].post(
        url(env, "EXPERIMENT/review/"),
        {"request_id": f"review-{uuid4().hex}", "action": "APPROVE", "escalate_to_pi": False},
        format="json",
    )
    assert completed.status_code == 200, completed.json()
    assert completed.json()["data"]["status"] == "APPROVED"


def test_always_pi_submission_blocks_before_stage_submission_without_unique_pi(env):
    from plane.db.models import ResearchChainStageMaterialItem

    node = ResearchChainNode.objects.create(
        chain=env["chain"],
        node_type="SUMMARY",
        title="API summary",
        request_id=f"node-{uuid4().hex}",
        payload_hash=uuid4().hex,
        created_by=env["owner"],
    )
    stage = env["chain"].stage_approvals.get(stage_code="SUMMARY")
    stage.status = "IN_PROGRESS"
    stage.save(update_fields=["status", "updated_at"])
    for requirement in stage.material_requirements.all():
        upload = make_upload(env, node, name=f"{requirement.code}.pdf")
        ResearchChainStageMaterialItem.objects.create(
            stage=stage,
            requirement=requirement,
            title=upload.file_name,
            source_node=node,
            upload=upload,
            request_id=f"material-{upload.id}",
            created_by=env["owner"],
        )
    OrgUnitMember.objects.filter(user=env["principal"]).delete()

    response = env["owner_client"].post(
        url(env, "SUMMARY/submit/"),
        {"request_id": f"submit-{uuid4().hex}", "node_id": str(node.id)},
        format="json",
    )
    assert response.status_code == 422
    assert response.json()["error_code"] == "research_chain_stage_reviewer_not_configured"
    assert response.json()["role"] == "PI"


def test_five_original_study_uploads_complete_literature_review_requirement(env):
    """Five distinct uploads satisfy the original-studies requirement."""
    node = ResearchChainNode.objects.create(
        chain=env["chain"],
        node_type="LITERATURE_REVIEW",
        title="API literature review",
        request_id=f"node-{uuid4().hex}",
        payload_hash=uuid4().hex,
        created_by=env["owner"],
    )

    for index in range(1, 6):
        upload = make_upload(env, node, name=f"original-study-{index}.pdf")
        response = env["owner_client"].post(
            url(env, "LITERATURE_REVIEW/materials/"),
            {
                "request_id": f"material-{uuid4().hex}",
                "requirement_code": "DIRECT_ORIGINAL_STUDIES",
                "upload_id": str(upload.id),
            },
            format="json",
        )
        assert response.status_code == 201, response.json()

    summary = env["owner_client"].get(url(env)).json()["data"]
    literature_review = next(item for item in summary["stages"] if item["stage_code"] == "LITERATURE_REVIEW")
    original_studies = next(
        material for material in literature_review["materials"] if material["code"] == "DIRECT_ORIGINAL_STUDIES"
    )
    assert original_studies["submitted_count"] == 5
    assert original_studies["complete"] is True


def test_four_success_and_one_processing_do_not_complete_five_file_requirement(env):
    node = ResearchChainNode.objects.create(
        chain=env["chain"],
        node_type="LITERATURE_REVIEW",
        title="API mixed literature status",
        request_id=f"node-{uuid4().hex}",
        payload_hash=uuid4().hex,
        created_by=env["owner"],
    )
    for index in range(4):
        upload = make_upload(env, node, name=f"success-{index}.pdf")
        response = env["owner_client"].post(
            url(env, "LITERATURE_REVIEW/materials/"),
            {
                "request_id": f"material-{upload.id}",
                "requirement_code": "DIRECT_ORIGINAL_STUDIES",
                "upload_id": str(upload.id),
            },
            format="json",
        )
        assert response.status_code == 201
    processing = make_upload(env, node, status="PROCESSING", name="processing.pdf")
    response = env["owner_client"].post(
        url(env, "LITERATURE_REVIEW/materials/"),
        {
            "request_id": f"material-{processing.id}",
            "requirement_code": "DIRECT_ORIGINAL_STUDIES",
            "upload_id": str(processing.id),
        },
        format="json",
    )
    assert response.status_code == 201

    summary = env["owner_client"].get(url(env)).json()["data"]
    material = next(stage for stage in summary["stages"] if stage["stage_code"] == "LITERATURE_REVIEW")["materials"][0]
    assert material["submitted_count"] == 4
    assert material["processing_count"] == 1
    assert material["complete"] is False
    assert material["submission_state"] == "PROCESSING"


def test_stage_material_rejects_failed_upload_and_duplicate_requirement_link(env):
    node = ResearchChainNode.objects.create(
        chain=env["chain"],
        node_type="PRE_EXPERIMENT",
        title="API failed upload",
        request_id=f"node-{uuid4().hex}",
        payload_hash=uuid4().hex,
        created_by=env["owner"],
    )
    failed = make_upload(env, node, status="FAILED")
    failed_response = env["owner_client"].post(
        url(env, "PRE_EXPERIMENT/materials/"),
        {
            "request_id": f"material-{uuid4().hex}",
            "requirement_code": "PRE_EXPERIMENT_PLAN",
            "upload_id": str(failed.id),
        },
        format="json",
    )
    assert failed_response.status_code == 422

    upload = make_upload(env, node, name="plan.pdf")
    invalid_requirement = env["owner_client"].post(
        url(env, "PRE_EXPERIMENT/materials/"),
        {
            "request_id": f"material-{uuid4().hex}",
            "requirement_code": "UNKNOWN_REQUIREMENT",
            "upload_id": str(upload.id),
        },
        format="json",
    )
    assert invalid_requirement.status_code == 422
    assert invalid_requirement.json()["error_code"] == "research_chain_invalid"

    payload = {
        "requirement_code": "PRE_EXPERIMENT_PLAN",
        "upload_id": str(upload.id),
    }
    first = env["owner_client"].post(
        url(env, "PRE_EXPERIMENT/materials/"),
        {**payload, "request_id": f"material-{uuid4().hex}"},
        format="json",
    )
    duplicate = env["owner_client"].post(
        url(env, "PRE_EXPERIMENT/materials/"),
        {**payload, "request_id": f"material-{uuid4().hex}"},
        format="json",
    )
    assert first.status_code == 201, first.json()
    assert duplicate.status_code == 409
    assert "already linked" in duplicate.json()["message"]

    summary = env["owner_client"].get(url(env)).json()["data"]
    pre_experiment = next(item for item in summary["stages"] if item["stage_code"] == "PRE_EXPERIMENT")
    assert pre_experiment["materials"][0]["submitted_count"] == 1


def test_stage_material_cannot_link_an_upload_from_another_chain(env):
    other_project = Project.objects.create(
        workspace=env["workspace"],
        name=f"Stage API other {uuid4().hex[:6].upper()}",
        identifier=f"SO{uuid4().hex[:6].upper()}",
        network=0,
        created_by=env["owner"],
    )
    other_chain = ResearchChain.objects.create(
        workspace=env["workspace"],
        project=other_project,
        owner=env["owner"],
        request_id=f"chain-{uuid4().hex}",
        payload_hash=uuid4().hex,
        created_by=env["owner"],
    )
    other_node = ResearchChainNode.objects.create(
        chain=other_chain,
        node_type="PRE_EXPERIMENT",
        title="Other chain node",
        request_id=f"node-{uuid4().hex}",
        payload_hash=uuid4().hex,
        created_by=env["owner"],
    )
    other_upload = ResearchChainUpload.objects.create(
        workspace=env["workspace"],
        chain=other_chain,
        node=other_node,
        request_id=f"upload-{uuid4().hex}",
        payload_hash=uuid4().hex,
        file_name="other-chain.pdf",
        file_type="pdf",
        file_size=512,
        file_hash=uuid4().hex,
        status=ResearchChainUpload.Status.SUCCESS,
        created_by=env["owner"],
    )

    response = env["owner_client"].post(
        url(env, "PRE_EXPERIMENT/materials/"),
        {
            "request_id": f"material-{uuid4().hex}",
            "requirement_code": "PRE_EXPERIMENT_PLAN",
            "upload_id": str(other_upload.id),
        },
        format="json",
    )

    assert response.status_code == 422
    assert "upload_id must reference an upload in this chain" in response.json()["message"]


def test_legacy_title_only_material_no_longer_satisfies_submission(env):
    from plane.db.models import ResearchChainStageMaterialItem

    node = ResearchChainNode.objects.create(
        chain=env["chain"],
        node_type="PRE_EXPERIMENT",
        title="API legacy material",
        request_id=f"node-{uuid4().hex}",
        payload_hash=uuid4().hex,
        created_by=env["owner"],
    )
    stage = env["chain"].stage_approvals.get(stage_code="PRE_EXPERIMENT")
    requirement = stage.material_requirements.get(code="PRE_EXPERIMENT_PLAN")
    stage.status = "IN_PROGRESS"
    stage.save(update_fields=["status", "updated_at"])
    ResearchChainStageMaterialItem.objects.create(
        stage=stage,
        requirement=requirement,
        title="Legacy title-only plan",
        source_node=node,
        request_id=f"legacy-{uuid4().hex}",
        created_by=env["owner"],
    )

    summary = env["owner_client"].get(url(env)).json()["data"]
    projected = next(item for item in summary["stages"] if item["stage_code"] == "PRE_EXPERIMENT")
    assert projected["materials"][0]["items"][0]["upload_detail"] is None
    assert projected["materials"][0]["submitted_count"] == 0
    assert projected["materials"][0]["complete"] is False

    submitted = env["owner_client"].post(
        url(env, "PRE_EXPERIMENT/submit/"),
        {"request_id": f"submit-{uuid4().hex}", "node_id": str(node.id)},
        format="json",
    )
    assert submitted.status_code == 422


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
    upload = make_upload(env, node, name="evaluation.pdf")
    for requirement in stage.material_requirements.all():
        env["owner_client"].post(
            url(env, "TOPIC_EVALUATION/materials/"),
            {
                "request_id": f"material-{requirement.id}-{uuid4().hex[:8]}",
                "requirement_code": requirement.code,
                "upload_id": str(upload.id),
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
    upload = make_upload(env, node, name="pre-experiment.pdf")
    env["owner_client"].post(
        url(env, "PRE_EXPERIMENT/materials/"),
        {
            "request_id": f"material-{uuid4().hex}",
            "requirement_code": "PRE_EXPERIMENT_PLAN",
            "upload_id": str(upload.id),
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
