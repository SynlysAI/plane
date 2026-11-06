"""统一 MCP 文件的有界流式存储与校验。"""

import hashlib
import tempfile

from plane.research.services.mcp_catalog import ResearchReadError
from plane.research.utils.files import detect_kind, validate_attachment, validate_office_container
from plane.settings.storage import S3Storage

STREAM_BYTES = 1024 * 1024
DEFAULT_CHUNK_BYTES = 4096
MAX_CHUNK_BYTES = 16384


class TransferStorage:
    """复用 Plane 对象存储，使 API 与 worker 可以访问同一暂存文件。"""

    def __init__(self):
        """初始化服务端存储连接。"""
        self.storage = S3Storage()
        self.client = self.storage.server_s3_client
        self.bucket = self.storage.aws_storage_bucket_name

    def put(self, key, stream, content_type):
        """将文件流写入指定的独立对象。"""
        stream.seek(0)
        if not self.storage.upload_file(stream, key, content_type=content_type, extra_args={}):
            raise ResearchReadError("storage_unavailable", "文件存储暂时不可用，请按原请求标识恢复。", 503)

    def copy_to(self, key, output, maximum):
        """有界读取对象到文件流，返回实际字节数和摘要。"""
        response = self.client.get_object(Bucket=self.bucket, Key=key)
        body = response["Body"]
        try:
            return copy_stream(body, output, maximum)
        finally:
            body.close()

    def read(self, key, offset, size):
        """读取不可变快照的指定区间。"""
        response = self.client.get_object(Bucket=self.bucket, Key=key, Range=f"bytes={offset}-{offset + size - 1}")
        body = response["Body"]
        try:
            return body.read(size)
        finally:
            body.close()

    def delete(self, keys):
        """按存储批量上限删除当前会话的暂存对象。"""
        batch = []
        for key in keys:
            if key:
                batch.append(key)
            if len(batch) == 1000:
                if not self.storage.delete_files(batch):
                    raise ResearchReadError("storage_unavailable", "暂存文件清理失败。", 503)
                batch = []
        if batch and not self.storage.delete_files(batch):
            raise ResearchReadError("storage_unavailable", "暂存文件清理失败。", 503)


def temporary_file():
    """创建自动关闭的磁盘临时文件，避免将整篇论文装入内存。"""
    return tempfile.TemporaryFile(mode="w+b")


def copy_stream(source, output, maximum):
    """有界复制字节流，并同步计算大小与 SHA-256。"""
    size = 0
    digest = hashlib.sha256()
    while True:
        block = source.read(min(STREAM_BYTES, maximum - size + 1))
        if not block:
            break
        size += len(block)
        if size > maximum:
            raise ResearchReadError("file_size_exceeded", "实际文件超过允许大小。", 422)
        digest.update(block)
        output.write(block)
    return size, digest.hexdigest()


def validate_file(stream, *, file_name, content_type, size, limits, sha256):
    """流式核对总摘要、文件头、类型以及 Office 容器结构。"""
    stream.seek(0)
    error = validate_attachment(
        file_name=file_name, content_type=content_type, size_bytes=size, limits=limits, header_bytes=stream.read(512)
    )
    if error:
        raise ResearchReadError(error, "文件类型、大小或签名不符合当前业务要求。", 422)
    stream.seek(0)
    actual = hashlib.sha256()
    total = 0
    while block := stream.read(STREAM_BYTES):
        total += len(block)
        if total > size:
            raise ResearchReadError("size_mismatch", "实际文件大小与声明不符。", 422)
        actual.update(block)
    if total != size or actual.hexdigest() != sha256:
        raise ResearchReadError("checksum_mismatch", "文件大小或 SHA-256 与声明不符。", 422)
    stream.seek(0)
    if detect_kind(file_name, content_type) == "OFFICE" and not validate_office_container(file_name, stream):
        raise ResearchReadError("file_type_not_allowed", "Office 文件容器无效。", 422)
    stream.seek(0)
