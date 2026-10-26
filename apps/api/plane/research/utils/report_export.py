"""报告 Markdown 导出打包与本地图片校验。"""

import io
import re
import zipfile
from collections import OrderedDict

from bs4 import BeautifulSoup

from plane.db.models import FileAsset
from plane.research.utils.files import extension_of, validate_attachment
from plane.research.utils.report_images import _source_asset_id, can_read_report_image
from plane.utils.path_validator import sanitize_filename


EXPORT_IMAGE_TYPES = {
    "image/jpeg": {".jpg", ".jpeg"},
    "image/png": {".png"},
    "image/webp": {".webp"},
    "image/gif": {".gif"},
}
CANONICAL_IMAGE_EXTENSIONS = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "image/gif": ".gif",
}
MARKDOWN_IMAGE_SOURCE = re.compile(
    r"!\[[^\]]*\]\(\s*([^)\s]+)(?:\s+[\"'][^\"']*[\"'])?\s*\)"
)
MARKDOWN_CODE_BLOCK = re.compile(r"(?:```|~~~).*?(?:```|~~~)", re.DOTALL)


class ReportMarkdownExportError(Exception):
    """报告导出失败时携带 API 错误码与用户可读信息。"""

    def __init__(self, error_code, message):
        super().__init__(message)
        self.error_code = error_code
        self.message = message


def _image_sources(content):
    """收集 Markdown 与 HTML 中出现的图片地址。

    Args:
        content: 编辑器导出的 Markdown 文本。

    Returns:
        按首次出现顺序去重后的图片地址列表。
    """
    visible_content = "".join(MARKDOWN_CODE_BLOCK.split(content))
    sources = MARKDOWN_IMAGE_SOURCE.findall(visible_content)
    if "<" in visible_content:
        sources.extend(
            str(image.get("src") or "")
            for image in BeautifulSoup(visible_content, "html.parser").find_all(["img", "image-component"])
        )
    return list(OrderedDict.fromkeys(source for source in sources if source))


def _replace_image_source(content, source, replacement):
    """只替换图片语法中的地址，避免 UUID 子串误伤其他 URL。

    Args:
        content: 待处理的 Markdown 文本。
        source: 原图片地址。
        replacement: ZIP 内的相对图片路径。

    Returns:
        替换后的 Markdown 文本。
    """
    escaped = re.escape(source)
    markdown_pattern = re.compile(
        r"(!\[[^\]]*\]\(\s*)(" + escaped + r")((?:\s+[\"'][^\"']*[\"'])?\s*\))"
    )
    html_pattern = re.compile(
        r"(<(?:img|image-component)\b[^>]*\bsrc=)([\"'])" + escaped + r"\2",
        re.IGNORECASE,
    )
    return html_pattern.sub(
        lambda match: f"{match.group(1)}{match.group(2)}{replacement}{match.group(2)}",
        markdown_pattern.sub(lambda match: f"{match.group(1)}{replacement}{match.group(3)}", content),
    )


