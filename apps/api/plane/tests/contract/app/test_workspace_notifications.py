# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

# Third party imports
import pytest
from rest_framework import status

# Module imports
from plane.db.models import Issue, Notification, Project


def notification_url(workspace, path=""):
    """Build the workspace notification API URL.

    Args:
        workspace: Workspace containing the notifications.
        path: Optional endpoint path appended after the notification root.

    Returns:
        Absolute API path used by the app client.
    """
    return f"/api/workspaces/{workspace.slug}/users/notifications/{path}"


def create_notification(project, issue, receiver, *, sender="issue_activities", **overrides):
    """Create a renderable work item notification.

    Args:
        project: Project linked to the notification.
        issue: Work item linked to the notification.
        receiver: User receiving the notification.
        sender: Stable sender identifier used to distinguish mentions.
        **overrides: Fields overridden for a specific test case.

    Returns:
        The created notification instance.
    """
    data = {
        "issue": {
            "id": str(issue.id),
            "name": issue.name,
            "identifier": project.identifier,
            "sequence_id": issue.sequence_id,
            "state_name": None,
            "state_group": None,
        },
        "issue_activity": {
            "id": "00000000-0000-0000-0000-000000000001",
            "field": "state",
            "verb": "updated",
            "actor": str(receiver.id),
        },
    }
    payload = {
        "workspace": project.workspace,
        "project": project,
        "receiver": receiver,
        "entity_identifier": issue.id,
        "entity_name": "issue",
        "title": f"{issue.name} updated",
        "message": {"action": "updated"},
        "sender": sender,
        "data": data,
        **overrides,
    }
    return Notification.objects.create(**payload)


@pytest.fixture
def notification_project(db, workspace, create_user):
    """Create a project used by notification contract tests."""
    return Project.objects.create(
        name="Notification Project",
        identifier="NOTIF",
        workspace=workspace,
        created_by=create_user,
    )


@pytest.fixture
def make_issue(notification_project, create_user):
    """Return a factory that creates work items for notifications."""

    def _make_issue(name, **overrides):
        return Issue.objects.create(
            name=name,
            project=notification_project,
            workspace=notification_project.workspace,
            created_by=create_user,
            **overrides,
        )

    return _make_issue


