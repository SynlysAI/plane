# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

from django.db import migrations, models


class Migration(migrations.Migration):
    """Add the Phase 1 research information-architecture presentation switch."""

    dependencies = [
        ("db", "0155_research_analysis_artifacts"),
    ]

    operations = [
        migrations.AddField(
            model_name="workspaceresearchsetting",
            name="research_ia_v2",
            field=models.BooleanField(default=False),
        ),
    ]
