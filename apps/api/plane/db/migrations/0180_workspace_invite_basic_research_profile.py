# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only

from django.db import migrations, models


class Migration(migrations.Migration):
    """Store basic research profile options on workspace invitations."""

    dependencies = [
        ("db", "0179_research_profile_bachelor_degree"),
    ]

    operations = [
        migrations.AddField(
            model_name="workspacememberinvite",
            name="display_name",
            field=models.CharField(blank=True, default="", max_length=255),
        ),
        migrations.AddField(
            model_name="workspacememberinvite",
            name="research_profile_enabled",
            field=models.BooleanField(default=False),
        ),
        migrations.AddField(
            model_name="workspacememberinvite",
            name="research_profile_category",
            field=models.CharField(blank=True, default="", max_length=16),
        ),
    ]
