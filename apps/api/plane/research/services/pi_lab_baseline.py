# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Rebuild the production-like π-Lab research baseline from the locked roster."""

from __future__ import annotations

import hashlib
import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

from django.core.serializers.json import DjangoJSONEncoder
from django.db import connection
from django.utils import timezone

from plane.db.models import (
    FileAsset,
    MentorBinding,
    OrgUnit,
    OrgUnitMember,
    Project,
    ResearchChain,
    ResearchGroupKnowledgeBinding,
    ResearchKnowledgeRequest,
    ResearchProjectProfile,
    ResearchUserProfile,
    User,
    UserImportBatch,
    UserImportRow,
    Workspace,
    WorkspaceMember,
    WorkspaceResearchSetting,
)
from plane.license.models import InstanceRoleAssignment
from plane.research.services.maintenance import _deletion_order, research_models, workspace_counts
from plane.research.services.user_import import parse_advisors, parse_students
from plane.research.utils.audit import ResearchAuditAction, ResearchResourceType, record_audit_event
from plane.research.utils.org import build_path, ensure_root_org_unit
from plane.research.utils.roles import (
    MAIN_PI,
    PUBLIC_WORKSPACE_SLUG,
    configured_main_pi_id,
    sync_main_pi_workspace_seat,
)

PUBLIC_WORKSPACE = PUBLIC_WORKSPACE_SLUG
PI_WORKSPACE = "pi"
ROOT_ORG_NAME = "π-Lab"
MAIN_PI_NAME = "洪文晶"
EXCLUDED_ADVISOR_NAME = "测试组"
EXCLUDED_STUDENT_NAME = "小白鼠"
INVALID_STUDENT_NO = "0"
WORKSPACE_MEMBER_ROLE = 15

STUDENTS_FILE_NAME = "π-Lab学生-导入信息表.xlsx"
ADVISORS_FILE_NAME = "导师信息表.xlsx"
STUDENTS_SHA256 = "cda7489f256601179b587d7a5bb7035145854272325e1599c62723f0cf0ecaa0"
ADVISORS_SHA256 = "ac21aba18ebc147a5b6d5c50ab6f4acdf595aec2b0f3c37a1f0bbb18a8f6e548"

TEAM_BUSINESS_CATEGORIES = {
    "电池": OrgUnit.BusinessCategory.INDUSTRIALIZATION,
    "跨尺度表征": OrgUnit.BusinessCategory.BASIC_RESEARCH,
    "AI决策": OrgUnit.BusinessCategory.BASIC_RESEARCH,
    "器件": OrgUnit.BusinessCategory.BASIC_RESEARCH,
    "自旋与超快": OrgUnit.BusinessCategory.BASIC_RESEARCH,
    "逻辑": OrgUnit.BusinessCategory.BASIC_RESEARCH,
    "硅基": OrgUnit.BusinessCategory.INDUSTRIALIZATION,
    "类脑计算": OrgUnit.BusinessCategory.BASIC_RESEARCH,
    "原子智能": OrgUnit.BusinessCategory.BASIC_RESEARCH,
    "量子": OrgUnit.BusinessCategory.BASIC_RESEARCH,
    "华为": OrgUnit.BusinessCategory.INDUSTRIALIZATION,
    "多肽": OrgUnit.BusinessCategory.BASIC_RESEARCH,
    "控制": OrgUnit.BusinessCategory.BASIC_RESEARCH,
    "生命": OrgUnit.BusinessCategory.BASIC_RESEARCH,
    "超分子材料": OrgUnit.BusinessCategory.BASIC_RESEARCH,
    "光刻胶": OrgUnit.BusinessCategory.INDUSTRIALIZATION,
    "电氢联储": OrgUnit.BusinessCategory.INDUSTRIALIZATION,
    "金属化": OrgUnit.BusinessCategory.INDUSTRIALIZATION,
    "转移胶": OrgUnit.BusinessCategory.INDUSTRIALIZATION,
    "磷酸": OrgUnit.BusinessCategory.INDUSTRIALIZATION,
    "测试": OrgUnit.BusinessCategory.INDUSTRIALIZATION,
}


class PiLabBaselineError(Exception):
    """Raised when source data or the rebuilt database violates the frozen baseline."""


@dataclass(frozen=True)
class ExpectedBaseline:
    """Locked counts derived from the two authoritative workbooks."""

    original_student_rows: int = 190
    imported_students: int = 189
    excluded_students: int = 1
    imported_advisors: int = 14
    team_count: int = 21
    primary_relation_gaps: int = 37
    co_advisor_reference_gaps: int = 14
    resolved_primary_relations: int = 152
    invalid_student_no_count: int = 2


