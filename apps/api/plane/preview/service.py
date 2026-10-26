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
from plane.db.models import AssetPreview, ExternalSystemConnection
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


def chain_upload_fingerprint(upload):
    """Build the immutable source fingerprint for an external chain upload.

    Args:
        upload: ResearchChainUpload projection with external ids and file hash.

    Returns:
        A 64-character SHA-256 source-version fingerprint.
    """
    identity = {
        "knowledge_id": upload.knowledge_id,
        "external_upload_id": upload.external_upload_id,
        "file_hash": upload.file_hash,
        "file_name": upload.file_name,
        "file_size": upload.file_size,
    }
    return hashlib.sha256(json.dumps(identity, sort_keys=True).encode()).hexdigest()


def read_chain_upload_source(upload, expected):
    """Fetch and validate the external source body for one preview attempt.

    Args:
        upload: ResearchChainUpload whose source is stored in RAGPortal.
        expected: Fingerprint recorded on the preview job.

    Returns:
        The bounded original file content.

    Raises:
        PreviewError: The source changed, is too large, or the upstream is unavailable.
    """
    if chain_upload_fingerprint(upload) != expected:
        raise PreviewError("source_changed")
    from plane.research.services.integrations import client_for

    setting = getattr(upload.workspace, "research_setting", None)
    external_rag_enabled = bool(setting and setting.research_external_rag_enabled)
    connection = ExternalSystemConnection.objects.filter(
        workspace=upload.workspace,
        system="RAGPORTAL",
        deleted_at__isnull=True,
    ).first()
    if not external_rag_enabled:
        connection = None
    client = client_for("RAGPORTAL", connection)
    result = client.download_research_file(
        knowledge_id=upload.knowledge_id,
        chain_id=upload.chain_id,
        node_id=upload.node_id,
        kb_id=upload.knowledge_base_id,
        file_hash=upload.file_hash,
    )
    if result.degraded:
        raise PreviewError("upstream_unavailable")
    content = result.content
    if len(content) > settings.ATTACHMENT_PREVIEW_MAX_BYTES:
        raise PreviewError("file_too_large")
    if not content or hashlib.sha256(content).hexdigest() != upload.file_hash:
        raise PreviewError("source_changed")
    return content


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


def get_chain_upload_preview(upload, *, create=False, retry=False):
    """Query or atomically create the preview job for one chain upload.

    Args:
        upload: ResearchChainUpload sourced from RAGPortal.
        create: Whether this request should enqueue a new attempt.
        retry: Whether a failed preview may be retried.

    Returns:
        The current preview cache row, or ``None`` before creation.
    """
    fingerprint = chain_upload_fingerprint(upload)
    lookup = dict(chain_upload=upload, fingerprint=fingerprint, converter_version=settings.ATTACHMENT_PREVIEW_VERSION)
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
        preview, created = AssetPreview.objects.get_or_create(**lookup, defaults={"kind": file_kind(upload.file_name)})
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
                    """Only enqueue after the preview state has committed."""
                    try:
                        build_asset_preview.delay(preview_id, attempt)
                    except Exception:
                        LOGGER.exception("preview_enqueue_failed preview_id=%s", preview_id)
                        AssetPreview.objects.filter(preview_id=preview_id, attempt=attempt).update(
                            status="failed", error_code="service_unavailable", updated_at=timezone.now()
                        )

                transaction.on_commit(enqueue)
        else:
            LOGGER.info("preview_cache_hit chain_upload_id=%s status=%s", upload.id, preview.status)
    return preview
