# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""把当前 public 组织树迁到「根 → 方向 → 小组」，不重建账号。"""

from __future__ import annotations

from django.db import transaction
from django.utils import timezone
from django.utils.dateparse import parse_datetime

from plane.db.models import (
    OrgUnit,
    OrgUnitMember,
    PeriodicReport,
    Project,
    ResearchChain,
    ResearchGroupKnowledgeBinding,
    ResearchProjectProfile,
)
from plane.research.services.pi_lab_baseline import DIRECTION_NAMES, TEAM_BUSINESS_CATEGORIES
from plane.research.utils.audit import ResearchAuditAction, ResearchResourceType, record_audit_event
from plane.research.utils.org import build_path, move_subtree
from plane.research.utils.roles import PUBLIC_WORKSPACE_SLUG

BASIC_DIRECTION_NAME = DIRECTION_NAMES[OrgUnit.BusinessCategory.BASIC_RESEARCH]
INDUSTRY_DIRECTION_NAME = DIRECTION_NAMES[OrgUnit.BusinessCategory.INDUSTRIALIZATION]
BASIC_VERIFICATION_NAME = "Phase 1.5 基础研究验证单元"
INDUSTRY_VERIFICATION_NAME = "Phase 1.5 产业化验证单元"
VERIFICATION_DIRECTION = {
    BASIC_VERIFICATION_NAME: BASIC_DIRECTION_NAME,
    INDUSTRY_VERIFICATION_NAME: INDUSTRY_DIRECTION_NAME,
}
EXPECTED_ACTIVE_NODES = 24
SNAPSHOT_SCHEMA_VERSION = 1


class PiLabDirectionMigrationError(Exception):
    """当前组织树不满足迁移或校验条件。"""


def _active_units(workspace):
    """返回工作区里未删除的活动组织节点。"""
    return OrgUnit.objects.filter(workspace=workspace, is_active=True, deleted_at__isnull=True)


def _node_payload(unit) -> dict:
    """序列化一个节点，不包含邮箱或人名。

    Args:
        unit: 组织节点。

    Returns:
        迁移输出使用的节点摘要。
    """
    return {
        "id": str(unit.id),
        "parent_id": str(unit.parent_id) if unit.parent_id else None,
        "unit_type": unit.unit_type,
        "path": unit.path,
        "depth": unit.depth,
        "name": unit.name,
    }


def _root(workspace):
    """返回 public 的唯一活动根节点。"""
    root = _active_units(workspace).filter(unit_type=OrgUnit.UnitType.ROOT, parent__isnull=True).first()
    if root is None:
        raise PiLabDirectionMigrationError("缺少活动的 π-Lab 根节点。")
    return root


def _single_named(workspace, name):
    """按名称取得唯一未删除节点。

    Args:
        workspace: 工作区。
        name: 组织节点名称。

    Returns:
        节点；不存在时为 None。
    """
    matches = list(OrgUnit.objects.filter(workspace=workspace, name=name, deleted_at__isnull=True))
    if len(matches) > 1:
        raise PiLabDirectionMigrationError(f"组织节点重名：{name}")
    return matches[0] if matches else None


def business_counts(workspace) -> dict:
    """统计迁移不得改变的业务对象数量。

    Args:
        workspace: 工作区。

    Returns:
        项目、课题和周报数量。
    """
    return {
        "projects": Project.objects.filter(workspace=workspace, deleted_at__isnull=True).count(),
        "profiles": ResearchProjectProfile.objects.filter(workspace=workspace, deleted_at__isnull=True).count(),
        "reports": PeriodicReport.objects.filter(workspace=workspace, deleted_at__isnull=True).count(),
    }


