"""网页上传与 MCP 共用的知识库连接和原生文件登记。"""

from django.db import transaction
from django.utils import timezone

from plane.db.models import ExternalSystemConnection, ResearchChainEvent, ResearchExternalReference
from plane.research.services.group_knowledge import SCOPE_GROUP, knowledge_scope_for_chain
from plane.research.services.idempotency import payload_hash
from plane.research.services.integrations import client_for
from plane.research.services.mcp_catalog import ResearchReadError

UPLOAD_STATUS_MAP = {
    "pending": "PROCESSING",
    "processing": "PROCESSING",
    "finalizing": "SUCCESS",
    "success": "SUCCESS",
    "failed": "FAILED",
    "deleted": "FAILED",
    "cancelled": "FAILED",
}


def rag_client(workspace):
    """读取工作区既有 RAGPortal 配置，不创建新的用户凭据。"""
    setting = getattr(workspace, "research_setting", None)
    connection = ExternalSystemConnection.objects.filter(workspace=workspace, system="RAGPORTAL").first()
    if not setting or not setting.research_external_rag_enabled:
        connection = None
    return client_for("RAGPORTAL", connection), connection


def ready_knowledge_scope(chain, actor):
    """解析研究链已绑定并可用的知识库。"""
    scope = knowledge_scope_for_chain(chain, ensure=True, actor=actor)
    if scope.state != "READY" or not scope.external_kb_id:
        raise ResearchReadError("knowledge_base_not_ready", "研究链对应知识库尚未就绪。", 409)
    return scope


@transaction.atomic
def register_chain_file(*, upload, item, connection, scope, actor):
    """将上游回执登记为网页可见的上传、引用和幂等研究链事件。"""
    from plane.db.models import ResearchChainUpload

    upload = ResearchChainUpload.objects.select_for_update().get(pk=upload.pk)
    metadata = item.get("metadata") or {}
    upload_id = str(metadata.get("upload_id") or "")
    knowledge_id = str(item.get("external_id") or "")
    if not upload_id or not knowledge_id or connection is None:
        raise ResearchReadError("upstream_receipt_incomplete", "知识库回执缺少文件标识，需要确认上游状态。", 503)
    existing = ResearchExternalReference.objects.filter(
        workspace=upload.workspace, system="RAGPORTAL", external_type="KNOWLEDGE_ENTRY", external_id=knowledge_id
    ).first()
    existing_chain = str((existing.metadata or {}).get("chain_id") or "") if existing else ""
    if existing_chain and existing_chain != str(upload.chain_id):
        raise ResearchReadError("cross_chain_reference", "上游文件已关联另一条研究链。", 403)
    upload.external_upload_id, upload.knowledge_id = upload_id, knowledge_id
    upload.task_id = str(metadata.get("task_id") or "")
    upload.knowledge_base_id = str(item.get("external_parent_id") or upload.knowledge_base_id)
    raw_status = str(metadata.get("parse_status") or "pending").lower()
    upload.status = UPLOAD_STATUS_MAP.get(raw_status, "PROCESSING")
    path = item.get("source_url") or f"/api/uploads/{upload_id}"
    reference, _ = ResearchExternalReference.objects.update_or_create(
        workspace=upload.workspace,
        system="RAGPORTAL",
        external_type="KNOWLEDGE_ENTRY",
        external_id=knowledge_id,
        defaults={
            "external_parent_id": upload.knowledge_base_id,
            "title": item.get("title") or upload.file_name,
            "summary": item.get("summary") or "",
            "source_url": f"{connection.base_url.rstrip('/')}{path}" if path.startswith("/") else path,
            "acl_hint": {
                "workspace": upload.workspace.slug,
                "research_project_id": str(upload.chain.project_id),
                "chain_id": str(upload.chain_id),
                "chain_node_id": str(upload.node_id),
                **({"org_units": [scope.org_unit_id]} if scope.scope == SCOPE_GROUP and scope.org_unit_id else {}),
            },
            "metadata": {
                **upload.metadata,
                "upload_id": upload_id,
                "task_id": upload.task_id,
                "parse_status": raw_status,
            },
            "content_hash": upload.file_hash,
            "synced_at": timezone.now(),
            "status": "ACTIVE",
        },
    )
    upload.reference, upload.error_code = reference, ""
    upload.save()
    event_id = payload_hash({"request_id": upload.request_id, "kind": "DATA_CHANGE"})
    event, _ = ResearchChainEvent.objects.get_or_create(
        event_id=event_id,
        defaults={
            "chain": upload.chain,
            "node": upload.node,
            "request_id": upload.request_id,
            "actor": actor,
            "actor_type": "USER",
            "source_system": "PLANE",
            "event_type": "DATA_CHANGE",
            "occurred_at": timezone.now(),
            "refs": [{"kind": "knowledge", "id": knowledge_id, "version": 1}],
            "summary": f"Uploaded research file: {upload.file_name}",
            "content_hash": upload.payload_hash,
            "metadata": {"upload_id": str(upload.pk), "kb_id": upload.knowledge_base_id, "sha256": upload.file_hash},
        },
    )
    if event.content_hash != upload.payload_hash:
        raise ResearchReadError("idempotency_conflict", "知识库登记请求标识冲突。", 409)
    return upload
