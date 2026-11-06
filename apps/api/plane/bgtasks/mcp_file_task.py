"""统一 MCP 文件的后台快照、校验、登记及暂存回收任务。"""

import hashlib
import logging
from datetime import timedelta
from uuid import uuid4

from celery import shared_task
from django.db import transaction
from django.db.models import Q
from django.utils import timezone

from plane.db.models import FileAsset, ResearchChainUpload, UnifiedMCPFileTransfer
from plane.mcp.file_business import FileBusiness
from plane.mcp.file_storage import TransferStorage, temporary_file, validate_file
from plane.mcp.files import UnifiedFileService
from plane.research.services.chain_files import rag_client, ready_knowledge_scope, register_chain_file
from plane.research.services.mcp_catalog import ResearchReadError

logger = logging.getLogger(__name__)


def assemble_upload(transfer, output, storage):
    """逐块组装到磁盘，验证每个块的偏移、大小和摘要。"""
    if transfer.transport == "http":
        storage.copy_to(transfer.staging_key, output, transfer.size)
        return
    offset = 0
    for block in transfer.chunks.order_by("offset").iterator(chunk_size=500):
        if block.offset != offset:
            raise ResearchReadError("invalid_offset", "上传块不连续。", 422)
        content = storage.read(block.object_key, 0, block.size)
        if len(content) != block.size or hashlib.sha256(content).hexdigest() != block.sha256:
            raise ResearchReadError("checksum_mismatch", "上传块的存储内容校验失败。", 422)
        output.write(content)
        offset += block.size
    if offset != transfer.size:
        raise ResearchReadError("size_mismatch", "上传块总大小与声明不符。", 422)


def prepare_download(transfer, output, storage):
    """只获取一次原文件，后续 HTTP 和分块均读取同一快照。"""
    business = FileBusiness(transfer.connection)
    info, source = business.source(transfer.file_ref)
    if info["size"] != transfer.size or (transfer.sha256 and info["sha256"] != transfer.sha256):
        raise ResearchReadError("version_changed", "文件版本在准备期间发生变化。", 409)
    if isinstance(source, FileAsset):
        size, sha256 = storage.copy_to(source.asset.name, output, transfer.size)
    else:
        local = (
            UnifiedMCPFileTransfer.objects.filter(
                pk=source.metadata.get("mcp_file_transfer_id"),
                direction="upload",
                state="PUBLISHED",
                workspace=transfer.workspace,
                sha256=source.file_hash,
            ).first()
            if source.metadata.get("mcp_file_transfer_id")
            else None
        )
        if local:
            size, sha256 = storage.copy_to(local.final_key, output, transfer.size)
        else:
            client, _ = rag_client(transfer.workspace)
            result = client.download_research_file(
                knowledge_id=source.knowledge_id,
                chain_id=str(source.chain_id),
                node_id=str(source.node_id),
                kb_id=source.knowledge_base_id,
                file_hash=source.file_hash,
                output=output,
                max_bytes=transfer.size,
            )
            if result.degraded:
                raise ResearchReadError("upstream_unavailable", "知识库原文件获取失败，请恢复同一下载会话。", 503)
            size = output.tell()
            output.seek(0)
            calculated = hashlib.sha256()
            while block := output.read(1024 * 1024):
                calculated.update(block)
            sha256 = calculated.hexdigest()
    if size != transfer.size or (transfer.sha256 and sha256 != transfer.sha256):
        raise ResearchReadError("checksum_mismatch", "原文件大小或摘要与选中版本不符。", 422)
    return sha256


