"""Phase 0 same-origin Agent plugin BFF."""

from django.db import transaction
from django.db import IntegrityError
from django.utils import timezone
from rest_framework import status
from rest_framework.response import Response
from uuid import UUID

from plane.db.models import (
    ResearchAgentRunEvent,
    ResearchAgentSession,
    ResearchChainEvent,
    ResearchChainNode,
    ResearchChainSnapshot,
)
from plane.research.serializers import ResearchAgentRunEventSerializer, ResearchAgentSessionSerializer
from plane.research.services.context_tokens import issue_context_token
from plane.research.services.idempotency import payload_hash, request_id_from
from plane.research.utils.audit import ResearchAuditAction, ResearchResourceType, record_audit_event
from plane.research.utils.capabilities import NAV_PROJECTS
from plane.research.utils.errors import (
    ResearchErrorCode,
    research_conflict,
    research_error,
    research_not_found,
)
from plane.research.views.base import ResearchAPIView
from plane.research.views.projects import can_read_project_research_metadata


AGENT_MANIFEST = {
    "schema_version": "agent-plugin.v1",
    "plugin_id": "research-agent",
    "manifest_version": "agent-plugin.v1",
    "entrypoints": ["workspace_home", "research_chain", "chain_node"],
    "required_scopes": ["context.read", "agent.session.create"],
    "capabilities": ["chat", "knowledge.search", "artifact.save"],
    "ui": {"desktop": "side_panel", "mobile": "stacked_panel"},
    "feature_flag": "research_agent_enabled",
    "ui_states": [
        "initializing",
        "loading_context",
        "ready",
        "streaming",
        "waiting_approval",
        "saving",
        "degraded",
        "forbidden",
        "expired",
        "error",
        "closed",
    ],
    "transport": {"events": "json_poll", "streaming": "reserved", "iframe": "forbidden"},
}

AGENT_CHAIN_EVENT_TYPES = frozenset({
    "RESEARCH_NOTE",
    "COMMUNICATION",
    "AI_ACTION",
    "TOOL_CALL",
    "VALIDATION",
    "HUMAN_DECISION",
    "APPROVAL",
    "DATA_CHANGE",
    "DEGRADED",
})
AGENT_CHAIN_EVENT_WRITE_ACTION = "agent.chain_event.write"
AGENT_CHAIN_EVENT_RESOURCE_TYPE = "research_chain_event"


def _agent_enabled(workspace):
    setting = getattr(workspace, "research_setting", None)
    return bool(setting and setting.research_agent_enabled)


def _disabled():
    return research_error(
        ResearchErrorCode.SUBMODULE_DISABLED,
        "The research agent switch is disabled for this workspace.",
        status.HTTP_403_FORBIDDEN,
    )


def _visible_node(workspace, user, node_id):
    try:
        node_id = UUID(str(node_id))
    except (TypeError, ValueError):
        return None
    node = ResearchChainNode.objects.select_related("chain__project__research_profile").filter(
        pk=node_id,
        chain__workspace=workspace,
    ).first()
    if node is None:
        return None
    profile = getattr(node.chain.project, "research_profile", None)
    if profile is None or not can_read_project_research_metadata(workspace, user, profile):
        return None
    return node


def _session_visible(workspace, user, session):
    profile = getattr(session.project, "research_profile", None)
    return session.user_id == user.id or (
        profile is not None and can_read_project_research_metadata(workspace, user, profile)
    )


def _guard_session_context(session, *, allow_inactive_context=False):
    """Validate the Context grant attached to an already loaded session.

    Args:
        session: The visible Agent session.
        allow_inactive_context: Whether this is a lifecycle operation that may
            close a session after its Context has expired or been revoked.

    Returns:
        ``(session, None)`` when allowed; otherwise ``(None, error_response)``.
    """
    grant = session.context_grant
    inactive = grant.revoked_at is not None or grant.expires_at <= timezone.now()
    if inactive and not allow_inactive_context:
        if session.status != ResearchAgentSession.Status.CLOSED:
            session.status = ResearchAgentSession.Status.DEGRADED
            session.last_error = "context_expired"
            session.save(update_fields=["status", "last_error", "updated_at"])
        return None, research_error(
            ResearchErrorCode.CONTEXT_TOKEN_INVALID,
            "Agent session context is expired or revoked.",
            status.HTTP_403_FORBIDDEN,
        )
    return session, None


