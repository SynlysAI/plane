# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

# Third party imports
import pytest
from rest_framework import status

# Module imports
from plane.db.models import Notification, SystemAnnouncement, User, WorkspaceMember


def announcement_url(workspace):
    """Build the workspace system announcement API URL.

    Args:
        workspace: Workspace that owns the announcements.

    Returns:
        Absolute API path used by the app client.
    """
    return f"/api/workspaces/{workspace.slug}/system-announcements/"


def notification_url(workspace, path=""):
    """Build the workspace notification API URL.

    Args:
        workspace: Workspace containing notifications.
        path: Optional endpoint path appended after the notification root.

    Returns:
        Absolute API path used by the app client.
    """
    return f"/api/workspaces/{workspace.slug}/users/notifications/{path}"


def create_workspace_user(workspace, email, role, *, is_bot=False, is_active=True):
    """Create a user and active workspace membership for announcement tests.

    Args:
        workspace: Workspace receiving the announcement.
        email: Unique user email.
        role: Workspace role value.
        is_bot: Whether the user represents a bot account.
        is_active: Whether the workspace membership is active.

    Returns:
        The created user.
    """
    username = email.split("@")[0].replace(".", "-")
    user = User.objects.create(
        email=email,
        username=username,
        first_name=username.title(),
        is_bot=is_bot,
    )
    WorkspaceMember.objects.create(workspace=workspace, member=user, role=role, is_active=is_active)
    return user


def authenticate(client, user):
    """Authenticate an existing API client as the supplied user.

    Args:
        client: Django REST framework API client.
        user: User to authenticate.

    Returns:
        The same client for concise call chains.
    """
    client.force_authenticate(user=user)
    return client


@pytest.mark.contract
@pytest.mark.django_db
class TestSystemAnnouncements:
    def test_admin_publishes_to_all_active_human_members(self, session_client, workspace, create_user):
        """Publishing creates one source and one isolated notification per recipient."""
        member = create_workspace_user(workspace, "member@plane.so", 15)
        create_workspace_user(workspace, "inactive@plane.so", 15, is_active=False)
        create_workspace_user(workspace, "bot@plane.so", 15, is_bot=True)

        response = session_client.post(
            announcement_url(workspace),
            {"title": "Version 7.1", "body": "系统公告正文", "idempotency_key": "publish-once"},
        )

        assert response.status_code == status.HTTP_201_CREATED
        assert response.data["recipient_count"] == 2
        assert response.data["delivery_status"] == "published"
        announcement = SystemAnnouncement.objects.get()
        notifications = Notification.objects.filter(announcement=announcement)
        assert {str(notification.receiver_id) for notification in notifications} == {
            str(create_user.id),
            str(member.id),
        }
        assert all(notification.read_at is None for notification in notifications)

        list_response = session_client.get(notification_url(workspace))
        published_list_response = session_client.get(announcement_url(workspace), {"per_page": 20, "cursor": "20:0:0"})
        member_list_response = authenticate(session_client, member).get(notification_url(workspace))
        unread_response = session_client.get(notification_url(workspace, "unread/"))
        mention_response = session_client.get(notification_url(workspace), {"mentioned": "true"})

        assert list_response.status_code == status.HTTP_200_OK
        assert len(list_response.data) == 1
        assert list_response.data[0]["announcement_details"]["body"] == "系统公告正文"
        assert published_list_response.status_code == status.HTTP_200_OK
        assert published_list_response.data["total_count"] == 1
        assert published_list_response.data["results"][0]["recipient_count"] == 2
        assert [str(item["id"]) for item in member_list_response.data] == [
            str(notification.id) for notification in notifications if notification.receiver_id == member.id
        ]
        assert unread_response.data == {
            "total_unread_notifications_count": 1,
            "mention_unread_notifications_count": 0,
        }
        assert mention_response.data == []

    def test_non_admin_cannot_publish_or_list_announcements(self, session_client, workspace):
        """Workspace members cannot use the announcement management API."""
        member = create_workspace_user(workspace, "member@plane.so", 15)

        post_response = authenticate(session_client, member).post(
            announcement_url(workspace),
            {"title": "Unauthorized", "body": "Should fail"},
        )
        list_response = session_client.get(announcement_url(workspace))

        assert post_response.status_code == status.HTTP_403_FORBIDDEN
        assert list_response.status_code == status.HTTP_403_FORBIDDEN
        assert not SystemAnnouncement.objects.exists()
        assert not Notification.objects.exists()

    def test_idempotency_key_replay_does_not_duplicate_delivery(self, session_client, workspace):
        """The same idempotency key returns the original publish result."""
        payload = {
            "title": "Maintenance",
            "body": "Tonight at 22:00",
            "idempotency_key": "same-key",
        }

        first = session_client.post(announcement_url(workspace), payload)
        second = session_client.post(announcement_url(workspace), payload)

        assert first.status_code == status.HTTP_201_CREATED
        assert second.status_code == status.HTTP_200_OK
        assert second.data["id"] == first.data["id"]
        assert SystemAnnouncement.objects.count() == 1
        assert Notification.objects.count() == 1

    def test_recipient_state_and_deletion_are_isolated(self, session_client, workspace, create_user):
        """Read and delete mutations affect only the requesting recipient row."""
        member = create_workspace_user(workspace, "member@plane.so", 15)
        session_client.post(announcement_url(workspace), {"title": "Isolation", "body": "Independent state"})
        announcement = SystemAnnouncement.objects.get()
        admin_notification = Notification.objects.get(announcement=announcement, receiver=create_user)
        member_notification = Notification.objects.get(announcement=announcement, receiver=member)

        read_response = authenticate(session_client, member).post(
            notification_url(workspace, f"{member_notification.id}/read/")
        )
        foreign_read_response = session_client.post(notification_url(workspace, f"{admin_notification.id}/read/"))
        foreign_delete_response = session_client.delete(notification_url(workspace, f"{admin_notification.id}/"))
        delete_response = session_client.delete(notification_url(workspace, f"{member_notification.id}/"))

        assert read_response.status_code == status.HTTP_200_OK
        assert foreign_read_response.status_code == status.HTTP_404_NOT_FOUND
        assert foreign_delete_response.status_code == status.HTTP_404_NOT_FOUND
        assert delete_response.status_code == status.HTTP_204_NO_CONTENT
        assert not Notification.objects.filter(pk=member_notification.id).exists()
        admin_notification.refresh_from_db()
        assert admin_notification.read_at is None
        assert admin_notification.deleted_at is None
        assert SystemAnnouncement.objects.filter(pk=announcement.id).exists()

    def test_failed_delivery_rolls_back_announcement_and_notifications(self, session_client, workspace, monkeypatch):
        """A bulk delivery failure leaves no source announcement or partial inbox rows."""

        def fail_bulk_create(*args, **kwargs):
            raise RuntimeError("delivery failed")

        monkeypatch.setattr(Notification.objects, "bulk_create", fail_bulk_create)

        response = session_client.post(announcement_url(workspace), {"title": "Failure", "body": "Rollback"})

        assert response.status_code == status.HTTP_500_INTERNAL_SERVER_ERROR

        assert SystemAnnouncement.objects.count() == 0
        assert Notification.objects.count() == 0
