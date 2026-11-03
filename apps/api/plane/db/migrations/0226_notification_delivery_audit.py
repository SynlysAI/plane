"""Add workspace-scoped generation diagnostics and operator retry history."""

import uuid

import django.db.models.deletion
from django.conf import settings
from django.db import migrations, models


def populate_outbox_workspaces(apps, schema_editor):
    """Backfill workspace scope from the project stored in each event payload."""
    Outbox = apps.get_model("db", "NotificationGenerationOutbox")
    Project = apps.get_model("db", "Project")
    database = schema_editor.connection.alias
    rows = []
    for outbox in Outbox.objects.using(database).filter(workspace__isnull=True).iterator():
        project_id = (outbox.payload or {}).get("project_id")
        if not project_id:
            continue
        workspace_id = (
            Project.objects.using(database).filter(pk=project_id).values_list("workspace_id", flat=True).first()
        )
        if workspace_id:
            outbox.workspace_id = workspace_id
            rows.append(outbox)
    if rows:
        Outbox.objects.using(database).bulk_update(rows, ["workspace_id"], batch_size=500)


class Migration(migrations.Migration):
    """Store tenant scope on generation events and retain audited retry actions."""

    dependencies = [
        ("db", "0225_notification_generation_outbox"),
    ]

    operations = [
        migrations.AddField(
            model_name="notificationgenerationoutbox",
            name="workspace",
            field=models.ForeignKey(
                null=True,
                on_delete=django.db.models.deletion.CASCADE,
                related_name="notification_generation_events",
                to="db.workspace",
            ),
        ),
        migrations.RunPython(populate_outbox_workspaces, migrations.RunPython.noop),
        migrations.CreateModel(
            name="NotificationDeliveryAudit",
            fields=[
                ("created_at", models.DateTimeField(auto_now_add=True, verbose_name="Created At")),
                ("updated_at", models.DateTimeField(auto_now=True, verbose_name="Last Modified At")),
                ("deleted_at", models.DateTimeField(blank=True, null=True, verbose_name="Deleted At")),
                (
                    "id",
                    models.UUIDField(
                        db_index=True,
                        default=uuid.uuid4,
                        editable=False,
                        primary_key=True,
                        serialize=False,
                        unique=True,
                    ),
                ),
                ("delivery_identifier", models.UUIDField()),
                ("event_identifier", models.UUIDField(blank=True, null=True)),
                ("action", models.CharField(max_length=32)),
                ("previous_status", models.CharField(max_length=16)),
                ("new_status", models.CharField(max_length=16)),
                ("reason", models.TextField()),
                (
                    "workspace",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="notification_delivery_audits",
                        to="db.workspace",
                    ),
                ),
                (
                    "actor",
                    models.ForeignKey(
                        null=True,
                        on_delete=django.db.models.deletion.SET_NULL,
                        related_name="notification_delivery_audits",
                        to=settings.AUTH_USER_MODEL,
                    ),
                ),
                (
                    "delivery",
                    models.ForeignKey(
                        blank=True,
                        null=True,
                        on_delete=django.db.models.deletion.SET_NULL,
                        related_name="audit_entries",
                        to="db.notificationemaildelivery",
                    ),
                ),
            ],
            options={
                "db_table": "notification_delivery_audits",
                "ordering": ("-created_at",),
            },
        ),
    ]