@dataclass(frozen=True)
class PiLabStudentPlan:
    """One normalized roster row ready for a partial relationship import."""

    row: object
    student_no: str
    primary_advisor_email: str
    co_advisor_1_email: str
    co_advisor_2_email: str
    relation_gaps: tuple[str, ...]


@dataclass(frozen=True)
class PiLabPlan:
    """Validated source data and derived relationship gaps."""

    students: tuple[PiLabStudentPlan, ...]
    advisor_mapping: dict[str, str]
    team_directions: dict[str, str]
    excluded_students: tuple[str, ...]
    primary_relation_gaps: tuple[str, ...]
    co_advisor_reference_gaps: tuple[str, ...]
    expected: ExpectedBaseline


@dataclass
class PiLabCredentialRecord:
    """A one-time credential returned to the protected manifest writer."""

    display_name: str
    email: str
    password: str
    category: str


@dataclass
class PiLabRebuildResult:
    """Counts and protected credentials produced by one rebuild."""

    users_created: int
    workspace_members: int
    org_units_created: int
    org_members_created: int
    mentor_bindings_created: int
    credentials: list[PiLabCredentialRecord]


def _sha256(path: Path) -> str:
    """Return a file digest without reading the whole file into memory."""
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def verify_pi_lab_source_files(students_path: Path, advisors_path: Path) -> None:
    """Reject replaced source workbooks before destructive maintenance runs."""
    checks = (
        (students_path, STUDENTS_FILE_NAME, STUDENTS_SHA256),
        (advisors_path, ADVISORS_FILE_NAME, ADVISORS_SHA256),
    )
    for path, expected_name, expected_hash in checks:
        if path.name != expected_name:
            raise PiLabBaselineError(f"源文件名应为 {expected_name}，实际为 {path.name}。")
        if not path.is_file():
            raise PiLabBaselineError(f"源文件不存在：{path}")
        actual_hash = _sha256(path)
        if actual_hash != expected_hash:
            raise PiLabBaselineError(f"{expected_name} 哈希不匹配：{actual_hash}")


def _normalise_name(value: str) -> str:
    """Normalize an advisor name to the roster mapping key."""
    return str(value or "").strip().lower().replace(" ", "").replace("　", "")


