# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Research paper review API."""

from uuid import uuid4

from rest_framework import status
from rest_framework.response import Response

from plane.db.models import FileAsset, ResearchPaperReview
from plane.research.serializers import (
    ResearchPaperReviewPresignSerializer,
    ResearchPaperReviewSerializer,
    ResearchPaperReviewVersionSerializer,
)
from plane.research.services.idempotency import payload_hash, request_id_from
from plane.research.services.paper_review import (
    PAPER_ASSET_ENTITY,
    PaperReviewConflictError,
    PaperReviewPermissionError,
    PaperReviewStateError,
    PaperReviewValidationError,
    accept_paper_version,
    actor_can_submit_paper,
    create_paper_review,
    paper_file_error,
    return_paper_version,
    submit_paper_version,
    withdraw_paper_review,
)
from plane.research.utils.capabilities import NAV_RESEARCH_CHAIN
from plane.research.utils.errors import ResearchErrorCode, research_error, research_not_found
from plane.research.utils.settings import get_workspace_research_settings
from plane.research.views.base import ResearchAPIView
from plane.research.views.chain_foundation import _envelope, _flag_enabled, _visible_chain
from plane.settings.storage import S3Storage
from plane.utils.path_validator import sanitize_filename

PAPER_REVIEW_SCHEMA_VERSION = "research-paper-review.v1"
PAPER_VERSION_SCHEMA_VERSION = "research-paper-review-version.v1"


def _error_response(exception):
    """Convert a domain paper exception into the research error envelope."""
    if isinstance(exception, PaperReviewPermissionError):
        return research_error(ResearchErrorCode.PERMISSION_DENIED, str(exception), status.HTTP_403_FORBIDDEN)
    if isinstance(exception, PaperReviewStateError):
        return research_error(ResearchErrorCode.INVALID_TRANSITION, str(exception), status.HTTP_409_CONFLICT)
    if isinstance(exception, PaperReviewConflictError):
        return research_error(ResearchErrorCode.IDEMPOTENCY_CONFLICT, str(exception), status.HTTP_409_CONFLICT)
    error_code = getattr(exception, "error_code", ResearchErrorCode.CHAIN_INVALID)
    return research_error(error_code, str(exception), status.HTTP_422_UNPROCESSABLE_ENTITY)


def _serializer_error(serializer):
    """Return the first serializer message without leaking field internals."""
    field, errors = next(serializer.errors.items())
    message = errors[0] if isinstance(errors, list) else str(errors)
    return research_error(
        ResearchErrorCode.CHAIN_INVALID,
        f"{field}: {message}" if field != "non_field_errors" else str(message),
        status.HTTP_422_UNPROCESSABLE_ENTITY,
    )


def _node_context(view, request, slug, chain_id, node_id):
    """Resolve a visible workspace, chain, and paper node."""
    workspace, error = view.get_workspace(section="research_chain")
    if error:
        return None, None, None, error
    if not _flag_enabled(workspace):
        return (
            None,
            None,
            None,
            research_error(
                ResearchErrorCode.RESEARCH_DISABLED,
                "Research Chain is disabled for this workspace.",
                status.HTTP_404_NOT_FOUND,
            ),
        )
    chain = _visible_chain(workspace, request.user, chain_id)
    if chain is None:
        return None, None, None, research_not_found(ResearchErrorCode.CHAIN_NOT_FOUND, "Research chain not found.")
    node = chain.nodes.filter(pk=node_id).first()
    if node is None:
        return None, None, None, research_not_found(ResearchErrorCode.CHAIN_NOT_FOUND, "Research node not found.")
    return workspace, chain, node, None


def _review_context(view, request, slug, review_id):
    """Resolve one visible paper review in the workspace."""
    workspace, error = view.get_workspace(section="research_chain")
    if error:
        return None, None, error
    if not _flag_enabled(workspace):
        return (
            None,
            None,
            research_error(
                ResearchErrorCode.RESEARCH_DISABLED,
                "Research Chain is disabled for this workspace.",
                status.HTTP_404_NOT_FOUND,
            ),
        )
    review = (
        ResearchPaperReview.objects.filter(workspace=workspace, pk=review_id)
        .select_related(
            "workspace",
            "chain__project__research_profile",
            "chain",
            "node",
            "owner",
            "final_reviewer",
        )
        .first()
    )
    if review is None or _visible_chain(workspace, request.user, review.chain_id) is None:
        return None, None, research_not_found(ResearchErrorCode.CHAIN_NOT_FOUND, "Research paper review not found.")
    return workspace, review, None