def _load_session(request, workspace, session_id, *, allow_inactive_context=False):
    try:
        session_id = UUID(str(session_id))
    except (TypeError, ValueError):
        return None, research_not_found(ResearchErrorCode.AGENT_SESSION_NOT_FOUND, "Agent session not found.")
    session = (
        ResearchAgentSession.objects.select_related(
            "workspace",
            "user",
            "project__research_profile",
            "chain_node__chain",
            "context_grant",
        )
        .filter(session_id=session_id, workspace=workspace, deleted_at__isnull=True)
        .first()
    )
    if session is None or not _session_visible(workspace, request.user, session):
        return None, research_not_found(ResearchErrorCode.AGENT_SESSION_NOT_FOUND, "Agent session not found.")
    return _guard_session_context(session, allow_inactive_context=allow_inactive_context)


def _load_session_by_run(request, workspace, run_id, *, allow_inactive_context=False):
    """Load a visible Agent session by its stable run ID."""
    try:
        run_id = UUID(str(run_id))
    except (TypeError, ValueError):
        return None, research_not_found(ResearchErrorCode.AGENT_SESSION_NOT_FOUND, "Agent run not found.")
    session = (
        ResearchAgentSession.objects.select_related(
            "workspace",
            "user",
            "project__research_profile",
            "chain_node__chain",
            "context_grant",
        )
        .filter(run_id=run_id, workspace=workspace, deleted_at__isnull=True)
        .first()
    )
    if session is None or not _session_visible(workspace, request.user, session):
        return None, research_not_found(ResearchErrorCode.AGENT_SESSION_NOT_FOUND, "Agent run not found.")
    return _guard_session_context(session, allow_inactive_context=allow_inactive_context)


def _append_event(session, event_type, payload, request_id):
    """Append one stable event with a transactional sequence number."""
    with transaction.atomic():
        locked = ResearchAgentSession.objects.select_for_update().get(pk=session.pk)
        seq = locked.run_events.count() + 1
        event = ResearchAgentRunEvent.objects.create(
            session=locked,
            run_id=locked.run_id,
            seq=seq,
            event_type=event_type,
            payload=payload,
            request_id=request_id,
        )
    return event


class AgentPluginMixin(ResearchAPIView):
    nav_capability = NAV_PROJECTS

    def workspace_or_error(self, request, slug, *, require_enabled=True):
        workspace, error = self.get_workspace()
        if error:
            return None, error
        if require_enabled and not _agent_enabled(workspace):
            return None, _disabled()
        return workspace, None


class ResearchAgentManifestEndpoint(AgentPluginMixin):
    """``GET /api/research/workspaces/<slug>/agent/manifest/``."""

    def get(self, request, slug):
        workspace, error = self.workspace_or_error(request, slug, require_enabled=False)
        if error:
            return error
        return Response({**AGENT_MANIFEST, "enabled": _agent_enabled(workspace)})


