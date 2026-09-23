"""Agent plugin manifest, scope, lifecycle and fail-closed BFF tests."""

from hashlib import sha256
from uuid import uuid4

import pytest
from django.utils import timezone
from rest_framework.test import APIClient

from plane.db.models import (
    AccountLink,
    Project,
    ResearchAgentSession,
    ResearchAgentRunEvent,
    ResearchAuditEvent,
    ResearchAnalysisResult,
    ResearchChain,
    ResearchChainEvent,
    ResearchChainNode,
    ResearchChainSnapshot,
    ResearchContextGrant,
    ResearchProjectProfile,
    ResearchUserProfile,
    WorkspaceResearchSetting,
)
from plane.research.services.agent_orchestrator import AgentAssembly, context_metadata, issue_agent_context
from plane.research.services.chain_projection import project_synlora_events
from plane.research.views import agent as agent_view
from plane.tests.research_fixtures import add_workspace_member, enable_research, make_user, make_workspace

pytestmark = pytest.mark.contract


def _client(user):
    client = APIClient()
    client.force_authenticate(user=user)
    return client


def _hash(value):
    return sha256(str(value).encode()).hexdigest()


@pytest.fixture
def env(db, settings):
    settings.RESEARCH_MODULE_ENABLED = True
    owner = make_user(first_name="Agent owner")
    other = make_user(first_name="Other member")
    workspace = make_workspace(owner)
    add_workspace_member(workspace, other)
    enable_research(workspace, research_agent_enabled=True, research_chain_enabled=True)
    suffix = uuid4().hex[:6]
    project = Project.objects.create(
        workspace=workspace,
        name=f"Agent project {suffix}",
        identifier=f"AG{suffix}",
        network=0,
        created_by=owner,
    )
    profile = ResearchProjectProfile.objects.create(project=project, workspace=workspace, owner=owner, created_by=owner)
    chain = ResearchChain.objects.create(
        project=project,
        workspace=workspace,
        owner=owner,
        request_id=f"chain-{uuid4().hex}",
        payload_hash=_hash("chain"),
        created_by=owner,
    )
    node = ResearchChainNode.objects.create(
        chain=chain,
        node_type="GENERAL_RESEARCH",
        title="Agent node",
        request_id=f"node-{uuid4().hex}",
        payload_hash=_hash("node"),
        created_by=owner,
    )
    AccountLink.objects.create(
        local_user=owner,
        provider="SYNLORA",
        canonical_identity=f"synlora-{uuid4().hex}",
        external_subject=f"u_{uuid4().hex[:12]}",
        status=AccountLink.Status.ACTIVE,
        verified_at=timezone.now(),
        request_id=f"link-{uuid4().hex}",
        payload_hash=_hash("link"),
        created_by=owner,
    )
    return {
        "owner": owner,
        "other": other,
        "workspace": workspace,
        "project": project,
        "profile": profile,
        "chain": chain,
        "node": node,
        "client": _client(owner),
        "other_client": _client(other),
    }


@pytest.fixture(autouse=True)
def synlora_orchestration(env, monkeypatch):
    """Provide a deterministic in-process Synlora contract fixture."""

    def fake_create_synlora_session(*, workspace, user, node, request_id, client=None):
        assembly = AgentAssembly(
            persona="research-general",
            enabled_plugins=[],
            allowed_tools=["knowledge.search", "knowledge.list", "file.read"],
            allowed_knowledge_base_ids=["kb-1"],
            allowed_file_ids=[],
            unavailable_reasons=[],
            policy_id=f"plane-node:{node.id}",
        )
        grant, _token = issue_agent_context(
            workspace=workspace,
            user=user,
            profile=node.chain.project.research_profile,
            node=node,
            assembly=assembly,
            request_id=f"agent:{request_id}",
        )
        metadata = context_metadata(
            workspace=workspace,
            profile=node.chain.project.research_profile,
            node=node,
            grant=grant,
            assembly=assembly,
        )
        return {
            "grant": grant,
            "context_metadata": metadata,
            "delegated_token": "delegated-token",
            "delegated_subject": "u_synlora",
            "synlora_session_id": f"synlora-{request_id[:12]}",
            "assembly": assembly.__dict__,
        }

    class FakeSynloraClient:
        def exchange_delegated_token(self, **_kwargs):
            return {"token": "delegated-token", "subject": "u_synlora"}

        def send_message(self, **_kwargs):
            return [
                {"seq": 1, "type": "turn/start", "payload": {"run_id": "synlora-run-1"}},
                {"seq": 2, "type": "tool/call", "payload": {"name": "knowledge.search"}},
            ]

        def events(self, **_kwargs):
            return []

        def cancel(self, **_kwargs):
            return {"ok": True}

        def close(self, **_kwargs):
            return {"ok": True}

    monkeypatch.setattr(agent_view, "create_synlora_session", fake_create_synlora_session)
    monkeypatch.setattr(agent_view, "SynloraClient", FakeSynloraClient)


