"""提及源权限、文档事务和正式正文发布契约。"""

from concurrent.futures import ThreadPoolExecutor
from uuid import uuid4
from unittest.mock import patch

import pytest
from django.db import close_old_connections, transaction
from rest_framework.test import APIClient

from plane.app.views.notification.base import renderable_inbox_notifications
from plane.db.models import (
    Notification,
    NotificationEvent,
    NotificationEmailDelivery,
    Page,
    ProjectMember,
    ProjectPage,
    ResearchStageInstance,
    StageMaterial,
    UserNotificationPreference,
    WorkspaceNotificationPolicy,
)
from plane.research.services.stage_service import snapshot_material
from plane.tests.contract.app import test_research_chain_tasks as task_contract
from plane.utils.mention_notifications import notify_page_mentions
from plane.utils.mentions import mentioned_user_ids

pytestmark = [pytest.mark.contract, pytest.mark.django_db]
env = task_contract.env
_create = task_contract._create
_url = task_contract._url


def mention(user):
    """构造真实编辑器成员提及。"""
    return f'<mention-component entity_name="user_mention" entity_identifier="{user.pk}"></mention-component>'


def test_parser_ignores_plain_text_entities_bad_nodes_and_duplicate_ids():
    """只识别成员结构化节点，逐个容错并去重。"""
    user_id = uuid4()
    html = (
        f'<p>@成员 user@example.com</p><mention-component entity_name="page" entity_identifier="{user_id}"/>'
        '<mention-component entity_name="user_mention" entity_identifier="broken"/>'
        f'<mention-component entity_name="user_mention" entity_identifier="{user_id}"/>'
        f'<mention-component entity_name="user_mention" entity_identifier="{user_id}"/>'
    )
    assert mentioned_user_ids(html) == {str(user_id)}


def test_page_save_mentions_diff_retry_and_current_permission(env):
    """普通和协同保存均通知，撤销源权限后列表和计数一起排除。"""
    ProjectMember.objects.create(project=env["project"], member=env["student"], role=15)
    page = Page.objects.create(workspace=env["workspace"], owned_by=env["student"], name="文档")
    ProjectPage.objects.create(page=page, project=env["project"], workspace=env["workspace"])
    base = f"/api/workspaces/{env['workspace'].slug}/projects/{env['project'].pk}/pages/{page.pk}/"
    html = f"<p>请审阅{mention(env['advisor'])}{mention(env['advisor'])}</p>"
    client = env["student_client"]
    response = client.patch(base + "description/", {"description_html": html}, format="json")
    assert response.status_code == 200, response.data
    rows = Notification.objects.filter(entity_name="page", entity_identifier=page.pk, receiver=env["advisor"])
    assert rows.count() == 1
    assert rows.get().data["route"].endswith(f"/pages/{page.pk}")
    assert renderable_inbox_notifications(env["workspace"].slug, env["advisor"].pk).filter(pk=rows.get().pk).exists()
    for url, value, count in [
        (base, html + "<p>更新</p>", 1),
        (base, "<p>移除</p>", 1),
        (base + "description/", html, 2),
    ]:
        response = client.patch(url, {"description_html": value}, format="json")
        assert response.status_code == 200, response.data
        assert rows.count() == count
    page.refresh_from_db()
    notify_page_mentions(page, env["student"], "")
    assert rows.count() == 2
    page.access = Page.PRIVATE_ACCESS
    page.save()
    assert not renderable_inbox_notifications(env["workspace"].slug, env["advisor"].pk).filter(pk__in=rows).exists()


