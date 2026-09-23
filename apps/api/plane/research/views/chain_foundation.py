"""Phase 0 Research Chain API skeleton with ACL and idempotent writes."""

from datetime import datetime
from uuid import UUID

from django.db import IntegrityError, transaction
from django.db.models import Max, Q
from django.utils import timezone
from rest_framework import status
from rest_framework.response import Response

from plane.db.models import (
    MentorBinding,
    ProjectMember,
    ResearchChain,
    ResearchChainEvent,
    ResearchChainNode,
    ResearchChainSnapshot,
    ResearchProjectProfile,
    WorkspaceMember,
)
from plane.research.serializers import (
    ResearchChainEventSerializer,
    ResearchChainNodeSerializer,
    ResearchChainSerializer,
    ResearchChainSnapshotSerializer,
)
from plane.research.services.idempotency import conflict_response, payload_hash, request_id_from
from plane.research.services.chain_state import NODE_TYPE_PATTERN, normalize_action, resolve_transition
from plane.research.utils.audit import ResearchAuditAction, ResearchResourceType, record_audit_event
from plane.research.utils.capabilities import NAV_RESEARCH_CHAIN
from plane.research.utils.errors import ResearchErrorCode, research_error, research_not_found
from plane.research.utils.org import is_workspace_admin
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


def _visible_chain(workspace, user, chain_id):
    """Resolve a chain only through the project-level research ACL."""
    chain = (
        ResearchChain.objects.filter(workspace=workspace, pk=chain_id)
        .select_related("project__research_profile", "project", "owner")
        .first()
    )
    if chain is None or not can_read_project_research_metadata(workspace, user, chain.project.research_profile):
        return None
    return chain


def _writable_chain(workspace, user, chain_id):
    """Resolve a chain and require an active lifecycle for new writes."""
    chain = _visible_chain(workspace, user, chain_id)
    if chain is None:
        return None, research_not_found(ResearchErrorCode.CHAIN_NOT_FOUND, "Research chain not found.")
    readonly_error = _chain_readonly_error(chain)
    return (None, readonly_error) if readonly_error else (chain, None)


def _chain_readonly_error(chain):
    """Return the write denial for an inactive chain, if any."""
    if chain.status == ResearchChain.Status.ACTIVE:
        return None
    return research_error(
        ResearchErrorCode.CHAIN_INVALID,
        "Archived or completed chains are read-only.",
        status.HTTP_409_CONFLICT,
    )


def _chain_manager(workspace, user, chain):
    """Return whether the caller can manage chain lifecycle and collaborators."""
    if chain.owner_id == user.id or is_workspace_admin(user, workspace.id):
        return True
    return ProjectMember.objects.filter(
        project_id=chain.project_id,
        member=user,
        role__gte=20,
        is_active=True,
        deleted_at__isnull=True,
    ).exists()


def _chain_members(chain):
    """Serialize the owner and active project collaborators for a chain."""
    owner = {
        "user_id": str(chain.owner_id),
        "display_name": chain.owner.display_name or chain.owner.email,
        "role": "OWNER",
        "is_owner": True,
    }
    collaborators = ProjectMember.objects.filter(
        project=chain.project,
        is_active=True,
        deleted_at__isnull=True,
    ).exclude(member_id=chain.owner_id).select_related("member")
    return [
        owner,
        *[
            {
                "user_id": str(member.member_id),
                "display_name": member.member.display_name or member.member.email,
                "role": "ADMIN" if member.role >= 20 else "MEMBER",
                "is_owner": False,
            }
            for member in collaborators
        ],
    ]


def _node_operator(workspace, user, node):
    """Return whether the caller can run a node lifecycle action."""
    return _chain_writer(workspace, user, node.chain) or node.assignee_id == user.id


def _chain_writer(workspace, user, chain):
    """Return whether a caller may append mutable Chain data."""
    if _chain_manager(workspace, user, chain):
        return True
    profile = getattr(chain.project, "research_profile", None)
    if profile is not None:
        today = timezone.localdate()
        mentor = MentorBinding.objects.filter(
            workspace=workspace,
            mentor=user,
            mentee_id=profile.owner_id,
            deleted_at__isnull=True,
            effective_from__lte=today,
        ).filter(Q(effective_to__isnull=True) | Q(effective_to__gte=today))
        if mentor.exists():
            return True
    return ProjectMember.objects.filter(
        project_id=chain.project_id,
        member=user,
        role__gte=15,
        is_active=True,
        deleted_at__isnull=True,
    ).exists()


