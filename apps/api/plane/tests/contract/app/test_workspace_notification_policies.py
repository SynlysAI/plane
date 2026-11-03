"""Contracts for workspace-level notification channel policies."""

from datetime import timedelta
from uuid import uuid4

import pytest
from django.utils import timezone
from rest_framework import status
from rest_framework.test import APIClient

from plane.db.models import (
    EmailNotificationLog,
    Notification,
    NotificationDeliveryAudit,
    NotificationEmailDelivery,
    NotificationEvent,
    Project,
    User,
    WorkspaceMember,
    WorkspaceNotificationPolicy,
)
from plane.utils.notification_outbox import persist_issue_notification_batch, persist_research_notification_batch


URL = "/api/workspaces/{slug}/notification-policies/"


@pytest.fixture
def project(db, workspace, create_user):
    """Create a project used by notification persistence tests."""
    return Project.objects.create(
        name="Notification policy project",
        identifier="NP",
        workspace=workspace,
        created_by=create_user,
    )


@pytest.mark.django_db
def test_policy_list_returns_every_category_with_defaults(session_client, workspace):
    """The management API exposes all categories without writing default rows."""
    response = session_client.get(URL.format(slug=workspace.slug))

    assert response.status_code == status.HTTP_200_OK, response.data
    assert len(response.data["policies"]) == len(WorkspaceNotificationPolicy.Category.choices)
    assert all(item["in_app_enabled"] is True and item["email_enabled"] is True for item in response.data["policies"])
    assert all(set(item) == {"category", "in_app_enabled", "email_enabled"} for item in response.data["policies"])
    assert not WorkspaceNotificationPolicy.objects.filter(workspace=workspace).exists()


@pytest.mark.django_db
def test_member_cannot_change_workspace_notification_policies(workspace, create_user):
    """Only workspace administrators can update notification policies."""
    member = User.objects.create(email="member@plane.so", username="policy-member")
    WorkspaceMember.objects.create(workspace=workspace, member=member, role=5)
    client = APIClient()
    client.force_authenticate(user=member)

    response = client.patch(
        URL.format(slug=workspace.slug),
        {"policies": [{"category": "mention", "email_enabled": False}]},
        format="json",
    )

    assert response.status_code == status.HTTP_403_FORBIDDEN


@pytest.mark.django_db
def test_policy_update_suppresses_queued_email_and_records_audit(session_client, workspace, create_user):
    """Disabling email immediately fences unleased queued deliveries."""
    event = NotificationEvent.objects.create(
        idempotency_key=f"policy-{uuid4()}",
        workspace=workspace,
        receiver=create_user,
        entity_name="issue",
        entity_identifier=uuid4(),
        action="updated",
        category=NotificationEvent.Category.MENTION,
        title="Mention update",
    )
    log = EmailNotificationLog.objects.create(
        receiver=create_user,
        triggered_by=create_user,
        entity_identifier=event.entity_identifier,
        entity_name="issue",
        data={},
        entity="issue",
    )
    delivery = NotificationEmailDelivery.objects.create(
        event=event,
        source_log=log,
        status=NotificationEmailDelivery.Status.RETRY,
        available_at=timezone.now(),
    )
    processing_event = NotificationEvent.objects.create(
        idempotency_key=f"policy-processing-{uuid4()}",
        workspace=workspace,
        receiver=create_user,
        entity_name="issue",
        entity_identifier=uuid4(),
        action="mentioned",
        category=NotificationEvent.Category.MENTION,
        title="Mention before submit",
    )
    processing_log = EmailNotificationLog.objects.create(
        receiver=create_user,
        triggered_by=create_user,
        entity_identifier=processing_event.entity_identifier,
        entity_name="issue",
        data={},
        entity="issue",
        delivery_status=EmailNotificationLog.DeliveryStatus.PROCESSING,
        lease_until=timezone.now() + timedelta(minutes=5),
    )
    processing_delivery = NotificationEmailDelivery.objects.create(
        event=processing_event,
        source_log=processing_log,
        status=NotificationEmailDelivery.Status.PROCESSING,
        available_at=timezone.now(),
        lease_until=timezone.now() + timedelta(minutes=5),
        lease_token="worker-token",
    )

    response = session_client.patch(
        URL.format(slug=workspace.slug),
        {"policies": [{"category": "mention", "email_enabled": False}]},
        format="json",
    )
    assert response.status_code == status.HTTP_200_OK, response.data
    delivery.refresh_from_db()
    log.refresh_from_db()
    processing_delivery.refresh_from_db()
    processing_log.refresh_from_db()
    assert delivery.status == NotificationEmailDelivery.Status.SUPPRESSED
    assert delivery.last_error_code == "workspace_policy_disabled"
    assert log.delivery_status == EmailNotificationLog.DeliveryStatus.SUPPRESSED
    assert processing_delivery.status == NotificationEmailDelivery.Status.SUPPRESSED
    assert processing_delivery.lease_token == ""
    assert processing_log.delivery_status == EmailNotificationLog.DeliveryStatus.SUPPRESSED
    assert NotificationDeliveryAudit.objects.filter(
        delivery=delivery,
        action="policy_suppress",
        previous_status=NotificationEmailDelivery.Status.RETRY,
    ).exists()