def load_pi_lab_plan(
    students_path: Path,
    advisors_path: Path,
    *,
    expected: ExpectedBaseline | None = None,
) -> PiLabPlan:
    """Parse and validate the two locked workbooks into an import plan.

    Args:
        students_path: Authoritative student workbook.
        advisors_path: Authoritative advisor email workbook.
        expected: Counts to enforce; defaults to the production baseline.

    Returns:
        Imported rows, retained organization metadata, and pending relationships.
    """
    expected = expected or ExpectedBaseline()
    raw_students = parse_students(students_path.read_bytes(), students_path.name)
    advisor_mapping = {
        name: email.strip().lower()
        for name, email in parse_advisors(advisors_path.read_bytes(), advisors_path.name).items()
        if name != EXCLUDED_ADVISOR_NAME
    }
    if len(raw_students) != expected.original_student_rows:
        raise PiLabBaselineError(f"学生表应为 {expected.original_student_rows} 行，实际 {len(raw_students)} 行。")
    if len(advisor_mapping) != expected.imported_advisors:
        raise PiLabBaselineError(
            f"剔除测试组后应导入 {expected.imported_advisors} 位导师，实际 {len(advisor_mapping)} 位。"
        )
    if _normalise_name(MAIN_PI_NAME) not in advisor_mapping:
        raise PiLabBaselineError("导师表缺少唯一主 PI 洪文晶。")

    team_directions: dict[str, str] = {}
    for row in raw_students:
        previous = team_directions.setdefault(row.group, row.business_category)
        if previous != row.business_category:
            raise PiLabBaselineError(f"小组 {row.group} 同时存在 {previous} 和 {row.business_category} 两个业务方向。")
    if len(team_directions) != expected.team_count:
        raise PiLabBaselineError(f"应保留 {expected.team_count} 个小组，实际 {len(team_directions)} 个。")
    if set(team_directions) != set(TEAM_BUSINESS_CATEGORIES):
        missing = set(TEAM_BUSINESS_CATEGORIES) - set(team_directions)
        extra = set(team_directions) - set(TEAM_BUSINESS_CATEGORIES)
        raise PiLabBaselineError(f"小组集合不匹配：missing={missing}, extra={extra}")
    for team, direction in TEAM_BUSINESS_CATEGORIES.items():
        if team_directions[team] != direction:
            raise PiLabBaselineError(f"小组 {team} 的业务方向与基线不一致。")

    imported: list[PiLabStudentPlan] = []
    excluded: list[str] = []
    seen_emails: set[str] = set()
    seen_student_numbers: set[str] = set()
    primary_gaps: list[str] = []
    co_gaps: list[str] = []
    for row in raw_students:
        if row.name == EXCLUDED_STUDENT_NAME or row.primary_advisor_name == EXCLUDED_ADVISOR_NAME:
            excluded.append(row.name)
            continue
        if not row.name or not row.email or not row.group:
            raise PiLabBaselineError(f"学生表第 {row.row_number} 行缺少姓名/邮箱/小组。")
        email = row.email.lower()
        if email in seen_emails:
            raise PiLabBaselineError(f"学生表第 {row.row_number} 行邮箱重复：{email}")
        seen_emails.add(email)
        student_no = "" if row.student_no == INVALID_STUDENT_NO else row.student_no
        if student_no and student_no in seen_student_numbers:
            raise PiLabBaselineError(f"学生表第 {row.row_number} 行学号重复：{student_no}")
        if student_no:
            seen_student_numbers.add(student_no)

        gaps: list[str] = []
        primary_email = advisor_mapping.get(_normalise_name(row.primary_advisor_name), "")
        co1_email = advisor_mapping.get(_normalise_name(row.co_advisor_1_name), "")
        co2_email = advisor_mapping.get(_normalise_name(row.co_advisor_2_name), "")
        if row.primary_advisor_name and not primary_email:
            gaps.append(f"主导师缺少邮箱映射：{row.primary_advisor_name}")
            primary_gaps.append(row.name)
        if row.co_advisor_1_name and not co1_email:
            gaps.append(f"联合导师1缺少邮箱映射：{row.co_advisor_1_name}")
            co_gaps.append(row.name)
        if row.co_advisor_2_name and not co2_email:
            gaps.append(f"联合导师2缺少邮箱映射：{row.co_advisor_2_name}")
            co_gaps.append(row.name)
        imported.append(
            PiLabStudentPlan(
                row=row,
                student_no=student_no,
                primary_advisor_email=primary_email,
                co_advisor_1_email=co1_email,
                co_advisor_2_email=co2_email,
                relation_gaps=tuple(gaps),
            )
        )

    if len(imported) != expected.imported_students:
        raise PiLabBaselineError(f"应导入 {expected.imported_students} 名学生，实际 {len(imported)} 名。")
    if len(excluded) != expected.excluded_students:
        raise PiLabBaselineError(f"应剔除 {expected.excluded_students} 名测试学生，实际 {len(excluded)} 名。")
    if len(primary_gaps) != expected.primary_relation_gaps:
        raise PiLabBaselineError(f"主导师关系缺口应为 {expected.primary_relation_gaps}，实际 {len(primary_gaps)}。")
    if len(co_gaps) != expected.co_advisor_reference_gaps:
        raise PiLabBaselineError(f"联合导师引用缺口应为 {expected.co_advisor_reference_gaps}，实际 {len(co_gaps)}。")
    return PiLabPlan(
        students=tuple(imported),
        advisor_mapping=advisor_mapping,
        team_directions=team_directions,
        excluded_students=tuple(excluded),
        primary_relation_gaps=tuple(primary_gaps),
        co_advisor_reference_gaps=tuple(co_gaps),
        expected=expected,
    )


def collect_research_assets() -> tuple[set[str], set[str]]:
    """Collect storage paths and FileAsset ids referenced by research models."""
    paths: set[str] = set()
    asset_ids: set[str] = set()
    manager_name = "all_objects"
    for model in research_models():
        manager = getattr(model, manager_name, model.objects)
        for field in model._meta.get_fields():
            if not getattr(field, "many_to_one", False) or field.related_model is not FileAsset:
                continue
            pairs = manager.exclude(**{f"{field.name}__isnull": True}).values_list(
                f"{field.name}_id", f"{field.name}__asset"
            )
            for asset_id, path in pairs:
                asset_ids.add(str(asset_id))
                if path:
                    paths.add(path)
    return paths, asset_ids


def collect_research_asset_paths() -> list[str]:
    """Collect storage paths referenced by research models before deletion."""
    return sorted(collect_research_assets()[0])


