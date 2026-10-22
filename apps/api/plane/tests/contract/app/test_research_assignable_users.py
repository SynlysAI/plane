# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Research chain assignable-user boundary contracts."""

import pytest
from django.utils import timezone
from rest_framework.test import APIClient

from plane.db.models import ProjectMember, WorkspaceMember
from plane.research.services.chain_tasks import validate_assignable_user
from plane.tests.research_fixtures import make_research_boundary_fixture

pytestmark = pytest.mark.contract


@pytest.fixture
def env(db, settings):
    settings.RESEARCH_MODULE_ENABLED = True
    fixture = make_research_boundary_fixture()
    fixture["owner_client"] = _client(fixture["student"])
    return fixture


def _client(user):
    client = APIClient()
    client.force_authenticate(user=user)
    return client


def _url(env):
    return f"/api/research/workspaces/{env['workspace'].slug}/chains/{env['chain'].id}/assignable-users/"


def _candidate_ids(env):
    response = env["owner_client"].get(_url(env))
    assert response.status_code == 200, response.json()
    payload = response.json()
    assert payload["schema_version"] == "research-chain-assignable-user.v1"
    return {item["user_id"] for item in payload["data"]}


@pytest.mark.django_db
class TestResearchChainAssignableUsers:
    def test_organization_identity_alone_does_not_allow_assignment(self, env):
        candidates = _candidate_ids(env)

        assert str(env["student"].id) not in candidates
        assert str(env["group_member"].id) not in candidates
        assert str(env["ancestor"].id) not in candidates

    def test_descendant_guest_workspace_admin_and_unrelated_users_are_excluded(self, env):
        candidates = _candidate_ids(env)

        assert str(env["descendant"].id) not in candidates
        assert str(env["guest"].id) not in candidates
        assert str(env["workspace_admin"].id) not in candidates

    def test_cross_org_user_requires_explicit_project_collaboration(self, env):
        assert str(env["cross_org"].id) in _candidate_ids(env)

        member = env["cross_org_project_member"]
        member.is_active = False
        member.deleted_at = timezone.now()
        member.save(update_fields=["is_active", "deleted_at", "updated_at"])
        assert not validate_assignable_user(env["workspace"], env["chain"], env["cross_org"].id)

        member.is_active = True
        member.deleted_at = None
        member.save(update_fields=["is_active", "deleted_at", "updated_at"])
        assert validate_assignable_user(env["workspace"], env["chain"], env["cross_org"].id)

    def test_response_exposes_research_scope_without_account_email(self, env):
        ProjectMember.objects.create(project=env["project"], member=env["student"], role=20)
        response = env["owner_client"].get(_url(env))
        items = response.json()["data"]
        by_user = {item["user_id"]: item for item in items}

        student = by_user[str(env["student"].id)]
        assert student["display_name"]
        assert student["org_unit_id"] == str(env["group_a1"].id)
        assert student["org_unit_name"] == "Group A1"
        assert student["org_role"] == "OWNER"
        assert student["is_primary"] is True
        assert student["scope"] == "ORG_SCOPE"

        collaborator = by_user[str(env["cross_org"].id)]
        assert collaborator["org_unit_id"] is None
        assert collaborator["org_unit_name"] is None
        assert collaborator["org_role"] is None
        assert collaborator["is_primary"] is False
        assert collaborator["scope"] == "COLLABORATOR"
        assert "email" not in collaborator

    def test_reusable_validator_accepts_only_candidate_ids(self, env):
        assert not validate_assignable_user(env["workspace"], env["chain"], env["student"].id)
        assert not validate_assignable_user(env["workspace"], env["chain"], env["ancestor"].id)
        assert not validate_assignable_user(env["workspace"], env["chain"], env["descendant"].id)
        assert not validate_assignable_user(env["workspace"], env["chain"], env["guest"].id)
        assert not validate_assignable_user(env["workspace"], env["chain"], env["workspace_admin"].id)

    def test_non_writer_cannot_read_assignable_users(self, env):
        response = _client(env["advisor"]).get(_url(env))

        assert response.status_code == 403
        assert response.json()["error_code"] == "research_permission_denied"


@pytest.mark.django_db
@pytest.mark.parametrize(
    "invalidity",
    [
        "project_inactive",
        "project_deleted",
        "project_guest",
        "workspace_inactive",
        "workspace_deleted",
        "workspace_guest",
        "account_inactive",
    ],
)
def test_only_live_project_and_workspace_members_are_assignable(env, invalidity):
    """课题、工作区与账号任一失效都会撤销候选资格。"""
    user = env["group_member"]
    member = ProjectMember.objects.create(project=env["project"], member=user, role=15)
    workspace_member = WorkspaceMember.objects.get(workspace=env["workspace"], member=user)
    assert str(user.id) in _candidate_ids(env)
    target, field, value = {
        "project_inactive": (member, "is_active", False),
        "project_deleted": (member, "deleted_at", timezone.now()),
        "project_guest": (member, "role", 5),
        "workspace_inactive": (workspace_member, "is_active", False),
        "workspace_deleted": (workspace_member, "deleted_at", timezone.now()),
        "workspace_guest": (workspace_member, "role", 5),
        "account_inactive": (user, "is_active", False),
    }[invalidity]
    setattr(target, field, value)
    target.save(update_fields=[field])
    assert str(user.id) not in _candidate_ids(env)
    assert not validate_assignable_user(env["workspace"], env["chain"], user.id)
