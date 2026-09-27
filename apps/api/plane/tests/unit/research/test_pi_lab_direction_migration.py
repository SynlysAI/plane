# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""方向节点迁移命令回归。"""

import json
from io import StringIO

import pytest
from django.core.management import call_command
from django.core.management.base import CommandError

from plane.db.models import (
    OrgUnit,
    OrgUnitMember,
    Project,
    ResearchProjectProfile,
)
from plane.research.services.pi_lab_baseline import TEAM_BUSINESS_CATEGORIES
from plane.research.services.pi_lab_direction_migration import (
    BASIC_VERIFICATION_NAME,
    INDUSTRY_VERIFICATION_NAME,
)
from plane.research.utils.org import build_path, order_org_units_for_tree
from plane.tests.research_fixtures import make_user, make_workspace

pytestmark = pytest.mark.django_db


def _command(*args, **options):
    """运行迁移命令并解析 JSON。

    Args:
        *args: 命令参数。
        **options: 命令选项。

    Returns:
        解析后的 JSON。
    """
    stdout = StringIO()
    call_command("migrate_pi_lab_direction_nodes", *args, stdout=stdout, json=True, **options)
    return json.loads(stdout.getvalue()), stdout.getvalue()


def _unit(workspace, name, unit_type, parent, depth, category=None):
    """创建一个带 path 的组织节点。"""
    unit = OrgUnit.objects.create(
        workspace=workspace,
        name=name,
        parent=parent,
        unit_type=unit_type,
        depth=depth,
        path="",
        business_category=category,
        is_active=True,
    )
    unit.path = build_path(unit.id, parent.path if parent is not None else None)
    unit.save(update_fields=["path"])
    return unit


@pytest.fixture
def public_tree(db):
    """搭一个根下直接挂 21 个小组、另有两个悬空验证单元的 public。"""
    owner = make_user(email="direction-admin@example.com", first_name="Admin")
    workspace = make_workspace(owner, name="Public", slug="public")
    root = _unit(workspace, "π-Lab", OrgUnit.UnitType.ROOT, None, 0)
    teams = {}
    for name, category in TEAM_BUSINESS_CATEGORIES.items():
        teams[name] = _unit(workspace, name, OrgUnit.UnitType.TEAM, root, 1, category)
    child = _unit(workspace, "器件子组", OrgUnit.UnitType.GROUP, teams["器件"], 2)
    child.is_active = False
    child.save(update_fields=["is_active"])
    basic = _unit(
        workspace,
        BASIC_VERIFICATION_NAME,
        OrgUnit.UnitType.TEAM,
        None,
        0,
        OrgUnit.BusinessCategory.BASIC_RESEARCH,
    )
    industry = _unit(
        workspace,
        INDUSTRY_VERIFICATION_NAME,
        OrgUnit.UnitType.TEAM,
        None,
        0,
        OrgUnit.BusinessCategory.INDUSTRIALIZATION,
    )
    basic_owner = make_user(email="basic-owner@example.com", first_name="Basic")
    industry_owner = make_user(email="industry-owner@example.com", first_name="Industry")
    OrgUnitMember.objects.create(
        workspace=workspace,
        org_unit=basic,
        user=basic_owner,
        org_role=OrgUnitMember.OrgRole.OWNER,
        is_primary=True,
    )
    OrgUnitMember.objects.create(
        workspace=workspace,
        org_unit=industry,
        user=industry_owner,
        org_role=OrgUnitMember.OrgRole.OWNER,
        is_primary=True,
    )
    return {
        "workspace": workspace,
        "root": root,
        "teams": teams,
        "child": child,
        "basic": basic,
        "industry": industry,
        "basic_owner": basic_owner,
        "industry_owner": industry_owner,
    }


def test_dry_run_lists_nodes_without_emails(public_tree):
    payload, raw = _command("--dry-run", workspace="public")
    assert payload["mode"] == "dry-run"
    assert len(payload["active_nodes"]) == 24
    assert {item["name"] for item in payload["deactivate"]} == {BASIC_VERIFICATION_NAME, INDUSTRY_VERIFICATION_NAME}
    assert "@" not in raw
    assert "basic-owner@example.com" not in raw
    devices = OrgUnit.objects.get(id=public_tree["teams"]["器件"].id)
    assert devices.parent_id == public_tree["root"].id


