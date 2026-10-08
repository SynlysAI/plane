"""报告正文图片资源校验与固定快照清单。"""

import re
from urllib.parse import urlsplit
from uuid import UUID

from bs4 import BeautifulSoup

from plane.db.models import FileAsset


def body_image_ids(report, payload):
    """解析正文图片并拒绝跨报告或未登记的本地资源。

    Args:
        report: 图片所属报告。
        payload: 正文 JSON 与 HTML 字段。

    Returns:
        正文引用的本地图片 ID 集合；无效引用引发 ValueError。
    """
    sources = set()

    def visit(node):
        """递归收集编辑器 JSON 中的图片地址。"""
        if isinstance(node, dict):
            if node.get("type") == "image":
                sources.add(str((node.get("attrs") or {}).get("src") or ""))
            for item in node.values():
                visit(item)
        elif isinstance(node, list):
            for item in node:
                visit(item)

    visit(payload.get("description_json") or {})
    sources.update(
        str(image.get("src") or "")
        for image in BeautifulSoup(payload.get("description_html") or "", "html.parser").find_all("img")
    )
    ids = set()
    for source in sources:
        parsed = urlsplit(source)
        # 本站路径即便带绝对域名也必须经过资源归属检查。
        matches = re.findall(r"[0-9a-fA-F]{8}-[0-9a-fA-F-]{27,}", parsed.path)
        local_route = "/api/" in parsed.path or not parsed.scheme
        if not local_route and parsed.scheme in {"http", "https"}:
            continue
        try:
            asset_id = UUID(matches[-1] if matches else source)
        except (ValueError, TypeError):
            raise ValueError("图片必须使用报告上传资源或 HTTP(S) 地址。") from None
        if not FileAsset.objects.filter(
            pk=asset_id,
            workspace_id=report.workspace_id,
            entity_type=FileAsset.EntityTypeContext.REPORT_IMAGE,
            entity_identifier=str(report.id),
            is_uploaded=True,
            is_deleted=False,
        ).exists():
            raise ValueError("图片尚未上传完成、已移除或不属于此报告。")
        ids.add(str(asset_id))
    return ids


def image_manifest(report):
    """冻结当前正文中引用的图片清单。

    Args:
        report: 即将提交的报告。

    Returns:
        包含资源 ID、文件名、类型及大小的不可变快照数据。
    """
    ids = body_image_ids(
        report,
        {
            "description_json": report.page.description_json,
            "description_html": report.page.description_html,
        },
    )
    return [
        {
            "asset_id": str(asset.id),
            "file_name": asset.attributes.get("name"),
            "content_type": asset.attributes.get("type"),
            "file_size": asset.size,
        }
        for asset in FileAsset.objects.filter(pk__in=ids).order_by("id")
    ]


def can_read_report_image(user, asset):
    """根据报告 ACL 和草稿/正式清单判断图片读取权限。

    Args:
        user: 当前调用方。
        asset: 正文图片资源。

    Returns:
        调用方可读取资源时返回 True。
    """
    from plane.db.models import PeriodicReport
    from plane.research.utils.acl import build_actor_context, check_access
    from plane.research.utils.reports import report_resource

    report = PeriodicReport.objects.filter(
        pk=asset.entity_identifier,
        workspace_id=asset.workspace_id,
    ).first()
    if report is None or not asset.is_uploaded:
        return False
    context = build_actor_context(user, asset.workspace_id)
    if not check_access(user, "download", report_resource(report), context=context):
        return False
    if report.owner_id == user.id and not asset.is_deleted:
        return True
    return any(
        any(item.get("asset_id") == str(asset.id) for item in snapshot.image_manifest)
        for snapshot in report.official_snapshots.all()
    )
