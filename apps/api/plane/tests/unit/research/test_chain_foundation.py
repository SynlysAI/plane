"""Research Chain foundation migration-view, ACL and idempotency tests."""

from datetime import timedelta
from uuid import uuid4

import pytest
from django.utils import timezone
from rest_framework.test import APIClient

from plane.db.models import (
    OrgUnit,
    OrgUnitMember,
    Project,
    ResearchChain,
    ResearchChainEvent,
    ResearchChainNodeTask,
    ResearchChainNode,
    ResearchChainSnapshot,
    ResearchProjectProfile,
    WorkspaceResearchSetting,
)
from plane.research.services.idempotency import payload_hash
from plane.tests.research_fixtures import (
    add_workspace_member,
    enable_research,
    make_user,
    make_workspace,
)

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
    external = make_user(first_name="Non-research outsider")
    workspace = make_workspace(owner)
    add_workspace_member(workspace, outsider)
    add_workspace_member(workspace, external)
    enable_research(workspace, research_chain_enabled=True, research_agent_enabled=True)
    suffix = uuid4().hex[:6]
    root = OrgUnit.objects.create(
        workspace=workspace,
        name="科研根节点",
        unit_type=OrgUnit.UnitType.ROOT,
        depth=0,
        path="",
    )
    root.path = f"/{root.id.hex}/"
    root.save(update_fields=["path"])
    group = OrgUnit.objects.create(
        workspace=workspace,
        name="链路课题组",
        parent=root,
        unit_type=OrgUnit.UnitType.GROUP,
        depth=1,
        path="",
    )
    group.path = f"{root.path}{group.id.hex}/"
    group.save(update_fields=["path"])
    OrgUnitMember.objects.create(
        workspace=workspace,
        org_unit=group,
        user=owner,
        org_role=OrgUnitMember.OrgRole.REVIEWER,
    )
    OrgUnitMember.objects.create(
        workspace=workspace,
        org_unit=group,
        user=outsider,
        org_role=OrgUnitMember.OrgRole.REVIEWER,
    )
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
        "external": external,
        "workspace": workspace,
        "project": project,
        "client": _client(owner),
        "outsider_client": _client(outsider),
        "external_client": _client(external),
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


def test_workspace_visible_chain_stays_closed_to_non_org_members(env):
    """无科研组织关系的成员即使链路声明 WORKSPACE 可见也不能进入科研链 API。"""
    env["project"].research_profile.chain_visibility = "WORKSPACE"
    env["project"].research_profile.save(update_fields=["chain_visibility", "updated_at"])
    created, _ = create_chain(env)
    assert created.status_code == 201, created.json()
    chain_id = created.json()["data"]["id"]
    node = ResearchChainNode.objects.create(
        chain_id=chain_id,
        node_type="LITERATURE_REVIEW",
        title="Workspace node",
        request_id=f"node-{uuid4().hex}",
        payload_hash=uuid4().hex,
    )

    assert env["external_client"].get(chains_url(env)).status_code == 403
    assert env["external_client"].get(f"{chains_url(env)}{chain_id}/").status_code == 403
    assert (
        env["external_client"]
        .get(f"/api/research/workspaces/{env['workspace'].slug}/nodes/{node.id}/events/")
        .status_code
        == 403
    )
    denied = env["external_client"].post(
        f"/api/research/workspaces/{env['workspace'].slug}/nodes/{node.id}/events/",
        {"request_id": f"event-{uuid4().hex}", "event_id": f"event-{uuid4().hex}", "event_type": "RESEARCH_NOTE"},
        format="json",
    )
    assert denied.status_code == 403


def test_workspace_admin_can_write_chain_without_org_relation(env):
    """工作区管理员无需科研组织关系即可写入研究链。"""
    env["project"].research_profile.chain_visibility = "WORKSPACE"
    env["project"].research_profile.save(update_fields=["chain_visibility", "updated_at"])
    created, _ = create_chain(env)
    chain = ResearchChain.objects.get(id=created.json()["data"]["id"])
    node = ResearchChainNode.objects.create(
        chain=chain,
        node_type="LITERATURE_REVIEW",
        title="Admin probe",
        request_id=f"node-{uuid4().hex}",
        payload_hash=uuid4().hex,
    )
    admin = make_user(first_name="Workspace admin")
    add_workspace_member(env["workspace"], admin, role=20)
    response = _client(admin).post(
        f"/api/research/workspaces/{env['workspace'].slug}/nodes/{node.id}/events/",
        {
            "request_id": f"admin-event-{uuid4().hex}",
            "event_id": f"admin-event-{uuid4().hex}",
            "event_type": "RESEARCH_NOTE",
            "summary": "Admin can write",
        },
        format="json",
    )
    assert response.status_code == 201, response.json()


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
    outsider_list = env["outsider_client"].get(chains_url(env))
    assert outsider_list.status_code == 200
    assert outsider_list.json()["data"] == []
    detail_url = f"{chains_url(env).rstrip('/')}/{chain_id}/"
    assert env["outsider_client"].get(detail_url).status_code == 404

    listed = env["client"].get(chains_url(env))
    assert listed.status_code == 200
    assert [item["id"] for item in listed.json()["data"]] == [chain_id]
    assert env["client"].get(detail_url).status_code == 200


