"""Human-confirmed analysis results for Research Chain nodes."""

from django.db import transaction
from django.db.models import Max
from django.utils import timezone
from rest_framework import status
from rest_framework.response import Response

from plane.db.models import ResearchChain, ResearchAnalysisResult, ResearchChainEvent, ResearchChainSnapshot
from plane.research.serializers import ResearchAnalysisResultSerializer
from plane.research.services.idempotency import conflict_response, payload_hash, request_id_from
from plane.research.utils.capabilities import NAV_RESEARCH_CHAIN
from plane.research.utils.errors import ResearchErrorCode, research_error, research_not_found
from plane.research.views.base import ResearchAPIView
from plane.research.views.chain_foundation import _chain_readonly_error, _visible_chain, _node_operator


class ResearchChainAnalysisListCreateEndpoint(ResearchAPIView):
    """``GET``/``POST /chains/<chain_id>/analyses/``."""

    nav_capability = NAV_RESEARCH_CHAIN

    def get(self, request, slug, chain_id):
        workspace, error = self.get_workspace(section="research_chain")
        if error:
            return error
        chain = _visible_chain(workspace, request.user, chain_id)
        if chain is None:
            return research_not_found(ResearchErrorCode.CHAIN_NOT_FOUND, "Research chain not found.")
        rows = chain.analysis_results.order_by("-created_at")
        if request.GET.get("status"):
            rows = rows.filter(status=str(request.GET["status"]).upper())
        return Response(
            {"results": ResearchAnalysisResultSerializer(rows, many=True).data, "count": rows.count()},
            status=status.HTTP_200_OK,
        )

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
        if not _node_operator(workspace, request.user, node):
            return research_error(
                ResearchErrorCode.PERMISSION_DENIED,
                "Only chain members can submit analyses.",
                status.HTTP_403_FORBIDDEN,
            )
        request_id = request_id_from(request)
        method = str(request.data.get("method") or "").strip()
        summary = str(request.data.get("summary") or "").strip()
        if not request_id or not method or not summary:
            return research_error(
                ResearchErrorCode.CHAIN_INVALID,
                "request_id, method and summary are required.",
            )
        confirmed = str(request.data.get("confirmed", "")).lower() in ("1", "true", "yes")
        digest = payload_hash(request.data)
        existing = ResearchAnalysisResult.objects.filter(request_id=request_id).first()
        if existing is not None:
            if existing.node_id != node.id or existing.payload_hash != digest:
                return conflict_response()
            return Response(ResearchAnalysisResultSerializer(existing).data, status=status.HTTP_200_OK)
        result = ResearchAnalysisResult.objects.create(
            workspace=workspace,
            chain=chain,
            node=node,
            method=method,
            input_refs=request.data.get("input_refs") or [],
            summary=summary,
            metrics=request.data.get("metrics") or {},
            quality=request.data.get("quality") or {},
            conclusion=str(request.data.get("conclusion") or ""),
            operator=request.user,
            tool_version=str(request.data.get("tool_version") or ""),
            status=ResearchAnalysisResult.Status.ACCEPTED if confirmed else ResearchAnalysisResult.Status.DRAFT,
            request_id=request_id,
            payload_hash=digest,
            created_by=request.user,
        )
        if confirmed:
            with transaction.atomic():
                ResearchChain.objects.select_for_update().get(pk=chain.pk)
                version = node.snapshots.aggregate(Max("version"))["version__max"] or 0
                snapshot = ResearchChainSnapshot.objects.create(
                    chain=chain,
                    node=node,
                    snapshot_type=ResearchChainSnapshot.SnapshotType.ANALYSIS_RESULT,
                    version=version + 1,
                    source_versions=request.data.get("source_versions") or [],
                    resources=[
                        {
                            "kind": "analysis",
                            "id": str(result.id),
                            "version": 1,
                            "method": method,
                        }
                    ],
                    event_range={},
                    summary=summary,
                    created_by=request.user,
                    content_hash=str(request.data.get("content_hash") or digest),
                    immutable=True,
                    request_id=f"analysis-snapshot:{request_id}",
                )
                ResearchChainEvent.objects.create(
                    chain=chain,
                    node=node,
                    event_id=payload_hash({"request_id": request_id, "kind": "analysis"}),
                    request_id=f"analysis-event:{request_id}",
                    actor=request.user,
                    actor_type="USER",
                    source_system="PLANE",
                    event_type="HUMAN_DECISION",
                    occurred_at=timezone.now(),
                    refs=[{"kind": "analysis", "id": str(result.id), "version": 1}],
                    summary=f"Accepted analysis: {method}",
                    content_hash=digest,
                )
        payload = ResearchAnalysisResultSerializer(result).data
        if confirmed:
            payload["snapshot_id"] = str(snapshot.snapshot_id)
            payload["snapshot_version"] = snapshot.version
        return Response(payload, status=status.HTTP_201_CREATED)