def export_research_history(output_dir: Path) -> dict[str, int]:
    """Export append-only research history to JSONL before deleting it."""
    output_dir.mkdir(parents=True, exist_ok=True)
    model_names = (
        "ResearchAuditEvent",
        "ResearchAgentRunEvent",
        "ResearchContextGrant",
        "IntegrationCallLog",
    )
    exported: dict[str, int] = {}
    available = {model.__name__: model for model in research_models()}
    for model_name in model_names:
        model = available.get(model_name)
        if model is None:
            exported[model_name] = 0
            continue
        manager = getattr(model, "all_objects", model.objects)
        rows = list(manager.order_by("id").values())
        with (output_dir / f"{model_name}.jsonl").open("w", encoding="utf-8") as handle:
            for row in rows:
                handle.write(json.dumps(row, ensure_ascii=False, cls=DjangoJSONEncoder, default=str))
                handle.write("\n")
        exported[model_name] = len(rows)
    return exported


def purge_instance_research_data() -> dict[str, int]:
    """Delete every workspace research payload and research-linked project."""
    project_ids = set(ResearchProjectProfile.all_objects.values_list("project_id", flat=True))
    project_ids.update(ResearchChain.all_objects.values_list("project_id", flat=True))
    deleted: dict[str, int] = {}
    models = research_models()
    conditions = {model: ("true", []) for model in models}
    for model in _deletion_order(models, conditions):
        table = model._meta.db_table
        with connection.cursor() as cursor:
            cursor.execute(f'SELECT COUNT(*) FROM "{table}"')
            count = cursor.fetchone()[0]
            if count:
                cursor.execute(f'DELETE FROM "{table}"')
                deleted[table] = count
    projects = list(Project.all_objects.filter(id__in=project_ids).order_by("created_at"))
    for project in projects:
        project.delete(soft=False)
    deleted["research_projects"] = len(projects)

    _paths, asset_ids = collect_research_assets()
    assets = list(FileAsset.all_objects.filter(id__in=asset_ids))
    for asset in assets:
        asset.delete(soft=False)
    deleted["research_file_assets"] = len(assets)

    remaining = {
        name: counts for workspace in Workspace.objects.all() for name, counts in workspace_counts(workspace).items()
    }
    if remaining:
        raise PiLabBaselineError(f"科研数据清理后仍有残留：{remaining}")
    return deleted


def _ensure_workspace_member(workspace: Workspace, user: User, actor: User) -> bool:
    """Restore or create one active public-workspace seat."""
    member = WorkspaceMember.all_objects.filter(workspace=workspace, member=user).order_by("-created_at").first()
    created = member is None
    if created:
        member = WorkspaceMember(workspace=workspace, member=user, created_by=actor)
    member.role = WORKSPACE_MEMBER_ROLE
    member.is_active = True
    member.deleted_at = None
    member.save()
    return created


def _ensure_user(name: str, email: str, actor: User, category: str) -> tuple[User, PiLabCredentialRecord | None]:
    """Create an account or reuse an existing identity without replacing its password."""
    user = User.objects.filter(email__iexact=email).first()
    credential = None
    if user is None:
        from plane.research.services.user_import import apply_initial_password

        user = User(
            email=email,
            username=email,
            first_name=name,
            display_name=name,
            is_active=True,
        )
        password = apply_initial_password(user, save=False)
        user.save()
        credential = PiLabCredentialRecord(name, email, password, category)
    else:
        user.is_active = True
        user.display_name = name
        user.first_name = name
        user.save(update_fields=["is_active", "display_name", "first_name", "updated_at"])
    return user, credential


def _ensure_profile(user: User, *, category: str, student_no: str = "", row=None, batch=None) -> None:
    """Upsert research profile attributes for one imported account."""
    profile = ResearchUserProfile.objects.filter(user=user).first()
    if profile is None:
        profile = ResearchUserProfile(user=user, category=category)
    profile.category = category
    profile.student_no = student_no
    if row is not None:
        profile.grade = row.grade
        profile.degree = row.degree
        profile.phone = row.phone
        profile.group_label = row.group
    if batch is not None:
        profile.source_batch = batch
    profile.save()


