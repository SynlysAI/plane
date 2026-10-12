# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Contract tests for administrative project and work-item assignment scope."""

from unittest import mock
from uuid import uuid4

import pytest
from rest_framework import status

from plane.db.models import Issue, Project, ProjectMember, State, User, WorkspaceMember


def issue_url(workspace, project):
    """Build the app work-item collection endpoint."""
    return f"/api/workspaces/{workspace.slug}/projects/{project.id}/issues/"


def project_url(workspace, project):
    """Build the app project detail endpoint."""
    return f"/api/workspaces/{workspace.slug}/projects/{project.id}/"


def make_user(name):
    """Create a deterministic user for assignment-boundary tests."""
    unique = uuid4().hex[:8]
    return User.objects.create_user(
        email=f"{name}-{unique}@plane.so",
        username=f"{name}_{unique}",
        first_name=name.title(),
    )


def add_workspace_member(workspace, user, role=15):
    """Create an active workspace membership without granting project membership."""
    return WorkspaceMember.objects.create(
        workspace=workspace,
        member=user,
        role=role,
        is_active=True,
    )


@pytest.fixture(autouse=True)
def no_issue_side_effects():
    """Keep contract tests focused on HTTP assignment validation."""
    with (
        mock.patch("plane.app.views.issue.base.issue_activity.delay"),
        mock.patch("plane.app.views.issue.base.model_activity.delay"),
        mock.patch("plane.app.views.issue.base.issue_description_version_task.delay"),
    ):
        yield


@pytest.fixture
def project(db, workspace, create_user):
    """Create a project whose creator is the only active administrative member."""
    project = Project.objects.create(
        name="Administrative Boundary",
        identifier="ADB",
        workspace=workspace,
        created_by=create_user,
    )
    ProjectMember.objects.create(
        workspace=workspace,
        project=project,
        member=create_user,
        role=15,
        is_active=True,
    )
    State.objects.create(
        name="Todo",
        color="#000000",
        group="unstarted",
        default=True,
        project=project,
        workspace=workspace,
        created_by=create_user,
    )
    return project


@pytest.mark.contract
class TestAdministrativeIssueAssignmentBoundary:
    @pytest.mark.django_db
    def test_active_project_member_can_be_assigned(self, session_client, workspace, project, create_user):
        response = session_client.post(
            issue_url(workspace, project),
            {"name": "Valid assignment", "assignee_ids": [str(create_user.id)]},
            format="json",
        )

        assert response.status_code == status.HTTP_201_CREATED, response.data
        issue = Issue.objects.get(name="Valid assignment")
        assert list(issue.assignees.values_list("id", flat=True)) == [create_user.id]

    @pytest.mark.django_db
    def test_workspace_member_outside_project_is_rejected(self, session_client, workspace, project):
        outsider = make_user("outsider")
        add_workspace_member(workspace, outsider)

        response = session_client.post(
            issue_url(workspace, project),
            {"name": "Invalid assignment", "assignee_ids": [str(outsider.id)]},
            format="json",
        )

        assert response.status_code == status.HTTP_400_BAD_REQUEST, response.data
        assert not Issue.objects.filter(name="Invalid assignment").exists()

    @pytest.mark.django_db
    def test_inactive_project_member_is_rejected(self, session_client, workspace, project, create_user):
        inactive_member = make_user("inactive-member")
        add_workspace_member(workspace, inactive_member)
        ProjectMember.objects.create(
            workspace=workspace,
            project=project,
            member=inactive_member,
            role=15,
            is_active=False,
        )

        response = session_client.post(
            issue_url(workspace, project),
            {"name": "Inactive assignment", "assignee_ids": [str(inactive_member.id)]},
            format="json",
        )

        assert response.status_code == status.HTTP_400_BAD_REQUEST, response.data
        assert not Issue.objects.filter(name="Inactive assignment").exists()

    @pytest.mark.django_db
    def test_updating_with_non_project_member_is_rejected(self, session_client, workspace, project, create_user):
        issue = Issue.objects.create(
            name="Existing assignment",
            project=project,
            workspace=workspace,
            created_by=create_user,
        )
        outsider = make_user("update-outsider")
        add_workspace_member(workspace, outsider)

        response = session_client.patch(
            f"{issue_url(workspace, project)}{issue.id}/",
            {"assignee_ids": [str(outsider.id)]},
            format="json",
        )

        assert response.status_code == status.HTTP_400_BAD_REQUEST, response.data
        issue.refresh_from_db()
        assert list(issue.assignees.values_list("id", flat=True)) == []

    @pytest.mark.django_db
    def test_project_without_assignable_members_blocks_creation(self, session_client, workspace, project):
        ProjectMember.objects.filter(project=project).update(is_active=False)

        response = session_client.post(
            issue_url(workspace, project),
            {"name": "Empty roster assignment"},
            format="json",
        )

        assert response.status_code in (status.HTTP_400_BAD_REQUEST, status.HTTP_403_FORBIDDEN)
        assert not Issue.objects.filter(name="Empty roster assignment").exists()


@pytest.mark.contract
class TestAdministrativeProjectLeadBoundary:
    @pytest.mark.django_db
    def test_project_lead_must_be_an_active_project_member_on_update(
        self, session_client, workspace, project, create_user
    ):
        valid_lead = make_user("valid-lead")
        add_workspace_member(workspace, valid_lead)
        ProjectMember.objects.create(
            workspace=workspace,
            project=project,
            member=valid_lead,
            role=20,
            is_active=True,
        )

        response = session_client.patch(
            project_url(workspace, project),
            {"project_lead": str(valid_lead.id)},
            format="json",
        )

        assert response.status_code == status.HTTP_200_OK, response.data
        project.refresh_from_db()
        assert project.project_lead_id == valid_lead.id

    @pytest.mark.django_db
    def test_workspace_member_outside_project_cannot_become_lead(self, session_client, workspace, project):
        outsider = make_user("lead-outsider")
        add_workspace_member(workspace, outsider)

        response = session_client.patch(
            project_url(workspace, project),
            {"project_lead": str(outsider.id)},
            format="json",
        )

        assert response.status_code == status.HTTP_400_BAD_REQUEST, response.data
        project.refresh_from_db()
        assert project.project_lead_id is None

    @pytest.mark.django_db
    def test_inactive_project_member_cannot_become_lead(self, session_client, workspace, project):
        inactive_lead = make_user("inactive-lead")
        add_workspace_member(workspace, inactive_lead)
        ProjectMember.objects.create(
            workspace=workspace,
            project=project,
            member=inactive_lead,
            role=20,
            is_active=False,
        )

        response = session_client.patch(
            project_url(workspace, project),
            {"project_lead": str(inactive_lead.id)},
            format="json",
        )

        assert response.status_code == status.HTTP_400_BAD_REQUEST, response.data
        project.refresh_from_db()
        assert project.project_lead_id is None
