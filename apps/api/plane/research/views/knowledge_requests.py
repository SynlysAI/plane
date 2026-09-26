"""Administrator workflow for manually created RAGPortal knowledge bases."""

from django.db import transaction
from django.utils import timezone
from rest_framework import status
from rest_framework.response import Response

from plane.db.models import OrgUnitMember, ResearchGroupKnowledgeBinding, ResearchKnowledgeRequest
from plane.research.services.group_knowledge import external_kb_conflicts, resolve_team_org_unit
from plane.research.utils.capabilities import NAV_RESEARCH_CHAIN
from plane.research.utils.errors import ResearchErrorCode, research_error, research_not_found
from plane.research.utils.org import active_membership_q
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
        team = resolve_team_org_unit(row.chain)
        if team is not None or row.state == ResearchKnowledgeRequest.State.ARCHIVED:
            return research_error(
                ResearchErrorCode.KB_BINDING_CONFLICT,
                "Bind the group knowledge base instead of this chain request.",
                status.HTTP_409_CONFLICT,
            )
        if row.state not in {
            ResearchKnowledgeRequest.State.PENDING_ADMIN,
            ResearchKnowledgeRequest.State.NEEDS_INFO,
            ResearchKnowledgeRequest.State.CREATED_PENDING_BINDING,
        }:
            return research_error(ResearchErrorCode.KB_BINDING_CONFLICT, "The knowledge request is not awaiting binding.", status.HTTP_409_CONFLICT)
        conflict = (
            ResearchKnowledgeRequest.objects.filter(external_kb_id=external_id, deleted_at__isnull=True)
            .exclude(pk=row.pk)
            .exists()
            or ResearchGroupKnowledgeBinding.objects.filter(external_kb_id=external_id, deleted_at__isnull=True).exists()
        )
        if conflict:
            return research_error(
                ResearchErrorCode.KB_SCOPE_CONFLICT,
                "This external knowledge base is already bound to another research team.",
                status.HTTP_409_CONFLICT,
            )
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


def _serialize_group(binding):
    """Serialize a team knowledge binding without credentials or file content.

    Args:
        binding: Group knowledge binding.

    Returns:
        JSON-ready binding metadata.
    """
    return {
        "id": str(binding.id),
        "org_unit_id": str(binding.org_unit_id),
        "org_unit_name": binding.org_unit.name,
        "workspace_id": str(binding.workspace_id),
        "state": binding.state,
        "external_kb_id": binding.external_kb_id or None,
        "external_kb_name": binding.external_kb_name or None,
        "parameter_summary": binding.parameter_summary,
        "rejection_reason": binding.rejection_reason,
        "last_error": binding.last_error,
        "processed_at": binding.processed_at,
        "scope": "GROUP",
    }


class ResearchGroupKnowledgeBindingDetailEndpoint(ResearchAPIView):
    """Read or administratively complete one team knowledge binding."""

    nav_capability = NAV_RESEARCH_CHAIN

    def _get(self, request, workspace, binding_id):
        """Load a binding the caller is allowed to see.

        Args:
            request: Current HTTP request.
            workspace: Resolved workspace.
            binding_id: Group binding id.

        Returns:
            The binding and an error response, exactly one of which is set.
        """
        row = (
            ResearchGroupKnowledgeBinding.objects.filter(pk=binding_id, workspace=workspace, deleted_at__isnull=True)
            .select_related("org_unit")
            .first()
        )
        if row is None:
            return None, research_not_found(ResearchErrorCode.KB_REQUEST_NOT_FOUND, "Knowledge request not found.")
        if is_research_admin(request.user, workspace):
            return row, None
        member = OrgUnitMember.objects.filter(
            active_membership_q(),
            workspace=workspace,
            org_unit=row.org_unit,
            user=request.user,
        ).exists()
        if not member:
            return None, research_not_found(ResearchErrorCode.KB_REQUEST_NOT_FOUND, "Knowledge request not found.")
        return row, None

    def get(self, request, slug, binding_id):
        """Return one team knowledge binding."""
        workspace, error = self.get_workspace(section="research_chain", nav=None)
        if error:
            return error
        row, error = self._get(request, workspace, binding_id)
        return error or Response(_serialize_group(row), status=status.HTTP_200_OK)

    def patch(self, request, slug, binding_id):
        """Bind one externally created WeKnora knowledge base to a team.

        Args:
            request: PATCH body with ``external_kb_id``.
            slug: Workspace slug.
            binding_id: Group binding id.

        Returns:
            The ready binding, or a conflict when the KB belongs to another team.
        """
        workspace, error = self.get_workspace(section="research_chain", nav=None)
        if error:
            return error
        row, error = self._get(request, workspace, binding_id)
        if error:
            return error
        if not is_research_admin(request.user, workspace):
            return research_error(
                ResearchErrorCode.PERMISSION_DENIED,
                "Only research administrators can bind a knowledge base.",
                status.HTTP_403_FORBIDDEN,
            )
        external_id = str(request.data.get("external_kb_id") or "").strip()
        if not external_id:
            return research_error(
                ResearchErrorCode.KB_BINDING_CONFLICT,
                "external_kb_id is required.",
                status.HTTP_422_UNPROCESSABLE_ENTITY,
            )
        if row.state == ResearchGroupKnowledgeBinding.State.READY and row.external_kb_id == external_id:
            return Response(_serialize_group(row), status=status.HTTP_200_OK)
        if row.state not in {
            ResearchGroupKnowledgeBinding.State.PENDING_ADMIN,
            ResearchGroupKnowledgeBinding.State.NEEDS_INFO,
            ResearchGroupKnowledgeBinding.State.CREATED_PENDING_BINDING,
        }:
            return research_error(
                ResearchErrorCode.KB_BINDING_CONFLICT,
                "The knowledge request is not awaiting binding.",
                status.HTTP_409_CONFLICT,
            )
        if external_kb_conflicts(external_id, row.org_unit):
            return research_error(
                ResearchErrorCode.KB_SCOPE_CONFLICT,
                "This external knowledge base is already bound to another research team.",
                status.HTTP_409_CONFLICT,
            )
        with transaction.atomic():
            row.external_kb_id = external_id
            row.external_kb_name = str(request.data.get("external_kb_name") or external_id).strip()
            row.parameter_summary = dict(request.data.get("parameter_summary") or {})
            row.state = ResearchGroupKnowledgeBinding.State.READY
            row.processed_by = request.user
            row.processed_at = timezone.now()
            row.last_error = ""
            row.save(
                update_fields=[
                    "external_kb_id",
                    "external_kb_name",
                    "parameter_summary",
                    "state",
                    "processed_by",
                    "processed_at",
                    "last_error",
                    "updated_at",
                ]
            )
        return Response(_serialize_group(row), status=status.HTTP_200_OK)
