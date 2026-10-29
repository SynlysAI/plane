# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Contract tests for administrative project and work-item assignment scope."""

from unittest import mock
from uuid import uuid4

import pytest
from rest_framework import status

from plane.app.views.workspace.todos import administrative_todos
from plane.db.models import Issue, IssueAssignee, Project, ProjectMember, State, User, WorkspaceMember


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
        mock.patch("plane.utils.issue_mutations.model_activity.delay"),
        mock.patch("plane.utils.issue_mutations.issue_description_version_task.delay"),
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

    @pytest.mark.django_db
    def test_multiple_assignees_are_rejected(self, session_client, workspace, project, create_user):
        """The work-item API keeps its list shape but accepts at most one owner."""
        second = make_user("second-owner")
        add_workspace_member(workspace, second)
        ProjectMember.objects.create(
            workspace=workspace,
            project=project,
            member=second,
            role=15,
            is_active=True,
        )

        response = session_client.post(
            issue_url(workspace, project),
            {"name": "Multiple owners", "assignee_ids": [str(create_user.id), str(second.id)]},
            format="json",
        )

        assert response.status_code == status.HTTP_400_BAD_REQUEST, response.data
        assert not Issue.objects.filter(name="Multiple owners").exists()

    @pytest.mark.django_db
    def test_reassignment_replaces_the_previous_owner(self, session_client, workspace, project, create_user):
        """Choosing a new owner removes the earlier owner instead of appending one."""
        second = make_user("replacement-owner")
        add_workspace_member(workspace, second)
        ProjectMember.objects.create(
            workspace=workspace,
            project=project,
            member=second,
            role=15,
            is_active=True,
        )
        issue = Issue.objects.create(
            name="Reassign owner",
            project=project,
            workspace=workspace,
            created_by=create_user,
        )
        IssueAssignee.objects.create(
            issue=issue,
            project=project,
            workspace=workspace,
            assignee=create_user,
        )

        response = session_client.patch(
            f"{issue_url(workspace, project)}{issue.id}/",
            {"assignee_ids": [str(second.id)]},
            format="json",
        )

        assert response.status_code == status.HTTP_204_NO_CONTENT, response.data
        issue.refresh_from_db()
        assert list(
            IssueAssignee.objects.filter(issue=issue, deleted_at__isnull=True).values_list("assignee_id", flat=True)
        ) == [second.id]

    @pytest.mark.django_db
    def test_repeated_assignment_is_idempotent(self, session_client, workspace, project, create_user):
        """重复提交同一负责人不新增关联记录。"""
        issue = Issue.objects.create(
            name="Repeated owner", project=project, workspace=workspace, created_by=create_user
        )

        for _ in range(2):
            response = session_client.patch(
                f"{issue_url(workspace, project)}{issue.id}/",
                {"assignee_ids": [str(create_user.id)]},
                format="json",
            )
            assert response.status_code == status.HTTP_204_NO_CONTENT, response.data

        assert IssueAssignee.objects.filter(issue=issue).count() == 1
        assert IssueAssignee.all_objects.filter(issue=issue).count() == 1

    @pytest.mark.django_db
    def test_clearing_the_owner_soft_deletes_the_active_assignment(
        self, session_client, workspace, project, create_user
    ):
        """清空负责人只移除当前有效关联，不生成新的空关联。"""
        issue = Issue.objects.create(name="Clear owner", project=project, workspace=workspace, created_by=create_user)
        assignment = IssueAssignee.objects.create(
            issue=issue, project=project, workspace=workspace, assignee=create_user
        )

        response = session_client.patch(
            f"{issue_url(workspace, project)}{issue.id}/", {"assignee_ids": []}, format="json"
        )

        assert response.status_code == status.HTTP_204_NO_CONTENT, response.data
        assert not IssueAssignee.objects.filter(issue=issue).exists()
        assert IssueAssignee.all_objects.filter(pk=assignment.id, deleted_at__isnull=False).exists()

    @pytest.mark.django_db
    def test_direct_assignment_preserves_work_item_state(self, session_client, workspace, project, create_user):
        """直接指派负责人不改变工作项原有状态。"""
        state = State.objects.filter(project=project, group="unstarted").first()
        issue = Issue.objects.create(
            name="Preserve state",
            project=project,
            workspace=workspace,
            created_by=create_user,
            state=state,
        )

        response = session_client.patch(
            f"{issue_url(workspace, project)}{issue.id}/",
            {"assignee_ids": [str(create_user.id)]},
            format="json",
        )

        assert response.status_code == status.HTTP_204_NO_CONTENT, response.data
        issue.refresh_from_db()
        assert issue.state_id == state.id
        assert issue.state.group == "unstarted"

    @pytest.mark.django_db
    def test_administrative_todos_use_only_the_current_assignee(self, session_client, workspace, project, create_user):
        """历史负责人关联软删除后不再进入行政待办。"""
        previous_owner = make_user("previous-owner")
        current_owner = make_user("current-owner")
        for user in (previous_owner, current_owner):
            add_workspace_member(workspace, user)
            ProjectMember.objects.create(workspace=workspace, project=project, member=user, role=15, is_active=True)
        issue = Issue.objects.create(
            name="Current owner todo", project=project, workspace=workspace, created_by=create_user
        )
        IssueAssignee.objects.create(issue=issue, project=project, workspace=workspace, assignee=previous_owner)
        IssueAssignee.objects.filter(issue=issue, assignee=previous_owner).delete()
        IssueAssignee.objects.create(issue=issue, project=project, workspace=workspace, assignee=current_owner)

        previous_todos = [todo["object_id"] for todo in administrative_todos(workspace, previous_owner)]
        current_todos = [todo["object_id"] for todo in administrative_todos(workspace, current_owner)]

        assert str(issue.id) not in previous_todos
        assert str(issue.id) in current_todos
