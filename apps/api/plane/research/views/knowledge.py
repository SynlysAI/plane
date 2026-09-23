"""Scoped RAGPortal knowledge BFF for Research Chains."""

import hashlib
import os
from uuid import UUID

from django.utils import timezone
from rest_framework import status
from rest_framework.parsers import FormParser, MultiPartParser
from rest_framework.response import Response

from plane.db.models import (
    ExternalSystemConnection,
    ResearchChainEvent,
    ResearchChainUpload,
    ResearchExternalReference,
)
from plane.research.serializers import (
    ResearchChainUploadSerializer,
    ResearchExternalReferenceSerializer,
)
from plane.research.services.idempotency import conflict_response, payload_hash, request_id_from
from plane.research.services.integrations import client_for
from plane.research.utils.capabilities import NAV_RESEARCH_CHAIN
from plane.research.utils.errors import ResearchErrorCode, research_error, research_not_found
from plane.research.views.base import ResearchAPIView
from plane.research.views.chain_foundation import _chain_readonly_error, _visible_chain

ALLOWED_UPLOAD_EXTENSIONS = frozenset({"pdf", "md", "markdown", "txt", "doc", "docx"})
MAX_UPLOAD_BYTES = 50 * 1024 * 1024
UPLOAD_STATUS_MAP = {
    "pending": ResearchChainUpload.Status.PENDING,
    "processing": ResearchChainUpload.Status.PROCESSING,
    "success": ResearchChainUpload.Status.SUCCESS,
    "failed": ResearchChainUpload.Status.FAILED,
}


def _rag_client(workspace):
    """Return the enabled RAGPortal client and its connection."""
    connection = (
        ExternalSystemConnection.objects.filter(
            workspace=workspace,
            system="RAGPORTAL",
            deleted_at__isnull=True,
        ).first()
    )
    return client_for("RAGPORTAL", connection), connection


def _event_id(request_id, kind):
    """Build a bounded deterministic event id for a BFF write."""
    return payload_hash({"request_id": request_id, "kind": kind})


def _append_event(*, chain, node, request, event_type, summary, refs, metadata, request_id, digest):
    """Append one idempotent Chain fact for a knowledge operation."""
    event_id = _event_id(request_id, event_type)
    existing = ResearchChainEvent.objects.filter(request_id=request_id).first()
    if existing is not None:
        return existing if existing.content_hash == digest else None
    return ResearchChainEvent.objects.create(
        chain=chain,
        node=node,
        event_id=event_id,
        request_id=request_id,
        actor=request.user,
        actor_type="USER",
        source_system="PLANE",
        event_type=event_type,
        occurred_at=timezone.now(),
        refs=refs,
        summary=summary,
        content_hash=digest,
        metadata=metadata,
    )


class ResearchChainKnowledgeBaseListEndpoint(ResearchAPIView):
    """``GET /chains/<chain_id>/knowledge-bases/``."""

    nav_capability = NAV_RESEARCH_CHAIN

    def get(self, request, slug, chain_id):
        workspace, error = self.get_workspace(section="research_chain")
        if error:
            return error
        chain = _visible_chain(workspace, request.user, chain_id)
        if chain is None:
            return research_not_found(ResearchErrorCode.CHAIN_NOT_FOUND, "Research chain not found.")
        client, _connection = _rag_client(workspace)
        result = client.knowledge_bases(request=request)
        payload = result.as_payload(chain_id=str(chain.id))
        return Response(payload, status=status.HTTP_200_OK)


