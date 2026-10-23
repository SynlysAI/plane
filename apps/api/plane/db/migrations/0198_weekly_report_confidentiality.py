# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only

from django.db import migrations, models
from django.db.models import Q


def fill_weekly_default_visibility(apps, schema_editor):
    """把未显式配置的周报默认值落为全员可见，不覆盖已有选择。"""
    setting = apps.get_model("db", "WorkspaceResearchSetting")
    setting.objects.filter(Q(weekly_default_visibility__isnull=True) | Q(weekly_default_visibility="")).update(
        weekly_default_visibility="WORKSPACE"
    )


def noop_reverse(apps, schema_editor):
    """反向迁移不猜测哪些 WORKSPACE 值原本是显式配置。"""


class Migration(migrations.Migration):
    """Add group-level weekly report confidentiality and widen weekly defaults."""

    dependencies = [
        ("db", "0197_feedback_operations_accounts"),
    ]

    operations = [
        migrations.AddField(
            model_name="orgunit",
            name="weekly_report_confidential",
            field=models.BooleanField(default=False),
        ),
        migrations.AlterField(
            model_name="workspaceresearchsetting",
            name="weekly_default_visibility",
            field=models.CharField(
                blank=True,
                choices=[
                    ("PRIVATE", "Private"),
                    ("DIRECT_ADVISOR", "Direct advisors"),
                    ("UNIT", "Organisation unit"),
                    ("ANCESTRY", "Ancestry principal investigators"),
                    ("WORKSPACE", "Workspace"),
                    ("CUSTOM", "Custom grants"),
                ],
                default="WORKSPACE",
                max_length=32,
                null=True,
            ),
        ),
        migrations.RunPython(fill_weekly_default_visibility, noop_reverse),
    ]
