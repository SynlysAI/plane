"""AI-Native Research Workspace RWS-1 control-plane contracts."""

from uuid import uuid4
from concurrent.futures import ThreadPoolExecutor

import pytest
from rest_framework.test import APIClient

from plane.db.models import (
    Project,
    ResearchChain,
    ResearchProjectProfile,
    StudyWorkspace,
    WorkspaceOperation,
    WorkspaceResourceReference,
)
from plane.tests.research_fixtures import (
    add_workspace_member,
    enable_research,
    make_org_member,
    make_user,
    make_workspace,
)
from plane.research.services.workspaces.control_plane import ensure_study_workspace

pytestmark = pytest.mark.contract


@pytest.fixture(autouse=True)
def research_module_on(settings):
    settings.RESEARCH_MODULE_ENABLED = True


def client_for(user):
    client = APIClient()
    client.force_authenticate(user=user)
    return client


@pytest.fixture
def env(transactional_db):
    admin = make_user(first_name="Admin")
    workspace = make_workspace(admin, name="RWS workspace")
    enable_research(workspace, research_chain_enabled=True, study_workspace_enabled=True)
    make_org_member(workspace, admin)

    owner = make_user(first_name="Owner")
    add_workspace_member(workspace, owner)
    make_org_member(workspace, owner)

    unauthorized = make_user(first_name="Unauthorized")
    add_workspace_member(workspace, unauthorized)
    make_org_member(workspace, unauthorized)

    suffix = uuid4().hex[:8]
    project = Project.objects.create(
        workspace=workspace,
        name=f"Study {suffix}",
        identifier=f"ST{suffix[:6]}",
        network=0,
        created_by=owner,
    )
    ResearchProjectProfile.objects.create(
        project=project,
        workspace=workspace,
        owner=owner,
        chain_kind=ResearchProjectProfile.ChainKind.RESEARCH_CHAIN,
        chain_visibility=ResearchProjectProfile.ChainVisibility.PRIVATE,
        created_by=owner,
    )
    chain = ResearchChain.objects.create(
        project=project,
        workspace=workspace,
        owner=owner,
        visibility="PRIVATE",
        request_id=f"chain-{uuid4().hex}",
        payload_hash="a" * 64,
        created_by=owner,
    )

    other_owner = make_user(first_name="Other", last_name="Owner")
    other_workspace = make_workspace(other_owner, name="Other RWS workspace")
    enable_research(other_workspace, research_chain_enabled=True, study_workspace_enabled=True)
    make_org_member(other_workspace, other_owner)
    add_workspace_member(other_workspace, unauthorized)
    make_org_member(other_workspace, unauthorized)

    return {
        "admin": admin,
        "owner": owner,
        "unauthorized": unauthorized,
        "workspace": workspace,
        "other_workspace": other_workspace,
        "project": project,
        "chain": chain,
        "admin_client": client_for(admin),
        "owner_client": client_for(owner),
        "unauthorized_client": client_for(unauthorized),
    }


def ensure_url(workspace):
    return f"/api/research/workspaces/{workspace.slug}/study-workspaces/ensure/"


def study_url(workspace, study_id, suffix=""):
    return f"/api/research/workspaces/{workspace.slug}/study-workspaces/{study_id}/{suffix}"


def reference_url(workspace, study_id, suffix=""):
    return study_url(workspace, study_id, f"resource-refs/{suffix}")


def ensure_study(env, request_id="ensure-study", chain=None):
    chain = chain or env["chain"]
    return env["admin_client"].post(
        ensure_url(env["workspace"]),
        {"chain_id": str(chain.id)},
        format="json",
        headers={"X-Request-Id": request_id},
    )


def test_repeated_ensure_is_idempotent_and_records_replay(env):
    first = ensure_study(env)
    second = ensure_study(env)

    assert first.status_code == 201, first.data
    assert second.status_code == 200, second.data
    assert second.json()["data"]["id"] == first.json()["data"]["id"]
    assert StudyWorkspace.objects.count() == 1
    assert WorkspaceOperation.objects.filter(kind="ENSURE_STUDY_WORKSPACE").count() == 1