def _event_id_for_request(request_id, kind):
    """Build a deterministic event id from a bounded request id."""
    return payload_hash({"request_id": request_id, "kind": kind})


def _event_replay(request_id, event_id, digest, node_id=None):
    """Return an existing immutable event or a conflict response."""
    existing = ResearchChainEvent.objects.filter(Q(request_id=request_id) | Q(event_id=event_id)).first()
    if existing is None:
        return None
    if node_id is not None and str(existing.node_id) != str(node_id):
        return conflict_response()
    if existing.content_hash != digest:
        return conflict_response()
    return existing


class ResearchChainListCreateEndpoint(ResearchAPIView):
    """List and create chain projections for visible research projects."""

    nav_capability = NAV_RESEARCH_CHAIN

    def get(self, request, slug):
        workspace, error = self.get_workspace(section="research_chain")
        if error:
            return error
        if not _flag_enabled(workspace):
            return _disabled()
        rows = ResearchChain.objects.filter(workspace=workspace, project__research_profile__isnull=False).order_by(
            "-updated_at"
        )
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
        digest = payload_hash(request.data)
        existing = ResearchChain.objects.filter(request_id=request_id).first()
        if existing:
            if existing.payload_hash != digest:
                return conflict_response()
            return Response(_envelope(data=ResearchChainSerializer(existing).data, request_id=request_id, schema_version="research-chain.v1"), status=status.HTTP_200_OK)
        profile = _profile(workspace, request.data.get("project_id"), request.user)
        if profile is None:
            return research_not_found(ResearchErrorCode.CHAIN_NOT_FOUND, "Research project not found.")
        if profile.chain_kind != ResearchProjectProfile.ChainKind.RESEARCH_CHAIN:
            return research_error(
                ResearchErrorCode.CHAIN_INVALID,
                "Only RESEARCH_CHAIN projects can create a Research Chain.",
                status.HTTP_422_UNPROCESSABLE_ENTITY,
            )
        requested_visibility = str(request.data.get("visibility") or profile.chain_visibility).upper()
        if requested_visibility != profile.chain_visibility:
            return research_error(
                ResearchErrorCode.CHAIN_INVALID,
                "visibility must match the research project visibility.",
                status.HTTP_422_UNPROCESSABLE_ENTITY,
            )
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
        chain = _visible_chain(workspace, request.user, chain_id)
        if chain is None:
            return research_not_found(ResearchErrorCode.CHAIN_NOT_FOUND, "Research chain not found.")
        return Response(_envelope(data=ResearchChainSerializer(chain).data, request_id=request_id_from(request), schema_version="research-chain.v1"))


class ResearchChainArchiveEndpoint(ResearchAPIView):
    """Archive a visible chain while preserving its append-only evidence."""

    nav_capability = NAV_RESEARCH_CHAIN

    def post(self, request, slug, chain_id):
        workspace, error = self.get_workspace(section="research_chain")
        if error:
            return error
        if not _flag_enabled(workspace):
            return _disabled()
        chain = _visible_chain(workspace, request.user, chain_id)
        if chain is None:
            return research_not_found(ResearchErrorCode.CHAIN_NOT_FOUND, "Research chain not found.")
        if not _chain_manager(workspace, request.user, chain):
            return research_error(
                ResearchErrorCode.PERMISSION_DENIED,
                "Only chain managers can archive a chain.",
                status.HTTP_403_FORBIDDEN,
            )
        profile = chain.project.research_profile
        with transaction.atomic():
            chain.status = ResearchChain.Status.ARCHIVED
            chain.save(update_fields=["status", "updated_at"])
            profile.workflow_status = ResearchProjectProfile.WorkflowStatus.ARCHIVED
            profile.is_active = False
            profile.save(update_fields=["workflow_status", "is_active", "updated_at"])
        record_audit_event(
            workspace=workspace,
            action=ResearchAuditAction.CHAIN_ARCHIVE,
            resource_type=ResearchResourceType.RESEARCH_CHAIN,
            resource_id=chain.id,
            org_unit=profile.org_unit,
            actor=request.user,
            metadata={"project": str(chain.project_id)},
            request=request,
        )
        return Response(
            _envelope(
                data=ResearchChainSerializer(chain).data,
                request_id=request_id_from(request),
                schema_version="research-chain.v1",
            )
        )