def _blocking_usage(unit) -> dict:
    """统计挂在验证单元上、会阻止停用的业务对象。

    Args:
        unit: 准备停用的验证单元。

    Returns:
        课题、项目、研究链和知识库绑定数量。
    """
    profiles = ResearchProjectProfile.objects.filter(org_unit=unit, deleted_at__isnull=True)
    project_ids = list(profiles.values_list("project_id", flat=True))
    return {
        "profiles": profiles.count(),
        "projects": Project.objects.filter(id__in=project_ids, deleted_at__isnull=True).count() if project_ids else 0,
        "chains": ResearchChain.objects.filter(project_id__in=project_ids, deleted_at__isnull=True).count()
        if project_ids
        else 0,
        "knowledge_bindings": ResearchGroupKnowledgeBinding.objects.filter(
            org_unit=unit, deleted_at__isnull=True
        ).count(),
    }


def capture_snapshot(workspace) -> dict:
    """保存组织节点和成员关系的迁移前快照。

    Args:
        workspace: 工作区。

    Returns:
        可写回的快照。不含邮箱。
    """
    units = []
    for unit in OrgUnit.objects.filter(workspace=workspace).order_by("id"):
        units.append(
            {
                "id": str(unit.id),
                "parent_id": str(unit.parent_id) if unit.parent_id else None,
                "path": unit.path,
                "depth": unit.depth,
                "unit_type": unit.unit_type,
                "business_category": unit.business_category,
                "is_active": unit.is_active,
                "deleted_at": unit.deleted_at.isoformat() if unit.deleted_at else None,
            }
        )
    members = []
    for member in OrgUnitMember.objects.filter(workspace=workspace).order_by("id"):
        members.append(
            {
                "id": str(member.id),
                "org_unit_id": str(member.org_unit_id),
                "org_role": member.org_role,
                "is_primary": member.is_primary,
                "deleted_at": member.deleted_at.isoformat() if member.deleted_at else None,
            }
        )
    return {
        "schema_version": SNAPSHOT_SCHEMA_VERSION,
        "workspace": workspace.slug,
        "units": units,
        "members": members,
        "created_direction_ids": [],
    }


def plan_direction_migration(workspace) -> dict:
    """预览迁移，不写数据库。

    Args:
        workspace: 目标工作区，只能是 public。

    Returns:
        活动节点、即将停用的验证单元和业务数量。
    """
    _require_public(workspace)
    root = _root(workspace)
    active = [_node_payload(unit) for unit in _active_units(workspace).order_by("depth", "path", "id")]
    deactivate = []
    for name in VERIFICATION_DIRECTION:
        unit = _single_named(workspace, name)
        if unit is not None and unit.is_active and unit.deleted_at is None:
            payload = _node_payload(unit)
            payload["blocking"] = _blocking_usage(unit)
            deactivate.append(payload)
    missing = [name for name in TEAM_BUSINESS_CATEGORIES if _single_named(workspace, name) is None]
    return {
        "mode": "dry-run",
        "root_id": str(root.id),
        "active_nodes": active,
        "deactivate": deactivate,
        "missing_teams": missing,
        "business_counts": business_counts(workspace),
    }


