# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

from collections import defaultdict

from django.db import migrations


LEGACY_DEFAULT_LAYOUT = {
    "my_todos": (True, {"size": "medium"}, 1100),
    "research_projects": (True, {"size": "large"}, 1000),
    "administrative_projects": (True, {"size": "medium"}, 900),
    "recent_activity": (True, {"size": "medium"}, 800),
    "report_summary": (True, {"size": "medium"}, 700),
    "workbench_layout": (True, {"density": "compact"}, 100),
}
NEW_DEFAULT_LAYOUT = {
    **LEGACY_DEFAULT_LAYOUT,
    "administrative_projects": (True, {"size": "small"}, 900),
    "recent_activity": (True, {"size": "small"}, 800),
    "report_summary": (True, {"size": "small"}, 700),
}
BOTTOM_WIDGET_KEYS = ("administrative_projects", "recent_activity", "report_summary")


def _find_matching_groups(preference_model, expected_layout):
    """返回与整组预期默认值完全一致且未删除的偏好行。"""
    rows = preference_model.objects.filter(
        key__in=expected_layout.keys(),
        deleted_at__isnull=True,
    )
    grouped = defaultdict(list)
    for row in rows:
        grouped[(row.workspace_id, row.user_id)].append(row)

    matched = []
    for group_rows in grouped.values():
        if len(group_rows) != len(expected_layout):
            continue
        if all(
            row.is_enabled == expected_layout[row.key][0]
            and row.config == expected_layout[row.key][1]
            and row.sort_order == expected_layout[row.key][2]
            for row in group_rows
        ):
            matched.extend(row for row in group_rows if row.key in BOTTOM_WIDGET_KEYS)
    return matched


def restore_default_grid(apps, schema_editor):
    """把仍未自定义的旧默认首页组合升级为上二下三栅格。"""
    preference_model = apps.get_model("db", "WorkspaceHomePreference")
    rows = _find_matching_groups(preference_model, LEGACY_DEFAULT_LAYOUT)
    for row in rows:
        row.config = {"size": "small"}
    preference_model.objects.bulk_update(rows, ["config"])


def restore_default_grid_reverse(apps, schema_editor):
    """仅把仍等于新默认值的组合恢复为旧默认下三栏尺寸。"""
    preference_model = apps.get_model("db", "WorkspaceHomePreference")
    rows = _find_matching_groups(preference_model, NEW_DEFAULT_LAYOUT)
    for row in rows:
        row.config = {"size": "medium"}
    preference_model.objects.bulk_update(rows, ["config"])


class Migration(migrations.Migration):
    """Restore the previous two-row default home workbench grid."""

    dependencies = [
        ("db", "0198_weekly_report_confidentiality"),
    ]

    operations = [
        migrations.RunPython(restore_default_grid, restore_default_grid_reverse),
    ]