class ResearchChainRestoreEndpoint(ResearchAPIView):
    """Restore an archived chain and its research project profile."""

    nav_capability = NAV_RESEARCH_CHAIN

    def post(self, request, slug, chain_id):
        workspace, error = self.get_workspace(section="research_chain")
        if error:
            return error
        if not _flag_enabled(workspace):
            return _disabled()
        chain = _visible_chain(workspace, request.user, chain_id)
        if chain is None:
            return research_not_found(ResearchErrorCode.CHAIN_NOT_FOUND, "Research chain not found.")
        if not _chain_manager(workspace, request.user, chain):
            return research_error(
                ResearchErrorCode.PERMISSION_DENIED,
                "Only chain managers can restore a chain.",
                status.HTTP_403_FORBIDDEN,
            )
        profile = chain.project.research_profile
        with transaction.atomic():
            chain.status = ResearchChain.Status.ACTIVE
            chain.save(update_fields=["status", "updated_at"])
            profile.workflow_status = ResearchProjectProfile.WorkflowStatus.ACTIVE
            profile.is_active = True
            profile.save(update_fields=["workflow_status", "is_active", "updated_at"])
        record_audit_event(
            workspace=workspace,
            action=ResearchAuditAction.CHAIN_RESTORE,
            resource_type=ResearchResourceType.RESEARCH_CHAIN,
            resource_id=chain.id,
            org_unit=profile.org_unit,
            actor=request.user,
            metadata={"project": str(chain.project_id)},
            request=request,
        )
        return Response(
            _envelope(
                data=ResearchChainSerializer(chain).data,
                request_id=request_id_from(request),
                schema_version="research-chain.v1",
            )
        )


class ResearchChainMemberListCreateEndpoint(ResearchAPIView):
    """List or add collaborators through the chain's underlying project ACL."""

    nav_capability = NAV_RESEARCH_CHAIN

    def get(self, request, slug, chain_id):
        workspace, error = self.get_workspace(section="research_chain")
        if error:
            return error
        if not _flag_enabled(workspace):
            return _disabled()
        chain = _visible_chain(workspace, request.user, chain_id)
        if chain is None:
            return research_not_found(ResearchErrorCode.CHAIN_NOT_FOUND, "Research chain not found.")
        return Response(
            _envelope(
                data=_chain_members(chain),
                request_id=request_id_from(request),
                schema_version="research-chain-member.v1",
            )
        )

    def post(self, request, slug, chain_id):
        workspace, error = self.get_workspace(section="research_chain")
        if error:
            return error
        if not _flag_enabled(workspace):
            return _disabled()
        chain, error = _writable_chain(workspace, request.user, chain_id)
        if error:
            return error
        if not _chain_manager(workspace, request.user, chain):
            return research_error(
                ResearchErrorCode.PERMISSION_DENIED,
                "Only chain managers can add collaborators.",
                status.HTTP_403_FORBIDDEN,
            )
        raw_user_id = request.data.get("user_id") or request.data.get("member_id")
        try:
            member_id = UUID(str(raw_user_id))
        except (TypeError, ValueError):
            return research_error(ResearchErrorCode.USER_NOT_FOUND, "A valid user_id is required.")
        if member_id == chain.owner_id:
            return research_error(
                ResearchErrorCode.CHAIN_INVALID,
                "The chain owner is already a member.",
                status.HTTP_422_UNPROCESSABLE_ENTITY,
            )
        workspace_member = WorkspaceMember.objects.filter(
            workspace=workspace,
            member_id=member_id,
            member__is_active=True,
            is_active=True,
            deleted_at__isnull=True,
        ).first()
        if workspace_member is None:
            return research_error(ResearchErrorCode.USER_NOT_FOUND, "The user must be an active workspace member.")
        member_exists = ProjectMember.objects.filter(
            project=chain.project,
            member_id=member_id,
            is_active=True,
            deleted_at__isnull=True,
        ).exists()
        if member_exists:
            return research_error(
                ResearchErrorCode.CHAIN_INVALID,
                "The user is already a chain member.",
                status.HTTP_409_CONFLICT,
            )
        role = int(request.data.get("role") or 15)
        if role not in (15, 20):
            return research_error(
                ResearchErrorCode.CHAIN_INVALID,
                "role must be 15 or 20.",
                status.HTTP_422_UNPROCESSABLE_ENTITY,
            )
        ProjectMember.objects.create(
            project=chain.project,
            workspace=workspace,
            member_id=member_id,
            role=role,
            created_by=request.user,
        )
        record_audit_event(
            workspace=workspace,
            action=ResearchAuditAction.CHAIN_MEMBER_ADD,
            resource_type=ResearchResourceType.RESEARCH_CHAIN,
            resource_id=chain.id,
            org_unit=chain.project.research_profile.org_unit,
            actor=request.user,
            metadata={"member": str(member_id), "role": role},
            request=request,
        )
        return Response(
            _envelope(
                data=_chain_members(chain),
                request_id=request_id_from(request),
                schema_version="research-chain-member.v1",
            ),
            status=status.HTTP_201_CREATED,
        )