def test_concurrent_ensure_with_same_request_id_returns_one_resource(env):
    """Two concurrent timeout replays converge on one StudyWorkspace and operation."""

    def invoke():
        return ensure_study_workspace(
            env["workspace"],
            env["chain"],
            env["admin"],
            "concurrent-ensure",
            {"chain_id": str(env["chain"].id)},
        )

    with ThreadPoolExecutor(max_workers=2) as executor:
        results = [future.result() for future in (executor.submit(invoke), executor.submit(invoke))]

    assert sorted(result.created for result in results) == [False, True]
    assert {result.study.id for result in results} == {results[0].study.id}
    assert StudyWorkspace.objects.count() == 1
    assert WorkspaceOperation.objects.filter(request_id="concurrent-ensure").count() == 1


def test_same_request_id_with_different_payload_returns_stable_conflict(env):
    first = ensure_study(env)
    conflict = env["admin_client"].post(
        ensure_url(env["workspace"]),
        {"chain_id": str(env["chain"].id), "metadata": {"retry": True}},
        format="json",
        headers={"X-Request-Id": "ensure-study"},
    )

    assert first.status_code == 201
    assert conflict.status_code == 409
    assert conflict.json()["error_code"] == "RWS_IDEMPOTENCY_CONFLICT"
    assert StudyWorkspace.objects.count() == 1


def test_ensure_creates_one_default_working_copy_with_resource_uri(env):
    response = ensure_study(env)
    data = response.json()["data"]
    study = StudyWorkspace.objects.get(pk=data["id"])

    assert data["resource_uri"] == f"plane-rws://study-workspaces/{study.id}"
    assert data["working_copy"]["is_default"] is True
    assert data["working_copy"]["status"] == "PENDING"
    assert data["working_copy"]["branch"] == "main"
    assert study.default_working_copy.storage_key == f"working-copies/{study.id}"


@pytest.mark.parametrize(
    "kind,overrides",
    [
        (
            "git",
            {
                "repository_id": "71824e61-a59f-48b1-9f13-e3a2d0970001",
                "commit": "8d202d35f26e10267cb6cbac70142ee219800001",
                "path": "research/opening/report.md",
                "blob_oid": "3dce58322c727a459c1acf75c95fe7a04cf30001",
            },
        ),
        (
            "lfs",
            {
                "repository_id": "71824e61-a59f-48b1-9f13-e3a2d0970001",
                "commit": "8d202d35f26e10267cb6cbac70142ee219800001",
                "path": "results/figure.png",
                "lfs_oid": "6b2f4c14a91a90dd5767de1e41a97f193f31c70af12dc8058ff9e38d80000001",
            },
        ),
        (
            "asset",
            {
                "asset_revision_id": "81824e61-a59f-48b1-9f13-e3a2d0970002",
                "logical_asset_id": "91824e61-a59f-48b1-9f13-e3a2d0970003",
                "path": "data/raw.csv",
            },
        ),
    ],
)
def test_fixed_references_cover_git_lfs_and_asset(env, kind, overrides):
    study_id = ensure_study(env).json()["data"]["id"]
    payload = {
        "schema_version": "research-resource-ref.v1",
        "study_id": study_id,
        "kind": kind,
        "content_sha256": "6b2f4c14a91a90dd5767de1e41a97f193f31c70af12dc8058ff9e38d80000001",
        "size": 12345,
        "source_system": "plane-test",
        **overrides,
    }
    response = env["owner_client"].post(
        reference_url(env["workspace"], study_id),
        payload,
        format="json",
        headers={"X-Request-Id": f"ref-{kind}"},
    )
    replay = env["owner_client"].post(
        reference_url(env["workspace"], study_id),
        payload,
        format="json",
        headers={"X-Request-Id": f"ref-{kind}"},
    )

    assert response.status_code == 201, response.data
    assert replay.status_code == 200, replay.data
    data = response.json()["data"]
    assert data["kind"] == kind
    assert len(data["digest"]) == 64
    assert data["resource_uri"] == f"plane-rws://study-workspaces/{study_id}/resources/{data['digest']}"
    assert WorkspaceResourceReference.objects.count() == 1
    assert WorkspaceOperation.objects.get(kind="REGISTER_RESOURCE_REF").status == "SUCCEEDED"


