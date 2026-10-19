"""报告正文图片资源校验与固定快照清单。"""

import re
from urllib.parse import urlsplit
from uuid import UUID

from bs4 import BeautifulSoup

from plane.db.models import FileAsset


def _body_image_sources(payload):
    """收集新旧编辑器 JSON 节点与 HTML 标签中的图片地址。

    Args:
        payload: 正文 JSON 与 HTML 字段。

    Returns:
        去重后的图片地址集合。
    """
    sources = set()

    def visit(node):
        """递归收集图片地址。

        Args:
            node: 当前 JSON 节点或子节点列表。
        """
        if isinstance(node, dict):
            if node.get("type") in {"image", "imageComponent"}:
                sources.add(str((node.get("attrs") or {}).get("src") or ""))
            for item in node.values():
                visit(item)
        elif isinstance(node, list):
            for item in node:
                visit(item)

    visit(payload.get("description_json") or {})
    sources.update(
        str(image.get("src") or "")
        for image in BeautifulSoup(payload.get("description_html") or "", "html.parser").find_all(
            ["img", "image-component"]
        )
    )
    return sources


def _source_asset_id(source):
    """解析本地图片资源 ID，保留原有 HTTP(S) 外部图片规则。

    Args:
        source: 编辑器保存的图片地址或资源 UUID。

    Returns:
        本地资源 ID；外部 HTTP(S) 地址返回 None，无效地址引发 ValueError。
    """
    try:
        parsed = urlsplit(source)
        # 本站路径即便带绝对域名也必须经过资源归属检查。
        matches = re.findall(r"[0-9a-fA-F]{8}-[0-9a-fA-F-]{27,}", parsed.path)
        local_route = "/api/" in parsed.path or not parsed.scheme
        if not local_route and parsed.scheme in {"http", "https"}:
            return None
        return str(UUID(matches[-1] if matches else source))
    except (ValueError, TypeError):
        raise ValueError("图片必须使用报告上传资源或 HTTP(S) 地址。") from None


def body_image_ids(report, payload):
    """解析正文图片并拒绝跨报告或未登记的本地资源。

    Args:
        report: 图片所属报告。
        payload: 正文 JSON 与 HTML 字段。

    Returns:
        正文引用的本地图片 ID 集合；无效引用引发 ValueError。
    """
    ids = set()
    for source in _body_image_sources(payload):
        asset_id = _source_asset_id(source)
        if asset_id is None:
            continue
        if not FileAsset.objects.filter(
            pk=asset_id,
            workspace_id=report.workspace_id,
            entity_type=FileAsset.EntityTypeContext.REPORT_IMAGE,
            entity_identifier=str(report.id),
            is_uploaded=True,
            is_deleted=False,
        ).exists():
            raise ValueError("图片尚未上传完成、已移除或不属于此报告。")
        ids.add(asset_id)
    return ids


def _asset_manifest_entry(asset):
    """生成图片清单中的资源描述。

    Args:
        asset: 已完成归属与状态检查的图片资源。

    Returns:
        图片 ID、文件名、类型及大小。
    """
    return {
        "asset_id": str(asset.id),
        "file_name": asset.attributes.get("name"),
        "content_type": asset.attributes.get("type"),
        "file_size": asset.size,
    }


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
    return [_asset_manifest_entry(asset) for asset in FileAsset.objects.filter(pk__in=ids).order_by("id")]


def snapshot_image_manifest(report, snapshot):
    """只读补全历史正式快照遗漏的图片，保留原清单及其元数据。

    Args:
        report: 快照所属报告，调用方须先验证报告读取权限。
        snapshot: 已提交的不可变正式快照。

    Returns:
        原清单及正文中有效本地图片的合并结果，不回写快照。
    """
    manifest = list(snapshot.image_manifest)
    existing_ids = {item.get("asset_id") for item in manifest}
    missing_ids = set()
    for source in _body_image_sources(
        {"description_json": snapshot.description_json, "description_html": snapshot.description_html}
    ):
        try:
            asset_id = _source_asset_id(source)
        except ValueError:
            # 历史坏引用不应阻止同一快照中的有效图片读取。
            continue
        if asset_id is not None and asset_id not in existing_ids:
            missing_ids.add(asset_id)
    if missing_ids:
        # 正式正文已固定；后来从草稿移除的资源仍属于该正式版本。
        assets = FileAsset.objects.filter(
            pk__in=missing_ids,
            workspace_id=report.workspace_id,
            entity_identifier=str(report.id),
            entity_type=FileAsset.EntityTypeContext.REPORT_IMAGE,
            is_uploaded=True,
        ).order_by("id")
        manifest.extend(_asset_manifest_entry(asset) for asset in assets)
    return manifest


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
        any(item.get("asset_id") == str(asset.id) for item in snapshot_image_manifest(report, snapshot))
        for snapshot in report.official_snapshots.all()
    )