class ResearchChainMemberDetailEndpoint(ResearchAPIView):
    """Remove a collaborator without deleting historical evidence."""

    nav_capability = NAV_RESEARCH_CHAIN

    def delete(self, request, slug, chain_id, user_id):
        workspace, error = self.get_workspace(section="research_chain")
        if error:
            return error
        if not _flag_enabled(workspace):
            return _disabled()
        chain, error = _writable_chain(workspace, request.user, chain_id)
        if error:
            return error
        if not _chain_manager(workspace, request.user, chain):
            return research_error(
                ResearchErrorCode.PERMISSION_DENIED,
                "Only chain managers can remove collaborators.",
                status.HTTP_403_FORBIDDEN,
            )
        try:
            member_id = UUID(str(user_id))
        except (TypeError, ValueError):
            return research_error(ResearchErrorCode.USER_NOT_FOUND, "A valid member id is required.")
        if member_id == chain.owner_id:
            return research_error(
                ResearchErrorCode.CHAIN_INVALID,
                "The chain owner cannot be removed.",
                status.HTTP_422_UNPROCESSABLE_ENTITY,
            )
        member = ProjectMember.objects.filter(
            project=chain.project,
            member_id=member_id,
            is_active=True,
            deleted_at__isnull=True,
        ).first()
        if member is None:
            return research_not_found(ResearchErrorCode.USER_NOT_FOUND, "Research chain member not found.")
        member.is_active = False
        member.deleted_at = timezone.now()
        member.save(update_fields=["is_active", "deleted_at", "updated_at"])
        record_audit_event(
            workspace=workspace,
            action=ResearchAuditAction.CHAIN_MEMBER_REMOVE,
            resource_type=ResearchResourceType.RESEARCH_CHAIN,
            resource_id=chain.id,
            org_unit=chain.project.research_profile.org_unit,
            actor=request.user,
            metadata={"member": str(member_id)},
            request=request,
        )
        return Response(status=status.HTTP_204_NO_CONTENT)


