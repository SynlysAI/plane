"""有界、可重试的私有附件转换及缓存清理任务。"""

import io
import hashlib
import json
import logging
import time
from pathlib import Path
from datetime import timedelta

import requests
from celery import shared_task
from django.conf import settings
from django.db.models import Q
from django.utils import timezone
from PIL import Image
from plane.db.models import AssetPreview, ReportAttachment
from plane.preview.service import (
    OFFICE,
    PreviewError,
    chain_upload_fingerprint,
    read_chain_upload_source,
    read_source,
    source_metadata,
    text_payload,
    validate_content,
)
from plane.settings.storage import S3Storage

LOGGER = logging.getLogger(__name__)


@shared_task(soft_time_limit=150, time_limit=180)
def build_asset_preview(preview_id, attempt):
    """生成当前尝试的预览，重复投递及过期任务不能覆盖新结果。

    Args:
        preview_id: 预览记录 ID。
        attempt: 创建或重试时生成的唯一令牌。
    """
    rows = AssetPreview.objects.filter(pk=preview_id, attempt=attempt)
    if not rows.filter(status="pending").update(status="processing", updated_at=timezone.now()):
        return
    preview = rows.select_related("asset", "chain_upload__workspace").get()
    started = time.monotonic()
    key = ""
    storage = S3Storage()
    try:
        asset = preview.asset
        upload = preview.chain_upload
        source_is_valid = True
        if upload is not None:
            source_is_valid = (
                settings.ATTACHMENT_PREVIEW_ENABLED
                and upload.deleted_at is None
                and upload.chain.deleted_at is None
                and upload.node.deleted_at is None
                and bool(upload.knowledge_id)
            )
            if not source_is_valid:
                raise PreviewError("source_missing")
            name = upload.file_name
            workspace_id = upload.workspace_id
            content = read_chain_upload_source(upload, preview.fingerprint)
            if hashlib.sha256(content).hexdigest() != upload.file_hash:
                raise PreviewError("source_changed")
        else:
            source_is_valid = (
                settings.ATTACHMENT_PREVIEW_ENABLED
                and asset is not None
                and not asset.is_deleted
                and asset.deleted_at is None
            )
            name = asset.attributes.get("name", "")
            workspace_id = asset.workspace_id
            content = read_source(storage, asset, preview.fingerprint)
        if not source_is_valid:
            raise PreviewError("source_missing")
        validate_content(name, content)
        if Path(name).suffix.lower() in OFFICE:
            # 只发送文件字节；转换器不接收用户控制的远端 URL。
            with requests.post(
                settings.ATTACHMENT_PREVIEW_CONVERTER_URL.rstrip("/") + "/forms/libreoffice/convert",
                files={"files": ("document" + Path(name).suffix.lower(), content)},
                timeout=(5, settings.ATTACHMENT_PREVIEW_TIMEOUT),
                stream=True,
            ) as response:
                response.raise_for_status()
                output = io.BytesIO()
                for chunk in response.iter_content(64 * 1024):
                    output.write(chunk)
                    if output.tell() > settings.ATTACHMENT_PREVIEW_MAX_BYTES:
                        raise PreviewError("file_too_large")
                content = output.getvalue()
            validate_content("preview.pdf", content)
        mime = "application/pdf"
        if preview.kind == "image":
            # 重新编码去除附带内容，SVG 不进入此路径。
            with Image.open(io.BytesIO(content)) as image:
                output = io.BytesIO()
                image.convert("RGBA").save(output, format="PNG")
                content = output.getvalue()
            mime = "image/png"
        elif preview.kind in {"text", "markdown", "table"}:
            content = json.dumps(text_payload(name, content), ensure_ascii=False).encode()
            mime = "application/json"
        if len(content) > settings.ATTACHMENT_PREVIEW_MAX_BYTES:
            raise PreviewError("file_too_large")
        source_unchanged = (
            chain_upload_fingerprint(upload) == preview.fingerprint
            if upload is not None
            else source_metadata(storage, asset)[0] == preview.fingerprint
        )
        if not source_unchanged:
            raise PreviewError("source_changed")
        key = f"{workspace_id}/previews/{preview.id}/{attempt}"
        storage.server_s3_client.put_object(
            Bucket=storage.aws_storage_bucket_name, Key=key, Body=content, ContentType=mime
        )
        if not rows.filter(status="processing").update(
            status="ready",
            object_key=key,
            content_type=mime,
            size=len(content),
            error_code="",
            updated_at=timezone.now(),
        ):
            storage.server_s3_client.delete_object(Bucket=storage.aws_storage_bucket_name, Key=key)
        LOGGER.info("preview_ready preview_id=%s duration=%.2f", preview_id, time.monotonic() - started)
    except Exception as error:
        code = str(error) if isinstance(error, PreviewError) else "conversion_failed"
        rows.filter(status="processing").update(status="failed", error_code=code, updated_at=timezone.now())
        duration = time.monotonic() - started
        LOGGER.warning("preview_failed preview_id=%s reason=%s duration=%.2f", preview_id, code, duration)


@shared_task
def cleanup_asset_previews():
    """清理无有效引用或长期未使用的派生物；正式报告快照引用保持有效。"""
    storage = S3Storage()
    for preview in (
        AssetPreview.objects.select_related("asset", "chain_upload__chain__project", "chain_upload__node")
        .filter(updated_at__lt=timezone.now() - timedelta(days=1))
        .iterator()
    ):
        asset = preview.asset
        upload = preview.chain_upload
        if upload is not None:
            keep = (
                upload.deleted_at is None
                and upload.chain.deleted_at is None
                and upload.chain.project.deleted_at is None
                and upload.node.deleted_at is None
            )
        else:
            keep = asset is not None and not asset.is_deleted and not asset.deleted_at
        if keep and asset is not None and asset.entity_type == "REPORT_ATTACHMENT":
            keep = (
                ReportAttachment.all_objects.filter(asset=asset, report__deleted_at__isnull=True)
                .filter(Q(deleted_at__isnull=True) | Q(official_version_no__isnull=False))
                .exists()
            )
        elif keep and asset.entity_type == "COMMENT_ATTACHMENT":
            keep = bool(asset.comment_id and asset.comment.deleted_at is None)
        elif keep and asset.entity_type == "RESEARCH_TASK_COMMENT_ATTACHMENT":
            keep = asset.research_task_comment_attachments.filter(
                deleted_at__isnull=True, comment__deleted_at__isnull=True
            ).exists()
        elif keep and asset.entity_type == "ISSUE_ATTACHMENT":
            keep = bool(asset.issue_id and asset.issue.deleted_at is None)
        expired = preview.updated_at < timezone.now() - timedelta(days=30)
        if keep and not expired:
            continue
        if preview.object_key:
            storage.server_s3_client.delete_object(Bucket=storage.aws_storage_bucket_name, Key=preview.object_key)
        preview.delete()