def publish_node_file(transfer, stream, token):
    """上传一次上游；保留请求已发出和上游标识以恢复不确定结果。"""
    business = FileBusiness(transfer.connection)
    _, node = business.context(transfer.target, transfer.location, write=True)
    scope = ready_knowledge_scope(node.chain, business.user)
    client, connection = rag_client(transfer.workspace)
    if not client.enabled:
        raise ResearchReadError("upstream_unavailable", "工作区既有知识库连接不可用。", 503)
    with transaction.atomic():
        locked = UnifiedMCPFileTransfer.objects.select_for_update().get(pk=transfer.pk)
        if locked.worker_token != token:
            return
        upload, _ = ResearchChainUpload.objects.get_or_create(
            request_id="mcp-file:" + str(transfer.pk),
            defaults={
                "workspace": transfer.workspace,
                "chain": node.chain,
                "node": node,
                "created_by": business.user,
                "payload_hash": transfer.request_hash,
                "file_name": transfer.file_name,
                "file_type": transfer.file_name.rsplit(".", 1)[-1].lower(),
                "file_size": transfer.size,
                "file_hash": transfer.sha256,
                "knowledge_base_id": scope.external_kb_id,
                "metadata": {
                    "workspace_slug": transfer.workspace.slug,
                    "research_project_id": str(node.chain.project_id),
                    "chain_id": str(node.chain_id),
                    "chain_node_id": str(node.pk),
                    "mcp_file_transfer_id": str(transfer.pk),
                },
            },
        )
        external_id = locked.result.get("external_upload_id") or upload.external_upload_id
        if locked.result.get("upstream_started") and not external_id:
            locked.state, locked.error_code = "UNKNOWN", "upstream_outcome_unknown"
            locked.save(update_fields=["state", "error_code", "updated_at"])
            return
        locked.result.update(upload_id=str(upload.pk), upstream_started=True)
        locked.save(update_fields=["result", "updated_at"])
    stream.seek(0)
    if external_id:
        response = client.upload_detail(external_id)
    else:
        response = client.upload(
            file_name=transfer.file_name,
            file_content=stream,
            kb_id=scope.external_kb_id,
            metadata={**upload.metadata, "file_sha256": transfer.sha256, "request_id": upload.request_id},
        )
    item = response.items[0] if response.items else None
    if item:
        external_id = str((item.get("metadata") or {}).get("upload_id") or external_id)
    with transaction.atomic():
        locked = UnifiedMCPFileTransfer.objects.select_for_update().get(pk=transfer.pk)
        if locked.worker_token != token:
            return
        if external_id:
            locked.result["external_upload_id"] = external_id
            locked.save(update_fields=["result", "updated_at"])
        if response.degraded or not item:
            locked.state, locked.error_code = "UNKNOWN", "upstream_outcome_unknown"
            locked.save(update_fields=["state", "error_code", "updated_at"])
            return
        business = FileBusiness(transfer.connection)
        _, node = business.context(transfer.target, transfer.location, write=True)
        business.lock_parent(node)
        upload = register_chain_file(upload=upload, item=item, connection=connection, scope=scope, actor=business.user)
        locked.state, locked.error_code = "PUBLISHED", ""
        locked.result.update(
            upload_id=str(upload.pk),
            external_upload_id=upload.external_upload_id,
            knowledge_id=upload.knowledge_id,
            business_published=True,
            upstream_status=upload.status,
        )
        locked.file_ref = {"parent": locked.target, "location": "node_file", "id": str(upload.pk)}
        locked.save(update_fields=["state", "error_code", "result", "file_ref", "updated_at"])


