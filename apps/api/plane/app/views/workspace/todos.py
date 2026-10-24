"""Read-only cross-domain workspace todo projection."""

import logging
from datetime import datetime
from rest_framework.exceptions import NotFound, PermissionDenied, ValidationError
from rest_framework.response import Response
from plane.app.views.base import BaseAPIView
from plane.db.models import Issue, Workspace, WorkspaceMember
from plane.utils.administrative_projects import visible_administrative_projects
from plane.utils.project_domains import research_admitted
from plane.utils.workspace_access import user_can_access_workspace
from plane.research.services.research_todos import collect_research_todos, research_todo_urgency
from plane.research.views.research_todos import encode_todo_cursor, decode_todo_cursor

logger = logging.getLogger("plane.api")


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
        workspace = self._workspace(request, slug)
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
        todos, degraded = [], []
        if domain in ("all", "administrative"):
            try:
                todos.extend(administrative_todos(workspace, request.user))
            except Exception:
                logger.exception("Administrative todo source failed", extra={"workspace_slug": slug})
                degraded.append("ADMINISTRATIVE")
        if domain in ("all", "research") and research_admitted(request.user, workspace):
            try:
                research, failures = collect_research_todos(workspace, request.user, "to_me")
                todos.extend({**item, "domain": "RESEARCH", "id": f"research:{item['id']}"} for item in research)
                degraded.extend(f"RESEARCH:{source}" for source in failures)
            except Exception:
                logger.exception("Research todo source failed", extra={"workspace_slug": slug})
                degraded.append("RESEARCH")
        todos = sorted({item["id"]: item for item in todos}.values(), key=todo_sort_key)
        return Response(
            {
                "schema_version": "workspace-todo.v1",
                "results": todos[offset : offset + limit],
                "total_count": len(todos),
                "degraded_sources": degraded,
                "next_cursor": encode_todo_cursor(offset + limit) if offset + limit < len(todos) else None,
            }
        )