class ResearchChainUploadEndpoint(ResearchAPIView):
    """``POST /chains/<chain_id>/uploads/`` with node-scoped metadata."""

    nav_capability = NAV_RESEARCH_CHAIN
    parser_classes = [MultiPartParser, FormParser]

    def post(self, request, slug, chain_id):
        workspace, error = self.get_workspace(section="research_chain")
        if error:
            return error
        chain = _visible_chain(workspace, request.user, chain_id)
        if chain is None:
            return research_not_found(ResearchErrorCode.CHAIN_NOT_FOUND, "Research chain not found.")
        readonly_error = _chain_readonly_error(chain)
        if readonly_error:
            return readonly_error
        node = chain.nodes.filter(pk=request.data.get("node_id")).first()
        if node is None:
            return research_error(
                ResearchErrorCode.CHAIN_INVALID,
                "node_id must identify a node in this chain.",
                status.HTTP_422_UNPROCESSABLE_ENTITY,
            )
        request_id = request_id_from(request)
        uploaded = request.FILES.get("file")
        knowledge_base_id = str(request.data.get("kb_id") or "").strip()
        if not request_id or uploaded is None or not knowledge_base_id:
            return research_error(
                ResearchErrorCode.IDEMPOTENCY_CONFLICT,
                "request_id, file and kb_id are required.",
            )
        file_name = os.path.basename(str(uploaded.name or "document"))
        extension = file_name.rsplit(".", 1)[-1].lower() if "." in file_name else ""
        if extension not in ALLOWED_UPLOAD_EXTENSIONS:
            return research_error(
                ResearchErrorCode.FILE_TYPE_NOT_ALLOWED,
                "Only PDF, Markdown, text and Word documents can be uploaded.",
                status.HTTP_422_UNPROCESSABLE_ENTITY,
            )
        if uploaded.size > MAX_UPLOAD_BYTES:
            return research_error(
                ResearchErrorCode.FILE_SIZE_EXCEEDED,
                "The research file exceeds the 50MB Phase 1 limit.",
                status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            )
        file_bytes = uploaded.read()
        file_hash = hashlib.sha256(file_bytes).hexdigest()
        digest = payload_hash(
            {
                "request_id": request_id,
                "chain_id": str(chain.id),
                "node_id": str(node.id),
                "kb_id": knowledge_base_id,
                "file_name": file_name,
                "file_hash": file_hash,
                "file_size": uploaded.size,
            }
        )
        existing = ResearchChainUpload.objects.filter(request_id=request_id).first()
        if existing is not None:
            if existing.payload_hash != digest:
                return conflict_response()
            return Response(
                {"data": ResearchChainUploadSerializer(existing).data, "idempotent": True},
                status=status.HTTP_200_OK,
            )
        duplicate = ResearchChainUpload.objects.filter(
            chain=chain,
            node=node,
            file_hash=file_hash,
            status__in=(
                ResearchChainUpload.Status.PENDING,
                ResearchChainUpload.Status.PROCESSING,
                ResearchChainUpload.Status.SUCCESS,
            ),
        ).first()
        if duplicate is not None:
            if duplicate.payload_hash != digest:
                return conflict_response()
            return Response(
                {"data": ResearchChainUploadSerializer(duplicate).data, "idempotent": True},
                status=status.HTTP_200_OK,
            )

        upload = ResearchChainUpload.objects.filter(chain=chain, node=node, file_hash=file_hash).first()
        created = upload is None
        if created:
            upload = ResearchChainUpload(
                workspace=workspace,
                chain=chain,
                node=node,
                request_id=request_id,
                created_by=request.user,
            )
        upload.payload_hash = digest
        upload.file_name = file_name
        upload.file_type = extension
        upload.file_size = uploaded.size
        upload.file_hash = file_hash
        upload.knowledge_base_id = knowledge_base_id
        upload.error_code = ""
        upload.metadata = {
            "workspace_slug": workspace.slug,
            "research_project_id": str(chain.project_id),
            "chain_id": str(chain.id),
            "chain_node_id": str(node.id),
        }
        upload.save()

        client, connection = _rag_client(workspace)
        result = client.upload(
            file_name=file_name,
            file_content=file_bytes,
            kb_id=knowledge_base_id,
            metadata={
                "workspace_slug": workspace.slug,
                "research_project_id": str(chain.project_id),
                "chain_node_id": str(node.id),
                "file_sha256": file_hash,
            },
            request=request,
        )
        if result.degraded:
            upload.status = ResearchChainUpload.Status.DEGRADED
            upload.error_code = result.degraded_reason
            upload.save(update_fields=["status", "error_code", "updated_at"])
            event = _append_event(
                chain=chain,
                node=node,
                request=request,
                event_type="DEGRADED",
                summary=f"RAGPortal upload degraded: {file_name}",
                refs=[{"kind": "upload", "id": str(upload.id)}],
                metadata={"reason": result.degraded_reason, "manual_record": True},
                request_id=request_id,
                digest=digest,
            )
            if event is None:
                return conflict_response()
            return Response(
                {
                    "data": ResearchChainUploadSerializer(upload).data,
                    "degraded": True,
                    "degraded_reason": result.degraded_reason,
                    "manual_record": True,
                },
                status=status.HTTP_503_SERVICE_UNAVAILABLE,
            )
        if not result.items:
            upload.status = ResearchChainUpload.Status.FAILED
            upload.error_code = "invalid_payload"
            upload.save(update_fields=["status", "error_code", "updated_at"])
            return research_error(
                ResearchErrorCode.UPSTREAM_DEGRADED,
                "RAGPortal did not return an upload receipt.",
                status.HTTP_502_BAD_GATEWAY,
            )

        item = result.items[0]
        raw_status = str(item.get("metadata", {}).get("parse_status") or "pending").lower()
        upload.status = UPLOAD_STATUS_MAP.get(raw_status, ResearchChainUpload.Status.PROCESSING)
        upload.external_upload_id = str(item.get("metadata", {}).get("upload_id") or "")
        upload.knowledge_id = str(item.get("external_id") or "")
        upload.knowledge_base_id = str(item.get("external_parent_id") or knowledge_base_id)
        upload.task_id = str(item.get("metadata", {}).get("task_id") or "")
        source_path = item.get("source_url") or f"/api/uploads/{upload.external_upload_id}"
        reference, _ = ResearchExternalReference.objects.update_or_create(
            workspace=workspace,
            system="RAGPORTAL",
            external_type=ResearchExternalReference.ExternalType.KNOWLEDGE_ENTRY,
            external_id=upload.knowledge_id,
            defaults={
                "external_parent_id": upload.knowledge_base_id,
                "title": item.get("title") or file_name,
                "summary": item.get("summary") or "",
                "source_url": (
                    f"{connection.base_url.rstrip('/')}{source_path}"
                    if source_path.startswith("/")
                    else source_path
                ),
                "acl_hint": {
                    "workspace": workspace.slug,
                    "research_project_id": str(chain.project_id),
                    "chain_id": str(chain.id),
                    "chain_node_id": str(node.id),
                },
                "metadata": {
                    **upload.metadata,
                    "upload_id": upload.external_upload_id,
                    "task_id": upload.task_id,
                    "parse_status": raw_status,
                },
                "content_hash": file_hash,
                "synced_at": timezone.now(),
                "status": ResearchExternalReference.Status.ACTIVE,
            },
        )
        upload.reference = reference
        upload.save()
        event = _append_event(
            chain=chain,
            node=node,
            request=request,
            event_type="DATA_CHANGE",
            summary=f"Uploaded research file: {file_name}",
            refs=[{"kind": "knowledge", "id": upload.knowledge_id, "version": 1}],
            metadata={"upload_id": str(upload.id), "kb_id": upload.knowledge_base_id, "sha256": file_hash},
            request_id=request_id,
            digest=digest,
        )
        if event is None:
            return conflict_response()
        return Response(
            {"data": ResearchChainUploadSerializer(upload).data, "degraded": False},
            status=status.HTTP_201_CREATED if created else status.HTTP_200_OK,
        )


