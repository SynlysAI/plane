"""结构化成员提及的解析、差分和源资源权限边界。"""

from types import SimpleNamespace
from dataclasses import replace
from uuid import UUID

from bs4 import BeautifulSoup
from django.db.models import Q
from rest_framework.exceptions import ValidationError

from plane.db.models import User, WorkspaceMember
from plane.utils.workspace_access import user_can_access_workspace


def mentioned_user_ids(html):
    """提取去重的有效用户 UUID，单个异常节点不影响其他节点。

    Args:
        html: 业务保存后的编辑器 HTML。

    Returns:
        结构化成员提及的规范 UUID 字符串集合。
    """
    identifiers = set()
    for node in BeautifulSoup(html or "", "html.parser").find_all("mention-component"):
        if node.get("entity_name") != "user_mention":
            continue
        try:
            identifiers.add(str(UUID(str(node.get("entity_identifier")))))
        except (ValueError, TypeError, AttributeError):
            continue
    return identifiers


def new_mention_ids(html, previous_html=None):
    """返回本次保存新增的成员 ID。

    Args:
        html: 当前持久化正文。
        previous_html: 锁内读取的前一正文；新建时为空。

    Returns:
        本次新增的成员 UUID 集合。
    """
    return mentioned_user_ids(html) - mentioned_user_ids(previous_html)


def can_view_mention_source(user, kind, source):
    """按源内容真实读取权限检查成员，提及本身不授予任何权限。

    Args:
        user: 候选接收人。
        kind: 来源类型。
        source: 来源模型；正文候选可标记正式发布受众。

    Returns:
        账号有效且有当前来源读取权时为 True。
    """
    if source is None or getattr(source, "deleted_at", None):
        return False
    workspace = source.stage_instance.workspace if kind == "stage_material" else source.workspace
    if (
        not user.is_active
        or user.is_bot
        or not WorkspaceMember.objects.filter(workspace=workspace, member=user, is_active=True).exists()
        or not user_can_access_workspace(user, workspace_id=workspace.id)
    ):
        return False
    if kind in {"research_chain", "research_chain_task"}:
        from plane.research.views.projects import can_read_project_research_metadata
        from plane.research.utils.settings import workspace_research_enabled

        chain = source.chain if kind == "research_chain_task" else source
        if chain.deleted_at or chain.project.deleted_at or not workspace_research_enabled(workspace):
            return False
        if kind == "research_chain_task" and source.node.deleted_at:
            return False
        profile = getattr(chain.project, "research_profile", None)
        return bool(profile and not profile.deleted_at and can_read_project_research_metadata(workspace, user, profile))
    if kind in {"research_report", "stage_material"}:
        from plane.research.utils.acl import build_actor_context, check_access
        from plane.research.utils.reports import report_resource
        from plane.research.utils.stages import material_resource

        if kind == "stage_material" and (source.stage_instance.deleted_at or source.stage_instance.project.deleted_at):
            return False
        resource = (
            report_resource(source) if kind == "research_report" else material_resource(source, with_reviewers=True)
        )
        if getattr(source, "_mention_official_audience", False):
            resource = replace(resource, is_draft=False)
        return check_access(user, "view", resource, context=build_actor_context(user, workspace.id))
    if kind == "page":
        from plane.app.permissions.page import ProjectPagePermission

        request = SimpleNamespace(user=user, method="GET")
        return any(
            ProjectPagePermission().has_permission(
                request,
                SimpleNamespace(kwargs={"slug": workspace.slug, "project_id": link.project_id, "page_id": source.pk}),
            )
            for link in source.project_pages.filter(deleted_at__isnull=True, project__deleted_at__isnull=True)
        )
    if kind in {"issue", "project"}:
        from plane.utils.administrative_projects import restrict_administrative_project_visibility
        from plane.db.models import Project, ProjectMember

        project = source.project if kind == "issue" else source
        if project.deleted_at or project.archived_at or (kind == "issue" and source.archived_at):
            return False
        if not restrict_administrative_project_visibility(
            Project.objects.filter(pk=project.pk), user, workspace.slug
        ).exists():
            return False
        if kind == "issue" and not project.guest_view_all_features and source.created_by_id != user.pk:
            return not ProjectMember.objects.filter(project=project, member=user, is_active=True, role=5).exists()
        return True
    return False