def agent_url(env, suffix=""):
    return f"/api/research/workspaces/{env['workspace'].slug}/agent/{suffix}"


def _create_agent_session(env):
    """Create one scoped Agent session for lifecycle and replay tests."""
    return env["client"].post(
        agent_url(env, "sessions/"),
        {"request_id": f"session-{uuid4().hex}", "chain_node_id": str(env["node"].id)},
        format="json",
    ).json()


def test_agent_manifest_is_versioned_and_forbids_iframes(env):
    response = env["client"].get(agent_url(env, "manifest/"))
    assert response.status_code == 200
    manifest = response.json()
    assert manifest["manifest_version"] == "agent-plugin.v1"
    assert manifest["feature_flag"] == "research_agent_enabled"
    assert manifest["transport"]["iframe"] == "forbidden"
    assert "expired" in manifest["ui_states"]


def test_agent_session_hides_exchange_token_and_is_idempotent(env):
    payload = {"request_id": f"session-{uuid4().hex}", "chain_node_id": str(env["node"].id)}
    created = env["client"].post(agent_url(env, "sessions/"), payload, format="json")
    assert created.status_code == 201, created.json()
    session = created.json()
    assert session["schema_version"] == "agent-plugin.v1"
    assert "exchange_token" not in session
    assert "token" not in session
    assert ResearchContextGrant.objects.filter(context_id=session["context_id"], agent_session__session_id=session["session_id"]).exists()

    replay = env["client"].post(agent_url(env, "sessions/"), payload, format="json")
    assert replay.status_code == 200
    assert replay.json()["session_id"] == session["session_id"]


def test_agent_session_is_project_scoped(env):
    created = env["client"].post(
        agent_url(env, "sessions/"),
        {"request_id": f"session-{uuid4().hex}", "chain_node_id": str(env["node"].id)},
        format="json",
    )
    session_id = created.json()["session_id"]
    assert env["other_client"].get(agent_url(env, f"sessions/{session_id}/")).status_code in (403, 404)


def test_visible_workspace_member_cannot_operate_agent_sessions(env):
    """Workspace visibility permits trace reads but not Agent session writes."""
    ResearchProjectProfile.objects.filter(pk=env["profile"].pk).update(chain_visibility="WORKSPACE")
    ResearchUserProfile.objects.create(
        user=env["other"],
        category=ResearchUserProfile.Category.STUDENT,
        student_no=f"agent-viewer-{uuid4().hex[:12]}",
    )
    denied = env["other_client"].post(
        agent_url(env, "sessions/"),
        {"request_id": f"session-{uuid4().hex}", "chain_node_id": str(env["node"].id)},
        format="json",
    )
    assert denied.status_code == 403, denied.json()

    session = _create_agent_session(env)
    assert env["other_client"].get(agent_url(env, f"sessions/{session['session_id']}/")).status_code == 200
    message = env["other_client"].post(
        agent_url(env, f"sessions/{session['session_id']}/messages/"),
        {"request_id": f"message-{uuid4().hex}", "content": "unauthorized"},
        format="json",
    )
    artifact = env["other_client"].post(
        agent_url(env, "artifacts/"),
        {
            "request_id": f"artifact-{uuid4().hex}",
            "session_id": session["session_id"],
            "artifact_type": "PROCESS_NOTE",
            "summary": "unauthorized",
            "confirmed": True,
        },
        format="json",
    )
    closed = env["other_client"].post(agent_url(env, f"sessions/{session['session_id']}/close/"), {}, format="json")

    assert message.status_code == 403, message.json()
    assert artifact.status_code == 403, artifact.json()
    assert closed.status_code == 403, closed.json()
    assert ResearchAgentSession.objects.get(session_id=session["session_id"]).status == "READY"
    assert ResearchContextGrant.objects.get(context_id=session["context_id"]).revoked_at is None


