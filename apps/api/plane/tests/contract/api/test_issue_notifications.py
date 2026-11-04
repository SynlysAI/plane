# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

import json
from unittest.mock import Mock, patch
from uuid import uuid4

from django.db import transaction
from django.utils import timezone
import pytest
from rest_framework import status
from django.db import transaction

from plane.bgtasks.issue_activities_task import process_notification_generation_outbox
from plane.db.models import (
    EmailNotificationLog,
    Issue,
    IssueActivity,
    IssueSubscriber,
    Notification,
    NotificationEmailDelivery,
    NotificationEvent,
    NotificationGenerationOutbox,
    Page,
    PeriodicReport,
    Project,
    ProjectMember,
    ReportAccessGrant,
    State,
    User,
    WorkspaceMember,
)
from plane.db.models.project import ProjectNetwork
from plane.utils.notification_outbox import persist_issue_notification_batch
from plane.utils.issue_mutations import enqueue_task_on_commit, queue_issue_activity
from plane.app.views.notification.base import renderable_inbox_notifications


@pytest.fixture
def project(db, workspace, create_user):
    """Create a test project with the user as an admin member and a default state."""
    project = Project.objects.create(
        name="Test Project",
        identifier="TP",
        workspace=workspace,
        created_by=create_user,
    )
    ProjectMember.objects.create(
        project=project,
        member=create_user,
        role=20,  # Admin role
        is_active=True,
    )
    # A default state is required to create work items through the API
    State.objects.create(
        name="Backlog",
        color="#000000",
        group="backlog",
        default=True,
        project=project,
        workspace=workspace,
        created_by=create_user,
    )
    return project


@pytest.fixture
def create_issue(db, project, workspace, create_user):
    """Create an existing work item to update/assign in tests."""
    return Issue.objects.create(
        name="Existing Issue",
        project=project,
        workspace=workspace,
        created_by=create_user,
    )


@pytest.mark.django_db
def test_business_mutation_and_notification_outbox_roll_back_together(project, workspace, create_user):
    """A failed business transaction leaves neither its issue nor outbox row committed."""
    issue_id = uuid4()
    with patch("plane.utils.issue_mutations.process_notification_generation_outbox.delay") as publish:
        with pytest.raises(RuntimeError):
            with transaction.atomic():
                Issue.objects.create(
                    id=issue_id,
                    name="Rolled back issue",
                    project=project,
                    workspace=workspace,
                    created_by=create_user,
                )
                queue_issue_activity(
                    type="issue.activity.created",
                    issue_id=str(issue_id),
                    project_id=str(project.pk),
                    actor_id=str(create_user.pk),
                    notification=True,
                )
                raise RuntimeError("force rollback")

    assert not Issue.objects.filter(pk=issue_id).exists()
    assert not NotificationGenerationOutbox.objects.filter(payload__issue_id=str(issue_id)).exists()
    publish.assert_not_called()


@pytest.mark.django_db
def test_celery_task_publish_waits_for_transaction_commit(django_capture_on_commit_callbacks):
    """A task that observes a mutation is not published before commit."""
    task = Mock()

    with django_capture_on_commit_callbacks(execute=True) as callbacks:
        with transaction.atomic():
            enqueue_task_on_commit(task, "entity-1", action="updated")
            task.delay.assert_not_called()
        task.delay.assert_not_called()

    assert len(callbacks) == 1
    task.delay.assert_called_once_with("entity-1", action="updated")


@pytest.fixture
def assignee_user(db):
    """Create a second user that can be assigned to a work item."""
    user = User.objects.create(
        email="assignee@plane.so",
        username="assignee-user",
        first_name="Assignee",
        last_name="User",
    )
    user.set_password("assignee-password")
    user.save()
    return user


