"""Phase 1 parallel Research Chain ACL and lifecycle contract tests."""

import hashlib
from uuid import uuid4

import pytest
from rest_framework.test import APIClient
from django.core.files.uploadedfile import SimpleUploadedFile

from plane.db.models import (
    Project,
    ResearchAnalysisResult,
    ResearchAuditEvent,
    ResearchChain,
    ResearchChainEvent,
    ResearchChainUpload,
    ResearchProjectProfile,
    ResearchUserProfile,
)
from plane.tests.research_fixtures import add_workspace_member, enable_research, make_user, make_workspace

pytestmark = pytest.mark.contract


def _client(user):
    """Return an API client authenticated as the supplied user."""
    client = APIClient()
    client.force_authenticate(user=user)
    return client


def _research_project(workspace, owner, name, visibility):
    """Create a project/profile pair with an explicit chain visibility."""
    suffix = uuid4().hex[:6]
    project = Project.objects.create(
        workspace=workspace,
        name=f"{name} {suffix}",
        identifier=f"{name[:2].upper()}{suffix}",
        network=0,
        created_by=owner,
    )
    profile = ResearchProjectProfile.objects.create(
        project=project,
        workspace=workspace,
        owner=owner,
        chain_kind=ResearchProjectProfile.ChainKind.RESEARCH_CHAIN,
        chain_visibility=visibility,
        created_by=owner,
    )
    return project, profile


def _create_chain(client, workspace, project):
    """Create a chain through the public API contract."""
    return client.post(
        f"/api/research/workspaces/{workspace.slug}/chains/",
        {
            "request_id": f"chain-{uuid4().hex}",
            "project_id": str(project.id),
        },
        format="json",
    )


@pytest.fixture
def env(db, settings):
    """Build one owner and one ordinary workspace member for ACL tests."""
    settings.RESEARCH_MODULE_ENABLED = True
    owner = make_user(first_name="Chain owner")
    collaborator = make_user(first_name="Chain collaborator")
    workspace = make_workspace(owner)
    add_workspace_member(workspace, collaborator)
    ResearchUserProfile.objects.create(user=collaborator, category=ResearchUserProfile.Category.STUDENT, student_no=f"chain-{uuid4().hex[:12]}")
    enable_research(workspace, research_chain_enabled=True, research_agent_enabled=True)
    public_project, public_profile = _research_project(workspace, owner, "Public", "WORKSPACE")
    private_project, private_profile = _research_project(workspace, owner, "Private", "PRIVATE")
    return {
        "owner": owner,
        "collaborator": collaborator,
        "workspace": workspace,
        "public_project": public_project,
        "public_profile": public_profile,
        "private_project": private_project,
        "private_profile": private_profile,
        "owner_client": _client(owner),
        "collaborator_client": _client(collaborator),
    }


def test_parallel_chains_respect_workspace_and_private_visibility(env):
    """A workspace member sees the public chain but not the private one."""
    public = _create_chain(env["owner_client"], env["workspace"], env["public_project"])
    private = _create_chain(env["owner_client"], env["workspace"], env["private_project"])
    assert public.status_code == 201, public.json()
    assert private.status_code == 201, private.json()

    visible = env["collaborator_client"].get(f"/api/research/workspaces/{env['workspace'].slug}/chains/")
    assert visible.status_code == 200, visible.json()
    visible_ids = {item["id"] for item in visible.json()["data"]}
    assert public.json()["data"]["id"] in visible_ids
    assert private.json()["data"]["id"] not in visible_ids

    public_detail_url = f"/api/research/workspaces/{env['workspace'].slug}/chains/{public.json()['data']['id']}/"
    private_detail_url = f"/api/research/workspaces/{env['workspace'].slug}/chains/{private.json()['data']['id']}/"
    assert env["collaborator_client"].get(public_detail_url).status_code == 200
    assert env["collaborator_client"].get(private_detail_url).status_code == 404


def test_chain_collaborator_lifecycle_and_audit(env):
    """Adding and removing a project member grants then revokes chain ACL."""
    created = _create_chain(env["owner_client"], env["workspace"], env["private_project"])
    chain_id = created.json()["data"]["id"]
    members_url = f"/api/research/workspaces/{env['workspace'].slug}/chains/{chain_id}/members/"
    detail_url = f"/api/research/workspaces/{env['workspace'].slug}/chains/{chain_id}/"

    assert env["collaborator_client"].get(detail_url).status_code == 404
    added = env["owner_client"].post(members_url, {"user_id": str(env["collaborator"].id)}, format="json")
    assert added.status_code == 201, added.json()
    assert env["collaborator_client"].get(detail_url).status_code == 200
    assert ResearchAuditEvent.objects.filter(
        workspace=env["workspace"],
        action="chain.member.add",
        resource_id=chain_id,
    ).exists()

    removed = env["owner_client"].delete(f"{members_url}{env['collaborator'].id}/")
    assert removed.status_code == 204
    assert env["collaborator_client"].get(detail_url).status_code == 404
    assert ResearchAuditEvent.objects.filter(
        workspace=env["workspace"],
        action="chain.member.remove",
        resource_id=chain_id,
    ).exists()