def test_archived_chain_blocks_agent_writes_but_allows_safe_close(env):
    """Archiving a Chain immediately makes all Agent projections read-only."""
    session = _create_agent_session(env)
    ResearchChain.objects.filter(pk=env["chain"].pk).update(status=ResearchChain.Status.ARCHIVED)

    message = env["client"].post(
        agent_url(env, f"sessions/{session['session_id']}/messages/"),
        {"request_id": f"message-{uuid4().hex}", "content": "continue"},
        format="json",
    )
    artifact = env["client"].post(
        agent_url(env, "artifacts/"),
        {
            "request_id": f"artifact-{uuid4().hex}",
            "session_id": session["session_id"],
            "artifact_type": "PROCESS_NOTE",
            "summary": "archived",
            "confirmed": True,
        },
        format="json",
    )
    event = env["client"].post(
        agent_url(env, "chain-events/"),
        {
            "request_id": f"event-{uuid4().hex}",
            "event_id": f"event-{uuid4().hex}",
            "chain_node_id": str(env["node"].id),
            "event_type": "AI_ACTION",
            "summary": "archived",
        },
        format="json",
    )
    closed = env["client"].post(agent_url(env, f"sessions/{session['session_id']}/close/"), {}, format="json")

    assert message.status_code == 409, message.json()
    assert artifact.status_code == 409, artifact.json()
    assert event.status_code == 409, event.json()
    assert closed.status_code == 200, closed.json()
    assert ResearchContextGrant.objects.get(context_id=session["context_id"]).revoked_at is not None


def test_agent_message_projects_events_and_does_not_store_content(env):
    created = env["client"].post(
        agent_url(env, "sessions/"),
        {"request_id": f"session-{uuid4().hex}", "chain_node_id": str(env["node"].id)},
        format="json",
    )
    session = created.json()
    message = env["client"].post(
        agent_url(env, f"sessions/{session['session_id']}/messages/"),
        {"request_id": f"message-{uuid4().hex}", "content": "confidential research message"},
        format="json",
    )
    assert message.status_code == 200, message.json()
    assert message.json()["session"]["status"] == "READY"
    assert message.json()["session"]["synlora_run_id"] == "synlora-run-1"
    assert {event["event_type"] for event in message.json()["events"]} >= {"COMMUNICATION", "tool/call"}
    assert ResearchChainEvent.objects.filter(
        node=env["node"],
        source_system="SYNLORA",
        event_type="TOOL_CALL",
    ).exists()

    events = env["client"].get(agent_url(env, f"runs/{session['run_id']}/events/?after_seq=0"))
    assert events.status_code == 200
    assert all("confidential research message" not in str(event) for event in events.json()["results"])


