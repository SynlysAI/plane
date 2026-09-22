"""Phase 0 Research Chain API skeleton with ACL and idempotent writes."""

from datetime import datetime

from django.db import transaction
from django.utils import timezone
from rest_framework import status
from rest_framework.response import Response

from plane.db.models import ResearchChain, ResearchChainEvent, ResearchChainNode, ResearchChainSnapshot, ResearchProjectProfile
from plane.research.serializers import (
    ResearchChainEventSerializer,
    ResearchChainNodeSerializer,
    ResearchChainSerializer,
    ResearchChainSnapshotSerializer,
)
from plane.research.services.idempotency import conflict_response, payload_hash, request_id_from
from plane.research.utils.capabilities import NAV_RESEARCH_CHAIN
from plane.research.utils.errors import ResearchErrorCode, research_error, research_not_found
from plane.research.views.base import ResearchAPIView
from plane.research.views.projects import can_read_project_research_metadata, profile_queryset


def _envelope(*, data, request_id, schema_version):
    """Build the Phase 0 success envelope."""
    return {"success": True, "data": data, "error": None, "request_id": request_id, "schema_version": schema_version}


def _flag_enabled(workspace):
    """Return whether the workspace opted into Research Chain."""
    return bool(getattr(workspace, "research_setting", None) and workspace.research_setting.research_chain_enabled)


def _disabled():
    return research_error(ResearchErrorCode.RESEARCH_DISABLED, "Research Chain is disabled for this workspace.", status.HTTP_404_NOT_FOUND)


def _profile(workspace, project_id, user):
    profile = profile_queryset(workspace).filter(project_id=project_id).first()
    if profile is None:
        return None
    if not can_read_project_research_metadata(workspace, user, profile):
        return None
    return profile


def _visible_node(workspace, user, node_id):
    """Resolve a node only when its project is visible to the caller."""
    node = (
        ResearchChainNode.objects.filter(pk=node_id, chain__workspace=workspace)
        .select_related("chain__project__research_profile")
        .first()
    )
    if node is None:
        return None
    if not can_read_project_research_metadata(workspace, user, node.chain.project.research_profile):
        return None
    return node


class ResearchChainListCreateEndpoint(ResearchAPIView):
    """List and create chain projections for visible research projects."""

    nav_capability = NAV_RESEARCH_CHAIN

    def get(self, request, slug):
        workspace, error = self.get_workspace(section="research_chain")
        if error:
            return error
        if not _flag_enabled(workspace):
            return _disabled()
        rows = ResearchChain.objects.filter(workspace=workspace, project__research_profile__isnull=False)
        rows = [row for row in rows if can_read_project_research_metadata(workspace, request.user, row.project.research_profile)]
        return Response(_envelope(data=ResearchChainSerializer(rows, many=True).data, request_id=request_id_from(request), schema_version="research-chain.v1"))

    def post(self, request, slug):
        workspace, error = self.get_workspace(section="research_chain")
        if error:
            return error
        if not _flag_enabled(workspace):
            return _disabled()
        request_id = request_id_from(request)
        if not request_id:
            return research_error(ResearchErrorCode.IDEMPOTENCY_CONFLICT, "request_id is required.")
        profile = _profile(workspace, request.data.get("project_id"), request.user)
        if profile is None:
            return research_not_found(ResearchErrorCode.CHAIN_NOT_FOUND, "Research project not found.")
        digest = payload_hash(request.data)
        existing = ResearchChain.objects.filter(request_id=request_id).first()
        if existing:
            if existing.payload_hash != digest:
                return conflict_response()
            return Response(_envelope(data=ResearchChainSerializer(existing).data, request_id=request_id, schema_version="research-chain.v1"), status=status.HTTP_200_OK)
        with transaction.atomic():
            chain, created = ResearchChain.objects.get_or_create(
                project=profile.project,
                defaults={
                    "workspace": workspace,
                    "owner": profile.owner,
                    "status": ResearchChain.Status.ACTIVE,
                    "visibility": profile.chain_visibility,
                    "request_id": request_id,
                    "payload_hash": digest,
                    "created_by": request.user,
                },
            )
            if not created and chain.request_id != request_id:
                return conflict_response()
        return Response(_envelope(data=ResearchChainSerializer(chain).data, request_id=request_id, schema_version="research-chain.v1"), status=status.HTTP_201_CREATED if created else status.HTTP_200_OK)