class ResearchChainUploadDetailEndpoint(ResearchAPIView):
    """``GET /chains/<chain_id>/uploads/<upload_id>/`` and refresh status."""

    nav_capability = NAV_RESEARCH_CHAIN

    def get(self, request, slug, chain_id, upload_id):
        workspace, error = self.get_workspace(section="research_chain")
        if error:
            return error
        chain = _visible_chain(workspace, request.user, chain_id)
        if chain is None:
            return research_not_found(ResearchErrorCode.CHAIN_NOT_FOUND, "Research chain not found.")
        try:
            upload = chain.uploads.get(pk=UUID(str(upload_id)))
        except (ResearchChainUpload.DoesNotExist, TypeError, ValueError):
            return research_not_found(ResearchErrorCode.CHAIN_NOT_FOUND, "Research upload not found.")
        client, _connection = _rag_client(workspace)
        result = client.upload_detail(upload.external_upload_id, request=request)
        degraded = bool(result.degraded)
        if not degraded and result.items:
            item = result.items[0]
            raw_status = str(item.get("metadata", {}).get("parse_status") or "").lower()
            previous = upload.status
            upload.status = UPLOAD_STATUS_MAP.get(raw_status, upload.status)
            upload.error_code = "" if raw_status != "failed" else "parse_failed"
            upload.save(update_fields=["status", "error_code", "updated_at"])
            if upload.status != previous:
                request_id = f"upload-status-{upload.id}-{upload.status.lower()}"
                digest = payload_hash({"upload": str(upload.id), "status": upload.status})
                _append_event(
                    chain=chain,
                    node=upload.node,
                    request=request,
                    event_type="DATA_CHANGE",
                    summary=f"Upload status: {upload.status}",
                    refs=[{"kind": "upload", "id": str(upload.id)}],
                    metadata={"status": upload.status},
                    request_id=request_id,
                    digest=digest,
                )
        elif degraded:
            upload.status = ResearchChainUpload.Status.DEGRADED
            upload.error_code = result.degraded_reason
            upload.save(update_fields=["status", "error_code", "updated_at"])
        payload = ResearchChainUploadSerializer(upload).data
        return Response(
            {
                "data": payload,
                "degraded": degraded,
                **({"degraded_reason": result.degraded_reason} if degraded else {}),
            },
            status=status.HTTP_200_OK,
        )