def _read_image(storage, asset, limits):
    """读取并完整校验一个报告正文图片对象。

    Args:
        storage: 当前请求绑定的 S3 存储实例。
        asset: 已通过归属与 ACL 检查的图片资源。
        limits: 工作区研究文件限制。

    Returns:
        图片字节与 ZIP 内使用的安全扩展名。

    Raises:
        ReportMarkdownExportError: 对象缺失、元数据不合法或存储不可用。
    """
    metadata = storage.get_object_metadata(object_name=asset.asset.name)
    if not metadata:
        raise ReportMarkdownExportError("report_attachment_not_found", "报告图片不存在。")

    file_name = asset.attributes.get("name") or f"{asset.id}.bin"
    content_type = (metadata.get("ContentType") or "").split(";", 1)[0].strip().lower()
    allowed_extensions = EXPORT_IMAGE_TYPES.get(content_type)
    if not allowed_extensions:
        raise ReportMarkdownExportError("file_type_not_allowed", "报告图片类型不允许。")
    try:
        size = int(metadata.get("ContentLength") or 0)
    except (TypeError, ValueError):
        size = 0

    error_code = validate_attachment(
        file_name=file_name,
        content_type=content_type,
        size_bytes=size,
        limits=limits,
    )
    if error_code:
        raise ReportMarkdownExportError(error_code, "报告图片元数据不合法。")

    try:
        response = storage.server_s3_client.get_object(
            Bucket=storage.aws_storage_bucket_name,
            Key=asset.asset.name,
        )
        body = response["Body"]
        try:
            content = body.read(size + 1)
        finally:
            body.close()
    except Exception:
        raise ReportMarkdownExportError("research_upload_storage_failed", "对象存储读取失败。") from None

    if len(content) != size:
        raise ReportMarkdownExportError("file_size_exceeded", "报告图片大小校验失败。")
    error_code = validate_attachment(
        file_name=file_name,
        content_type=content_type,
        size_bytes=size,
        limits=limits,
        header_bytes=content[:512],
    )
    if error_code:
        raise ReportMarkdownExportError(error_code, "报告图片内容与类型不一致。")

    extension = extension_of(file_name)
    if extension not in allowed_extensions:
        extension = CANONICAL_IMAGE_EXTENSIONS[content_type]
    return content, extension


def build_report_markdown_export(report, content, user, storage, limits):
    """把报告 Markdown 与本地正文图片打包为可离线阅读的 ZIP。

    Args:
        report: 当前导出的周期报告。
        content: 编辑器当前导出的 Markdown 文本。
        user: 发起导出的用户，用于复用图片读取 ACL。
        storage: 当前请求绑定的 S3 存储实例。
        limits: 工作区研究文件限制。

    Returns:
        ZIP 字节、下载文件名、图片数量与 Markdown 字节数。

    Raises:
        ReportMarkdownExportError: 任一本地图片不可读或不合法时中止整包导出。
    """
    source_asset_ids = []
    for source in _image_sources(content):
        try:
            asset_id = _source_asset_id(source)
        except ValueError as error:
            raise ReportMarkdownExportError("file_type_not_allowed", str(error)) from None
        if asset_id is not None:
            source_asset_ids.append((source, asset_id))

    assets = {
        str(asset.id): asset
        for asset in FileAsset.objects.filter(
            pk__in=[asset_id for _, asset_id in source_asset_ids],
            workspace_id=report.workspace_id,
            entity_type=FileAsset.EntityTypeContext.REPORT_IMAGE,
            entity_identifier=str(report.id),
        )
    }
    images = []
    asset_paths = {}
    replaced = content
    seen_assets = set()
    for source, asset_id in source_asset_ids:
        asset = assets.get(asset_id)
        if asset is None or not can_read_report_image(user, asset):
            raise ReportMarkdownExportError(
                "report_attachment_not_found",
                "图片尚未上传完成、已移除或不属于此报告。",
            )
        if asset_id in seen_assets:
            replaced = _replace_image_source(replaced, source, asset_paths[asset_id])
            continue
        image_content, extension = _read_image(storage, asset, limits)
        images.append((asset_id, image_content, extension))
        seen_assets.add(asset_id)
        asset_paths[asset_id] = f"assets/{asset_id}{extension}"
        replaced = _replace_image_source(replaced, source, asset_paths[asset_id])

    stem = sanitize_filename(f"{report.report_type.lower()}-{report.period_key}") or str(report.id)
    archive_name = f"{stem}.zip"
    markdown_name = f"{stem}.md"
    archive = io.BytesIO()
    with zipfile.ZipFile(archive, "w") as bundle:
        bundle.writestr(
            markdown_name,
            replaced.encode("utf-8"),
            compress_type=zipfile.ZIP_DEFLATED,
        )
        for _asset_id, image_content, extension in images:
            bundle.writestr(
                f"assets/{_asset_id}{extension}",
                image_content,
                compress_type=zipfile.ZIP_STORED,
            )

    return archive.getvalue(), archive_name, len(images), len(content.encode("utf-8"))