class ResearchAgentSessionCreateEndpoint(AgentPluginMixin):
    """Create a scoped session and keep its exchange token server-side."""

    def post(self, request, slug):
        workspace, error = self.workspace_or_error(request, slug)
        if error:
            return error
        request_id = request_id_from(request)
        if not request_id:
            return research_error(ResearchErrorCode.IDEMPOTENCY_CONFLICT, "request_id is required.")
        existing = ResearchAgentSession.objects.filter(request_id=request_id).first()
        if existing:
            if existing.workspace_id != workspace.id or not _session_visible(workspace, request.user, existing):
                return research_error(ResearchErrorCode.IDEMPOTENCY_CONFLICT, "request_id was already used with another payload.", status.HTTP_409_CONFLICT)
            if existing.payload_hash != payload_hash(request.data):
                return research_error(ResearchErrorCode.IDEMPOTENCY_CONFLICT, "request_id was already used with another payload.", status.HTTP_409_CONFLICT)
            return Response(ResearchAgentSessionSerializer(existing).data, status=status.HTTP_200_OK)
        node = _visible_node(workspace, request.user, request.data.get("chain_node_id"))
        if node is None:
            return research_error(ResearchErrorCode.AGENT_SCOPE_INVALID, "chain_node_id is invalid or not accessible.", status.HTTP_403_FORBIDDEN)
        profile = node.chain.project.research_profile
        grant, _raw_token_never_returned = issue_context_token(
            workspace=workspace,
            user=request.user,
            profile=profile,
            chain_node=node,
            request_id=f"agent:{request_id}",
        )
        try:
            session = ResearchAgentSession.objects.create(
                workspace=workspace,
                user=request.user,
                project_id=node.chain.project_id,
                chain_node=node,
                context_grant=grant,
                status=ResearchAgentSession.Status.READY,
                request_id=request_id,
                payload_hash=payload_hash(request.data),
                created_by=request.user,
            )
        except IntegrityError:
            return research_error(ResearchErrorCode.IDEMPOTENCY_CONFLICT, "request_id was already used with another payload.", status.HTTP_409_CONFLICT)
        event = _append_event(session, "AI_ACTION", {"action": "session.ready"}, f"event:{request_id}")
        record_audit_event(
            workspace=workspace,
            action=ResearchAuditAction.AGENT_SESSION_CREATE,
            resource_type=ResearchResourceType.AGENT_SESSION,
            resource_id=session.session_id,
            actor=request.user,
            metadata={"run_id": str(session.run_id), "project_id": str(session.project_id), "chain_node_id": str(node.id)},
            request=request,
        )
        return Response(
            {**ResearchAgentSessionSerializer(session).data, "initial_event": ResearchAgentRunEventSerializer(event).data},
            status=status.HTTP_201_CREATED,
        )


class ResearchAgentSessionDetailEndpoint(AgentPluginMixin):
    """Restore session state without replaying the whole event stream."""

    def get(self, request, slug, session_id):
        workspace, error = self.workspace_or_error(request, slug)
        if error:
            return error
        session, error = _load_session(request, workspace, session_id)
        if error:
            return error
        record_audit_event(
            workspace=workspace,
            action=ResearchAuditAction.AGENT_SESSION_READ,
            resource_type=ResearchResourceType.AGENT_SESSION,
            resource_id=session.session_id,
            actor=request.user,
            metadata={"run_id": str(session.run_id)},
            request=request,
        )
        return Response(ResearchAgentSessionSerializer(session).data)


class ResearchAgentSessionCloseEndpoint(AgentPluginMixin):
    """Close a session and revoke its context token immediately."""

    def post(self, request, slug, session_id):
        workspace, error = self.workspace_or_error(request, slug)
        if error:
            return error
        session, error = _load_session(
            request,
            workspace,
            session_id,
            allow_inactive_context=True,
        )
        if error:
            return error
        if session.status == ResearchAgentSession.Status.CLOSED:
            return Response(ResearchAgentSessionSerializer(session).data)
        session.status = ResearchAgentSession.Status.CLOSED
        session.last_error = ""
        session.updated_by = request.user
        session.save(update_fields=["status", "last_error", "updated_by", "updated_at"])
        grant = session.context_grant
        if grant.revoked_at is None:
            grant.revoked_at = timezone.now()
            grant.updated_by = request.user
            grant.save(update_fields=["revoked_at", "updated_by", "updated_at"])
        _append_event(session, "HUMAN_DECISION", {"action": "session.close"}, request_id_from(request) or f"close:{session.session_id}")
        record_audit_event(
            workspace=workspace,
            action=ResearchAuditAction.AGENT_SESSION_CLOSE,
            resource_type=ResearchResourceType.AGENT_SESSION,
            resource_id=session.session_id,
            actor=request.user,
            metadata={"run_id": str(session.run_id)},
            request=request,
        )
        return Response(ResearchAgentSessionSerializer(session).data)