def test_page_invalid_receiver_rolls_back_body_and_notification(env):
    """业务事务失败没有正文和通知残留。"""
    ProjectMember.objects.create(project=env["project"], member=env["student"], role=15)
    page = Page.objects.create(workspace=env["workspace"], owned_by=env["student"], name="私有文档", access=1)
    ProjectPage.objects.create(page=page, project=env["project"], workspace=env["workspace"])
    url = f"/api/workspaces/{env['workspace'].slug}/projects/{env['project'].pk}/pages/{page.pk}/description/"
    response = env["student_client"].patch(url, {"description_html": mention(env["advisor"])}, format="json")
    assert response.status_code == 400, response.data
    page.refresh_from_db()
    assert page.description_html == "<p></p>"
    assert not Notification.objects.filter(entity_identifier=page.pk).exists()


def test_task_instruction_fixed_in_app_email_preference_and_deletion(env):
    """站内提及固定开启且独立于邮件；来源评论删除后不可见。"""
    WorkspaceNotificationPolicy.objects.create(
        workspace=env["workspace"], category="research_mention", in_app_enabled=False, email_enabled=False
    )
    UserNotificationPreference.objects.update_or_create(user=env["advisor"], defaults={"research_mention": False})
    task = _create(env, instruction=mention(env["advisor"]))
    rows = Notification.objects.filter(
        entity_identifier=task["id"], receiver=env["advisor"], sender="research:mentioned"
    )
    assert rows.count() == 1
    assert not NotificationEmailDelivery.objects.filter(event__notification=rows.get()).exists()
    assert (
        env["student_client"].patch(_url(env, task["id"]), {"instruction": "<p>移除</p>"}, format="json").status_code
        == 200
    )
    assert (
        env["student_client"]
        .patch(_url(env, task["id"]), {"instruction": mention(env["advisor"])}, format="json")
        .status_code
        == 200
    )
    assert rows.count() == 2


def test_material_only_notifies_formal_versions_and_rolls_back(env):
    """阶段材料草稿不通知，正式版差分并在失败时原子回滚。"""
    stage = ResearchStageInstance.objects.create(
        workspace=env["workspace"],
        project=env["project"],
        stage="PRE_OPENING",
        org_unit=env["project_profile"].org_unit,
        sort_order=1,
    )
    page = Page.objects.create(
        workspace=env["workspace"], owned_by=env["student"], description_html=mention(env["advisor"])
    )
    material = StageMaterial.objects.create(
        stage_instance=stage, page=page, owner=env["student"], material_type="TOPIC_DESCRIPTION"
    )
    snapshot_material(material, env["student"], change_source="MANUAL")
    assert not Notification.objects.filter(entity_identifier=material.pk).exists()
    with transaction.atomic():
        material.status = "SUBMITTED"
        material.save()
        snapshot_material(material, env["student"], change_source="MANUAL")
    rows = Notification.objects.filter(
        entity_identifier=material.pk, receiver=env["advisor"], sender="research:mentioned"
    )
    assert rows.count() == 1
    snapshot_material(material, env["student"], change_source="MANUAL")
    assert rows.count() == 1
    assert renderable_inbox_notifications(env["workspace"].slug, env["advisor"].pk).filter(pk=rows.get().pk).exists()
    with pytest.raises(RuntimeError), transaction.atomic():
        page.description_html = "<p>移除</p>"
        page.save()
        snapshot_material(material, env["student"], change_source="MANUAL")
        raise RuntimeError("rollback")
    assert material.versions.count() == 3


def test_candidates_use_resource_acl_and_reject_invalid_context(env):
    """候选 API 校验调用者与资源，不向私有内容推荐无权成员。"""
    ProjectMember.objects.create(project=env["project"], member=env["student"], role=15)
    page = Page.objects.create(workspace=env["workspace"], owned_by=env["student"], access=1)
    ProjectPage.objects.create(page=page, project=env["project"], workspace=env["workspace"])
    url = f"/api/workspaces/{env['workspace'].slug}/entity-search/"
    params = {"source_type": "page", "source_id": str(page.pk), "query_type": "user_mention,project"}
    response = env["student_client"].get(url, params)
    assert response.status_code == 200, response.data
    assert response.data["user_mention"] == []
    assert env["advisor_client"].get(url, params).status_code == 400
    for value in ("invalid", str(uuid4())):
        assert env["student_client"].get(url, {**params, "source_id": value}).status_code == 400
    assert env["student_client"].get(url, {**params, "count": "invalid"}).status_code == 400


