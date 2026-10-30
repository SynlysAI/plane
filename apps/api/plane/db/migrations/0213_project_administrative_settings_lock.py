from django.db import migrations, models


def copy_workspace_lock_to_administrative_projects(apps, schema_editor):
    """将旧工作区锁迁移到现有行政项目。

    Args:
        apps: 当前迁移状态的历史模型注册表。
        schema_editor: 当前数据库连接的结构编辑器。
    """
    alias = schema_editor.connection.alias
    project_model = apps.get_model("db", "Project")
    profile_model = apps.get_model("db", "ResearchProjectProfile")
    setting_model = apps.get_model("db", "WorkspaceResearchSetting")

    # 历史模型未序列化 all_objects，使用基础管理器保留包含软删除关联的查询语义。
    research_project_ids = set(profile_model._base_manager.using(alias).values_list("project_id", flat=True))
    for setting in setting_model._base_manager.using(alias).filter(administrative_settings_admin_only=True):
        project_model._base_manager.using(alias).filter(
            workspace_id=setting.workspace_id,
            deleted_at__isnull=True,
        ).exclude(id__in=research_project_ids).update(administrative_settings_admin_only=True)


def restore_workspace_lock_from_administrative_projects(apps, schema_editor):
    """根据未删除项目的锁状态恢复旧工作区锁。

    Args:
        apps: 当前迁移状态的历史模型注册表。
        schema_editor: 当前数据库连接的结构编辑器。
    """
    alias = schema_editor.connection.alias
    project_model = apps.get_model("db", "Project")
    setting_model = apps.get_model("db", "WorkspaceResearchSetting")
    workspace_ids = (
        project_model._base_manager.using(alias)
        .filter(
            administrative_settings_admin_only=True,
            deleted_at__isnull=True,
        )
        .values_list("workspace_id", flat=True)
        .distinct()
    )
    for setting in setting_model._base_manager.using(alias).filter(workspace_id__in=workspace_ids):
        setting.administrative_settings_admin_only = True
        setting.save(using=alias, update_fields=["administrative_settings_admin_only", "updated_at"])


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
