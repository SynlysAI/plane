# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""登记 public 工作区已经在跑的 RAGPortal 和 Synlora。"""

from __future__ import annotations

import os

from django.conf import settings
from django.db import transaction

from plane.db.models import ExternalSystemConnection, IntegrationSystem
from plane.research.services.integrations import client_for
from plane.research.utils.roles import PUBLIC_WORKSPACE_SLUG

# dev 文档值。容器网关变化时只通过命令参数覆盖，不把新地址写进仓库。
DEFAULT_RAGPORTAL_BASE_URL = "http://172.19.0.1:8004"
DEFAULT_SYNLORA_BASE_URL = "http://172.19.0.1:8005"

REGISTERABLE_SYSTEMS = {
    IntegrationSystem.RAGPORTAL: {
        "display_name": "RAGPortal",
        "credential_ref": "RAGPORTAL_AUTH_SECRET",
        "default_base_url": DEFAULT_RAGPORTAL_BASE_URL,
        "base_url_env": "RAGPORTAL_BASE_URL",
        "auth_mode": ExternalSystemConnection.AuthMode.HMAC,
    },
    IntegrationSystem.SYNLORA: {
        "display_name": "Synlora",
        "credential_ref": "SYNLORA_SERVICE_TOKEN",
        "default_base_url": DEFAULT_SYNLORA_BASE_URL,
        "base_url_env": "SYNLORA_BASE_URL",
        "auth_mode": ExternalSystemConnection.AuthMode.BEARER,
    },
}


class WorkspaceIntegrationRegistrationError(Exception):
    """连接登记因工作区、系统或密钥不满足条件而停止。"""


def register_workspace_integrations(
    workspace,
    *,
    base_urls=None,
    disable=False,
    dry_run=False,
    environ=None,
):
    """幂等登记或停用 RAGPortal 与 Synlora。

    Args:
        workspace: 目标工作区，只能是 public。
        base_urls: 按系统覆盖基地址。为空时读环境变量，再退回 dev 文档值。
        disable: 只关闭这两行，不删除健康记录。
        dry_run: 不写数据库，也不调用健康检查。
        environ: 密钥和地址的环境来源，测试可传入。

    Returns:
        每个系统的登记或探针结果。不含密钥值。
    """
    if workspace is None or workspace.slug != PUBLIC_WORKSPACE_SLUG:
        raise WorkspaceIntegrationRegistrationError("连接登记只能作用于 public 工作区。")
    environ = os.environ if environ is None else environ
    base_urls = {str(key).upper(): value for key, value in (base_urls or {}).items() if value}
    unknown = set(base_urls) - set(REGISTERABLE_SYSTEMS)
    if unknown:
        raise WorkspaceIntegrationRegistrationError("只能登记 RAGPORTAL 和 SYNLORA。")
    if disable:
        return _disable(workspace, dry_run=dry_run)
    _require_secrets(environ)
    planned = [_plan_row(system, spec, base_urls, environ) for system, spec in REGISTERABLE_SYSTEMS.items()]
    if dry_run:
        return {"mode": "dry-run", "results": planned}
    with transaction.atomic():
        connections = [_upsert(workspace, row) for row in planned]
    results = [_probe(connection) for connection in connections]
    healthy = all(row["status"] == ExternalSystemConnection.HealthStatus.OK for row in results)
    return {"mode": "apply", "continue_r8": healthy, "results": results}


def _require_secrets(environ):
    """密钥缺失时失败，且此时还没有写入连接。"""
    missing = [
        spec["credential_ref"]
        for spec in REGISTERABLE_SYSTEMS.values()
        if not _secret_configured(spec["credential_ref"], environ)
    ]
    if missing:
        raise WorkspaceIntegrationRegistrationError(f"缺少连接密钥引用：{', '.join(missing)}")


def _secret_configured(name, environ) -> bool:
    """判断密钥引用在设置或环境中有值，不返回值本身。"""
    configured = getattr(settings, name, None)
    if configured:
        return True
    return bool(environ.get(name))


def _plan_row(system, spec, base_urls, environ) -> dict:
    """解析一个系统的登记参数。"""
    base_url = str(base_urls.get(system) or environ.get(spec["base_url_env"]) or spec["default_base_url"]).rstrip("/")
    return {
        "system": system,
        "display_name": spec["display_name"],
        "base_url": base_url,
        "credential_ref": spec["credential_ref"],
        "auth_mode": spec["auth_mode"],
        "secret_configured": True,
    }


def _upsert(workspace, row):
    """更新已有连接；没有则新建一行，不建第二行。"""
    connection = ExternalSystemConnection.objects.filter(workspace=workspace, system=row["system"]).first()
    if connection is None:
        connection = ExternalSystemConnection(workspace=workspace, system=row["system"])
    connection.display_name = row["display_name"]
    connection.base_url = row["base_url"]
    connection.credential_ref = row["credential_ref"]
    connection.auth_mode = row["auth_mode"]
    connection.is_enabled = True
    connection.deleted_at = None
    connection.save()
    return connection


def _probe(connection) -> dict:
    """调用现有健康适配器，只返回状态、耗时、降级原因和 request id。"""
    result = client_for(connection.system, connection).health()
    connection.refresh_from_db()
    return {
        "system": connection.system,
        "status": connection.health_status,
        "latency_ms": result.latency_ms,
        "degraded_reason": result.degraded_reason or connection.last_error or "",
        "request_id": result.request_id,
    }


def _disable(workspace, *, dry_run):
    """停用已登记的两行，保留历史健康字段。"""
    results = []
    for system in REGISTERABLE_SYSTEMS:
        connection = ExternalSystemConnection.objects.filter(workspace=workspace, system=system).first()
        if connection is None:
            results.append({"system": system, "status": "NOT_REGISTERED", "is_enabled": False})
            continue
        previous_error = connection.last_error
        if not dry_run and connection.is_enabled:
            connection.is_enabled = False
            connection.save(update_fields=["is_enabled", "updated_at"])
            connection.refresh_from_db()
        results.append(
            {
                "system": system,
                "status": connection.health_status,
                "is_enabled": False if not dry_run else connection.is_enabled,
                "degraded_reason": connection.last_error,
                "preserved_error": previous_error == connection.last_error,
            }
        )
    return {"mode": "dry-run" if dry_run else "disable", "results": results}
