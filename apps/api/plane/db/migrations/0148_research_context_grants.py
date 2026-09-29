# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only

import uuid

import django.db.models.deletion
from django.db import migrations, models


class Migration(migrations.Migration):
    """Store short-lived context token hashes and revocable scope metadata."""

    dependencies = [("db", "0147_research_phase_zero_flags")]

    operations = [
        migrations.CreateModel(
            name="ResearchContextGrant",
            fields=[
                ("id", models.UUIDField(db_index=True, default=uuid.uuid4, editable=False, primary_key=True, serialize=False, unique=True)),
                ("created_at", models.DateTimeField(auto_now_add=True, verbose_name="Created At")),
                ("updated_at", models.DateTimeField(auto_now=True, verbose_name="Last Modified At")),
                ("deleted_at", models.DateTimeField(blank=True, null=True, verbose_name="Deleted At")),
                ("context_id", models.UUIDField(default=uuid.uuid4, editable=False, unique=True)),
                ("visibility_scope", models.CharField(default="PRIVATE", max_length=32)),
                ("context_hash", models.CharField(max_length=64)),
                ("token_hash", models.CharField(max_length=64, unique=True)),
                ("expires_at", models.DateTimeField(db_index=True)),
                ("revoked_at", models.DateTimeField(blank=True, null=True)),
                ("last_used_at", models.DateTimeField(blank=True, null=True)),
                ("request_id", models.CharField(max_length=128, unique=True)),
                ("chain_node", models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.PROTECT, related_name="context_grants", to="db.researchchainnode")),
                ("created_by", models.ForeignKey(null=True, on_delete=django.db.models.deletion.SET_NULL, related_name="researchcontextgrant_created_by", to="db.user", verbose_name="Created By")),
                ("project", models.ForeignKey(on_delete=django.db.models.deletion.PROTECT, related_name="research_context_grants", to="db.project")),
                ("updated_by", models.ForeignKey(null=True, on_delete=django.db.models.deletion.SET_NULL, related_name="researchcontextgrant_updated_by", to="db.user", verbose_name="Last Modified By")),
                ("user", models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name="research_context_grants", to="db.user")),
                ("workspace", models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name="research_context_grants", to="db.workspace")),
            ],
            options={"db_table": "research_context_grants", "ordering": ("-created_at",)},
        ),
        migrations.AddIndex(model_name="researchcontextgrant", index=models.Index(fields=["workspace", "user", "project"], name="rsch_ctx_ws_user_proj_idx")),
        migrations.AddIndex(model_name="researchcontextgrant", index=models.Index(fields=["workspace", "revoked_at"], name="rsch_ctx_ws_revoked_idx")),
    ]
