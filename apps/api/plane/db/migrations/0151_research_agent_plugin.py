# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only

import uuid

import django.db.models.deletion
from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):
    """Add Phase 0 Agent BFF sessions and ordered run events."""

    dependencies = [("db", "0150_alter_researchchainevent_options_and_more")]

    operations = [
        migrations.CreateModel(
            name="ResearchAgentSession",
            fields=[
                ("id", models.UUIDField(db_index=True, default=uuid.uuid4, editable=False, primary_key=True, serialize=False, unique=True)),
                ("created_at", models.DateTimeField(auto_now_add=True, verbose_name="Created At")),
                ("updated_at", models.DateTimeField(auto_now=True, verbose_name="Last Modified At")),
                ("deleted_at", models.DateTimeField(blank=True, null=True, verbose_name="Deleted At")),
                ("session_id", models.UUIDField(default=uuid.uuid4, editable=False, unique=True)),
                ("run_id", models.UUIDField(default=uuid.uuid4, editable=False, unique=True)),
                ("status", models.CharField(choices=[("INITIALIZING", "Initializing"), ("READY", "Ready"), ("STREAMING", "Streaming"), ("WAITING_APPROVAL", "Waiting approval"), ("SAVING", "Saving"), ("DEGRADED", "Degraded"), ("ERROR", "Error"), ("CLOSED", "Closed")], default="INITIALIZING", max_length=24)),
                ("last_error", models.CharField(blank=True, default="", max_length=255)),
                ("request_id", models.CharField(max_length=128, unique=True)),
                ("payload_hash", models.CharField(max_length=64)),
                ("chain_node", models.ForeignKey(on_delete=django.db.models.deletion.PROTECT, related_name="agent_sessions", to="db.researchchainnode")),
                ("context_grant", models.OneToOneField(on_delete=django.db.models.deletion.PROTECT, related_name="agent_session", to="db.researchcontextgrant")),
                ("created_by", models.ForeignKey(null=True, on_delete=django.db.models.deletion.SET_NULL, related_name="%(class)s_created_by", to=settings.AUTH_USER_MODEL, verbose_name="Created By")),
                ("project", models.ForeignKey(on_delete=django.db.models.deletion.PROTECT, related_name="research_agent_sessions", to="db.project")),
                ("updated_by", models.ForeignKey(null=True, on_delete=django.db.models.deletion.SET_NULL, related_name="%(class)s_updated_by", to=settings.AUTH_USER_MODEL, verbose_name="Last Modified By")),
                ("user", models.ForeignKey(on_delete=django.db.models.deletion.PROTECT, related_name="research_agent_sessions", to="db.user")),
                ("workspace", models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name="research_agent_sessions", to="db.workspace")),
            ],
            options={"db_table": "research_agent_sessions", "ordering": ("-created_at",)},
        ),
        migrations.AddIndex(model_name="researchagentsession", index=models.Index(fields=["workspace", "user", "status"], name="rsch_agent_ws_user_idx")),
        migrations.CreateModel(
            name="ResearchAgentRunEvent",
            fields=[
                ("id", models.UUIDField(db_index=True, default=uuid.uuid4, editable=False, primary_key=True, serialize=False, unique=True)),
                ("created_at", models.DateTimeField(auto_now_add=True, db_index=True, verbose_name="Created At")),
                ("run_id", models.UUIDField(db_index=True)),
                ("seq", models.PositiveIntegerField()),
                ("event_type", models.CharField(max_length=64)),
                ("payload", models.JSONField(blank=True, default=dict)),
                ("request_id", models.CharField(max_length=128, unique=True)),
                ("session", models.ForeignKey(on_delete=django.db.models.deletion.PROTECT, related_name="run_events", to="db.researchagentsession")),
            ],
            options={"db_table": "research_agent_run_events"},
        ),
        migrations.AddConstraint(model_name="researchagentrunevent", constraint=models.UniqueConstraint(fields=("run_id", "seq"), name="rsch_agent_event_uq_seq")),
        migrations.AddIndex(model_name="researchagentrunevent", index=models.Index(fields=["run_id", "event_type"], name="rsch_agent_event_type_idx")),
    ]
