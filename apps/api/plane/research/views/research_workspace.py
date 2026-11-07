"""RWS-1 StudyWorkspace control-plane API."""

from uuid import UUID

from rest_framework import status
from rest_framework.response import Response

from plane.db.models import ProjectMember, ResearchChain, StudyWorkspace, WorkspaceMember, WorkspaceOperation
from plane.research.serializers.research_workspace import (
    StudyWorkspaceSerializer,
    WorkspaceOperationSerializer,
    WorkspaceResourceReferenceSerializer,
)
from plane.research.services.idempotency import request_id_from
from plane.research.services.workspaces.control_plane import WorkspaceIdempotencyConflict, ensure_study_workspace
from plane.research.services.workspaces.resource_refs import register_resource_reference
from plane.research.utils.errors import ResearchErrorCode, research_error, research_not_found
from plane.research.utils.settings import get_workspace_research_settings, workspace_research_enabled
from plane.research.views.base import ResearchAPIView
from plane.research.views.projects import can_read_project_research_metadata


def _envelope(data, request_id, schema_version="study-workspace.v1"):
    """Build the stable RWS success envelope.

    Args:
        data: Serialized response payload.
        request_id: Request idempotency key, when supplied.
        schema_version: Stable response contract version.

    Returns:
        The DRF response envelope dictionary.
    """
    return {
        "success": True,
        "data": data,
        "error": None,
        "request_id": request_id,
        "schema_version": schema_version,
    }


def _rws_disabled():
    """Return the non-probing denial used when either feature gate is off."""
    return research_error(
        ResearchErrorCode.STUDY_WORKSPACE_DISABLED,
        "Study Workspace is disabled.",
        status.HTTP_404_NOT_FOUND,
    )


def _workspace_enabled(workspace):
    """Return the explicit workspace-level RWS gate."""
    return bool(
        workspace_research_enabled(workspace)
        and get_workspace_research_settings(workspace).get("study_workspace_enabled", False)
    )


def _as_uuid(value):
    """Convert a caller identifier to UUID without relying on ORM exceptions.

    Args:
        value: Raw path or body value.

    Returns:
        A UUID, or ``None`` for an absent/invalid identifier.
    """
    try:
        return UUID(str(value))
    except (TypeError, ValueError):
        return None


def _visible_chain(workspace, user, chain_id):
    """Resolve a chain only through the existing project research ACL."""
    chain_uuid = _as_uuid(chain_id)
    if chain_uuid is None:
        return None
    chain = (
        ResearchChain.objects.filter(
            pk=chain_uuid,
            workspace=workspace,
            deleted_at__isnull=True,
            project__deleted_at__isnull=True,
            project__research_profile__deleted_at__isnull=True,
        )
        .select_related("workspace", "project__research_profile__org_unit", "owner")
        .first()
    )
    if chain is None or not can_read_project_research_metadata(workspace, user, chain.project.research_profile):
        return None
    return chain


def _can_manage_chain(workspace, user, chain):
    """Require chain ownership or an explicit administrative project role."""
    return bool(
        user.id in {workspace.owner_id, chain.owner_id}
        or WorkspaceMember.objects.filter(
            workspace=workspace,
            member=user,
            role=20,
            is_active=True,
            deleted_at__isnull=True,
        ).exists()
        or ProjectMember.objects.filter(
            project=chain.project,
            member=user,
            role__gte=15,
            is_active=True,
            deleted_at__isnull=True,
        ).exists()
    )


def _visible_study(workspace, user, study_id):
    """Resolve a StudyWorkspace without leaking inaccessible study existence."""
    study = (
        StudyWorkspace.objects.filter(
            pk=study_id,
            workspace=workspace,
            deleted_at__isnull=True,
            chain__deleted_at__isnull=True,
            chain__project__deleted_at__isnull=True,
        )
        .select_related("workspace", "chain__project__research_profile__org_unit", "chain__owner")
        .first()
    )
    if study is None or not can_read_project_research_metadata(workspace, user, study.chain.project.research_profile):
        return None
    return study


class StudyWorkspaceEnsureEndpoint(ResearchAPIView):
    """Create or idempotently return one StudyWorkspace per ResearchChain."""

    def post(self, request, slug):
        workspace, error = self.get_workspace(section="research_chain", nav=None)
        if error:
            return error
        if not _workspace_enabled(workspace):
            return _rws_disabled()
        request_id = request_id_from(request)
        if not request_id:
            return research_error(ResearchErrorCode.IDEMPOTENCY_CONFLICT, "request_id is required.")
        chain = _visible_chain(workspace, request.user, request.data.get("chain_id"))
        if chain is None or not _can_manage_chain(workspace, request.user, chain):
            return research_not_found(ResearchErrorCode.CHAIN_NOT_FOUND, "Research chain not found.")
        try:
            result = ensure_study_workspace(workspace, chain, request.user, request_id, request.data)
        except WorkspaceIdempotencyConflict:
            return research_error(
                ResearchErrorCode.RWS_IDEMPOTENCY_CONFLICT,
                "The request id was already used with another payload.",
                status.HTTP_409_CONFLICT,
            )
        return Response(
            _envelope(StudyWorkspaceSerializer(result.study).data, request_id),
            status=status.HTTP_201_CREATED if result.created else status.HTTP_200_OK,
        )


