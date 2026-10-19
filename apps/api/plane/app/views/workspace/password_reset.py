# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""由工作区管理员核验身份后发放临时密码。"""

import secrets

from django.db import transaction
from rest_framework import status
from rest_framework.authentication import SessionAuthentication
from rest_framework.response import Response
from rest_framework.throttling import UserRateThrottle

from plane.app.permissions import ROLE, allow_permission
from plane.app.views.base import BaseAPIView
from plane.authentication.rate_limit import AuthenticationThrottle
from plane.db.models import User, WorkspaceMember
from plane.db.models.session import Session
from plane.license.models import InstanceAdmin, InstanceRoleAssignment
from plane.research.utils.audit import record_audit_event


class AdminPasswordResetThrottle(UserRateThrottle):
    """按操作者限制密码核验次数，避免登录态绕过匿名限流。"""

    rate = AuthenticationThrottle.rate
    scope = "admin_password_reset"


class WorkspaceMemberPasswordResetEndpoint(BaseAPIView):
    """验证操作者密码，重置成员凭据并撤销已有会话。"""

    authentication_classes = [SessionAuthentication]
    throttle_classes = [AdminPasswordResetThrottle]

    @allow_permission(allowed_roles=[ROLE.ADMIN], level="WORKSPACE")
    def post(self, request, slug, pk):
        """向有权管理的成员发放仅在本次响应展示的临时密码。

        Args:
            request: 包含操作者当前密码的认证请求。
            slug: 当前工作区标识。
            pk: 待重置账号的用户标识。

        Returns:
            临时密码或权限、身份核验错误响应。
        """
        current_password = request.data.get("current_password")
        if (
            not isinstance(current_password, str)
            or not current_password
            or len(current_password) > 1024
            or not request.user.check_password(current_password)
        ):
            return Response(
                {"error": "管理员当前密码不正确。"},
                status=status.HTTP_400_BAD_REQUEST,
            )

        with transaction.atomic():
            target = User.objects.select_for_update().filter(pk=pk, is_active=True, is_bot=False).first()
            membership = WorkspaceMember.objects.select_related("workspace").filter(
                workspace__slug=slug,
                member_id=pk,
                is_active=True,
                deleted_at__isnull=True,
            ).first()
            if target is None or membership is None:
                return Response({"error": "当前工作区中没有此活跃成员。"}, status=status.HTTP_404_NOT_FOUND)
            if target.id == request.user.id:
                return Response({"error": "请在个人设置中修改自己的密码。"}, status=status.HTTP_400_BAD_REQUEST)

            actor_is_instance_admin = InstanceAdmin.objects.filter(user=request.user, role__gte=15).exists()
            target_is_privileged = (
                target.is_superuser
                or target.is_staff
                or InstanceAdmin.objects.filter(user=target).exists()
                or InstanceRoleAssignment.objects.filter(user=target, deleted_at__isnull=True).exists()
                or WorkspaceMember.objects.filter(
                    member=target, role=ROLE.ADMIN.value, is_active=True, deleted_at__isnull=True
                ).exists()
            )
            if target_is_privileged and not actor_is_instance_admin:
                return Response({"error": "管理员账号须由实例管理员重置。"}, status=status.HTTP_403_FORBIDDEN)

            temporary_password = secrets.token_urlsafe(24)
            target.set_password(temporary_password)
            target.is_password_autoset = False
            target.is_password_reset_required = True
            target.save(update_fields=["password", "is_password_autoset", "is_password_reset_required", "updated_at"])
            Session.objects.filter(user_id=str(target.id)).delete()
            record_audit_event(
                workspace=membership.workspace,
                action="account.password.reset",
                resource_type="user",
                resource_id=target.id,
                actor=request.user,
                metadata={"reset_required": True},
                request=request,
            )

        return Response(
            {"temporary_password": temporary_password},
            headers={"Cache-Control": "no-store", "Pragma": "no-cache"},
        )