def _version_context(review, version_no):
    """Resolve one immutable version attached to a review."""
    version = (
        review.versions.select_related(
            "review__workspace",
            "review__chain__project__research_profile",
            "review__chain",
            "review__node",
            "asset",
            "submitted_by",
        )
        .filter(version_no=version_no)
        .first()
    )
    if version is None:
        return None, research_not_found(ResearchErrorCode.CHAIN_NOT_FOUND, "Research paper version not found.")
    return version, None


def _payload_with_request_id(request, request_id):
    """Merge the request body with its required idempotency key."""
    payload = request.data.dict() if hasattr(request.data, "dict") else dict(request.data or {})
    payload["request_id"] = request_id
    return payload


class ResearchPaperReviewListCreateEndpoint(ResearchAPIView):
    """List and open paper reviews on one Research Chain node."""

    nav_capability = NAV_RESEARCH_CHAIN

    def get(self, request, slug, chain_id, node_id):
        workspace, chain, node, error = _node_context(self, request, slug, chain_id, node_id)
        if error:
            return error
        reviews = node.paper_reviews.select_related(
            "workspace",
            "chain",
            "node",
            "owner",
            "final_reviewer",
        ).order_by("-created_at")
        status_filter = str(request.GET.get("status") or "").upper()
        if status_filter:
            if status_filter not in ResearchPaperReview.Status.values:
                return research_error(
                    ResearchErrorCode.CHAIN_INVALID,
                    "status is not a supported paper review status.",
                    status.HTTP_422_UNPROCESSABLE_ENTITY,
                )
            reviews = reviews.filter(status=status_filter)
        return Response(
            _envelope(
                data=ResearchPaperReviewSerializer(reviews, many=True, context={"request": request}).data,
                request_id=request_id_from(request),
                schema_version=PAPER_REVIEW_SCHEMA_VERSION,
            )
        )

    def post(self, request, slug, chain_id, node_id):
        workspace, chain, node, error = _node_context(self, request, slug, chain_id, node_id)
        if error:
            return error
        request_id = request_id_from(request)
        if not request_id:
            return research_error(ResearchErrorCode.IDEMPOTENCY_CONFLICT, "request_id is required.")
        serializer = ResearchPaperReviewSerializer(data=request.data, context={"request": request})
        if not serializer.is_valid():
            return _serializer_error(serializer)
        payload = {**serializer.validated_data, "request_id": request_id}
        try:
            review, created = create_paper_review(
                workspace=workspace,
                chain=chain,
                node=node,
                actor=request.user,
                payload=payload,
                request=request,
            )
        except (
            PaperReviewPermissionError,
            PaperReviewStateError,
            PaperReviewConflictError,
            PaperReviewValidationError,
        ) as exception:
            return _error_response(exception)
        return Response(
            _envelope(
                data=ResearchPaperReviewSerializer(review, context={"request": request}).data,
                request_id=request_id,
                schema_version=PAPER_REVIEW_SCHEMA_VERSION,
            ),
            status=status.HTTP_201_CREATED if created else status.HTTP_200_OK,
        )


class ResearchPaperReviewDetailEndpoint(ResearchAPIView):
    """Read one paper review with its immutable version history."""

    nav_capability = NAV_RESEARCH_CHAIN

    def get(self, request, slug, review_id):
        _workspace, review, error = _review_context(self, request, slug, review_id)
        if error:
            return error
        return Response(
            _envelope(
                data=ResearchPaperReviewSerializer(
                    review,
                    context={"request": request, "include_versions": True},
                ).data,
                request_id=request_id_from(request),
                schema_version=PAPER_REVIEW_SCHEMA_VERSION,
            )
        )


