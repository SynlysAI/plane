"""科研 MCP 正文测试使用的合成文件和内存对象存储。"""

import hashlib
import io

import pytest
from botocore.exceptions import ClientError
from pypdf import PdfWriter
from pypdf.generic import DictionaryObject, NameObject, DecodedStreamObject


def pdf_bytes(text="Synthetic measured result", *, pages=1, encrypted=False):
    """生成可提取文本、空白或加密的合成 PDF。

    Args:
        text: 第一页的 ASCII 文本，空字符串生成空白页。
        pages: 页数。
        encrypted: 是否使用密码加密。

    Returns:
        PDF 文件字节。
    """
    writer = PdfWriter()
    for index in range(pages):
        page = writer.add_blank_page(width=612, height=792)
        if text and index == 0:
            font = DictionaryObject(
                {
                    NameObject("/Type"): NameObject("/Font"),
                    NameObject("/Subtype"): NameObject("/Type1"),
                    NameObject("/BaseFont"): NameObject("/Helvetica"),
                }
            )
            page[NameObject("/Resources")] = DictionaryObject(
                {
                    NameObject("/Font"): DictionaryObject({NameObject("/F1"): font}),
                }
            )
            stream = DecodedStreamObject()
            stream.set_data(f"BT /F1 12 Tf 72 720 Td ({text}) Tj ET".encode("ascii"))
            page[NameObject("/Contents")] = stream
    if encrypted:
        writer.encrypt("synthetic-test-password")
    output = io.BytesIO()
    writer.write(output)
    return output.getvalue()


class MemoryAttachmentStorage:
    """仅实现只读接口的内存文件存储，记录读取及流关闭情况。"""

    def __init__(self):
        """初始化彼此隔离的合成源文件与访问记录。"""
        self.files = {}
        self.reads = []
        self.bodies = []
        self.aws_storage_bucket_name = "synthetic-mcp-content"
        self.server_s3_client = self

    def get_object_metadata(self, *, object_name):
        """返回合成源文件指纹所需元数据。

        Args:
            object_name: 合成对象键。

        Returns:
            元数据；文件不存在时返回 None。
        """
        content = self.files.get(object_name)
        if content is None:
            return None
        return {"ContentLength": len(content), "ETag": hashlib.sha256(content).hexdigest()}

    def get_object(self, *, Bucket, Key, IfMatch=None):
        """模拟有条件读取，不实现上传和预览生成。

        Args:
            Bucket: 合成桶名。
            Key: 对象键。
            IfMatch: 可选的源版本指纹。

        Returns:
            包含可关闭字节流的读取结果。
        """
        assert Bucket == self.aws_storage_bucket_name
        self.reads.append(Key)
        if Key not in self.files:
            raise ClientError({"Error": {"Code": "NoSuchKey"}}, "GetObject")
        metadata = self.get_object_metadata(object_name=Key)
        if IfMatch and IfMatch != metadata["ETag"]:
            raise ClientError({"Error": {"Code": "PreconditionFailed"}}, "GetObject")
        body = io.BytesIO(self.files[Key])
        self.bodies.append(body)
        return {"Body": body}


@pytest.fixture
def attachment_storage(monkeypatch):
    """隔离所有正文测试的对象存储访问。

    Args:
        monkeypatch: pytest 临时替换器。

    Returns:
        本次测试专用的只读内存存储。
    """
    storage = MemoryAttachmentStorage()
    monkeypatch.setattr("plane.settings.storage.S3Storage", lambda: storage)
    return storage