def _ensure_org_member(
    workspace: Workspace,
    unit: OrgUnit,
    user: User,
    role: str,
    *,
    is_primary: bool,
    actor: User,
) -> bool:
    """Idempotently restore one organization role and primary-membership invariant."""
    if is_primary:
        OrgUnitMember.objects.filter(workspace=workspace, user=user, is_primary=True).exclude(org_unit=unit).update(
            is_primary=False
        )
    member = OrgUnitMember.all_objects.filter(workspace=workspace, org_unit=unit, user=user, org_role=role).first()
    created = member is None
    if created:
        member = OrgUnitMember(
            workspace=workspace,
            org_unit=unit,
            user=user,
            org_role=role,
            created_by=actor,
        )
    member.is_primary = is_primary
    member.effective_from = timezone.localdate()
    member.effective_to = None
    member.deleted_at = None
    member.save()
    return created


def _ensure_mentor_binding(
    workspace: Workspace,
    unit: OrgUnit,
    mentee: User,
    mentor: User,
    *,
    is_primary: bool,
    actor: User,
) -> bool:
    """Idempotently restore one direct or co-advisor relationship."""
    if is_primary:
        MentorBinding.objects.filter(workspace=workspace, mentee=mentee, is_primary_advisor=True).exclude(
            mentor=mentor
        ).update(is_primary_advisor=False)
    binding = MentorBinding.all_objects.filter(workspace=workspace, mentee=mentee, mentor=mentor).first()
    created = binding is None
    if created:
        binding = MentorBinding(
            workspace=workspace,
            mentee=mentee,
            mentor=mentor,
            org_unit=unit,
            created_by=actor,
        )
    binding.org_unit = unit
    binding.is_primary_advisor = is_primary
    binding.effective_from = timezone.localdate()
    binding.effective_to = None
    binding.deleted_at = None
    binding.save()
    return created


def _ensure_settings(workspace: Workspace, main_pi: User, actor: User) -> WorkspaceResearchSetting:
    """Enable research and point both paired settings at the real main PI."""
    setting, _ = WorkspaceResearchSetting.objects.get_or_create(workspace=workspace, defaults={"created_by": actor})
    setting.purpose = WorkspaceResearchSetting.Purpose.PUBLIC_RESEARCH
    setting.main_pi = main_pi
    setting.module_enabled = True
    setting.org_enabled = True
    setting.report_enabled = True
    setting.approval_enabled = True
    setting.stage_enabled = True
    setting.experiment_enabled = True
    setting.code_enabled = True
    setting.integration_enabled = True
    setting.research_chain_enabled = True
    setting.save()

    private = WorkspaceResearchSetting.objects.filter(purpose=WorkspaceResearchSetting.Purpose.PI_PRIVATE).first()
    if private is not None:
        private.main_pi = main_pi
        private.save(update_fields=["main_pi", "updated_at"])
    return setting


def _replace_main_pi_assignment(user: User, actor: User) -> None:
    """Replace legacy MAIN_PI tags without granting them content access."""
    now = timezone.now()
    for assignment in InstanceRoleAssignment.objects.filter(role=MAIN_PI, deleted_at__isnull=True):
        assignment.deleted_at = now
        assignment.save(update_fields=["deleted_at", "updated_at"])
    assignment, _ = InstanceRoleAssignment.all_objects.get_or_create(
        user=user,
        role=MAIN_PI,
        defaults={"assigned_by": actor, "note": "π-Lab baseline"},
    )
    assignment.deleted_at = None
    assignment.assigned_by = actor
    assignment.note = "π-Lab baseline"
    assignment.save(update_fields=["deleted_at", "assigned_by", "note", "updated_at"])


