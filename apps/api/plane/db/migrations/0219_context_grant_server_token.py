# Copyright (c) 2023-present Plane Software, Inc. contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

from django.db import migrations, models


class Migration(migrations.Migration):
    """Keep the opaque dock context token server-side until session creation."""

    dependencies = [
        ("db", "0218_agent_dock_context_targets"),
    ]

    operations = [
        migrations.AddField(
            model_name="researchcontextgrant",
            name="context_token_encrypted",
            field=models.TextField(blank=True, default=""),
        ),
    ]