class ResearchPaperReviewVersionListCreateEndpoint(ResearchAPIView):
    """List versions or submit the next immutable version."""

    nav_capability = NAV_RESEARCH_CHAIN

    def get(self, request, slug, review_id):
        _workspace, review, error = _review_context(self, request, slug, review_id)
        if error:
            return error
        versions = review.versions.select_related("asset", "submitted_by").all()
        return Response(
            _envelope(
                data=ResearchPaperReviewVersionSerializer(versions, many=True, context={"request": request}).data,
                request_id=request_id_from(request),
                schema_version=PAPER_VERSION_SCHEMA_VERSION,
            )
        )

    def post(self, request, slug, review_id):
        _workspace, review, error = _review_context(self, request, slug, review_id)
        if error:
            return error
        request_id = request_id_from(request)
        if not request_id:
            return research_error(ResearchErrorCode.IDEMPOTENCY_CONFLICT, "request_id is required.")
        if not str(request.data.get("asset_id") or "").strip():
            return research_error(
                ResearchErrorCode.CHAIN_INVALID,
                "asset_id is required: upload the paper first with presign.",
                status.HTTP_422_UNPROCESSABLE_ENTITY,
            )
        payload = _payload_with_request_id(request, request_id)
        try:
            version, created = submit_paper_version(
                review=review,
                actor=request.user,
                payload=payload,
                request=request,
            )
        except (
            PaperReviewPermissionError,
            PaperReviewStateError,
            PaperReviewConflictError,
            PaperReviewValidationError,
        ) as exception:
            return _error_response(exception)
        return Response(
            _envelope(
                data=ResearchPaperReviewVersionSerializer(version, context={"request": request}).data,
                request_id=request_id,
                schema_version=PAPER_VERSION_SCHEMA_VERSION,
            ),
            status=status.HTTP_201_CREATED if created else status.HTTP_200_OK,
        )


class ResearchPaperReviewVersionDetailEndpoint(ResearchAPIView):
    """Read one immutable paper version."""

    nav_capability = NAV_RESEARCH_CHAIN

    def get(self, request, slug, review_id, version_no):
        _workspace, review, error = _review_context(self, request, slug, review_id)
        if error:
            return error
        version, error = _version_context(review, version_no)
        if error:
            return error
        return Response(
            _envelope(
                data=ResearchPaperReviewVersionSerializer(version, context={"request": request}).data,
                request_id=request_id_from(request),
                schema_version=PAPER_VERSION_SCHEMA_VERSION,
            )
        )


class ResearchPaperReviewVersionActionEndpoint(ResearchAPIView):
    """Return or accept the latest submitted paper version."""

    nav_capability = NAV_RESEARCH_CHAIN

    ACTIONS = {"return": return_paper_version, "accept": accept_paper_version}

    def post(self, request, slug, review_id, version_no, action):
        if action not in self.ACTIONS:
            return research_error(
                ResearchErrorCode.CHAIN_INVALID,
                "Unsupported paper review action.",
                status.HTTP_404_NOT_FOUND,
            )
        _workspace, review, error = _review_context(self, request, slug, review_id)
        if error:
            return error
        version, error = _version_context(review, version_no)
        if error:
            return error
        request_id = request_id_from(request)
        if not request_id:
            return research_error(ResearchErrorCode.IDEMPOTENCY_CONFLICT, "request_id is required.")
        payload = _payload_with_request_id(request, request_id)
        try:
            updated_review, updated_version, _changed = self.ACTIONS[action](
                review=review,
                version=version,
                actor=request.user,
                comment=request.data.get("comment"),
                request_id=request_id,
                content_hash=payload_hash(payload),
                request=request,
            )
        except (
            PaperReviewPermissionError,
            PaperReviewStateError,
            PaperReviewConflictError,
            PaperReviewValidationError,
        ) as exception:
            return _error_response(exception)
        updated_version.review = updated_review
        return Response(
            _envelope(
                data=ResearchPaperReviewVersionSerializer(
                    updated_version,
                    context={"request": request, "review": updated_review},
                ).data,
                request_id=request_id,
                schema_version=PAPER_VERSION_SCHEMA_VERSION,
            )
        )


