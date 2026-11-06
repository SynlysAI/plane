"""统一 MCP 文件会话、续传与确认发布服务。"""

import base64
import binascii
import hashlib
import io
from datetime import timedelta
from uuid import uuid4

from django.core import signing
from django.db import transaction
from django.utils import timezone

from plane.db.models import UnifiedMCPFileTransfer, UnifiedMCPFileChunk, UnifiedMCPWriteResult
from plane.mcp.catalog import validate
from plane.mcp.client_config import public_url
from plane.mcp.file_business import FileBusiness
from plane.mcp.file_storage import DEFAULT_CHUNK_BYTES, MAX_CHUNK_BYTES, TransferStorage, copy_stream, temporary_file
from plane.research.services.mcp_catalog import ResearchReadError
from plane.utils.path_validator import sanitize_filename

TOKEN_SALT = "unified-mcp.file-http.v1"
CURSOR_SALT = "unified-mcp.file-chunk.v1"
HTTP_TTL_SECONDS = 600
UPLOAD_TTL_DAYS = 7
DOWNLOAD_TTL_HOURS = 24


def digest(value):
    """计算规范 JSON 摘要，绑定重试请求的文件和目标。"""
    from plane.mcp.reading import encode

    return hashlib.sha256(encode(value).encode()).hexdigest()


def enqueue(transfer):
    """在当前事务提交后唤醒文件 worker，失败时保留可恢复会话。"""
    from plane.bgtasks.mcp_file_task import process_mcp_file_transfer

    def dispatch():
        """派发后台任务，队列不可用时允许同一会话稍后重新派发。"""
        try:
            process_mcp_file_transfer.delay(str(transfer.pk))
        except Exception:
            UnifiedMCPFileTransfer.objects.filter(pk=transfer.pk).update(error_code="worker_unavailable")

    transaction.on_commit(dispatch)