def test_chain_list_returns_aggregated_summary_without_per_row_node_requests(env):
    from django.test.utils import CaptureQueriesContext
    from django.db import connection

    def table_query_count(capture, table_name):
        return sum(table_name in query["sql"] for query in capture.captured_queries)

    created, _ = create_chain(env)
    chain = ResearchChain.objects.get(id=created.json()["data"]["id"])
    active_node = ResearchChainNode.objects.create(
        chain=chain,
        node_type="ANALYSIS",
        title="实验数据分析",
        status="ACTIVE",
        request_id=f"node-active-{uuid4().hex}",
        payload_hash=uuid4().hex,
    )
    waiting_node = ResearchChainNode.objects.create(
        chain=chain,
        node_type="PAPER_WRITING",
        title="论文修改",
        status="WAITING_HUMAN",
        request_id=f"node-waiting-{uuid4().hex}",
        payload_hash=uuid4().hex,
    )
    ResearchChainNodeTask.objects.create(
        workspace=env["workspace"],
        chain=chain,
        node=active_node,
        title="补充实验图表",
        status="ASSIGNED",
        due_at=timezone.now() + timedelta(days=3),
        request_id=f"task-open-{uuid4().hex}",
        payload_hash=uuid4().hex,
    )
    ResearchChainNodeTask.objects.create(
        workspace=env["workspace"],
        chain=chain,
        node=active_node,
        title="整理数据表",
        status="ASSIGNED",
        due_at=timezone.now() + timedelta(days=1),
        request_id=f"task-next-{uuid4().hex}",
        payload_hash=uuid4().hex,
    )
    ResearchChainNodeTask.objects.create(
        workspace=env["workspace"],
        chain=chain,
        node=active_node,
        title="已完成任务",
        status="COMPLETED",
        request_id=f"task-completed-{uuid4().hex}",
        payload_hash=uuid4().hex,
    )

    with CaptureQueriesContext(connection) as first_capture:
        listed = env["client"].get(chains_url(env))
    summary = next(item for item in listed.json()["data"] if item["id"] == str(chain.id))
    assert summary["open_task_count"] == 2
    assert summary["next_due_at"] is not None
    assert summary["current_node"]["id"] == str(waiting_node.id)
    assert summary["current_node"]["title"] == "论文修改"

    project_suffix = uuid4().hex[:6]
    second_project = Project.objects.create(
        workspace=env["workspace"],
        name=f"Second chain project {project_suffix}",
        identifier=f"S{project_suffix}",
        network=0,
        created_by=env["owner"],
    )
    ResearchProjectProfile.objects.create(
        project=second_project,
        workspace=env["workspace"],
        owner=env["owner"],
        chain_kind="RESEARCH_CHAIN",
        chain_visibility="PRIVATE",
        created_by=env["owner"],
    )
    ResearchChain.objects.create(
        project=second_project,
        workspace=env["workspace"],
        owner=env["owner"],
        request_id=f"chain-second-{uuid4().hex}",
        payload_hash=uuid4().hex,
        created_by=env["owner"],
    )
    second_node = ResearchChainNode.objects.create(
        chain_id=ResearchChain.objects.get(project=second_project).id,
        node_type="ANALYSIS",
        title="第二条链路节点",
        status="ACTIVE",
        request_id=f"node-second-{uuid4().hex}",
        payload_hash=uuid4().hex,
    )
    ResearchChainNodeTask.objects.create(
        workspace=env["workspace"],
        chain_id=second_node.chain_id,
        node=second_node,
        title="第二条链路任务",
        status="ASSIGNED",
        due_at=timezone.now() + timedelta(days=2),
        request_id=f"task-second-{uuid4().hex}",
        payload_hash=uuid4().hex,
    )

    with CaptureQueriesContext(connection) as second_capture:
        listed_again = env["client"].get(chains_url(env))
    assert len(listed_again.json()["data"]) == 2
    assert table_query_count(second_capture, "research_chain_nodes") == table_query_count(
        first_capture, "research_chain_nodes"
    )
    assert any("research_chain_node_tasks" in query["sql"] for query in first_capture.captured_queries)


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
