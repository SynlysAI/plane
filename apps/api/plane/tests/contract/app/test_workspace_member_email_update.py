"""工作区管理员修正成员全局登录邮箱的契约测试。"""

from datetime import timedelta
from uuid import uuid4

import pytest
from django.db import IntegrityError
from django.test import TestCase
from django.utils import timezone
from rest_framework.test import APIClient

from plane.db.models import User, WorkspaceMember
from plane.db.models.session import Session
from plane.tests.research_fixtures import add_workspace_member, make_user, make_workspace


pytestmark = [pytest.mark.contract, pytest.mark.django_db]


@pytest.fixture
def env():
    """创建工作区管理员、普通成员及已认证客户端。"""
    admin = make_user(email="email-admin@example.com")
    workspace = make_workspace(admin)
    member = make_user(email="email-member@example.com")
    membership = add_workspace_member(workspace, member)
    client = APIClient()
    client.force_authenticate(user=admin)
    return admin, workspace, member, membership, client


def update_email(client, workspace, user, email):
    """通过工作区成员邮箱专用接口提交新邮箱。

    Args:
        client: 已认证或匿名的测试客户端。
        workspace: 请求所属工作区。
        user: 待修改的用户。
        email: 提交的新邮箱。

    Returns:
        邮箱更新接口响应。
    """
    return client.patch(
        f"/api/workspaces/{workspace.slug}/members/{user.id}/email/",
        {"email": email},
        format="json",
    )


def test_admin_updates_only_email_fields_and_notifies_only_new_address(env, mocker):
    """成功修改只改变邮箱与验证状态，并保留账号、会话和成员权限。

    Args:
        env: 管理员、成员、工作区及认证客户端。
        mocker: pytest-mock 的 mock 工具。
    """
    admin, workspace, member, membership, client = env
    second_workspace = make_workspace(make_user(email="second-owner@example.com"))
    second_membership = add_workspace_member(second_workspace, member, role=20)
    Session.objects.create(
        session_key=uuid4().hex,
        user_id=str(member.id),
        session_data="preserved-session",
        expire_date=timezone.now() + timedelta(days=1),
    )
    member.is_email_verified = True
    member.display_name = "Member Profile"
    member.first_name = "Member"
    member.last_name = "Profile"
    member.save()
    old_fields = {
        "id": member.id,
        "username": member.username,
        "password": member.password,
        "display_name": member.display_name,
        "first_name": member.first_name,
        "last_name": member.last_name,
        "is_active": member.is_active,
        "is_bot": member.is_bot,
    }
    member_roles = list(
        WorkspaceMember.objects.filter(member=member).order_by("workspace_id").values_list(
            "workspace_id", "role", "is_active", "deleted_at"
        )
    )
    send_notification = mocker.patch(
        "plane.app.views.workspace.member_email.send_email_update_confirmation.delay"
    )

    with TestCase.captureOnCommitCallbacks(execute=True):
        response = update_email(client, workspace, member, "  Fixed.Member@Example.COM  ")

    assert response.status_code == 200
    assert response.data == {"email": "fixed.member@example.com"}
    member.refresh_from_db()
    assert member.email == "fixed.member@example.com"
    assert member.is_email_verified is False
    assert {field: getattr(member, field) for field in old_fields} == old_fields
    assert list(
        WorkspaceMember.objects.filter(member=member).order_by("workspace_id").values_list(
            "workspace_id", "role", "is_active", "deleted_at"
        )
    ) == member_roles
    assert membership.role == 15
    assert second_membership.role == 20
    assert Session.objects.filter(user_id=str(member.id), session_data="preserved-session").exists()
    send_notification.assert_called_once_with("fixed.member@example.com")


def test_workspace_admin_can_update_own_email(env, mocker):
    """管理员可修正自己的全局邮箱，且会收到新邮箱通知。

    Args:
        env: 管理员、成员、工作区及认证客户端。
        mocker: pytest-mock 的 mock 工具。
    """
    admin, workspace, _member, _membership, client = env
    send_notification = mocker.patch(
        "plane.app.views.workspace.member_email.send_email_update_confirmation.delay"
    )

    with TestCase.captureOnCommitCallbacks(execute=True):
        response = update_email(client, workspace, admin, "corrected-admin@example.com")

    assert response.status_code == 200
    admin.refresh_from_db()
    assert admin.email == "corrected-admin@example.com"
    assert admin.is_email_verified is False
    send_notification.assert_called_once_with("corrected-admin@example.com")


