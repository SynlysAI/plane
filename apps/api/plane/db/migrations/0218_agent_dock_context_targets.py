# Copyright (c) 2023-present Plane Software, Inc. contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

from django.db import migrations, models
import django.db.models.deletion


class Migration(migrations.Migration):
    """Extend existing Agent context/session tables to all dock target scopes."""

    dependencies = [
        ("db", "0217_research_agent_context_token"),
    ]

    operations = [
        migrations.AddField(
            model_name="researchcontextgrant",
            name="target_type",
            field=models.CharField(
                choices=[
                    ("WORKSPACE", "Workspace"),
                    ("PROJECT", "Research project"),
                    ("RESEARCH_CHAIN", "Research chain"),
                    ("RESEARCH_CHAIN_NODE", "Research chain node"),
                ],
                db_index=True,
                default="RESEARCH_CHAIN_NODE",
                max_length=32,
            ),
        ),
        migrations.AddField(
            model_name="researchcontextgrant",
            name="research_chain",
            field=models.ForeignKey(
                blank=True,
                null=True,
                on_delete=django.db.models.deletion.PROTECT,
                related_name="context_grants",
                to="db.researchchain",
            ),
        ),
        migrations.AddField(
            model_name="researchcontextgrant",
            name="context_version",
            field=models.PositiveIntegerField(default=1),
        ),
        migrations.AddField(
            model_name="researchcontextgrant",
            name="context_manifest",
            field=models.JSONField(blank=True, default=dict),
        ),
        migrations.AddField(
            model_name="researchcontextgrant",
            name="allowed_mcp_ids",
            field=models.JSONField(blank=True, default=list),
        ),
        migrations.AlterField(
            model_name="researchcontextgrant",
            name="project",
            field=models.ForeignKey(
                blank=True,
                null=True,
                on_delete=django.db.models.deletion.PROTECT,
                related_name="research_context_grants",
                to="db.project",
            ),
        ),
        migrations.AddField(
            model_name="researchagentsession",
            name="target_type",
            field=models.CharField(
                choices=[
                    ("WORKSPACE", "Workspace"),
                    ("PROJECT", "Research project"),
                    ("RESEARCH_CHAIN", "Research chain"),
                    ("RESEARCH_CHAIN_NODE", "Research chain node"),
                ],
                db_index=True,
                default="RESEARCH_CHAIN_NODE",
                max_length=32,
            ),
        ),
        migrations.AddField(
            model_name="researchagentsession",
            name="research_chain",
            field=models.ForeignKey(
                blank=True,
                null=True,
                on_delete=django.db.models.deletion.PROTECT,
                related_name="agent_sessions",
                to="db.researchchain",
            ),
        ),
        migrations.AddField(
            model_name="researchagentsession",
            name="latest_seq",
            field=models.PositiveIntegerField(default=0),
        ),
        migrations.AlterField(
            model_name="researchagentsession",
            name="project",
            field=models.ForeignKey(
                blank=True,
                null=True,
                on_delete=django.db.models.deletion.PROTECT,
                related_name="research_agent_sessions",
                to="db.project",
            ),
        ),
        migrations.AlterField(
            model_name="researchagentsession",
            name="chain_node",
            field=models.ForeignKey(
                blank=True,
                null=True,
                on_delete=django.db.models.deletion.PROTECT,
                related_name="agent_sessions",
                to="db.researchchainnode",
            ),
        ),
    ]
