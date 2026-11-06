"""为科研 MCP 提供有界、只读的附件正文提取。"""

import hashlib
import multiprocessing
from pathlib import Path
from time import monotonic

from botocore.exceptions import ClientError

from plane.preview.document_text import MAX_TEXT_CHARS, parse_worker
from plane.research.services.mcp_catalog import ResearchReadError

ATTACHMENT_KINDS = frozenset({"task_attachment", "task_comment_attachment"})
TEXT_EXTENSIONS = frozenset({".txt", ".md", ".markdown", ".csv", ".tsv"})
DIRECT_EXTENSIONS = TEXT_EXTENSIONS | {".docx", ".pdf"}
OFFICE_EXTENSIONS = frozenset({".doc", ".xls", ".xlsx", ".ppt", ".pptx"})
PARSE_TIMEOUT_SECONDS = 30


def extract_document(extension, content):
    """执行限时解析，并确保超时或异常的子进程被回收。

    Args:
        extension: DOCX 或 PDF 扩展名。
        content: 已授权且有大小限制的文件内容。

    Returns:
        提取到的正文。
    """
    context = multiprocessing.get_context("spawn")
    receiver, sender = context.Pipe(duplex=False)
    process = context.Process(target=parse_worker, args=(sender, extension, content))
    started_at = monotonic()
    try:
        process.start()
        sender.close()
        remaining = max(0, PARSE_TIMEOUT_SECONDS - (monotonic() - started_at))
        if not receiver.poll(remaining):
            raise ResearchReadError("parse_timeout", "附件正文解析超时。", 504)
        try:
            success, result = receiver.recv()
        except EOFError:
            raise ResearchReadError("invalid_file", "附件正文无法解析。", 422) from None
        if not success:
            status = 413 if result in {"file_too_large", "too_many_pages", "content_too_large"} else 422
            raise ResearchReadError(result, "附件正文无法提取，请根据错误码检查文件。", status)
        return result
    finally:
        sender.close()
        receiver.close()
        if process.pid is not None:
            process.join(timeout=0.2)
            if process.is_alive():
                process.terminate()
                process.join(timeout=1)
            if process.is_alive():
                process.kill()
                process.join()
            process.close()


def attachment_content_state(attachment):
    """依据已登记格式和预览记录给出正文读取能力，不访问对象存储。

    Args:
        attachment: 已校验归属、预取资产预览的附件登记。

    Returns:
        正文是否可尝试读取以及对应状态。
    """
    from django.conf import settings

    extension = Path(attachment.file_name).suffix.lower()
    if attachment.file_size > settings.ATTACHMENT_PREVIEW_MAX_BYTES:
        return False, "file_too_large"
    if extension in DIRECT_EXTENSIONS:
        return True, "readable"
    if extension in OFFICE_EXTENSIONS:
        previews = getattr(attachment.asset, "mcp_ready_previews", None)
        if previews is None:
            previews = attachment.asset.previews.filter(
                status="ready", kind="pdf", converter_version=settings.ATTACHMENT_PREVIEW_VERSION
            )
        return (True, "preview_required") if previews else (False, "preview_unavailable")
    return False, "unsupported_format"


def _read_preview(storage, preview):
    """有界读取内部预览文件，不生成预览或暴露存储地址。

    Args:
        storage: 服务端对象存储适配器。
        preview: 与源文件指纹一致的现成预览。

    Returns:
        现成 PDF 预览的字节内容。
    """
    from django.conf import settings

    if not 0 < preview.size <= settings.ATTACHMENT_PREVIEW_MAX_BYTES:
        raise ResearchReadError("file_too_large", "预览文件超过读取限制。", 413)
    response = storage.server_s3_client.get_object(Bucket=storage.aws_storage_bucket_name, Key=preview.object_key)
    body = response["Body"]
    try:
        content = body.read(preview.size + 1)
    finally:
        body.close()
    if len(content) != preview.size:
        raise ResearchReadError("source_changed", "预览文件已变化，请重新读取。", 409)
    return content


def read_attachment_content(attachment):
    """读取已授权附件的正文，读取前后校验源版本且不写入预览缓存。

    Args:
        attachment: 已通过节点、任务及资产归属校验的附件登记。

    Returns:
        包含正文、文件名和源版本指纹的有界内容对象。
    """
    from django.conf import settings
    from plane.db.models import AssetPreview
    from plane.preview.service import PreviewError, read_source, source_metadata, text_payload, validate_content
    from plane.settings.storage import S3Storage

    extension = Path(attachment.file_name).suffix.lower()
    if extension not in DIRECT_EXTENSIONS | OFFICE_EXTENSIONS:
        raise ResearchReadError("unsupported_format", "当前附件格式不支持正文提取。", 422)
    try:
        storage = S3Storage()
        fingerprint, _ = source_metadata(storage, attachment.asset)
        extraction_source = "original"
        if extension in OFFICE_EXTENSIONS:
            preview = AssetPreview.objects.filter(
                asset=attachment.asset,
                fingerprint=fingerprint,
                converter_version=settings.ATTACHMENT_PREVIEW_VERSION,
                status="ready",
                kind="pdf",
            ).first()
            if preview is None:
                raise ResearchReadError("preview_unavailable", "附件尚无匹配当前源版本的 PDF 预览。", 422)
            content = _read_preview(storage, preview)
            text = extract_document(".pdf", content)
            extraction_source = "preview"
        else:
            content = read_source(storage, attachment.asset, fingerprint)
            if extension in TEXT_EXTENSIONS:
                validate_content(attachment.file_name, content)
                payload = text_payload(attachment.file_name, content)
                text = payload.get("text")
                if text is None:
                    text = "\n".join("\t".join(row) for row in payload["rows"])
                if len(text) > MAX_TEXT_CHARS:
                    raise ResearchReadError("content_too_large", "附件正文超过提取长度限制。", 413)
                if not text.strip():
                    raise ResearchReadError("no_extractable_text", "附件没有可提取的文字。", 422)
            else:
                text = extract_document(extension, content)
        if source_metadata(storage, attachment.asset)[0] != fingerprint:
            raise ResearchReadError("source_changed", "附件源文件已变化，请重新读取。", 409)
        return {
            "file_name": attachment.file_name,
            "asset_id": str(attachment.asset_id),
            "text": text,
            "source_fingerprint": fingerprint,
            "file_content_hash": hashlib.sha256(content).hexdigest(),
            "extraction_source": extraction_source,
        }
    except ResearchReadError:
        raise
    except PreviewError as error:
        code = "file_missing" if str(error) == "source_missing" else str(error)
        status = {"file_missing": 404, "source_changed": 409, "file_too_large": 413}.get(code, 422)
        raise ResearchReadError(code, "附件文件不可读取，请根据错误码检查文件。", status) from None
    except ClientError as error:
        code = str(error.response.get("Error", {}).get("Code", ""))
        if code in {"NoSuchKey", "NoSuchVersion", "NotFound", "404"}:
            raise ResearchReadError("file_missing", "附件文件不存在。", 404) from None
        if code in {"PreconditionFailed", "412"}:
            raise ResearchReadError("source_changed", "附件源文件已变化，请重新读取。", 409) from None
        raise ResearchReadError("file_unavailable", "附件文件暂时不可读取。", 503) from None
    except Exception:
        raise ResearchReadError("file_unavailable", "附件文件暂时不可读取。", 503) from None
