"""Read-only cross-domain workspace todo projection."""

import logging
import time
from datetime import datetime

from django.core.cache import cache
from django.db import connections
from rest_framework.exceptions import NotFound, PermissionDenied, ValidationError
from rest_framework.response import Response
from plane.app.views.base import BaseAPIView
from plane.db.models import Issue, Workspace, WorkspaceMember
from plane.utils.administrative_projects import visible_administrative_projects
from plane.utils.project_domains import research_admitted
from plane.utils.workspace_access import user_can_access_workspace
from plane.utils.todo_metrics import count_todo_queries
from plane.research.utils.todo_context import todo_query_context
from plane.research.services.research_todos import collect_research_todos, research_todo_urgency
from plane.research.views.research_todos import encode_todo_cursor, decode_todo_cursor, request_id_for_todo_log
from plane.utils.workspace_todos_cache import (
    TODO_CACHE_TTL_SECONDS,
    workspace_todo_cache_key,
    workspace_todo_cache_version,
)

logger = logging.getLogger("plane.api")


def _collect_todo_source(source, workspace, callback, request_id):
    """执行单个待办来源，记录耗时、查询数量、结果数量和降级状态。

    Args:
        source: 观测日志中的稳定来源标识。
        workspace: 当前查询的工作区。
        callback: 无参数的来源收集函数。
        request_id: 总请求及各来源日志共用的关联标识。

    Returns:
        来源返回值；来源故障时返回 None。
    """
    counter = {"query_count": 0}
    result = None
    failed = False
    started_at = time.perf_counter()

    try:
        with count_todo_queries() as counter:
            result = callback()
    except Exception:
        failed = True
        logger.exception(
            "Workspace todo source failed",
            extra={
                "event": "workspace_todo_source_failed",
                "source": source,
                "workspace_id": str(workspace.id),
                "request_id": request_id,
            },
        )
    finally:
        logger.info(
            "Workspace todo source measured",
            extra={
                "event": "workspace_todo_source",
                "source": source,
                "workspace_id": str(workspace.id),
                "request_id": request_id,
                "duration_ms": round((time.perf_counter() - started_at) * 1000, 2),
                "query_count": counter["query_count"],
                "result_count": (
                    len(result[0])
                    if isinstance(result, tuple) and result and hasattr(result[0], "__len__")
                    else len(result)
                    if result is not None
                    else 0
                ),
                "degraded": failed or (isinstance(result, tuple) and bool(result[1])),
            },
        )
    return None if failed else result


def _participant(user):
    """Project one todo participant without exposing account contact fields."""
    if user is None:
        return None
    return {"id": str(user.id), "display_name": user.display_name or user.username or str(user.id)}


def administrative_todos(workspace, user):
    projects = visible_administrative_projects(user, workspace.slug).filter(archived_at__isnull=True)
    issues = (
        Issue.issue_objects.filter(
            workspace=workspace,
            project_id__in=projects.values("id"),
            issue_assignee__assignee=user,
            issue_assignee__deleted_at__isnull=True,
            archived_at__isnull=True,
        )
        .exclude(state__group__in=["completed", "cancelled"])
        .select_related("project", "state", "created_by")
        .only(
            "name",
            "target_date",
            "updated_at",
            "sequence_id",
            "project__name",
            "project__identifier",
            "state__name",
            "state__group",
            "created_by__display_name",
            "created_by__username",
        )
        .distinct()
    )
    result = [
        {
            "id": f"administrative:issue:{issue.id}",
            "domain": "ADMINISTRATIVE",
            "source": "WORK_ITEM",
            "object_id": str(issue.id),
            "title": issue.name,
            "project_id": str(issue.project_id),
            "context": issue.project.name,
            "requester": _participant(issue.created_by),
            "business_status": issue.state.name,
            "handling_status": "IN_PROGRESS" if issue.state.group == "started" else "TODO",
            "due_at": issue.target_date.isoformat() if issue.target_date else None,
            "urgency": research_todo_urgency(issue.target_date),
            "updated_at": issue.updated_at.isoformat(),
            "href": f"/{workspace.slug}/browse/{issue.project.identifier}-{issue.sequence_id}/",
            "next_action": "OPEN",
            "capabilities": {"actions": {}},
        }
        for issue in issues
    ]
    return result


def todo_sort_key(todo):
    ranks = {"OVERDUE": 0, "DUE_TODAY": 1, "DUE_SOON": 2, "NORMAL": 3}
    updated = datetime.fromisoformat(todo["updated_at"])
    return (ranks.get(todo["urgency"], 3), todo.get("due_at") or "9999", -updated.timestamp(), todo["id"])


