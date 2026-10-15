"""Phase 0 same-origin Agent plugin BFF."""

import hashlib
import os

from django.conf import settings as django_settings
from django.db import transaction
from django.db import IntegrityError
from django.db.models import Max, Q
from django.http import HttpResponse
from django.utils import timezone
from rest_framework import status
from rest_framework.response import Response
from uuid import UUID

from plane.db.models import (
    ResearchAgentBackendConnection,
    ResearchAgentRunEvent,
    ResearchAgentSession,
    ResearchAnalysisResult,
    ResearchChainEvent,
    ResearchChain,
    ResearchChainNode,
    ResearchChainSnapshot,
    ResearchChainUpload,
    WorkspaceResearchSetting,
)
from plane.api.middleware.api_authentication import APIKeyAuthentication
from plane.authentication.session import BaseSessionAuthentication
import httpx

from plane.license.utils.encryption import encrypt_data
from plane.research.serializers import ResearchAgentRunEventSerializer, ResearchAgentSessionSerializer
from plane.research.services.agent_orchestrator import (
    AgentAssembly,
    create_science_discovery_session,
    issue_agent_context,
)
from plane.research.services.backend_connections import (
    BackendConnectionError,
    resolve_science_discovery_connection,
    validate_backend_base_url,
)
from plane.research.services.report_context import ResearchReportContextError
from plane.research.services.agent_runtime import (
    SynloraRuntimeError,
    resolve_synlora_runtime,
)
from plane.research.services.chain_projection import project_science_discovery_events
from plane.research.services.sciencediscovery import ScienceDiscoveryClient, ScienceDiscoveryError
from plane.research.services.idempotency import conflict_response, payload_hash, request_id_from
from plane.research.utils.audit import ResearchAuditAction, ResearchResourceType, record_audit_event
from plane.research.utils.capabilities import NAV_PROJECTS
from plane.research.utils.errors import (
    ResearchErrorCode,
    research_conflict,
    research_error,
    research_not_found,
)
from plane.research.views.base import ResearchAPIView
from plane.research.views.chain_foundation import (
    _agent_scope_kind,
    _chain_readonly_error,
    _chain_writer,
    _node_operator,
)
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


def _sd_client_for_session(session):
    """Build the pinned ScienceDiscovery client for one session."""
    return ScienceDiscoveryClient(connection=session.backend_connection)


def create_synlora_runtime_session(
    *, workspace, user, node, request_id, scope_kind="OWNER", scope_source="chain_owner"
):
    """Create a cloud Synlora thread plus the same grant/assembly envelope."""
    runtime = resolve_synlora_runtime(workspace, user=user)
    if runtime is None:
        raise SynloraRuntimeError(
            "synlora_not_configured",
            "No enabled Synlora integration connection is configured for this workspace.",
            503,
        )
    assembly = AgentAssembly(
        persona="research-general",
        enabled_plugins=[],
        allowed_tools=[],
        allowed_knowledge_base_ids=[],
        allowed_file_ids=[],
        unavailable_reasons=[],
        policy_id=f"policy-{node.id}",
        scope_kind=scope_kind,
        scope_source=scope_source,
    )
    grant, _token = issue_agent_context(
        workspace=workspace,
        user=user,
        profile=node.chain.project.research_profile,
        node=node,
        assembly=assembly,
        request_id=f"agent:{request_id}",
    )
    thread_id = runtime.create_session(title=node.title or "Research agent")
    return {
        "grant": grant,
        "synlora_session_id": thread_id,
        "delegated_subject": "",
        "assembly": assembly.__dict__,
        "sd_project_id": "",
        "sd_session_id": "",
    }


def _synlora_runtime_for_session(workspace, session):
    """Build the runtime client pinned to a Synlora provider session."""
    runtime = resolve_synlora_runtime(workspace, user=session.user)
    if runtime is None:
        raise SynloraRuntimeError("synlora_not_configured", "Synlora runtime is not configured.", 503)
    return runtime

AGENT_CHAIN_EVENT_TYPES = frozenset(
    {
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
    }
)
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
    node = (
        ResearchChainNode.objects.select_related("chain__project__research_profile")
        .filter(
            pk=node_id,
            chain__workspace=workspace,
        )
        .first()
    )
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


def _session_operator(workspace, user, session):
    """Return whether the caller may operate or write through an Agent session."""
    return _chain_writer(workspace, user, session.chain_node.chain) or (
        session.context_grant.scope_kind == "REVIEW" and session.user_id == user.id
    )


def _session_scope_allows(session, action):
    """Enforce the REVIEW session's read/comment/draft-only capability boundary."""
    if session.context_grant.scope_kind != "REVIEW":
        return True
    return action in {"message", "events", "draft"}


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


def _load_session(
    request,
    workspace,
    session_id,
    *,
    allow_inactive_context=False,
    require_operator=False,
    require_active_chain=False,
):
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
    if require_operator and not _session_operator(workspace, request.user, session):
        return None, research_error(
            ResearchErrorCode.PERMISSION_DENIED,
            "Only chain members can operate this Agent session.",
            status.HTTP_403_FORBIDDEN,
        )
    if require_active_chain:
        readonly_error = _chain_readonly_error(session.chain_node.chain)
        if readonly_error:
            return None, readonly_error
    return _guard_session_context(session, allow_inactive_context=allow_inactive_context)


