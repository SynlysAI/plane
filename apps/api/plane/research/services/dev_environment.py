"""开发环境重建辅助服务。"""

from __future__ import annotations

import csv
import hashlib
import os
from pathlib import Path
from typing import Iterable

from django.apps import apps
from django.core.exceptions import FieldDoesNotExist
from django.contrib.auth.hashers import check_password
from django.db import connection, transaction

from plane.db.models import Project, User
from plane.db.models.session import Session
from plane.research.services.maintenance import _deletion_order, _workspace_condition, research_models, workspace_counts

PRESERVED_MODEL_NAMES = frozenset(
    {
        "User",
        "Profile",
        "Workspace",
        "WorkspaceMember",
        "WorkspaceResearchSetting",
        "OrgUnit",
        "OrgUnitMember",
        "MentorBinding",
        "ResearchUserProfile",
        "UserImportBatch",
        "UserImportRow",
        "UserImportAccountSource",
        "IdentityMapping",
        "AccountLink",
        "ExternalSystemConnection",
        "WorkspaceIntegration",
    }
)


def _manager(model):
    """获取包含软删除记录的模型管理器。

    Args:
        model: 待查询的 Django 模型。

    Returns:
        包含软删除记录的管理器，不支持时使用默认管理器。
    """
    return getattr(model, "all_objects", model.objects)


def _workspace_models():
    """遍历直接关联工作区且不属于保留范围的普通模型。

    Returns:
        可清理模型的迭代器。
    """
    for model in apps.get_app_config("db").get_models():
        if model.__name__ in PRESERVED_MODEL_NAMES or model._meta.db_table.startswith("research_"):
            continue
        try:
            field = model._meta.get_field("workspace")
        except FieldDoesNotExist:
            continue
        if getattr(field, "many_to_one", False):
            yield model


def _workspace_counts(workspace):
    """只读统计指定工作区的科研与普通业务数据。

    Args:
        workspace: 待统计的工作区。

    Returns:
        按科研和普通模型分组的数据量。
    """
    regular = {
        model._meta.db_table: _manager(model).filter(workspace=workspace).count()
        for model in _workspace_models()
        if _manager(model).filter(workspace=workspace).exists()
    }
    project_count = _manager(Project).filter(workspace=workspace).count()
    if project_count:
        regular[Project._meta.db_table] = project_count
    return {"research": workspace_counts(workspace), "regular": regular}


def _delete_regular_workspace_rows(workspace):
    """清理普通业务数据并保留账号、组织和集成配置。

    Args:
        workspace: 待清理的工作区。

    Returns:
        各普通业务表删除的记录数。
    """
    models = list(apps.get_app_config("db").get_models())
    workspace_models = set(_workspace_models())
    conditions = {
        model: ("workspace_id = %s", [str(workspace.id)]) if model in workspace_models else None for model in models
    }
    deleted = {}
    for model in _deletion_order(models, conditions):
        if conditions.get(model) is None:
            continue
        rows = list(_manager(model).filter(workspace=workspace).only("pk"))
        for row in rows:
            row.delete(soft=False)
        if rows:
            deleted[model._meta.db_table] = len(rows)
    projects = list(_manager(Project).filter(workspace=workspace).only("pk"))
    for project in projects:
        project.delete(soft=False)
    if projects:
        deleted[Project._meta.db_table] = deleted.get(Project._meta.db_table, 0) + len(projects)
    return deleted


def reset_passwords(*, password: str):
    """轮换本地账号密码并使现有会话失效。

    Args:
        password: 运行时注入的测试密码。

    Returns:
        更新的账号数量与删除的会话数量。
    """
    users = list(User.objects.all().only("pk"))
    for user in users:
        user.set_password(password)
        user.is_password_autoset = False
        user.is_password_reset_required = False
        user.is_password_expired = False
        user.save(
            update_fields=[
                "password",
                "is_password_autoset",
                "is_password_reset_required",
                "is_password_expired",
                "updated_at",
            ]
        )
    sessions_deleted, _ = Session.objects.all().delete()
    return {"users": len(users), "sessions": sessions_deleted}


