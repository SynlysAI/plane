import uuid
import django.db.models.deletion
from django.conf import settings
from django.db import migrations, models


def audit_fields():
    return [
        ("id", models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False, unique=True, db_index=True, serialize=False)),
        ("created_at", models.DateTimeField(auto_now_add=True, verbose_name="Created At")),
        ("updated_at", models.DateTimeField(auto_now=True, verbose_name="Last Modified At")),
        ("deleted_at", models.DateTimeField(blank=True, null=True, verbose_name="Deleted At")),
        ("created_by", models.ForeignKey(null=True, on_delete=django.db.models.deletion.SET_NULL, related_name="%(class)s_created_by", to=settings.AUTH_USER_MODEL, verbose_name="Created By")),
        ("updated_by", models.ForeignKey(null=True, on_delete=django.db.models.deletion.SET_NULL, related_name="%(class)s_updated_by", to=settings.AUTH_USER_MODEL, verbose_name="Last Modified By")),
    ]


def preserve_workspace_configuration(apps, schema_editor):
    workspace_model = apps.get_model("db", "Workspace")
    setting_model = apps.get_model("db", "WorkspaceResearchSetting")
    # An absent row previously inherited this deployment value. Existing rows
    # are authoritative and must never be overwritten by a layout migration.
    enabled = bool(getattr(settings, "RESEARCH_MODULE_ENABLED", False))
    for workspace_id in workspace_model.objects.using(schema_editor.connection.alias).exclude(
        pk__in=setting_model.objects.using(schema_editor.connection.alias).values("workspace_id")
    ).values_list("id", flat=True).iterator():
        setting_model.objects.using(schema_editor.connection.alias).create(
            workspace_id=workspace_id, module_enabled=enabled, research_chain_enabled=True,
        )


class Migration(migrations.Migration):
    dependencies = [("db", "0180_workspace_invite_basic_research_profile")]
    operations = [
        migrations.RunPython(preserve_workspace_configuration, migrations.RunPython.noop),
        migrations.CreateModel(name="AdministrativeApprovalFlow", fields=audit_fields() + [
            ("workspace", models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, to="db.workspace")),
            ("organization", models.ForeignKey(on_delete=django.db.models.deletion.PROTECT, to="db.administrativeorganization")),
            ("family_id", models.UUIDField(default=uuid.uuid4)),
            ("version", models.PositiveIntegerField(default=1)),
            ("name", models.CharField(max_length=255)),
            ("is_active", models.BooleanField(default=True)),
        ], options={"db_table": "administrative_approval_flows", "constraints": [models.UniqueConstraint(fields=("family_id", "version"), name="admin_flow_version_uq")]}),
        migrations.CreateModel(name="AdministrativeApprovalStep", fields=audit_fields() + [
            ("flow", models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name="steps", to="db.administrativeapprovalflow")),
            ("order", models.PositiveSmallIntegerField()),
            ("approver_kind", models.CharField(max_length=16, choices=[("ORG_ADMIN", "Organization admin"), ("USER", "User")])),
            ("approver", models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.PROTECT, to=settings.AUTH_USER_MODEL)),
        ], options={"db_table": "administrative_approval_steps", "ordering": ["order"], "constraints": [models.UniqueConstraint(fields=("flow", "order"), name="admin_step_order_uq")]}),
        migrations.CreateModel(name="AdministrativeProjectApprovalSetting", fields=audit_fields() + [
            ("project", models.OneToOneField(on_delete=django.db.models.deletion.CASCADE, related_name="administrative_approval_setting", to="db.project")),
            ("flow", models.ForeignKey(on_delete=django.db.models.deletion.PROTECT, to="db.administrativeapprovalflow")),
        ], options={"db_table": "administrative_project_approval_settings"}),
        migrations.CreateModel(name="AdministrativeApprovalRequest", fields=audit_fields() + [
            ("workspace", models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, to="db.workspace")),
            ("project", models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, to="db.project")),
            ("issue", models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name="administrative_approvals", to="db.issue")),
            ("flow", models.ForeignKey(on_delete=django.db.models.deletion.PROTECT, related_name="requests", to="db.administrativeapprovalflow")),
            ("requested_by", models.ForeignKey(on_delete=django.db.models.deletion.PROTECT, related_name="administrative_approval_requests", to=settings.AUTH_USER_MODEL)),
            ("status", models.CharField(default="PENDING", max_length=16)),
            ("current_step_order", models.PositiveSmallIntegerField(default=1)),
        ], options={"db_table": "administrative_approval_requests", "constraints": [models.UniqueConstraint(fields=("issue",), condition=models.Q(status="PENDING", deleted_at__isnull=True), name="admin_issue_pending_uq")], "indexes": [models.Index(fields=["workspace", "status"], name="admin_approval_ws_status_idx")]}),
        migrations.CreateModel(name="AdministrativeApprovalAction", fields=[
            ("id", models.UUIDField(default=uuid.uuid4, primary_key=True, editable=False, serialize=False)),
            ("request", models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name="actions", to="db.administrativeapprovalrequest")),
            ("actor", models.ForeignKey(on_delete=django.db.models.deletion.PROTECT, to=settings.AUTH_USER_MODEL)),
            ("step_order", models.PositiveSmallIntegerField()),
            ("action", models.CharField(max_length=16)),
            ("comment", models.TextField(default="", blank=True)),
            ("created_at", models.DateTimeField(auto_now_add=True)),
        ], options={"db_table": "administrative_approval_actions", "ordering": ["created_at", "id"]}),
    ]