def _load_session_by_run(
    request,
    workspace,
    run_id,
    *,
    allow_inactive_context=False,
    require_operator=False,
    require_active_chain=False,
):
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
    if require_operator and not _session_operator(workspace, request.user, session):
        return None, research_error(
            ResearchErrorCode.PERMISSION_DENIED,
            "Only chain members can operate this Agent run.",
            status.HTTP_403_FORBIDDEN,
        )
    if require_active_chain:
        readonly_error = _chain_readonly_error(session.chain_node.chain)
        if readonly_error:
            return None, readonly_error
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
                return research_error(
                    ResearchErrorCode.IDEMPOTENCY_CONFLICT,
                    "request_id was already used with another payload.",
                    status.HTTP_409_CONFLICT,
                )
            if existing.payload_hash != payload_hash(request.data):
                return research_error(
                    ResearchErrorCode.IDEMPOTENCY_CONFLICT,
                    "request_id was already used with another payload.",
                    status.HTTP_409_CONFLICT,
                )
            return Response(ResearchAgentSessionSerializer(existing).data, status=status.HTTP_200_OK)
        node = _visible_node(workspace, request.user, request.data.get("chain_node_id"))
        if node is None:
            return research_error(
                ResearchErrorCode.AGENT_SCOPE_INVALID,
                "chain_node_id is invalid or not accessible.",
                status.HTTP_403_FORBIDDEN,
            )
        readonly_error = _chain_readonly_error(node.chain)
        if readonly_error:
            return readonly_error
        scope_kind = _agent_scope_kind(workspace, request.user, node.chain)
        if scope_kind is None:
            return research_error(
                ResearchErrorCode.PERMISSION_DENIED,
                "The current actor has no Agent scope for this research chain.",
                status.HTTP_403_FORBIDDEN,
            )
        try:
            orchestration_kwargs = {
                "workspace": workspace,
                "user": request.user,
                "node": node,
                "request_id": request_id,
            }
            if scope_kind == "REVIEW":
                orchestration_kwargs.update(
                    scope_kind="REVIEW",
                    scope_source="direct_advisor_or_main_pi",
                )
            # provider 解析（§5）：仅认「治理开关开 + 用户自配且启用」的 SD 连接，
            # 否则回落平台默认 Synlora；连接信息只来自设置页，不走环境变量。
            backend_connection = resolve_science_discovery_connection(workspace, request.user)
            if backend_connection is not None:
                orchestrated = create_science_discovery_session(
                    connection=backend_connection, **orchestration_kwargs
                )
            else:
                orchestrated = create_synlora_runtime_session(**orchestration_kwargs)
        except (SynloraRuntimeError, ScienceDiscoveryError) as exc:
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
                synlora_session_id=orchestrated.get("synlora_session_id", ""),
                provider=(
                    ResearchAgentSession.Provider.SCIENCE_DISCOVERY
                    if backend_connection is not None
                    else ResearchAgentSession.Provider.SYNLORA
                ),
                backend_connection=backend_connection,
                sd_project_id=orchestrated.get("sd_project_id", ""),
                sd_session_id=orchestrated.get("sd_session_id", ""),
                delegated_subject=orchestrated.get("delegated_subject", ""),
                assembly=orchestrated["assembly"],
                request_id=request_id,
                payload_hash=payload_hash(request.data),
                created_by=request.user,
            )
        except IntegrityError:
            return research_error(
                ResearchErrorCode.IDEMPOTENCY_CONFLICT,
                "request_id was already used with another payload.",
                status.HTTP_409_CONFLICT,
            )
        event = _append_event(session, "AI_ACTION", {"action": "session.ready"}, f"event:{request_id}")
        record_audit_event(
            workspace=workspace,
            action=ResearchAuditAction.AGENT_SESSION_CREATE,
            resource_type=ResearchResourceType.AGENT_SESSION,
            resource_id=session.session_id,
            actor=request.user,
            metadata={
                "run_id": str(session.run_id),
                "project_id": str(session.project_id),
                "chain_node_id": str(node.id),
            },
            request=request,
        )
        return Response(
            {
                **ResearchAgentSessionSerializer(session).data,
                "initial_event": ResearchAgentRunEventSerializer(event).data,
            },
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
            require_operator=True,
        )
        if error:
            return error
        if session.status == ResearchAgentSession.Status.CLOSED:
            return Response(ResearchAgentSessionSerializer(session).data)
        if session.provider == ResearchAgentSession.Provider.SYNLORA and session.synlora_session_id:
            try:
                runtime = _synlora_runtime_for_session(workspace, session)
                runtime.close_session(thread_id=session.synlora_session_id)
            except (SynloraRuntimeError, httpx.HTTPError):
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
        _append_event(
            session,
            "HUMAN_DECISION",
            {"action": "session.close"},
            request_id_from(request) or f"close:{session.session_id}",
        )
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
        session, error = _load_session(
            request,
            workspace,
            session_id,
            require_operator=True,
            require_active_chain=True,
        )
        if error:
            return error
        if session.status == ResearchAgentSession.Status.CLOSED:
            return research_error(
                ResearchErrorCode.AGENT_SCOPE_INVALID, "Agent session is closed.", status.HTTP_409_CONFLICT
            )
        request_id = request_id_from(request)
        content = str(request.data.get("content") or "").strip()
        if not request_id or not content:
            return research_error(ResearchErrorCode.AGENT_SCOPE_INVALID, "request_id and content are required.")
        from plane.research.services.report_context import (
            selected_report_content,
            content_for_grant,
            inject_report_content,
        )

        selections = request.data.get("reports", session.context_grant.allowed_reports)
        try:
            # 已授权版本先逐次检查，不允许消息过程静默换成最新版本。
            content_for_grant(session.context_grant)
            report_contents = selected_report_content(
                workspace=workspace,
                actor=request.user,
                project_id=session.project_id,
                selections=selections,
            )
        except ResearchReportContextError as failure:
            return Response({"error_code": failure.code, "message": failure.message}, status=failure.status_code)
        content_hash = (
            payload_hash({"content": content, "reports": selections})
            if selections
            else payload_hash({"content": content})
        )

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
        if session.provider == ResearchAgentSession.Provider.SCIENCE_DISCOVERY:
            # SD 异步分支：提交 run 拿号即返回，增量事件由 getEvents 轮询补齐（§6）。
            science_discovery = _sd_client_for_session(session)
            try:
                sd_run_id = science_discovery.start_run(
                    session_id=session.sd_session_id,
                    content=inject_report_content(content, report_contents),
                )
                session.sd_run_id = sd_run_id
                session.status = ResearchAgentSession.Status.STREAMING
                session.last_error = ""
                session.updated_by = request.user
                session.save(update_fields=["sd_run_id", "status", "last_error", "updated_by", "updated_at"])
            except ScienceDiscoveryError as exc:
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
                    metadata={
                        "run_id": str(session.run_id),
                        "content_hash": content_hash,
                        "error": exc.code,
                    },
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
            record_audit_event(
                workspace=workspace,
                action=ResearchAuditAction.AGENT_MESSAGE,
                resource_type=ResearchResourceType.AGENT_SESSION,
                resource_id=session.session_id,
                actor=request.user,
                metadata={
                    "run_id": str(session.run_id),
                    "content_hash": content_hash,
                    "sd_session": session.sd_session_id,
                    "sd_run": sd_run_id,
                },
                request=request,
            )
            return Response(
                {
                    "session": ResearchAgentSessionSerializer(session).data,
                    "events": ResearchAgentRunEventSerializer(
                        [communication] if communication is not None else [], many=True
                    ).data,
                },
                status=status.HTTP_200_OK,
            )
        # Synlora 异步分支：提交 run 拿号即返回，增量事件由 getEvents 轮询拉取并投影。
        try:
            runtime = _synlora_runtime_for_session(workspace, session)
            synlora_run_id = runtime.start_run(
                thread_id=session.synlora_session_id,
                content=inject_report_content(content, report_contents),
                request_id=request_id,
            )
            session.synlora_run_id = synlora_run_id
            session.status = ResearchAgentSession.Status.STREAMING
            session.last_error = ""
            session.updated_by = request.user
            session.save(update_fields=["synlora_run_id", "status", "last_error", "updated_by", "updated_at"])
        except SynloraRuntimeError as exc:
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
        events = [communication] if communication is not None else []
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