def build_pi_lab_baseline(workspace: Workspace, actor: User, plan: PiLabPlan) -> PiLabRebuildResult:
    """Build the π-Lab organization, accounts, seats, and advisor relationships."""
    if workspace.slug != PUBLIC_WORKSPACE:
        raise PiLabBaselineError(f"π-Lab 基线只能重建到 {PUBLIC_WORKSPACE} 工作区。")

    credentials: list[PiLabCredentialRecord] = []
    users_created = 0
    members_created = 0
    units_created = 0
    org_members_created = 0
    bindings_created = 0
    advisor_users: dict[str, User] = {}

    for name, email in sorted(plan.advisor_mapping.items()):
        user, credential = _ensure_user(name, email, actor, ResearchUserProfile.Category.ADVISOR)
        advisor_users[email] = user
        if credential:
            credentials.append(credential)
            users_created += 1
        members_created += int(_ensure_workspace_member(workspace, user, actor))

    main_pi_email = plan.advisor_mapping[_normalise_name(MAIN_PI_NAME)]
    main_pi = advisor_users[main_pi_email]
    _ensure_settings(workspace, main_pi, actor)
    _replace_main_pi_assignment(main_pi, actor)
    sync_main_pi_workspace_seat(main_pi, actor=actor)

    root = ensure_root_org_unit(workspace, actor=actor)
    if root.name != ROOT_ORG_NAME or root.unit_type != OrgUnit.UnitType.ROOT:
        root.name = ROOT_ORG_NAME
        root.unit_type = OrgUnit.UnitType.ROOT
        root.parent = None
        root.depth = 0
        root.path = build_path(root.id, None)
        root.save()

    units = {ROOT_ORG_NAME: root}
    for sort_order, team in enumerate(TEAM_BUSINESS_CATEGORIES, start=1):
        unit = OrgUnit.objects.filter(workspace=workspace, parent=root, name=team).first()
        created = unit is None
        if created:
            unit = OrgUnit(
                workspace=workspace,
                parent=root,
                name=team,
                unit_type=OrgUnit.UnitType.TEAM,
                depth=1,
                sort_order=sort_order,
                business_category=TEAM_BUSINESS_CATEGORIES[team],
                created_by=actor,
            )
            unit.path = build_path(unit.id, root.path)
            unit.save()
        else:
            unit.unit_type = OrgUnit.UnitType.TEAM
            unit.parent = root
            unit.depth = 1
            unit.path = build_path(unit.id, root.path)
            unit.sort_order = sort_order
            unit.business_category = TEAM_BUSINESS_CATEGORIES[team]
            unit.is_active = True
            unit.deleted_at = None
            unit.save()
        units_created += int(created)
        units[team] = unit

    org_members_created += int(
        _ensure_org_member(
            workspace,
            root,
            main_pi,
            OrgUnitMember.OrgRole.PI,
            is_primary=True,
            actor=actor,
        )
    )
    batch = UserImportBatch.objects.create(
        workspace=workspace,
        source_filename=f"{STUDENTS_FILE_NAME};{ADVISORS_FILE_NAME}",
        dry_run=False,
        status=UserImportBatch.Status.IMPORTED,
        rows_total=len(plan.students),
        reviewed_by=actor,
        reviewed_at=timezone.now(),
        options={
            "source": "rebuild_pi_lab_baseline",
            "root_org": ROOT_ORG_NAME,
            "main_pi": MAIN_PI_NAME,
            "invalid_student_no": INVALID_STUDENT_NO,
        },
        advisor_mapping=plan.advisor_mapping,
    )

    advisor_teams: dict[str, list[OrgUnit]] = {}
    pending_rows = 0
    student_rows: dict[str, UserImportRow] = {}
    for item in plan.students:
        row = item.row
        user, credential = _ensure_user(row.name, row.email, actor, ResearchUserProfile.Category.STUDENT)
        if credential:
            credentials.append(credential)
            users_created += 1
        members_created += int(_ensure_workspace_member(workspace, user, actor))
        _ensure_profile(
            user,
            category=ResearchUserProfile.Category.STUDENT,
            student_no=item.student_no,
            row=row,
            batch=batch,
        )
        unit = units[row.group]
        org_members_created += int(
            _ensure_org_member(
                workspace,
                unit,
                user,
                OrgUnitMember.OrgRole.REVIEWER,
                is_primary=True,
                actor=actor,
            )
        )

        advisors: list[tuple[User, bool]] = []
        if item.primary_advisor_email:
            advisors.append((advisor_users[item.primary_advisor_email], True))
        if item.co_advisor_1_email:
            advisors.append((advisor_users[item.co_advisor_1_email], False))
        if item.co_advisor_2_email:
            advisors.append((advisor_users[item.co_advisor_2_email], False))
        for mentor, is_primary in advisors:
            advisor_teams.setdefault(mentor.email, []).append(unit)
            bindings_created += int(
                _ensure_mentor_binding(workspace, unit, user, mentor, is_primary=is_primary, actor=actor)
            )

        has_invalid_student_no = row.student_no == INVALID_STUDENT_NO
        is_pending = bool(item.relation_gaps or has_invalid_student_no)
        pending_rows += int(is_pending)
        import_row = UserImportRow.objects.create(
            batch=batch,
            row_number=row.row_number,
            raw=row.raw,
            status=UserImportRow.Status.PENDING if is_pending else UserImportRow.Status.OK,
            message="；".join(
                [
                    *item.relation_gaps,
                    *(["学号为无效占位 0，已置空待修正"] if has_invalid_student_no else []),
                ]
            )[:255],
            review_decision=UserImportRow.ReviewDecision.INCLUDED,
            display_name=row.name,
            email=row.email,
            student_no=item.student_no,
            group_label=row.group,
            advisor_name=row.primary_advisor_name,
            phone=row.phone,
            grade=row.grade,
            category=row.category,
            degree=row.degree,
            business_category=row.business_category,
            primary_advisor_email=item.primary_advisor_email,
            co_advisor_1_name=row.co_advisor_1_name,
            co_advisor_1_email=item.co_advisor_1_email,
            co_advisor_2_name=row.co_advisor_2_name,
            co_advisor_2_email=item.co_advisor_2_email,
            user=user,
            org_unit=unit,
            initial_password=credential.password if credential else "",
        )
        student_rows[row.email.lower()] = import_row

    for email, teams in advisor_teams.items():
        advisor = advisor_users[email]
        for index, unit in enumerate(sorted(set(teams), key=lambda item: item.name)):
            org_members_created += int(
                _ensure_org_member(
                    workspace,
                    unit,
                    advisor,
                    OrgUnitMember.OrgRole.ADVISOR,
                    is_primary=email != main_pi_email and index == 0,
                    actor=actor,
                )
            )
    for email in plan.advisor_mapping.values():
        _ensure_profile(advisor_users[email], category=ResearchUserProfile.Category.ADVISOR, batch=batch)

    from plane.research.services.user_import import record_issued_password

    for credential in credentials:
        account = User.objects.filter(email__iexact=credential.email).first()
        if account is None:
            continue
        kind = "ADVISOR" if credential.category == ResearchUserProfile.Category.ADVISOR else "ROSTER"
        record_issued_password(
            account,
            credential.password,
            batch=batch,
            actor=actor,
            row=student_rows.get(credential.email.lower()),
            kind=kind,
        )

    batch.rows_ok = len(plan.students) - pending_rows
    batch.rows_pending = pending_rows
    batch.rows_error = 0
    batch.summary = {
        "dry_run": False,
        "included": len(plan.students),
        "excluded": len(plan.excluded_students),
        "credentials_issued": len(credentials),
        "primary_relation_gaps": len(plan.primary_relation_gaps),
        "co_advisor_reference_gaps": len(plan.co_advisor_reference_gaps),
    }
    batch.save()
    record_audit_event(
        workspace=workspace,
        action=ResearchAuditAction.USER_IMPORT,
        resource_type=ResearchResourceType.IMPORT_BATCH,
        resource_id=batch.id,
        actor=actor,
        metadata={
            "source": "rebuild_pi_lab_baseline",
            "students": len(plan.students),
            "advisors": len(plan.advisor_mapping),
            "primary_relation_gaps": len(plan.primary_relation_gaps),
        },
    )
    return PiLabRebuildResult(
        users_created=users_created,
        workspace_members=members_created,
        org_units_created=units_created,
        org_members_created=org_members_created,
        mentor_bindings_created=bindings_created,
        credentials=credentials,
    )