class ResearchChainNodeListCreateEndpoint(ResearchAPIView):
    """List or append a node to a visible chain."""

    nav_capability = NAV_RESEARCH_CHAIN

    def _chain(self, request, slug, chain_id):
        workspace, error = self.get_workspace(section="research_chain")
        if error:
            return None, error
        if not _flag_enabled(workspace):
            return None, _disabled()
        chain = _visible_chain(workspace, request.user, chain_id)
        if chain is None:
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
            if existing.chain_id != chain.id or existing.payload_hash != digest:
                return conflict_response()
            return Response(_envelope(data=ResearchChainNodeSerializer(existing).data, request_id=request_id, schema_version="research-node.v1"))
        lifecycle_error = _chain_readonly_error(chain)
        if lifecycle_error:
            return lifecycle_error
        if not _chain_writer(chain.workspace, request.user, chain):
            return research_error(
                ResearchErrorCode.PERMISSION_DENIED,
                "Only chain members can create nodes.",
                status.HTTP_403_FORBIDDEN,
            )
        node_type = str(request.data.get("node_type") or "GENERAL_RESEARCH").strip().upper()
        if len(node_type) > 64 or NODE_TYPE_PATTERN.fullmatch(node_type) is None:
            return research_error(
                ResearchErrorCode.CHAIN_INVALID,
                "node_type is not a supported Research Chain node type.",
                status.HTTP_422_UNPROCESSABLE_ENTITY,
            )
        parent = None
        try:
            loop_iteration = max(0, int(request.data.get("loop_iteration") or 0))
        except (TypeError, ValueError):
            return research_error(ResearchErrorCode.CHAIN_INVALID, "loop_iteration must be an integer.")
        if request.data.get("parent_node_id"):
            parent = chain.nodes.filter(pk=request.data["parent_node_id"]).first()
            if parent is None:
                return research_error(ResearchErrorCode.CHAIN_NOT_FOUND, "parent_node_id is not in this chain.", status.HTTP_422_UNPROCESSABLE_ENTITY)
        if (parent is None and loop_iteration != 0) or (parent is not None and loop_iteration < 1):
            return research_error(
                ResearchErrorCode.CHAIN_INVALID,
                "Root nodes use loop_iteration 0; child nodes require loop_iteration >= 1.",
                status.HTTP_422_UNPROCESSABLE_ENTITY,
            )
        try:
            with transaction.atomic():
                node = ResearchChainNode.objects.create(
                    chain=chain,
                    node_type=node_type,
                    title=str(request.data.get("title") or "Untitled research node"),
                    parent_node=parent,
                    loop_iteration=loop_iteration,
                    assignee_id=request.data.get("assignee_id") or request.user.id,
                    request_id=request_id,
                    payload_hash=digest,
                    created_by=request.user,
                )
                created_event_id = _event_id_for_request(request_id, "NODE_CREATED")
                ResearchChainEvent.objects.create(
                    chain=chain,
                    node=node,
                    event_id=created_event_id,
                    request_id=f"node-created-{created_event_id[:48]}",
                    actor=request.user,
                    actor_type="USER",
                    source_system="PLANE",
                    event_type="NODE_CREATED",
                    occurred_at=timezone.now(),
                    summary=f"Created node: {node.title}",
                    content_hash=payload_hash({"request_id": request_id, "kind": "NODE_CREATED"}),
                )
        except IntegrityError:
            return conflict_response()
        return Response(_envelope(data=ResearchChainNodeSerializer(node).data, request_id=request_id, schema_version="research-node.v1"), status=status.HTTP_201_CREATED)


class ResearchChainNodeDetailEndpoint(ResearchAPIView):
    """Return one visible node with its append-only evidence."""

    nav_capability = NAV_RESEARCH_CHAIN

    def get(self, request, slug, node_id):
        workspace, error = self.get_workspace(section="research_chain")
        if error:
            return error
        if not _flag_enabled(workspace):
            return _disabled()
        node = _visible_node(workspace, request.user, node_id)
        if node is None:
            return research_not_found(ResearchErrorCode.CHAIN_NOT_FOUND, "Research node not found.")
        return Response(
            _envelope(
                data={
                    "node": ResearchChainNodeSerializer(node).data,
                    "events": ResearchChainEventSerializer(
                        node.events.order_by("occurred_at", "event_id"), many=True
                    ).data,
                    "snapshots": ResearchChainSnapshotSerializer(node.snapshots.order_by("version"), many=True).data,
                },
                request_id=request_id_from(request),
                schema_version="research-node-detail.v1",
            )
        )


