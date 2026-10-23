"""Research Chain thirteen-stage approval endpoints."""

from django.db import IntegrityError
from uuid import UUID
from rest_framework import status
from rest_framework.response import Response

from plane.db.models import ResearchChainEvent, ResearchChainNode, ResearchChainStageMaterialItem
from plane.research.serializers.chain_stage import (
    ResearchChainStageMaterialItemSerializer,
    ResearchChainStagePrecheckSerializer,
    ResearchChainStageSerializer,
)
from plane.research.services.chain_stage_approvals import (
    CHAIN_STAGE_CODES,
    ChainStageRuleError,
    add_stage_material,
    create_stage_precheck,
    initialize_chain_stages,
    remove_stage_material,
    review_chain_stage,
    submit_chain_stage,
)
from plane.research.services.chain_tasks import chain_writer
from plane.research.services.idempotency import conflict_response, payload_hash, request_id_from
from plane.research.utils.capabilities import NAV_RESEARCH_CHAIN
from plane.research.utils.errors import ResearchErrorCode, research_error, research_not_found
from plane.research.views.base import ResearchAPIView, truthy
from plane.research.views.chain_foundation import (
    _chain_readonly_error,
    _disabled,
    _flag_enabled,
    _visible_chain,
)


def _envelope(data, request_id, schema_version):
    """Build the Research Chain stage approval response envelope."""
    return {"success": True, "data": data, "error": None, "request_id": request_id, "schema_version": schema_version}


def _rule_error(error: ChainStageRuleError):
    """Convert a domain rule failure to the research error contract."""
    return Response(
        {"error_code": error.error_code, "message": error.message, **error.extra},
        status=error.http_status,
    )


def _uuid_value(value, field_name):
    """Parse a JSON body UUID without leaking ORM validation errors."""
    try:
        return UUID(str(value)), None
    except (AttributeError, TypeError, ValueError):
        return None, research_error(
            ResearchErrorCode.CHAIN_INVALID,
            f"{field_name} must be a valid UUID.",
            status.HTTP_422_UNPROCESSABLE_ENTITY,
        )


def _request_id(request):
    """Read and validate the endpoint idempotency key."""
    value = request_id_from(request)
    if not value:
        return None, research_error(ResearchErrorCode.IDEMPOTENCY_CONFLICT, "request_id is required.")
    if len(value) > 128:
        return None, research_error(
            ResearchErrorCode.CHAIN_INVALID,
            "request_id must contain at most 128 characters.",
            status.HTTP_422_UNPROCESSABLE_ENTITY,
        )
    return value, None


class ResearchChainStageApprovalListEndpoint(ResearchAPIView):
    """Return the authoritative thirteen-stage approval summary."""

    nav_capability = NAV_RESEARCH_CHAIN

    def get(self, request, slug, chain_id):
        workspace, error = self.get_workspace(section="research_chain", nav=None, research_member=False)
        if error:
            return error
        if not _flag_enabled(workspace):
            return _disabled()
        chain = _visible_chain(workspace, request.user, chain_id)
        if chain is None:
            return research_not_found(ResearchErrorCode.CHAIN_NOT_FOUND, "Research chain not found.")
        initialize_chain_stages(chain)
        stages = list(
            chain.stage_approvals.filter(deleted_at__isnull=True)
            .prefetch_related(
                "material_requirements__items",
                "review_actions",
                "prechecks",
            )
            .order_by("sort_order")
        )
        counts = {
            code: 0
            for code in (
                "APPROVED",
                "AWAITING_ADVISOR",
                "AWAITING_PI",
                "NEEDS_REVISION",
                "IN_PROGRESS",
                "NOT_STARTED",
            )
        }
        for stage in stages:
            counts[stage.status] += 1
        data = {
            "chain": str(chain.id),
            "chain_status": chain.status,
            "stages": ResearchChainStageSerializer(stages, many=True, context={"actor": request.user}).data,
            "progress": {
                "total": len(stages),
                "approved": counts["APPROVED"],
                "awaiting_advisor": counts["AWAITING_ADVISOR"],
                "awaiting_pi": counts["AWAITING_PI"],
                "needs_revision": counts["NEEDS_REVISION"],
                "in_progress": counts["IN_PROGRESS"],
                "not_started": counts["NOT_STARTED"],
            },
        }
        return Response(_envelope(data, request_id_from(request), "research-chain-stage-list.v1"))