class UnifiedFileService:
    """让两种传输方式共用一个持久回执和业务登记流程。"""

    def __init__(self, connection, request=None):
        """保存连接及用于构造公共临时地址的请求。"""
        self.connection = connection
        self.request = request

    def execute(self, name, arguments):
        """验证工具输入并分派对应文件操作。"""
        args = validate(name, arguments)
        return getattr(self, name.removeprefix("plane_"))(**args)

    def session(self, session_id, *, lock=False, write=False):
        """读取本连接的会话，并实时复核有效期、父对象和文件归属。"""
        business = FileBusiness(self.connection)
        rows = UnifiedMCPFileTransfer.objects.select_related("workspace", "asset")
        if lock:
            rows = rows.select_for_update(of=("self",))
        transfer = rows.filter(pk=session_id, connection=business.connection).first()
        if transfer is None:
            raise ResearchReadError("not_found", "当前连接中找不到文件会话。", 404)
        published = transfer.direction == "upload" and bool(
            FileBusiness.publication(transfer).get("business_published")
        )
        if (transfer.expires_at <= timezone.now() and not published) or transfer.state == "EXPIRED":
            raise ResearchReadError("transfer_expired", "文件会话已过期，请重新准备传输。", 410)
        workspace, _ = business.context(
            transfer.target, transfer.location, write=write, resource_id=transfer.file_ref.get("resource_id")
        )
        if workspace.pk != transfer.workspace_id:
            raise ResearchReadError("scope_denied", "文件会话归属不符。", 403)
        if transfer.direction == "download":
            business.source(transfer.file_ref)
        elif transfer.asset_id and (
            transfer.asset.workspace_id != workspace.pk or transfer.asset.is_deleted or transfer.asset.deleted_at
        ):
            raise ResearchReadError("not_found", "文件登记已失效。", 404)
        return transfer, business

    def present(self, transfer, *, http=True):
        """返回字节、文件完成、业务发布三个独立阶段，不泄露暂存对象键。"""
        publication = FileBusiness.publication(transfer) if transfer.asset_id else transfer.result
        file_complete = transfer.state in {"READY", "PUBLISHED"}
        value = {
            "session_id": str(transfer.pk),
            "request_id": transfer.request_id,
            "direction": transfer.direction,
            "phase": transfer.state,
            "error_code": transfer.error_code or None,
            "bytes_received": transfer.received_bytes,
            "next_offset": transfer.received_bytes,
            "bytes_complete": transfer.received_bytes == transfer.size and transfer.size > 0,
            "file_complete": file_complete,
            "business_published": bool(publication.get("business_published")),
            "file_name": transfer.file_name,
            "content_type": transfer.content_type,
            "size": transfer.size,
            "sha256": transfer.sha256 or None,
            "target": transfer.target,
            "location": transfer.location,
            "file_ref": transfer.file_ref or None,
            "result": publication,
            "expires_at": transfer.expires_at.isoformat(),
            "mcp": {
                "tool": "plane_read_file_chunk" if transfer.direction == "download" else "plane_upload_file_chunk",
                "session_id": str(transfer.pk),
                "default_chunk_bytes": DEFAULT_CHUNK_BYTES,
                "max_chunk_bytes": MAX_CHUNK_BYTES,
            },
        }
        if http and (
            (transfer.direction == "upload" and transfer.state == "RECEIVING")
            or (transfer.direction == "download" and file_complete)
        ):
            credential = signing.dumps(
                {
                    "session": str(transfer.pk),
                    "connection": str(transfer.connection_id),
                    "credential_hash": transfer.connection.token_hash,
                    "direction": transfer.direction,
                },
                salt=TOKEN_SALT,
            )
            path = f"/api/mcp/files/{transfer.pk}/?credential={credential}"
            value["http"] = {
                "method": "GET" if transfer.direction == "download" else "PUT",
                "url": public_url(self.request, path) if self.request else path,
                "headers": {} if transfer.direction == "download" else {"Content-Type": transfer.content_type},
                "body": "raw_file_bytes" if transfer.direction == "upload" else None,
                "expires_in_seconds": HTTP_TTL_SECONDS,
            }
        return value

    def list_files(self, parent, location, resource_id=None, version=None, cursor=None, limit=20):
        """分页列举授权文件与此位置当前可执行的操作。"""
        business = FileBusiness(self.connection)
        workspace, obj = business.context(parent, location)
        parent = business.reader.reference(parent["domain"], parent["object_type"], obj, workspace)
        rows, _ = business.rows(parent, location, resource_id=resource_id, version=version)
        binding = digest(
            {
                "target": parent,
                "location": location,
                "resource_id": resource_id,
                "version": version,
                "scope": business.connection.scope,
            }
        )
        after = None
        if cursor:
            try:
                state = signing.loads(cursor, salt="mcp.file-list", max_age=3600)
                if state["connection"] != str(self.connection.pk) or state["binding"] != binding:
                    raise ValueError()
                after = state["after"]
            except (signing.BadSignature, KeyError, ValueError, TypeError):
                raise ResearchReadError("invalid_cursor", "文件分页游标无效。", 422) from None
        if isinstance(rows, list):
            items = [row for row in rows if not after or row["attachment_id"] > after][: limit + 1]
        else:
            if after:
                rows = rows.filter(pk__gt=after)
            items = list(rows[: limit + 1])
        allowed, reason = True, None
        try:
            business.context(parent, location, write=True, resource_id=resource_id)
        except ResearchReadError as exc:
            allowed, reason = False, exc.code
        next_cursor = None
        if len(items) > limit:
            last = items[limit - 1]
            next_cursor = signing.dumps(
                {
                    "connection": str(self.connection.pk),
                    "binding": binding,
                    "after": last["attachment_id"] if isinstance(last, dict) else str(last.pk),
                },
                salt="mcp.file-list",
            )
        return {
            "data": [
                business.describe(parent, location, row, resource_id=resource_id, version=version)
                for row in items[:limit]
            ],
            "capabilities": {
                "upload": allowed,
                "unavailable_reason": reason,
                "limits_mb": business.limits(workspace, location),
                "markdown_text_max_bytes": min(
                    262144, int(business.limits(workspace, location).get("markdown_max_mb", 0)) * 1024 * 1024
                ),
                "attachment_count_limit": 50,
            },
            "page": {"has_more": next_cursor is not None, "next_cursor": next_cursor},
        }

    @transaction.atomic
    def prepare_file_upload(
        self, target, file_name, content_type, size, sha256, request_id, *, tool="plane_prepare_file_upload"
    ):
        """幂等创建上传会话；同请求标识不同文件或目标时拒绝。"""
        from plane.db.models import UnifiedMCPConnection

        business = FileBusiness(self.connection)
        UnifiedMCPConnection.objects.select_for_update().get(pk=business.connection.pk)
        location = target["location"]
        workspace, parent = business.context(
            target["parent"], location, write=True, resource_id=target.get("resource_id")
        )
        canonical = business.reader.reference(
            target["parent"]["domain"], target["parent"]["object_type"], parent, workspace
        )
        name = sanitize_filename(file_name)
        if not name or name != file_name or len(name) > 255:
            raise ResearchReadError("invalid_filename", "请使用不含目录的有效文件名。", 422)
        content_type = content_type.lower().strip()
        sha256 = sha256.lower()
        business.validate_metadata(workspace, location, name, content_type, size)
        request_hash = digest(
            {
                "tool": tool,
                "target": {**target, "parent": canonical},
                "file_name": name,
                "content_type": content_type,
                "size": size,
                "sha256": sha256,
            }
        )
        receipt = UnifiedMCPWriteResult.all_objects.filter(
            connection=business.connection, workspace=workspace, request_id=request_id
        ).first()
        if receipt:
            if receipt.deleted_at or receipt.tool != tool or receipt.request_hash != request_hash:
                raise ResearchReadError("idempotency_conflict", "该 request_id 已用于其他文件或业务操作。", 409)
            transfer, _ = self.session(receipt.object_id)
            return self.present(transfer)
        transfer = UnifiedMCPFileTransfer.objects.create(
            connection=business.connection,
            workspace=workspace,
            direction="upload",
            request_id=request_id,
            request_hash=request_hash,
            target=canonical,
            location=location,
            file_ref={"resource_id": target["resource_id"]} if target.get("resource_id") else {},
            file_name=name,
            content_type=content_type,
            size=size,
            sha256=sha256,
            expires_at=timezone.now() + timedelta(days=UPLOAD_TTL_DAYS),
        )
        prefix = f"{workspace.pk}/mcp-files/{transfer.pk}"
        transfer.staging_key = f"{prefix}/staging"
        transfer.final_key = f"{prefix}/final/{uuid4().hex}-{name}"
        transfer.save(update_fields=["staging_key", "final_key", "updated_at"])
        UnifiedMCPWriteResult.objects.create(
            connection=business.connection,
            workspace=workspace,
            request_id=request_id,
            tool=tool,
            request_hash=request_hash,
            object_type="FileTransfer",
            object_id=transfer.pk,
            result={"session_id": str(transfer.pk)},
        )
        return self.present(transfer)

    @transaction.atomic
    def upload_file_chunk(self, session_id, offset, content_base64):
        """顺序接收块，校验重试内容并返回准确续传位置。"""
        transfer, _ = self.session(session_id, lock=True, write=True)
        if transfer.direction != "upload":
            raise ResearchReadError("invalid_transfer", "该会话不能上传。", 422)
        try:
            content = base64.b64decode(content_base64, validate=True)
        except (ValueError, binascii.Error):
            raise ResearchReadError("invalid_base64", "文件块不是有效的 Base64。", 422) from None
        if not 1 <= len(content) <= MAX_CHUNK_BYTES:
            raise ResearchReadError("invalid_chunk_size", "每块原始内容必须为 1 至 16384 字节。", 422)
        block_hash = hashlib.sha256(content).hexdigest()
        existing = transfer.chunks.filter(offset=offset).first()
        if existing:
            if existing.size != len(content) or existing.sha256 != block_hash:
                raise ResearchReadError("chunk_conflict", "此偏移已经接收了不同内容。", 409)
            return {
                "session_id": str(transfer.pk),
                "phase": transfer.state,
                "bytes_received": transfer.received_bytes,
                "next_offset": transfer.received_bytes,
                "duplicate": True,
            }
        if transfer.state != "RECEIVING" or transfer.transport not in {"", "mcp"}:
            raise ResearchReadError("state_conflict", "该会话已进入其他传输或确认阶段。", 409)
        if offset != transfer.received_bytes or offset + len(content) > transfer.size:
            error = ResearchReadError("invalid_offset", "块偏移不正确，请从 next_offset 续传。", 409)
            error.details = {"next_offset": transfer.received_bytes}
            raise error
        key = f"{transfer.staging_key}/chunks/{offset}"
        TransferStorage().put(key, io.BytesIO(content), "application/octet-stream")
        UnifiedMCPFileChunk.objects.create(
            transfer=transfer, offset=offset, size=len(content), sha256=block_hash, object_key=key
        )
        transfer.transport = "mcp"
        transfer.received_bytes += len(content)
        transfer.save(update_fields=["transport", "received_bytes", "updated_at"])
        return {
            "session_id": str(transfer.pk),
            "phase": transfer.state,
            "bytes_received": transfer.received_bytes,
            "next_offset": transfer.received_bytes,
            "duplicate": False,
        }

    @transaction.atomic
    def receive_http(self, session_id, source):
        """在短期授权下有界接收原始文件，禁止已确认会话被覆盖。"""
        transfer, business = self.session(session_id, lock=True, write=True)
        if transfer.direction != "upload" or transfer.state != "RECEIVING" or transfer.transport not in {"", "http"}:
            raise ResearchReadError("state_conflict", "当前会话不能接收 HTTP 文件。", 409)
        with temporary_file() as stream:
            size, sha256 = copy_stream(source, stream, transfer.size)
            if size != transfer.size or sha256 != transfer.sha256:
                raise ResearchReadError("checksum_mismatch", "HTTP 文件大小或摘要不符。", 422)
            business = FileBusiness(self.connection)
            business.context(
                transfer.target, transfer.location, write=True, resource_id=transfer.file_ref.get("resource_id")
            )
            TransferStorage().put(transfer.staging_key, stream, transfer.content_type)
        transfer.transport, transfer.received_bytes = "http", size
        transfer.save(update_fields=["transport", "received_bytes", "updated_at"])
        return self.present(transfer, http=False)

    @transaction.atomic
    def complete_file_upload(self, session_id, transport):
        """启动后台校验和登记，重复确认只恢复同一结果。"""
        transfer, _ = self.session(session_id, lock=True)
        if transfer.direction != "upload" or transfer.transport != transport:
            raise ResearchReadError("transport_conflict", "传输方式与会话实际使用的通道不符。", 409)
        if transfer.state in {"READY", "PUBLISHED", "UNKNOWN"}:
            if not FileBusiness.publication(transfer).get("business_published"):
                self.session(session_id, write=True)
            return self.present(transfer)
        self.session(session_id, write=True)
        if transfer.received_bytes != transfer.size:
            raise ResearchReadError("upload_incomplete", "文件字节尚未全部接收，请继续上传。", 409)
        if transfer.state == "FAILED" and transfer.error_code in {
            "checksum_mismatch",
            "file_type_not_allowed",
            "size_mismatch",
        }:
            raise ResearchReadError(transfer.error_code, "文件校验失败，请使用新的 request_id 上传正确文件。", 422)
        transfer.state, transfer.error_code = "FINALIZING", ""
        transfer.save(update_fields=["state", "error_code", "updated_at"])
        enqueue(transfer)
        return self.present(transfer)

    def upload_markdown(self, target, file_name, text, request_id):
        """生成真实 UTF-8 Markdown 文件，并通过共同确认流程登记。"""
        content = text.encode("utf-8")
        business = FileBusiness(self.connection)
        workspace, _ = business.context(
            target["parent"], target["location"], write=True, resource_id=target.get("resource_id")
        )
        limits = business.limits(workspace, target["location"])
        maximum = min(262144, int(limits.get("markdown_max_mb", 0)) * 1024 * 1024)
        if not file_name.lower().endswith(".md") or not 0 < len(content) <= maximum:
            raise ResearchReadError(
                "markdown_text_limit",
                f"正文入口要求 .md 文件且 UTF-8 内容不超过 {maximum} 字节；更大文件请用普通通道。",
                422,
            )
        prepared = self.prepare_file_upload(
            target,
            file_name,
            "text/markdown",
            len(content),
            hashlib.sha256(content).hexdigest(),
            request_id,
            tool="plane_upload_markdown",
        )
        transfer, _ = self.session(prepared["session_id"])
        if transfer.state == "RECEIVING":
            self.receive_http(str(transfer.pk), io.BytesIO(content))
        return self.complete_file_upload(str(transfer.pk), "http")

    @transaction.atomic
    def get_file_download(self, file_ref):
        """为明确版本创建一次性外部获取、可重复读取的不可变快照。"""
        business = FileBusiness(self.connection)
        info, _ = business.source(file_ref)
        workspace, parent = business.context(file_ref["parent"], file_ref["location"])
        canonical = business.reader.reference(
            file_ref["parent"]["domain"], file_ref["parent"]["object_type"], parent, workspace
        )
        reference = {**file_ref, "parent": canonical}
        transfer = UnifiedMCPFileTransfer.objects.create(
            connection=business.connection,
            workspace=workspace,
            direction="download",
            state="PREPARING",
            target=canonical,
            location=file_ref["location"],
            file_ref=reference,
            file_name=info["file_name"],
            content_type=info["content_type"],
            size=info["size"],
            sha256=info["sha256"] or "",
            expires_at=timezone.now() + timedelta(hours=DOWNLOAD_TTL_HOURS),
        )
        transfer.final_key = f"{workspace.pk}/mcp-files/{transfer.pk}/snapshot"
        transfer.save(update_fields=["final_key", "updated_at"])
        enqueue(transfer)
        return {**self.present(transfer), "recovery_request_id": "download:" + str(transfer.pk)}

    def read_file_chunk(self, session_id, cursor=None, chunk_size=DEFAULT_CHUNK_BYTES):
        """读取绑定快照摘要的有界块，返回独立块摘要和下一游标。"""
        transfer, _ = self.session(session_id)
        if transfer.direction != "download" or transfer.state != "READY":
            raise ResearchReadError("download_not_ready", "下载快照仍在准备，请查询会话阶段。", 409)
        offset = 0
        if cursor:
            try:
                state = signing.loads(cursor, salt=CURSOR_SALT, max_age=DOWNLOAD_TTL_HOURS * 3600)
                if state["session"] != str(transfer.pk) or state["sha256"] != transfer.sha256:
                    raise ValueError()
                offset = state["offset"]
                if type(offset) is not int or not 0 <= offset <= transfer.size:
                    raise ValueError()
            except (signing.BadSignature, ValueError, TypeError, KeyError):
                raise ResearchReadError("invalid_cursor", "分块下载游标与当前快照不符。", 422) from None
        size = min(chunk_size, transfer.size - offset)
        content = TransferStorage().read(transfer.final_key, offset, size) if size else b""
        if len(content) != size:
            raise ResearchReadError("snapshot_unavailable", "下载快照不完整，请重新准备。", 503)
        next_offset = offset + size
        eof = next_offset == transfer.size
        next_cursor = signing.dumps(
            {"session": str(transfer.pk), "sha256": transfer.sha256, "offset": next_offset}, salt=CURSOR_SALT
        )
        return {
            "session_id": str(transfer.pk),
            "offset": offset,
            "size": size,
            "content_base64": base64.b64encode(content).decode("ascii"),
            "chunk_sha256": hashlib.sha256(content).hexdigest(),
            "file_sha256": transfer.sha256,
            "next_cursor": next_cursor,
            "next_offset": next_offset,
            "eof": eof,
        }

    def get_result(self, workspace_slug, request_id):
        """恢复上传或下载会话，并重新派发可恢复的后台工作。"""
        business = FileBusiness(self.connection)
        workspace = business.reader.workspace(workspace_slug)
        if request_id.startswith("download:"):
            from uuid import UUID

            try:
                identity = str(UUID(request_id.removeprefix("download:")))
            except ValueError:
                raise ResearchReadError("not_found", "下载会话标识无效。", 404) from None
            transfer, _ = self.session(identity)
            if transfer.workspace_id != workspace.pk or transfer.direction != "download":
                raise ResearchReadError("not_found", "下载会话不属于此工作区。", 404)
        else:
            receipt = UnifiedMCPWriteResult.objects.filter(
                connection=business.connection, workspace=workspace, request_id=request_id, object_type="FileTransfer"
            ).first()
            if receipt is None:
                return None
            transfer, _ = self.session(receipt.object_id)
            if transfer.direction == "upload" and not FileBusiness.publication(transfer).get("business_published"):
                transfer, _ = self.session(receipt.object_id, write=True)
        if transfer.state in {"PREPARING", "FINALIZING"} and (
            not transfer.lease_until or transfer.lease_until <= timezone.now()
        ):
            enqueue(transfer)
        if transfer.state == "UNKNOWN" and transfer.result.get("external_upload_id"):
            enqueue(transfer)
        return self.present(transfer)

    @transaction.atomic
    def submit_paper_version(self, session_id, change_summary, request_id):
        """显式提交已校验的论文候选，原子保存版本及幂等回执。"""
        from plane.db.models import UnifiedMCPConnection
        from plane.research.services.paper_review import (
            submit_paper_version,
            PaperReviewPermissionError,
            PaperReviewValidationError,
            PaperReviewStateError,
            PaperReviewConflictError,
        )

        UnifiedMCPConnection.objects.select_for_update().get(pk=self.connection.pk)
        transfer, business = self.session(session_id, lock=True)
        request_hash = digest({"session_id": str(transfer.pk), "change_summary": change_summary})
        receipt = UnifiedMCPWriteResult.all_objects.filter(
            connection=business.connection, workspace=transfer.workspace, request_id=request_id
        ).first()
        if receipt:
            if (
                receipt.tool != "plane_submit_paper_version"
                or receipt.request_hash != request_hash
                or receipt.deleted_at
            ):
                raise ResearchReadError("idempotency_conflict", "request_id 已用于其他操作。", 409)
            return self.present(transfer)
        if (
            transfer.direction != "upload"
            or transfer.location != "paper_version"
            or transfer.state != "READY"
            or not transfer.asset_id
        ):
            raise ResearchReadError("candidate_not_ready", "请先完成论文候选文件上传，再显式提交版本。", 409)
        self.session(session_id, write=True)
        _, parent = business.context(
            transfer.target, transfer.location, resource_id=transfer.file_ref.get("resource_id")
        )
        review = business.resource(parent, transfer.location, transfer.file_ref["resource_id"])
        try:
            version, _ = submit_paper_version(
                review=review,
                actor=business.user,
                payload={
                    "asset_id": str(transfer.asset_id),
                    "change_summary": change_summary,
                    "request_id": request_id,
                },
                request=self.request,
            )
        except (
            PaperReviewPermissionError,
            PaperReviewValidationError,
            PaperReviewStateError,
            PaperReviewConflictError,
        ) as exc:
            raise ResearchReadError(getattr(exc, "error_code", "paper_submit_rejected"), str(exc), 409) from None
        transfer.state = "PUBLISHED"
        transfer.file_ref = {
            "parent": transfer.target,
            "location": "paper_version",
            "id": str(version.pk),
            "resource_id": str(review.pk),
            "version": version.version_no,
        }
        transfer.result.update(business_published=True, version_id=str(version.pk), version=version.version_no)
        transfer.save(update_fields=["state", "file_ref", "result", "updated_at"])
        UnifiedMCPWriteResult.objects.create(
            connection=business.connection,
            workspace=transfer.workspace,
            request_id=request_id,
            tool="plane_submit_paper_version",
            request_hash=request_hash,
            object_type="FileTransfer",
            object_id=transfer.pk,
            result=transfer.result,
        )
        return self.present(transfer)