def test_agent_artifact_and_chain_event_are_idempotent(env):
    created = env["client"].post(
        agent_url(env, "sessions/"),
        {"request_id": f"session-{uuid4().hex}", "chain_node_id": str(env["node"].id)},
        format="json",
    )
    session = created.json()
    artifact_request = {
        "request_id": f"artifact-{uuid4().hex}",
        "session_id": session["session_id"],
        "artifact_type": "ANALYSIS_SUMMARY",
        "summary": "Agent summary",
        "confirmed": True,
        "content_hash": _hash("artifact"),
    }
    artifact = env["client"].post(agent_url(env, "artifacts/"), artifact_request, format="json")
    assert artifact.status_code == 201
    assert artifact.json()["snapshot_type"] == "ANALYSIS_RESULT"
    assert ResearchChainSnapshot.objects.filter(snapshot_type="ANALYSIS_RESULT").exists()
    assert ResearchAnalysisResult.objects.filter(request_id=artifact_request["request_id"], status="ACCEPTED").exists()
    replay = env["client"].post(agent_url(env, "artifacts/"), artifact_request, format="json")
    assert replay.status_code == 200
    assert replay.json()["idempotent"] is True
    assert replay.json().get("snapshot_type") is None
    changed_artifact = {**artifact_request, "summary": "Changed Agent summary"}
    artifact_conflict = env["client"].post(agent_url(env, "artifacts/"), changed_artifact, format="json")
    assert artifact_conflict.status_code == 409

    remote_event = {
        "seq": 10,
        "type": "tool/call",
        "payload": {"name": "knowledge.search", "remote_seq": 999},
    }
    session_record = ResearchAgentSession.objects.select_related("chain_node").get(session_id=session["session_id"])
    projected = project_synlora_events(session_record, [remote_event])
    replayed = project_synlora_events(session_record, [remote_event])

    assert projected[0].pk == replayed[0].pk
    assert projected[0].payload["remote_seq"] == 10
    assert ResearchAgentRunEvent.objects.filter(run_id=session["run_id"], payload__remote_seq=10).count() == 1
    assert ResearchChainEvent.objects.filter(
        request_id=f"chain:synlora:{session_record.synlora_session_id}:10"
    ).count() == 1

    event_request = {
        "request_id": f"event-{uuid4().hex}",
        "event_id": f"event-{uuid4().hex}",
        "chain_node_id": str(env["node"].id),
        "event_type": "AI_ACTION",
        "summary": "Agent action",
    }
    event = env["client"].post(agent_url(env, "chain-events/"), event_request, format="json")
    assert event.status_code == 201, event.json()
    replay_event = env["client"].post(agent_url(env, "chain-events/"), event_request, format="json")
    assert replay_event.status_code == 200


def test_ai_artifact_draft_requires_human_confirmation(env):
    """AI output stays draft until the explicit human confirmation flag."""
    session = _create_agent_session(env)
    draft = env["client"].post(
        agent_url(env, "artifacts/"),
        {
            "request_id": f"artifact-{uuid4().hex}",
            "session_id": session["session_id"],
            "artifact_type": "ANALYSIS_SUMMARY",
            "summary": "AI analysis draft",
            "confirmed": False,
        },
        format="json",
    )
    assert draft.status_code == 201, draft.json()
    analysis_id = draft.json()["analysis_id"]
    assert draft.json()["status"] == "DRAFT"
    assert ResearchAnalysisResult.objects.filter(id=analysis_id, status="DRAFT").exists()
    assert not ResearchChainSnapshot.objects.exists()

    accepted = env["client"].post(
        f"/api/research/workspaces/{env['workspace'].slug}/chains/{env['chain'].id}/analyses/",
        {
            "request_id": f"analysis-{uuid4().hex}",
            "node_id": str(env["node"].id),
            "method": "regression",
            "summary": "conversion improved",
            "metrics": {"r2": 0.91},
            "confirmed": True,
        },
        format="json",
    )
    assert accepted.status_code == 201, accepted.json()
    assert accepted.json()["status"] == "ACCEPTED"
    assert ResearchChainSnapshot.objects.filter(snapshot_id=accepted.json()["snapshot_id"]).exists()
    assert ResearchChainEvent.objects.filter(event_type="HUMAN_DECISION", node=env["node"]).exists()


def test_agent_close_revokes_context_and_expires_session(env):
    created = env["client"].post(
        agent_url(env, "sessions/"),
        {"request_id": f"session-{uuid4().hex}", "chain_node_id": str(env["node"].id)},
        format="json",
    )
    session = created.json()
    closed = env["client"].post(agent_url(env, f"sessions/{session['session_id']}/close/"), format="json")
    assert closed.status_code == 200
    assert closed.json()["status"] == "CLOSED"
    assert not ResearchContextGrant.objects.filter(context_id=session["context_id"], revoked_at__isnull=True).exists()
    assert env["client"].get(agent_url(env, f"sessions/{session['session_id']}/")).status_code == 403