class ResearchChainDetailEndpoint(ResearchAPIView):
    """Return one visible chain."""

    nav_capability = NAV_RESEARCH_CHAIN

    def get(self, request, slug, chain_id):
        workspace, error = self.get_workspace(section="research_chain")
        if error:
            return error
        if not _flag_enabled(workspace):
            return _disabled()
        chain = ResearchChain.objects.filter(workspace=workspace, pk=chain_id).select_related("project__research_profile").first()
        if chain is None or not can_read_project_research_metadata(workspace, request.user, chain.project.research_profile):
            return research_not_found(ResearchErrorCode.CHAIN_NOT_FOUND, "Research chain not found.")
        return Response(_envelope(data=ResearchChainSerializer(chain).data, request_id=request_id_from(request), schema_version="research-chain.v1"))


class ResearchChainNodeListCreateEndpoint(ResearchAPIView):
    """List or append a node to a visible chain."""

    nav_capability = NAV_RESEARCH_CHAIN

    def _chain(self, request, slug, chain_id):
        workspace, error = self.get_workspace(section="research_chain")
        if error:
            return None, error
        if not _flag_enabled(workspace):
            return None, _disabled()
        chain = ResearchChain.objects.filter(workspace=workspace, pk=chain_id).select_related("project__research_profile").first()
        if chain is None or not can_read_project_research_metadata(workspace, request.user, chain.project.research_profile):
            return None, research_not_found(ResearchErrorCode.CHAIN_NOT_FOUND, "Research chain not found.")
        return chain, None

    def get(self, request, slug, chain_id):
        chain, error = self._chain(request, slug, chain_id)
        if error:
            return error
        return Response(_envelope(data=ResearchChainNodeSerializer(chain.nodes.order_by("created_at"), many=True).data, request_id=request_id_from(request), schema_version="research-node.v1"))

    def post(self, request, slug, chain_id):
        chain, error = self._chain(request, slug, chain_id)
        if error:
            return error
        request_id = request_id_from(request)
        if not request_id:
            return research_error(ResearchErrorCode.IDEMPOTENCY_CONFLICT, "request_id is required.")
        digest = payload_hash(request.data)
        existing = ResearchChainNode.objects.filter(request_id=request_id).first()
        if existing:
            if existing.payload_hash != digest:
                return conflict_response()
            return Response(_envelope(data=ResearchChainNodeSerializer(existing).data, request_id=request_id, schema_version="research-node.v1"))
        parent = None
        if request.data.get("parent_node_id"):
            parent = chain.nodes.filter(pk=request.data["parent_node_id"]).first()
            if parent is None:
                return research_error(ResearchErrorCode.CHAIN_NOT_FOUND, "parent_node_id is not in this chain.", status.HTTP_422_UNPROCESSABLE_ENTITY)
        node = ResearchChainNode.objects.create(
            chain=chain,
            node_type=str(request.data.get("node_type") or "GENERAL_RESEARCH"),
            title=str(request.data.get("title") or "Untitled research node"),
            parent_node=parent,
            loop_iteration=max(0, int(request.data.get("loop_iteration") or 0)),
            assignee_id=request.data.get("assignee_id") or request.user.id,
            request_id=request_id,
            payload_hash=digest,
            created_by=request.user,
        )
        return Response(_envelope(data=ResearchChainNodeSerializer(node).data, request_id=request_id, schema_version="research-node.v1"), status=status.HTTP_201_CREATED)