def test_archived_chain_is_replayable_and_readonly(env):
    """Archive preserves reads and idempotent replay but blocks new writes."""
    created = _create_chain(env["owner_client"], env["workspace"], env["public_project"])
    chain_id = created.json()["data"]["id"]
    nodes_url = f"/api/research/workspaces/{env['workspace'].slug}/chains/{chain_id}/nodes/"
    node_payload = {
        "request_id": f"node-{uuid4().hex}",
        "node_type": "LITERATURE_REVIEW",
        "title": "文献调研",
    }
    node = env["owner_client"].post(nodes_url, node_payload, format="json")
    assert node.status_code == 201, node.json()

    archive_url = f"/api/research/workspaces/{env['workspace'].slug}/chains/{chain_id}/archive/"
    archived = env["owner_client"].post(archive_url, {}, format="json")
    assert archived.status_code == 200, archived.json()
    assert archived.json()["data"]["status"] == ResearchChain.Status.ARCHIVED
    assert env["collaborator_client"].post(nodes_url, node_payload, format="json").status_code == 200
    assert env["collaborator_client"].post(
        nodes_url,
        {**node_payload, "request_id": f"node-{uuid4().hex}"},
        format="json",
    ).status_code == 409

    restore_url = f"/api/research/workspaces/{env['workspace'].slug}/chains/{chain_id}/restore/"
    restored = env["owner_client"].post(restore_url, {}, format="json")
    assert restored.status_code == 200, restored.json()
    assert restored.json()["data"]["status"] == ResearchChain.Status.ACTIVE


def test_node_state_machine_is_service_driven_and_idempotent(env):
    """Valid transitions append facts while invalid jumps stay blocked."""
    created = _create_chain(env["owner_client"], env["workspace"], env["public_project"])
    chain_id = created.json()["data"]["id"]
    nodes_url = f"/api/research/workspaces/{env['workspace'].slug}/chains/{chain_id}/nodes/"
    node = env["owner_client"].post(
        nodes_url,
        {
            "request_id": f"node-{uuid4().hex}",
            "node_type": "RESEARCH_PLAN",
            "title": "研究计划",
        },
        format="json",
    ).json()["data"]
    assert node["status"] == "DRAFT"
    assert ResearchChainEvent.objects.filter(node_id=node["id"], event_type="NODE_CREATED").exists()

    transition_url = f"/api/research/workspaces/{env['workspace'].slug}/nodes/{node['id']}/transitions/"
    invalid = env["owner_client"].post(
        transition_url,
        {"request_id": f"transition-{uuid4().hex}", "action": "SUBMIT_REVIEW"},
        format="json",
    )
    assert invalid.status_code == 409

    start_payload = {"request_id": f"transition-{uuid4().hex}", "action": "START"}
    started = env["owner_client"].post(transition_url, start_payload, format="json")
    replay = env["owner_client"].post(transition_url, start_payload, format="json")
    assert started.status_code == 201, started.json()
    assert replay.status_code == 200
    assert replay.json()["data"]["node"]["status"] == "ACTIVE"
    assert ResearchChainEvent.objects.filter(node_id=node["id"], event_type="NODE_STARTED").count() == 1

    failed = env["owner_client"].post(
        transition_url,
        {"request_id": f"transition-{uuid4().hex}", "action": "FAIL", "reason": "数据不足"},
        format="json",
    )
    assert failed.status_code == 201
    retried = env["owner_client"].post(
        transition_url,
        {"request_id": f"transition-{uuid4().hex}", "action": "RETRY"},
        format="json",
    )
    assert retried.status_code == 201
    assert retried.json()["data"]["node"]["status"] == "ACTIVE"
    assert ResearchChainEvent.objects.filter(node_id=node["id"], event_type="NODE_RETRIED").exists()


    submitted = env["owner_client"].post(
        transition_url,
        {"request_id": f"transition-{uuid4().hex}", "action": "SUBMIT_REVIEW"},
        format="json",
    )
    returned = env["owner_client"].post(
        transition_url,
        {"request_id": f"transition-{uuid4().hex}", "action": "RETURN", "reason": "补充基线"},
        format="json",
    )
    revised = env["owner_client"].post(
        transition_url,
        {"request_id": f"transition-{uuid4().hex}", "action": "START"},
        format="json",
    )
    resubmitted = env["owner_client"].post(
        transition_url,
        {"request_id": f"transition-{uuid4().hex}", "action": "SUBMIT_REVIEW"},
        format="json",
    )
    approved = env["owner_client"].post(
        transition_url,
        {"request_id": f"transition-{uuid4().hex}", "action": "APPROVE"},
        format="json",
    )
    assert submitted.json()["data"]["node"]["status"] == "WAITING_HUMAN"
    assert returned.json()["data"]["node"]["status"] == "NEEDS_REVISION"
    assert revised.json()["data"]["node"]["status"] == "ACTIVE"
    assert resubmitted.json()["data"]["node"]["status"] == "WAITING_HUMAN"
    assert approved.status_code == 201
    assert approved.json()["data"]["node"]["status"] == "COMPLETED"