def write_credential_manifest(path: Path, credentials: Iterable[PiLabCredentialRecord]) -> None:
    """Write one-time credentials to a newly created protected manifest."""
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "schema_version": 1,
        "warning": "Protected one-time credentials; do not commit or include in browser evidence.",
        "accounts": [credential.__dict__ for credential in credentials],
    }
    serialized = json.dumps(payload, ensure_ascii=False, indent=2) + "\n"
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
        handle.write(serialized)
    os.chmod(path, 0o600)


def verify_pi_lab_baseline(workspace: Workspace, plan: PiLabPlan) -> dict[str, int | str]:
    """Assert the rebuilt baseline and return a compact verification report."""
    if workspace.slug != PUBLIC_WORKSPACE:
        raise PiLabBaselineError("验收目标必须是 public 工作区。")
    pi = Workspace.objects.filter(slug=PI_WORKSPACE).first()
    if pi is None:
        raise PiLabBaselineError("缺少 pi 工作区。")
    pi_residual = workspace_counts(pi)
    if pi_residual:
        raise PiLabBaselineError(f"pi 工作区仍有科研业务数据：{pi_residual}")

    units = list(OrgUnit.objects.filter(workspace=workspace).order_by("sort_order", "name"))
    if len(units) != plan.expected.team_count + 1:
        raise PiLabBaselineError(f"public 组织节点应为 {plan.expected.team_count + 1} 个，实际 {len(units)}。")
    root = next((unit for unit in units if unit.unit_type == OrgUnit.UnitType.ROOT), None)
    if root is None or root.name != ROOT_ORG_NAME or root.parent_id is not None:
        raise PiLabBaselineError("π-Lab 根节点不正确。")
    teams = [unit for unit in units if unit.unit_type == OrgUnit.UnitType.TEAM]
    if {team.name for team in teams} != set(TEAM_BUSINESS_CATEGORIES):
        raise PiLabBaselineError("21 个小组集合不正确。")
    for team in teams:
        if team.parent_id != root.id or team.business_category != TEAM_BUSINESS_CATEGORIES[team.name]:
            raise PiLabBaselineError(f"小组 {team.name} 的层级或业务方向不正确。")

    pi_roles = list(
        OrgUnitMember.objects.filter(
            workspace=workspace,
            org_role=OrgUnitMember.OrgRole.PI,
            deleted_at__isnull=True,
        ).select_related("user")
    )
    if len(pi_roles) != 1 or pi_roles[0].user.display_name != MAIN_PI_NAME:
        raise PiLabBaselineError("有效组织 PI 必须只有洪文晶。")
    main_pi = pi_roles[0].user
    if configured_main_pi_id(workspace) != main_pi.id or configured_main_pi_id(pi) != main_pi.id:
        raise PiLabBaselineError("平台配置的 Main PI 不是洪文晶。")
    active_main_pi_tags = list(
        InstanceRoleAssignment.objects.filter(role=MAIN_PI, deleted_at__isnull=True).values_list("user_id", flat=True)
    )
    if active_main_pi_tags != [main_pi.id]:
        raise PiLabBaselineError("实例 MAIN_PI 标签不是洪文晶。")

    student_profiles = ResearchUserProfile.objects.filter(category=ResearchUserProfile.Category.STUDENT)
    advisor_profiles = ResearchUserProfile.objects.filter(category=ResearchUserProfile.Category.ADVISOR)
    if student_profiles.count() != plan.expected.imported_students:
        raise PiLabBaselineError("学生 Profile 数量不等于基线。")
    if advisor_profiles.count() != plan.expected.imported_advisors:
        raise PiLabBaselineError("导师 Profile 数量不等于基线。")
    if student_profiles.filter(student_no="").count() != plan.expected.invalid_student_no_count:
        raise PiLabBaselineError("无效学号未按置空规则处理。")
    if MentorBinding.objects.filter(is_primary_advisor=True).count() != plan.expected.resolved_primary_relations:
        raise PiLabBaselineError("主导师绑定数量不等于基线。")
    if UserImportRow.objects.filter(primary_advisor_email="").count() != plan.expected.primary_relation_gaps:
        raise PiLabBaselineError("主导师关系缺口不等于基线。")
    if (
        ResearchProjectProfile.objects.count()
        or ResearchChain.objects.count()
        or ResearchKnowledgeRequest.objects.count()
        or ResearchGroupKnowledgeBinding.objects.count()
    ):
        raise PiLabBaselineError("重建后不得预造科研课题、研究链或 KB 申请。")

    return {
        "public_workspace": workspace.slug,
        "pi_workspace": pi.slug,
        "org_units": len(units),
        "teams": len(teams),
        "students": student_profiles.count(),
        "advisors": advisor_profiles.count(),
        "primary_mentor_bindings": MentorBinding.objects.filter(is_primary_advisor=True).count(),
        "primary_relation_gaps": plan.expected.primary_relation_gaps,
        "co_advisor_reference_gaps": plan.expected.co_advisor_reference_gaps,
        "projects": Project.objects.filter(workspace=workspace).count(),
        "research_profiles": ResearchProjectProfile.objects.count(),
        "research_chains": ResearchChain.objects.count(),
        "knowledge_requests": ResearchKnowledgeRequest.objects.count(),
        "main_pi": MAIN_PI_NAME,
    }


def delete_research_asset_objects(paths: Iterable[str]) -> list[str]:
    """Delete storage objects whose database references were removed by rebuild."""
    from django.core.files.storage import default_storage

    paths = [str(path) for path in paths if path]
    if not paths:
        return []
    bucket = getattr(default_storage, "aws_storage_bucket_name", None)
    s3_client = getattr(default_storage, "s3_client", None)
    if bucket and s3_client is not None:
        response = s3_client.delete_objects(
            Bucket=bucket,
            Delete={"Objects": [{"Key": path} for path in paths], "Quiet": True},
        )
        errors = response.get("Errors") or []
        if errors:
            raise PiLabBaselineError(f"存储服务删除旧科研附件失败：{len(errors)} 个对象未删除。")
        return paths
    for path in paths:
        default_storage.delete(path)
    return paths
