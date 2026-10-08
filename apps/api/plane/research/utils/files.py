# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Research file validation and Markdown import.

Research uploads use their own limits (never ``FILE_SIZE_LIMIT``) and verify
MIME type, extension, size and the file signature (P0-FILE-04, P0-FILE-05).
"""

import html
import io
import os
import re
import zipfile

import nh3
import olefile

IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg"}
IMAGE_CONTENT_TYPES = {
    "image/png",
    "image/jpeg",
    "image/jpg",
    "image/gif",
    "image/webp",
    "image/bmp",
    "image/svg+xml",
}
PDF_EXTENSIONS = {".pdf"}
MARKDOWN_EXTENSIONS = {".md", ".markdown"}
OFFICE_EXTENSIONS = {
    ".doc",
    ".docx",
    ".xls",
    ".xlsx",
    ".ppt",
    ".pptx",
    ".csv",
    ".tsv",
}
OFFICE_CONTENT_TYPES = {
    "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.ms-excel",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.ms-powerpoint",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "text/csv",
    "text/tab-separated-values",
    "application/csv",
}
OFFICE_CONTENT_TYPES_BY_EXTENSION = {
    ".doc": {"application/msword"},
    ".docx": {"application/vnd.openxmlformats-officedocument.wordprocessingml.document"},
    ".xls": {"application/vnd.ms-excel"},
    ".xlsx": {"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"},
    ".ppt": {"application/vnd.ms-powerpoint"},
    ".pptx": {"application/vnd.openxmlformats-officedocument.presentationml.presentation"},
    ".csv": {"text/csv", "application/csv"},
    ".tsv": {"text/tab-separated-values", "text/tsv"},
}

IMAGE_SIGNATURES = (
    b"\x89PNG\r\n\x1a\n",
    b"\xff\xd8\xff",
    b"GIF87a",
    b"GIF89a",
    b"BM",
)

ALLOWED_HTML_TAGS = {
    "p",
    "br",
    "strong",
    "em",
    "u",
    "s",
    "code",
    "pre",
    "blockquote",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "ul",
    "ol",
    "li",
    "a",
    "img",
    "table",
    "thead",
    "tbody",
    "tr",
    "th",
    "td",
    "hr",
}

ALLOWED_ATTRIBUTES = {"a": {"href", "title"}, "img": {"src", "alt", "title"}}


def extension_of(file_name):
    return os.path.splitext(str(file_name or ""))[1].lower()


def detect_kind(file_name, content_type):
    extension = extension_of(file_name)
    content_type = (content_type or "").split(";")[0].strip().lower()
    if extension in PDF_EXTENSIONS or content_type == "application/pdf":
        return "PDF"
    if extension in MARKDOWN_EXTENSIONS or content_type in ("text/markdown", "text/x-markdown"):
        return "MARKDOWN"
    if extension in OFFICE_EXTENSIONS or content_type in OFFICE_CONTENT_TYPES:
        return "OFFICE"
    if extension in IMAGE_EXTENSIONS or content_type in IMAGE_CONTENT_TYPES:
        return "IMAGE"
    return "OTHER"


def validate_attachment(*, file_name, content_type, size_bytes, limits, header_bytes=None):
    """Return an error code for an invalid upload, else ``None``."""
    normalized_content_type = (content_type or "").split(";", 1)[0].strip().lower()
    kind = detect_kind(file_name, normalized_content_type)
    extension = extension_of(file_name)

    if kind == "OTHER":
        return "file_type_not_allowed"
    if kind == "IMAGE" and extension not in IMAGE_EXTENSIONS:
        return "file_type_not_allowed"
    if kind == "PDF" and extension not in PDF_EXTENSIONS:
        return "file_type_not_allowed"
    if kind == "MARKDOWN" and extension not in MARKDOWN_EXTENSIONS:
        return "file_type_not_allowed"
    if kind == "OFFICE" and extension not in OFFICE_EXTENSIONS:
        return "file_type_not_allowed"
    if (
        kind == "OFFICE"
        and normalized_content_type
        and normalized_content_type not in OFFICE_CONTENT_TYPES_BY_EXTENSION[extension]
    ):
        return "file_type_not_allowed"
    if kind == "PDF" and normalized_content_type != "application/pdf":
        return "file_type_not_allowed"
    if kind == "IMAGE" and normalized_content_type not in IMAGE_CONTENT_TYPES:
        return "file_type_not_allowed"
    if kind == "MARKDOWN" and normalized_content_type not in {"text/markdown", "text/x-markdown", "text/plain"}:
        return "file_type_not_allowed"

    limit_mb = {
        "IMAGE": limits.get("image_max_mb", 20),
        "PDF": limits.get("pdf_max_mb", 100),
        "MARKDOWN": limits.get("markdown_max_mb", 5),
        "OFFICE": limits.get("office_max_mb", 50),
    }[kind]
    if size_bytes is None or size_bytes <= 0:
        return "file_size_exceeded"
    if size_bytes > int(limit_mb) * 1024 * 1024:
        return "file_size_exceeded"

    if header_bytes is not None:
        if not header_bytes:
            return "file_type_not_allowed"
        if kind == "PDF" and not header_bytes.startswith(b"%PDF"):
            return "file_type_not_allowed"
        if kind == "IMAGE" and not _looks_like_image(header_bytes, normalized_content_type):
            return "file_type_not_allowed"
        if kind == "MARKDOWN" and b"\x00" in header_bytes[:512]:
            return "file_type_not_allowed"
        if kind == "OFFICE" and not _looks_like_office(extension, header_bytes):
            return "file_type_not_allowed"

    return None


def validate_office_container(file_name, content):
    """校验 Office 实际容器与文件扩展名对应的内部结构。

    Args:
        file_name: 已登记的文件名。
        content: 通过大小限制校验后读取的对象内容。

    Returns:
        有效容器返回 True，伪造、加密或损坏容器返回 False。
    """
    extension = extension_of(file_name)
    try:
        if extension in {".docx", ".xlsx", ".pptx"}:
            required = {
                ".docx": "word/document.xml",
                ".xlsx": "xl/workbook.xml",
                ".pptx": "ppt/presentation.xml",
            }[extension]
            with zipfile.ZipFile(io.BytesIO(content)) as container:
                names = set(container.namelist())
                if required not in names or "[Content_Types].xml" not in names:
                    return False
                for name in (required, "[Content_Types].xml"):
                    entry = container.getinfo(name)
                    if entry.flag_bits & 1 or not 0 < entry.file_size <= 10 * 1024 * 1024:
                        return False
                    container.read(name)
                content_types = container.read("[Content_Types].xml")
                return {
                    ".docx": b"wordprocessingml.document.main+xml",
                    ".xlsx": b"spreadsheetml.sheet.main+xml",
                    ".pptx": b"presentationml.presentation.main+xml",
                }[extension] in content_types
        if extension in {".doc", ".xls", ".ppt"}:
            with olefile.OleFileIO(io.BytesIO(content)) as container:
                required = {
                    ".doc": ("WordDocument",),
                    ".xls": ("Workbook", "Book"),
                    ".ppt": ("PowerPoint Document",),
                }[extension]
                return any(container.exists(name) for name in required)
        return b"\x00" not in content[:512]
    except (OSError, ValueError, KeyError, RuntimeError, zipfile.BadZipFile):
        return False


def inspect_uploaded_asset(storage, asset, limits):
    """读取存储对象并验证实际大小、MIME、文件头及办公容器。

    Args:
        storage: 当前请求的 S3 存储实例。
        asset: 待登记的 FileAsset。
        limits: 工作区附件大小限制。

    Returns:
        错误码及实际元数据；成功时错误码为 None。
    """
    metadata = storage.get_object_metadata(object_name=asset.asset.name)
    if not metadata:
        return "attachment_not_found", None
    file_name = asset.attributes.get("name") or asset.asset.name
    content_type = metadata.get("ContentType") or ""
    size = metadata.get("ContentLength")
    error = validate_attachment(
        file_name=file_name,
        content_type=content_type,
        size_bytes=size,
        limits=limits,
    )
    if error:
        return error, metadata
    response = storage.server_s3_client.get_object(
        Bucket=storage.aws_storage_bucket_name,
        Key=asset.asset.name,
    )
    body = response["Body"]
    try:
        # 元数据先限制大小，读取再限制长度，避免对象替换及伪造响应造成无界读取。
        content = body.read(int(size) + 1)
    finally:
        body.close()
    if len(content) != size:
        return "file_size_exceeded", metadata
    error = validate_attachment(
        file_name=file_name,
        content_type=content_type,
        size_bytes=size,
        limits=limits,
        header_bytes=content[:512],
    )
    if not error and detect_kind(file_name, content_type) == "OFFICE":
        if not validate_office_container(file_name, content):
            error = "file_type_not_allowed"
    return error, metadata


def _looks_like_image(header, content_type):
    """核对实际图片格式与对象 MIME，拒绝混用文件头。"""
    signatures = {
        "image/png": (b"\x89PNG\r\n\x1a\n",),
        "image/jpeg": (b"\xff\xd8\xff",),
        "image/jpg": (b"\xff\xd8\xff",),
        "image/gif": (b"GIF87a", b"GIF89a"),
        "image/bmp": (b"BM",),
    }
    if content_type == "image/webp":
        return header.startswith(b"RIFF") and header[8:12] == b"WEBP"
    return any(header.startswith(signature) for signature in signatures.get(content_type, ()))


def _looks_like_office(extension, header):
    """Check the lightweight signatures shared by legacy and OOXML Office files."""
    if extension in {".doc", ".xls", ".ppt"}:
        return header.startswith(b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1")
    if extension in {".docx", ".xlsx", ".pptx"}:
        return header.startswith(b"PK\x03\x04")
    return b"\x00" not in header[:512]


def markdown_to_html(content):
    """Minimal, safe Markdown to HTML conversion used by ``.md`` import.

    Remote images keep their original URL (P0-FILE-07); local relative image
    paths are reported back to the caller so the author can upload them.
    """
    lines = str(content or "").replace("\r\n", "\n").split("\n")
    html_parts = []
    in_code = False
    code_buffer = []
    in_list = False
    in_table = False
    local_images = []

    def close_list():
        nonlocal in_list
        if in_list:
            html_parts.append("</ul>")
            in_list = False

    def close_table():
        nonlocal in_table
        if in_table:
            html_parts.append("</tbody></table>")
            in_table = False

    for raw_line in lines:
        line = raw_line.rstrip()
        stripped = line.strip()

        if stripped.startswith("```"):
            if in_code:
                html_parts.append(f"<pre><code>{html.escape(chr(10).join(code_buffer))}</code></pre>")
                code_buffer = []
                in_code = False
            else:
                close_list()
                close_table()
                in_code = True
            continue

        if in_code:
            code_buffer.append(raw_line)
            continue

        if not stripped:
            close_list()
            close_table()
            continue

        image_match = re.match(r"^!\[([^\]]*)\]\(([^)]+)\)$", stripped)
        if image_match:
            close_list()
            close_table()
            alt, src = image_match.groups()
            if re.match(r"^[a-zA-Z][a-zA-Z0-9+.-]*://", src):
                html_parts.append(f'<img src="{html.escape(src)}" alt="{html.escape(alt)}">')
            else:
                local_images.append(src)
            continue

        if stripped.startswith("|") and stripped.endswith("|"):
            cells = [cell.strip() for cell in stripped.strip("|").split("|")]
            if all(set(cell) <= set("-: ") and cell for cell in cells):
                continue
            close_list()
            if not in_table:
                html_parts.append("<table><tbody>")
                in_table = True
                html_parts.append("<tr>" + "".join(f"<th>{_inline(cell)}</th>" for cell in cells) + "</tr>")
            else:
                html_parts.append("<tr>" + "".join(f"<td>{_inline(cell)}</td>" for cell in cells) + "</tr>")
            continue

        close_table()

        heading = re.match(r"^(#{1,6})\s+(.*)$", stripped)
        if heading:
            close_list()
            level = len(heading.group(1))
            html_parts.append(f"<h{level}>{_inline(heading.group(2))}</h{level}>")
            continue

        bullet = re.match(r"^[-*+]\s+(.*)$", stripped)
        if bullet:
            if not in_list:
                html_parts.append("<ul>")
                in_list = True
            html_parts.append(f"<li>{_inline(bullet.group(1))}</li>")
            continue

        numbered = re.match(r"^\d+[.)]\s+(.*)$", stripped)
        if numbered:
            if not in_list:
                html_parts.append("<ul>")
                in_list = True
            html_parts.append(f"<li>{_inline(numbered.group(1))}</li>")
            continue

        close_list()
        if stripped.startswith(">"):
            html_parts.append(f"<blockquote>{_inline(stripped[1:].strip())}</blockquote>")
            continue
        if re.match(r"^(-{3,}|\*{3,}|_{3,})$", stripped):
            html_parts.append("<hr>")
            continue

        html_parts.append(f"<p>{_inline(stripped)}</p>")

    if in_code:
        html_parts.append(f"<pre><code>{html.escape(chr(10).join(code_buffer))}</code></pre>")
    close_list()
    close_table()

    raw_html = "".join(html_parts) or "<p></p>"
    sanitized = nh3.clean(
        raw_html,
        tags=ALLOWED_HTML_TAGS,
        attributes=ALLOWED_ATTRIBUTES,
        url_schemes={"http", "https", "mailto"},
    )
    return sanitized, local_images


def _inline(text):
    escaped = html.escape(text)
    escaped = re.sub(r"`([^`]+)`", r"<code>\1</code>", escaped)
    escaped = re.sub(r"\*\*([^*]+)\*\*", r"<strong>\1</strong>", escaped)
    escaped = re.sub(r"(?<!\*)\*([^*]+)\*(?!\*)", r"<em>\1</em>", escaped)
    escaped = re.sub(r"\[([^\]]+)\]\(([^)]+)\)", r'<a href="\2">\1</a>', escaped)
    return escaped
