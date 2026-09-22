# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only

import uuid

import django.db.models.deletion
from django.db import migrations, models


class Migration(migrations.Migration):
    """Add Phase 0 chain and account-link tables without changing old data."""

    dependencies = [("db", "0145_user_import_review_and_account_source")]

    operations = [
        migrations.AddField(
            model_name="researchprojectprofile",
            name="chain_kind",
            field=models.CharField(choices=[("LEGACY_TRAINING", "Legacy training"), ("RESEARCH_CHAIN", "Research chain")], default="LEGACY_TRAINING", max_length=24),
        ),
        migrations.AddField(
            model_name="researchprojectprofile",
            name="chain_visibility",
            field=models.CharField(choices=[("PRIVATE", "Private"), ("MEMBERS", "Members"), ("ORG", "Organisation"), ("WORKSPACE", "Workspace")], default="PRIVATE", max_length=16),
        ),
        migrations.AddIndex(
            model_name="researchprojectprofile",
            index=models.Index(fields=["workspace", "chain_kind"], name="rsch_project_ws_chain_idx"),
        ),
        migrations.CreateModel(
            name="ResearchChain",
            fields=[
                ("id", models.UUIDField(db_index=True, default=uuid.uuid4, editable=False, primary_key=True, serialize=False, unique=True)),
                ("created_at", models.DateTimeField(auto_now_add=True, verbose_name="Created At")),
                ("updated_at", models.DateTimeField(auto_now=True, verbose_name="Last Modified At")),
                ("deleted_at", models.DateTimeField(blank=True, null=True, verbose_name="Deleted At")),
                ("status", models.CharField(choices=[("ACTIVE", "Active"), ("ARCHIVED", "Archived"), ("COMPLETED", "Completed")], default="ACTIVE", max_length=16)),
                ("visibility", models.CharField(choices=[("PRIVATE", "Private"), ("MEMBERS", "Members"), ("ORG", "Organisation"), ("WORKSPACE", "Workspace")], default="PRIVATE", max_length=16)),
                ("request_id", models.CharField(max_length=128, unique=True)),
                ("payload_hash", models.CharField(max_length=64)),
                ("created_by", models.ForeignKey(null=True, on_delete=django.db.models.deletion.SET_NULL, related_name="researchchain_created_by", to="db.user", verbose_name="Created By")),
                ("updated_by", models.ForeignKey(null=True, on_delete=django.db.models.deletion.SET_NULL, related_name="researchchain_updated_by", to="db.user", verbose_name="Last Modified By")),
                ("owner", models.ForeignKey(on_delete=django.db.models.deletion.PROTECT, related_name="owned_research_chains", to="db.user")),
                ("project", models.OneToOneField(on_delete=django.db.models.deletion.PROTECT, related_name="research_chain", to="db.project")),
                ("workspace", models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name="research_chains", to="db.workspace")),
            ],
            options={"db_table": "research_chains"},
        ),
        migrations.AddIndex(model_name="researchchain", index=models.Index(fields=["workspace", "status"], name="rsch_chain_ws_status_idx")),
        migrations.CreateModel(
            name="ResearchChainNode",
            fields=[
                ("id", models.UUIDField(db_index=True, default=uuid.uuid4, editable=False, primary_key=True, serialize=False, unique=True)),
                ("created_at", models.DateTimeField(auto_now_add=True, verbose_name="Created At")),
                ("updated_at", models.DateTimeField(auto_now=True, verbose_name="Last Modified At")),
                ("deleted_at", models.DateTimeField(blank=True, null=True, verbose_name="Deleted At")),
                ("node_type", models.CharField(max_length=64)),
                ("title", models.CharField(max_length=500)),
                ("loop_iteration", models.PositiveIntegerField(default=0)),
                ("status", models.CharField(choices=[("PENDING", "Pending"), ("IN_PROGRESS", "In progress"), ("BLOCKED", "Blocked"), ("SUCCEEDED", "Succeeded"), ("FAILED", "Failed"), ("CANCELLED", "Cancelled")], default="PENDING", max_length=16)),
                ("request_id", models.CharField(max_length=128, unique=True)),
                ("payload_hash", models.CharField(max_length=64)),
                ("assignee", models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL, related_name="research_chain_nodes", to="db.user")),
                ("chain", models.ForeignKey(on_delete=django.db.models.deletion.PROTECT, related_name="nodes", to="db.researchchain")),
                ("created_by", models.ForeignKey(null=True, on_delete=django.db.models.deletion.SET_NULL, related_name="researchchainnode_created_by", to="db.user", verbose_name="Created By")),
                ("parent_node", models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.PROTECT, related_name="children", to="db.researchchainnode")),
                ("updated_by", models.ForeignKey(null=True, on_delete=django.db.models.deletion.SET_NULL, related_name="researchchainnode_updated_by", to="db.user", verbose_name="Last Modified By")),
            ],
            options={"db_table": "research_chain_nodes"},
        ),
        migrations.AddConstraint(model_name="researchchainnode", constraint=models.UniqueConstraint(fields=("chain", "parent_node", "loop_iteration"), name="rsch_node_uq_loop")),
        migrations.AddIndex(model_name="researchchainnode", index=models.Index(fields=["chain", "status"], name="rsch_node_chain_status_idx")),
        migrations.CreateModel(
            name="ResearchChainEvent",
            fields=[
                ("id", models.UUIDField(db_index=True, default=uuid.uuid4, editable=False, primary_key=True, serialize=False, unique=True)),
                ("created_at", models.DateTimeField(auto_now_add=True, db_index=True, verbose_name="Created At")),
                ("event_id", models.CharField(max_length=128, unique=True)),
                ("request_id", models.CharField(max_length=128, unique=True)),
                ("actor_type", models.CharField(default="USER", max_length=32)),
                ("source_system", models.CharField(default="PLANE", max_length=24)),
                ("event_type", models.CharField(max_length=64)),
                ("occurred_at", models.DateTimeField()),
                ("trace_id", models.CharField(blank=True, default="", max_length=128)),
                ("refs", models.JSONField(blank=True, default=list)),
                ("summary", models.TextField(blank=True, default="")),
                ("content_hash", models.CharField(blank=True, default="", max_length=64)),
                ("actor", models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL, related_name="research_chain_events", to="db.user")),
                ("chain", models.ForeignKey(on_delete=django.db.models.deletion.PROTECT, related_name="events", to="db.researchchain")),
                ("node", models.ForeignKey(on_delete=django.db.models.deletion.PROTECT, related_name="events", to="db.researchchainnode")),
            ],
            options={"db_table": "research_chain_events", "ordering": ("-created_at",)},
        ),
        migrations.AddIndex(model_name="researchchainevent", index=models.Index(fields=["chain", "occurred_at", "event_id"], name="rsch_event_chain_time_idx")),
        migrations.CreateModel(
            name="ResearchChainSnapshot",
            fields=[
                ("id", models.UUIDField(db_index=True, default=uuid.uuid4, editable=False, primary_key=True, serialize=False, unique=True)),
                ("created_at", models.DateTimeField(auto_now_add=True, db_index=True, verbose_name="Created At")),
                ("snapshot_id", models.UUIDField(default=uuid.uuid4, editable=False, unique=True)),
                ("version", models.PositiveIntegerField(default=1)),
                ("source_versions", models.JSONField(default=list)),
                ("summary", models.TextField(blank=True, default="")),
                ("content_hash", models.CharField(blank=True, default="", max_length=64)),
                ("immutable", models.BooleanField(default=True)),
                ("request_id", models.CharField(max_length=128, unique=True)),
                ("chain", models.ForeignKey(on_delete=django.db.models.deletion.PROTECT, related_name="snapshots", to="db.researchchain")),
                ("created_by", models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL, related_name="research_chain_snapshots", to="db.user")),
                ("node", models.ForeignKey(on_delete=django.db.models.deletion.PROTECT, related_name="snapshots", to="db.researchchainnode")),
            ],
            options={"db_table": "research_chain_snapshots", "ordering": ("-created_at",)},
        ),
        migrations.AddConstraint(model_name="researchchainsnapshot", constraint=models.UniqueConstraint(fields=("node", "version"), name="rsch_snapshot_uq_node_version")),
        migrations.CreateModel(
            name="ResearchReflectionLog",
            fields=[
                ("id", models.UUIDField(db_index=True, default=uuid.uuid4, editable=False, primary_key=True, serialize=False, unique=True)),
                ("created_at", models.DateTimeField(auto_now_add=True, db_index=True, verbose_name="Created At")),
                ("summary", models.TextField()),
                ("failure_reason", models.TextField(blank=True, default="")),
                ("next_actions", models.JSONField(blank=True, default=list)),
                ("chain", models.ForeignKey(on_delete=django.db.models.deletion.PROTECT, related_name="reflections", to="db.researchchain")),
                ("created_by", models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL, related_name="research_reflections", to="db.user")),
                ("node", models.ForeignKey(on_delete=django.db.models.deletion.PROTECT, related_name="reflections", to="db.researchchainnode")),
            ],
            options={"db_table": "research_reflection_logs", "ordering": ("-created_at",)},
        ),
        migrations.CreateModel(
            name="AccountLink",
            fields=[
                ("id", models.UUIDField(db_index=True, default=uuid.uuid4, editable=False, primary_key=True, serialize=False, unique=True)),
                ("created_at", models.DateTimeField(auto_now_add=True, verbose_name="Created At")),
                ("updated_at", models.DateTimeField(auto_now=True, verbose_name="Last Modified At")),
                ("deleted_at", models.DateTimeField(blank=True, null=True, verbose_name="Deleted At")),
                ("canonical_identity", models.CharField(max_length=255)),
                ("provider", models.CharField(max_length=64)),
                ("external_subject", models.CharField(max_length=255)),
                ("status", models.CharField(choices=[("PENDING", "Pending"), ("ACTIVE", "Active"), ("REVOKED", "Revoked"), ("UNLINKED", "Unlinked")], default="PENDING", max_length=16)),
                ("verified_at", models.DateTimeField(blank=True, null=True)),
                ("unlinked_at", models.DateTimeField(blank=True, null=True)),
                ("audit_event_id", models.UUIDField(blank=True, null=True)),
                ("request_id", models.CharField(max_length=128, unique=True)),
                ("payload_hash", models.CharField(max_length=64)),
                ("bound_by", models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL, related_name="research_account_links_created", to="db.user")),
                ("created_by", models.ForeignKey(null=True, on_delete=django.db.models.deletion.SET_NULL, related_name="accountlink_created_by", to="db.user", verbose_name="Created By")),
                ("local_user", models.ForeignKey(on_delete=django.db.models.deletion.PROTECT, related_name="research_account_links", to="db.user")),
                ("updated_by", models.ForeignKey(null=True, on_delete=django.db.models.deletion.SET_NULL, related_name="accountlink_updated_by", to="db.user", verbose_name="Last Modified By")),
            ],
            options={"db_table": "research_account_links"},
        ),
        migrations.AddConstraint(model_name="accountlink", constraint=models.UniqueConstraint(condition=models.Q(("deleted_at__isnull", True)), fields=("provider", "external_subject"), name="rsch_account_link_uq_subject")),
        migrations.AddConstraint(model_name="accountlink", constraint=models.UniqueConstraint(condition=models.Q(("deleted_at__isnull", True)), fields=("canonical_identity", "provider"), name="rsch_account_link_uq_identity")),
        migrations.AddIndex(model_name="accountlink", index=models.Index(fields=["local_user", "status"], name="rsch_account_link_user_idx")),
    ]
