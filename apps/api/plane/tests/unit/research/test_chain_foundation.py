"""Research Chain foundation migration-view, ACL and idempotency tests."""

from uuid import uuid4

import pytest
from rest_framework.test import APIClient

from plane.db.models import (
    Project,
    ResearchChain,
    ResearchChainEvent,
    ResearchChainNode,
    ResearchChainSnapshot,
    ResearchProjectProfile,
    WorkspaceResearchSetting,
)
from plane.research.services.idempotency import payload_hash
from plane.tests.research_fixtures import add_workspace_member, enable_research, make_user, make_workspace

pytestmark = pytest.mark.unit


def _client(user):
    client = APIClient()
    client.force_authenticate(user=user)
    return client


@pytest.fixture
def env(db, settings):
    settings.RESEARCH_MODULE_ENABLED = True
    owner = make_user(first_name="Chain owner")
    outsider = make_user(first_name="Chain outsider")
    workspace = make_workspace(owner)
    add_workspace_member(workspace, outsider)
    enable_research(workspace, research_chain_enabled=True, research_agent_enabled=True)
    suffix = uuid4().hex[:6]
    project = Project.objects.create(
        workspace=workspace,
        name=f"Chain project {suffix}",
        identifier=f"CH{suffix}",
        network=0,
        created_by=owner,
    )
    ResearchProjectProfile.objects.create(
        project=project,
        workspace=workspace,
        owner=owner,
        chain_kind="RESEARCH_CHAIN",
        chain_visibility="PRIVATE",
        created_by=owner,
    )
    return {
        "owner": owner,
        "outsider": outsider,
        "workspace": workspace,
        "project": project,
        "client": _client(owner),
        "outsider_client": _client(outsider),
    }


def chains_url(env):
    return f"/api/research/workspaces/{env['workspace'].slug}/chains/"


def create_chain(env, request_id=None):
    payload = {
        "request_id": request_id or f"chain-{uuid4().hex}",
        "project_id": str(env["project"].id),
    }
    return env["client"].post(chains_url(env), payload, format="json"), payload


def test_chain_requires_request_id_and_switch(env):
    missing = env["client"].post(chains_url(env), {"project_id": str(env["project"].id)}, format="json")
    assert missing.status_code == 400

    WorkspaceResearchSetting.objects.filter(workspace=env["workspace"]).update(research_chain_enabled=False)
    disabled = create_chain(env)
    assert disabled[0].status_code == 403
    WorkspaceResearchSetting.objects.filter(workspace=env["workspace"]).update(research_chain_enabled=True)


def test_chain_create_is_idempotent_and_detects_payload_conflict(env):
    created, payload = create_chain(env)
    assert created.status_code == 201, created.json()
    chain_id = created.json()["data"]["id"]
    assert created.json()["schema_version"] == "research-chain.v1"

    replay = env["client"].post(chains_url(env), payload, format="json")
    assert replay.status_code == 200
    assert replay.json()["data"]["id"] == chain_id
    assert ResearchChain.objects.filter(project=env["project"]).count() == 1

    payload["visibility"] = "WORKSPACE"
    conflict = env["client"].post(chains_url(env), payload, format="json")
    assert conflict.status_code == 409


def test_chain_list_and_detail_use_project_visibility(env):
    created, _ = create_chain(env)
    chain_id = created.json()["data"]["id"]
    assert env["outsider_client"].get(chains_url(env)).status_code == 403
    detail_url = f"{chains_url(env).rstrip('/')}/{chain_id}/"
    assert env["outsider_client"].get(detail_url).status_code == 403

    listed = env["client"].get(chains_url(env))
    assert listed.status_code == 200
    assert [item["id"] for item in listed.json()["data"]] == [chain_id]
    assert env["client"].get(detail_url).status_code == 200


def test_node_event_and_snapshot_are_idempotent_append_only(env):
    chain_response, _ = create_chain(env)
    chain_id = chain_response.json()["data"]["id"]
    nodes_url = f"{chains_url(env).rstrip('/')}/{chain_id}/nodes/"
    node_payload = {
        "request_id": f"node-{uuid4().hex}",
        "node_type": "LITERATURE_REVIEW",
        "title": "文献调研",
    }
    node = env["client"].post(nodes_url, node_payload, format="json")
    assert node.status_code == 201, node.json()
    node_id = node.json()["data"]["id"]
    node_replay = env["client"].post(nodes_url, node_payload, format="json")
    assert node_replay.status_code == 200
    assert node_replay.json()["data"]["id"] == node_id

    invalid_parent = env["client"].post(
        nodes_url,
        {**node_payload, "request_id": f"node-{uuid4().hex}", "parent_node_id": str(uuid4())},
        format="json",
    )
    assert invalid_parent.status_code == 422

    events_url = f"/api/research/workspaces/{env['workspace'].slug}/nodes/{node_id}/events/"
    event_payload = {
        "request_id": f"event-{uuid4().hex}",
        "event_id": f"event-{uuid4().hex}",
        "event_type": "RESEARCH_NOTE",
        "summary": "初始记录",
        "occurred_at": "2026-09-22T08:00:00Z",
    }
    event = env["client"].post(events_url, event_payload, format="json")
    assert event.status_code == 201, event.json()
    event_replay = env["client"].post(events_url, event_payload, format="json")
    assert event_replay.status_code == 200
    assert ResearchChainEvent.objects.count() == 2
    stored_event = ResearchChainEvent.objects.get(request_id=event_payload["request_id"])
    with pytest.raises(TypeError):
        stored_event.summary = "overwrite"
        stored_event.save()
    with pytest.raises(TypeError):
        stored_event.delete()

    snapshots_url = f"/api/research/workspaces/{env['workspace'].slug}/nodes/{node_id}/snapshots/"
    snapshot_payload = {
        "request_id": f"snapshot-{uuid4().hex}",
        "summary": "文献快照",
        "source_versions": [{"kind": "literature", "id": "lit-1", "version": 1}],
    }
    snapshot = env["client"].post(snapshots_url, snapshot_payload, format="json")
    assert snapshot.status_code == 201, snapshot.json()
    snapshot_replay = env["client"].post(snapshots_url, snapshot_payload, format="json")
    assert snapshot_replay.status_code == 200
    assert ResearchChainSnapshot.objects.count() == 1

    stored_node = ResearchChainNode.objects.get(pk=node_id)
    assert stored_node.payload_hash == payload_hash(node_payload)


def test_chain_preserves_future_taxonomy_values(env):
    chain_response, _ = create_chain(env)
    chain_id = chain_response.json()["data"]["id"]
    nodes_url = f"{chains_url(env).rstrip('/')}/{chain_id}/nodes/"
    node = env["client"].post(
        nodes_url,
        {
            "request_id": f"node-{uuid4().hex}",
            "node_type": "FUTURE_NODE_TYPE",
            "title": "未来节点",
        },
        format="json",
    )
    assert node.status_code == 201
    assert node.json()["data"]["node_type"] == "FUTURE_NODE_TYPE"

    events_url = f"/api/research/workspaces/{env['workspace'].slug}/nodes/{node.json()['data']['id']}/events/"
    event = env["client"].post(
        events_url,
        {
            "request_id": f"event-{uuid4().hex}",
            "event_id": f"event-{uuid4().hex}",
            "event_type": "FUTURE_EVENT_TYPE",
            "summary": "未来事件",
        },
        format="json",
    )
    assert event.status_code == 201
    assert event.json()["data"]["event_type"] == "FUTURE_EVENT_TYPE"