def test_material_draft_candidates_use_formal_audience(env):
    """正文草稿候选遵循未来正式受众，但草稿保存不投递。"""
    stage = ResearchStageInstance.objects.create(
        workspace=env["workspace"],
        project=env["project"],
        stage="PRE_OPENING",
        org_unit=env["project_profile"].org_unit,
        sort_order=1,
    )
    material = StageMaterial.objects.create(
        stage_instance=stage, owner=env["student"], material_type="TOPIC_DESCRIPTION"
    )
    response = env["student_client"].get(
        f"/api/workspaces/{env['workspace'].slug}/entity-search/",
        {
            "source_type": "stage_material",
            "source_id": str(material.pk),
            "count": 20,
        },
    )
    assert response.status_code == 200, response.data
    assert str(env["advisor"].pk) in {item["member__id"] for item in response.data["user_mention"]}
    assert not Notification.objects.filter(entity_identifier=material.pk).exists()


def test_task_assignment_subscriber_and_mention_merge_and_deleted_comment_is_hidden(env):
    """同次指派和提及仅一条；删除来源评论同时排除列表和计数。"""
    task = _create(env, assignee=str(env["advisor"].pk), instruction=mention(env["advisor"]))
    rows = Notification.objects.filter(entity_identifier=task["id"], receiver=env["advisor"])
    assert rows.count() == 1
    assert rows.get().sender == "research:mentioned"
    response = env["student_client"].post(
        _url(env, task["id"]) + "comments/",
        {
            "comment_html": mention(env["advisor"]),
            "request_id": uuid4().hex,
        },
        format="json",
    )
    assert response.status_code == 201, response.data
    comment_row = rows.filter(data__comment_id__isnull=False).get()
    assert comment_row.data["comment_id"] in comment_row.data["route"]
    from plane.db.models import ResearchTaskComment

    ResearchTaskComment.objects.get(pk=comment_row.data["comment_id"]).delete()
    assert (
        not renderable_inbox_notifications(env["workspace"].slug, env["advisor"].pk).filter(pk=comment_row.pk).exists()
    )


def test_email_rechecks_new_content_sources_and_task_mentions(env):
    """邮件投递复核直接提及读取权，不要求订阅，撤权后拒绝投递。"""
    from plane.bgtasks.email_notification_task import _research_event_currently_authorized, _research_preference_enabled

    task = _create(env, instruction=mention(env["advisor"]))
    event = NotificationEvent.objects.get(entity_identifier=task["id"], category="research_mention")
    assert _research_event_currently_authorized(event, env["advisor"])
    UserNotificationPreference.objects.update_or_create(user=env["advisor"], defaults={"research_mention": False})
    assert not _research_preference_enabled(env["advisor"].pk, "research_mention")
    env["advisor"].is_active = False
    env["advisor"].save(update_fields=["is_active"])
    assert not _research_event_currently_authorized(event, env["advisor"])


