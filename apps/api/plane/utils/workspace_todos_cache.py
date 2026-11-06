# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""工作区待办投影的用户隔离短缓存与工作区级失效。"""

import hashlib
import json
import logging
from uuid import uuid4

from django.core.cache import cache
from django.db import transaction

logger = logging.getLogger("plane.api")
TODO_CACHE_TTL_SECONDS = 5
TODO_CACHE_VERSION_PREFIX = "workspace-todos:v1:version"

# 仅这些模型的写入影响待办。路径同时供信号和批量写入使用。
TODO_WORKSPACE_PATHS = {
    **dict.fromkeys(
        (
            "administrativeorganization",
            "administrativeorganizationmember",
            "approvalflow",
            "issue",
            "issueassignee",
            "mentorbinding",
            "orgunit",
            "orgunitmember",
            "page",
            "periodicreport",
            "project",
            "projectmember",
            "researchagentsession",
            "researchapprovalroute",
            "researchchain",
            "researchchainnodetask",
            "researchchainstage",
            "researchcontextgrant",
            "researchpaperreview",
            "researchprojectprofile",
            "researchstageinstance",
            "state",
            "workspacemember",
            "workspaceresearchsetting",
        ),
        "workspace_id",
    ),
    "workspace": "id",
    "approvalaction": "request__flow__workspace_id",
    "approvalflowstep": "flow__workspace_id",
    "approvalrequest": "flow__workspace_id",
    "periodicreportprojectreference": "report__workspace_id",
    "periodicreportreadreceipt": "report__workspace_id",
    "periodicreportsnapshot": "report__workspace_id",
    "researchagentrunevent": "session__workspace_id",
    "researchchainnode": "chain__workspace_id",
    "reportaccessgrant": "report__workspace_id",
    "researchworkspaceaccessgrant": "setting__workspace_id",
    "stagereview": "stage_instance__workspace_id",
    "stagereviewrevision": "review__stage_instance__workspace_id",
    "stagereviewerassignment": "stage_instance__workspace_id",
    "instanceadmin": "user__member_workspace__workspace_id",
    "user": "member_workspace__workspace_id",
}
TODO_USER_FIELDS = frozenset({"is_active", "display_name", "username"})


def todo_workspace_path(model):
    """返回待办依赖模型到工作区的 ORM 路径。

    Args:
        model: 需要判定的 Django 模型类。

    Returns:
        工作区路径；非依赖模型返回 None。
    """
    if model._meta.app_label not in ("db", "license"):
        return None
    return TODO_WORKSPACE_PATHS.get(model._meta.model_name)


def todo_fields_affect_projection(model, fields=None):
    """判断写入字段是否影响待办，跳过用户登录时间等无关更新。

    Args:
        model: 正在写入的模型。
        fields: 被更新的字段名；None 表示完整保存或创建。

    Returns:
        是否需要处理本次待办缓存失效。
    """
    if todo_workspace_path(model) is None:
        return False
    return model._meta.model_name != "user" or fields is None or bool(TODO_USER_FIELDS.intersection(fields))


def invalidate_todo_workspaces(workspace_ids, *, model=None, using=None):
    """安排受影响工作区失效，并处理主 PI 设置的跨工作区依赖。

    Args:
        workspace_ids: 本次写入影响的工作区 ID 集合。
        model: 被写入的模型，用于识别共享配置依赖。
        using: 业务写事务所在的数据库别名。
    """
    workspace_ids = set(workspace_ids) - {None}
    if model is not None and model._meta.model_name == "workspaceresearchsetting":
        from plane.db.models import WorkspaceResearchSetting

        workspace_ids.update(
            WorkspaceResearchSetting.objects.using(using)
            .filter(purpose__in=("PUBLIC_RESEARCH", "PI_PRIVATE"))
            .values_list("workspace_id", flat=True)
        )
    for workspace_id in workspace_ids:
        invalidate_workspace_todos(workspace_id, using=using)


def workspace_todo_cache_version(workspace_id):
    """读取工作区当前的共享缓存版本。

    Args:
        workspace_id: 需要读取版本的工作区 ID。

    Returns:
        缓存版本；缓存后端不可用时返回 None。
    """
    key = f"{TODO_CACHE_VERSION_PREFIX}:{workspace_id}"
    try:
        version = cache.get(key)
        if version is None:
            cache.add(key, uuid4().hex, timeout=None)
            version = cache.get(key)
        return version
    except Exception:
        logger.exception(
            "Workspace todo cache version read failed",
            extra={"event": "workspace_todo_cache_error", "workspace_id": str(workspace_id)},
        )
        return None


def workspace_todo_cache_key(workspace_id, user_id, domain, limit, offset, version):
    """构造隔离用户与分页维度的固定长度缓存键。

    Args:
        workspace_id: 待办数据所属工作区 ID。
        user_id: 接收权限过滤结果的当前用户 ID。
        domain: 请求的业务域。
        limit: 每页结果数量。
        offset: 解码后的游标偏移。
        version: 工作区当前的失效版本。

    Returns:
        可供 Django cache 使用的稳定键。
    """
    dimensions = json.dumps(
        [str(user_id), domain, limit, offset],
        separators=(",", ":"),
    ).encode()
    digest = hashlib.sha256(dimensions).hexdigest()
    return f"workspace-todos:v1:{workspace_id}:{version}:{digest}"


def invalidate_workspace_todos(workspace_id, using=None):
    """在业务事务提交后更新工作区缓存版本。

    Args:
        workspace_id: 需要使待办缓存失效的工作区 ID。
        using: 提交后触发失效的业务数据库别名。
    """
    if not workspace_id:
        return

    def rotate_version():
        """更新版本；缓存异常只记录日志，不影响已提交的业务写入。"""
        key = f"{TODO_CACHE_VERSION_PREFIX}:{workspace_id}"
        try:
            cache.set(key, uuid4().hex, timeout=None)
        except Exception:
            logger.exception(
                "Workspace todo cache invalidation failed",
                extra={"event": "workspace_todo_cache_error", "workspace_id": str(workspace_id)},
            )

    transaction.on_commit(rotate_version, using=using)
