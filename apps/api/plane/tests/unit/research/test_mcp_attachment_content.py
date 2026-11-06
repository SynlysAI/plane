"""验证真实附件解析器的格式、资源上限与文件异常。"""
# ruff: noqa: F811

import io
import multiprocessing
from types import SimpleNamespace
from unittest.mock import Mock
from uuid import uuid4

import pytest
from botocore.exceptions import ClientError
from docx import Document

from plane.preview import document_text
from plane.research.services import mcp_attachment_content as content
from plane.research.services.mcp_catalog import ResearchReadError
from plane.tests.mcp_content_fixtures import attachment_storage, pdf_bytes  # noqa: F401

pytestmark = pytest.mark.unit


def attachment(name, data, storage):
    """登记无需数据库的附件与合成源文件。

    Args:
        name: 文件名。
        data: 文件字节。
        storage: 内存存储。

    Returns:
        正文读取器需要的最小附件对象。
    """
    identity = uuid4()
    key = f"synthetic/{identity}/{name}"
    storage.files[key] = data
    asset = SimpleNamespace(
        pk=identity,
        asset=SimpleNamespace(name=key),
        attributes={"name": name},
        mcp_ready_previews=[],
    )
    return SimpleNamespace(file_name=name, file_size=len(data), asset=asset, asset_id=identity)


def docx_bytes():
    """生成段落、表格与嵌套表格相邻的真实 DOCX。

    Returns:
        DOCX 文件字节。
    """
    document = Document()
    document.add_paragraph("实验记录开始")
    table = document.add_table(rows=1, cols=2)
    table.cell(0, 0).text = "样品 A"
    table.cell(0, 1).text = "测量 42"
    nested = table.cell(0, 1).add_table(rows=1, cols=1)
    nested.cell(0, 0).text = "重复测量 43"
    document.add_paragraph("实验记录结束")
    output = io.BytesIO()
    document.save(output)
    return output.getvalue()


def test_docx_paragraphs_and_nested_tables_preserve_document_order(attachment_storage):
    """直接解析 DOCX，在无预览时仍包含表格及嵌套表格。"""
    obj = attachment("结果.docx", docx_bytes(), attachment_storage)
    result = content.read_attachment_content(obj)
    text = result["text"]
    assert text.index("实验记录开始") < text.index("样品 A") < text.index("测量 42")
    assert text.index("测量 42") < text.index("重复测量 43") < text.index("实验记录结束")
    assert result["extraction_source"] == "original"
    assert len(result["source_fingerprint"]) == len(result["file_content_hash"]) == 64
    assert all(body.closed for body in attachment_storage.bodies)


@pytest.mark.parametrize(
    "name,data,expected",
    [
        ("结果.md", "# 实验结果\n测量值 42".encode(), "# 实验结果\n测量值 42"),
        ("结果.markdown", b"\xef\xbb\xbf# Result", "# Result"),
        ("结果.txt", "中文记录".encode("gb18030"), "中文记录"),
        ("结果.csv", b"sample,value\nA,42\n", "sample\tvalue\nA\t42"),
        ("结果.tsv", b"sample\tvalue\nA\t42\n", "sample\tvalue\nA\t42"),
    ],
)
def test_text_formats_reuse_existing_decoder(attachment_storage, name, data, expected):
    """复用既有文本解码与表格分隔逻辑。"""
    obj = attachment(name, data, attachment_storage)
    assert content.read_attachment_content(obj)["text"] == expected


def test_pdf_uses_real_parser(attachment_storage):
    """真实 PDF 的文字通过受限解析进程返回。"""
    obj = attachment("result.pdf", pdf_bytes(pages=200), attachment_storage)
    assert "Synthetic measured result" in content.read_attachment_content(obj)["text"]


@pytest.mark.parametrize(
    "data,code",
    [
        (b"not a pdf", "invalid_file"),
        (b"%PDF-1.7\ncorrupt", "invalid_file"),
        (pdf_bytes(text=""), "no_extractable_text"),
        (pdf_bytes(encrypted=True), "encrypted_file"),
        (pdf_bytes(pages=201), "too_many_pages"),
    ],
    ids=["wrong-header", "corrupt", "no-text", "encrypted", "page-limit"],
)
def test_pdf_rejects_invalid_empty_encrypted_and_over_limit(data, code):
    """不可读取 PDF 给出具体错误，不返回空正文。"""
    with pytest.raises(ResearchReadError) as error:
        content.extract_document(".pdf", data)
    assert error.value.code == code