def mention_receivers(kind, source, identifiers):
    """解析有效且有源内容读取权的提及对象。

    Args:
        kind: 来源类型。
        source: 来源模型。
        identifiers: 已规范化的成员 UUID 集合。

    Returns:
        有权接收通知的有效用户列表。
    """
    return [
        user
        for user in User.objects.filter(pk__in=identifiers, is_active=True, is_bot=False)
        if can_view_mention_source(user, kind, source)
    ]


def validate_new_mentions(kind, source, html, previous_html=None):
    """保存时校验新增提及，拒绝停用、跨工作区和无权成员。

    Args:
        kind: 来源类型。
        source: 已保存的来源模型。
        html: 当前正文。
        previous_html: 锁内旧正文。

    Returns:
        新增的合法接收人列表；无权成员触发 ValidationError。
    """
    identifiers = new_mention_ids(html, previous_html)
    receivers = mention_receivers(kind, source, identifiers)
    denied = identifiers - {str(user.pk) for user in receivers}
    if denied:
        raise ValidationError({"mentions": "新增提及包含无权读取该内容的成员。", "user_ids": sorted(denied)})
    return receivers


def mention_candidates(kind, source, *, query="", count=5, actor=None):
    """按源内容权限搜索候选人，保持编辑器 user_mention 响应格式。

    Args:
        kind: 来源类型。
        source: 当前来源或新建内容的父级资源。
        query: 成员名称检索词。
        count: 候选人数上限。
        actor: 需要排除的当前操作者。

    Returns:
        编辑器兼容的成员候选字典列表。
    """
    workspace_id = source.stage_instance.workspace_id if kind == "stage_material" else source.workspace_id
    users = User.objects.filter(
        pk__in=WorkspaceMember.objects.filter(workspace_id=workspace_id, is_active=True).values("member_id"),
        is_active=True,
        is_bot=False,
    ).filter(Q(display_name__icontains=query) | Q(first_name__icontains=query) | Q(last_name__icontains=query))
    if actor:
        users = users.exclude(pk=actor.pk)
    candidates = []
    for user in users.order_by("display_name", "id").distinct():
        if not can_view_mention_source(user, kind, source):
            continue
        candidates.append(
            {
                "member__id": str(user.pk),
                "member__display_name": user.display_name or user.username,
                "member__avatar_url": user.avatar_url,
            }
        )
        if len(candidates) >= count:
            break
    return candidates


def resolve_mention_source(slug, kind, identifier, actor):
    """解析搜索上下文并校验调用者，科研正文候选采用正式发布受众。

    Args:
        slug: 工作区标识。
        kind: 客户端声明的来源类型。
        identifier: 来源 UUID。
        actor: 搜索调用者。

    Returns:
        已校验的来源类型和模型二元组。
    """
    from plane.db.models import (
        Issue,
        Page,
        PeriodicReport,
        Project,
        ResearchChain,
        ResearchChainNodeTask,
        StageMaterial,
    )

    models = {
        "issue": Issue,
        "page": Page,
        "research_report": PeriodicReport,
        "project": Project,
        "research_chain": ResearchChain,
        "research_chain_task": ResearchChainNodeTask,
        "stage_material": StageMaterial,
    }
    try:
        identifier = UUID(str(identifier))
    except (ValueError, TypeError, AttributeError):
        raise ValidationError({"source_id": "提及源资源 ID 无效。"}) from None
    if kind not in models:
        raise ValidationError({"source_type": "提及源资源类型无效。"})
    workspace_path = "stage_instance__workspace__slug" if kind == "stage_material" else "workspace__slug"
    source = models[kind].objects.filter(pk=identifier, **{workspace_path: slug}).first()
    if source is None:
        raise ValidationError({"source_id": "提及源内容不存在或无权访问。"})
    if kind == "page":
        from plane.research.utils.page_guard import get_material_for_page, get_report_for_page

        report, material = get_report_for_page(source), get_material_for_page(source)
        if report:
            kind, source = "research_report", report
        elif material:
            kind, source = "stage_material", material
    if not can_view_mention_source(actor, kind, source):
        raise ValidationError({"source_id": "提及源内容不存在或无权访问。"})
    if kind in {"research_report", "stage_material"}:
        source._mention_official_audience = True
    return kind, source