@pytest.mark.parametrize(
    "mutation",
    [
        lambda study_id: {"study_id": str(uuid4())},
        lambda study_id: {"kind": "git", "blob_oid": "0" * 39},
        lambda study_id: {"kind": "git", "path": "../escape.txt"},
        lambda study_id: {"kind": "git", "commit": "0" * 39},
        lambda study_id: {"content_sha256": "6B2F4C14A91A90DD5767DE1E41A97F193F31C70AF12DC8058FF9E38D80000001"},
    ],
)
def test_invalid_fixed_references_are_rejected_without_writes(env, mutation):
    study_id = ensure_study(env).json()["data"]["id"]
    payload = {
        "schema_version": "research-resource-ref.v1",
        "study_id": study_id,
        "kind": "git",
        "repository_id": "71824e61-a59f-48b1-9f13-e3a2d0970001",
        "commit": "8d202d35f26e10267cb6cbac70142ee219800001",
        "path": "research/opening/report.md",
        "blob_oid": "3dce58322c727a459c1acf75c95fe7a04cf30001",
        "content_sha256": "6b2f4c14a91a90dd5767de1e41a97f193f31c70af12dc8058ff9e38d80000001",
        "size": 12345,
    }
    payload.update(mutation(study_id))
    response = env["owner_client"].post(
        reference_url(env["workspace"], study_id),
        payload,
        format="json",
        headers={"X-Request-Id": "invalid-ref"},
    )

    assert response.status_code == 422
    assert response.json()["error_code"] == "RWS_RESOURCE_REF_INVALID"
    assert WorkspaceResourceReference.objects.count() == 0
    assert not WorkspaceOperation.objects.filter(kind="REGISTER_RESOURCE_REF").exists()


def test_unauthorized_users_cannot_probe_private_study_workspace(env):
    study_id = ensure_study(env).json()["data"]["id"]

    same_workspace = env["unauthorized_client"].get(study_url(env["workspace"], study_id))
    cross_workspace = env["unauthorized_client"].get(study_url(env["workspace"], study_id))

    assert same_workspace.status_code == 404
    assert cross_workspace.status_code == 404
    assert same_workspace.json().get("data") is None


def test_workspace_and_chain_flags_do_not_change_legacy_chain_api(env):
    study_id = ensure_study(env).json()["data"]["id"]
    setting = env["workspace"].research_setting
    setting.study_workspace_enabled = False
    setting.save(update_fields=["study_workspace_enabled"])
    study = StudyWorkspace.objects.get(pk=study_id)
    study.is_enabled = False
    study.save(update_fields=["is_enabled"])

    disabled = env["owner_client"].get(study_url(env["workspace"], study_id))
    legacy_chain = env["owner_client"].get(
        f"/api/research/workspaces/{env['workspace'].slug}/chains/{env['chain'].id}/"
    )

    assert disabled.status_code == 404
    assert disabled.json()["error_code"] == "RWS_STUDY_WORKSPACE_DISABLED"
    assert legacy_chain.status_code == 200


def test_operation_records_actor_payload_head_status_and_error_fields(env):
    ensure_study(env, request_id="operation-check")
    operation = WorkspaceOperation.objects.get(request_id="operation-check")

    assert operation.actor_id == env["admin"].id
    assert operation.actor_type == "USER"
    assert operation.kind == "ENSURE_STUDY_WORKSPACE"
    assert len(operation.payload_hash) == 64
    assert operation.expected_head == ""
    assert operation.status == WorkspaceOperation.Status.SUCCEEDED
    assert operation.error_code == ""
    assert operation.error_message == ""
