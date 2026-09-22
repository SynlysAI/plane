# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only

from django.db import migrations, models


class Migration(migrations.Migration):
    """Add disabled-by-default workspace feature flags for Phase 0."""

    dependencies = [("db", "0146_research_chain_foundation")]

    operations = [
        migrations.AddField("workspaceresearchsetting", "research_chain_enabled", models.BooleanField(default=False)),
        migrations.AddField("workspaceresearchsetting", "research_agent_enabled", models.BooleanField(default=False)),
        migrations.AddField("workspaceresearchsetting", "research_trace_enabled", models.BooleanField(default=False)),
        migrations.AddField("workspaceresearchsetting", "research_account_link_enabled", models.BooleanField(default=False)),
        migrations.AddField("workspaceresearchsetting", "research_external_rag_enabled", models.BooleanField(default=False)),
    ]