def test_corrupt_docx_is_explicit_error():
    """损坏 DOCX 返回稳定的文件错误。"""
    with pytest.raises(ResearchReadError) as error:
        content.extract_document(".docx", b"invalid docx")
    assert error.value.code == "invalid_file"


def test_docx_expansion_limit_is_checked_before_document_parser(monkeypatch):
    """解压总量超过上限时不进入文档解析。"""
    monkeypatch.setattr(document_text, "MAX_DOCX_EXPANDED_BYTES", 1)
    with pytest.raises(document_text.AttachmentParseError, match="file_too_large"):
        document_text.extract_document(".docx", docx_bytes())


def test_encrypted_docx_container_is_explicit_error(monkeypatch):
    """识别 Office 加密容器，避免将其报告为普通损坏文件。"""
    monkeypatch.setattr("olefile.isOleFile", lambda value: True)
    container = Mock()
    container.__enter__ = Mock(return_value=container)
    container.__exit__ = Mock(return_value=False)
    container.exists.return_value = True
    monkeypatch.setattr("olefile.OleFileIO", lambda value: container)
    with pytest.raises(document_text.AttachmentParseError, match="encrypted_file"):
        document_text.extract_document(".docx", b"encrypted synthetic container")


def test_timeout_reaps_parser_process(monkeypatch):
    """超时后回收真实解析进程，避免后台工作残留。"""
    before = {child.pid for child in multiprocessing.active_children()}
    monkeypatch.setattr(content, "PARSE_TIMEOUT_SECONDS", 0)
    with pytest.raises(ResearchReadError) as error:
        content.extract_document(".docx", docx_bytes())
    assert error.value.code == "parse_timeout"
    assert {child.pid for child in multiprocessing.active_children()} == before


@pytest.mark.parametrize(
    "name,data,code",
    [
        ("result.txt", b"   \n", "no_extractable_text"),
        ("result.txt", b"binary\x00data", "invalid_file"),
        ("result.png", b"unsupported", "unsupported_format"),
    ],
)
def test_unreadable_text_and_formats_are_explicit(attachment_storage, name, data, code):
    """空文本、二进制伪造和不支持格式不伪装为可读正文。"""
    obj = attachment(name, data, attachment_storage)
    with pytest.raises(ResearchReadError) as error:
        content.read_attachment_content(obj)
    assert error.value.code == code


def test_missing_source_is_explicit(attachment_storage):
    """文件元数据缺失时报告源文件不存在。"""
    obj = attachment("result.md", b"test", attachment_storage)
    attachment_storage.files.clear()
    with pytest.raises(ResearchReadError) as error:
        content.read_attachment_content(obj)
    assert error.value.code == "file_missing"


def test_source_size_limit_prevents_file_download(attachment_storage, settings):
    """以真实存储大小限制源读取，超限不下载文件。"""
    obj = attachment("result.md", b"synthetic result", attachment_storage)
    settings.ATTACHMENT_PREVIEW_MAX_BYTES = 2
    with pytest.raises(ResearchReadError) as error:
        content.read_attachment_content(obj)
    assert error.value.code == "file_too_large"
    assert not attachment_storage.reads


@pytest.mark.parametrize(
    "storage_code,code",
    [
        ("NoSuchKey", "file_missing"),
        ("PreconditionFailed", "source_changed"),
        ("AccessDenied", "file_unavailable"),
    ],
)
def test_storage_failure_preserves_actionable_error(attachment_storage, monkeypatch, storage_code, code):
    """对象在读取阶段消失、变化或不可用时返回对应错误。"""
    obj = attachment("result.md", b"test", attachment_storage)
    failure = Mock(side_effect=ClientError({"Error": {"Code": storage_code}}, "GetObject"))
    monkeypatch.setattr(attachment_storage, "get_object", failure)
    with pytest.raises(ResearchReadError) as error:
        content.read_attachment_content(obj)
    assert error.value.code == code


def test_source_changes_during_extraction_are_detected(attachment_storage, monkeypatch):
    """解析结束后再次核对源指纹，拒绝混合版本结果。"""
    obj = attachment("result.pdf", pdf_bytes(), attachment_storage)

    def change_source(extension, data):
        """模拟解析期间替换源文件。

        Args:
            extension: 文档类型。
            data: 已读取的旧版内容。

        Returns:
            旧版正文。
        """
        assert extension == ".pdf" and data
        attachment_storage.files[obj.asset.asset.name] = b"changed source"
        return "old content"

    monkeypatch.setattr(content, "extract_document", change_source)
    with pytest.raises(ResearchReadError) as error:
        content.read_attachment_content(obj)
    assert error.value.code == "source_changed"