class ResearchChainReferenceEndpoint(ResearchAPIView):
    """``POST /chains/<chain_id>/references/`` after a human confirms a citation."""

    nav_capability = NAV_RESEARCH_CHAIN

    def post(self, request, slug, chain_id):
        workspace, error = self.get_workspace(section="research_chain")
        if error:
            return error
        chain = _visible_chain(workspace, request.user, chain_id)
        if chain is None:
            return research_not_found(ResearchErrorCode.CHAIN_NOT_FOUND, "Research chain not found.")
        readonly_error = _chain_readonly_error(chain)
        if readonly_error:
            return readonly_error
        node = chain.nodes.filter(pk=request.data.get("node_id")).first()
        if node is None:
            return research_error(
                ResearchErrorCode.CHAIN_INVALID,
                "node_id must identify a node in this chain.",
                status.HTTP_422_UNPROCESSABLE_ENTITY,
            )
        request_id = request_id_from(request)
        knowledge_id = str(request.data.get("knowledge_id") or "").strip()
        knowledge_base_id = str(request.data.get("kb_id") or "").strip()
        if not request_id or not knowledge_id or not knowledge_base_id:
            return research_error(
                ResearchErrorCode.EXTERNAL_REFERENCE_INVALID,
                "request_id, knowledge_id and kb_id are required.",
            )
        digest = payload_hash(request.data)
        existing_event = ResearchChainEvent.objects.filter(request_id=request_id).first()
        if existing_event is not None:
            if existing_event.content_hash != digest:
                return conflict_response()
            return Response({"idempotent": True, "event_id": existing_event.event_id}, status=status.HTTP_200_OK)
        reference = ResearchExternalReference.objects.filter(
            workspace=workspace,
            system="RAGPORTAL",
            external_type=ResearchExternalReference.ExternalType.KNOWLEDGE_ENTRY,
            external_id=knowledge_id,
        ).first()
        if reference is not None:
            reference_chain = str((reference.metadata or {}).get("chain_id") or "")
            if reference_chain and reference_chain != str(chain.id):
                return research_error(
                    ResearchErrorCode.CHAIN_ACCESS_DENIED,
                    "The knowledge entry belongs to another research chain.",
                    status.HTTP_403_FORBIDDEN,
                )
        else:
            client, connection = _rag_client(workspace)
            base_url = connection.base_url.rstrip("/") if connection else ""
            source_url = str(request.data.get("source_url") or f"{base_url}/api/kb/{knowledge_id}")
            reference = ResearchExternalReference.objects.create(
                workspace=workspace,
                system="RAGPORTAL",
                external_type=ResearchExternalReference.ExternalType.KNOWLEDGE_ENTRY,
                external_id=knowledge_id,
                external_parent_id=knowledge_base_id,
                title=str(request.data.get("title") or knowledge_id),
                summary=str(request.data.get("summary") or ""),
                source_url=source_url,
                acl_hint={
                    "workspace": workspace.slug,
                    "research_project_id": str(chain.project_id),
                    "chain_id": str(chain.id),
                    "chain_node_id": str(node.id),
                },
                metadata={
                    "chain_id": str(chain.id),
                    "chain_node_id": str(node.id),
                    "source_version": request.data.get("source_version") or 1,
                },
                content_hash=str(request.data.get("content_hash") or ""),
                synced_at=timezone.now(),
                status=ResearchExternalReference.Status.ACTIVE,
                created_by=request.user,
            )
        event = _append_event(
            chain=chain,
            node=node,
            request=request,
            event_type="ARTIFACT_CREATED",
            summary=str(request.data.get("summary") or "Confirmed knowledge reference"),
            refs=[{"kind": "knowledge", "id": knowledge_id, "version": request.data.get("source_version") or 1}],
            metadata={
                "query": str(request.data.get("query") or ""),
                "knowledge_base_ids": request.data.get("knowledge_base_ids") or [knowledge_base_id],
                "reference_id": str(reference.id),
            },
            request_id=request_id,
            digest=digest,
        )
        if event is None:
            return conflict_response()
        payload = ResearchExternalReferenceSerializer(reference).data
        payload["event_id"] = event.event_id
        return Response(payload, status=status.HTTP_201_CREATED)