def test_agent_run_cancel_revokes_streaming_scope(env):
    session = env["client"].post(
        agent_url(env, "sessions/"),
        {"request_id": f"session-{uuid4().hex}", "chain_node_id": str(env["node"].id)},
        format="json",
    ).json()
    cancelled = env["client"].post(
        agent_url(env, f"runs/{session['run_id']}/cancel/"),
        {"request_id": f"cancel-{uuid4().hex}"},
        format="json",
    )
    assert cancelled.status_code == 200
    assert cancelled.json()["status"] == "CLOSED"
    assert not ResearchContextGrant.objects.filter(context_id=session["context_id"], revoked_at__isnull=True).exists()


def test_revoked_context_blocks_reads_and_allows_safe_close(env):
    """Revoked Context blocks Trace/approval writes but keeps close idempotent."""
    session = _create_agent_session(env)
    ResearchContextGrant.objects.filter(context_id=session["context_id"]).update(revoked_at=timezone.now())

    assert env["client"].get(agent_url(env, f"runs/{session['run_id']}/events/")).status_code == 403
    approval = env["client"].post(
        agent_url(env, f"runs/{session['run_id']}/approvals/"),
        {"request_id": f"approval-{uuid4().hex}", "decision": "APPROVED"},
        format="json",
    )
    assert approval.status_code == 403

    closed = env["client"].post(agent_url(env, f"sessions/{session['session_id']}/close/"), format="json")
    assert closed.status_code == 200
    assert closed.json()["status"] == "CLOSED"
    replay = env["client"].post(agent_url(env, f"sessions/{session['session_id']}/close/"), format="json")
    assert replay.status_code == 200
    assert replay.json()["status"] == "CLOSED"


def test_agent_message_replay_is_idempotent_and_rejects_payload_change(env):
    """A retried message does not duplicate events or accept a new payload."""
    session = _create_agent_session(env)
    payload = {"request_id": f"message-{uuid4().hex}", "content": "research question"}
    first = env["client"].post(agent_url(env, f"sessions/{session['session_id']}/messages/"), payload, format="json")
    first_event_count = ResearchAgentRunEvent.objects.filter(run_id=session["run_id"]).count()
    replay = env["client"].post(agent_url(env, f"sessions/{session['session_id']}/messages/"), payload, format="json")

    assert first.status_code == 200, first.json()
    assert replay.status_code == 200, replay.json()
    assert replay.json()["session"]["session_id"] == session["session_id"]
    event_count = ResearchAgentRunEvent.objects.filter(run_id=session["run_id"]).count()
    assert event_count == first_event_count

    changed = dict(payload, content="different research question")
    conflict = env["client"].post(agent_url(env, f"sessions/{session['session_id']}/messages/"), changed, format="json")
    assert conflict.status_code == 409
    assert ResearchAgentRunEvent.objects.filter(run_id=session["run_id"]).count() == event_count


def test_agent_approval_replay_is_idempotent_and_rejects_payload_change(env):
    """A retried approval returns the same decision and rejects a changed payload."""
    session = _create_agent_session(env)
    payload = {"request_id": f"approval-{uuid4().hex}", "decision": "APPROVED", "tool_call_id": "tool-1"}
    first = env["client"].post(agent_url(env, f"runs/{session['run_id']}/approvals/"), payload, format="json")
    replay = env["client"].post(agent_url(env, f"runs/{session['run_id']}/approvals/"), payload, format="json")

    assert first.status_code == 200
    assert replay.status_code == 200
    assert replay.json()["event"]["request_id"] == payload["request_id"]
    assert ResearchAgentRunEvent.objects.filter(run_id=session["run_id"], event_type="HUMAN_DECISION").count() == 1

    changed = dict(payload, decision="REJECTED")
    conflict = env["client"].post(agent_url(env, f"runs/{session['run_id']}/approvals/"), changed, format="json")
    assert conflict.status_code == 409
    assert ResearchAgentRunEvent.objects.filter(run_id=session["run_id"], event_type="HUMAN_DECISION").count() == 1


def test_agent_events_are_isolated_between_old_and_new_sessions(env):
    first = env["client"].post(
        agent_url(env, "sessions/"),
        {"request_id": f"session-{uuid4().hex}", "chain_node_id": str(env["node"].id)},
        format="json",
    ).json()
    env["client"].post(
        agent_url(env, f"sessions/{first['session_id']}/messages/"),
        {"request_id": f"message-{uuid4().hex}", "content": "old session message"},
        format="json",
    )
    second = env["client"].post(
        agent_url(env, "sessions/"),
        {"request_id": f"session-{uuid4().hex}", "chain_node_id": str(env["node"].id)},
        format="json",
    ).json()

    second_events = env["client"].get(agent_url(env, f"runs/{second['run_id']}/events/"))
    assert second_events.status_code == 200
    assert all(event["run_id"] == str(second["run_id"]) for event in second_events.json()["results"])
    assert all("old session message" not in str(event) for event in second_events.json()["results"])


