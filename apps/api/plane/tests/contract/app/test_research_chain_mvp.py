"""Phase 1 parallel Research Chain ACL and lifecycle contract tests."""

from uuid import uuid4

import pytest
from rest_framework.test import APIClient

from plane.db.models import Project, ResearchAuditEvent, ResearchChain, ResearchProjectProfile, ResearchUserProfile
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
