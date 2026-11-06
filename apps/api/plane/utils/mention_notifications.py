"""文档和正式正文的事务内站内提及通知。"""

from html import escape

from plane.db.models import Notification, NotificationEvent
from plane.utils.mentions import validate_new_mentions
from plane.utils.notification_outbox import persist_research_notification_batch


def notify_content_mentions(*, kind, source, actor, html, previous_html, revision, project, route, data=None):
    """为一次持久化修订新增的合法提及创建通知和邮件投递记录。

    Args:
        kind: 正文来源类型。
        source: 已保存的来源模型。
        actor: 当前操作者。
        html: 已保存的正文。
        previous_html: 前一次持久化正文或正式版本正文。
        revision: 来源持久化修订标识，用于重试去重。
        project: 来源所属项目。
        route: 站内资源路由。
        data: 可选来源定位字段。

    Returns:
        本次提交给通知持久化设施的记录。
    """
    receivers = validate_new_mentions(kind, source, html, previous_html)
    workspace = source.stage_instance.workspace if kind == "stage_material" else source.workspace
    category = NotificationEvent.Category.MENTION if kind == "page" else NotificationEvent.Category.RESEARCH_MENTION
    title = f"{actor.display_name or actor.username} 在内容中提及了你"
    rows = [
        Notification(
            workspace=workspace,
            project=project,
            receiver=user,
            triggered_by=actor,
            entity_name=kind,
            entity_identifier=source.pk,
            sender="research:mentioned" if kind != "page" else "in_app:mentioned",
            title=title,
            message={"action": "mentioned"},
            message_html=f"<p>{escape(title)}</p>",
            message_stripped=title,
            data={"action": "mentioned", "event_id": str(revision), "route": route, **(data or {})},
        )
        for user in receivers
        if user.pk != actor.pk
    ]
    persist_research_notification_batch(
        rows,
        category=category,
        email_policy={
            str(row.receiver_id): {"category": category, "reason": "mentioned", "immediate": True} for row in rows
        },
    )
    return rows


def notify_page_mentions(page, actor, previous_html=None):
    """普通文档保存时生成新增提及，科研正文在正式提交流程另行处理。

    Args:
        page: 已保存的文档。
        actor: 当前操作者。
        previous_html: 锁内旧正文。

    Returns:
        普通文档的通知记录；科研正文或未关联项目时为空列表。
    """
    from plane.research.utils.page_guard import get_material_for_page, get_report_for_page

    if get_report_for_page(page) or get_material_for_page(page):
        return []
    link = page.project_pages.filter(deleted_at__isnull=True).select_related("project").first()
    if not link:
        return []
    return notify_content_mentions(
        kind="page",
        source=page,
        actor=actor,
        html=page.description_html,
        previous_html=previous_html,
        revision=f"page:{page.pk}:{page.updated_at.isoformat()}",
        project=link.project,
        route=f"/{page.workspace.slug}/projects/{link.project_id}/pages/{page.pk}",
        data={"page_id": str(page.pk)},
    )