@pytest.mark.contract
class TestIssueNotificationContract:
    """
    Contract: creating and updating/assigning a work item through the external
    REST API (``/api/v1/...``) must trigger notifications, i.e. ``issue_activity``
    is dispatched with ``notification=True`` so subscribers and assignees are
    notified the same way the web app does. See makeplane/plane#9306.
    """

    def get_list_url(self, workspace_slug, project_id):
        """Helper to build the work item list/create endpoint URL."""
        return f"/api/v1/workspaces/{workspace_slug}/projects/{project_id}/issues/"

    def get_detail_url(self, workspace_slug, project_id, issue_id):
        """Helper to build the work item detail endpoint URL."""
        return f"/api/v1/workspaces/{workspace_slug}/projects/{project_id}/issues/{issue_id}/"

    @pytest.mark.django_db
    def test_create_issue_triggers_notification(self, api_key_client, workspace, project):
        """Creating a work item via the external API dispatches a notifying activity."""
        url = self.get_list_url(workspace.slug, project.id)

        response = api_key_client.post(url, {"name": "New Issue"}, format="json")

        assert response.status_code == status.HTTP_201_CREATED
        assert Issue.objects.filter(name="New Issue").exists()

        outbox_row = NotificationGenerationOutbox.objects.get(payload__type="issue.activity.created")
        assert outbox_row.payload["notification"] is True

    @pytest.mark.django_db
    def test_update_issue_triggers_notification(self, api_key_client, workspace, project, create_issue):
        """Updating a work item via the external API dispatches a notifying activity."""
        url = self.get_detail_url(workspace.slug, project.id, create_issue.id)

        response = api_key_client.patch(url, {"name": "Renamed Issue"}, format="json")

        assert response.status_code == status.HTTP_200_OK
        create_issue.refresh_from_db()
        assert create_issue.name == "Renamed Issue"

        outbox_row = NotificationGenerationOutbox.objects.get(payload__type="issue.activity.updated")
        assert outbox_row.payload["notification"] is True

    @pytest.mark.django_db
    def test_assignment_notifies_only_the_new_owner(self, workspace, project, create_user, assignee_user):
        """Each new assignee receives only their own assignment event, without a preference row."""
        from plane.bgtasks.notification_task import notifications

        ProjectMember.objects.create(project=project, member=assignee_user, role=15, is_active=True)
        second_assignee = User.objects.create(email="second-assignee@plane.so", username="second-assignee")
        ProjectMember.objects.create(project=project, member=second_assignee, role=15, is_active=True)
        observer = User.objects.create(email="observer@plane.so", username="observer")
        ProjectMember.objects.create(project=project, member=observer, role=15, is_active=True)
        issue = Issue.objects.create(
            name="Assignment target", project=project, workspace=workspace, created_by=create_user
        )
        IssueSubscriber.objects.create(issue=issue, project=project, workspace=workspace, subscriber=observer)
        activity = IssueActivity.objects.create(
            issue=issue,
            project=project,
            workspace=workspace,
            actor=create_user,
            verb="updated",
            field="assignees",
            comment="added assignee ",
            old_value="",
            new_value=assignee_user.display_name,
            new_identifier=assignee_user.id,
        )
        second_activity = IssueActivity.objects.create(
            issue=issue,
            project=project,
            workspace=workspace,
            actor=create_user,
            verb="updated",
            field="assignees",
            comment="added assignee ",
            old_value="",
            new_value=second_assignee.display_name,
            new_identifier=second_assignee.id,
        )

        notifications(
            type="issue.activity.updated",
            issue_id=str(issue.id),
            project_id=str(project.id),
            actor_id=str(create_user.id),
            subscriber=False,
            issue_activities_created=json.dumps(
                [
                    {
                        "id": str(activity.id),
                        "issue_detail": {"id": str(issue.id)},
                        "verb": activity.verb,
                        "field": activity.field,
                        "comment": activity.comment,
                        "actor_id": str(create_user.id),
                        "new_value": activity.new_value,
                        "old_value": activity.old_value,
                        "new_identifier": str(assignee_user.id),
                        "old_identifier": None,
                        "created_at": activity.created_at.isoformat(),
                        "issue_comment": None,
                    },
                    {
                        "id": str(second_activity.id),
                        "issue_detail": {"id": str(issue.id)},
                        "verb": second_activity.verb,
                        "field": second_activity.field,
                        "comment": second_activity.comment,
                        "actor_id": str(create_user.id),
                        "new_value": second_activity.new_value,
                        "old_value": second_activity.old_value,
                        "new_identifier": str(second_assignee.id),
                        "old_identifier": None,
                        "created_at": second_activity.created_at.isoformat(),
                        "issue_comment": None,
                    },
                ]
            ),
            requested_data="{}",
            current_instance="{}",
        )

        notifications_for_issue = Notification.objects.filter(entity_identifier=issue.id, entity_name="issue")
        assert set(notifications_for_issue.values_list("receiver_id", flat=True)) == {
            assignee_user.id,
            second_assignee.id,
        }
        assert set(notifications_for_issue.values_list("sender", flat=True)) == {"in_app:issue_activities:assigned"}
        assert not notifications_for_issue.filter(receiver=observer).exists()

        email_logs = EmailNotificationLog.objects.filter(entity_identifier=issue.id, receiver__in=[assignee_user, second_assignee])
        assert set(email_logs.values_list("receiver_id", flat=True)) == {assignee_user.id, second_assignee.id}
        assert email_logs.filter(immediate=True).count() == 2
        assert NotificationEmailDelivery.objects.filter(source_log__in=email_logs).count() == 2

    def test_assign_issue_triggers_notification(self, api_key_client, workspace, project, create_issue, assignee_user):
        """Assigning a work item via the external API dispatches a notifying activity."""
        ProjectMember.objects.create(
            project=project,
            member=assignee_user,
            role=15,  # Member role
            is_active=True,
        )
        WorkspaceMember.objects.create(workspace=workspace, member=assignee_user, role=15, is_active=True)
        url = self.get_detail_url(workspace.slug, project.id, create_issue.id)

        response = api_key_client.patch(url, {"assignees": [str(assignee_user.id)]}, format="json")

        assert response.status_code == status.HTTP_200_OK

        outbox_row = NotificationGenerationOutbox.objects.get(payload__type="issue.activity.updated")
        assert outbox_row.payload["notification"] is True

    @pytest.mark.django_db
    def test_external_id_upsert_uses_the_durable_notification_outbox(
        self, api_key_client, workspace, project
    ):
        """Both branches of the legacy REST upsert persist their activity request."""
        url = f"/api/v1/workspaces/{workspace.slug}/projects/{project.id}/issues/{uuid4()}/"
        data = {"name": "Imported Issue", "external_id": "source-42", "external_source": "integration"}

        created = api_key_client.put(url, data, format="json")

        assert created.status_code == status.HTTP_201_CREATED
        assert NotificationGenerationOutbox.objects.filter(
            payload__type="issue.activity.created",
            payload__issue_id=str(created.data["id"]),
        ).exists()

        data["name"] = "Updated Imported Issue"
        updated = api_key_client.put(url, data, format="json")

        assert updated.status_code == status.HTTP_200_OK
        assert NotificationGenerationOutbox.objects.filter(
            payload__type="issue.activity.updated",
            payload__issue_id=str(created.data["id"]),
        ).exists()

    @pytest.mark.django_db
    def test_generation_outbox_rolls_back_and_retries_once(self, workspace, project, create_issue, create_user):
        """A failed notification build rolls back activity writes before retry."""
        outbox_row = NotificationGenerationOutbox.objects.create(
            idempotency_key="notification-retry-contract",
            payload={
                "type": "issue.activity.updated",
                "requested_data": '{"name":"Renamed"}',
                "current_instance": '{"name":"Existing Issue"}',
                "issue_id": str(create_issue.pk),
                "actor_id": str(create_user.pk),
                "project_id": str(project.pk),
                "epoch": int(timezone.now().timestamp()),
                "notification": True,
            },
        )

        with patch("plane.bgtasks.issue_activities_task.notifications.run", side_effect=RuntimeError("test failure")):
            process_notification_generation_outbox.run(outbox_id=str(outbox_row.pk))

        outbox_row.refresh_from_db()
        assert outbox_row.status == NotificationGenerationOutbox.Status.RETRY
        assert not IssueActivity.objects.filter(issue=create_issue).exists()

        outbox_row.available_at = timezone.now()
        outbox_row.save(update_fields=["available_at", "updated_at"])
        with patch("plane.bgtasks.issue_activities_task.notifications.run", return_value=None):
            process_notification_generation_outbox.run(outbox_id=str(outbox_row.pk))

        outbox_row.refresh_from_db()
        assert outbox_row.status == NotificationGenerationOutbox.Status.COMPLETED
        assert IssueActivity.objects.filter(issue=create_issue, field="name").count() == 1

        process_notification_generation_outbox.run(outbox_id=str(outbox_row.pk))
        assert IssueActivity.objects.filter(issue=create_issue, field="name").count() == 1

    @pytest.mark.django_db
    def test_description_mention_email_links_to_mention_event(self, workspace, project, create_issue, create_user):
        """Description mention emails link to the mention event despite source activity being a description edit."""
        activity_id = str(uuid4())
        issue_data = {
            "id": str(create_issue.pk),
            "name": create_issue.name,
            "state_group": "backlog",
        }
        activity_data = {
            "id": activity_id,
            "verb": "updated",
            "field": "description",
            "actor": str(create_user.pk),
            "new_value": "Mentioned a colleague",
            "old_value": "",
        }
        notification = Notification(
            workspace=workspace,
            project=project,
            receiver=create_user,
            triggered_by=create_user,
            sender="in_app:issue_activities:mentioned",
            entity_identifier=create_issue.pk,
            entity_name="issue",
            title="You were mentioned",
            data={"issue": issue_data, "issue_activity": activity_data},
        )
        email_log = EmailNotificationLog(
            receiver=create_user,
            triggered_by=create_user,
            entity_identifier=create_issue.pk,
            entity_name="issue",
            entity="issue",
            data={"issue": issue_data, "issue_activity": activity_data},
        )

        persist_issue_notification_batch([notification], [email_log])

        event = NotificationEvent.objects.get(receiver=create_user, entity_identifier=create_issue.pk)
        assert event.category == NotificationEvent.Category.MENTION
        assert NotificationEmailDelivery.objects.get(event=event).source_log is not None

    @pytest.mark.django_db
    def test_issue_inbox_hides_notifications_after_project_access_revocation(
        self, workspace, project, create_issue, create_user
    ):
        """A removed project member cannot read old work item notification content."""
        reader = User.objects.create(email="revoked-reader@plane.so", username="revoked-reader")
        WorkspaceMember.objects.create(workspace=workspace, member=reader, role=15, is_active=True)
        ProjectMember.objects.create(project=project, member=reader, role=15, is_active=True)
        project.network = ProjectNetwork.SECRET.value
        project.save(update_fields=["network"])
        Notification.objects.create(
            workspace=workspace,
            project=project,
            receiver=reader,
            triggered_by=create_user,
            sender="in_app:issue_activities:subscribed",
            entity_identifier=create_issue.pk,
            entity_name="issue",
            title="A private work item changed",
            data={
                "issue": {"id": str(create_issue.pk)},
                "issue_activity": {"field": "name"},
            },
        )
        assert renderable_inbox_notifications(workspace.slug, reader.pk).exists()

        ProjectMember.objects.filter(project=project, member=reader).update(is_active=False)

        assert not renderable_inbox_notifications(workspace.slug, reader.pk).exists()

    @pytest.mark.django_db
    def test_research_report_notification_hides_after_access_grant_revocation(self, workspace, create_user):
        """Research inbox rechecks custom report grants when old notices are read."""
        from datetime import date

        reader = User.objects.create(email="report-reader@plane.so", username="report-reader")
        WorkspaceMember.objects.create(workspace=workspace, member=reader, role=15, is_active=True)
        page = Page.objects.create(workspace=workspace, name="Private report", owned_by=create_user)
        report = PeriodicReport.objects.create(
            workspace=workspace,
            owner=create_user,
            page=page,
            report_type=PeriodicReport.ReportType.WEEKLY,
            period_key=f"2026-{uuid4().hex[:8]}",
            period_start=date(2026, 10, 26),
            period_end=date(2026, 11, 1),
            status=PeriodicReport.Status.SUBMITTED,
            visibility="CUSTOM",
            submitted_at=timezone.now(),
            created_by=create_user,
        )
        grant = ReportAccessGrant.objects.create(
            report=report,
            grantee_user=reader,
            granted_by=create_user,
        )
        Notification.objects.create(
            workspace=workspace,
            receiver=reader,
            triggered_by=create_user,
            sender="research",
            entity_identifier=report.pk,
            entity_name="research_report",
            title="Private report update",
            data={"action": "submitted"},
        )

        assert renderable_inbox_notifications(workspace.slug, reader.pk).exists()

        grant.is_revoked = True
        grant.save(update_fields=["is_revoked", "updated_at"])

        assert not renderable_inbox_notifications(workspace.slug, reader.pk).exists()

    @pytest.mark.django_db
    def test_workspace_admin_can_inspect_notification_delivery_without_content(
        self, session_client, workspace, create_user, create_issue
    ):
        """The admin diagnostic lists generation and delivery states without message bodies."""
        outbox = NotificationGenerationOutbox.objects.create(
            idempotency_key="diagnostics-outbox-contract",
            workspace=workspace,
            payload={"type": "issue.activity.updated", "issue_id": str(create_issue.pk)},
        )
        event = NotificationEvent.objects.create(
            idempotency_key="diagnostics-event-contract",
            workspace=workspace,
            project=create_issue.project,
            receiver=create_user,
            triggered_by=create_user,
            entity_name="issue",
            entity_identifier=create_issue.pk,
            action="updated",
            category=NotificationEvent.Category.PROPERTY_CHANGE,
            title="Private title that must not appear",
            summary="Private body that must not appear",
        )

        response = session_client.get(f"/api/workspaces/{workspace.slug}/users/notification-deliveries/")

        assert response.status_code == status.HTTP_200_OK
        assert response.data["generation"][0]["id"] == str(outbox.pk)
        delivery = next(row for row in response.data["deliveries"] if row["event_id"] == str(event.event_key))
        assert delivery["status"] == "not_scheduled"
        assert "Private title" not in str(response.data)
        assert "Private body" not in str(response.data)