@pytest.mark.contract
@pytest.mark.django_db
class TestWorkspaceNotificationConsistency:
    """Verify that notification lists and unread counts use the same scope."""

    def test_counts_and_default_list_include_only_active_renderable_notifications(
        self, session_client, workspace, notification_project, make_issue, create_user
    ):
        """Active normal and mention notifications are counted and listed together."""
        normal = make_issue("Normal")
        mention = make_issue("Mention")
        read = make_issue("Read")
        archived = make_issue("Archived")
        snoozed = make_issue("Snoozed")
        deleted = make_issue("Deleted")

        create_notification(notification_project, normal, create_user)
        create_notification(notification_project, mention, create_user, sender="in_app:issue_activities:mentioned")
        create_notification(notification_project, read, create_user, read_at="2026-01-01T00:00:00Z")
        create_notification(notification_project, archived, create_user, archived_at="2026-01-01T00:00:00Z")
        create_notification(notification_project, snoozed, create_user, snoozed_till="2099-01-01T00:00:00Z")
        create_notification(notification_project, deleted, create_user)
        deleted.delete()

        list_response = session_client.get(notification_url(workspace))
        unread_response = session_client.get(notification_url(workspace, "unread/"))

        assert list_response.status_code == status.HTTP_200_OK
        assert unread_response.status_code == status.HTTP_200_OK
        issue_ids = {issue.name: str(issue.id) for issue in (normal, mention, read, archived, snoozed, deleted)}
        assert {item["entity_identifier"] for item in list_response.data} == {
            str(normal.id),
            str(mention.id),
            str(read.id),
        }, issue_ids
        assert unread_response.data == {
            "total_unread_notifications_count": 2,
            "mention_unread_notifications_count": 1,
        }

    def test_mention_filter_returns_only_mention_notifications(
        self, session_client, workspace, notification_project, make_issue, create_user
    ):
        """The mention tab is a subset of the all notifications tab."""
        normal = make_issue("Normal")
        mention = make_issue("Mention")
        create_notification(notification_project, normal, create_user)
        create_notification(notification_project, mention, create_user, sender="in_app:issue_activities:mentioned")

        response = session_client.get(notification_url(workspace), {"mentioned": "true"})

        assert response.status_code == status.HTTP_200_OK
        assert [item["entity_identifier"] for item in response.data] == [str(mention.id)]

    def test_invalid_issue_states_and_payloads_are_excluded(
        self, session_client, workspace, notification_project, make_issue, create_user
    ):
        """Draft, archived, project-archived, and malformed notifications are hidden."""
        draft = make_issue("Draft", is_draft=True)
        archived_issue = make_issue("Archived issue", archived_at="2026-01-01")
        active = make_issue("Active")
        archived_project_issue = make_issue("Archived project issue")

        create_notification(notification_project, draft, create_user)
        create_notification(notification_project, archived_issue, create_user)
        create_notification(notification_project, active, create_user)
        create_notification(notification_project, archived_project_issue, create_user)
        create_notification(notification_project, active, create_user, data={})
        create_notification(
            notification_project,
            active,
            create_user,
            data={"issue": {"id": str(active.id)}, "issue_activity": {"field": ""}},
        )
        create_notification(notification_project, active, create_user, entity_name="research_report")
        notification_project.archived_at = "2026-01-01T00:00:00Z"
        notification_project.save()

        list_response = session_client.get(notification_url(workspace))
        unread_response = session_client.get(notification_url(workspace, "unread/"))

        assert list_response.status_code == status.HTTP_200_OK
        assert list_response.data == []
        assert unread_response.data == {
            "total_unread_notifications_count": 0,
            "mention_unread_notifications_count": 0,
        }

    def test_single_notification_read_state_updates_both_counts(
        self, session_client, workspace, notification_project, make_issue, create_user
    ):
        """Reading and unreading a mention updates total and mention counts."""
        issue = make_issue("Mention")
        notification = create_notification(
            notification_project, issue, create_user, sender="in_app:issue_activities:mentioned"
        )

        read_response = session_client.post(notification_url(workspace, f"{notification.id}/read/"))
        count_after_read = session_client.get(notification_url(workspace, "unread/")).data
        unread_response = session_client.delete(notification_url(workspace, f"{notification.id}/read/"))
        count_after_unread = session_client.get(notification_url(workspace, "unread/")).data

        assert read_response.status_code == status.HTTP_200_OK
        assert unread_response.status_code == status.HTTP_200_OK
        assert count_after_read == {
            "total_unread_notifications_count": 0,
            "mention_unread_notifications_count": 0,
        }
        assert count_after_unread == {
            "total_unread_notifications_count": 1,
            "mention_unread_notifications_count": 1,
        }

    def test_mark_all_read_respects_mention_scope(
        self, session_client, workspace, notification_project, make_issue, create_user
    ):
        """Marking mentions read leaves ordinary unread notifications active."""
        normal = make_issue("Normal")
        mention = make_issue("Mention")
        create_notification(notification_project, normal, create_user)
        create_notification(notification_project, mention, create_user, sender="in_app:issue_activities:mentioned")

        response = session_client.post(notification_url(workspace, "mark-all-read/"), {"mentioned": True})
        counts = session_client.get(notification_url(workspace, "unread/")).data

        assert response.status_code == status.HTTP_200_OK
        assert counts == {
            "total_unread_notifications_count": 1,
            "mention_unread_notifications_count": 0,
        }

    def test_mark_all_read_marks_normal_and_mention_notifications(
        self, session_client, workspace, notification_project, make_issue, create_user
    ):
        """Marking the all tab read clears every renderable unread notification."""
        normal = make_issue("Normal")
        mention = make_issue("Mention")
        create_notification(notification_project, normal, create_user)
        create_notification(notification_project, mention, create_user, sender="in_app:issue_activities:mentioned")

        response = session_client.post(notification_url(workspace, "mark-all-read/"), {})
        counts = session_client.get(notification_url(workspace, "unread/")).data

        assert response.status_code == status.HTTP_200_OK
        assert counts == {
            "total_unread_notifications_count": 0,
            "mention_unread_notifications_count": 0,
        }