class ResearchAgentSessionFileEndpoint(AgentPluginMixin):
    """Upload one analysis file into the session's ScienceDiscovery workspace."""

    def post(self, request, slug, session_id):
        workspace, error = self.workspace_or_error(request, slug)
        if error:
            return error
        session, error = _load_session(
            request,
            workspace,
            session_id,
            require_operator=True,
            require_active_chain=True,
        )
        if error:
            return error
        if session.provider != ResearchAgentSession.Provider.SCIENCE_DISCOVERY:
            return research_error(
                ResearchErrorCode.AGENT_SCOPE_INVALID,
                "File upload requires a ScienceDiscovery session.",
                status.HTTP_409_CONFLICT,
            )
        if session.status == ResearchAgentSession.Status.CLOSED:
            return research_error(
                ResearchErrorCode.AGENT_SCOPE_INVALID, "Agent session is closed.", status.HTTP_409_CONFLICT
            )
        request_id = request_id_from(request)
        if not request_id:
            return research_error(ResearchErrorCode.IDEMPOTENCY_CONFLICT, "request_id is required.")
        uploaded_file = request.FILES.get("file")
        if uploaded_file is None or not uploaded_file.size:
            return research_error(ResearchErrorCode.AGENT_SCOPE_INVALID, "A non-empty file field is required.")
        max_bytes = int(
            getattr(django_settings, "SCIENCE_DISCOVERY_MAX_UPLOAD_BYTES", 104857600),
        )
        if uploaded_file.size > max_bytes:
            return research_error(
                ResearchErrorCode.FILE_SIZE_EXCEEDED,
                f"The analysis file exceeds the {max_bytes // 1048576}MB ScienceDiscovery limit.",
                status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            )
        file_bytes = uploaded_file.read()
        file_hash = hashlib.sha256(file_bytes).hexdigest()
        file_name = os.path.basename(str(uploaded_file.name or "upload.bin"))[:500]
        extension = os.path.splitext(file_name)[1].lstrip(".").lower()[:16] or "bin"

        existing = ResearchChainUpload.objects.filter(request_id=request_id).first()
        if existing is not None:
            if existing.file_hash != file_hash or existing.file_name != file_name:
                return research_conflict(
                    ResearchErrorCode.IDEMPOTENCY_CONFLICT,
                    "request_id was already used with another payload.",
                )
            return Response({"idempotent": True, "sd_path": existing.external_upload_id}, status=status.HTTP_200_OK)

        client = _sd_client_for_session(session)
        if not client.configured:
            return research_error(
                ResearchErrorCode.AGENT_UPSTREAM_NOT_CONFIGURED,
                "ScienceDiscovery runtime is not configured.",
                status.HTTP_503_SERVICE_UNAVAILABLE,
            )
        try:
            result = client.upload_workspace_file(
                session_id=session.sd_session_id,
                file_name=file_name,
                content=file_bytes,
            )
        except ScienceDiscoveryError as exc:
            return Response({"error_code": exc.code, "message": exc.message}, status=exc.status_code)
        items = result.get("uploaded") if isinstance(result, dict) else None
        item = items[0] if isinstance(items, list) and items else {}
        item = item if isinstance(item, dict) else {}
        sd_status = str(item.get("status") or "")
        sd_path = str(item.get("path") or "")
        sd_hash = str(item.get("hash") or "")
        if sd_status == "failed" or not sd_path:
            sd_error = str(item.get("error") or "ScienceDiscovery rejected the upload.")
            return research_error(
                ResearchErrorCode.AGENT_UPSTREAM_NOT_CONFIGURED,
                sd_error,
                status.HTTP_502_BAD_GATEWAY,
            )
        # 哈希对账：SD 收到的字节必须与 Plane 记录逐字节一致（§9）。
        if sd_hash and sd_hash != file_hash:
            return research_error(
                ResearchErrorCode.AGENT_UPSTREAM_NOT_CONFIGURED,
                "ScienceDiscovery upload hash mismatch; the file was not recorded.",
                status.HTTP_502_BAD_GATEWAY,
            )

        upload = ResearchChainUpload.objects.create(
            workspace=workspace,
            chain=session.chain_node.chain,
            node=session.chain_node,
            request_id=request_id,
            payload_hash=file_hash,
            external_upload_id=sd_path,
            file_name=file_name,
            file_type=extension,
            file_size=uploaded_file.size,
            file_hash=file_hash,
            status=ResearchChainUpload.Status.SUCCESS,
            metadata={
                "provider": ResearchAgentSession.Provider.SCIENCE_DISCOVERY,
                "sd_session_id": session.sd_session_id,
                "sd_hash": sd_hash,
                "sd_status": sd_status,
            },
            created_by=request.user,
        )
        event = _append_event(
            session,
            "DATA_CHANGE",
            {
                "action": "workspace.upload",
                "file_name": file_name,
                "file_size": uploaded_file.size,
                "file_hash": file_hash,
                "sd_hash": sd_hash,
                "sd_path": sd_path,
            },
            f"sdfile:{request_id}",
        )
        chain_request_id = f"chain:sdfile:{request_id}"
        ResearchChainEvent.objects.create(
            chain=session.chain_node.chain,
            node=session.chain_node,
            event_id=payload_hash({"request_id": chain_request_id}),
            request_id=chain_request_id,
            actor=request.user,
            actor_type="USER",
            source_system="SCIENCE_DISCOVERY",
            event_type="DATA_CHANGE",
            occurred_at=timezone.now(),
            refs=[{"kind": "chain_upload", "id": str(upload.id), "hash": file_hash}],
            summary=f"上传分析文件 {file_name}",
            content_hash=file_hash,
        )
        record_audit_event(
            workspace=workspace,
            action=ResearchAuditAction.AGENT_MESSAGE,
            resource_type=ResearchResourceType.AGENT_SESSION,
            resource_id=session.session_id,
            actor=request.user,
            metadata={
                "run_id": str(session.run_id),
                "file_name": file_name,
                "file_hash": file_hash,
                "sd_path": sd_path,
                "mode": "sd_workspace_upload",
            },
            request=request,
        )
        return Response(
            {
                "upload": {"file_name": file_name, "file_hash": file_hash, "sd_path": sd_path},
                "event": ResearchAgentRunEventSerializer(event).data,
            },
            status=status.HTTP_201_CREATED,
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
        if (
            session.provider == ResearchAgentSession.Provider.SYNLORA
            and session.synlora_session_id
            and session.synlora_run_id
            and session.status == ResearchAgentSession.Status.STREAMING
        ):
            # Synlora 分支：按游标有界拉取 SSE，翻译成 SD 事件词汇后共用同一投影器。
            try:
                runtime = _synlora_runtime_for_session(workspace, session)
                last_event = (
                    session.run_events.order_by("-seq")
                    .values_list("payload", flat=True)
                    .first()
                )
                cursor = (last_event or {}).get("remote_event_id")
                sequence_base = max(
                    [
                        int((e or {}).get("remote_seq") or 0)
                        for e in session.run_events.values_list("payload", flat=True)
                    ]
                    or [0]
                )
                events_batch, cursor_after, terminal = runtime.pull_events(
                    run_id=session.synlora_run_id,
                    last_event_id=cursor,
                    sequence_base=sequence_base,
                )
                if events_batch:
                    for entry in events_batch:
                        entry["event"]["remote_event_id"] = cursor_after
                    project_science_discovery_events(session, events_batch, source_system="SYNLORA")
                    session.refresh_from_db()
                if terminal == "interrupted":
                    session.status = ResearchAgentSession.Status.WAITING_APPROVAL
                    session.save(update_fields=["status", "updated_at"])
            except (SynloraRuntimeError, ScienceDiscoveryError):
                # Local events remain replayable when the cursor refresh is unavailable.
                pass
        elif (
            session.provider == ResearchAgentSession.Provider.SCIENCE_DISCOVERY
            and session.sd_session_id
            and session.sd_run_id
        ):
            client = _sd_client_for_session(session)
            if client.configured:
                try:
                    remote_after = max(
                        [int(event.payload.get("remote_seq") or 0) for event in session.run_events.all()] or [-1]
                    )
                    remote_page = client.events(
                        session_id=session.sd_session_id,
                        run_id=session.sd_run_id,
                        after_seq=remote_after,
                    )
                    project_science_discovery_events(session, remote_page)
                    session.refresh_from_db()
                except ScienceDiscoveryError:
                    # 本地事件仍可重放；下次轮询会继续尝试补齐远端游标。
                    pass
        events = session.run_events.filter(seq__gt=after_seq).order_by("seq")
        response_data = {
            "results": ResearchAgentRunEventSerializer(events, many=True).data,
            "count": events.count(),
            "latest_seq": events.last().seq if events.exists() else after_seq,
        }
        if session.provider in (
            ResearchAgentSession.Provider.SCIENCE_DISCOVERY,
            ResearchAgentSession.Provider.SYNLORA,
        ):
            # 异步链路（SD/Synlora）随轮询回传最新会话状态，驱动前端收敛（§6.1）。
            response_data["session"] = ResearchAgentSessionSerializer(session).data
        return Response(response_data)


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
            require_operator=True,
        )
        if error:
            return error
        if session.status != ResearchAgentSession.Status.CLOSED:
            if (
                session.provider == ResearchAgentSession.Provider.SCIENCE_DISCOVERY
                and session.sd_session_id
                and session.sd_run_id
            ):
                client = _sd_client_for_session(session)
                if client.configured:
                    try:
                        client.cancel(session_id=session.sd_session_id, run_id=session.sd_run_id)
                    except ScienceDiscoveryError:
                        # 本地仍 fail-closed 关闭；远端取消由 SD 队列终态兜底。
                        pass
            if (
                session.provider == ResearchAgentSession.Provider.SYNLORA
                and session.synlora_run_id
            ):
                try:
                    runtime = _synlora_runtime_for_session(workspace, session)
                    runtime.cancel(run_id=session.synlora_run_id)
                except (SynloraRuntimeError, httpx.HTTPError):
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


