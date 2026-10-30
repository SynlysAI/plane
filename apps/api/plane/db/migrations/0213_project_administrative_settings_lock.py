from django.db import migrations, models


def copy_workspace_lock_to_administrative_projects(apps, schema_editor):
    """Move the retired workspace lock onto each existing administrative project."""
    project_model = apps.get_model("db", "Project")
    profile_model = apps.get_model("db", "ResearchProjectProfile")
    setting_model = apps.get_model("db", "WorkspaceResearchSetting")

    research_project_ids = set(profile_model.all_objects.values_list("project_id", flat=True))
    for setting in setting_model.objects.filter(administrative_settings_admin_only=True):
        project_model.all_objects.filter(
            workspace_id=setting.workspace_id,
            deleted_at__isnull=True,
        ).exclude(id__in=research_project_ids).update(administrative_settings_admin_only=True)


def restore_workspace_lock_from_administrative_projects(apps, schema_editor):
    """Restore the workspace lock when any administrative project remains locked."""
    project_model = apps.get_model("db", "Project")
    setting_model = apps.get_model("db", "WorkspaceResearchSetting")
    workspace_ids = (
        project_model.all_objects.filter(
            administrative_settings_admin_only=True,
            deleted_at__isnull=True,
        )
        .values_list("workspace_id", flat=True)
        .distinct()
    )
    for setting in setting_model.objects.filter(workspace_id__in=workspace_ids):
        setting.administrative_settings_admin_only = True
        setting.save(update_fields=["administrative_settings_admin_only", "updated_at"])


class Migration(migrations.Migration):
    dependencies = [
        ("db", "0212_project_member_inheritance_revoked"),
    ]

    operations = [
        migrations.AddField(
            model_name="project",
            name="administrative_settings_admin_only",
            field=models.BooleanField(default=False),
        ),
        migrations.RunPython(
            copy_workspace_lock_to_administrative_projects,
            restore_workspace_lock_from_administrative_projects,
        ),
        migrations.RemoveField(
            model_name="workspaceresearchsetting",
            name="administrative_settings_admin_only",
        ),
    ]
