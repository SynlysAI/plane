"""使用真实密码哈希验证重置逻辑，不连接数据库或邮件服务。"""

from contextlib import ExitStack, nullcontext
from unittest.mock import Mock, patch
from uuid import uuid4

from django.core.cache import cache
from django.http import JsonResponse
from django.test import RequestFactory, SimpleTestCase, override_settings
from rest_framework.test import APIRequestFactory, force_authenticate

from plane.app.views.workspace.password_reset import WorkspaceMemberPasswordResetEndpoint
from plane.db.models import User
from plane.middleware.logger import APITokenLogMiddleware

MODULE = "plane.app.views.workspace.password_reset"


@override_settings(
    CACHES={"default": {"BACKEND": "django.core.cache.backends.locmem.LocMemCache"}},
    PASSWORD_HASHERS=["django.contrib.auth.hashers.MD5PasswordHasher"],
)
class WorkspacePasswordResetTests(SimpleTestCase):
    """仅替换持久化边界，保留认证、限流、权限装饰器和密码哈希。"""

    def setUp(self):
        """准备两个使用真实密码哈希的内存账号和数据访问桩。"""
        cache.clear()
        self.actor = User(id=uuid4(), email="admin@example.com")
        self.actor.set_password("admin-password")
        self.target = User(id=uuid4(), email="member@example.com")
        self.target.set_password("old-password")
        self.target.save = Mock()
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.stack.enter_context(patch(f"{MODULE}.transaction.atomic", return_value=nullcontext()))
        self.stack.enter_context(patch("plane.app.permissions.base.user_can_access_workspace", return_value=True))
        users = self.stack.enter_context(patch(f"{MODULE}.User.objects.select_for_update"))
        users.return_value.filter.return_value.first.return_value = self.target
        self.memberships = self.stack.enter_context(patch(f"{MODULE}.WorkspaceMember.objects"))
        self.memberships.filter.return_value.exists.return_value = True
        self.memberships.select_related.return_value.filter.return_value.first.return_value = Mock(workspace=Mock())
        # 最后一个成员权限查询检查目标是否为其他工作区管理员。
        self.target_is_admin = False
        self.memberships.filter.side_effect = self._membership_query
        self.instance_admins = self.stack.enter_context(patch(f"{MODULE}.InstanceAdmin.objects.filter"))
        self.instance_admins.return_value.exists.return_value = False
        roles = self.stack.enter_context(patch(f"{MODULE}.InstanceRoleAssignment.objects.filter"))
        roles.return_value.exists.return_value = False
        self.sessions = self.stack.enter_context(patch(f"{MODULE}.Session.objects.filter"))
        self.audit = self.stack.enter_context(patch(f"{MODULE}.record_audit_event"))
        self.actor_allowed = True

    def _membership_query(self, **filters):
        """按查询对象返回操作者或目标账号的真实权限状态。

        Args:
            **filters: 工作区成员查询条件。

        Returns:
            只提供存在性检查的查询结果。
        """
        exists = self.actor_allowed if filters.get("member") is self.actor else self.target_is_admin
        return Mock(exists=Mock(return_value=exists))

    def request_reset(self, password="admin-password", *, session_auth=False):
        """通过 DRF 视图入口发起内存请求。

        Args:
            password: 管理员用于二次核验的密码。
            session_auth: 是否启用真实会话认证来验证 CSRF 拒绝。

        Returns:
            视图响应。
        """
        request = APIRequestFactory(enforce_csrf_checks=session_auth).post(
            "/api/workspaces/lab/members/reset-password/",
            {"current_password": password},
            format="json",
        )
        if session_auth:
            request.user = self.actor
        else:
            force_authenticate(request, user=self.actor)
        return WorkspaceMemberPasswordResetEndpoint.as_view()(request, slug="lab", pk=self.target.id)

    def test_reset_hashes_password_requires_change_and_revokes_target_sessions(self):
        """成功后新密码有效，旧密码失效，且审计中没有凭据。"""
        response = self.request_reset()
        self.assertEqual(response.status_code, 200)
        password = response.data["temporary_password"]
        self.assertTrue(self.target.check_password(password))
        self.assertFalse(self.target.check_password("old-password"))
        self.assertTrue(self.target.is_password_reset_required)
        self.assertFalse(self.target.is_password_autoset)
        self.assertEqual(response["Cache-Control"], "no-store")
        self.sessions.assert_called_once_with(user_id=str(self.target.id))
        self.sessions.return_value.delete.assert_called_once()
        self.assertNotIn(password, str(self.audit.call_args))

    def test_invalid_current_password_leaves_target_unchanged(self):
        """错误及非字符串管理员密码不能写入目标账号。"""
        original = self.target.password
        for password in ("wrong", "", None, 123, ["admin-password"]):
            with self.subTest(password=password):
                self.assertEqual(self.request_reset(password).status_code, 400)
                self.assertEqual(self.target.password, original)
        self.target.save.assert_not_called()

    def test_regular_member_is_rejected_by_workspace_permission(self):
        """工作区权限装饰器拒绝普通成员。"""
        self.actor_allowed = False
        self.assertEqual(self.request_reset().status_code, 403)
        self.target.save.assert_not_called()

    def test_workspace_administrator_cannot_reset_privileged_target(self):
        """管理员在其他工作区的权限也会保护其全局账号。"""
        self.target_is_admin = True
        self.assertEqual(self.request_reset().status_code, 403)
        self.target.save.assert_not_called()

    def test_member_outside_workspace_is_rejected(self):
        """未找到当前工作区成员时不能重置全局账号。"""
        self.memberships.select_related.return_value.filter.return_value.first.return_value = None
        self.assertEqual(self.request_reset().status_code, 404)
        self.target.save.assert_not_called()

    def test_instance_administrator_can_reset_another_administrator(self):
        """保留实例管理员为其他管理员恢复凭据的能力。"""
        self.instance_admins.return_value.exists.return_value = True
        self.target_is_admin = True
        self.assertEqual(self.request_reset().status_code, 200)

    def test_session_authentication_requires_csrf(self):
        """没有 CSRF token 的真实会话请求在写入前被拒绝。"""
        self.assertEqual(self.request_reset(session_auth=True).status_code, 403)
        self.target.save.assert_not_called()

    def test_authenticated_requests_are_throttled(self):
        """登录态不能绕过管理员密码核验次数限制。"""
        for _attempt in range(10):
            self.assertEqual(self.request_reset("wrong").status_code, 400)
        self.assertEqual(self.request_reset("wrong").status_code, 429)

    def test_extra_api_key_cannot_make_request_logs_store_credentials(self):
        """额外携带 API key 时请求日志也不能保存管理员密码或临时凭据。"""
        request = RequestFactory().post(
            "/api/workspaces/lab/members/member/reset-password/",
            {"current_password": "admin-password"},
            content_type="application/json",
            HTTP_X_API_KEY="example-key",
        )
        response = JsonResponse({"temporary_password": "temporary-secret"})
        with patch("plane.middleware.logger.process_logs.delay") as log_task:
            APITokenLogMiddleware(lambda _request: response)(request)
        log_data = log_task.call_args.kwargs["log_data"]
        self.assertEqual(log_data["body"], "[REDACTED]")
        self.assertEqual(log_data["response_body"], "[REDACTED]")
        self.assertNotIn("admin-password", str(log_data))
        self.assertNotIn("temporary-secret", str(log_data))
