"""验证管理员邮箱通知的终态、租约与站内通知隔离。"""

import json
from datetime import timedelta
from unittest.mock import patch
from uuid import uuid4

import pytest
from django.utils import timezone

from plane.bgtasks.email_notification_task import (
    _lease_and_enqueue_email_notifications,
    _lease_and_enqueue_research_email_notifications,
    send_email_notification,
    send_research_notification_email,
)
from plane.db.models import (
    EmailNotificationLog,
    Issue,
    Notification,
    NotificationEmailDelivery,
    NotificationEvent,
    Project,
)
from plane.license.models import InstanceConfiguration
from plane.utils.email_recipient_filters import EMAIL_RECIPIENT_FILTERS_KEY



def make_blocked_notification_delivery(workspace, receiver, entity_name, status):
    """创建管理员待发送通知及对应的邮件投递记录。

    Args:
        workspace: 通知所在的测试工作区。
        receiver: 测试收件用户，将改为系统管理员邮箱。
        entity_name: 工作项或研究通知的实体类型。
        status: 初始投递状态。

    Returns:
        邮件投递记录、可选的工作项邮件日志和站内通知。
    """
    receiver.email = "admin@ai4ms.local"
    receiver.save(update_fields=["email"])
    project = Project.objects.create(
        name="邮件过滤验证",
        identifier=f"MF{uuid4().hex[:4]}",
        workspace=workspace,
        created_by=receiver,
    )
    entity_id = uuid4()
    if entity_name == "issue":
        entity_id = Issue.objects.create(
            name="系统管理员通知",
            project=project,
            workspace=workspace,
            created_by=receiver,
        ).pk
    notification = Notification.objects.create(
        workspace=workspace,
        project=project,
        receiver=receiver,
        entity_name=entity_name,
        entity_identifier=entity_id,
        title="系统管理员通知",
        sender="system",
        data={"action": "updated"},
    )
    event = NotificationEvent.objects.create(
        workspace=workspace,
        project=project,
        receiver=receiver,
        notification=notification,
        idempotency_key=f"blocked-{uuid4()}",
        entity_name=entity_name,
        entity_identifier=entity_id,
        action="updated",
        category=NotificationEvent.Category.PROPERTY_CHANGE,
        title=notification.title,
    )
    log = None
    if entity_name == "issue":
        log = EmailNotificationLog.objects.create(
            receiver=receiver,
            triggered_by=receiver,
            entity_name=entity_name,
            entity_identifier=entity_id,
            entity="issue",
            data={},
            delivery_status=status,
        )
    delivery = NotificationEmailDelivery.objects.create(
        event=event,
        source_log=log,
        status=status,
        available_at=timezone.now() - timedelta(seconds=1),
    )
    return delivery, log, notification


@pytest.mark.django_db
@pytest.mark.parametrize("entity_name", ["issue", "research_report"])
@pytest.mark.parametrize("status", [NotificationEmailDelivery.Status.PENDING, NotificationEmailDelivery.Status.RETRY])
def test_blocked_notification_is_suppressed_and_never_requeued(workspace, create_user, settings, entity_name, status):
    """待发送和重试中的管理员通知被抑制，站内通知继续保留。

    Args:
        workspace: 测试工作区。
        create_user: 测试收件用户。
        settings: pytest 的 Django 设置覆盖工具。
        entity_name: 通知所属的实体类型。
        status: 投递开始时的状态。
    """
    settings.NOTIFICATION_EMAIL_DELIVERY_ENABLED = True
    delivery, log, notification = make_blocked_notification_delivery(workspace, create_user, entity_name, status)
    scanner = (
        _lease_and_enqueue_email_notifications
        if entity_name == "issue"
        else _lease_and_enqueue_research_email_notifications
    )
    sender = send_email_notification if entity_name == "issue" else send_research_notification_email

    with (
        patch.object(sender, "delay") as enqueue,
        patch("plane.bgtasks.email_notification_task._claim_smtp_probe") as claim_probe,
        patch("plane.bgtasks.email_notification_task._open_smtp_circuit") as open_circuit,
        patch("plane.bgtasks.email_notification_task.get_connection") as get_connection,
    ):
        assert scanner() == 1
        assert sender.run(**enqueue.call_args.kwargs) is False
        enqueue.reset_mock()
        assert scanner() == 0
        enqueue.assert_not_called()
        claim_probe.assert_not_called()
        open_circuit.assert_not_called()
        get_connection.assert_not_called()

    delivery.refresh_from_db()
    assert delivery.status == NotificationEmailDelivery.Status.SUPPRESSED
    assert delivery.last_error_code == "recipient_email_blocked"
    assert delivery.lease_token == ""
    assert delivery.lease_until is None
    assert delivery.smtp_accepted_at is None
    if log is not None:
        log.refresh_from_db()
        assert log.delivery_status == EmailNotificationLog.DeliveryStatus.SUPPRESSED
        assert log.last_error_code == "recipient_email_blocked"
        assert log.processed_at is not None
        assert log.sent_at is None
        assert log.lease_until is None
    notification.refresh_from_db()
    assert notification.receiver_id == create_user.pk
    assert notification.read_at is None
    assert notification.archived_at is None
    assert notification.data == {"action": "updated"}
    assert delivery.event.notification_id == notification.pk