class ResearchAgentMessageEndpoint(AgentPluginMixin):
    """Accept a message; Phase 0 fail-closes when Synlora is not configured."""

    def post(self, request, slug, session_id):
        workspace, error = self.workspace_or_error(request, slug)
        if error:
            return error
        session, error = _load_session(request, workspace, session_id)
        if error:
            return error
        if session.status == ResearchAgentSession.Status.CLOSED:
            return research_error(ResearchErrorCode.AGENT_SCOPE_INVALID, "Agent session is closed.", status.HTTP_409_CONFLICT)
        request_id = request_id_from(request)
        content = str(request.data.get("content") or "").strip()
        if not request_id or not content:
            return research_error(ResearchErrorCode.AGENT_SCOPE_INVALID, "request_id and content are required.")
        content_hash = payload_hash({"content": content})

        existing = ResearchAgentRunEvent.objects.select_related("session").filter(request_id=request_id).first()
        if existing is not None:
            payload_matches = (
                existing.session_id == session.pk
                and existing.event_type == "COMMUNICATION"
                and existing.payload.get("content_hash") == content_hash
                and existing.payload.get("length") == len(content)
            )
            if not payload_matches:
                return research_conflict(
                    ResearchErrorCode.IDEMPOTENCY_CONFLICT,
                    "request_id was already used with another payload.",
                )
            degraded = ResearchAgentRunEvent.objects.filter(request_id=f"degraded:{request_id}").first()
            if degraded is not None:
                return Response(
                    {
                        "session": ResearchAgentSessionSerializer(session).data,
                        "events": ResearchAgentRunEventSerializer([degraded], many=True).data,
                    },
                    status=status.HTTP_503_SERVICE_UNAVAILABLE,
                )
        else:
            _append_event(
                session,
                "COMMUNICATION",
                {"direction": "user", "content_hash": content_hash, "length": len(content)},
                request_id,
            )

        session.status = ResearchAgentSession.Status.DEGRADED
        session.last_error = ResearchErrorCode.AGENT_UPSTREAM_NOT_CONFIGURED
        session.updated_by = request.user
        session.save(update_fields=["status", "last_error", "updated_by", "updated_at"])
        degraded = _append_event(
            session,
            "DEGRADED",
            {"reason": ResearchErrorCode.AGENT_UPSTREAM_NOT_CONFIGURED},
            f"degraded:{request_id}",
        )
        record_audit_event(
            workspace=workspace,
            action=ResearchAuditAction.AGENT_MESSAGE,
            resource_type=ResearchResourceType.AGENT_SESSION,
            resource_id=session.session_id,
            actor=request.user,
            metadata={"run_id": str(session.run_id), "content_hash": content_hash, "length": len(content)},
            request=request,
        )
        return Response(
            {
                "session": ResearchAgentSessionSerializer(session).data,
                "events": ResearchAgentRunEventSerializer([degraded], many=True).data,
            },
            status=status.HTTP_503_SERVICE_UNAVAILABLE,
        )


class ResearchAgentRunEventEndpoint(AgentPluginMixin):
    """Stable event polling for one visible run."""

    def get(self, request, slug, run_id):
        workspace, error = self.workspace_or_error(request, slug)
        if error:
            return error
        session, error = _load_session_by_run(request, workspace, run_id)
        if error:
            return error
        try:
            after_seq = int(request.GET.get("after_seq", 0))
        except (TypeError, ValueError):
            after_seq = -1
        if after_seq < 0:
            return research_error(ResearchErrorCode.AGENT_SCOPE_INVALID, "after_seq must be a non-negative integer.")
        events = session.run_events.filter(seq__gt=after_seq).order_by("seq")
        return Response(
            {
                "results": ResearchAgentRunEventSerializer(events, many=True).data,
                "count": events.count(),
                "latest_seq": events.last().seq if events.exists() else after_seq,
            }
        )