def apply_direction_migration(workspace, actor) -> dict:
    """在一个事务里重挂方向和小组，并停用空的验证单元。

    Args:
        workspace: 目标工作区，只能是 public。
        actor: 写入审计的操作者。

    Returns:
        迁移结果。业务对象数量发生变化时整批回滚。
    """
    _require_public(workspace)
    if actor is None:
        raise PiLabDirectionMigrationError("public 工作区没有可用的操作者。")
    before_ids = set(OrgUnit.objects.filter(workspace=workspace).values_list("id", flat=True))
    with transaction.atomic():
        before_counts = business_counts(workspace)
        root = _root(workspace)
        directions = {
            BASIC_DIRECTION_NAME: _ensure_direction(
                workspace, root, BASIC_DIRECTION_NAME, OrgUnit.BusinessCategory.BASIC_RESEARCH, actor
            ),
            INDUSTRY_DIRECTION_NAME: _ensure_direction(
                workspace, root, INDUSTRY_DIRECTION_NAME, OrgUnit.BusinessCategory.INDUSTRIALIZATION, actor
            ),
        }
        for team_name, category in TEAM_BUSINESS_CATEGORIES.items():
            team = _single_named(workspace, team_name)
            if team is None or not team.is_active:
                raise PiLabDirectionMigrationError(f"缺少活动小组：{team_name}")
            direction = directions[DIRECTION_NAMES[category]]
            _rehang_team(team, direction, category)
        moved_members = 0
        deactivated = []
        for verification_name, direction_name in VERIFICATION_DIRECTION.items():
            unit = _single_named(workspace, verification_name)
            if unit is None:
                continue
            moved_members += _move_owners(unit, directions[direction_name])
            if _retire_verification_unit(unit):
                deactivated.append(str(unit.id))
        after_counts = business_counts(workspace)
        if after_counts != before_counts:
            raise PiLabDirectionMigrationError("迁移改变了项目、课题或周报数量。")
        record_audit_event(
            workspace=workspace,
            action=ResearchAuditAction.ORG_UNIT_MOVE,
            resource_type=ResearchResourceType.ORG_UNIT,
            resource_id=root.id,
            actor=actor,
            org_unit=root,
            metadata={
                "command": "migrate_pi_lab_direction_nodes",
                "deactivated": deactivated,
                "moved_owner_memberships": moved_members,
            },
        )
        created = [
            str(unit_id)
            for unit_id in OrgUnit.objects.filter(workspace=workspace).exclude(id__in=before_ids).values_list("id", flat=True)
        ]
    return {
        "mode": "apply",
        "deactivated": deactivated,
        "moved_owner_memberships": moved_members,
        "created_direction_ids": created,
        "business_counts_before": before_counts,
        "business_counts_after": after_counts,
        "directions": {name: str(unit.id) for name, unit in directions.items()},
    }


def verify_direction_migration(workspace) -> dict:
    """核对活动节点为 1 个根、2 个方向和 21 个小组。

    Args:
        workspace: 目标工作区。

    Returns:
        校验摘要。不符合时期望调用方视为失败。
    """
    _require_public(workspace)
    active = list(_active_units(workspace))
    root = _root(workspace)
    directions = {
        name: _single_named(workspace, name)
        for name in (BASIC_DIRECTION_NAME, INDUSTRY_DIRECTION_NAME)
    }
    problems = []
    if len(active) != EXPECTED_ACTIVE_NODES:
        problems.append(f"活动节点应为 {EXPECTED_ACTIVE_NODES}，实际 {len(active)}")
    for name, direction in directions.items():
        if (
            direction is None
            or not direction.is_active
            or direction.unit_type != OrgUnit.UnitType.LAB
            or direction.parent_id != root.id
        ):
            problems.append(f"方向节点不完整：{name}")
    team_ids = set()
    for team_name, category in TEAM_BUSINESS_CATEGORIES.items():
        team = _single_named(workspace, team_name)
        direction = directions.get(DIRECTION_NAMES[category])
        if team is None or not team.is_active or direction is None or team.parent_id != direction.id or team.depth != 2:
            problems.append(f"小组未挂到方向：{team_name}")
        elif team.business_category != category:
            problems.append(f"小组业务方向不一致：{team_name}")
        else:
            team_ids.add(team.id)
    known_ids = {root.id, *[unit.id for unit in directions.values() if unit is not None], *team_ids}
    extras = [unit.name for unit in active if unit.id not in known_ids]
    if extras:
        problems.append(f"存在预期之外的活动节点：{extras}")
    basic = directions[BASIC_DIRECTION_NAME]
    industry = directions[INDUSTRY_DIRECTION_NAME]
    basic_names = _descendant_names(basic) if basic is not None else set()
    industry_names = _descendant_names(industry) if industry is not None else set()
    if "器件" not in basic_names or "磷酸" in basic_names:
        problems.append("基础研究的后代应包含器件，且不包含磷酸。")
    if "磷酸" not in industry_names or "器件" in industry_names:
        problems.append("产业化的后代应包含磷酸，且不包含器件。")
    for name in VERIFICATION_DIRECTION:
        unit = _single_named(workspace, name)
        if unit is not None and unit.is_active:
            problems.append(f"验证单元仍是活动节点：{name}")
    if problems:
        raise PiLabDirectionMigrationError("；".join(problems))
    return {
        "mode": "verify",
        "active_nodes": len(active),
        "root": 1,
        "directions": 2,
        "teams": len(team_ids),
        "basic_contains_devices": "器件" in basic_names,
        "basic_contains_phosphate": "磷酸" in basic_names,
        "industry_contains_phosphate": "磷酸" in industry_names,
        "industry_contains_devices": "器件" in industry_names,
    }


