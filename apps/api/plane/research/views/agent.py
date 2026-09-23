"""Phase 0 same-origin Agent plugin BFF."""

from django.db import transaction
from django.db import IntegrityError
from django.db.models import Max
from django.utils import timezone
from rest_framework import status
from rest_framework.response import Response
from uuid import UUID

from plane.db.models import (
    ResearchAgentRunEvent,
    ResearchAgentSession,
    ResearchAnalysisResult,
    ResearchChainEvent,
    ResearchChain,
    ResearchChainNode,
    ResearchChainSnapshot,
)
from plane.research.serializers import ResearchAgentRunEventSerializer, ResearchAgentSessionSerializer
from plane.research.services.agent_orchestrator import (
    AgentAssembly,
    active_synlora_link,
    create_synlora_session,
    issue_agent_context,
    context_metadata,
)
from plane.research.services.chain_projection import project_synlora_events
from plane.research.services.synlora import SynloraClient, SynloraError
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
    "INTERMEDIATE_ARTIFACT",
    "VALIDATION",
    "VALIDATION_PASSED",
    "VALIDATION_FAILED",
    "HUMAN_DECISION",
    "APPROVAL",
    "DATA_CHANGE",
    "DEGRADED",
    "OUTPUT",
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
        try:
            orchestrated = create_synlora_session(
                workspace=workspace,
                user=request.user,
                node=node,
                request_id=request_id,
            )
        except SynloraError as exc:
            error_code = (
                ResearchErrorCode.AGENT_SCOPE_INVALID
                if exc.status_code == 403
                else ResearchErrorCode.AGENT_UPSTREAM_NOT_CONFIGURED
            )
            return research_error(error_code, exc.message, exc.status_code)
        grant = orchestrated["grant"]
        try:
            session = ResearchAgentSession.objects.create(
                workspace=workspace,
                user=request.user,
                project_id=node.chain.project_id,
                chain_node=node,
                context_grant=grant,
                status=ResearchAgentSession.Status.READY,
                synlora_session_id=orchestrated["synlora_session_id"],
                delegated_subject=orchestrated["delegated_subject"],
                assembly=orchestrated["assembly"],
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
        if session.synlora_session_id:
            link = active_synlora_link(request.user)
            if link is not None:
                try:
                    client = SynloraClient()
                    delegated = client.exchange_delegated_token(
                        account_link=link, workspace=workspace, user=request.user
                    )
                    client.close(
                        delegated_token=str(delegated.get("token") or ""),
                        session_id=session.synlora_session_id,
                    )
                except SynloraError:
                    # Closing must still revoke Plane context even if Synlora is briefly down.
                    pass
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
    """Run one Synlora message after refreshing and revalidating Context."""

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
            return Response(
                {
                    "session": ResearchAgentSessionSerializer(session).data,
                    "events": [ResearchAgentRunEventSerializer(existing).data],
                },
                status=status.HTTP_200_OK,
            )

        _append_event(
            session,
            "COMMUNICATION",
            {"direction": "user", "content_hash": content_hash, "length": len(content)},
            request_id,
        )
        try:
            link = active_synlora_link(request.user)
            if link is None:
                raise SynloraError("synlora_account_link_inactive", "Synlora AccountLink is inactive.", 403)
            client = SynloraClient()
            delegated = client.exchange_delegated_token(account_link=link, workspace=workspace, user=request.user)
            delegated_token = str(delegated.get("token") or "")
            if not delegated_token:
                raise SynloraError("synlora_delegated_auth_failed", "Synlora delegated token exchange failed.", 502)
            assembly = AgentAssembly(**session.assembly)
            grant, context_token = issue_agent_context(
                workspace=workspace,
                user=request.user,
                profile=session.project.research_profile,
                node=session.chain_node,
                assembly=assembly,
                request_id=f"message:{request_id}",
            )
            metadata = context_metadata(
                workspace=workspace,
                profile=session.project.research_profile,
                node=session.chain_node,
                grant=grant,
                assembly=assembly,
            )
            remote_events = client.send_message(
                delegated_token=delegated_token,
                session_id=session.synlora_session_id,
                context_token=context_token,
                context_metadata=metadata,
                content=content,
                request_id=request_id,
            )
            session.context_grant = grant
            session.status = ResearchAgentSession.Status.READY
            session.last_error = ""
            session.updated_by = request.user
            session.save(update_fields=["context_grant", "status", "last_error", "updated_by", "updated_at"])
            projected = project_synlora_events(session, remote_events)
            for remote in remote_events:
                remote_run = str((remote.get("payload") or {}).get("run_id") or "")
                if remote_run:
                    session.synlora_run_id = remote_run
                    session.save(update_fields=["synlora_run_id", "updated_at"])
                    break
        except SynloraError as exc:
            session.status = ResearchAgentSession.Status.DEGRADED
            session.last_error = exc.code
            session.updated_by = request.user
            session.save(update_fields=["status", "last_error", "updated_by", "updated_at"])
            degraded = _append_event(session, "DEGRADED", {"reason": exc.code}, f"degraded:{request_id}")
            record_audit_event(
                workspace=workspace,
                action=ResearchAuditAction.AGENT_MESSAGE,
                resource_type=ResearchResourceType.AGENT_SESSION,
                resource_id=session.session_id,
                actor=request.user,
                metadata={"run_id": str(session.run_id), "content_hash": content_hash, "error": exc.code},
                request=request,
            )
            return Response(
                {
                    "session": ResearchAgentSessionSerializer(session).data,
                    "events": ResearchAgentRunEventSerializer([degraded], many=True).data,
                },
                status=exc.status_code,
            )

        communication = ResearchAgentRunEvent.objects.filter(request_id=request_id).first()
        events = [event for event in (communication, *projected) if event is not None]
        record_audit_event(
            workspace=workspace,
            action=ResearchAuditAction.AGENT_MESSAGE,
            resource_type=ResearchResourceType.AGENT_SESSION,
            resource_id=session.session_id,
            actor=request.user,
            metadata={
                "run_id": str(session.run_id),
                "content_hash": content_hash,
                "synlora_session": session.synlora_session_id,
            },
            request=request,
        )
        return Response(
            {
                "session": ResearchAgentSessionSerializer(session).data,
                "events": ResearchAgentRunEventSerializer(events, many=True).data,
            },
            status=status.HTTP_200_OK,
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
        if session.synlora_session_id:
            link = active_synlora_link(request.user)
            if link is not None:
                try:
                    client = SynloraClient()
                    delegated = client.exchange_delegated_token(
                        account_link=link, workspace=workspace, user=request.user
                    )
                    remote_after = max(
                        [int(event.payload.get("remote_seq") or 0) for event in session.run_events.all()]
                        or [-1]
                    )
                    remote_page = client.events(
                        delegated_token=str(delegated.get("token") or ""),
                        session_id=session.synlora_session_id,
                        after_seq=remote_after,
                    )
                    project_synlora_events(session, remote_page)
                except SynloraError:
                    # Local events remain replayable when the cursor refresh is unavailable.
                    pass
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
            if session.synlora_run_id:
                link = active_synlora_link(request.user)
                if link is not None:
                    try:
                        client = SynloraClient()
                        delegated = client.exchange_delegated_token(
                            account_link=link, workspace=workspace, user=request.user
                        )
                        client.cancel(
                            delegated_token=str(delegated.get("token") or ""),
                            run_id=session.synlora_run_id,
                        )
                    except SynloraError:
                        # A stopped UI must still fail closed locally; Synlora can be retried later.
                        pass
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
    """Save a human-confirmed artifact as a typed immutable Chain snapshot."""

    ARTIFACT_SNAPSHOT_TYPES = {
        "RESEARCH_PLAN_DRAFT": ResearchChainSnapshot.SnapshotType.PAPER_RESEARCH,
        "LITERATURE_REFERENCE": ResearchChainSnapshot.SnapshotType.LITERATURE_REVIEW,
        "EXPERIMENT_RECORD": ResearchChainSnapshot.SnapshotType.EXPERIMENT_EXECUTION,
        "EXPERIMENT_DATA": ResearchChainSnapshot.SnapshotType.EXPERIMENT_DATA,
        "ANALYSIS_SUMMARY": ResearchChainSnapshot.SnapshotType.ANALYSIS_RESULT,
        "PROCESS_NOTE": ResearchChainSnapshot.SnapshotType.PROCESS,
    }

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
        artifact_type = str(request.data.get("artifact_type") or "").upper()
        summary = str(request.data.get("summary") or "").strip()
        confirmed = str(request.data.get("confirmed", "")).lower() in ("1", "true", "yes")
        if not request_id or artifact_type not in self.ARTIFACT_SNAPSHOT_TYPES or not summary:
            return research_error(
                ResearchErrorCode.AGENT_SCOPE_INVALID,
                "request_id, supported artifact_type and summary are required.",
            )
        if ResearchChainSnapshot.objects.filter(request_id=request_id).exists():
            return Response({"idempotent": True}, status=status.HTTP_200_OK)
        if ResearchAnalysisResult.objects.filter(request_id=request_id).exists():
            return Response({"idempotent": True, "draft": True}, status=status.HTTP_200_OK)
        if not confirmed:
            analysis = ResearchAnalysisResult.objects.create(
                workspace=workspace,
                chain=session.chain_node.chain,
                node=session.chain_node,
                method=str(request.data.get("method") or "AI draft"),
                input_refs=request.data.get("input_refs") or [],
                summary=summary,
                metrics=request.data.get("metrics") or {},
                quality=request.data.get("quality") or {},
                conclusion=str(request.data.get("conclusion") or ""),
                operator=request.user,
                tool_version=str(request.data.get("tool_version") or ""),
                status=ResearchAnalysisResult.Status.DRAFT,
                request_id=request_id,
                payload_hash=payload_hash(request.data),
                created_by=request.user,
            )
            return Response(
                {"analysis_id": str(analysis.id), "status": "DRAFT", "confirmed": False},
                status=status.HTTP_201_CREATED,
            )

        with transaction.atomic():
            ResearchChain.objects.select_for_update().get(pk=session.chain_node.chain_id)
            version = (
                session.chain_node.snapshots.aggregate(Max("version"))["version__max"] or 0
            ) + 1
            snapshot = ResearchChainSnapshot.objects.create(
                chain=session.chain_node.chain,
                node=session.chain_node,
                snapshot_type=self.ARTIFACT_SNAPSHOT_TYPES[artifact_type],
                version=version,
                source_versions=request.data.get("source_versions") or [],
                resources=request.data.get("resources") or [],
                event_range=request.data.get("event_range") or {},
                summary=summary,
                created_by=request.user,
                content_hash=str(request.data.get("content_hash") or payload_hash(request.data)),
                immutable=True,
                request_id=request_id,
            )
            if artifact_type == "ANALYSIS_SUMMARY":
                ResearchAnalysisResult.objects.create(
                    workspace=workspace,
                    chain=session.chain_node.chain,
                    node=session.chain_node,
                    method=str(request.data.get("method") or "AI assisted analysis"),
                    input_refs=request.data.get("input_refs") or [],
                    summary=summary,
                    metrics=request.data.get("metrics") or {},
                    quality=request.data.get("quality") or {},
                    conclusion=str(request.data.get("conclusion") or ""),
                    operator=request.user,
                    tool_version=str(request.data.get("tool_version") or ""),
                    status=ResearchAnalysisResult.Status.ACCEPTED,
                    request_id=request_id,
                    payload_hash=payload_hash(request.data),
                    created_by=request.user,
                )
        event = _append_event(
            session,
            "DATA_CHANGE",
            {
                "artifact_type": artifact_type,
                "artifact_id": str(snapshot.snapshot_id),
                "snapshot_version": version,
            },
            f"artifact:{request_id}",
        )
        record_audit_event(
            workspace=workspace,
            action=ResearchAuditAction.AGENT_ARTIFACT_SAVE,
            resource_type=ResearchResourceType.AGENT_SESSION,
            resource_id=session.session_id,
            actor=request.user,
            metadata={
                "snapshot_id": str(snapshot.snapshot_id),
                "snapshot_type": snapshot.snapshot_type,
                "node_id": str(session.chain_node_id),
            },
            request=request,
        )
        return Response(
            {
                "snapshot_id": str(snapshot.snapshot_id),
                "snapshot_type": snapshot.snapshot_type,
                "version": version,
                "immutable": True,
                "event": ResearchAgentRunEventSerializer(event).data,
            },
            status=status.HTTP_201_CREATED,
        )


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
