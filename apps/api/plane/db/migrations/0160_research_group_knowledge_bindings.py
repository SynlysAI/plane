import uuid

import django.db.models.deletion
from django.conf import settings
from django.db import migrations, models


def archive_pending_chain_requests(apps, schema_editor):
    """Move unfinished per-chain knowledge requests onto their team binding."""
    from plane.research.services.group_knowledge import migrate_pending_chain_requests

    migrate_pending_chain_requests()


class Migration(migrations.Migration):
    """Share one WeKnora knowledge base across every chain in a team."""

    dependencies = [("db", "0159_research_review_scope")]

    operations = [
        migrations.CreateModel(
            name="ResearchGroupKnowledgeBinding",
            fields=[
                ("created_at", models.DateTimeField(auto_now_add=True, verbose_name="Created At")),
                ("updated_at", models.DateTimeField(auto_now=True, verbose_name="Last Modified At")),
                ("deleted_at", models.DateTimeField(blank=True, null=True, verbose_name="Deleted At")),
                (
                    "id",
                    models.UUIDField(
                        db_index=True, default=uuid.uuid4, editable=False, primary_key=True, serialize=False, unique=True
                    ),
                ),
                ("request_key", models.CharField(max_length=128, unique=True)),
                (
                    "state",
                    models.CharField(
                        choices=[
                            ("REQUESTED", "Requested"),
                            ("PENDING_ADMIN", "Pending administrator"),
                            ("NEEDS_INFO", "Needs information"),
                            ("REJECTED", "Rejected"),
                            ("CREATED_PENDING_BINDING", "Created pending binding"),
                            ("READY", "Ready"),
                            ("FAILED", "Failed"),
                            ("ARCHIVED", "Archived"),
                            ("RESTORE_PENDING", "Restore pending"),
                        ],
                        default="PENDING_ADMIN",
                        max_length=32,
                    ),
                ),
                ("external_kb_id", models.CharField(blank=True, default="", max_length=128)),
                ("external_kb_name", models.CharField(blank=True, default="", max_length=255)),
                ("parameter_summary", models.JSONField(blank=True, default=dict)),
                ("rejection_reason", models.TextField(blank=True, default="")),
                ("last_error", models.TextField(blank=True, default="")),
                ("processed_at", models.DateTimeField(blank=True, null=True)),
                (
                    "org_unit",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.PROTECT,
                        related_name="group_knowledge_bindings",
                        to="db.orgunit",
                    ),
                ),
                (
                    "processed_by",
                    models.ForeignKey(
                        blank=True,
                        null=True,
                        on_delete=django.db.models.deletion.SET_NULL,
                        related_name="processed_research_group_knowledge_bindings",
                        to="db.user",
                    ),
                ),
                (
                    "workspace",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="research_group_knowledge_bindings",
                        to="db.workspace",
                    ),
                ),
                (
                    "created_by",
                    models.ForeignKey(
                        null=True,
                        on_delete=django.db.models.deletion.SET_NULL,
                        related_name="%(class)s_created_by",
                        to=settings.AUTH_USER_MODEL,
                        verbose_name="Created By",
                    ),
                ),
                (
                    "updated_by",
                    models.ForeignKey(
                        null=True,
                        on_delete=django.db.models.deletion.SET_NULL,
                        related_name="%(class)s_updated_by",
                        to=settings.AUTH_USER_MODEL,
                        verbose_name="Last Modified By",
                    ),
                ),
            ],
            options={
                "db_table": "research_group_knowledge_bindings",
                "ordering": ("-created_at",),
                "indexes": [
                    models.Index(fields=["workspace", "state"], name="rsch_grp_kb_ws_state_idx"),
                    models.Index(fields=["external_kb_id"], name="rsch_grp_kb_external_idx"),
                ],
            },
        ),
        migrations.AddConstraint(
            model_name="researchgroupknowledgebinding",
            constraint=models.UniqueConstraint(
                condition=models.Q(deleted_at__isnull=True),
                fields=("workspace", "org_unit"),
                name="rsch_grp_kb_ws_unit_uq",
            ),
        ),
        migrations.RunPython(archive_pending_chain_requests, migrations.RunPython.noop),
    ]
