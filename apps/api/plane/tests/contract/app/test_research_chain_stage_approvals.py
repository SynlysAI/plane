"""Research Chain stage approval API contract tests."""

import json
from datetime import timedelta
from uuid import uuid4

import pytest
from django.db import connection
from django.test.utils import CaptureQueriesContext
from django.utils import timezone
from rest_framework.test import APIClient

from plane.db.models import (
    MentorBinding,
    OrgUnit,
    OrgUnitMember,
    Project,
    ReportTemplate,
    ResearchAgentBackendConnection,
    ResearchAgentRunEvent,
    ResearchAgentSession,
    ResearchChain,
    ResearchChainNode,
    ResearchChainUpload,
    ResearchChainStageEvaluation,
    ResearchChainStageMaterialItem,
    ResearchContextGrant,
    ResearchProjectProfile,
)
from plane.research.services.chain_stage_approvals import (
    create_stage_precheck,
    initialize_chain_stages,
    precheck_material_version,
)
from plane.research.services.stage_evaluations import refresh_stage_evaluation
from plane.research.services import stage_evaluations
from plane.research.utils.templates import ensure_default_preopening_template
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


def complete_evaluation_materials(env, node):
    """Fill every stage-three requirement with successful upload links."""
    stage = env["chain"].stage_approvals.get(stage_code="TOPIC_EVALUATION")
    upload = make_upload(env, node, name="evaluation-evidence.pdf")
    for requirement in stage.material_requirements.all():
        ResearchChainStageMaterialItem.objects.create(
            stage=stage,
            requirement=requirement,
            title=upload.file_name,
            source_node=node,
            upload=upload,
            request_id=f"evaluation-material-{requirement.id}-{uuid4().hex[:8]}",
            created_by=env["owner"],
        )
    stage.status = "IN_PROGRESS"
    stage.save(update_fields=["status", "updated_at"])
    return stage


def make_agent_session(env, node, *, status=ResearchAgentSession.Status.READY):
    """Create one minimal persisted Agent session for evaluation contracts."""
    grant = make_context_grant(env, node)
    return ResearchAgentSession.objects.create(
        workspace=env["workspace"],
        user=env["owner"],
        project=env["chain"].project,
        research_chain=env["chain"],
        chain_node=node,
        context_grant=grant,
        provider=ResearchAgentSession.Provider.SCIENCE_DISCOVERY,
        status=status,
        sd_session_id=f"sd-{uuid4().hex[:8]}",
        sd_run_id=f"run-{uuid4().hex[:8]}",
        request_id=f"evaluation-session-{uuid4().hex}",
        payload_hash=uuid4().hex,
        created_by=env["owner"],
    )


