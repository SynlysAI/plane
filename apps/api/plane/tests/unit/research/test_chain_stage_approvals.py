"""Research Chain thirteen-stage approval rule tests."""

from uuid import uuid4
from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path

import pytest
from django.apps import apps as django_apps
from django.db import connection
from django.utils import timezone

from plane.db.models import (
    MentorBinding,
    OrgUnit,
    OrgUnitMember,
    Project,
    ResearchChain,
    ResearchChainNode,
    ResearchChainStageMaterialItem,
    ResearchProjectProfile,
)
from plane.research.services.chain_stage_approvals import (
    CHAIN_STAGE_CODES,
    MATERIAL_REQUIREMENTS,
    ChainStageRuleError,
    create_stage_precheck,
    initialize_chain_stages,
    review_chain_stage,
    submit_chain_stage,
)
from plane.research.services.chain_stage_approvals import mark_chain_stage_in_progress
from plane.tests.research_fixtures import enable_research, make_user, make_workspace

pytestmark = pytest.mark.unit


@pytest.fixture
def env(db):
    owner = make_user(first_name="Stage owner")
    advisor = make_user(first_name="Direct advisor")
    principal = make_user(first_name="Principal investigator")
    workspace = make_workspace(owner)
    enable_research(workspace, research_chain_enabled=True)
    suffix = uuid4().hex[:6].upper()
    project = Project.objects.create(
        workspace=workspace,
        name=f"Stage project {suffix}",
        identifier=f"SA{suffix}",
        network=0,
        created_by=owner,
    )
    ResearchProjectProfile.objects.create(
        project=project,
        workspace=workspace,
        owner=owner,
        chain_kind=ResearchProjectProfile.ChainKind.RESEARCH_CHAIN,
        created_by=owner,
    )
    unit = OrgUnit.objects.create(
        workspace=workspace,
        name="阶段审批课题组",
        unit_type=OrgUnit.UnitType.GROUP,
        depth=0,
        path="/stage/",
    )
    OrgUnitMember.objects.create(
        workspace=workspace,
        org_unit=unit,
        user=principal,
        org_role=OrgUnitMember.OrgRole.PI,
        is_primary=True,
    )
    ResearchProjectProfile.objects.filter(project=project).update(org_unit=unit)
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
    return {
        "owner": owner,
        "advisor": advisor,
        "principal": principal,
        "workspace": workspace,
        "project": project,
        "chain": chain,
    }


def test_thirteen_stage_definitions_match_research_chain_process():
    assert CHAIN_STAGE_CODES == (
        "LITERATURE_REVIEW",
        "TOPIC_SELECTION",
        "TOPIC_EVALUATION",
        "PRE_EXPERIMENT",
        "ANALYSIS_PRE_EXPERIMENT",
        "OPENING",
        "EXPERIMENT",
        "ANALYSIS_EXPERIMENT",
        "ITERATION",
        "SUMMARY",
        "PAPER_WRITING",
        "COMPLETION",
        "TRANSFER",
    )
    assert len(MATERIAL_REQUIREMENTS) == len(CHAIN_STAGE_CODES)
    literature = MATERIAL_REQUIREMENTS["LITERATURE_REVIEW"]
    assert literature[0].minimum_count == 5


def test_initialize_chain_stages_is_idempotent(env):
    initialize_chain_stages(env["chain"], env["owner"])
    initialize_chain_stages(env["chain"], env["owner"])

    stages = env["chain"].stage_approvals.order_by("sort_order")
    assert [stage.stage_code for stage in stages] == list(CHAIN_STAGE_CODES)
    assert stages.first().status == "NOT_STARTED"
    assert stages.count() == 13
    assert sum(stage.material_requirements.count() for stage in stages) > 13


def fill_materials(stage, prefix="Material"):
    stage.status = "IN_PROGRESS"
    stage.save(update_fields=["status", "updated_at"])
    for requirement in stage.material_requirements.all():
        for index in range(requirement.minimum_count):
            ResearchChainStageMaterialItem.objects.create(
                stage=stage,
                requirement=requirement,
                title=f"{prefix} {requirement.code} {index + 1}",
                request_id=f"material-{stage.id}-{requirement.code}-{index}",
            )


def make_node(env, node_type, title="Stage node", parent_node=None):
    return ResearchChainNode.objects.create(
        chain=env["chain"],
        node_type=node_type,
        title=title,
        parent_node=parent_node,
        request_id=f"node-{uuid4().hex}",
        payload_hash=uuid4().hex,
        created_by=env["owner"],
    )