def _agent_approval_projection(session):
    """Build one safe Agent approval card from a waiting session.

    Args:
        session: A waiting Agent session selected with project and node relations.

    Returns:
        A JSON-safe dictionary containing only queue and UI context fields.
    """
    latest_tool = session.run_events.filter(event_type__in=["TOOL_CALL", "AI_ACTION"]).order_by("-seq").first()
    payload = latest_tool.payload if latest_tool else {}
    tool_call_id = str(payload.get("tool_call_id") or "")
    if not tool_call_id and latest_tool is not None:
        tool_call_id = str(latest_tool.seq)
    summary = next(
        (
            str(value)
            for value in (
                payload.get("input_summary"),
                payload.get("query"),
                payload.get("summary"),
                payload.get("action"),
            )
            if value
        ),
        session.chain_node.title,
    )
    return {
        "session_id": str(session.session_id),
        "run_id": str(session.run_id),
        "workspace": str(session.workspace_id),
        "user": str(session.user_id),
        "user_detail": {
            "id": str(session.user.id),
            "email": session.user.email,
            "first_name": session.user.first_name,
            "last_name": session.user.last_name,
            "display_name": session.user.display_name,
            "avatar": session.user.avatar,
            "avatar_url": session.user.avatar_url,
            "is_active": session.user.is_active,
        },
        "project": str(session.project_id),
        "project_name": session.project.name,
        "chain": str(session.chain_node.chain_id),
        "chain_node": str(session.chain_node_id),
        "chain_node_title": session.chain_node.title,
        "status": session.status,
        "tool_call_id": tool_call_id,
        "summary": summary,
        "risk_level": str(payload.get("risk_level") or ""),
        "capability_scope": str(payload.get("capability_scope") or payload.get("scope") or ""),
        "created_at": session.created_at,
        "updated_at": session.updated_at,
    }