def test_apply_rehangs_teams_and_verify_expects_24(public_tree, tmp_path):
    snapshot = tmp_path / "before.json"
    payload, _raw = _command("--apply", workspace="public", snapshot=snapshot)
    assert payload["business_counts_before"] == payload["business_counts_after"]
    devices = OrgUnit.objects.get(id=public_tree["teams"]["器件"].id)
    phosphate = OrgUnit.objects.get(id=public_tree["teams"]["磷酸"].id)
    basic = OrgUnit.objects.get(name="基础研究", workspace=public_tree["workspace"])
    industry = OrgUnit.objects.get(name="产业化", workspace=public_tree["workspace"])
    assert devices.parent_id == basic.id
    assert devices.depth == 2
    assert devices.path.startswith(basic.path)
    assert phosphate.parent_id == industry.id
    child = OrgUnit.objects.get(id=public_tree["child"].id)
    assert child.path.startswith(devices.path)
    assert child.depth == 3
    assert OrgUnit.objects.get(id=public_tree["basic"].id).is_active is False
    assert OrgUnit.objects.get(id=public_tree["industry"].id).is_active is False
    assert OrgUnitMember.objects.get(user=public_tree["basic_owner"], deleted_at__isnull=True).org_unit_id == basic.id
    assert OrgUnitMember.objects.get(user=public_tree["industry_owner"], deleted_at__isnull=True).org_unit_id == industry.id
    verified, _raw = _command("--verify", workspace="public")
    assert verified["active_nodes"] == 24
    assert verified["basic_contains_devices"] is True
    assert verified["basic_contains_phosphate"] is False
    assert verified["industry_contains_phosphate"] is True
    assert verified["industry_contains_devices"] is False

    second, _raw = _command("--apply", workspace="public", snapshot=tmp_path / "second.json")
    assert second["created_direction_ids"] == []
    assert OrgUnit.objects.filter(workspace=public_tree["workspace"], name="基础研究", is_active=True).count() == 1


def test_apply_rolls_back_when_verification_unit_has_a_project(public_tree, tmp_path):
    owner = public_tree["basic_owner"]
    project = Project.objects.create(
        workspace=public_tree["workspace"],
        name="Kept project",
        identifier="KEEP",
        network=0,
        created_by=owner,
    )
    ResearchProjectProfile.objects.create(
        project=project,
        workspace=public_tree["workspace"],
        owner=owner,
        org_unit=public_tree["basic"],
        chain_kind=ResearchProjectProfile.ChainKind.RESEARCH_CHAIN,
        chain_visibility=ResearchProjectProfile.ChainVisibility.PRIVATE,
        created_by=owner,
    )
    with pytest.raises(CommandError, match="知识库绑定"):
        _command("--apply", workspace="public", snapshot=tmp_path / "blocked.json")
    assert OrgUnit.objects.get(id=public_tree["teams"]["器件"].id).parent_id == public_tree["root"].id
    assert OrgUnit.objects.get(id=public_tree["basic"].id).is_active is True
    assert not OrgUnit.objects.filter(workspace=public_tree["workspace"], name="基础研究").exists()


def test_rollback_restores_parents_and_owners(public_tree, tmp_path):
    snapshot = tmp_path / "rollback.json"
    _command("--apply", workspace="public", snapshot=snapshot)
    restored, _raw = _command("--rollback", workspace="public", snapshot=snapshot)
    assert restored["mode"] == "rollback"
    devices = OrgUnit.objects.get(id=public_tree["teams"]["器件"].id)
    assert devices.parent_id == public_tree["root"].id
    assert devices.depth == 1
    assert OrgUnit.objects.get(id=public_tree["basic"].id).is_active is True
    membership = OrgUnitMember.objects.get(user=public_tree["basic_owner"], deleted_at__isnull=True)
    assert membership.org_unit_id == public_tree["basic"].id
    assert OrgUnit.objects.get(name="基础研究", workspace=public_tree["workspace"]).is_active is False


def test_tree_order_keeps_orphan_units_after_the_root(public_tree):
    ordered = list(order_org_units_for_tree(OrgUnit.objects.filter(workspace=public_tree["workspace"], is_active=True)))
    assert ordered[0].unit_type == OrgUnit.UnitType.ROOT
    assert ordered[-1].name in {BASIC_VERIFICATION_NAME, INDUSTRY_VERIFICATION_NAME}
    assert ordered[-2].name in {BASIC_VERIFICATION_NAME, INDUSTRY_VERIFICATION_NAME}


def test_command_rejects_a_non_public_workspace(db):
    owner = make_user()
    make_workspace(owner, slug="pi")
    with pytest.raises(CommandError, match="public"):
        _command("--dry-run", workspace="pi")