@shared_task
def process_mcp_file_transfer(session_id):
    """使用有期限租约处理一个会话；重复派发不会重复登记或提交上游。"""
    token = uuid4()
    with transaction.atomic():
        transfer = UnifiedMCPFileTransfer.objects.select_for_update().filter(pk=session_id).first()
        if (
            transfer is None
            or transfer.expires_at <= timezone.now()
            or transfer.state not in {"PREPARING", "FINALIZING", "UNKNOWN"}
        ):
            return
        if transfer.lease_until and transfer.lease_until > timezone.now():
            return
        transfer.worker_token, transfer.lease_until = token, timezone.now() + timedelta(minutes=10)
        transfer.save(update_fields=["worker_token", "lease_until", "updated_at"])
    try:
        service = UnifiedFileService(transfer.connection)
        transfer, business = service.session(session_id, write=transfer.direction == "upload")
        storage = TransferStorage()
        with temporary_file() as stream:
            if transfer.direction == "download":
                sha256 = prepare_download(transfer, stream, storage)
            else:
                assemble_upload(transfer, stream, storage)
                limits = business.validate_metadata(
                    transfer.workspace, transfer.location, transfer.file_name, transfer.content_type, transfer.size
                )
                validate_file(
                    stream,
                    file_name=transfer.file_name,
                    content_type=transfer.content_type,
                    size=transfer.size,
                    limits=limits,
                    sha256=transfer.sha256,
                )
                sha256 = transfer.sha256
            with transaction.atomic():
                locked, business = service.session(session_id, lock=True, write=transfer.direction == "upload")
                if locked.worker_token != token or locked.state not in {"PREPARING", "FINALIZING", "UNKNOWN"}:
                    return
                if not locked.result.get("snapshot_stored"):
                    storage.put(locked.final_key, stream, locked.content_type)
                    locked.result["snapshot_stored"] = True
                locked.sha256, locked.error_code = sha256, ""
                if locked.direction == "download":
                    locked.state, locked.received_bytes = "READY", locked.size
                elif locked.location != "node_file":
                    business.register(locked)
                locked.save()
                transfer = locked
            if transfer.direction == "upload" and transfer.location == "node_file":
                with temporary_file() as upstream_stream:
                    storage.copy_to(transfer.final_key, upstream_stream, transfer.size)
                    publish_node_file(transfer, upstream_stream, token)
    except ResearchReadError as exc:
        UnifiedMCPFileTransfer.objects.filter(pk=session_id, worker_token=token).update(
            state="FAILED", error_code=exc.code
        )
    except Exception as exc:
        # 响应中不回显存储地址、上游请求或临时凭据。
        logger.error(
            "MCP file transfer processing failed",
            extra={"file_transfer_id": str(session_id), "error_type": type(exc).__name__},
        )
        UnifiedMCPFileTransfer.objects.filter(pk=session_id, worker_token=token).update(
            error_code="transfer_unavailable"
        )
    finally:
        UnifiedMCPFileTransfer.objects.filter(pk=session_id, worker_token=token).update(
            worker_token=None, lease_until=None
        )


@shared_task
def cleanup_mcp_file_transfers():
    """回收过期快照与七天未发布的文件，保留真实业务关联。"""
    now = timezone.now()
    storage = TransferStorage()
    for identity in (
        UnifiedMCPFileTransfer.objects.filter(expires_at__lte=now)
        .exclude(state="EXPIRED")
        .filter(Q(result__staging_cleaned__isnull=True) | ~Q(result__staging_cleaned=True))
        .values_list("pk", flat=True)
        .iterator(chunk_size=100)
    ):
        with transaction.atomic():
            transfer = UnifiedMCPFileTransfer.objects.select_for_update().get(pk=identity)
            if transfer.lease_until and transfer.lease_until > now:
                continue
            if transfer.asset_id:
                transfer.asset = FileAsset.objects.select_for_update().get(pk=transfer.asset_id)
            result = FileBusiness.publication(transfer) if transfer.asset_id else transfer.result
            published = bool(result.get("business_published"))
            keys = list(transfer.chunks.values_list("object_key", flat=True))
            keys.append(transfer.staging_key)
            if transfer.direction == "download" or not published:
                keys.append(transfer.final_key)
            storage.delete(keys)
            if transfer.asset_id and not published:
                FileAsset.objects.filter(pk=transfer.asset_id).update(is_deleted=True, deleted_at=now)
            transfer.chunks.all().delete()
            transfer.state = "PUBLISHED" if published else "EXPIRED"
            transfer.result = {**transfer.result, **result, "staging_cleaned": True}
            transfer.save(update_fields=["state", "result", "updated_at"])
