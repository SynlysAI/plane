"""预览状态、源对象校验与有界内容处理。"""

import csv
import hashlib
import io
import json
import logging
from datetime import timedelta
from pathlib import Path
from uuid import uuid4

from django.conf import settings
from django.db import transaction
from django.utils import timezone
from PIL import Image
from pypdf import PdfReader
from plane.db.models import AssetPreview
from plane.research.utils.files import validate_office_container
from plane.settings.storage import S3Storage

LOGGER = logging.getLogger(__name__)
OFFICE = {".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx"}
IMAGES = {".png": "PNG", ".jpg": "JPEG", ".jpeg": "JPEG", ".gif": "GIF", ".webp": "WEBP", ".bmp": "BMP"}
PERMANENT_ERRORS = {"invalid_file", "encrypted_file", "file_too_large", "source_changed"}


class PreviewError(Exception):
    """向客户端提供稳定、无内部路径的预览错误码。"""


def file_kind(name):
    """按文件扩展名选择受支持的只读预览器。"""
    extension = Path(name).suffix.lower()
    if extension in OFFICE or extension == ".pdf":
        return "pdf"
    if extension in IMAGES:
        return "image"
    return {".csv": "table", ".tsv": "table", ".txt": "text", ".md": "markdown", ".markdown": "markdown"}.get(
        extension, "unsupported"
    )


def source_metadata(storage, asset):
    """从对象存储读取当前版本指纹与大小，不信任上传请求元数据。"""
    metadata = storage.get_object_metadata(object_name=asset.asset.name)
    if not metadata:
        raise PreviewError("source_missing")
    size = int(metadata.get("ContentLength") or 0)
    if not 0 < size <= settings.ATTACHMENT_PREVIEW_MAX_BYTES:
        raise PreviewError("file_too_large")
    identity = [
        asset.asset.name,
        asset.attributes.get("name"),
        metadata.get("VersionId"),
        metadata.get("ETag"),
        str(metadata.get("LastModified")),
        size,
    ]
    fingerprint = hashlib.sha256(json.dumps(identity).encode()).hexdigest()
    return fingerprint, metadata


def read_source(storage, asset, expected):
    """有界读取源文件，并确认读取前后版本仍与缓存键一致。"""
    fingerprint, metadata = source_metadata(storage, asset)
    if fingerprint != expected:
        raise PreviewError("source_changed")
    kwargs = {"Bucket": storage.aws_storage_bucket_name, "Key": asset.asset.name}
    if metadata.get("ETag"):
        kwargs["IfMatch"] = metadata["ETag"]
    response = storage.server_s3_client.get_object(**kwargs)
    body = response["Body"]
    try:
        content = body.read(int(metadata["ContentLength"]) + 1)
    finally:
        body.close()
    if len(content) != metadata["ContentLength"]:
        raise PreviewError("source_changed")
    return content


def validate_content(name, content):
    """验证真实内容，拒绝加密、损坏及扩展名伪造的文件。"""
    extension = Path(name).suffix.lower()
    if extension in OFFICE:
        if not validate_office_container(name, content):
            raise PreviewError("invalid_file")
    elif extension == ".pdf":
        if not content.startswith(b"%PDF-"):
            raise PreviewError("invalid_file")
        try:
            reader = PdfReader(io.BytesIO(content))
            if reader.is_encrypted:
                raise PreviewError("encrypted_file")
            if not len(reader.pages):
                raise PreviewError("invalid_file")
        except PreviewError:
            raise
        except Exception as error:
            raise PreviewError("invalid_file") from error
    elif extension in IMAGES:
        try:
            with Image.open(io.BytesIO(content)) as image:
                if image.format != IMAGES[extension] or image.width * image.height > 40_000_000:
                    raise PreviewError("invalid_file")
                image.verify()
        except Exception as error:
            raise PreviewError("invalid_file") from error
    elif b"\x00" in content[:4096]:
        raise PreviewError("invalid_file")


def text_payload(name, content):
    """解码文本或分页表格源；不执行 Markdown HTML 或表格公式。"""
    if len(content) > 5 * 1024 * 1024:
        raise PreviewError("file_too_large")
    try:
        text = content.decode("utf-8-sig")
    except UnicodeDecodeError:
        try:
            text = content.decode("gb18030")
        except UnicodeDecodeError as error:
            raise PreviewError("invalid_file") from error
    if file_kind(name) != "table":
        return {"text": text}
    delimiter = "\t" if Path(name).suffix.lower() == ".tsv" else ","
    csv.field_size_limit(1024 * 1024)
    rows = []
    try:
        for row in csv.reader(io.StringIO(text), delimiter=delimiter):
            if len(row) > 200 or len(rows) >= 100_000:
                raise PreviewError("file_too_large")
            rows.append(row)
    except csv.Error as error:
        raise PreviewError("invalid_file") from error
    return {"rows": rows}


def get_preview(asset, *, create=False, retry=False):
    """查询或原子创建预览；同一源版本仅派发一个转换任务。"""
    storage = S3Storage()
    fingerprint, _ = source_metadata(storage, asset)
    lookup = dict(asset=asset, fingerprint=fingerprint, converter_version=settings.ATTACHMENT_PREVIEW_VERSION)
    if not create:
        preview = AssetPreview.objects.filter(**lookup).first()
        stale_at = timezone.now() - timedelta(minutes=5)
        if preview and preview.status in {"pending", "processing"} and preview.updated_at < stale_at:
            AssetPreview.objects.filter(pk=preview.pk, attempt=preview.attempt).update(
                status="failed", error_code="timeout"
            )
            preview.refresh_from_db()
        return preview
    with transaction.atomic():
        preview, created = AssetPreview.objects.get_or_create(
            **lookup, defaults={"kind": file_kind(asset.attributes.get("name", ""))}
        )
        preview = AssetPreview.objects.select_for_update().get(pk=preview.pk)
        stale = preview.updated_at < timezone.now() - timedelta(minutes=5)
        if (
            created
            or (retry and preview.status == "failed" and preview.error_code not in PERMANENT_ERRORS)
            or (stale and preview.status in {"pending", "processing"})
        ):
            preview.status = "unsupported" if preview.kind == "unsupported" else "pending"
            preview.error_code = ""
            preview.attempt = uuid4()
            preview.save()
            if preview.status == "pending":
                from plane.bgtasks.asset_preview_task import build_asset_preview

                preview_id, attempt = str(preview.id), str(preview.attempt)

                def enqueue():
                    """仅在状态提交后投递任务，队列故障可安全重试。"""
                    try:
                        build_asset_preview.delay(preview_id, attempt)
                    except Exception:
                        LOGGER.exception("preview_enqueue_failed preview_id=%s", preview_id)
                        AssetPreview.objects.filter(pk=preview_id, attempt=attempt).update(
                            status="failed", error_code="service_unavailable", updated_at=timezone.now()
                        )

                transaction.on_commit(enqueue)
        else:
            LOGGER.info("preview_cache_hit asset_id=%s status=%s", asset.id, preview.status)
    return preview