class ResearchAgentRunCancelEndpoint(AgentPluginMixin):
    """Cancel one run, close its session and revoke the context grant."""

    def post(self, request, slug, run_id):
        workspace, error = self.workspace_or_error(request, slug)
        if error:
            return error
        session, error = _load_session_by_run(
            request,
            workspace,
            run_id,
            allow_inactive_context=True,
        )
        if error:
            return error
        if session.status != ResearchAgentSession.Status.CLOSED:
            session.status = ResearchAgentSession.Status.CLOSED
            session.last_error = ""
            session.updated_by = request.user
            session.save(update_fields=["status", "last_error", "updated_by", "updated_at"])
            grant = session.context_grant
            if grant.revoked_at is None:
                grant.revoked_at = timezone.now()
                grant.updated_by = request.user
                grant.save(update_fields=["revoked_at", "updated_by", "updated_at"])
            _append_event(
                session,
                "HUMAN_DECISION",
                {"action": "run.cancel"},
                request_id_from(request) or f"cancel:{run_id}",
            )
            record_audit_event(
                workspace=workspace,
                action=ResearchAuditAction.AGENT_SESSION_CLOSE,
                resource_type=ResearchResourceType.AGENT_SESSION,
                resource_id=session.session_id,
                actor=request.user,
                metadata={"run_id": str(run_id), "mode": "run_cancel"},
                request=request,
            )
        return Response(ResearchAgentSessionSerializer(session).data)


class ResearchAgentApprovalEndpoint(AgentPluginMixin):
    """Record a human decision; execution remains fail-closed in Phase 0."""

    def post(self, request, slug, run_id):
        workspace, error = self.workspace_or_error(request, slug)
        if error:
            return error
        session, error = _load_session_by_run(request, workspace, run_id)
        if error:
            return error
        decision = str(request.data.get("decision") or "").upper()
        if decision not in ("APPROVED", "REJECTED"):
            return research_error(ResearchErrorCode.AGENT_SCOPE_INVALID, "decision must be APPROVED or REJECTED.")
        request_id = request_id_from(request)
        if not request_id:
            return research_error(ResearchErrorCode.IDEMPOTENCY_CONFLICT, "request_id is required.")

        tool_call_id = str(request.data.get("tool_call_id") or "")
        existing = ResearchAgentRunEvent.objects.select_related("session").filter(request_id=request_id).first()
        if existing is not None:
            payload_matches = (
                existing.session_id == session.pk
                and existing.event_type == "HUMAN_DECISION"
                and existing.payload.get("decision") == decision
                and existing.payload.get("tool_call_id") == tool_call_id
            )
            if not payload_matches:
                return research_conflict(
                    ResearchErrorCode.IDEMPOTENCY_CONFLICT,
                    "request_id was already used with another payload.",
                )
            return Response(
                {
                    "session": ResearchAgentSessionSerializer(session).data,
                    "event": ResearchAgentRunEventSerializer(existing).data,
                }
            )

        event = _append_event(
            session,
            "HUMAN_DECISION",
            {"decision": decision, "tool_call_id": tool_call_id},
            request_id,
        )
        session.status = ResearchAgentSession.Status.READY if decision == "APPROVED" else ResearchAgentSession.Status.ERROR
        session.updated_by = request.user
        session.save(update_fields=["status", "updated_by", "updated_at"])
        record_audit_event(
            workspace=workspace,
            action=ResearchAuditAction.AGENT_APPROVAL,
            resource_type=ResearchResourceType.AGENT_SESSION,
            resource_id=session.session_id,
            actor=request.user,
            metadata={"run_id": str(run_id), "decision": decision},
            request=request,
        )
        return Response({"session": ResearchAgentSessionSerializer(session).data, "event": ResearchAgentRunEventSerializer(event).data})