def make_context_grant(env, node):
    """Create one short-lived context grant for an evaluation session."""
    return ResearchContextGrant.objects.create(
        workspace=env["workspace"],
        user=env["owner"],
        project=env["chain"].project,
        research_chain=env["chain"],
        chain_node=node,
        context_hash=uuid4().hex,
        token_hash=uuid4().hex,
        expires_at=timezone.now() + timedelta(hours=1),
        request_id=f"evaluation-grant-{uuid4().hex}",
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
    assert len(queries) < 41
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


def test_material_body_rejects_both_upload_and_text(env):
    response = env["owner_client"].post(
        url(env, "PRE_EXPERIMENT/materials/"),
        {
            "request_id": f"material-{uuid4().hex}",
            "requirement_code": "PRE_EXPERIMENT_PLAN",
            "upload_id": str(uuid4()),
            "content": "预实验方案",
        },
        format="json",
    )

    assert response.status_code == 422
    assert response.json()["error_code"] == "research_chain_invalid"


def test_stage_material_accepts_text_and_counts_it_towards_submission(env):
    node = ResearchChainNode.objects.create(
        chain=env["chain"],
        node_type="TOPIC_SELECTION",
        title="API topic text",
        request_id=f"node-{uuid4().hex}",
        payload_hash=uuid4().hex,
        created_by=env["owner"],
    )
    content = (
        "题目：面向金属化的单分子电导研究\n研究课题：光致变色分子的电输运调控\n研究问题：分子结环境如何影响反应动力学。"
    )
    payload = {
        "requirement_code": "RESEARCH_GOAL",
        "content": content,
        "title": "研究课题说明",
    }
    created = env["owner_client"].post(
        url(env, "TOPIC_SELECTION/materials/"),
        {**payload, "request_id": f"material-{uuid4().hex}"},
        format="json",
    )
    duplicate = env["owner_client"].post(
        url(env, "TOPIC_SELECTION/materials/"),
        {**payload, "request_id": f"material-{uuid4().hex}"},
        format="json",
    )

    assert created.status_code == 201, created.json()
    item = created.json()["data"]
    assert item["title"] == "研究课题说明"
    assert item["description"] == content
    assert item["upload"] is None
    assert item["source_node"] == str(node.id)
    assert duplicate.status_code == 409
    assert "重复" in duplicate.json()["message"]

    summary = env["owner_client"].get(url(env)).json()["data"]
    stage = next(row for row in summary["stages"] if row["stage_code"] == "TOPIC_SELECTION")
    material = next(row for row in stage["materials"] if row["code"] == "RESEARCH_GOAL")
    assert material["submitted_count"] == 1
    assert material["complete"] is True
    assert material["submission_state"] == "READY"


def test_stage_material_text_uses_bounded_default_title_and_content(env):
    long_content = "面" * 81
    invalid = env["owner_client"].post(
        url(env, "TOPIC_SELECTION/materials/"),
        {
            "request_id": f"material-{uuid4().hex}",
            "requirement_code": "RESEARCH_GOAL",
            "content": "x" * 50_001,
        },
        format="json",
    )
    created = env["owner_client"].post(
        url(env, "TOPIC_SELECTION/materials/"),
        {
            "request_id": f"material-{uuid4().hex}",
            "requirement_code": "RESEARCH_GOAL",
            "content": long_content,
        },
        format="json",
    )

    assert invalid.status_code == 422
    assert created.status_code == 201, created.json()
    assert created.json()["data"]["title"] == "面" * 80


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


def test_default_preopening_template_is_seeded_once(env):
    """The reusable five-criteria template is added without overriding later edits."""
    scoped_url = (
        f"/api/research/workspaces/{env['workspace'].slug}/report-templates/"
        "?scope=STAGE_MATERIAL&stage=PRE_OPENING&material_type=TOPIC_DESCRIPTION"
    )
    scoped = env["owner_client"].get(scoped_url)
    assert scoped.status_code == 200, scoped.json()
    assert scoped.json()["count"] == 1

    assert ensure_default_preopening_template(env["workspace"]) is None

    template = ReportTemplate.objects.get(
        workspace=env["workspace"],
        scope=ReportTemplate.Scope.STAGE_MATERIAL,
        stage="PRE_OPENING",
        material_type="TOPIC_DESCRIPTION",
        is_default=True,
    )
    sections = template.sections_json["sections"]
    assert [item["title"] for item in sections] == ["独特性", "创新性", "非做不可", "可行性", "非我莫属"]
    assert [item["max_chars"] for item in sections] == [100, 300, 200, 100, 100]

    template.is_active = False
    template.save(update_fields=["is_active", "updated_at"])
    assert ensure_default_preopening_template(env["workspace"]) is None
    template.refresh_from_db()
    assert template.is_active is False


def test_stage_evaluation_does_not_call_agent_when_material_is_incomplete(env, monkeypatch):
    ResearchChainNode.objects.create(
        chain=env["chain"],
        node_type="TOPIC_EVALUATION",
        title="Incomplete evaluation",
        request_id=f"node-{uuid4().hex}",
        payload_hash=uuid4().hex,
        created_by=env["owner"],
    )
    stage = env["chain"].stage_approvals.get(stage_code="TOPIC_EVALUATION")
    stage.status = "IN_PROGRESS"
    stage.save(update_fields=["status", "updated_at"])
    monkeypatch.setattr(
        "plane.research.services.stage_evaluations._create_agent_session",
        lambda *args, **kwargs: (_ for _ in ()).throw(AssertionError("agent must not run")),
    )

    response = env["owner_client"].post(
        url(env, "TOPIC_EVALUATION/evaluations/"),
        {"request_id": f"evaluation-{uuid4().hex}", "track": "BASIC"},
        format="json",
    )

    assert response.status_code == 422, response.json()
    assert response.json()["error_code"] == "research_chain_stage_material_incomplete"
    assert not ResearchChainStageEvaluation.objects.exists()


def test_stage_evaluation_pins_the_science_discovery_provider(env, monkeypatch):
    node = ResearchChainNode.objects.create(
        chain=env["chain"],
        node_type="TOPIC_EVALUATION",
        title="SD evaluation",
        request_id=f"node-{uuid4().hex}",
        payload_hash=uuid4().hex,
        created_by=env["owner"],
    )
    stage = complete_evaluation_materials(env, node)
    grant = make_context_grant(env, node)
    orchestrated = {"grant": grant, "assembly": {}, "sd_session_id": "sd-evaluation"}
    backend = ResearchAgentBackendConnection.objects.create(
        workspace=env["workspace"],
        user=env["owner"],
        system="SCIENCE_DISCOVERY",
        base_url="https://eva-cor.example.com",
        is_enabled=True,
    )
    monkeypatch.setattr(stage_evaluations, "resolve_science_discovery_connection", lambda *args, **kwargs: backend)
    monkeypatch.setattr(stage_evaluations, "create_science_discovery_session", lambda **kwargs: orchestrated)
    monkeypatch.setattr(stage_evaluations, "_start_agent_run", lambda *args, **kwargs: None)

    evaluation = stage_evaluations.create_stage_evaluation(
        stage,
        env["owner"],
        track="BASIC",
        request_id=f"evaluation-{uuid4().hex}",
    )

    assert evaluation.provider == "SCIENCE_DISCOVERY"
    assert evaluation.agent_session.provider == ResearchAgentSession.Provider.SCIENCE_DISCOVERY


def test_stage_evaluation_pins_the_synlora_provider(env, monkeypatch):
    from plane.research.views import agent as agent_view

    node = ResearchChainNode.objects.create(
        chain=env["chain"],
        node_type="TOPIC_EVALUATION",
        title="Synlora evaluation",
        request_id=f"node-{uuid4().hex}",
        payload_hash=uuid4().hex,
        created_by=env["owner"],
    )
    stage = complete_evaluation_materials(env, node)
    grant = make_context_grant(env, node)
    orchestrated = {"grant": grant, "assembly": {}, "synlora_session_id": "synlora-evaluation"}
    monkeypatch.setattr(stage_evaluations, "resolve_science_discovery_connection", lambda *args, **kwargs: None)
    monkeypatch.setattr(agent_view, "create_synlora_runtime_session", lambda **kwargs: orchestrated)
    monkeypatch.setattr(stage_evaluations, "_start_agent_run", lambda *args, **kwargs: None)

    evaluation = stage_evaluations.create_stage_evaluation(
        stage,
        env["owner"],
        track="APPLIED",
        request_id=f"evaluation-{uuid4().hex}",
    )

    assert evaluation.provider == "SYNLORA"
    assert evaluation.agent_session.provider == ResearchAgentSession.Provider.SYNLORA


def test_stage_evaluation_converges_from_existing_agent_events(env):
    node = ResearchChainNode.objects.create(
        chain=env["chain"],
        node_type="TOPIC_EVALUATION",
        title="Evaluation convergence",
        request_id=f"node-{uuid4().hex}",
        payload_hash=uuid4().hex,
        created_by=env["owner"],
    )
    stage = complete_evaluation_materials(env, node)
    precheck = create_stage_precheck(stage, env["owner"], request_id=f"precheck-{uuid4().hex}")
    session = make_agent_session(env, node)
    answer = {
        "subjournal_probability": 62,
        "conservative_probability": 48,
        "paper_tier": "Nature 子刊",
        "criteria": [
            {"code": "intelligence", "title": "智能化", "score": 4, "evidence": "与大模型闭环"},
            {"code": "moat", "title": "护城河", "score": 4, "evidence": "依赖自建表征数据"},
            {"code": "uniqueness", "title": "独特性", "score": 3, "evidence": "跨尺度表征"},
            {"code": "positioning", "title": "分级分类（顶天 / 立地）", "score": 4, "evidence": "面向子刊"},
            {"code": "irreplaceability", "title": "非我莫属", "score": 5, "evidence": "依赖独有仪器"},
        ],
        "risks": ["表征 uniqueness 不足"],
        "recommendations": ["补齐对照组"],
    }
    ResearchAgentRunEvent.objects.create(
        session=session,
        run_id=session.run_id,
        seq=1,
        event_type="OUTPUT",
        payload={
            "content": f"```json\n{json.dumps(answer, ensure_ascii=False)}\n```",
            "remote_seq": 1,
            "remote_type": "run.completed",
        },
        request_id=f"evaluation-output-{uuid4().hex}",
    )
    evaluation = ResearchChainStageEvaluation.objects.create(
        stage=stage,
        agent_session=session,
        track="BASIC",
        status="RUNNING",
        input_snapshot={"materials": []},
        material_version=precheck_material_version(precheck),
        prompt_version="topic-evaluation-deepseek.v1",
        provider="SCIENCE_DISCOVERY",
        model_version="deepseek-test",
        request_id=f"evaluation-{uuid4().hex}",
        created_by=env["owner"],
    )

    refreshed = refresh_stage_evaluation(evaluation)

    assert refreshed.status == "READY"
    assert refreshed.result["decision"] == "RETURN"
    assert refreshed.result["conservative_probability"] == 48
    assert refreshed.result["criteria"][0]["title"] == "智能化"


def test_basic_stage_evaluation_below_threshold_blocks_submission(env):
    node = ResearchChainNode.objects.create(
        chain=env["chain"],
        node_type="TOPIC_EVALUATION",
        title="Blocked basic evaluation",
        request_id=f"node-{uuid4().hex}",
        payload_hash=uuid4().hex,
        created_by=env["owner"],
    )
    stage = complete_evaluation_materials(env, node)
    precheck = create_stage_precheck(stage, env["owner"], request_id=f"precheck-{uuid4().hex}")
    session = make_agent_session(env, node)
    ResearchChainStageEvaluation.objects.create(
        stage=stage,
        agent_session=session,
        track="BASIC",
        status="READY",
        input_snapshot={},
        result={"decision": "RETURN", "conservative_probability": 45},
        material_version=precheck_material_version(precheck),
        prompt_version="topic-evaluation-deepseek.v1",
        provider="SCIENCE_DISCOVERY",
        model_version="deepseek-test",
        request_id=f"evaluation-{uuid4().hex}",
        created_by=env["owner"],
    )

    blocked = env["owner_client"].post(
        url(env, "TOPIC_EVALUATION/submit/"),
        {"request_id": f"submit-{uuid4().hex}", "node_id": str(node.id)},
        format="json",
    )

    assert blocked.status_code == 422, blocked.json()
    assert blocked.json()["error_code"] == "research_chain_stage_evaluation_blocked"


def test_applied_stage_evaluation_does_not_block_submission(env):
    node = ResearchChainNode.objects.create(
        chain=env["chain"],
        node_type="TOPIC_EVALUATION",
        title="Applied evaluation",
        request_id=f"node-{uuid4().hex}",
        payload_hash=uuid4().hex,
        created_by=env["owner"],
    )
    stage = complete_evaluation_materials(env, node)
    precheck = create_stage_precheck(stage, env["owner"], request_id=f"precheck-{uuid4().hex}")
    session = make_agent_session(env, node)
    ResearchChainStageEvaluation.objects.create(
        stage=stage,
        agent_session=session,
        track="APPLIED",
        status="READY",
        input_snapshot={},
        result={"decision": "ADVISORY", "conservative_probability": 20},
        material_version=precheck_material_version(precheck),
        prompt_version="topic-evaluation-deepseek.v1",
        provider="SCIENCE_DISCOVERY",
        model_version="deepseek-test",
        request_id=f"evaluation-{uuid4().hex}",
        created_by=env["owner"],
    )

    submitted = env["owner_client"].post(
        url(env, "TOPIC_EVALUATION/submit/"),
        {"request_id": f"submit-{uuid4().hex}", "node_id": str(node.id)},
        format="json",
    )

    assert submitted.status_code == 200, submitted.json()
    assert submitted.json()["data"]["status"] == "AWAITING_ADVISOR"


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
