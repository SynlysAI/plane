"""Administrator workflow for manually created RAGPortal knowledge bases."""

from django.db import transaction
from django.utils import timezone
from rest_framework import status
from rest_framework.response import Response

from plane.db.models import ResearchKnowledgeRequest
from plane.research.utils.errors import ResearchErrorCode, research_error, research_not_found
from plane.research.utils.capabilities import NAV_RESEARCH_CHAIN
from plane.research.utils.roles import is_research_admin
from plane.research.views.base import ResearchAPIView


def _serialize(request):
    """Serialize request metadata without exposing credentials or file content."""
    return {
        "id": str(request.id),
        "chain_id": str(request.chain_id),
        "workspace_id": str(request.workspace_id),
        "state": request.state,
        "external_kb_id": request.external_kb_id or None,
        "external_kb_name": request.external_kb_name or None,
        "parameter_summary": request.parameter_summary,
        "rejection_reason": request.rejection_reason,
        "last_error": request.last_error,
        "processed_at": request.processed_at,
    }


class ResearchKnowledgeRequestDetailEndpoint(ResearchAPIView):
    """Read or administratively complete one Chain knowledge request."""

    nav_capability = NAV_RESEARCH_CHAIN

    def _get(self, request, workspace, request_id):
        row = ResearchKnowledgeRequest.objects.filter(pk=request_id, workspace=workspace, deleted_at__isnull=True).select_related("chain").first()
        if row is None:
            return None, research_not_found(ResearchErrorCode.KB_REQUEST_NOT_FOUND, "Knowledge request not found.")
        if not is_research_admin(request.user, workspace) and row.chain.owner_id != request.user.id:
            return None, research_not_found(ResearchErrorCode.KB_REQUEST_NOT_FOUND, "Knowledge request not found.")
        return row, None

    def get(self, request, slug, request_id):
        workspace, error = self.get_workspace(section="research_chain", nav=None)
        if error:
            return error
        row, error = self._get(request, workspace, request_id)
        return error or Response(_serialize(row), status=status.HTTP_200_OK)

    def patch(self, request, slug, request_id):
        workspace, error = self.get_workspace(section="research_chain", nav=None)
        if error:
            return error
        row, error = self._get(request, workspace, request_id)
        if error:
            return error
        if not is_research_admin(request.user, workspace):
            return research_error(ResearchErrorCode.PERMISSION_DENIED, "Only research administrators can bind a knowledge base.", status.HTTP_403_FORBIDDEN)
        external_id = str(request.data.get("external_kb_id") or "").strip()
        if not external_id:
            return research_error(ResearchErrorCode.KB_BINDING_CONFLICT, "external_kb_id is required.", status.HTTP_422_UNPROCESSABLE_ENTITY)
        if row.state == ResearchKnowledgeRequest.State.READY and row.external_kb_id == external_id:
            return Response(_serialize(row), status=status.HTTP_200_OK)
        if row.state not in {
            ResearchKnowledgeRequest.State.PENDING_ADMIN,
            ResearchKnowledgeRequest.State.NEEDS_INFO,
            ResearchKnowledgeRequest.State.CREATED_PENDING_BINDING,
        }:
            return research_error(ResearchErrorCode.KB_BINDING_CONFLICT, "The knowledge request is not awaiting binding.", status.HTTP_409_CONFLICT)
        conflict = ResearchKnowledgeRequest.objects.filter(external_kb_id=external_id, deleted_at__isnull=True).exclude(pk=row.pk).exists()
        if conflict:
            return research_error(ResearchErrorCode.KB_SCOPE_CONFLICT, "This external knowledge base is already bound to another research chain.", status.HTTP_409_CONFLICT)
        with transaction.atomic():
            row.external_kb_id = external_id
            row.external_kb_name = str(request.data.get("external_kb_name") or external_id).strip()
            row.parameter_summary = dict(request.data.get("parameter_summary") or {})
            row.state = ResearchKnowledgeRequest.State.READY
            row.processed_by = request.user
            row.processed_at = timezone.now()
            row.last_error = ""
            row.save(update_fields=["external_kb_id", "external_kb_name", "parameter_summary", "state", "processed_by", "processed_at", "last_error", "updated_at"])
        return Response(_serialize(row), status=status.HTTP_200_OK)