def node_type_for_stage(stage_code):
    return "ANALYSIS" if stage_code.startswith("ANALYSIS_") else stage_code


def test_submit_blocks_incomplete_materials(env):
    initialize_chain_stages(env["chain"], env["owner"])
    stage = env["chain"].stage_approvals.get(stage_code="LITERATURE_REVIEW")
    stage.status = "IN_PROGRESS"
    stage.save(update_fields=["status", "updated_at"])
    node = make_node(env, "LITERATURE_REVIEW")

    with pytest.raises(ChainStageRuleError) as error:
        submit_chain_stage(stage, env["owner"], node=node, request_id=f"submit-{uuid4().hex}")

    assert error.value.error_code == "research_chain_stage_material_incomplete"
    assert error.value.extra["missing"] == ["DIRECT_ORIGINAL_STUDIES"]


def test_advisor_only_stage_completes_after_direct_advisor(env):
    initialize_chain_stages(env["chain"], env["owner"])
    stage = env["chain"].stage_approvals.get(stage_code="PRE_EXPERIMENT")
    fill_materials(stage)
    node = make_node(env, "PRE_EXPERIMENT")

    submitted = submit_chain_stage(stage, env["owner"], node=node, request_id=f"submit-{uuid4().hex}")
    assert submitted.status == "AWAITING_ADVISOR"
    approved = review_chain_stage(stage, env["advisor"], action="APPROVE", request_id=f"review-{uuid4().hex}")

    assert approved.status == "APPROVED"
    approved.submitted_node.refresh_from_db()
    assert approved.submitted_node.status == "COMPLETED"


def test_fixed_pi_stage_requires_both_reviewers(env):
    initialize_chain_stages(env["chain"], env["owner"])
    stage = env["chain"].stage_approvals.get(stage_code="SUMMARY")
    fill_materials(stage)
    submit_chain_stage(
        stage,
        env["owner"],
        node=make_node(env, "SUMMARY"),
        request_id=f"submit-{uuid4().hex}",
    )

    after_advisor = review_chain_stage(stage, env["advisor"], action="APPROVE", request_id=f"advisor-{uuid4().hex}")
    assert after_advisor.status == "AWAITING_PI"

    after_pi = review_chain_stage(stage, env["principal"], action="APPROVE", request_id=f"pi-{uuid4().hex}")
    assert after_pi.status == "APPROVED"


def test_conditional_stage_requires_explicit_advisor_confirmation(env):
    initialize_chain_stages(env["chain"], env["owner"])
    stage = env["chain"].stage_approvals.get(stage_code="EXPERIMENT")
    fill_materials(stage)
    submit_chain_stage(
        stage,
        env["owner"],
        node=make_node(env, "EXPERIMENT"),
        request_id=f"submit-{uuid4().hex}",
        requires_pi=True,
        escalation_reason="Formal experiment start",
    )

    with pytest.raises(ChainStageRuleError):
        review_chain_stage(stage, env["advisor"], action="APPROVE", request_id=f"review-{uuid4().hex}")

    escalated = review_chain_stage(
        stage,
        env["advisor"],
        action="APPROVE",
        request_id=f"review-{uuid4().hex}",
        escalate_to_pi=True,
    )
    assert escalated.status == "AWAITING_PI"


def test_analysis_stage_uses_chain_structure_not_only_node_type(env):
    initialize_chain_stages(env["chain"], env["owner"])
    stage = env["chain"].stage_approvals.get(stage_code="ANALYSIS_PRE_EXPERIMENT")
    fill_materials(stage)
    experiment = make_node(env, "EXPERIMENT", "正式实验")
    analysis = make_node(env, "ANALYSIS", "实验分析", parent_node=experiment)

    with pytest.raises(ChainStageRuleError) as error:
        submit_chain_stage(stage, env["owner"], node=analysis, request_id=f"submit-{uuid4().hex}")

    assert error.value.error_code == "research_chain_invalid"


def test_return_requires_comment_and_resubmission_creates_new_attempt(env):
    initialize_chain_stages(env["chain"], env["owner"])
    stage = env["chain"].stage_approvals.get(stage_code="PRE_EXPERIMENT")
    fill_materials(stage)
    submit_chain_stage(stage, env["owner"], node=make_node(env, "PRE_EXPERIMENT"), request_id=f"submit-{uuid4().hex}")

    with pytest.raises(ChainStageRuleError):
        review_chain_stage(stage, env["advisor"], action="RETURN", request_id=f"return-{uuid4().hex}")

    returned = review_chain_stage(
        stage,
        env["advisor"],
        action="RETURN",
        comment="Please revise the plan.",
        request_id=f"return-{uuid4().hex}",
    )
    assert returned.status == "NEEDS_REVISION"
    assert returned.attempt_count == 1

    resubmitted = submit_chain_stage(
        stage,
        env["owner"],
        node=returned.submitted_node,
        request_id=f"submit-{uuid4().hex}",
    )
    assert resubmitted.attempt_count == 2
    assert resubmitted.status == "AWAITING_ADVISOR"


