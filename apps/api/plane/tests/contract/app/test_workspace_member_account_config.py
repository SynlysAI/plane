# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Contract coverage for workspace-scoped feedback operations accounts."""

import pytest
from rest_framework import status

from plane.db.models import User, Workspace, WorkspaceMember


def _bulk_account_config_url(workspace):
    """Return the bulk operations-account configuration URL.

    Args:
        workspace: Workspace whose member accounts are configured.

    Returns:
        The workspace-relative API route.
    """
    return f"/api/workspaces/{workspace.slug}/members/account-config/bulk/"


@pytest.fixture
def operations_candidate(db, workspace):
    """Create an ordinary member eligible for operations-account configuration."""
    user = User.objects.create(
        email="operations-candidate@plane.so",
        username="operations-candidate@plane.so",
        first_name="Operations",
        last_name="Candidate",
    )
    WorkspaceMember.objects.create(workspace=workspace, member=user, role=15)
    return user


@pytest.fixture
def member_client(api_client, workspace, operations_candidate):
    """Return a client authenticated as an ordinary workspace member."""
    api_client.force_authenticate(user=operations_candidate)
    return api_client


@pytest.mark.contract
@pytest.mark.django_db
class TestWorkspaceMemberAccountConfig:
    """Verify authorization, persistence, and workspace isolation."""

    def test_admin_can_set_and_cancel_operations_account(self, session_client, workspace, operations_candidate):
        """Setting and cancelling the marker is idempotent and preserves the member role."""
        payload = {"member_ids": [str(operations_candidate.id)], "is_operations_account": True}

        set_response = session_client.post(_bulk_account_config_url(workspace), payload, format="json")
        cancel_response = session_client.post(
            _bulk_account_config_url(workspace),
            {**payload, "is_operations_account": False},
            format="json",
        )

        assert set_response.status_code == status.HTTP_200_OK, set_response.data
        assert set_response.data["members"][0]["is_operations_account"] is True
        assert cancel_response.status_code == status.HTTP_200_OK
        assert cancel_response.data["members"][0]["is_operations_account"] is False
        membership = WorkspaceMember.objects.get(workspace=workspace, member=operations_candidate)
        assert membership.is_operations_account is False
        assert membership.role == 15
        assert membership.is_active is True

    def test_member_list_returns_operations_account_state(self, session_client, workspace, operations_candidate):
        """The member API exposes the persisted state for the settings table."""
        WorkspaceMember.objects.filter(workspace=workspace, member=operations_candidate).update(
            is_operations_account=True
        )

        response = session_client.get(f"/api/workspaces/{workspace.slug}/members/")

        assert response.status_code == status.HTTP_200_OK
        member = next(item for item in response.data if str(item["member"]["id"]) == str(operations_candidate.id))
        assert member["is_operations_account"] is True

    def test_member_cannot_configure_accounts(self, member_client, workspace, operations_candidate):
        """An ordinary member cannot grant the marker through a direct API call."""
        response = member_client.post(
            _bulk_account_config_url(workspace),
            {"member_ids": [str(operations_candidate.id)], "is_operations_account": True},
            format="json",
        )

        assert response.status_code == status.HTTP_403_FORBIDDEN
        assert not WorkspaceMember.objects.get(workspace=workspace, member=operations_candidate).is_operations_account

    def test_rejects_admin_guest_and_cross_workspace_members_in_one_batch(
        self, session_client, workspace, operations_candidate, create_user
    ):
        """Only active ordinary members in the selected workspace are configurable."""
        guest = User.objects.create(email="guest@plane.so", username="guest@plane.so")
        WorkspaceMember.objects.create(workspace=workspace, member=guest, role=5)
        other_workspace = Workspace.objects.create(
            name="Other workspace", owner=create_user, slug="other-account-config"
        )
        WorkspaceMember.objects.create(workspace=other_workspace, member=operations_candidate, role=15)

        for member_ids in (
            [str(create_user.id)],
            [str(guest.id)],
            [str(operations_candidate.id), str(create_user.id)],
        ):
            response = session_client.post(
                _bulk_account_config_url(workspace),
                {"member_ids": member_ids, "is_operations_account": True},
                format="json",
            )
            assert response.status_code == status.HTTP_400_BAD_REQUEST

        assert not WorkspaceMember.objects.filter(is_operations_account=True).exists()

    def test_existing_member_patch_cannot_change_operations_marker(
        self, session_client, workspace, operations_candidate
    ):
        """The role endpoint keeps the marker read-only and account changes use the dedicated API."""
        membership = WorkspaceMember.objects.get(workspace=workspace, member=operations_candidate)

        response = session_client.patch(
            f"/api/workspaces/{workspace.slug}/members/{membership.id}/",
            {"is_operations_account": True},
            format="json",
        )

        membership.refresh_from_db()
        assert response.status_code == status.HTTP_200_OK
        assert membership.is_operations_account is False