class ResearchPaperReviewWithdrawEndpoint(ResearchAPIView):
    """Withdraw a paper review before acceptance."""

    nav_capability = NAV_RESEARCH_CHAIN

    def post(self, request, slug, review_id):
        _workspace, review, error = _review_context(self, request, slug, review_id)
        if error:
            return error
        request_id = request_id_from(request)
        if not request_id:
            return research_error(ResearchErrorCode.IDEMPOTENCY_CONFLICT, "request_id is required.")
        payload = _payload_with_request_id(request, request_id)
        try:
            updated_review, _changed = withdraw_paper_review(
                review=review,
                actor=request.user,
                reason=request.data.get("reason"),
                request_id=request_id,
                content_hash=payload_hash(payload),
                request=request,
            )
        except (
            PaperReviewPermissionError,
            PaperReviewStateError,
            PaperReviewConflictError,
            PaperReviewValidationError,
        ) as exception:
            return _error_response(exception)
        return Response(
            _envelope(
                data=ResearchPaperReviewSerializer(updated_review, context={"request": request}).data,
                request_id=request_id,
                schema_version=PAPER_REVIEW_SCHEMA_VERSION,
            )
        )


class ResearchPaperReviewPresignEndpoint(ResearchAPIView):
    """Create a direct-to-S3 upload slot for one paper version."""

    nav_capability = NAV_RESEARCH_CHAIN

    def post(self, request, slug, review_id):
        _workspace, review, error = _review_context(self, request, slug, review_id)
        if error:
            return error
        serializer = ResearchPaperReviewPresignSerializer(data=request.data)
        if not serializer.is_valid():
            return _serializer_error(serializer)
        if not actor_can_submit_paper(review.workspace, review, request.user):
            return research_error(
                ResearchErrorCode.PERMISSION_DENIED,
                "Only the review owner or chain writers can upload paper versions.",
                status.HTTP_403_FORBIDDEN,
            )
        if review.status not in (
            ResearchPaperReview.Status.OPEN,
            ResearchPaperReview.Status.NEEDS_REVISION,
        ):
            return research_error(
                ResearchErrorCode.INVALID_TRANSITION,
                f"UPLOAD is not allowed from {review.status}.",
                status.HTTP_409_CONFLICT,
            )

        file_name = str(serializer.validated_data["file_name"])
        content_type = str(serializer.validated_data["content_type"])
        size = int(serializer.validated_data["size"])
        error_code = paper_file_error(
            file_name,
            content_type,
            size,
            get_workspace_research_settings(review.workspace),
        )
        if error_code:
            return research_error(error_code, "This paper file is not allowed.", status.HTTP_422_UNPROCESSABLE_ENTITY)

        safe_name = sanitize_filename(file_name) or "paper"
        asset_key = f"{review.workspace_id}/research/paper-reviews/{review.id}/{uuid4().hex}-{safe_name}"
        presigned = S3Storage(request=request).generate_presigned_post(
            object_name=asset_key,
            file_type=content_type,
            file_size=size,
        )
        if presigned is None:
            return research_error(
                ResearchErrorCode.UPSTREAM_DEGRADED,
                "Unable to prepare the upload.",
                status.HTTP_503_SERVICE_UNAVAILABLE,
            )
        asset = FileAsset.objects.create(
            attributes={
                "name": file_name,
                "type": content_type,
                "size": size,
                "sha256": str(serializer.validated_data["sha256"]).lower(),
            },
            asset=asset_key,
            size=size,
            workspace=review.workspace,
            user=request.user,
            created_by=request.user,
            entity_type=PAPER_ASSET_ENTITY,
            entity_identifier=str(review.id),
            is_uploaded=False,
        )
        return Response(
            _envelope(
                data={
                    "asset_id": str(asset.id),
                    "upload_data": presigned,
                    "file_name": file_name,
                    "size": size,
                    "content_type": content_type,
                },
                request_id=request_id_from(request),
                schema_version=PAPER_REVIEW_SCHEMA_VERSION,
            )
        )