@pytest.mark.parametrize("kind", ["page", "stage_material"])
def test_content_email_scanner_and_send_recheck_source(env, kind, monkeypatch, settings, mailoutbox):
    """新增正文来源可被领取并投递；停用成员会在发送前被抑制。"""
    from django.core.mail.backends.locmem import EmailBackend
    from plane.bgtasks import email_notification_task as delivery_task

    ProjectMember.objects.create(project=env["project"], member=env["student"], role=15)
    page = Page.objects.create(
        workspace=env["workspace"], owned_by=env["student"], description_html=mention(env["advisor"])
    )
    if kind == "page":
        ProjectPage.objects.create(page=page, project=env["project"], workspace=env["workspace"])
        notify_page_mentions(page, env["student"])
        source_id = page.pk
    else:
        stage = ResearchStageInstance.objects.create(
            workspace=env["workspace"],
            project=env["project"],
            stage="PRE_OPENING",
            org_unit=env["project_profile"].org_unit,
            sort_order=1,
        )
        material = StageMaterial.objects.create(
            stage_instance=stage, page=page, owner=env["student"], material_type="TOPIC_DESCRIPTION", status="SUBMITTED"
        )
        snapshot_material(material, env["student"], change_source="MANUAL")
        source_id = material.pk
    event = NotificationEvent.objects.get(entity_name=kind, entity_identifier=source_id)
    assert delivery_task._research_event_currently_authorized(event, env["advisor"])
    with patch.object(delivery_task.send_research_notification_email, "delay") as enqueue:
        assert delivery_task._lease_and_enqueue_research_email_notifications() == 1
    delivery_ids = enqueue.call_args.kwargs["delivery_ids"]
    lease = enqueue.call_args.kwargs["lease_token"]
    settings.WEB_URL = "https://plane.example.test"
    monkeypatch.setattr(delivery_task, "_notification_email_delivery_enabled", lambda: True)
    monkeypatch.setattr(delivery_task, "is_email_recipient_blocked", lambda email: False)
    monkeypatch.setattr(delivery_task, "_claim_smtp_probe", lambda: (True, None, None))
    monkeypatch.setattr(
        delivery_task, "get_email_configuration", lambda: ("localhost", "", "", 25, "0", "0", "plane@example.test")
    )
    monkeypatch.setattr(delivery_task, "get_connection", lambda **kwargs: EmailBackend())
    assert delivery_task.send_research_notification_email(delivery_ids, lease)
    assert len(mailoutbox) == 1
    assert event.route in mailoutbox[0].body
    delivery = NotificationEmailDelivery.objects.get(event=event)
    delivery.refresh_from_db()
    assert delivery.status == NotificationEmailDelivery.Status.ACCEPTED
    env["advisor"].is_active = False
    env["advisor"].save(update_fields=["is_active"])
    assert not delivery_task._research_event_currently_authorized(event, env["advisor"])


def test_deleted_parent_node_hides_task_mention(env):
    """任务父节点删除后，提及列表与未读计数使用同一权限结果。"""
    from django.utils import timezone
    from plane.db.models import ResearchChainNodeTask

    payload = _create(env, instruction=mention(env["advisor"]))
    task = ResearchChainNodeTask.objects.get(pk=payload["id"])
    task.node.deleted_at = timezone.now()
    task.node.save(update_fields=["deleted_at"])
    assert (
        not renderable_inbox_notifications(env["workspace"].slug, env["advisor"].pk)
        .filter(entity_identifier=task.pk)
        .exists()
    )


@pytest.mark.django_db(transaction=True)
def test_concurrent_page_saves_create_one_mention(env):
    """并发相同正文保存以锁内版本差分，每位接收人仅生成一条。"""
    ProjectMember.objects.create(project=env["project"], member=env["student"], role=15)
    page = Page.objects.create(workspace=env["workspace"], owned_by=env["student"])
    ProjectPage.objects.create(page=page, project=env["project"], workspace=env["workspace"])
    url = f"/api/workspaces/{env['workspace'].slug}/projects/{env['project'].pk}/pages/{page.pk}/description/"

    def save_body(_):
        """在独立数据库连接提交并发保存。"""
        close_old_connections()
        try:
            client = APIClient()
            client.force_authenticate(user=env["student"])
            return client.patch(url, {"description_html": mention(env["advisor"])}, format="json").status_code
        finally:
            close_old_connections()

    with ThreadPoolExecutor(max_workers=2) as pool:
        assert list(pool.map(save_body, range(2))) == [200, 200]
    assert Notification.objects.filter(entity_identifier=page.pk, receiver=env["advisor"]).count() == 1