def restore_direction_snapshot(workspace, snapshot) -> dict:
    """按快照恢复父节点、path 和成员归属。

    Args:
        workspace: 目标工作区。
        snapshot: ``capture_snapshot`` 写出的内容。

    Returns:
        恢复的节点数和成员数。不删除审计，也不物理删除节点。
    """
    _require_public(workspace)
    if snapshot.get("schema_version") != SNAPSHOT_SCHEMA_VERSION or snapshot.get("workspace") != workspace.slug:
        raise PiLabDirectionMigrationError("组织迁移快照与当前工作区不匹配。")
    with transaction.atomic():
        for row in snapshot.get("units") or []:
            unit = OrgUnit.objects.filter(workspace=workspace, id=row["id"]).first()
            if unit is None:
                raise PiLabDirectionMigrationError("快照中的组织节点已不存在，停止恢复。")
            unit.parent_id = row["parent_id"]
            unit.path = row["path"]
            unit.depth = row["depth"]
            unit.unit_type = row["unit_type"]
            unit.business_category = row["business_category"]
            unit.is_active = row["is_active"]
            unit.deleted_at = parse_datetime(row["deleted_at"]) if row.get("deleted_at") else None
            unit.save(
                update_fields=[
                    "parent",
                    "path",
                    "depth",
                    "unit_type",
                    "business_category",
                    "is_active",
                    "deleted_at",
                    "updated_at",
                ]
            )
        member_rows = list(snapshot.get("members") or [])
        member_ids = [row["id"] for row in member_rows]
        OrgUnitMember.objects.filter(workspace=workspace, id__in=member_ids).update(is_primary=False)
        for row in member_rows:
            member = OrgUnitMember.objects.filter(workspace=workspace, id=row["id"]).first()
            if member is None:
                raise PiLabDirectionMigrationError("快照中的组织成员已不存在，停止恢复。")
            member.org_unit_id = row["org_unit_id"]
            member.org_role = row["org_role"]
            member.is_primary = row["is_primary"]
            member.deleted_at = parse_datetime(row["deleted_at"]) if row.get("deleted_at") else None
            member.save(update_fields=["org_unit", "org_role", "is_primary", "deleted_at", "updated_at"])
        retired = 0
        for unit_id in snapshot.get("created_direction_ids") or []:
            created = OrgUnit.objects.filter(workspace=workspace, id=unit_id).first()
            if created is None or not created.is_active:
                continue
            if _blocking_usage(created) != {"profiles": 0, "projects": 0, "chains": 0, "knowledge_bindings": 0}:
                raise PiLabDirectionMigrationError("迁移新建的方向节点已有业务数据，不能停用。")
            created.is_active = False
            created.save(update_fields=["is_active", "updated_at"])
            retired += 1
    return {"mode": "rollback", "units": len(snapshot.get("units") or []), "members": len(member_rows), "retired_created_directions": retired}


def _require_public(workspace):
    """限制迁移只作用于 public。"""
    if workspace is None or workspace.slug != PUBLIC_WORKSPACE_SLUG:
        raise PiLabDirectionMigrationError("方向节点迁移只能作用于 public 工作区。")