def test_chain_completes_only_after_all_thirteen_stages_are_approved(env):
    initialize_chain_stages(env["chain"], env["owner"])
    submitted_nodes = {}
    for stage in env["chain"].stage_approvals.order_by("sort_order"):
        fill_materials(stage, prefix=stage.stage_code)
        if stage.stage_code == "TOPIC_EVALUATION":
            create_stage_precheck(stage, env["owner"], request_id=f"precheck-{stage.id}")
        parent_node = None
        if stage.stage_code == "ANALYSIS_PRE_EXPERIMENT":
            parent_node = submitted_nodes["PRE_EXPERIMENT"]
        elif stage.stage_code == "ANALYSIS_EXPERIMENT":
            parent_node = submitted_nodes["EXPERIMENT"]
        stage_node = make_node(
            env,
            node_type_for_stage(stage.stage_code),
            stage.stage_code,
            parent_node=parent_node,
        )
        submitted_nodes[stage.stage_code] = stage_node
        submit_chain_stage(
            stage,
            env["owner"],
            node=stage_node,
            request_id=f"submit-{stage.id}",
        )
        stage = review_chain_stage(
            stage,
            env["advisor"],
            action="APPROVE",
            request_id=f"advisor-{stage.id}",
            escalate_to_pi=False,
        )
        if stage.status == "AWAITING_PI":
            stage = review_chain_stage(stage, env["principal"], action="APPROVE", request_id=f"pi-{stage.id}")
        stage.refresh_from_db()
        assert stage.status == "APPROVED"

    env["chain"].refresh_from_db()
    env["project"].research_profile.refresh_from_db()
    assert env["chain"].status == "COMPLETED"
    assert env["project"].research_profile.workflow_status == "COMPLETED"
    assert env["project"].research_profile.completed_at == timezone.localdate()


def test_mapped_node_creation_marks_only_its_parallel_stage_in_progress(env):
    initialize_chain_stages(env["chain"], env["owner"])
    transfer = make_node(env, "TRANSFER", "转化提前开始")

    stage = mark_chain_stage_in_progress(transfer)

    assert stage is not None
    assert stage.stage_code == "TRANSFER"
    assert stage.status == "IN_PROGRESS"
    assert env["chain"].stage_approvals.exclude(stage_code="TRANSFER").filter(status="IN_PROGRESS").exists() is False


def test_owner_and_wrong_review_step_cannot_review(env):
    initialize_chain_stages(env["chain"], env["owner"])
    stage = env["chain"].stage_approvals.get(stage_code="SUMMARY")
    fill_materials(stage)
    submit_chain_stage(
        stage,
        env["owner"],
        node=make_node(env, "SUMMARY"),
        request_id=f"submit-{uuid4().hex}",
    )

    with pytest.raises(ChainStageRuleError) as owner_error:
        review_chain_stage(stage, env["owner"], action="APPROVE", request_id=f"owner-{uuid4().hex}")
    assert owner_error.value.error_code == "research_permission_denied"

    with pytest.raises(ChainStageRuleError) as pi_error:
        review_chain_stage(stage, env["principal"], action="APPROVE", request_id=f"pi-{uuid4().hex}")
    assert pi_error.value.error_code == "research_chain_stage_reviewer_invalid"


def test_migration_seeds_existing_chain_with_thirteen_stages(env):
    migration_path = Path(__file__).parents[3] / "db/migrations/0192_research_chain_stage_approvals.py"
    spec = spec_from_file_location("research_chain_stage_approvals_migration", migration_path)
    assert spec is not None and spec.loader is not None
    module = module_from_spec(spec)
    spec.loader.exec_module(module)

    with connection.schema_editor() as schema_editor:
        module.Migration.seed_research_chain_stages(django_apps, schema_editor)

    stages = env["chain"].stage_approvals.order_by("sort_order")
    assert stages.count() == 13
    assert [stage.stage_code for stage in stages] == list(CHAIN_STAGE_CODES)
    assert stages.exclude(material_requirements__isnull=False).exists() is False