def test_unlinked_synlora_account_blocks_next_message(env):
    """An existing session cannot continue after its ACTIVE AccountLink disappears."""
    session = _create_agent_session(env)
    AccountLink.objects.filter(local_user=env["owner"], provider="SYNLORA").update(
        status=AccountLink.Status.UNLINKED,
        unlinked_at=timezone.now(),
    )
    message = env["client"].post(
        agent_url(env, f"sessions/{session['session_id']}/messages/"),
        {"request_id": f"message-{uuid4().hex}", "content": "continue"},
        format="json",
    )
    assert message.status_code == 403
    assert message.json()["session"]["status"] == "DEGRADED"
    assert message.json()["session"]["last_error"] == "synlora_account_link_inactive"


def test_rejected_agent_approval_fails_closed(env):
    session = env["client"].post(
        agent_url(env, "sessions/"),
        {"request_id": f"session-{uuid4().hex}", "chain_node_id": str(env["node"].id)},
        format="json",
    ).json()
    rejected = env["client"].post(
        agent_url(env, f"runs/{session['run_id']}/approvals/"),
        {"request_id": f"approval-{uuid4().hex}", "decision": "REJECTED", "tool_call_id": "tool-1"},
        format="json",
    )
    assert rejected.status_code == 200
    assert rejected.json()["session"]["status"] == "ERROR"
    artifact = env["client"].post(
        agent_url(env, "artifacts/"),
        {
            "request_id": f"artifact-{uuid4().hex}",
            "session_id": session["session_id"],
            "summary": "must not save",
        },
        format="json",
    )
    assert artifact.status_code == 403


def test_agent_manifest_and_session_fail_when_switch_is_off(env):
    WorkspaceResearchSetting.objects.filter(workspace=env["workspace"]).update(research_agent_enabled=False)
    assert env["client"].post(
        agent_url(env, "sessions/"),
        {"request_id": f"session-{uuid4().hex}", "chain_node_id": str(env["node"].id)},
        format="json",
    ).status_code == 403


def test_agent_chain_event_taxonomy_and_audit_are_enforced(env):
    """Only Phase 0 taxonomy events enter Chain and every write is audited."""
    invalid = env["client"].post(
        agent_url(env, "chain-events/"),
        {
            "request_id": f"event-{uuid4().hex}",
            "event_id": f"event-{uuid4().hex}",
            "chain_node_id": str(env["node"].id),
            "event_type": "NOT_A_PHASE_ZERO_EVENT",
            "summary": "invalid",
        },
        format="json",
    )
    assert invalid.status_code == 400
    assert not ResearchChainEvent.objects.filter(event_id=invalid.json().get("event_id", "")).exists()

    event_id = f"event-{uuid4().hex}"
    valid = env["client"].post(
        agent_url(env, "chain-events/"),
        {
            "request_id": f"event-{uuid4().hex}",
            "event_id": event_id,
            "chain_node_id": str(env["node"].id),
            "event_type": "TOOL_CALL",
            "summary": "valid",
        },
        format="json",
    )
    assert valid.status_code == 201, valid.json()
    event_request = {
        "request_id": f"event-{uuid4().hex}",
        "event_id": event_id,
        "chain_node_id": str(env["node"].id),
        "event_type": "TOOL_CALL",
        "summary": "valid",
    }
    changed_event = {**event_request, "summary": "changed"}
    event_conflict = env["client"].post(agent_url(env, "chain-events/"), changed_event, format="json")
    assert event_conflict.status_code == 409
    chain_event = ResearchChainEvent.objects.get(event_id=event_id)
    assert ResearchAuditEvent.objects.filter(
        workspace=env["workspace"],
        action="agent.chain_event.write",
        resource_id=chain_event.id,
    ).exists()