def test_visible_workspace_member_cannot_write_chain_lifecycle_resources(env):
    """Visibility grants reads only; all Phase 1 writes require chain membership."""
    created = _create_chain(env["owner_client"], env["workspace"], env["public_project"])
    chain_id = created.json()["data"]["id"]
    nodes_url = f"/api/research/workspaces/{env['workspace'].slug}/chains/{chain_id}/nodes/"
    node_payload = {
        "request_id": f"node-member-{uuid4().hex}",
        "node_type": "LITERATURE_REVIEW",
        "title": "未经授权的节点",
    }

    denied = env["collaborator_client"].post(nodes_url, node_payload, format="json")

    assert denied.status_code == 403, denied.json()

    invalid_type = env["owner_client"].post(
        nodes_url,
        {
            "request_id": f"node-invalid-{uuid4().hex}",
            "node_type": "not-a-research-node",
            "title": "非法节点类型",
        },
        format="json",
    )
    assert invalid_type.status_code == 422, invalid_type.json()

    node = env["owner_client"].post(
        nodes_url,
        {
            "request_id": f"node-owner-{uuid4().hex}",
            "node_type": "LITERATURE_REVIEW",
            "title": "授权节点",
        },
        format="json",
    ).json()["data"]
    events_url = f"/api/research/workspaces/{env['workspace'].slug}/nodes/{node['id']}/events/"
    event = env["collaborator_client"].post(
        events_url,
        {
            "request_id": f"event-member-{uuid4().hex}",
            "event_id": f"event-{uuid4().hex}",
            "event_type": "RESEARCH_NOTE",
            "summary": "未经授权的事件",
        },
        format="json",
    )

    assert event.status_code == 403, event.json()

    upload = env["collaborator_client"].post(
        f"/api/research/workspaces/{env['workspace'].slug}/chains/{chain_id}/uploads/",
        {
            "node_id": node["id"],
            "kb_id": "kb-unauthorized",
            "file": SimpleUploadedFile("unauthorized.md", b"denied", content_type="text/markdown"),
        },
        format="multipart",
        HTTP_X_REQUEST_ID=f"upload-member-{uuid4().hex}",
    )
    assert upload.status_code == 403, upload.json()

    analysis = env["collaborator_client"].post(
        f"/api/research/workspaces/{env['workspace'].slug}/chains/{chain_id}/analyses/",
        {
            "request_id": f"analysis-member-{uuid4().hex}",
            "node_id": node["id"],
            "method": "unauthorized analysis",
            "summary": "不应写入",
        },
        format="json",
    )
    assert analysis.status_code == 403, analysis.json()

    reference = env["collaborator_client"].post(
        f"/api/research/workspaces/{env['workspace'].slug}/chains/{chain_id}/references/",
        {
            "request_id": f"reference-member-{uuid4().hex}",
            "node_id": node["id"],
            "knowledge_id": "knowledge-unauthorized",
            "kb_id": "kb-unauthorized",
        },
        format="json",
    )
    assert reference.status_code == 403, reference.json()

    assert not ResearchChainUpload.objects.filter(request_id__startswith="upload-member-").exists()
    assert not ResearchAnalysisResult.objects.filter(request_id__startswith="analysis-member-").exists()


