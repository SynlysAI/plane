"""Rules and initialization for the thirteen-stage Research Chain approvals."""

from dataclasses import dataclass

from django.conf import settings
from django.db import transaction
from django.db.models import Count, Max, Q
from django.utils import timezone
from rest_framework import status

from plane.preview.service import file_kind
from plane.research.utils.audit import (
    ResearchAuditAction,
    ResearchResourceType,
    record_audit_event,
)
from plane.research.utils.chain_stage_notifications import (
    notify_chain_stage_decided,
    notify_chain_stage_escalated,
    notify_chain_stage_submitted,
)
from plane.research.utils.errors import ResearchErrorCode
from plane.research.utils.org import active_membership_q


CHAIN_STAGE_CODES = (
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

ASSOCIABLE_UPLOAD_STATUSES = {"PENDING", "PROCESSING", "SUCCESS"}
SATISFYING_UPLOAD_STATUSES = {"SUCCESS"}
PROCESSING_UPLOAD_STATUSES = {"PENDING", "PROCESSING"}
FAILED_UPLOAD_STATUSES = {"FAILED", "DEGRADED"}


@dataclass(frozen=True)
class MaterialRule:
    """One immutable stage material definition."""

    code: str
    title: str
    minimum_count: int = 1


@dataclass(frozen=True)
class StageRule:
    """Review routing and material rules for one fixed stage."""

    code: str
    pi_policy: str
    materials: tuple[MaterialRule, ...]


def _stage(code, pi_policy, materials):
    return StageRule(code=code, pi_policy=pi_policy, materials=tuple(materials))


STAGE_RULES = (
    _stage(
        "LITERATURE_REVIEW",
        "ADVISOR_ONLY",
        (MaterialRule("DIRECT_ORIGINAL_STUDIES", "直接相关原创研究", 5),),
    ),
    _stage(
        "TOPIC_SELECTION",
        "ADVISOR_ONLY",
        (
            MaterialRule("TOPIC_TITLE", "题目"),
            MaterialRule("RESEARCH_QUESTION", "研究问题"),
            MaterialRule("RESEARCH_GOAL", "研究目标"),
            MaterialRule("INNOVATION_POINTS", "创新点"),
            MaterialRule("EXPECTED_OUTPUTS", "预期成果"),
        ),
    ),
    _stage(
        "TOPIC_EVALUATION",
        "ALWAYS_PI",
        (
            MaterialRule("PRINCIPLE_FEASIBILITY", "原理可行性分析"),
            MaterialRule("LAB_CONDITIONS", "实验室条件"),
            MaterialRule("BUDGET", "经费"),
            MaterialRule("TIME_PLAN", "时间安排"),
        ),
    ),
    _stage("PRE_EXPERIMENT", "ADVISOR_ONLY", (MaterialRule("PRE_EXPERIMENT_PLAN", "预实验方案"),)),
    _stage(
        "ANALYSIS_PRE_EXPERIMENT",
        "ADVISOR_ONLY",
        (
            MaterialRule("RAW_DATA", "原始数据"),
            MaterialRule("ANALYSIS_METHOD", "分析方法"),
            MaterialRule("RESULT_REPORT", "结果报告"),
        ),
    ),
    _stage(
        "OPENING",
        "ADVISOR_ONLY",
        (
            MaterialRule("OPENING_REPORT", "完整开题报告"),
            MaterialRule("RESEARCH_BACKGROUND", "研究背景"),
            MaterialRule("OPENING_GOALS", "目标"),
            MaterialRule("OPENING_METHODS", "方法"),
            MaterialRule("OPENING_SCHEDULE", "进度"),
            MaterialRule("OPENING_RISKS", "风险"),
            MaterialRule("OPENING_EXPECTED_OUTPUTS", "预期成果"),
        ),
    ),
    _stage(
        "EXPERIMENT",
        "CONDITIONAL_PI",
        (
            MaterialRule("FORMAL_EXPERIMENT_PLAN", "正式实验方案"),
            MaterialRule("SOP", "SOP"),
            MaterialRule("EXPERIMENT_RECORDS", "实验记录"),
            MaterialRule("EXPERIMENT_RAW_DATA", "原始数据"),
            MaterialRule("QUALITY_CONTROL", "质量控制"),
            MaterialRule("DEVIATION_RECORDS", "偏差记录"),
        ),
    ),
    _stage(
        "ANALYSIS_EXPERIMENT",
        "CONDITIONAL_PI",
        (
            MaterialRule("DATA_CLEANING_RECORDS", "数据清洗记录"),
            MaterialRule("ANALYSIS_CODE_OR_STEPS", "分析代码或步骤"),
            MaterialRule("STATISTICAL_METHODS", "统计方法"),
            MaterialRule("CHARTS", "图表"),
            MaterialRule("INTERIM_CONCLUSION", "阶段性结论"),
        ),
    ),
    _stage(
        "ITERATION",
        "CONDITIONAL_PI",
        (
            MaterialRule("PROBLEM_ANALYSIS", "问题分析"),
            MaterialRule("CHANGE_REASON", "修改原因"),
            MaterialRule("PLAN_COMPARISON", "原方案与新方案对比"),
            MaterialRule("IMPACT_ASSESSMENT", "影响评估"),
            MaterialRule("UPDATED_PLAN", "更新后的计划"),
        ),
    ),
    _stage(
        "SUMMARY",
        "ALWAYS_PI",
        (
            MaterialRule("GOAL_COMPLETION", "目标完成情况"),
            MaterialRule("MAIN_RESULTS", "主要结果"),
            MaterialRule("FINAL_DATA", "最终数据"),
            MaterialRule("LIMITATIONS", "局限性"),
            MaterialRule("CONCLUSION", "结论"),
            MaterialRule("FOLLOW_UP_PLAN", "后续计划"),
        ),
    ),
    _stage(
        "PAPER_WRITING",
        "ALWAYS_PI",
        (
            MaterialRule("PAPER_OUTLINE", "论文提纲"),
            MaterialRule("PAPER_DRAFT", "初稿"),
            MaterialRule("PAPER_REVISED_DRAFT", "修改稿"),
            MaterialRule("PAPER_CHARTS", "图表"),
            MaterialRule("REFERENCES", "参考文献"),
            MaterialRule("AUTHOR_ORDER", "作者排序"),
            MaterialRule("DATA_COMPLIANCE", "数据合规说明"),
        ),
    ),
    _stage(
        "COMPLETION",
        "ALWAYS_PI",
        (
            MaterialRule("MATERIAL_ARCHIVE", "材料归档"),
            MaterialRule("OPENING_RELEVANCE_SELF_REVIEW", "开题相关性自评"),
        ),
    ),
    _stage("TRANSFER", "ALWAYS_PI", (MaterialRule("TRANSFER_EVIDENCE", "转化成果材料"),)),
)

STAGE_RULES_BY_CODE = {rule.code: rule for rule in STAGE_RULES}
MATERIAL_REQUIREMENTS = {rule.code: rule.materials for rule in STAGE_RULES}
CHAIN_STAGE_PI_POLICIES = {rule.code: rule.pi_policy for rule in STAGE_RULES}

NODE_TYPE_BY_STAGE = {
    "LITERATURE_REVIEW": "LITERATURE_REVIEW",
    "TOPIC_SELECTION": "TOPIC_SELECTION",
    "TOPIC_EVALUATION": "TOPIC_EVALUATION",
    "PRE_EXPERIMENT": "PRE_EXPERIMENT",
    "ANALYSIS_PRE_EXPERIMENT": "ANALYSIS",
    "OPENING": "OPENING",
    "EXPERIMENT": "EXPERIMENT",
    "ANALYSIS_EXPERIMENT": "ANALYSIS",
    "ITERATION": "ITERATION",
    "SUMMARY": "SUMMARY",
    "PAPER_WRITING": "PAPER_WRITING",
    "COMPLETION": "COMPLETION",
    "TRANSFER": "TRANSFER",
}
NODE_TYPE_BY_STAGE_REVERSED = {node_type: stage_code for stage_code, node_type in NODE_TYPE_BY_STAGE.items()}
EDITABLE_STAGE_STATUSES = ("NOT_STARTED", "IN_PROGRESS", "NEEDS_REVISION")


class ChainStageRuleError(Exception):
    """A Research Chain stage action violated a documented rule."""

    def __init__(self, error_code, message, http_status=status.HTTP_409_CONFLICT, **extra):
        self.error_code = error_code
        self.message = message
        self.http_status = http_status
        self.extra = extra
        super().__init__(message)


def initialize_chain_stages(chain, actor=None):
    """Create the fixed stage and material rows for a research chain.

    Args:
        chain: The Research Chain that needs thirteen approval stages.
        actor: Optional user recorded as the initializer.

    Returns:
        The number of newly created stage rows.
    """
    from plane.db.models import ResearchChainStage, ResearchChainStageMaterialRequirement

    with transaction.atomic():
        type(chain).objects.select_for_update().get(pk=chain.pk)
        existing_stages = {
            stage.stage_code: stage for stage in ResearchChainStage.objects.filter(chain=chain, deleted_at__isnull=True)
        }
        missing_stages = []
        for sort_order, rule in enumerate(STAGE_RULES, start=1):
            if rule.code in existing_stages:
                continue
            missing_stages.append(
                ResearchChainStage(
                    workspace=chain.workspace,
                    chain=chain,
                    stage_code=rule.code,
                    sort_order=sort_order,
                    created_by=actor,
                )
            )
        if missing_stages:
            ResearchChainStage.objects.bulk_create(missing_stages)
        stages_by_code = {stage.stage_code: stage for stage in existing_stages.values()}
        stages_by_code.update({stage.stage_code: stage for stage in missing_stages})

        existing_requirements = {
            (requirement.stage_id, requirement.code): requirement
            for requirement in ResearchChainStageMaterialRequirement.objects.filter(
                stage__chain=chain,
                deleted_at__isnull=True,
            )
        }
        missing_requirements = []
        for rule in STAGE_RULES:
            stage = stages_by_code[rule.code]
            for requirement_order, material in enumerate(rule.materials, start=1):
                if (stage.id, material.code) in existing_requirements:
                    continue
                missing_requirements.append(
                    ResearchChainStageMaterialRequirement(
                        stage=stage,
                        code=material.code,
                        title=material.title,
                        minimum_count=material.minimum_count,
                        sort_order=requirement_order,
                        created_by=actor,
                    )
                )
        if missing_requirements:
            ResearchChainStageMaterialRequirement.objects.bulk_create(missing_requirements)
        return len(missing_stages)


def _ancestor_node_types(node):
    """Return parent node types without following a cycle twice."""
    types = set()
    visited = set()
    parent = node.parent_node
    while parent is not None and parent.id not in visited:
        visited.add(parent.id)
        types.add(parent.node_type)
        parent = parent.parent_node
    return types


def stage_code_for_node(node):
    """Resolve the fixed stage represented by one business node.

    Args:
        node: Research Chain node to classify.

    Returns:
        The stage code, or ``None`` for an intentionally unmapped node.
    """
    stage_code = NODE_TYPE_BY_STAGE_REVERSED.get(node.node_type)
    if node.node_type == "ANALYSIS":
        ancestors = _ancestor_node_types(node)
        if "EXPERIMENT" in ancestors or "ITERATION" in ancestors:
            stage_code = "ANALYSIS_EXPERIMENT"
        elif "PRE_EXPERIMENT" in ancestors:
            stage_code = "ANALYSIS_PRE_EXPERIMENT"
    return stage_code


def mark_chain_stage_in_progress(node):
    """Move a mapped stage from ``NOT_STARTED`` to ``IN_PROGRESS``.

    Args:
        node: A newly created Research Chain business node.

    Returns:
        The updated stage, or ``None`` when the node is intentionally unmapped.
    """
    from plane.db.models import ResearchChainStage

    stage_code = stage_code_for_node(node)
    if stage_code is None:
        return None
    stage = ResearchChainStage.objects.filter(
        chain=node.chain,
        stage_code=stage_code,
        status="NOT_STARTED",
        deleted_at__isnull=True,
    ).first()
    if stage is None:
        return None
    stage.status = "IN_PROGRESS"
    stage.save(update_fields=["status", "updated_at"])
    return stage


def _chain_profile(chain):
    """Return the research profile that owns a chain.

    Args:
        chain: The Research Chain being inspected.

    Returns:
        The project's research profile, or ``None`` when it is missing.
    """
    from plane.db.models import ResearchProjectProfile

    return (
        ResearchProjectProfile.objects.filter(project_id=chain.project_id, deleted_at__isnull=True)
        .select_related("org_unit")
        .first()
    )


def _active_mentor_bindings(chain, owner_id):
    """Return effective mentor bindings for a chain owner."""
    from plane.db.models import MentorBinding

    today = timezone.localdate()
    return list(
        MentorBinding.objects.filter(
            active_membership_q(today),
            workspace_id=chain.workspace_id,
            mentee_id=owner_id,
        )
        .exclude(mentor_id=owner_id)
        .select_related("mentor")
        .order_by("-is_primary_advisor", "created_at")
    )


def resolve_advisor(chain):
    """Resolve the single direct advisor for a chain owner.

    Args:
        chain: The Research Chain under review.

    Returns:
        The effective direct advisor user.
    """
    profile = _chain_profile(chain)
    owner_id = profile.owner_id if profile else chain.owner_id
    bindings = _active_mentor_bindings(chain, owner_id)
    primary = [binding for binding in bindings if binding.is_primary_advisor]
    candidates = primary or bindings
    if len(candidates) == 1:
        return candidates[0].mentor
    raise ChainStageRuleError(
        ResearchErrorCode.CHAIN_STAGE_REVIEWER_NOT_CONFIGURED,
        "A unique direct advisor must be configured before stage submission.",
        status.HTTP_422_UNPROCESSABLE_ENTITY,
        role="ADVISOR",
    )


def _active_pi_members(chain, owner_id):
    """Return effective principal investigator members for a chain org unit."""
    from plane.db.models import OrgUnitMember

    profile = _chain_profile(chain)
    if profile is None or profile.org_unit_id is None:
        return []
    today = timezone.localdate()
    return list(
        OrgUnitMember.objects.filter(
            active_membership_q(today),
            workspace_id=chain.workspace_id,
            org_unit_id=profile.org_unit_id,
            org_role__in=("PI", "OWNER"),
        )
        .exclude(user_id=owner_id)
        .select_related("user")
        .order_by("-is_primary", "created_at")
    )


def resolve_principal(chain):
    """Resolve the single principal investigator for a chain org unit.

    Args:
        chain: The Research Chain under review.

    Returns:
        The effective principal investigator user.
    """
    profile = _chain_profile(chain)
    members = _active_pi_members(chain, profile.owner_id if profile else chain.owner_id)
    primary = [member for member in members if member.is_primary]
    candidates = primary or members
    if len(candidates) == 1:
        return candidates[0].user
    raise ChainStageRuleError(
        ResearchErrorCode.CHAIN_STAGE_REVIEWER_NOT_CONFIGURED,
        "A unique principal investigator must be configured before PI review.",
        status.HTTP_422_UNPROCESSABLE_ENTITY,
        role="PI",
    )


def _upload_detail(upload):
    """Project the reviewer-facing fields of one linked research upload.

    Args:
        upload: Research chain upload linked to a stage material item.

    Returns:
        A dictionary with status, file metadata and Plane-only access URLs.
    """
    if upload is None:
        return None
    previewable = (
        upload.knowledge_id and settings.ATTACHMENT_PREVIEW_ENABLED and file_kind(upload.file_name) != "unsupported"
    )
    return {
        "id": str(upload.id),
        "status": upload.status,
        "file_name": upload.file_name,
        "file_size": upload.file_size,
        "preview_url": (
            f"/api/research/workspaces/{upload.workspace.slug}/chains/{upload.chain_id}/uploads/{upload.id}/preview/"
            if previewable
            else ""
        ),
        "download_url": (
            f"/api/research/workspaces/{upload.workspace.slug}/chains/{upload.chain_id}/uploads/{upload.id}/download/"
            if upload.knowledge_id
            else ""
        ),
        "error_code": upload.error_code,
    }


def material_state(stage):
    """Project one mutually exclusive readiness state for every requirement.

    Args:
        stage: The Research Chain stage to inspect.

    Returns:
        Requirement dictionaries with success, processing and failed counts.
    """
    prefetch_cache = getattr(stage, "_prefetched_objects_cache", {})
    if "material_requirements" in prefetch_cache:
        requirements = sorted(
            (requirement for requirement in prefetch_cache["material_requirements"] if requirement.deleted_at is None),
            key=lambda requirement: requirement.sort_order,
        )
    else:
        requirements = list(
            stage.material_requirements.filter(deleted_at__isnull=True)
            .prefetch_related("items__upload__workspace")
            .order_by("sort_order")
        )
    result = []
    for requirement in requirements:
        items = [item for item in requirement.items.all() if item.deleted_at is None]
        success_count = sum(1 for item in items if item.upload_id and item.upload.status in SATISFYING_UPLOAD_STATUSES)
        processing_count = sum(
            1 for item in items if item.upload_id and item.upload.status in PROCESSING_UPLOAD_STATUSES
        )
        failed_count = sum(1 for item in items if item.upload_id and item.upload.status in FAILED_UPLOAD_STATUSES)
        complete = success_count >= requirement.minimum_count
        if complete:
            submission_state = "READY"
        elif processing_count > 0:
            submission_state = "PROCESSING"
        elif failed_count > 0:
            submission_state = "FAILED"
        else:
            submission_state = "INCOMPLETE"
        result.append(
            {
                "id": str(requirement.id),
                "code": requirement.code,
                "title": requirement.title,
                "minimum_count": requirement.minimum_count,
                "submitted_count": success_count,
                "complete": complete,
                "submission_state": submission_state,
                "processing_count": processing_count,
                "failed_count": failed_count,
                "items": [
                    {
                        "id": str(item.id),
                        "title": item.title,
                        "description": item.description,
                        "source_node": str(item.source_node_id) if item.source_node_id else None,
                        "upload": str(item.upload_id) if item.upload_id else None,
                        "upload_detail": _upload_detail(item.upload),
                        "external_reference": item.external_reference,
                        "created_at": item.created_at.isoformat(),
                    }
                    for item in items
                ],
            }
        )
    return result


def missing_material_requirements(stage):
    """Return codes for stage requirements without enough submitted items."""
    return [item["code"] for item in material_state(stage) if item["submission_state"] != "READY"]


def stage_material_version(stage):
    """Compute a deterministic version from all stage material rows.

    Soft-deleted rows are included so deleting and recreating an item always
    invalidates a previously generated precheck.

    Args:
        stage: The Research Chain stage being inspected.

    Returns:
        A stable version derived from the latest update timestamp and row counts.
    """
    from plane.db.models import ResearchChainStageMaterialItem, ResearchChainStageMaterialRequirement

    requirement_state = ResearchChainStageMaterialRequirement.all_objects.filter(stage=stage).aggregate(
        latest=Max("updated_at"),
        total_count=Count("id"),
        active_count=Count("id", filter=Q(deleted_at__isnull=True)),
    )
    item_state = ResearchChainStageMaterialItem.all_objects.filter(stage=stage).aggregate(
        latest=Max("updated_at"),
        total_count=Count("id"),
        active_count=Count("id", filter=Q(deleted_at__isnull=True)),
    )
    latest = max(
        (state["latest"] for state in (requirement_state, item_state) if state["latest"] is not None),
        default=None,
    )
    if latest is None:
        return ""
    return (
        f"{latest.isoformat()}:"
        f"{requirement_state['total_count']}:{requirement_state['active_count']}:"
        f"{item_state['total_count']}:{item_state['active_count']}"
    )


def precheck_material_version(precheck):
    """Read the material version captured when a precheck was generated.

    Args:
        precheck: A stage precheck containing rule check metadata.

    Returns:
        The stored version, or an empty string for legacy prechecks.
    """
    checks = precheck.checks if isinstance(precheck.checks, list) else []
    for check in checks:
        if isinstance(check, dict) and check.get("material_version"):
            return str(check["material_version"])
    return ""


def _stage_event(stage, event_type, actor, request_id, summary, metadata=None, node=None):
    """Append one immutable stage lifecycle event."""
    from plane.db.models import ResearchChainEvent

    target_node = node or stage.submitted_node
    if target_node is None:
        return None
    return ResearchChainEvent.objects.create(
        chain=stage.chain,
        node=target_node,
        event_id=f"{stage.stage_code}-{event_type}-{request_id[:48]}",
        request_id=f"stage-{event_type}-{request_id[:48]}",
        actor=actor,
        actor_type="USER",
        source_system="PLANE",
        event_type=event_type,
        occurred_at=timezone.now(),
        refs=[{"kind": "research_chain_stage", "id": str(stage.id), "status": stage.status}],
        metadata=metadata or {},
        summary=summary,
        content_hash=request_id,
    )


def _audit_stage(action, stage, actor, metadata, request=None):
    """Record an audit event without interrupting the business transaction."""
    profile = _chain_profile(stage.chain)
    record_audit_event(
        workspace=stage.workspace,
        action=action,
        resource_type=ResearchResourceType.RESEARCH_CHAIN_STAGE,
        resource_id=stage.id,
        org_unit=profile.org_unit if profile else None,
        actor=actor,
        metadata={"chain": str(stage.chain_id), "stage": stage.stage_code, **metadata},
        request=request,
    )


def add_stage_material(
    stage,
    actor,
    *,
    requirement_code,
    upload,
    request_id="",
):
    """Link one scoped upload to a stage material requirement.

    Args:
        stage: The Research Chain stage receiving the material.
        actor: User creating the material link.
        requirement_code: Fixed requirement code for this stage.
        upload: Research chain upload supplying the material file.
        request_id: Idempotency key supplied by the API caller.

    Returns:
        The created stage material item.
    """
    from plane.db.models import ResearchChainStageMaterialItem

    with transaction.atomic():
        locked_stage = type(stage).objects.select_for_update().get(pk=stage.pk)
        if locked_stage.status not in EDITABLE_STAGE_STATUSES:
            raise ChainStageRuleError(
                ResearchErrorCode.CHAIN_STAGE_MATERIAL_READ_ONLY,
                "Materials can only be edited before submission or after a return.",
                status.HTTP_409_CONFLICT,
            )
        requirement = locked_stage.material_requirements.filter(
            code=str(requirement_code or "").strip(),
            deleted_at__isnull=True,
        ).first()
        if requirement is None:
            raise ChainStageRuleError(
                ResearchErrorCode.CHAIN_INVALID,
                "requirement_code is not defined for this stage.",
                status.HTTP_422_UNPROCESSABLE_ENTITY,
            )
        if upload is None or upload.chain_id != locked_stage.chain_id:
            raise ChainStageRuleError(
                ResearchErrorCode.CHAIN_INVALID,
                "upload_id must reference an upload in this chain.",
                status.HTTP_422_UNPROCESSABLE_ENTITY,
            )
        if upload.status not in ASSOCIABLE_UPLOAD_STATUSES:
            raise ChainStageRuleError(
                ResearchErrorCode.CHAIN_INVALID,
                "Only pending, processing or successful research uploads can be linked.",
                status.HTTP_422_UNPROCESSABLE_ENTITY,
            )
        duplicate = requirement.items.filter(upload=upload, deleted_at__isnull=True).exists()
        if duplicate:
            raise ChainStageRuleError(
                ResearchErrorCode.CHAIN_INVALID,
                "This research upload is already linked to this material requirement.",
                status.HTTP_409_CONFLICT,
            )
        item = ResearchChainStageMaterialItem.objects.create(
            stage=locked_stage,
            requirement=requirement,
            title=upload.file_name[:500],
            description="",
            source_node=upload.node,
            upload=upload,
            external_reference="",
            request_id=request_id,
            created_by=actor,
        )
        if locked_stage.status == "NOT_STARTED":
            locked_stage.status = "IN_PROGRESS"
            locked_stage.save(update_fields=["status", "updated_at"])
        _stage_event(
            locked_stage,
            "CHAIN_STAGE_MATERIAL_ADDED",
            actor,
            request_id or str(item.id),
            f"Added material: {item.title}",
            {"requirement": requirement.code, "upload_id": str(upload.id), "upload_status": upload.status},
            node=upload.node,
        )
        _audit_stage(
            ResearchAuditAction.CHAIN_STAGE_MATERIAL_ADD, locked_stage, actor, {"requirement": requirement.code}
        )
        return item


def remove_stage_material(stage, item, actor):
    """Soft-delete an editable stage material item."""
    with transaction.atomic():
        locked_stage = type(stage).objects.select_for_update().get(pk=stage.pk)
        if locked_stage.status not in EDITABLE_STAGE_STATUSES:
            raise ChainStageRuleError(
                ResearchErrorCode.CHAIN_STAGE_MATERIAL_READ_ONLY,
                "Materials can only be edited before submission or after a return.",
                status.HTTP_409_CONFLICT,
            )
        if item.stage_id != locked_stage.id or item.deleted_at is not None:
            raise ChainStageRuleError(
                ResearchErrorCode.CHAIN_INVALID,
                "Material item is not active on this stage.",
                status.HTTP_422_UNPROCESSABLE_ENTITY,
            )
        item.deleted_at = timezone.now()
        item.updated_by = actor
        item.save(update_fields=["deleted_at", "updated_by", "updated_at"])
        _audit_stage(
            ResearchAuditAction.CHAIN_STAGE_MATERIAL_REMOVE,
            locked_stage,
            actor,
            {"requirement": item.requirement.code, "item": str(item.id)},
        )
        return item


def create_stage_precheck(stage, actor, *, request_id=""):
    """Create an advisory rule-based material precheck for stage 03."""
    from plane.db.models import ResearchChainStagePrecheck

    with transaction.atomic():
        locked_stage = type(stage).objects.select_for_update().get(pk=stage.pk)
        if locked_stage.stage_code != "TOPIC_EVALUATION":
            raise ChainStageRuleError(
                ResearchErrorCode.CHAIN_STAGE_PRECHECK_ONLY_TOPIC_EVALUATION,
                "Material precheck is only available for TOPIC_EVALUATION.",
                status.HTTP_422_UNPROCESSABLE_ENTITY,
            )
        if locked_stage.status not in EDITABLE_STAGE_STATUSES:
            raise ChainStageRuleError(
                ResearchErrorCode.CHAIN_STAGE_MATERIAL_READ_ONLY,
                "Materials can only be prechecked before submission or after a return.",
                status.HTTP_409_CONFLICT,
            )
        requirements = material_state(locked_stage)
        material_version = stage_material_version(locked_stage)
        checks = [
            {
                "code": requirement["code"],
                "passed": requirement["complete"],
                "submitted_count": requirement["submitted_count"],
                "minimum_count": requirement["minimum_count"],
                "material_version": material_version,
            }
            for requirement in requirements
        ]
        missing = [check["code"] for check in checks if not check["passed"]]
        precheck = ResearchChainStagePrecheck.objects.create(
            stage=locked_stage,
            status="READY" if not missing else "WARNING",
            summary="材料完整性预检通过。" if not missing else "以下材料尚未满足最低数量：" + "、".join(missing),
            checks=checks,
            recommendations=[] if not missing else [f"补充 {code} 对应材料。" for code in missing],
            generated_by="research-agent-precheck",
            model_version="rule-material-v1",
            request_id=request_id,
        )
        if locked_stage.status == "NOT_STARTED":
            locked_stage.status = "IN_PROGRESS"
            locked_stage.save(update_fields=["status", "updated_at"])
        _stage_event(locked_stage, "CHAIN_STAGE_PRECHECK", actor, request_id or str(precheck.id), "材料预检已生成")
        _audit_stage(ResearchAuditAction.CHAIN_STAGE_PRECHECK, locked_stage, actor, {"status": precheck.status})
        return precheck


def _validate_submission(stage, node, requires_pi, escalation_reason):
    if stage.chain.status != "ACTIVE":
        raise ChainStageRuleError(
            ResearchErrorCode.CHAIN_STAGE_STATE_CONFLICT,
            "Only active research chains can submit stage approvals.",
        )
    if stage.status not in ("IN_PROGRESS", "NEEDS_REVISION"):
        raise ChainStageRuleError(
            ResearchErrorCode.CHAIN_STAGE_STATE_CONFLICT,
            f"The stage status {stage.status} does not allow submission.",
        )
    if node is None or node.chain_id != stage.chain_id or node.deleted_at is not None:
        raise ChainStageRuleError(
            ResearchErrorCode.CHAIN_INVALID,
            "node_id must reference an active node in this chain.",
            status.HTTP_422_UNPROCESSABLE_ENTITY,
        )
    if node.status not in ("DRAFT", "ACTIVE", "NEEDS_REVISION"):
        raise ChainStageRuleError(
            ResearchErrorCode.CHAIN_INVALID,
            "Only a draft, active or returned node can be submitted for stage approval.",
            status.HTTP_422_UNPROCESSABLE_ENTITY,
        )
    if stage_code_for_node(node) != stage.stage_code:
        raise ChainStageRuleError(
            ResearchErrorCode.CHAIN_INVALID,
            "node_type does not match this stage.",
            status.HTTP_422_UNPROCESSABLE_ENTITY,
        )
    missing = missing_material_requirements(stage)
    if missing:
        raise ChainStageRuleError(
            ResearchErrorCode.CHAIN_STAGE_MATERIAL_INCOMPLETE,
            "All required stage materials must be submitted.",
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            missing=missing,
        )
    latest_precheck = stage.prechecks.first() if stage.stage_code == "TOPIC_EVALUATION" else None
    if stage.stage_code == "TOPIC_EVALUATION" and (
        latest_precheck is None or precheck_material_version(latest_precheck) != stage_material_version(stage)
    ):
        raise ChainStageRuleError(
            ResearchErrorCode.CHAIN_STAGE_PRECHECK_REQUIRED,
            "Generate a current material precheck before submitting this stage.",
            status.HTTP_422_UNPROCESSABLE_ENTITY,
        )
    resolve_advisor(stage.chain)
    policy = CHAIN_STAGE_PI_POLICIES[stage.stage_code]
    final_requires_pi = policy == "ALWAYS_PI" or (policy == "CONDITIONAL_PI" and bool(requires_pi))
    if policy == "CONDITIONAL_PI" and final_requires_pi and not escalation_reason.strip():
        raise ChainStageRuleError(
            ResearchErrorCode.CHAIN_INVALID,
            "escalation_reason is required when PI review is declared.",
            status.HTTP_422_UNPROCESSABLE_ENTITY,
        )
    if final_requires_pi:
        resolve_principal(stage.chain)
    return final_requires_pi


def _material_snapshot(stage):
    return [
        {
            "code": item["code"],
            "minimum_count": item["minimum_count"],
            "submitted_count": item["submitted_count"],
            "titles": [material["title"] for material in item["items"]],
            "items": [
                {
                    "title": material["title"],
                    "upload": material.get("upload_detail"),
                }
                for material in item["items"]
            ],
        }
        for item in material_state(stage)
    ]


def _complete_chain_if_ready(stage, actor, request_id):
    """Complete a chain only when all thirteen stages are approved."""
    from plane.db.models import ResearchChain

    chain = ResearchChain.objects.select_for_update().get(pk=stage.chain_id)
    approved_count = chain.stage_approvals.filter(
        status="APPROVED",
        deleted_at__isnull=True,
    ).count()
    if approved_count != len(CHAIN_STAGE_CODES):
        return False
    if chain.status == ResearchChain.Status.COMPLETED:
        return True
    chain.status = ResearchChain.Status.COMPLETED
    chain.save(update_fields=["status", "updated_at"])
    profile = _chain_profile(chain)
    if profile is not None:
        profile.workflow_status = "COMPLETED"
        profile.completed_at = timezone.localdate()
        profile.is_active = False
        profile.save(update_fields=["workflow_status", "completed_at", "is_active", "updated_at"])
    _stage_event(stage, "CHAIN_COMPLETED", actor, request_id, "All thirteen stages approved; chain completed")
    _audit_stage(ResearchAuditAction.CHAIN_COMPLETE, stage, actor, {"approved_stages": approved_count})
    return True


def submit_chain_stage(
    stage,
    actor,
    *,
    node,
    request_id,
    requires_pi=False,
    escalation_reason="",
    request=None,
    payload_digest="",
):
    """Submit one stage into the advisor review queue.

    Args:
        stage: The Research Chain stage being submitted.
        actor: The authenticated submitting user.
        node: The stage's business node.
        request_id: Idempotency key supplied by the API caller.
        requires_pi: Student declaration for conditionally escalating stages.
        escalation_reason: Reason required when PI review is declared.
        request: Optional HTTP request for audit metadata.

    Returns:
        The refreshed stage after submission.
    """
    with transaction.atomic():
        locked_stage = type(stage).objects.select_for_update().get(pk=stage.pk)
        locked_node = node.__class__.objects.select_for_update().get(pk=node.pk)
        final_requires_pi = _validate_submission(locked_stage, locked_node, requires_pi, str(escalation_reason or ""))
        locked_stage.attempt_count += 1
        locked_stage.status = "AWAITING_ADVISOR"
        locked_stage.requires_pi = final_requires_pi
        locked_stage.escalation_reason = str(escalation_reason or "").strip()
        locked_stage.submitted_node = locked_node
        locked_stage.submitted_at = timezone.now()
        locked_stage.approved_at = None
        locked_stage.save(
            update_fields=[
                "attempt_count",
                "status",
                "requires_pi",
                "escalation_reason",
                "submitted_node",
                "submitted_at",
                "approved_at",
                "updated_at",
            ]
        )
        locked_node.status = "WAITING_HUMAN"
        locked_node.save(update_fields=["status", "updated_at"])
        _stage_event(
            locked_stage,
            "CHAIN_STAGE_SUBMITTED",
            actor,
            request_id,
            f"Submitted stage {locked_stage.stage_code} for advisor review",
            {
                "attempt": locked_stage.attempt_count,
                "requires_pi": locked_stage.requires_pi,
                "payload_hash": payload_digest,
            },
            node=locked_node,
        )
        _audit_stage(
            ResearchAuditAction.CHAIN_STAGE_SUBMIT,
            locked_stage,
            actor,
            {"attempt": locked_stage.attempt_count, "requires_pi": locked_stage.requires_pi},
            request,
        )
        locked_stage.refresh_from_db()
        advisor = resolve_advisor(locked_stage.chain)
        notify_chain_stage_submitted(locked_stage, advisor, actor)
        return locked_stage


def _return_stage(stage, actor, reviewer_role, comment, request_id, request):
    stage.status = "NEEDS_REVISION"
    stage.save(update_fields=["status", "updated_at"])
    if stage.submitted_node is not None:
        stage.submitted_node.status = "NEEDS_REVISION"
        stage.submitted_node.save(update_fields=["status", "updated_at"])
    _stage_event(stage, "CHAIN_STAGE_RETURNED", actor, request_id, comment)
    _audit_stage(
        ResearchAuditAction.CHAIN_STAGE_RETURN,
        stage,
        actor,
        {"reviewer_role": reviewer_role, "attempt": stage.attempt_count},
        request,
    )
    profile = _chain_profile(stage.chain)
    if profile is not None and profile.owner is not None:
        notify_chain_stage_decided(stage, profile.owner, actor, "returned")
    return stage


def _approve_stage(stage, actor, reviewer_role, request_id, request, escalate_to_pi=False):
    principal = resolve_principal(stage.chain) if escalate_to_pi else None
    stage.status = "AWAITING_PI" if escalate_to_pi else "APPROVED"
    if not escalate_to_pi:
        stage.approved_at = timezone.now()
    stage.save(
        update_fields=["status", "approved_at", "updated_at"] if not escalate_to_pi else ["status", "updated_at"]
    )
    if not escalate_to_pi and stage.submitted_node is not None:
        stage.submitted_node.status = "COMPLETED"
        stage.submitted_node.save(update_fields=["status", "updated_at"])
    event_type = (
        "CHAIN_STAGE_ESCALATED_TO_PI"
        if escalate_to_pi
        else ("CHAIN_STAGE_PI_APPROVED" if reviewer_role == "PI" else "CHAIN_STAGE_ADVISOR_APPROVED")
    )
    _stage_event(stage, event_type, actor, request_id, f"{reviewer_role} approved stage {stage.stage_code}")
    audit_action = (
        ResearchAuditAction.CHAIN_STAGE_PI_APPROVE
        if reviewer_role == "PI"
        else ResearchAuditAction.CHAIN_STAGE_ADVISOR_APPROVE
    )
    _audit_stage(
        audit_action,
        stage,
        actor,
        {"reviewer_role": reviewer_role, "attempt": stage.attempt_count, "escalated_to_pi": escalate_to_pi},
        request,
    )
    if not escalate_to_pi:
        _complete_chain_if_ready(stage, actor, request_id)
    else:
        notify_chain_stage_escalated(stage, principal, actor)
        return stage
    profile = _chain_profile(stage.chain)
    if profile is not None and profile.owner is not None:
        notify_chain_stage_decided(stage, profile.owner, actor, "approved")
    return stage


def review_chain_stage(
    stage,
    actor,
    *,
    action,
    request_id,
    comment="",
    escalate_to_pi=None,
    request=None,
    payload_digest="",
):
    """Approve or return a stage as its current advisor or principal investigator.

    Args:
        stage: The Research Chain stage under review.
        actor: The authenticated reviewer.
        action: ``APPROVE`` or ``RETURN``.
        request_id: Idempotency key supplied by the API caller.
        comment: Mandatory reason for a return.
        escalate_to_pi: Explicit advisor decision for conditional stages.
        request: Optional HTTP request for audit metadata.

    Returns:
        The refreshed stage after the review action.
    """
    from plane.db.models import ResearchChainStageReviewAction

    normalized_action = str(action or "").strip().upper()
    if normalized_action not in ("APPROVE", "RETURN"):
        raise ChainStageRuleError(
            ResearchErrorCode.CHAIN_INVALID,
            "action must be APPROVE or RETURN.",
            status.HTTP_422_UNPROCESSABLE_ENTITY,
        )
    if normalized_action == "RETURN" and not str(comment or "").strip():
        raise ChainStageRuleError(
            ResearchErrorCode.CHAIN_INVALID,
            "A comment is required when returning a stage.",
            status.HTTP_422_UNPROCESSABLE_ENTITY,
        )
    profile = _chain_profile(stage.chain)
    owner_id = profile.owner_id if profile else stage.chain.owner_id
    if owner_id == actor.id:
        raise ChainStageRuleError(
            ResearchErrorCode.PERMISSION_DENIED,
            "The research owner cannot review their own stage.",
            status.HTTP_403_FORBIDDEN,
        )

    with transaction.atomic():
        locked_stage = type(stage).objects.select_for_update().get(pk=stage.pk)
        reviewer_role = "ADVISOR" if locked_stage.status == "AWAITING_ADVISOR" else "PI"
        if locked_stage.status not in ("AWAITING_ADVISOR", "AWAITING_PI"):
            raise ChainStageRuleError(
                ResearchErrorCode.CHAIN_STAGE_STATE_CONFLICT,
                f"The stage status {locked_stage.status} does not allow review.",
            )
        if escalate_to_pi is not None and not isinstance(escalate_to_pi, bool):
            raise ChainStageRuleError(
                ResearchErrorCode.CHAIN_STAGE_ESCALATION_CONFIRM_REQUIRED,
                "escalate_to_pi must be a boolean.",
                status.HTTP_422_UNPROCESSABLE_ENTITY,
            )
        expected = (
            resolve_advisor(locked_stage.chain) if reviewer_role == "ADVISOR" else resolve_principal(locked_stage.chain)
        )
        if expected.id != actor.id:
            raise ChainStageRuleError(
                ResearchErrorCode.CHAIN_STAGE_REVIEWER_INVALID,
                f"You are not the current {reviewer_role} for this stage.",
                status.HTTP_403_FORBIDDEN,
            )

        escalate = False
        policy = CHAIN_STAGE_PI_POLICIES[locked_stage.stage_code]
        if reviewer_role == "ADVISOR" and normalized_action == "APPROVE":
            if policy == "ALWAYS_PI":
                escalate = True
            elif policy == "CONDITIONAL_PI":
                if escalate_to_pi is None:
                    raise ChainStageRuleError(
                        ResearchErrorCode.CHAIN_STAGE_ESCALATION_CONFIRM_REQUIRED,
                        "The advisor must explicitly confirm whether this stage goes to the PI.",
                        status.HTTP_422_UNPROCESSABLE_ENTITY,
                    )
                if not isinstance(escalate_to_pi, bool):
                    raise ChainStageRuleError(
                        ResearchErrorCode.CHAIN_STAGE_ESCALATION_CONFIRM_REQUIRED,
                        "escalate_to_pi must be a boolean.",
                        status.HTTP_422_UNPROCESSABLE_ENTITY,
                    )
                if bool(escalate_to_pi) and not locked_stage.requires_pi:
                    raise ChainStageRuleError(
                        ResearchErrorCode.CHAIN_INVALID,
                        "The student did not declare PI review for this stage.",
                        status.HTTP_422_UNPROCESSABLE_ENTITY,
                    )
                escalate = bool(escalate_to_pi)
            elif bool(escalate_to_pi):
                raise ChainStageRuleError(
                    ResearchErrorCode.CHAIN_INVALID,
                    "This stage cannot be escalated to the PI.",
                    status.HTTP_422_UNPROCESSABLE_ENTITY,
                )
        elif reviewer_role == "PI":
            escalate = False

        ResearchChainStageReviewAction.objects.create(
            stage=locked_stage,
            attempt_no=locked_stage.attempt_count,
            reviewer=actor,
            reviewer_role=reviewer_role,
            action=normalized_action,
            comment=str(comment or "").strip(),
            escalated_to_pi=escalate,
            material_snapshot=_material_snapshot(locked_stage),
            declaration_snapshot={
                "requires_pi": locked_stage.requires_pi,
                "escalation_reason": locked_stage.escalation_reason,
                "policy": policy,
                "attempt": locked_stage.attempt_count,
                "payload_hash": payload_digest,
            },
            request_id=request_id,
        )
        if normalized_action == "RETURN":
            return _return_stage(locked_stage, actor, reviewer_role, str(comment).strip(), request_id, request)
        return _approve_stage(
            locked_stage,
            actor,
            reviewer_role,
            request_id,
            request,
            escalate_to_pi=escalate,
        )