class ResearchAgentArtifactEndpoint(AgentPluginMixin):
    """Save immutable artifact metadata through the Chain snapshot projection."""

    def post(self, request, slug):
        workspace, error = self.workspace_or_error(request, slug)
        if error:
            return error
        session, error = _load_session(request, workspace, request.data.get("session_id"))
        if error:
            return error
        if session.status not in (ResearchAgentSession.Status.READY, ResearchAgentSession.Status.WAITING_APPROVAL):
            return research_error(
                ResearchErrorCode.AGENT_SCOPE_INVALID,
                "Agent session is not approved for artifact writes.",
                status.HTTP_403_FORBIDDEN,
            )
        request_id = request_id_from(request)
        if not request_id:
            return research_error(ResearchErrorCode.IDEMPOTENCY_CONFLICT, "request_id is required.")
        if ResearchChainSnapshot.objects.filter(request_id=request_id).exists():
            return Response({"idempotent": True}, status=status.HTTP_200_OK)
        version = session.chain_node.snapshots.count() + 1
        snapshot = ResearchChainSnapshot.objects.create(
            chain=session.chain_node.chain,
            node=session.chain_node,
            version=version,
            source_versions=request.data.get("source_versions") or [],
            summary=str(request.data.get("summary") or "Agent artifact"),
            created_by=request.user,
            content_hash=str(request.data.get("content_hash") or ""),
            immutable=True,
            request_id=request_id,
        )
        _append_event(session, "DATA_CHANGE", {"artifact_id": str(snapshot.snapshot_id), "snapshot_version": version}, f"artifact:{request_id}")
        record_audit_event(
            workspace=workspace,
            action=ResearchAuditAction.AGENT_ARTIFACT_SAVE,
            resource_type=ResearchResourceType.AGENT_SESSION,
            resource_id=session.session_id,
            actor=request.user,
            metadata={"snapshot_id": str(snapshot.snapshot_id), "node_id": str(session.chain_node_id)},
            request=request,
        )
        return Response({"snapshot_id": str(snapshot.snapshot_id), "version": version, "immutable": True}, status=status.HTTP_201_CREATED)


class ResearchAgentChainEventEndpoint(AgentPluginMixin):
    """Write a scoped Chain fact through the Agent BFF."""

    def post(self, request, slug):
        workspace, error = self.workspace_or_error(request, slug)
        if error:
            return error
        request_id = request_id_from(request)
        event_id = str(request.data.get("event_id") or "").strip()
        event_type = str(request.data.get("event_type") or "AI_ACTION").strip().upper()
        if not request_id or not event_id:
            return research_error(ResearchErrorCode.IDEMPOTENCY_CONFLICT, "event_id and request_id are required.")
        if event_type not in AGENT_CHAIN_EVENT_TYPES:
            return research_error(
                ResearchErrorCode.AGENT_SCOPE_INVALID,
                "event_type is not a Phase 0 research event type.",
            )
        node = _visible_node(workspace, request.user, request.data.get("chain_node_id"))
        if node is None:
            return research_error(ResearchErrorCode.AGENT_SCOPE_INVALID, "chain_node_id is invalid or not accessible.", status.HTTP_403_FORBIDDEN)
        if ResearchChainEvent.objects.filter(request_id=request_id).exists():
            return Response({"idempotent": True}, status=status.HTTP_200_OK)
        event = ResearchChainEvent.objects.create(
            chain=node.chain,
            node=node,
            event_id=event_id,
            request_id=request_id,
            actor=request.user,
            actor_type="USER",
            source_system="SYNLORA",
            event_type=event_type,
            occurred_at=timezone.now(),
            refs=request.data.get("refs") or [],
            summary=str(request.data.get("summary") or ""),
            content_hash=payload_hash(request.data),
        )
        record_audit_event(
            workspace=workspace,
            action=AGENT_CHAIN_EVENT_WRITE_ACTION,
            resource_type=AGENT_CHAIN_EVENT_RESOURCE_TYPE,
            resource_id=event.id,
            actor=request.user,
            metadata={
                "event_id": event.event_id,
                "node_id": str(node.id),
                "event_type": event_type,
                "request_id": request_id,
            },
            request=request,
        )
        return Response({"event_id": event.event_id, "schema_version": "research-event.v1"}, status=status.HTTP_201_CREATED)