class ResearchChainStageApprovalBaseEndpoint(ResearchAPIView):
    """Shared workspace, chain, stage and writer resolution."""

    nav_capability = NAV_RESEARCH_CHAIN

    def _chain(self, request, slug, chain_id):
        workspace, error = self.get_workspace(section="research_chain", nav=None, research_member=False)
        if error:
            return None, None, error
        if not _flag_enabled(workspace):
            return None, None, _disabled()
        chain = _visible_chain(workspace, request.user, chain_id)
        if chain is None:
            return None, None, research_not_found(ResearchErrorCode.CHAIN_NOT_FOUND, "Research chain not found.")
        initialize_chain_stages(chain)
        return workspace, chain, None

    def _stage(self, chain, stage_code):
        normalized = str(stage_code or "").strip().upper()
        if normalized not in CHAIN_STAGE_CODES:
            return research_not_found(ResearchErrorCode.CHAIN_STAGE_NOT_FOUND, "Research chain stage not found.")
        stage = chain.stage_approvals.filter(stage_code=normalized, deleted_at__isnull=True).first()
        if stage is None:
            return research_not_found(ResearchErrorCode.CHAIN_STAGE_NOT_FOUND, "Research chain stage not found.")
        return stage

    def _writable(self, request, chain):
        readonly = _chain_readonly_error(chain)
        if readonly:
            return readonly
        if not chain_writer(chain.workspace, request.user, chain):
            return research_error(
                ResearchErrorCode.PERMISSION_DENIED,
                "Only chain writers can modify stage materials.",
                status.HTTP_403_FORBIDDEN,
            )
        return None


class ResearchChainStageMaterialEndpoint(ResearchChainStageApprovalBaseEndpoint):
    """Add a hard stage material item with request idempotency."""

    def post(self, request, slug, chain_id, stage_code):
        workspace, chain, error = self._chain(request, slug, chain_id)
        if error:
            return error
        stage_or_error = self._stage(chain, stage_code)
        if isinstance(stage_or_error, Response):
            return stage_or_error
        stage = stage_or_error
        request_id, request_error = _request_id(request)
        if request_error:
            return request_error
        permission_error = self._writable(request, chain)
        if permission_error:
            return permission_error
        title = str(request.data.get("title") or "").strip()
        requirement_code = str(request.data.get("requirement_code") or "").strip()
        if not title or not requirement_code:
            return research_error(
                ResearchErrorCode.CHAIN_INVALID,
                "requirement_code and title are required.",
                status.HTTP_422_UNPROCESSABLE_ENTITY,
            )
        if len(title) > 500 or len(str(request.data.get("external_reference") or "")) > 1000:
            return research_error(
                ResearchErrorCode.CHAIN_INVALID,
                "material title and external_reference exceed their length limits.",
                status.HTTP_422_UNPROCESSABLE_ENTITY,
            )
        source_node = None
        if request.data.get("source_node_id"):
            source_node_id, uuid_error = _uuid_value(request.data["source_node_id"], "source_node_id")
            if uuid_error:
                return uuid_error
            source_node = ResearchChainNode.objects.filter(
                pk=source_node_id, chain=chain, deleted_at__isnull=True
            ).first()
            if source_node is None:
                return research_error(
                    ResearchErrorCode.CHAIN_INVALID,
                    "source_node_id is not an active node in this chain.",
                    status.HTTP_422_UNPROCESSABLE_ENTITY,
                )
        existing = ResearchChainStageMaterialItem.objects.filter(request_id=request_id).first()
        if existing is not None:
            same_payload = (
                existing.stage_id == stage.id
                and existing.requirement.code == requirement_code
                and existing.title == title
                and existing.description == str(request.data.get("description") or "").strip()
                and existing.source_node_id == (source_node.id if source_node else None)
                and existing.external_reference == str(request.data.get("external_reference") or "").strip()
            )
            if not same_payload:
                return conflict_response()
            return Response(
                _envelope(
                    ResearchChainStageMaterialItemSerializer(existing).data,
                    request_id,
                    "research-chain-stage-material.v1",
                )
            )
        try:
            item = add_stage_material(
                stage,
                request.user,
                requirement_code=requirement_code,
                title=title,
                description=str(request.data.get("description") or "").strip(),
                source_node=source_node,
                external_reference=str(request.data.get("external_reference") or "").strip(),
                request_id=request_id,
            )
        except ChainStageRuleError as rule_error:
            return _rule_error(rule_error)
        return Response(
            _envelope(
                ResearchChainStageMaterialItemSerializer(item).data,
                request_id,
                "research-chain-stage-material.v1",
            ),
            status=status.HTTP_201_CREATED,
        )


class ResearchChainStageMaterialDetailEndpoint(ResearchChainStageApprovalBaseEndpoint):
    """Remove an editable stage material item."""

    def delete(self, request, slug, chain_id, stage_code, material_id):
        workspace, chain, error = self._chain(request, slug, chain_id)
        if error:
            return error
        stage_or_error = self._stage(chain, stage_code)
        if isinstance(stage_or_error, Response):
            return stage_or_error
        stage = stage_or_error
        permission_error = self._writable(request, chain)
        if permission_error:
            return permission_error
        item = ResearchChainStageMaterialItem.objects.filter(
            pk=material_id, stage=stage, deleted_at__isnull=True
        ).first()
        if item is None:
            return research_not_found(ResearchErrorCode.CHAIN_STAGE_NOT_FOUND, "Stage material item not found.")
        try:
            remove_stage_material(stage, item, request.user)
        except ChainStageRuleError as rule_error:
            return _rule_error(rule_error)
        return Response(status=status.HTTP_204_NO_CONTENT)