@pytest.mark.django_db
def test_issue_policy_separates_in_app_and_email_generation(workspace, project, create_user):
    """An event can be in-app only while its email delivery is omitted."""
    WorkspaceNotificationPolicy.objects.create(
        workspace=workspace,
        category=WorkspaceNotificationPolicy.Category.PROPERTY_CHANGE,
        in_app_enabled=True,
        email_enabled=False,
    )
    entity_id = uuid4()
    notification = Notification(
        workspace=workspace,
        project=project,
        receiver=create_user,
        triggered_by=create_user,
        entity_name="issue",
        entity_identifier=entity_id,
        title="Title updated",
        message={},
        data={"issue_activity": {"id": str(uuid4()), "field": "name", "verb": "updated"}},
        sender="subscribed",
    )
    email_log = EmailNotificationLog(
        receiver=create_user,
        triggered_by=create_user,
        entity_identifier=entity_id,
        entity_name="issue",
        data=notification.data,
        entity="issue",
    )

    persist_issue_notification_batch([notification], [email_log])
    duplicate_log = EmailNotificationLog(
        receiver=create_user,
        triggered_by=create_user,
        entity_identifier=entity_id,
        entity_name="issue",
        data=notification.data,
        entity="issue",
    )
    persist_issue_notification_batch([notification], [duplicate_log])

    assert Notification.objects.filter(entity_identifier=entity_id).count() == 1
    assert NotificationEvent.objects.filter(entity_identifier=entity_id).count() == 1
    assert NotificationEmailDelivery.objects.filter(event__entity_identifier=entity_id).exists() is False
    assert EmailNotificationLog.objects.filter(entity_identifier=entity_id).count() == 0


@pytest.mark.django_db
def test_research_policy_can_disable_both_channels(workspace, create_user):
    """A category disabled by an administrator creates neither inbox nor email work."""
    WorkspaceNotificationPolicy.objects.create(
        workspace=workspace,
        category=WorkspaceNotificationPolicy.Category.RESEARCH_STATE_CHANGE,
        in_app_enabled=False,
        email_enabled=False,
    )
    entity_id = uuid4()
    notification = Notification(
        workspace=workspace,
        receiver=create_user,
        triggered_by=create_user,
        entity_name="research_report",
        entity_identifier=entity_id,
        title="Report returned",
        message={"action": "returned"},
        data={"action": "returned", "report_id": str(entity_id)},
    )

    persist_research_notification_batch(
        [notification],
        category=NotificationEvent.Category.RESEARCH_STATE_CHANGE,
        email_policy={
            str(create_user.id): {
                "category": NotificationEvent.Category.RESEARCH_STATE_CHANGE,
                "reason": "reviewer",
                "immediate": True,
            }
        },
    )

    assert Notification.objects.filter(entity_identifier=entity_id).count() == 0
    assert NotificationEvent.objects.filter(entity_identifier=entity_id).count() == 0
    assert NotificationEmailDelivery.objects.filter(event__entity_identifier=entity_id).exists() is False
