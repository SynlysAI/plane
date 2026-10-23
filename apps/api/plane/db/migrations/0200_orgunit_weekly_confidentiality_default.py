# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only

from django.db import migrations, models


class Migration(migrations.Migration):
    """Keep historical OrgUnit inserts compatible with the confidentiality column."""

    dependencies = [
        ("db", "0199_restore_home_workbench_default_grid"),
    ]

    operations = [
        migrations.AlterField(
            model_name="orgunit",
            name="weekly_report_confidential",
            field=models.BooleanField(db_default=False, default=False),
        ),
    ]