class ResearchAgentApprovalListEndpoint(AgentPluginMixin):
    """List waiting Agent approvals for Chain nodes this caller can operate."""

    def get(self, request, slug):
        workspace, error = self.workspace_or_error(request, slug)
        if error:
            return error
        sessions = (
            ResearchAgentSession.objects.select_related(
                "workspace",
                "user",
                "project",
                "chain_node__chain",
                "context_grant",
            )
            .filter(
                workspace=workspace,
                status=ResearchAgentSession.Status.WAITING_APPROVAL,
                deleted_at__isnull=True,
                context_grant__revoked_at__isnull=True,
                context_grant__expires_at__gt=timezone.now(),
            )
            .order_by("-updated_at")
        )
        results = []
        for session in sessions:
            if _chain_readonly_error(session.chain_node.chain) is not None:
                continue
            if not _session_operator(workspace, request.user, session):
                continue
            results.append(_agent_approval_projection(session))
        return Response({"results": results, "count": len(results)})


class ResearchAgentApprovalEndpoint(AgentPluginMixin):
    """Record a human decision; execution remains fail-closed in Phase 0."""

    def post(self, request, slug, run_id):
        workspace, error = self.workspace_or_error(request, slug)
        if error:
            return error
        session, error = _load_session_by_run(
            request,
            workspace,
            run_id,
            require_operator=True,
            require_active_chain=True,
        )
        if error:
            return error
        if session.context_grant.scope_kind == "REVIEW":
            return research_error(
                ResearchErrorCode.PERMISSION_DENIED,
                "Review Agent sessions cannot approve tool calls.",
                status.HTTP_403_FORBIDDEN,
            )
        decision = str(request.data.get("decision") or "").upper()
        if decision not in ("APPROVED", "APPROVED_ALWAYS", "REJECTED"):
            return research_error(
                ResearchErrorCode.AGENT_SCOPE_INVALID,
                "decision must be APPROVED, APPROVED_ALWAYS or REJECTED.",
            )
        request_id = request_id_from(request)
        if not request_id:
            return research_error(ResearchErrorCode.IDEMPOTENCY_CONFLICT, "request_id is required.")

        tool_call_id = str(request.data.get("tool_call_id") or "")
        reason = str(request.data.get("reason") or "").strip()
        existing = ResearchAgentRunEvent.objects.select_related("session").filter(request_id=request_id).first()
        if existing is not None:
            payload_matches = (
                existing.session_id == session.pk
                and existing.event_type == "HUMAN_DECISION"
                and existing.payload.get("decision") == decision
                and existing.payload.get("tool_call_id") == tool_call_id
                and existing.payload.get("reason") == reason
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

        # SD 审批桥接：把 Plane 三值决策翻译成 SD adapter 枚举并转发（§7）。
        if session.provider == ResearchAgentSession.Provider.SCIENCE_DISCOVERY:
            sd_decision = {
                "APPROVED": "allow_once",
                "APPROVED_ALWAYS": "allow_matching",
                "REJECTED": "deny",
            }.get(decision)
            approval_event = (
                session.run_events.filter(event_type="APPROVAL", payload__remote_type="permission.required")
                .order_by("-seq")
                .first()
            )
            request_payload = (approval_event.payload or {}).get("request") if approval_event else None
            sd_request_id = str((request_payload or {}).get("id") or "") if isinstance(request_payload, dict) else ""
            if not sd_request_id:
                return research_error(
                    ResearchErrorCode.AGENT_SCOPE_INVALID,
                    "No pending ScienceDiscovery approval request.",
                    status.HTTP_409_CONFLICT,
                )
            client = _sd_client_for_session(session)
            if not client.configured:
                return research_error(
                    ResearchErrorCode.AGENT_UPSTREAM_NOT_CONFIGURED,
                    "ScienceDiscovery runtime is not configured.",
                    status.HTTP_503_SERVICE_UNAVAILABLE,
                )
            try:
                client.answer_approval(request_id=sd_request_id, decision=sd_decision)
            except ScienceDiscoveryError as exc:
                return Response({"error_code": exc.code, "message": exc.message}, status=exc.status_code)
        elif session.provider == ResearchAgentSession.Provider.SYNLORA and session.synlora_run_id:
            # Synlora 审批桥接：interrupt 的 run 通过 resume 决策继续执行。
            try:
                runtime = _synlora_runtime_for_session(workspace, session)
                runtime.resume(
                    run_id=session.synlora_run_id,
                    approved=decision in ("APPROVED", "APPROVED_ALWAYS"),
                    request_id=request_id,
                )
            except (SynloraRuntimeError, httpx.HTTPError) as exc:
                code = getattr(exc, "code", "synlora_resume_failed")
                return Response({"error_code": code, "message": "Synlora resume failed."}, status=502)

        event = _append_event(
            session,
            "HUMAN_DECISION",
            {"decision": decision, "tool_call_id": tool_call_id, "reason": reason},
            request_id,
        )
        if session.provider in (
            ResearchAgentSession.Provider.SCIENCE_DISCOVERY,
            ResearchAgentSession.Provider.SYNLORA,
        ):
            # 异步 run 在审批后继续执行：回到 STREAMING，终态由轮询收敛（§6.1）。
            session.status = ResearchAgentSession.Status.STREAMING
        else:
            session.status = (
                ResearchAgentSession.Status.READY if decision == "APPROVED" else ResearchAgentSession.Status.ERROR
            )
        session.updated_by = request.user
        session.save(update_fields=["status", "updated_by", "updated_at"])
        record_audit_event(
            workspace=workspace,
            action=ResearchAuditAction.AGENT_APPROVAL,
            resource_type=ResearchResourceType.AGENT_SESSION,
            resource_id=session.session_id,
            actor=request.user,
            metadata={"run_id": str(run_id), "decision": decision, "reason": reason},
            request=request,
        )
        return Response(
            {
                "session": ResearchAgentSessionSerializer(session).data,
                "event": ResearchAgentRunEventSerializer(event).data,
            }
        )


class ResearchAgentBackendConnectionEndpoint(AgentPluginMixin):
    """Read or upsert the caller's self-service ScienceDiscovery connection (§5)."""

    def _governance_enabled(self, workspace):
        setting = WorkspaceResearchSetting.objects.filter(workspace=workspace).first()
        return bool(setting and setting.research_agent_user_backend_enabled)

    def get(self, request, slug):
        workspace, error = self.workspace_or_error(request, slug)
        if error:
            return error
        system = str(request.query_params.get("system") or "SCIENCE_DISCOVERY").upper()
        connection = ResearchAgentBackendConnection.objects.filter(
            workspace=workspace, user=request.user, system=system, deleted_at__isnull=True
        ).first()
        return Response(
            {
                "connection": (
                    {
                        "id": str(connection.id),
                        "system": connection.system,
                        "base_url": connection.base_url,
                        "is_enabled": connection.is_enabled,
                        "has_credential": bool(connection.credential_encrypted),
                        "health_status": connection.health_status,
                        "last_health_at": connection.last_health_at,
                        "last_error": connection.last_error,
                    }
                    if connection is not None
                    else None
                ),
                "governance_enabled": self._governance_enabled(workspace),
            }
        )

    def post(self, request, slug):
        workspace, error = self.workspace_or_error(request, slug)
        if error:
            return error
        system = str(request.data.get("system") or "SCIENCE_DISCOVERY").upper()
        if system not in ("SCIENCE_DISCOVERY", "SYNLORA"):
            return research_error(ResearchErrorCode.AGENT_SCOPE_INVALID, "Unknown agent system.")
        base_url = str(request.data.get("base_url") or "").strip().rstrip("/")
        token = str(request.data.get("token") or "").strip()
        raw_enabled = request.data.get("is_enabled", True)
        is_enabled = (
            raw_enabled
            if isinstance(raw_enabled, bool)
            else str(raw_enabled).strip().lower() in ("1", "true", "yes", "on")
        )
        # SD 需要用户自填完整地址；云端 Synlora 个人凭证可留空地址（回落平台统一地址）。
        if system == "SCIENCE_DISCOVERY":
            if not base_url:
                return research_error(ResearchErrorCode.AGENT_SCOPE_INVALID, "base_url is required.")
            try:
                validate_backend_base_url(base_url)
            except BackendConnectionError as exc:
                return research_error(ResearchErrorCode.AGENT_SCOPE_INVALID, str(exc), status.HTTP_400_BAD_REQUEST)
        elif not base_url and not token:
            return research_error(ResearchErrorCode.AGENT_SCOPE_INVALID, "token or base_url is required.")
        connection = (
            ResearchAgentBackendConnection.objects.filter(
                workspace=workspace, user=request.user, system=system, deleted_at__isnull=True
            )
            .order_by("-created_at")
            .first()
        )
        if connection is None:
            existing_row = ResearchAgentBackendConnection.objects.filter(
                workspace=workspace, user=request.user, system=system
            ).order_by("-created_at").first()
            if not token and not (existing_row and existing_row.credential_encrypted):
                return research_error(ResearchErrorCode.AGENT_SCOPE_INVALID, "token is required.")
            connection = ResearchAgentBackendConnection.objects.create(
                workspace=workspace,
                user=request.user,
                system=system,
                base_url=base_url,
                credential_encrypted=encrypt_data(token) if token else "",
                is_enabled=is_enabled,
                created_by=request.user,
            )
        else:
            if base_url or system == "SCIENCE_DISCOVERY":
                connection.base_url = base_url
            if token:
                connection.credential_encrypted = encrypt_data(token)
            connection.is_enabled = is_enabled
            connection.health_status = ResearchAgentBackendConnection.HealthStatus.UNKNOWN
            connection.updated_by = request.user
            connection.save(
                update_fields=[
                    "base_url",
                    "credential_encrypted",
                    "is_enabled",
                    "health_status",
                    "updated_by",
                    "updated_at",
                ]
            )
        record_audit_event(
            workspace=workspace,
            action=ResearchAuditAction.AGENT_SESSION_CREATE,
            resource_type=ResearchResourceType.AGENT_SESSION,
            resource_id=str(connection.id),
            actor=request.user,
            metadata={"connection_id": str(connection.id), "base_url": base_url},
            request=request,
        )
        return Response(
            {
                "id": str(connection.id),
                "base_url": connection.base_url,
                "is_enabled": connection.is_enabled,
                "has_credential": bool(connection.credential_encrypted),
                "governance_enabled": self._governance_enabled(workspace),
            },
            status=status.HTTP_201_CREATED,
        )

    def delete(self, request, slug):
        workspace, error = self.workspace_or_error(request, slug)
        if error:
            return error
        system = str(request.query_params.get("system") or "SCIENCE_DISCOVERY").upper()
        connection = ResearchAgentBackendConnection.objects.filter(
            workspace=workspace, user=request.user, system=system, deleted_at__isnull=True
        ).first()
        if connection is not None:
            # Retain credential material for historical sessions pinned to this
            # connection; soft-deletion excludes it from new sessions and permits
            # a replacement connection for the same member and workspace.
            connection.delete()
        return Response(status=status.HTTP_204_NO_CONTENT)


class ResearchAgentBackendConnectionTestEndpoint(AgentPluginMixin):
    """Probe the caller's stored connection via ``GET /api/models`` (§5)."""

    def post(self, request, slug):
        workspace, error = self.workspace_or_error(request, slug)
        if error:
            return error
        connection = ResearchAgentBackendConnection.objects.filter(
            workspace=workspace, user=request.user
        ).first()
        if connection is None:
            return research_error(
                ResearchErrorCode.AGENT_SCOPE_INVALID, "No ScienceDiscovery connection is configured."
            )
        client = ScienceDiscoveryClient(connection=connection)
        if not client.configured:
            return research_error(
                ResearchErrorCode.AGENT_SCOPE_INVALID, "The connection has no stored credential."
            )
        models = []
        try:
            models = client.list_models()
            connection.health_status = ResearchAgentBackendConnection.HealthStatus.OK
            connection.last_error = ""
        except ScienceDiscoveryError as exc:
            connection.health_status = ResearchAgentBackendConnection.HealthStatus.DOWN
            connection.last_error = exc.message[:255]
        finally:
            connection.last_health_at = timezone.now()
            connection.updated_by = request.user
            connection.save(
                update_fields=[
                    "health_status",
                    "last_error",
                    "last_health_at",
                    "updated_by",
                    "updated_at",
                ]
            )
        if connection.health_status == ResearchAgentBackendConnection.HealthStatus.OK:
            return Response({"ok": True, "models": len(models or [])})
        return Response({"ok": False, "error": connection.last_error}, status=status.HTTP_502_BAD_GATEWAY)


class ResearchAgentSessionArtifactListEndpoint(AgentPluginMixin):
    """Proxy the ScienceDiscovery session artifact list (§8 第二层)."""

    def get(self, request, slug, session_id):
        workspace, error = self.workspace_or_error(request, slug)
        if error:
            return error
        session, error = _load_session(request, workspace, session_id)
        if error:
            return error
        if session.provider != ResearchAgentSession.Provider.SCIENCE_DISCOVERY:
            return research_error(
                ResearchErrorCode.AGENT_SCOPE_INVALID,
                "Artifact listing requires a ScienceDiscovery session.",
                status.HTTP_409_CONFLICT,
            )
        client = _sd_client_for_session(session)
        if not client.configured:
            return research_error(
                ResearchErrorCode.AGENT_UPSTREAM_NOT_CONFIGURED,
                "ScienceDiscovery runtime is not configured.",
                status.HTTP_503_SERVICE_UNAVAILABLE,
            )
        try:
            artifacts = client.list_artifacts(session_id=session.sd_session_id)
        except ScienceDiscoveryError as exc:
            return Response({"error_code": exc.code, "message": exc.message}, status=exc.status_code)
        return Response({"results": artifacts if isinstance(artifacts, list) else [], "count": len(artifacts or [])})


class ResearchAgentSessionArtifactContentEndpoint(AgentPluginMixin):
    """Proxy one artifact version's bytes; Plane never stores the content."""

    def get(self, request, slug, session_id, version_id):
        workspace, error = self.workspace_or_error(request, slug)
        if error:
            return error
        session, error = _load_session(request, workspace, session_id)
        if error:
            return error
        if session.provider != ResearchAgentSession.Provider.SCIENCE_DISCOVERY:
            return research_error(
                ResearchErrorCode.AGENT_SCOPE_INVALID,
                "Artifact content requires a ScienceDiscovery session.",
                status.HTTP_409_CONFLICT,
            )
        # 越权防线：vid 必须在本会话事件流中出现过，防止取别家会话的产物（§8）。
        seen = session.run_events.filter(
            event_type="INTERMEDIATE_ARTIFACT",
            payload__version__id=version_id,
        ).exists()
        if not seen:
            return research_not_found(ResearchErrorCode.AGENT_SCOPE_INVALID, "Artifact version not found.")
        client = _sd_client_for_session(session)
        if not client.configured:
            return research_error(
                ResearchErrorCode.AGENT_UPSTREAM_NOT_CONFIGURED,
                "ScienceDiscovery runtime is not configured.",
                status.HTTP_503_SERVICE_UNAVAILABLE,
            )
        try:
            content, media_type = client.artifact_content(
                session_id=session.sd_session_id,
                version_id=version_id,
            )
        except ScienceDiscoveryError as exc:
            return Response({"error_code": exc.code, "message": exc.message}, status=exc.status_code)
        response = HttpResponse(content, content_type=media_type)
        artifact_name = ""
        event = session.run_events.filter(event_type="INTERMEDIATE_ARTIFACT", payload__version__id=version_id).order_by(
            "-seq"
        ).first()
        if event is not None:
            artifact = (event.payload or {}).get("artifact")
            artifact_name = str((artifact or {}).get("name") or "") if isinstance(artifact, dict) else ""
        if artifact_name:
            response["Content-Disposition"] = f'attachment; filename="{artifact_name[:120]}"'
        return response


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
        session, error = _load_session(
            request,
            workspace,
            request.data.get("session_id"),
            require_operator=True,
            require_active_chain=True,
        )
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
        if confirmed and not _session_scope_allows(session, "artifact"):
            return research_error(
                ResearchErrorCode.PERMISSION_DENIED,
                "Review Agent sessions can save analysis drafts but cannot create immutable artifacts.",
                status.HTTP_403_FORBIDDEN,
            )
        if not request_id or artifact_type not in self.ARTIFACT_SNAPSHOT_TYPES or not summary:
            return research_error(
                ResearchErrorCode.AGENT_SCOPE_INVALID,
                "request_id, supported artifact_type and summary are required.",
            )
        digest = payload_hash(request.data)
        existing_snapshot = ResearchChainSnapshot.objects.filter(request_id=request_id).first()
        if existing_snapshot is not None:
            if existing_snapshot.node_id != session.chain_node_id or existing_snapshot.content_hash != digest:
                return conflict_response()
            return Response({"idempotent": True}, status=status.HTTP_200_OK)
        existing_analysis = ResearchAnalysisResult.objects.filter(request_id=request_id).first()
        if existing_analysis is not None:
            if existing_analysis.node_id != session.chain_node_id or existing_analysis.payload_hash != digest:
                return conflict_response()
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
                payload_hash=digest,
                created_by=request.user,
            )
            return Response(
                {"analysis_id": str(analysis.id), "status": "DRAFT", "confirmed": False},
                status=status.HTTP_201_CREATED,
            )

        with transaction.atomic():
            ResearchChain.objects.select_for_update().get(pk=session.chain_node.chain_id)
            version = (session.chain_node.snapshots.aggregate(Max("version"))["version__max"] or 0) + 1
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
                content_hash=digest,
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
                    payload_hash=digest,
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

    authentication_classes = [BaseSessionAuthentication, APIKeyAuthentication]

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
            return research_error(
                ResearchErrorCode.AGENT_SCOPE_INVALID,
                "chain_node_id is invalid or not accessible.",
                status.HTTP_403_FORBIDDEN,
            )
        readonly_error = _chain_readonly_error(node.chain)
        if readonly_error:
            return readonly_error
        if not _node_operator(workspace, request.user, node):
            return research_error(
                ResearchErrorCode.PERMISSION_DENIED,
                "Only chain members can append Agent events.",
                status.HTTP_403_FORBIDDEN,
            )
        digest = payload_hash(request.data)
        existing_event = ResearchChainEvent.objects.filter(Q(request_id=request_id) | Q(event_id=event_id)).first()
        if existing_event is not None:
            if existing_event.node_id != node.id or existing_event.content_hash != digest:
                return conflict_response()
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
            content_hash=digest,
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
        return Response(
            {"event_id": event.event_id, "schema_version": "research-event.v1"}, status=status.HTTP_201_CREATED
        )