def _ensure_direction(workspace, root, name, category, actor):
    """确保方向节点位于根下。已存在则复用。

    Args:
        workspace: 工作区。
        root: π-Lab 根。
        name: 方向名称。
        category: 业务方向。
        actor: 创建者。

    Returns:
        方向节点。
    """
    unit = _single_named(workspace, name)
    if unit is None:
        unit = OrgUnit(
            workspace=workspace,
            name=name,
            parent=root,
            unit_type=OrgUnit.UnitType.LAB,
            business_category=category,
            depth=root.depth + 1,
            path="",
            is_active=True,
            created_by=actor,
        )
        unit.path = build_path(unit.id, root.path)
        unit.save()
        return unit
    if unit.id == root.id:
        raise PiLabDirectionMigrationError(f"方向名称与根节点冲突：{name}")
    if not unit.path:
        raise PiLabDirectionMigrationError(f"方向节点缺少 path：{name}")
    if unit.parent_id != root.id:
        move_subtree(unit, root)
        unit.refresh_from_db()
    unit.unit_type = OrgUnit.UnitType.LAB
    unit.business_category = category
    unit.is_active = True
    unit.deleted_at = None
    unit.save(update_fields=["unit_type", "business_category", "is_active", "deleted_at", "updated_at"])
    return unit


def _rehang_team(team, direction, category):
    """把小组挂到方向下，并重算自身与后代的 path、depth。"""
    if not team.path:
        raise PiLabDirectionMigrationError(f"小组缺少 path：{team.name}")
    if team.parent_id != direction.id or not team.path.startswith(direction.path):
        move_subtree(team, direction)
        team.refresh_from_db()
    if team.business_category != category:
        team.business_category = category
        team.save(update_fields=["business_category", "updated_at"])


def _move_owners(source, direction) -> int:
    """把验证单元上的 OWNER 迁到对应方向，角色不变。

    Args:
        source: 验证单元。
        direction: 目标方向。

    Returns:
        迁移的成员关系数量。
    """
    moved = 0
    members = list(
        OrgUnitMember.objects.filter(
            org_unit=source,
            org_role=OrgUnitMember.OrgRole.OWNER,
            deleted_at__isnull=True,
        )
    )
    for member in members:
        existing = (
            OrgUnitMember.objects.filter(
                org_unit=direction,
                user_id=member.user_id,
                org_role=OrgUnitMember.OrgRole.OWNER,
                deleted_at__isnull=True,
            )
            .exclude(id=member.id)
            .first()
        )
        if existing is not None:
            if member.is_primary and not existing.is_primary:
                member.is_primary = False
                member.save(update_fields=["is_primary", "updated_at"])
                existing.is_primary = True
                existing.save(update_fields=["is_primary", "updated_at"])
            member.is_primary = False
            member.deleted_at = timezone.now()
            member.save(update_fields=["is_primary", "deleted_at", "updated_at"])
        else:
            member.org_unit = direction
            member.save(update_fields=["org_unit", "updated_at"])
        moved += 1
    return moved


def _retire_verification_unit(unit) -> bool:
    """没有课题、项目和研究链或知识库绑定时停用验证单元。

    Args:
        unit: 验证单元。

    Returns:
        本次是否从活动改为停用。
    """
    usage = _blocking_usage(unit)
    if any(usage.values()):
        raise PiLabDirectionMigrationError(f"{unit.name} 仍有课题、项目或知识库绑定，已整批回滚。")
    if not unit.is_active:
        return False
    unit.is_active = False
    unit.save(update_fields=["is_active", "updated_at"])
    return True


def _descendant_names(unit) -> set[str]:
    """返回节点后代的名称。"""
    if unit is None or not unit.path:
        return set()
    return set(
        OrgUnit.objects.filter(workspace=unit.workspace, path__startswith=unit.path, is_active=True)
        .exclude(id=unit.id)
        .values_list("name", flat=True)
    )
