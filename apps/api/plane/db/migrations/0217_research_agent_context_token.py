# Copyright (c) 2023-present Plane Software, Inc. contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

from django.db import migrations, models


class Migration(migrations.Migration):
    """Store the scoped Research Context token server-side for Synlora v1 runs."""

    dependencies = [
        ("db", "0216_unified_mcp_generic_receipts"),
    ]

    operations = [
        migrations.AddField(
            model_name="researchagentsession",
            name="context_token_encrypted",
            field=models.TextField(blank=True, default=""),
        ),
    ]