class ResearchChainStagePrecheckEndpoint(ResearchChainStageApprovalBaseEndpoint):
    """Generate or replay the advisory stage-three precheck."""

    def post(self, request, slug, chain_id, stage_code):
        workspace, chain, error = self._chain(request, slug, chain_id)
        if error:
            return error
        stage_or_error = self._stage(chain, stage_code)
        if isinstance(stage_or_error, Response):
            return stage_or_error
        stage = stage_or_error
        request_id, request_error = _request_id(request)
        if request_error:
            return request_error
        permission_error = self._writable(request, chain)
        if permission_error:
            return permission_error
        existing = stage.prechecks.filter(request_id=request_id).first()
        if existing is not None:
            return Response(
                _envelope(
                    ResearchChainStagePrecheckSerializer(existing).data,
                    request_id,
                    "research-chain-stage-precheck.v1",
                )
            )
        try:
            precheck = create_stage_precheck(stage, request.user, request_id=request_id)
        except ChainStageRuleError as rule_error:
            return _rule_error(rule_error)
        return Response(
            _envelope(
                ResearchChainStagePrecheckSerializer(precheck).data,
                request_id,
                "research-chain-stage-precheck.v1",
            ),
            status=status.HTTP_201_CREATED,
        )


class ResearchChainStageSubmitEndpoint(ResearchChainStageApprovalBaseEndpoint):
    """Submit one stage into the directed advisor review queue."""

    def post(self, request, slug, chain_id, stage_code):
        workspace, chain, error = self._chain(request, slug, chain_id)
        if error:
            return error
        stage_or_error = self._stage(chain, stage_code)
        if isinstance(stage_or_error, Response):
            return stage_or_error
        stage = stage_or_error
        request_id, request_error = _request_id(request)
        if request_error:
            return request_error
        permission_error = self._writable(request, chain)
        if permission_error:
            return permission_error
        digest = payload_hash(request.data)
        existing_event = ResearchChainEvent.objects.filter(
            event_id=f"{stage.stage_code}-CHAIN_STAGE_SUBMITTED-{request_id[:48]}"
        ).first()
        if existing_event is not None:
            if existing_event.metadata.get("payload_hash") != digest:
                return conflict_response()
            stage.refresh_from_db()
            return Response(
                _envelope(
                    ResearchChainStageSerializer(stage, context={"actor": request.user}).data,
                    request_id,
                    "research-chain-stage.v1",
                )
            )
        node_id, uuid_error = _uuid_value(request.data.get("node_id"), "node_id")
        if uuid_error:
            return uuid_error
        node = ResearchChainNode.objects.filter(pk=node_id, chain=chain, deleted_at__isnull=True).first()
        if node is None:
            return research_error(
                ResearchErrorCode.CHAIN_INVALID,
                "node_id must reference an active node in this chain.",
                status.HTTP_422_UNPROCESSABLE_ENTITY,
            )
        try:
            submitted = submit_chain_stage(
                stage,
                request.user,
                node=node,
                request_id=request_id,
                requires_pi=truthy(request.data.get("requires_pi")),
                escalation_reason=str(request.data.get("escalation_reason") or ""),
                request=request,
                payload_digest=digest,
            )
        except ChainStageRuleError as rule_error:
            return _rule_error(rule_error)
        return Response(
            _envelope(
                ResearchChainStageSerializer(submitted, context={"actor": request.user}).data,
                request_id,
                "research-chain-stage.v1",
            )
        )


class ResearchChainStageReviewEndpoint(ResearchChainStageApprovalBaseEndpoint):
    """Approve or return the current stage review step."""

    def post(self, request, slug, chain_id, stage_code):
        workspace, chain, error = self._chain(request, slug, chain_id)
        if error:
            return error
        stage_or_error = self._stage(chain, stage_code)
        if isinstance(stage_or_error, Response):
            return stage_or_error
        stage = stage_or_error
        request_id, request_error = _request_id(request)
        if request_error:
            return request_error
        digest = payload_hash(request.data)
        existing_action = stage.review_actions.filter(request_id=request_id).first()
        if existing_action is not None:
            if existing_action.declaration_snapshot.get("payload_hash") != digest:
                return conflict_response()
            stage.refresh_from_db()
            return Response(
                _envelope(
                    ResearchChainStageSerializer(stage, context={"actor": request.user}).data,
                    request_id,
                    "research-chain-stage.v1",
                )
            )
        try:
            reviewed = review_chain_stage(
                stage,
                request.user,
                action=request.data.get("action"),
                request_id=request_id,
                comment=str(request.data.get("comment") or ""),
                escalate_to_pi=(request.data["escalate_to_pi"] if "escalate_to_pi" in request.data else None),
                request=request,
                payload_digest=digest,
            )
        except ChainStageRuleError as rule_error:
            return _rule_error(rule_error)
        except IntegrityError:
            return conflict_response()
        return Response(
            _envelope(
                ResearchChainStageSerializer(reviewed, context={"actor": request.user}).data,
                request_id,
                "research-chain-stage.v1",
            )
        )
