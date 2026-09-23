"""Agent plugin manifest, scope, lifecycle and fail-closed BFF tests."""

from hashlib import sha256
from uuid import uuid4

import pytest
from django.utils import timezone
from rest_framework.test import APIClient

from plane.db.models import (
    Project,
    ResearchAgentRunEvent,
    ResearchAuditEvent,
    ResearchChain,
    ResearchChainEvent,
    ResearchChainNode,
    ResearchContextGrant,
    ResearchProjectProfile,
    WorkspaceResearchSetting,
)
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


def test_agent_message_fail_closed_and_events_do_not_store_content(env):
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
    assert message.status_code == 503
    assert message.json()["session"]["status"] == "DEGRADED"
    assert message.json()["session"]["last_error"] == "AGENT_UPSTREAM_NOT_CONFIGURED"

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
    artifact_request = {"request_id": f"artifact-{uuid4().hex}", "session_id": session["session_id"], "summary": "Agent summary", "content_hash": _hash("artifact")}
    artifact = env["client"].post(agent_url(env, "artifacts/"), artifact_request, format="json")
    assert artifact.status_code == 201
    replay = env["client"].post(agent_url(env, "artifacts/"), artifact_request, format="json")
    assert replay.status_code == 200
    assert replay.json()["idempotent"] is True

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
    """A retried fail-closed message does not duplicate events or accept a new payload."""
    session = _create_agent_session(env)
    payload = {"request_id": f"message-{uuid4().hex}", "content": "research question"}
    first = env["client"].post(agent_url(env, f"sessions/{session['session_id']}/messages/"), payload, format="json")
    first_event_count = ResearchAgentRunEvent.objects.filter(run_id=session["run_id"]).count()
    replay = env["client"].post(agent_url(env, f"sessions/{session['session_id']}/messages/"), payload, format="json")

    assert first.status_code == 503
    assert replay.status_code == 503
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
    chain_event = ResearchChainEvent.objects.get(event_id=event_id)
    assert ResearchAuditEvent.objects.filter(
        workspace=env["workspace"],
        action="agent.chain_event.write",
        resource_id=chain_event.id,
    ).exists()