class ResearchChainNodeTransitionEndpoint(ResearchAPIView):
    """Run a validated node transition and append its lifecycle event."""

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
        action = normalize_action(request.data.get("action"))
        if not action:
            return research_error(ResearchErrorCode.CHAIN_INVALID, "action is required.")
        reason = str(request.data.get("reason") or "").strip()
        if action in {"FAIL", "RETURN"} and not reason:
            return research_error(ResearchErrorCode.CHAIN_INVALID, "reason is required for FAIL and RETURN.")
        digest = payload_hash(request.data)
        event_id = _event_id_for_request(request_id, action)
        existing = _event_replay(request_id, event_id, digest, node.id)
        if isinstance(existing, Response):
            return existing
        if existing is not None:
            return Response(
                _envelope(
                    data={
                        "node": ResearchChainNodeSerializer(node).data,
                        "event": ResearchChainEventSerializer(existing).data,
                    },
                    request_id=request_id,
                    schema_version="research-node-transition.v1",
                )
            )
        if not _node_operator(node.chain.workspace, request.user, node):
            return research_error(
                ResearchErrorCode.PERMISSION_DENIED,
                "Only node operators can transition a node.",
                status.HTTP_403_FORBIDDEN,
            )
        readonly_error = _chain_readonly_error(node.chain)
        if readonly_error:
            return readonly_error
        with transaction.atomic():
            locked_node = ResearchChainNode.objects.select_for_update().get(pk=node.pk)
            transition = resolve_transition(locked_node.status, action)
            if transition is None:
                return research_error(
                    ResearchErrorCode.INVALID_TRANSITION,
                    f"{action} is not allowed from {locked_node.status}.",
                    status.HTTP_409_CONFLICT,
                )
            new_status, event_type = transition
            locked_node.status = new_status
            locked_node.save(update_fields=["status", "updated_at"])
            event = ResearchChainEvent.objects.create(
                chain=locked_node.chain,
                node=locked_node,
                event_id=event_id,
                request_id=request_id,
                actor=request.user,
                actor_type="USER",
                source_system="PLANE",
                event_type=event_type,
                occurred_at=timezone.now(),
                refs=[{"kind": "node", "id": str(locked_node.id), "version": new_status}],
                summary=reason or f"{action}: {locked_node.title}",
                content_hash=digest,
            )
        return Response(
            _envelope(
                data={
                    "node": ResearchChainNodeSerializer(locked_node).data,
                    "event": ResearchChainEventSerializer(event).data,
                },
                request_id=request_id,
                schema_version="research-node-transition.v1",
            ),
            status=status.HTTP_201_CREATED,
        )


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
        event_type = str(request.data.get("event_type") or "RESEARCH_NOTE").upper()
        refs = request.data.get("refs") or []
        if not isinstance(refs, list):
            return research_error(ResearchErrorCode.CHAIN_INVALID, "refs must be a list.")
        existing = _event_replay(request_id, event_id, digest, node.id)
        if isinstance(existing, Response):
            return existing
        if existing is not None:
            return Response(_envelope(data=ResearchChainEventSerializer(existing).data, request_id=request_id, schema_version="research-event.v1"))
        lifecycle_error = _chain_readonly_error(node.chain)
        if lifecycle_error:
            return lifecycle_error
        if not _node_operator(node.chain.workspace, request.user, node):
            return research_error(
                ResearchErrorCode.PERMISSION_DENIED,
                "Only chain members can append events.",
                status.HTTP_403_FORBIDDEN,
            )
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
            event_type=event_type,
            occurred_at=parsed_time,
            trace_id=str(request.data.get("trace_id") or ""),
            refs=refs,
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
            if existing.node_id != node.id or existing.content_hash != digest:
                return conflict_response()
            return Response(_envelope(data=ResearchChainSnapshotSerializer(existing).data, request_id=request_id, schema_version="research-snapshot.v1"))
        lifecycle_error = _chain_readonly_error(node.chain)
        if lifecycle_error:
            return lifecycle_error
        if not _node_operator(workspace, request.user, node):
            return research_error(
                ResearchErrorCode.PERMISSION_DENIED,
                "Only node operators can create snapshots.",
                status.HTTP_403_FORBIDDEN,
            )
        source_versions = request.data.get("source_versions") or []
        resources = request.data.get("resources") or []
        event_range = request.data.get("event_range") or {}
        if not isinstance(source_versions, list) or not isinstance(resources, list):
            return research_error(ResearchErrorCode.CHAIN_INVALID, "source_versions and resources must be lists.")
        if not isinstance(event_range, dict):
            return research_error(ResearchErrorCode.CHAIN_INVALID, "event_range requires first and last event ids.")
        if not event_range:
            event_ids = list(
                node.events.order_by("occurred_at", "event_id").values_list("event_id", flat=True)
            )
            event_range = {"first": event_ids[0] if event_ids else "", "last": event_ids[-1] if event_ids else ""}
        elif not all(isinstance(event_range.get(key), str) for key in ("first", "last")):
            return research_error(ResearchErrorCode.CHAIN_INVALID, "event_range requires first and last event ids.")
        with transaction.atomic():
            ResearchChain.objects.select_for_update().get(pk=node.chain_id)
            version = node.snapshots.aggregate(Max("version"))["version__max"] or 0
            snapshot = ResearchChainSnapshot.objects.create(
                chain=node.chain,
                node=node,
                version=version + 1,
                source_versions=source_versions,
                resources=resources,
                event_range=event_range,
                summary=str(request.data.get("summary") or ""),
                created_by=request.user,
                content_hash=digest,
                immutable=True,
                request_id=request_id,
            )
        return Response(_envelope(data=ResearchChainSnapshotSerializer(snapshot).data, request_id=request_id, schema_version="research-snapshot.v1"), status=status.HTTP_201_CREATED)