@pytest.mark.django_db
@pytest.mark.parametrize("entity_name", ["issue", "research_report"])
@pytest.mark.parametrize("expired", [True, False])
def test_blocked_recipient_does_not_bypass_delivery_lease(workspace, create_user, settings, entity_name, expired):
    """过期或不属于本任务的租约仍不可改写管理员投递记录。

    Args:
        workspace: 测试工作区。
        create_user: 测试收件用户。
        settings: pytest 的 Django 设置覆盖工具。
        entity_name: 通知所属的实体类型。
        expired: 使用过期租约，否则使用不匹配的租约令牌。
    """
    settings.NOTIFICATION_EMAIL_DELIVERY_ENABLED = True
    delivery, log, _ = make_blocked_notification_delivery(
        workspace, create_user, entity_name, NotificationEmailDelivery.Status.PROCESSING
    )
    delivery.lease_token = "current-lease"
    delivery.lease_until = timezone.now() + timedelta(minutes=-1 if expired else 5)
    delivery.save(update_fields=["lease_token", "lease_until"])
    if log is not None:
        log.lease_until = delivery.lease_until
        log.save(update_fields=["lease_until"])
    lease_token = "current-lease" if expired else "stale-lease"

    if entity_name == "issue":
        result = send_email_notification.run(
            issue_id=str(delivery.event.entity_identifier),
            notification_data={},
            receiver_id=str(create_user.pk),
            email_notification_ids=[log.pk],
            lease_token=lease_token,
        )
    else:
        result = send_research_notification_email.run([delivery.pk], lease_token)

    assert result is False
    delivery.refresh_from_db()
    assert delivery.status == NotificationEmailDelivery.Status.PROCESSING
    assert delivery.lease_token == "current-lease"
    assert delivery.last_error_code == ""
    if log is not None:
        log.refresh_from_db()
        assert log.delivery_status == EmailNotificationLog.DeliveryStatus.PROCESSING
        assert log.processed_at is None


@pytest.mark.django_db
@pytest.mark.parametrize("entity_name", ["issue", "research_report"])
@pytest.mark.parametrize("corrupt", [True, False])
def test_worker_reads_current_policy_before_smtp_probe(workspace, create_user, settings, entity_name, corrupt):
    """新保存的域名规则立即用于 Worker，读取失败则释放租约并重试。"""
    settings.NOTIFICATION_EMAIL_DELIVERY_ENABLED = True
    delivery, log, _ = make_blocked_notification_delivery(
        workspace, create_user, entity_name, NotificationEmailDelivery.Status.PENDING
    )
    scanner = (
        _lease_and_enqueue_email_notifications
        if entity_name == "issue"
        else _lease_and_enqueue_research_email_notifications
    )
    sender = send_email_notification if entity_name == "issue" else send_research_notification_email
    with (
        patch.object(sender, "delay") as enqueue,
        patch("plane.bgtasks.email_notification_task._claim_smtp_probe") as probe,
        patch("plane.bgtasks.email_notification_task._open_smtp_circuit") as circuit,
        patch("plane.bgtasks.email_notification_task.get_connection") as smtp,
    ):
        assert scanner() == 1
        # 在扫描并领取租约之后保存，验证发送前会重新读取，而非沿用扫描时快照。
        InstanceConfiguration.objects.create(
            key=EMAIL_RECIPIENT_FILTERS_KEY,
            category="SMTP",
            value="{"
            if corrupt
            else json.dumps(
                {
                    "enabled": True,
                    "rules": [
                        {"id": str(uuid4()), "type": "domain", "value": "ai4ms.local", "note": "", "enabled": True}
                    ],
                }
            ),
        )
        assert sender.run(**enqueue.call_args.kwargs) is False
        probe.assert_not_called()
        circuit.assert_not_called()
        smtp.assert_not_called()
    delivery.refresh_from_db()
    assert delivery.status == (
        NotificationEmailDelivery.Status.RETRY if corrupt else NotificationEmailDelivery.Status.SUPPRESSED
    )
    assert delivery.last_error_code == ("email_recipient_filters_unavailable" if corrupt else "recipient_email_blocked")
    assert delivery.lease_token == ""
    assert delivery.lease_until is None
    if log:
        log.refresh_from_db()
        assert log.delivery_status == delivery.status
        assert log.last_error_code == delivery.last_error_code