class StudyWorkspaceDetailEndpoint(ResearchAPIView):
    """Read one visible and enabled StudyWorkspace."""

    def get(self, request, slug, study_id):
        workspace, error = self.get_workspace(section="research_chain", nav=None)
        if error:
            return error
        if not _workspace_enabled(workspace):
            return _rws_disabled()
        study = _visible_study(workspace, request.user, study_id)
        if study is None:
            return research_not_found(
                ResearchErrorCode.STUDY_WORKSPACE_NOT_FOUND,
                "Study Workspace not found.",
            )
        if not study.is_enabled:
            return _rws_disabled()
        return Response(_envelope(StudyWorkspaceSerializer(study).data, request_id_from(request)))


class StudyWorkspaceResourceReferenceEndpoint(ResearchAPIView):
    """List and idempotently register immutable fixed resource references."""

    def get(self, request, slug, study_id):
        workspace, error = self.get_workspace(section="research_chain", nav=None)
        if error:
            return error
        if not _workspace_enabled(workspace):
            return _rws_disabled()
        study = _visible_study(workspace, request.user, study_id)
        if study is None:
            return research_not_found(
                ResearchErrorCode.STUDY_WORKSPACE_NOT_FOUND,
                "Study Workspace not found.",
            )
        if not study.is_enabled:
            return _rws_disabled()
        references = study.resource_references.all().order_by("-created_at")
        data = WorkspaceResourceReferenceSerializer(references, many=True).data
        return Response(_envelope(data, request_id_from(request), "research-resource-ref.v1"))

    def post(self, request, slug, study_id):
        workspace, error = self.get_workspace(section="research_chain", nav=None)
        if error:
            return error
        if not _workspace_enabled(workspace):
            return _rws_disabled()
        study = _visible_study(workspace, request.user, study_id)
        if study is None or not _can_manage_chain(workspace, request.user, study.chain):
            return research_not_found(
                ResearchErrorCode.STUDY_WORKSPACE_NOT_FOUND,
                "Study Workspace not found.",
            )
        if not study.is_enabled:
            return _rws_disabled()
        request_id = request_id_from(request)
        if not request_id:
            return research_error(ResearchErrorCode.IDEMPOTENCY_CONFLICT, "request_id is required.")
        serializer = WorkspaceResourceReferenceSerializer(data=request.data, context={"study": study})
        if not serializer.is_valid():
            return research_error(
                ResearchErrorCode.RWS_RESOURCE_REF_INVALID,
                "The resource reference does not match research-resource-ref.v1.",
                status.HTTP_422_UNPROCESSABLE_ENTITY,
            )
        try:
            result = register_resource_reference(study, request.user, request_id, serializer.validated_data)
        except WorkspaceIdempotencyConflict:
            return research_error(
                ResearchErrorCode.RWS_IDEMPOTENCY_CONFLICT,
                "The request id was already used with another payload.",
                status.HTTP_409_CONFLICT,
            )
        data = WorkspaceResourceReferenceSerializer(result.reference).data
        return Response(
            _envelope(data, request_id, "research-resource-ref.v1"),
            status=status.HTTP_201_CREATED if result.created else status.HTTP_200_OK,
        )


class StudyWorkspaceResourceReferenceDetailEndpoint(ResearchAPIView):
    """Read one fixed reference by its content digest."""

    def get(self, request, slug, study_id, digest):
        workspace, error = self.get_workspace(section="research_chain", nav=None)
        if error:
            return error
        if not _workspace_enabled(workspace):
            return _rws_disabled()
        study = _visible_study(workspace, request.user, study_id)
        if study is None:
            return research_not_found(
                ResearchErrorCode.STUDY_WORKSPACE_NOT_FOUND,
                "Study Workspace not found.",
            )
        if not study.is_enabled:
            return _rws_disabled()
        reference = study.resource_references.filter(digest=digest).first()
        if reference is None:
            return research_not_found(
                ResearchErrorCode.RWS_RESOURCE_REF_INVALID,
                "Resource reference not found.",
            )
        data = WorkspaceResourceReferenceSerializer(reference).data
        return Response(_envelope(data, request_id_from(request), "research-resource-ref.v1"))


class StudyWorkspaceOperationEndpoint(ResearchAPIView):
    """Read the control-plane operation ledger for one visible study."""

    def get(self, request, slug, study_id):
        workspace, error = self.get_workspace(section="research_chain", nav=None)
        if error:
            return error
        if not _workspace_enabled(workspace):
            return _rws_disabled()
        study = _visible_study(workspace, request.user, study_id)
        if study is None:
            return research_not_found(
                ResearchErrorCode.STUDY_WORKSPACE_NOT_FOUND,
                "Study Workspace not found.",
            )
        operations = WorkspaceOperation.objects.filter(study=study).order_by("-created_at")
        data = WorkspaceOperationSerializer(operations, many=True).data
        return Response(_envelope(data, request_id_from(request)))