class ResearchChainEventListCreateEndpoint(ResearchAPIView):
    """List or append immutable events for a visible node."""

    nav_capability = NAV_RESEARCH_CHAIN

    def _node(self, request, slug, node_id):
        workspace, error = self.get_workspace(section="research_chain")
        if error:
            return None, error
        if not _flag_enabled(workspace):
            return None, _disabled()
        node = _visible_node(workspace, request.user, node_id)
        if node is None:
            return None, research_not_found(ResearchErrorCode.CHAIN_NOT_FOUND, "Research node not found.")
        return node, None

    def get(self, request, slug, node_id):
        node, error = self._node(request, slug, node_id)
        if error:
            return error
        events = node.events.order_by("occurred_at", "event_id")
        return Response(_envelope(data=ResearchChainEventSerializer(events, many=True).data, request_id=request_id_from(request), schema_version="research-event.v1"))

    def post(self, request, slug, node_id):
        node, error = self._node(request, slug, node_id)
        if error:
            return error
        request_id = request_id_from(request)
        event_id = str(request.data.get("event_id") or "").strip()
        if not request_id or not event_id:
            return research_error(ResearchErrorCode.IDEMPOTENCY_CONFLICT, "event_id and request_id are required.")
        digest = payload_hash(request.data)
        existing = ResearchChainEvent.objects.filter(request_id=request_id).first()
        if existing:
            if existing.content_hash != digest:
                return conflict_response()
            return Response(_envelope(data=ResearchChainEventSerializer(existing).data, request_id=request_id, schema_version="research-event.v1"))
        occurred_at = request.data.get("occurred_at")
        parsed_time = timezone.now()
        if occurred_at:
            try:
                parsed_time = datetime.fromisoformat(str(occurred_at).replace("Z", "+00:00"))
            except ValueError:
                return research_error(ResearchErrorCode.CHAIN_INVALID, "occurred_at must be ISO-8601.")
        event = ResearchChainEvent.objects.create(
            chain=node.chain,
            node=node,
            event_id=event_id,
            request_id=request_id,
            actor=request.user,
            actor_type=str(request.data.get("actor_type") or "USER"),
            source_system=str(request.data.get("source_system") or "PLANE").upper(),
            event_type=str(request.data.get("event_type") or "RESEARCH_NOTE").upper(),
            occurred_at=parsed_time,
            trace_id=str(request.data.get("trace_id") or ""),
            refs=request.data.get("refs") or [],
            summary=str(request.data.get("summary") or ""),
            content_hash=digest,
        )
        return Response(_envelope(data=ResearchChainEventSerializer(event).data, request_id=request_id, schema_version="research-event.v1"), status=status.HTTP_201_CREATED)


class ResearchChainSnapshotCreateEndpoint(ResearchAPIView):
    """Create immutable snapshot metadata for a visible node."""

    nav_capability = NAV_RESEARCH_CHAIN

    def post(self, request, slug, node_id):
        workspace, error = self.get_workspace(section="research_chain")
        if error:
            return error
        if not _flag_enabled(workspace):
            return _disabled()
        node = _visible_node(workspace, request.user, node_id)
        if node is None:
            return research_not_found(ResearchErrorCode.CHAIN_NOT_FOUND, "Research node not found.")
        request_id = request_id_from(request)
        if not request_id:
            return research_error(ResearchErrorCode.IDEMPOTENCY_CONFLICT, "request_id is required.")
        digest = payload_hash(request.data)
        existing = ResearchChainSnapshot.objects.filter(request_id=request_id).first()
        if existing:
            if existing.content_hash != digest:
                return conflict_response()
            return Response(_envelope(data=ResearchChainSnapshotSerializer(existing).data, request_id=request_id, schema_version="research-snapshot.v1"))
        version = node.snapshots.count() + 1
        snapshot = ResearchChainSnapshot.objects.create(
            chain=node.chain,
            node=node,
            version=version,
            source_versions=request.data.get("source_versions") or [],
            summary=str(request.data.get("summary") or ""),
            created_by=request.user,
            content_hash=digest,
            immutable=True,
            request_id=request_id,
        )
        return Response(_envelope(data=ResearchChainSnapshotSerializer(snapshot).data, request_id=request_id, schema_version="research-snapshot.v1"), status=status.HTTP_201_CREATED)