def write_password_manifest(path: Path, *, password: str):
    """输出仅当前用户可读写的本地测试凭据清单。

    Args:
        path: Git 之外的凭据清单路径。
        password: 运行时注入的测试密码。

    Returns:
        清单路径、账号数量与文件 SHA-256。
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    rows = list(User.objects.order_by("email").values("email", "display_name", "is_active"))
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, "w", encoding="utf-8", newline="") as handle:
        os.fchmod(handle.fileno(), 0o600)
        writer = csv.writer(handle)
        writer.writerow(["email", "display_name", "is_active", "password"])
        for row in rows:
            writer.writerow([row["email"], row["display_name"], row["is_active"], password])
    return {"path": str(path), "users": len(rows), "sha256": _sha256(path)}


def verify_passwords(*, password: str):
    """核实所有本地账号是否接受指定测试密码。

    Args:
        password: 运行时注入的测试密码。

    Returns:
        账号数量、校验失败数量与是否全部通过。
    """
    users = list(User.objects.all().only("password"))
    invalid = sum(not check_password(password, user.password) for user in users)
    return {"users": len(users), "invalid": invalid, "ok": invalid == 0}


def _sha256(path: Path):
    """计算文件的 SHA-256 摘要。

    Args:
        path: 待计算摘要的文件路径。

    Returns:
        十六进制 SHA-256 摘要。
    """
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def reset_workspace_business_data(workspaces: Iterable):
    """在事务内清理指定工作区的业务数据并保留身份信息。

    Args:
        workspaces: 待清理工作区的可迭代集合。

    Returns:
        各工作区的科研和普通业务删除统计。
    """
    result = {}
    with transaction.atomic():
        for workspace in workspaces:
            result[workspace.slug] = {
                "research": _delete_research_rows(workspace),
                "regular": _delete_regular_workspace_rows(workspace),
            }
            remaining = {
                name: count for name, count in workspace_counts(workspace).items() if name not in PRESERVED_MODEL_NAMES
            }
            if remaining:
                raise RuntimeError(f"workspace {workspace.slug} still has research data: {remaining}")
    return result


def _delete_research_rows(workspace):
    """按依赖顺序清理科研业务数据并保留身份记录。

    Args:
        workspace: 待清理的工作区。

    Returns:
        各科研模型与底层项目的删除数量。
    """
    models = [model for model in research_models() if model.__name__ not in PRESERVED_MODEL_NAMES]
    conditions = {model: _workspace_condition(model, workspace) for model in models}
    deleted = {}
    for model in _deletion_order(models, conditions):
        condition = conditions.get(model)
        if condition is None:
            continue
        sql, params = condition
        table = model._meta.db_table
        with connection.cursor() as cursor:
            cursor.execute(f'DELETE FROM "{table}" WHERE {sql}', params)
            count = cursor.rowcount
        if count:
            deleted[model.__name__] = count
    project_ids = set(Project.all_objects.filter(workspace=workspace).values_list("id", flat=True))
    for project in Project.all_objects.filter(id__in=project_ids):
        project.delete(soft=False)
    if project_ids:
        deleted["projects"] = len(project_ids)
    return deleted


def reset_report(workspaces):
    """生成指定工作区的只读重建预览。

    Args:
        workspaces: 待预览工作区的可迭代集合。

    Returns:
        可序列化为 JSON 的数据量、保留范围与密码处理说明。
    """
    return {
        "workspaces": [{"slug": ws.slug, "name": ws.name, "counts": _workspace_counts(ws)} for ws in workspaces],
        "users": User.objects.count(),
        "preserved_models": sorted(PRESERVED_MODEL_NAMES),
        "password": {"algorithm": "django-configured-hasher", "value": "written only at apply time"},
    }
