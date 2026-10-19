"""管理员密码重置的权限、会话与凭据保护回归。"""

from datetime import timedelta
from uuid import uuid4

import pytest
from django.utils import timezone
from rest_framework.test import APIClient

from plane.db.models import ResearchAuditEvent
from plane.db.models.session import Session
from plane.tests.research_fixtures import (
    add_workspace_member,
    make_instance_admin,
    make_user,
    make_workspace,
)

pytestmark = [pytest.mark.contract, pytest.mark.django_db]


@pytest.fixture
def env():
    """创建管理员、普通成员及没有科研功能的工作区。"""
    admin = make_user()
    workspace = make_workspace(admin)
    member = make_user()
    add_workspace_member(workspace, member)
    client = APIClient()
    client.force_authenticate(user=admin)
    return admin, workspace, member, client


def reset(client, workspace, user, password="test-password"):
    """通过公开路由提交管理员密码核验。

    Args:
        client: 已认证或匿名的测试客户端。
        workspace: URL 所属工作区。
        user: 待重置用户。
        password: 当前操作者密码。

    Returns:
        重置接口响应。
    """
    return client.post(
        f"/api/workspaces/{workspace.slug}/members/{user.id}/reset-password/",
        {"current_password": password},
        format="json",
    )


def test_reset_revokes_only_target_sessions_and_keeps_audit_free_of_credentials(env):
    """生成随机凭据、强制改密且不将凭据写入审计。"""
    admin, workspace, member, client = env
    for user in (admin, member):
        Session.objects.create(
            session_key=uuid4().hex,
            user_id=str(user.id),
            session_data="",
            expire_date=timezone.now() + timedelta(days=1),
        )
    response = reset(client, workspace, member)
    assert response.status_code == 200
    password = response.data["temporary_password"]
    assert len(password) >= 24
    assert response["Cache-Control"] == "no-store"
    member.refresh_from_db()
    assert member.check_password(password)
    assert not member.check_password("test-password")
    assert member.is_password_reset_required
    assert not member.is_password_autoset
    assert not Session.objects.filter(user_id=str(member.id)).exists()
    assert Session.objects.filter(user_id=str(admin.id)).exists()
    event = ResearchAuditEvent.objects.get(workspace=workspace, action="account.password.reset")
    assert event.actor_id == admin.id
    assert str(event.resource_id) == str(member.id)
    assert password not in str(event.metadata)


@pytest.mark.parametrize("password", ["", "wrong-password", None, 123, ["test-password"]])
def test_invalid_administrator_password_does_not_change_member(env, password):
    """缺失、错误或类型不正确的密码不得改变目标凭据。"""
    _admin, workspace, member, client = env
    original = member.password
    assert reset(client, workspace, member, password).status_code == 400
    member.refresh_from_db()
    assert member.password == original


def test_regular_member_and_anonymous_cannot_reset(env):
    """普通成员和匿名用户不能发放临时凭据。"""
    admin, workspace, member, _client = env
    client = APIClient()
    assert reset(client, workspace, member).status_code in (401, 403)
    client.force_authenticate(user=member)
    assert reset(client, workspace, admin).status_code == 403


def test_targets_outside_workspace_and_suspended_members_are_rejected(env):
    """仅允许处理当前工作区的活跃成员。"""
    _admin, workspace, member, client = env
    outsider = make_user()
    assert reset(client, workspace, outsider).status_code == 404
    membership = member.member_workspace.get(workspace=workspace)
    membership.is_active = False
    membership.save()
    assert reset(client, workspace, member).status_code == 404


def test_workspace_admin_cannot_reset_admin_in_another_workspace(env):
    """跨工作区管理员账号仍受保护，防止全局账号被接管。"""
    _admin, workspace, member, client = env
    make_workspace(member)
    original = member.password
    assert reset(client, workspace, member).status_code == 403
    member.refresh_from_db()
    assert member.password == original


def test_instance_admin_can_help_other_admin_but_not_self(env):
    """实例管理员可重置其他管理员，自身仍走个人改密。"""
    admin, workspace, member, client = env
    make_instance_admin(admin)
    make_workspace(member)
    assert reset(client, workspace, member).status_code == 200
    assert reset(client, workspace, admin).status_code == 400


def test_session_authenticated_reset_requires_csrf(env):
    """真实会话认证不能跳过 CSRF。"""
    admin, workspace, member, _client = env
    client = APIClient(enforce_csrf_checks=True)
    client.force_login(admin)
    assert reset(client, workspace, member).status_code == 403