def test_notification_queue_failure_does_not_rollback_email(env, mocker):
    """通知任务入队失败时，邮箱修改仍然提交成功。

    Args:
        env: 管理员、成员、工作区及认证客户端。
        mocker: pytest-mock 的 mock 工具。
    """
    _admin, workspace, member, _membership, client = env
    mocker.patch(
        "plane.app.views.workspace.member_email.send_email_update_confirmation.delay",
        side_effect=RuntimeError("queue unavailable"),
    )

    with TestCase.captureOnCommitCallbacks(execute=True):
        response = update_email(client, workspace, member, "queued-later@example.com")

    assert response.status_code == 200
    member.refresh_from_db()
    assert member.email == "queued-later@example.com"


def test_non_admin_cannot_update_member_email(env):
    """普通工作区成员不能调用管理员邮箱修正接口。

    Args:
        env: 管理员、成员、工作区及认证客户端。
    """
    _admin, workspace, member, _membership, _client = env
    client = APIClient()
    client.force_authenticate(user=member)

    response = update_email(client, workspace, member, "new-address@example.com")

    assert response.status_code == 403
    member.refresh_from_db()
    assert member.email == "email-member@example.com"


def test_outsider_suspended_member_inactive_user_and_bot_are_rejected(env):
    """只允许修正当前工作区中活跃的非机器人用户。

    Args:
        env: 管理员、成员、工作区及认证客户端。
    """
    _admin, workspace, _member, _membership, client = env
    outsider = make_user(email="email-outsider@example.com")
    suspended = make_user(email="email-suspended@example.com")
    suspended_membership = add_workspace_member(workspace, suspended)
    suspended_membership.is_active = False
    suspended_membership.save(update_fields=["is_active"])
    inactive = make_user(email="email-inactive@example.com", is_active=False)
    add_workspace_member(workspace, inactive)
    bot = make_user(email="email-bot@example.com")
    bot.is_bot = True
    bot.save(update_fields=["is_bot"])
    add_workspace_member(workspace, bot)

    for target in (outsider, suspended, inactive, bot):
        assert update_email(client, workspace, target, "new-address@example.com").status_code == 404


@pytest.mark.parametrize("email", ["", "not-an-email", "name@", None, 123])
def test_invalid_email_is_rejected(env, email):
    """空值、格式无效或类型错误的邮箱不能保存。

    Args:
        env: 管理员、成员、工作区及认证客户端。
        email: 待验证的无效邮箱值。
    """
    _admin, workspace, member, _membership, client = env

    response = update_email(client, workspace, member, email)

    assert response.status_code == 400
    member.refresh_from_db()
    assert member.email == "email-member@example.com"


def test_existing_or_unchanged_email_is_rejected(env):
    """邮箱全局唯一，忽略大小写判断邮箱是否未发生变化。

    Args:
        env: 管理员、成员、工作区及认证客户端。
    """
    _admin, workspace, member, _membership, client = env
    existing_user = make_user(email="already-used@example.com")

    assert update_email(client, workspace, member, existing_user.email).status_code == 400
    assert update_email(client, workspace, member, " EMAIL-MEMBER@example.com ").status_code == 400
    member.refresh_from_db()
    assert member.email == "email-member@example.com"


def test_concurrent_unique_constraint_conflict_returns_conflict(env, monkeypatch):
    """保存时数据库唯一约束发生竞争冲突时返回 409。

    Args:
        env: 管理员、成员、工作区及认证客户端。
        monkeypatch: pytest 的属性替换工具。
    """
    _admin, workspace, member, _membership, client = env
    original_save = User.save

    def save_with_unique_conflict(user, *args, **kwargs):
        """模拟邮箱更新并发触发数据库唯一约束。"""
        if user.pk == member.pk and kwargs.get("update_fields") == ["email", "is_email_verified"]:
            raise IntegrityError("concurrent email update")
        return original_save(user, *args, **kwargs)

    monkeypatch.setattr(User, "save", save_with_unique_conflict)

    response = update_email(client, workspace, member, "concurrent@example.com")

    assert response.status_code == 409
    member.refresh_from_db()
    assert member.email == "email-member@example.com"