class WorkspaceTodoEndpoint(BaseAPIView):
    @staticmethod
    def _workspace(request, slug):
        """解析并校验当前用户可访问的工作区。

        Args:
            request: 当前请求对象。
            slug: 工作区别名。

        Returns:
            可访问的工作区实例。

        Raises:
            NotFound: 工作区不存在。
            PermissionDenied: 用户未获工作区准入或成员身份失效。
        """
        workspace = Workspace.objects.filter(slug=slug).first()
        if workspace is None:
            raise NotFound()
        if (
            not user_can_access_workspace(request.user, workspace_slug=slug)
            or not WorkspaceMember.objects.filter(workspace=workspace, member=request.user, is_active=True).exists()
        ):
            raise PermissionDenied()
        return workspace

    def get(self, request, slug):
        """在现有鉴权和响应边界外记录聚合的总耗时与 SQL 数量。

        Args:
            request: 当前请求对象。
            slug: 工作区别名。

        Returns:
            保持原有契约的待办响应。
        """
        request_started_at = time.perf_counter()
        metrics = {
            "event": "workspace_todo_request",
            "workspace_slug": slug,
            "user_id": str(request.user.id),
            "request_id": request_id_for_todo_log(request),
            "domain": request.GET.get("domain", "all").lower(),
            "cache_hit": False,
            "degraded": False,
            "degraded_sources": [],
            "result_count": 0,
            "total_count": 0,
        }
        counter = {"query_count": 0}
        try:
            with count_todo_queries() as counter, todo_query_context():
                response = self._get_todos(request, slug, metrics)
            metrics["status_code"] = response.status_code
            return response
        except Exception as error:
            metrics["status_code"] = getattr(error, "status_code", 500)
            raise
        finally:
            logger.info(
                "Workspace todo request measured",
                extra={
                    **metrics,
                    "duration_ms": round((time.perf_counter() - request_started_at) * 1000, 2),
                    "query_count": counter["query_count"],
                },
            )

    def _get_todos(self, request, slug, metrics):
        """在成员和准入检查通过后读取或构建五秒待办缓存。

        Args:
            request: 当前请求对象。
            slug: 工作区别名。
            metrics: 接收本次请求观测字段的字典。

        Returns:
            当前分页的待办响应，或原有游标校验错误响应。
        """
        workspace = self._workspace(request, slug)
        metrics["workspace_id"] = str(workspace.id)
        domain = request.GET.get("domain", "all").lower()
        if domain not in ("all", "research", "administrative"):
            raise ValidationError("待办类型无效。")
        try:
            limit = int(request.GET.get("limit", 50))
        except (ValueError, TypeError):
            raise ValidationError("分页数量无效。")
        if not 1 <= limit <= 100:
            raise ValidationError("分页数量须为 1–100。")
        offset = 0
        if request.GET.get("cursor"):
            offset, error = decode_todo_cursor(request.GET["cursor"])
            if error:
                return error

        # 事务内可能读到未提交写入，共享缓存只能保存已提交的投影。
        in_transaction = any(connections[alias].in_atomic_block for alias in connections)
        cache_version = None if in_transaction else workspace_todo_cache_version(workspace.id)
        cache_key = (
            workspace_todo_cache_key(workspace.id, request.user.id, domain, limit, offset, cache_version)
            if cache_version is not None
            else None
        )
        if cache_key is not None:
            try:
                cached_payload = cache.get(cache_key)
            except Exception:
                logger.exception(
                    "Workspace todo cache read failed",
                    extra={"event": "workspace_todo_cache_error", "workspace_id": str(workspace.id)},
                )
                cached_payload = None
            if cached_payload is not None:
                metrics.update(
                    cache_hit=True,
                    result_count=len(cached_payload["results"]),
                    total_count=cached_payload["total_count"],
                )
                return Response(cached_payload)

        todos, degraded = [], []
        if domain in ("all", "administrative"):
            administrative = _collect_todo_source(
                "ADMINISTRATIVE",
                workspace,
                lambda: administrative_todos(workspace, request.user),
                metrics["request_id"],
            )
            if administrative is None:
                degraded.append("ADMINISTRATIVE")
            else:
                todos.extend(administrative)
        if domain in ("all", "research") and research_admitted(request.user, workspace):
            collected = _collect_todo_source(
                "RESEARCH",
                workspace,
                lambda: collect_research_todos(workspace, request.user, "to_me", metrics["request_id"]),
                metrics["request_id"],
            )
            if collected is None:
                degraded.append("RESEARCH")
            else:
                research, failures = collected
                todos.extend({**item, "domain": "RESEARCH", "id": f"research:{item['id']}"} for item in research)
                degraded.extend(f"RESEARCH:{source}" for source in failures)
        todos = sorted({item["id"]: item for item in todos}.values(), key=todo_sort_key)
        payload = {
            "schema_version": "workspace-todo.v1",
            "results": todos[offset : offset + limit],
            "total_count": len(todos),
            "degraded_sources": degraded,
            "next_cursor": encode_todo_cursor(offset + limit) if offset + limit < len(todos) else None,
        }
        if cache_key is not None and not degraded:
            try:
                cache.set(cache_key, payload, timeout=TODO_CACHE_TTL_SECONDS)
            except Exception:
                logger.exception(
                    "Workspace todo cache write failed",
                    extra={"event": "workspace_todo_cache_error", "workspace_id": str(workspace.id)},
                )
        metrics.update(
            result_count=len(payload["results"]),
            total_count=payload["total_count"],
            degraded_sources=degraded,
            degraded=bool(degraded),
        )
        return Response(payload)
