"""项目配置锁迁移在真实历史模型上的回归测试。"""

from importlib import import_module

import pytest
from django.db import connection
from django.db.migrations.loader import MigrationLoader
from django.db.migrations.state import ProjectState
from django.test.utils import override_settings
from django.utils import timezone


LOCK_MIGRATION = "0213_project_administrative_settings_lock"
LOCK_FIELD = "administrative_settings_admin_only"


def _run_migration(migration, state, reverse=False):
    """在测试库执行真实迁移操作并返回迁移状态。

    Args:
        migration: 待执行的迁移实例。
        state: 该迁移之前的历史状态。
        reverse: 是否执行反向迁移。

    Returns:
        操作完成后的历史状态。
    """
    with connection.schema_editor() as editor:
        operation = migration.unapply if reverse else migration.apply
        return operation(state.clone(), editor)


@pytest.fixture
def historical_lock_migration(transactional_db):
    """将独立测试库暂时调整为 0212 的字段布局，结束后恢复。

    Args:
        transactional_db: 允许 PostgreSQL DDL 的隔离测试库 fixture。

    Yields:
        0212 历史状态及 0213 迁移实例。
    """
    # 默认 --nomigrations 仍需显式读取迁移图，不能使用当前运行时模型。
    with override_settings(MIGRATION_MODULES={}):
        loader = MigrationLoader(None)
        original = loader.project_state([("db", "0212_project_member_inheritance_revoked")])
    state = ProjectState(
        models={key: model for key, model in original.models.items() if key[0] in {"db", "auth", "contenttypes"}}
    )
    migration = loader.disk_migrations[("db", LOCK_MIGRATION)]
    after = migration.mutate_state(state)
    setting = state.apps.get_model("db", "WorkspaceResearchSetting")
    project = after.apps.get_model("db", "Project")

    with connection.schema_editor() as editor:
        editor.add_field(setting, setting._meta.get_field(LOCK_FIELD))
        editor.remove_field(project, project._meta.get_field(LOCK_FIELD))
    try:
        yield state, migration
    finally:
        # 即使迁移失败，也恢复 pytest 创建的最新字段布局供后续用例使用。
        with connection.cursor() as cursor:
            setting_columns = {
                column.name for column in connection.introspection.get_table_description(cursor, setting._meta.db_table)
            }
            project_columns = {
                column.name for column in connection.introspection.get_table_description(cursor, project._meta.db_table)
            }
        with connection.schema_editor() as editor:
            if LOCK_FIELD in setting_columns:
                editor.remove_field(setting, setting._meta.get_field(LOCK_FIELD))
            if LOCK_FIELD not in project_columns:
                editor.add_field(project, project._meta.get_field(LOCK_FIELD))


def test_historical_project_lock_migration_round_trip(historical_lock_migration):
    """正反向迁移应保留工作区边界，并排除科研项目和已删除项目。

    Args:
        historical_lock_migration: 0212 历史状态及待验证的迁移实例。
    """
    state, migration = historical_lock_migration
    user_model = state.apps.get_model("db", "User")
    workspace_model = state.apps.get_model("db", "Workspace")
    project_model = state.apps.get_model("db", "Project")
    profile_model = state.apps.get_model("db", "ResearchProjectProfile")
    setting_model = state.apps.get_model("db", "WorkspaceResearchSetting")
    for model in (project_model, profile_model, setting_model):
        assert not hasattr(model, "all_objects")

    owner = user_model.objects.create(email="lock-migration@example.com", username="lock-migration")
    workspaces = {}
    for name, locked in (("locked", True), ("open", False), ("deleted-only", True)):
        workspace = workspace_model.objects.create(name=name, slug=name, owner_id=owner.pk)
        workspaces[name] = workspace
        setting_model.objects.create(workspace_id=workspace.pk, **{LOCK_FIELD: locked})

    deleted_at = timezone.now()
    cases = (
        ("ADMIN", "locked", False, False, False),
        ("DELETED", "locked", True, False, False),
        ("RESEARCH", "locked", False, True, False),
        ("OLDPROFILE", "locked", False, True, True),
        ("OPEN", "open", False, False, False),
        ("DELETEDONLY", "deleted-only", True, False, False),
    )
    for identifier, workspace_name, deleted, research, deleted_profile in cases:
        workspace = workspaces[workspace_name]
        project = project_model.objects.create(
            workspace_id=workspace.pk,
            name=identifier,
            identifier=identifier,
            deleted_at=deleted_at if deleted else None,
        )
        if research:
            profile_model.objects.create(
                workspace_id=workspace.pk,
                project_id=project.pk,
                owner_id=owner.pk,
                deleted_at=deleted_at if deleted_profile else None,
            )

    after = _run_migration(migration, state)
    projects = after.apps.get_model("db", "Project")._base_manager
    flags = dict(projects.values_list("identifier", LOCK_FIELD))
    assert flags == {identifier: identifier == "ADMIN" for identifier, *_ in cases}
    assert LOCK_FIELD not in {
        field.name for field in after.apps.get_model("db", "WorkspaceResearchSetting")._meta.get_fields()
    }

    # 已删除项目即使存在锁，也不能在反向迁移时重新锁定工作区。
    projects.filter(identifier="DELETEDONLY").update(**{LOCK_FIELD: True})
    restored = _run_migration(migration, state, reverse=True)
    restored_settings = restored.apps.get_model("db", "WorkspaceResearchSetting")
    restored_flags = dict(restored_settings.objects.values_list("workspace_id", LOCK_FIELD))
    assert restored_flags == {workspace.pk: name == "locked" for name, workspace in workspaces.items()}

    after = _run_migration(migration, restored)
    background_migration = import_module("plane.db.migrations.0214_user_background_asset_type").Migration(
        "0214_user_background_asset_type", "db"
    )
    final = _run_migration(background_migration, after)
    choices = dict(final.apps.get_model("db", "FileAsset")._meta.get_field("entity_type").choices)
    assert "USER_BACKGROUND" in choices
    assert final.apps.get_model("db", "Project").objects.count() == len(cases)


@pytest.mark.parametrize("has_setting", [False, True])
def test_historical_migration_without_locked_workspace(historical_lock_migration, has_setting):
    """没有旧锁或尚无工作区设置时，迁移也必须完成历史模型查询。

    Args:
        historical_lock_migration: 0212 历史状态及待验证的迁移实例。
        has_setting: 是否已存在工作区设置记录。
    """
    state, migration = historical_lock_migration
    owner = state.apps.get_model("db", "User").objects.create(email="no-lock@example.com", username="no-lock")
    workspace = state.apps.get_model("db", "Workspace").objects.create(
        name="No lock", slug="no-lock", owner_id=owner.pk
    )
    if has_setting:
        state.apps.get_model("db", "WorkspaceResearchSetting").objects.create(workspace_id=workspace.pk)
    state.apps.get_model("db", "Project").objects.create(name="No lock", identifier="NOLOCK", workspace_id=workspace.pk)
    after = _run_migration(migration, state)
    assert not after.apps.get_model("db", "Project").objects.get().administrative_settings_admin_only
    _run_migration(migration, state, reverse=True)