def test_loop_children_and_snapshots_are_versioned(env):
    """Loop iterations are unique and formal snapshots remain immutable."""
    created = _create_chain(env["owner_client"], env["workspace"], env["public_project"])
    chain_id = created.json()["data"]["id"]
    nodes_url = f"/api/research/workspaces/{env['workspace'].slug}/chains/{chain_id}/nodes/"
    root_payload = {
        "request_id": f"node-{uuid4().hex}",
        "node_type": "EXPERIMENT",
        "title": "预实验",
    }
    root = env["owner_client"].post(nodes_url, root_payload, format="json").json()["data"]
    invalid_child = env["owner_client"].post(
        nodes_url,
        {
            "request_id": f"node-{uuid4().hex}",
            "node_type": "EXPERIMENT",
            "title": "重复实验",
            "parent_node_id": root["id"],
            "loop_iteration": 0,
        },
        format="json",
    )
    assert invalid_child.status_code == 422

    child_payload = {
        "request_id": f"node-{uuid4().hex}",
        "node_type": "EXPERIMENT",
        "title": "重复实验",
        "parent_node_id": root["id"],
        "loop_iteration": 1,
    }
    child = env["owner_client"].post(nodes_url, child_payload, format="json")
    duplicate = env["owner_client"].post(
        nodes_url,
        {**child_payload, "request_id": f"node-{uuid4().hex}"},
        format="json",
    )
    assert child.status_code == 201, child.json()
    assert duplicate.status_code == 409

    events_url = f"/api/research/workspaces/{env['workspace'].slug}/nodes/{root['id']}/events/"
    event_payload = {
        "request_id": f"event-{uuid4().hex}",
        "event_id": f"event-{uuid4().hex}",
        "event_type": "AI_ACTION",
        "summary": "生成分析摘要",
    }
    assert env["owner_client"].post(events_url, event_payload, format="json").status_code == 201
    duplicate_event = env["owner_client"].post(
        events_url,
        {**event_payload, "request_id": f"event-{uuid4().hex}"},
        format="json",
    )
    assert duplicate_event.status_code == 409

    snapshots_url = f"/api/research/workspaces/{env['workspace'].slug}/nodes/{root['id']}/snapshots/"
    first = env["owner_client"].post(
        snapshots_url,
        {
            "request_id": f"snapshot-{uuid4().hex}",
            "summary": "第一轮实验",
            "source_versions": [{"kind": "experiment", "id": "exp-1", "version": 1}],
            "resources": [{"kind": "experiment", "id": "exp-1", "version": 1}],
            "event_range": {"first": "event-1", "last": "event-2"},
        },
        format="json",
    )
    second = env["owner_client"].post(
        snapshots_url,
        {
            "request_id": f"snapshot-{uuid4().hex}",
            "summary": "第二轮实验",
            "source_versions": [{"kind": "experiment", "id": "exp-1", "version": 2}],
            "resources": [{"kind": "experiment", "id": "exp-1", "version": 2}],
            "event_range": {"first": "event-1", "last": "event-3"},
        },
        format="json",
    )
    assert first.status_code == 201, first.json()
    assert second.status_code == 201, second.json()
    assert [first.json()["data"]["version"], second.json()["data"]["version"]] == [1, 2]
    assert second.json()["data"]["immutable"] is True


def test_timeline_and_export_replay_hashed_chain_facts(env):
    """Timeline and Markdown export preserve event order, versions and hashes."""
    created = _create_chain(env["owner_client"], env["workspace"], env["public_project"])
    chain_id = created.json()["data"]["id"]
    project_id = env["public_project"].id
    nodes_url = f"/api/research/workspaces/{env['workspace'].slug}/chains/{chain_id}/nodes/"
    node = env["owner_client"].post(
        nodes_url,
        {
            "request_id": f"node-{uuid4().hex}",
            "node_type": "EXPERIMENT",
            "title": "人工实验",
        },
        format="json",
    ).json()["data"]
    event_payload = {
        "request_id": f"event-{uuid4().hex}",
        "event_id": f"event-{uuid4().hex}",
        "event_type": "DATA_CHANGE",
        "summary": "记录实验参数",
    }
    event = env["owner_client"].post(
        f"/api/research/workspaces/{env['workspace'].slug}/nodes/{node['id']}/events/",
        event_payload,
        format="json",
    ).json()["data"]
    snapshot = env["owner_client"].post(
        f"/api/research/workspaces/{env['workspace'].slug}/nodes/{node['id']}/snapshots/",
        {
            "request_id": f"snapshot-{uuid4().hex}",
            "summary": "人工实验快照",
            "resources": [{"kind": "experiment", "id": "exp-1", "version": 1}],
        },
        format="json",
    ).json()["data"]

    timeline = env["owner_client"].get(
        f"/api/research/workspaces/{env['workspace'].slug}/projects/{project_id}/timeline/"
    )
    assert timeline.status_code == 200, timeline.json()
    items = timeline.json()["items"]
    assert any(item["kind"] == "chain_node" and item["target_id"] == node["id"] for item in items)
    assert any(item["kind"] == "chain_event" and item["content_hash"] == event["content_hash"] for item in items)
    assert any(item["kind"] == "chain_snapshot" and item["version"] == snapshot["version"] for item in items)

    exported = env["owner_client"].get(
        f"/api/research/workspaces/{env['workspace'].slug}/projects/{project_id}/chain/export/"
    )
    assert exported.status_code == 200
    body = exported.content.decode("utf-8")
    assert event["event_id"] in body
    assert event["content_hash"] in body
    assert f"v{snapshot['version']}" in body
    assert body.index("NODE_CREATED") < body.index("记录实验参数")
    assert exported["X-Research-Chain-SHA256"] == hashlib.sha256(exported.content).hexdigest()
