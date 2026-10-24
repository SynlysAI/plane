# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only

import pytest
import runpy
from pathlib import Path

from django.apps import apps

from plane.db.models import OrgUnit, WorkspaceResearchSetting
from plane.research.utils.settings import (
    default_visibility_for,
    org_unit_is_weekly_confidential,
    weekly_confidential_paths,
)
from plane.tests.research_fixtures import (
    enable_research,
    make_research_org_unit,
    make_user,
    make_workspace,
)


@pytest.mark.django_db
def test_weekly_reports_default_to_workspace_visibility(db):
    """周报空配置时默认全员可见，通用默认不影响月报。"""
    admin = make_user(first_name="Admin")
    workspace = make_workspace(admin)
    enable_research(workspace)

    assert default_visibility_for("WEEKLY", workspace) == "WORKSPACE"
    assert default_visibility_for("MONTHLY", workspace) == "DIRECT_ADVISOR"


@pytest.mark.django_db
def test_explicit_weekly_visibility_is_preserved(db):
    """显式配置的周报默认值优先于内置默认值。"""
    admin = make_user(first_name="Admin")
    workspace = make_workspace(admin)
    enable_research(workspace, weekly_default_visibility="UNIT")

    assert default_visibility_for("WEEKLY", workspace) == "UNIT"


@pytest.mark.django_db
def test_confidential_subtree_narrows_weekly_default_to_unit(db):
    """保密配置作用于本节点和子组，并把周报上限收窄到本组。"""
    admin = make_user(first_name="Admin")
    workspace = make_workspace(admin)
    setting = enable_research(workspace)
    root = make_research_org_unit(workspace, "Root", None, OrgUnit.UnitType.ROOT)
    parent = make_research_org_unit(workspace, "Institute", root, OrgUnit.UnitType.INSTITUTE)
    child = make_research_org_unit(workspace, "Group", parent, OrgUnit.UnitType.GROUP)
    outside = make_research_org_unit(workspace, "Other", root, OrgUnit.UnitType.GROUP)
    parent.weekly_report_confidential = True
    parent.save(update_fields=["weekly_report_confidential"])

    assert weekly_confidential_paths(workspace) == [parent.path]
    assert org_unit_is_weekly_confidential(parent, workspace) is True
    assert org_unit_is_weekly_confidential(child, workspace) is True
    assert org_unit_is_weekly_confidential(outside, workspace) is False
    assert default_visibility_for("WEEKLY", workspace, child) == "UNIT"
    assert default_visibility_for("MONTHLY", workspace, child) == "DIRECT_ADVISOR"

    setting.weekly_default_visibility = "PRIVATE"
    setting.save(update_fields=["weekly_default_visibility"])
    assert default_visibility_for("WEEKLY", workspace, child) == "PRIVATE"


@pytest.mark.django_db
def test_missing_org_unit_is_not_confidential(db):
    """没有组织归属的报告不落入任何保密子树。"""
    admin = make_user(first_name="Admin")
    workspace = make_workspace(admin)
    enable_research(workspace)

    assert org_unit_is_weekly_confidential(None, workspace) is False
    assert default_visibility_for("WEEKLY", workspace, None) == "WORKSPACE"
    assert WorkspaceResearchSetting.objects.filter(workspace=workspace).exists()


@pytest.mark.django_db
def test_weekly_visibility_migration_fills_only_empty_values(db):
    """迁移只补空值，不覆盖管理员显式选择的周报默认级别。"""
    empty = make_workspace(make_user(first_name="Empty Admin"), name="Empty Workspace")
    explicit = make_workspace(make_user(first_name="Explicit Admin"), name="Explicit Workspace")
    WorkspaceResearchSetting.objects.create(workspace=empty, created_by=empty.owner)
    WorkspaceResearchSetting.objects.create(
        workspace=explicit,
        created_by=explicit.owner,
        weekly_default_visibility="UNIT",
    )
    WorkspaceResearchSetting.objects.filter(workspace=empty).update(weekly_default_visibility=None)
    migration_path = Path(__file__).parents[3] / "db/migrations/0198_weekly_report_confidentiality.py"
    migration = runpy.run_path(str(migration_path))

    migration["fill_weekly_default_visibility"](apps, None)

    empty_setting = WorkspaceResearchSetting.objects.get(workspace=empty)
    explicit_setting = WorkspaceResearchSetting.objects.get(workspace=explicit)
    assert empty_setting.weekly_default_visibility == "WORKSPACE"
    assert explicit_setting.weekly_default_visibility == "UNIT"
