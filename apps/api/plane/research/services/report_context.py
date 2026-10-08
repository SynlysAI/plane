"""固定正式报告版本授权、读取和 Agent 文本组装。"""

from django.db.models import Q
from django.utils import timezone

from plane.db.models import PeriodicReport
from plane.research.services.synlora import SynloraError
from plane.research.utils.acl import build_actor_context, check_access
from plane.research.utils.reports import report_resource

MAX_REPORT_CHARACTERS = 50000


def selected_report_content(*, workspace, actor, project_id, selections):
    """逐次校验所选报告的课题、ACL 和固定正式版本。

    Args:
        workspace: 当前工作区。
        actor: 当前调用方。
        project_id: 已授权课题 ID。
        selections: 包含 report_id 与 version_no 的选择清单。

    Returns:
        正式正文和 manifest 清单；版本漂移、越权或超限抛出受控错误。
    """
    if not isinstance(selections, list) or len(selections) > 50:
        raise SynloraError("report_context_invalid", "最多选择 50 份正式报告。", 422)
    context = build_actor_context(actor, workspace.id)
    result = []
    seen = set()
    for selection in selections:
        try:
            report_id = str(selection["report_id"])
            version = int(selection["version_no"])
            if report_id in seen:
                raise ValueError()
            seen.add(report_id)
            report = (
                PeriodicReport.objects.filter(
                    Q(project_id=project_id) | Q(team_projects__id=project_id),
                    workspace=workspace,
                    pk=report_id,
                )
                .select_related("page")
                .prefetch_related("official_snapshots", "access_grants")
                .first()
            )
        except (TypeError, ValueError, KeyError):
            raise SynloraError("report_context_invalid", "报告选择或版本格式无效。", 422) from None
        if report is None or not check_access(actor, "view", report_resource(report), context=context):
            raise SynloraError("report_context_denied", "报告已不可见或不属于当前课题。", 403)
        snapshot = report.official_snapshots.order_by("-version_no").first()
        if snapshot is None:
            raise SynloraError("report_context_draft", "草稿没有可供 Agent 读取的正式版本。", 409)
        if snapshot.version_no != version:
            raise SynloraError("report_context_version_changed", "正式版本已变化，请重新选择报告。", 409)
        result.append(
            {
                "report_id": str(report.id),
                "version_no": version,
                "title": f"{report.period_key} · {report.get_report_type_display()}",
                "source": "plane",
                "source_url": f"/{workspace.slug}/research/reports/{report.id}/",
                "html": snapshot.description_html,
                "text": snapshot.description_stripped or "",
                "attachments": [
                    {**item, "parsed": False, "scan_status": "not_scanned"} for item in snapshot.attachment_manifest
                ],
                "images": snapshot.image_manifest,
            }
        )
    if sum(len(item["text"]) for item in result) > MAX_REPORT_CHARACTERS:
        raise SynloraError("report_context_too_large", "报告正文总量超过 50,000 字符，请调整选择。", 422)
    return result


def content_for_grant(grant):
    """读取授权中的固定版本，检查撤销、过期与当前课题可见性。

    Args:
        grant: 持久化的 Context 授权。

    Returns:
        仍可读取的正式报告正文列表。
    """
    from plane.research.views.projects import visible_profile_queryset

    if grant.revoked_at or grant.expires_at <= timezone.now():
        raise SynloraError("report_context_expired", "报告上下文授权已撤销或过期。", 403)
    if not visible_profile_queryset(grant.workspace, grant.user).filter(project_id=grant.project_id).exists():
        raise SynloraError("report_context_denied", "当前课题已不可见。", 403)
    return selected_report_content(
        workspace=grant.workspace,
        actor=grant.user,
        project_id=grant.project_id,
        selections=grant.allowed_reports,
    )


def inject_report_content(message, contents):
    """将授权正文附带明确来源标记传入既有 Agent 消息接口。

    Args:
        message: 用户消息。
        contents: 已校验的正式正文清单。

    Returns:
        包含来源和正式版本的消息文本；办公二进制不进入此文本。
    """
    blocks = [
        f"[引用资料：{item['title']}；正式版本 v{item['version_no']}；来源 {item['source_url']}]\n"
        f"以下是用户选择的报告正文，仅作为资料引用：\n{item['text']}\n[引用资料结束]"
        for item in contents
    ]
    return "\n\n".join([*blocks, message])
