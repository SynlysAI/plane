"""Administrative work-item notification-member contracts."""

import json
from uuid import uuid4

import pytest
from rest_framework.test import APIClient

from plane.bgtasks.notification_task import notifications
from plane.db.models import (
    AdministrativeOrganization,
    AdministrativeOrganizationMember,
    Issue,
    IssueActivity,
    IssueAssignee,
    IssueSubscriber,
    Notification,
    Project,
    ProjectMember,
    ResearchProjectProfile,
    State,
    User,
    WorkspaceMember,
)

pytestmark = pytest.mark.contract


def _client(user):
    client = APIClient()
    client.force_authenticate(user=user)
    return client


def _url(workspace, project, issue, suffix=""):
    return f"/api/workspaces/{workspace.slug}/projects/{project.id}/issues/{issue.id}/issue-subscribers/notification-recipients/{suffix}"


def _user(workspace, name, *, project=None, organization=None):
    user = User.objects.create(email=f"{name}-{uuid4().hex[:6]}@example.com", username=name)
    user.set_password("password")
    user.save()
    WorkspaceMember.objects.create(workspace=workspace, member=user, role=15)
    if project is not None:
        ProjectMember.objects.create(workspace=workspace, project=project, member=user, role=15)
    if organization is not None:
        AdministrativeOrganizationMember.objects.create(
            workspace=workspace, organization=organization, member=user
        )
    return user


@pytest.fixture
def env(db, workspace, create_user):
    project = Project.objects.create(
        name="Administrative Notifications",
        identifier=f"AN{uuid4().hex[:3]}",
        workspace=workspace,
        created_by=create_user,
        network=2,
    )

    ProjectMember.objects.create(workspace=workspace, project=project, member=create_user, role=20)
    organization = AdministrativeOrganization.objects.create(workspace=workspace, name="行政团队")
    project.administrative_organization = organization
    project.save(update_fields=["administrative_organization"])

    assignee = _user(workspace, "assignee", project=project)
    self_subscriber = _user(workspace, "self-subscriber", project=project)
    cc_member = _user(workspace, "organization-member", organization=organization)
    outsider = _user(workspace, "outsider")
    issue = Issue.objects.create(
        name="确认采购报价",
        project=project,
        workspace=workspace,
        created_by=create_user,
        state=State.objects.create(
            name="待处理",
            color="#000000",
            group="backlog",
            default=True,
            project=project,
            workspace=workspace,
            created_by=create_user,
        ),
    )
    IssueAssignee.objects.create(
        workspace=workspace, project=project, issue=issue, assignee=assignee
    )
    IssueSubscriber.objects.create(
        workspace=workspace,
        project=project,
        issue=issue,
        subscriber=assignee,
        source=IssueSubscriber.Source.SYSTEM,
    )
    IssueSubscriber.objects.create(
        workspace=workspace,
        project=project,
        issue=issue,
        subscriber=self_subscriber,
        source=IssueSubscriber.Source.SELF,
    )
    return {
        "workspace": workspace,
        "project": project,
        "issue": issue,
        "actor": create_user,
        "assignee": assignee,
        "self_subscriber": self_subscriber,
        "cc_member": cc_member,
        "outsider": outsider,
    }


@pytest.mark.django_db
class TestIssueNotificationRecipients:
    def test_administrative_issue_supports_organization_cc(self, env):
        client = _client(env["actor"])
        response = client.get(_url(env["workspace"], env["project"], env["issue"]))

        assert response.status_code == 200, response.json()
        payload = response.data
        candidate_ids = {item["id"] for item in payload["candidates"]}
        assert str(env["cc_member"].id) in candidate_ids
        assert str(env["outsider"].id) not in candidate_ids
        assert payload["can_manage"] is True

        response = client.put(
            _url(env["workspace"], env["project"], env["issue"]),
            {"user_ids": [str(env["cc_member"].id)]},
            format="json",
        )
        assert response.status_code == 200, response.json()
        assert response.data["cc_user_ids"] == [str(env["cc_member"].id)]
        assert set(response.data["fixed_user_ids"]) == {str(env["assignee"].id), str(env["self_subscriber"].id)}

        response = client.put(
            _url(env["workspace"], env["project"], env["issue"]),
            {"user_ids": [str(env["outsider"].id)]},
            format="json",
        )
        assert response.status_code == 422

        response = client.put(
            _url(env["workspace"], env["project"], env["issue"]),
            {"user_ids": []},
            format="json",
        )
        assert response.status_code == 200, response.json()
        assert not IssueSubscriber.objects.filter(
            issue=env["issue"], subscriber=env["cc_member"], source=IssueSubscriber.Source.CC, deleted_at__isnull=True
        ).exists()
        assert IssueSubscriber.objects.filter(
            issue=env["issue"], subscriber=env["assignee"], source=IssueSubscriber.Source.SYSTEM, deleted_at__isnull=True
        ).exists()
        assert IssueSubscriber.objects.filter(
            issue=env["issue"],
            subscriber=env["self_subscriber"],
            source=IssueSubscriber.Source.SELF,
            deleted_at__isnull=True,
        ).exists()

    def test_organization_cc_receives_activity_notification(self, env):
        client = _client(env["actor"])
        response = client.put(
            _url(env["workspace"], env["project"], env["issue"]),
            {"user_ids": [str(env["cc_member"].id)]},
            format="json",
        )
        assert response.status_code == 200, response.json()

        activity = IssueActivity.objects.create(
            issue=env["issue"],
            project=env["project"],
            workspace=env["workspace"],
            actor=env["actor"],
            verb="updated",
            field="priority",
            comment="updated the priority to",
            old_value="none",
            new_value="high",
        )
        notifications(
            type="issue.activity.updated",
            issue_id=str(env["issue"].id),
            project_id=str(env["project"].id),
            actor_id=str(env["actor"].id),
            subscriber=False,
            issue_activities_created=json.dumps(
                [
                    {
                        "id": str(activity.id),
                        "issue_detail": {"id": str(env["issue"].id)},
                        "verb": activity.verb,
                        "field": activity.field,
                        "comment": activity.comment,
                        "actor_id": str(env["actor"].id),
                        "new_value": activity.new_value,
                        "old_value": activity.old_value,
                        "new_identifier": None,
                        "old_identifier": None,
                        "created_at": activity.created_at.isoformat(),
                        "issue_comment": None,
                    }
                ]
            ),
            requested_data="{}",
            current_instance="{}",
        )

        receiver_ids = set(
            Notification.objects.filter(entity_identifier=env["issue"].id).values_list("receiver_id", flat=True)
        )
        assert {env["cc_member"].id, env["assignee"].id, env["self_subscriber"].id} <= receiver_ids

    def test_research_project_issue_does_not_expose_administrative_cc(self, env):
        ResearchProjectProfile.objects.create(
            workspace=env["workspace"],
            project=env["project"],
            owner=env["actor"],
            created_by=env["actor"],
        )
        response = _client(env["actor"]).get(_url(env["workspace"], env["project"], env["issue"]))

        assert response.status_code in {403, 404}
