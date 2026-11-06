"""独立进程可直接导入的文档解析器，不加载 Django 或业务模型。"""

import io
import zipfile

MAX_DOCX_EXPANDED_BYTES = 256 * 1024 * 1024
MAX_PDF_PAGES = 200
MAX_TEXT_CHARS = 2_000_000


class AttachmentParseError(Exception):
    """携带可对外返回的附件解析错误码。"""


def extract_document(extension, content):
    """使用成熟文档解析器提取正文，限制解压总量和 PDF 页数。

    Args:
        extension: 已识别的文档扩展名。
        content: 已经过源文件大小校验的字节内容。

    Returns:
        按文档顺序排列的正文与表格文字。
    """
    if extension == ".docx":
        import olefile
        from docx import Document
        from docx.table import Table

        if olefile.isOleFile(io.BytesIO(content)):
            with olefile.OleFileIO(io.BytesIO(content)) as container:
                if container.exists("EncryptedPackage") or container.exists("EncryptionInfo"):
                    raise AttachmentParseError("encrypted_file")
            raise AttachmentParseError("invalid_file")
        with zipfile.ZipFile(io.BytesIO(content)) as container:
            entries = container.infolist()
            if any(entry.flag_bits & 1 for entry in entries):
                raise AttachmentParseError("encrypted_file")
            if sum(entry.file_size for entry in entries) > MAX_DOCX_EXPANDED_BYTES:
                raise AttachmentParseError("file_too_large")

        def blocks_text(blocks):
            """按段落和表格的实际顺序读取嵌套单元格文字。

            Args:
                blocks: 文档或单元格内的段落与表格迭代器。

            Returns:
                当前容器的纯文本。
            """
            parts = []
            for block in blocks:
                if isinstance(block, Table):
                    parts.extend(
                        "\t".join(blocks_text(cell.iter_inner_content()) for cell in row.cells) for row in block.rows
                    )
                else:
                    parts.append(block.text)
            return "\n".join(parts)

        text = blocks_text(Document(io.BytesIO(content)).iter_inner_content())
    elif extension == ".pdf":
        from pypdf import PdfReader

        if not content.startswith(b"%PDF-"):
            raise AttachmentParseError("invalid_file")
        reader = PdfReader(io.BytesIO(content))
        if reader.is_encrypted:
            raise AttachmentParseError("encrypted_file")
        if len(reader.pages) > MAX_PDF_PAGES:
            raise AttachmentParseError("too_many_pages")
        text = "\n".join(page.extract_text() or "" for page in reader.pages)
    else:
        raise AttachmentParseError("unsupported_format")
    if len(text) > MAX_TEXT_CHARS:
        raise AttachmentParseError("content_too_large")
    if not text.strip():
        raise AttachmentParseError("no_extractable_text")
    return text


def parse_worker(sender, extension, content):
    """在独立进程内运行解析器，仅向父进程发送正文或稳定错误码。

    Args:
        sender: 结果管道的发送端。
        extension: 源文档格式。
        content: 源文件内容。
    """
    try:
        sender.send((True, extract_document(extension, content)))
    except AttachmentParseError as error:
        sender.send((False, str(error)))
    except Exception:
        sender.send((False, "invalid_file"))
    finally:
        sender.close()
