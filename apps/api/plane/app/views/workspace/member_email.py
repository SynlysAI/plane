# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""工作区管理员修正成员的全局登录邮箱。"""

import logging

from django.core.exceptions import ValidationError
from django.core.validators import validate_email
from django.db import IntegrityError, transaction
from rest_framework import status
from rest_framework.response import Response

from plane.app.permissions import ROLE, allow_permission
from plane.app.views.base import BaseAPIView
from plane.bgtasks.user_email_update_task import send_email_update_confirmation
from plane.db.models import User, WorkspaceMember


logger = logging.getLogger("plane")


def _send_email_update_notification(email):
    """在事务提交后向新邮箱排入变更通知。"""
    try:
        send_email_update_confirmation.delay(email)
    except Exception:
        logger.exception("Failed to queue workspace member email update confirmation for %s", email)


class WorkspaceMemberEmailUpdateEndpoint(BaseAPIView):
    """仅更新当前工作区成员的全局邮箱及邮箱验证状态。"""

    @allow_permission(allowed_roles=[ROLE.ADMIN], level="WORKSPACE")
    def patch(self, request, slug, member_id):
        """将成员的登录邮箱改为经格式和全局唯一性校验的新地址。

        Args:
            request: 携带新邮箱的管理员请求。
            slug: 当前工作区标识。
            member_id: 待修改用户的标识。

        Returns:
            更新后的邮箱，或对应的校验、权限错误响应。
        """
        email = request.data.get("email")
        if not isinstance(email, str):
            return Response({"error": "邮箱格式无效。"}, status=status.HTTP_400_BAD_REQUEST)

        email = email.strip().lower()
        if not email or len(email) > 255:
            return Response({"error": "邮箱格式无效。"}, status=status.HTTP_400_BAD_REQUEST)
        try:
            validate_email(email)
        except ValidationError:
            return Response({"error": "邮箱格式无效。"}, status=status.HTTP_400_BAD_REQUEST)

        try:
            with transaction.atomic():
                membership_exists = WorkspaceMember.objects.filter(
                    workspace__slug=slug,
                    member_id=member_id,
                    is_active=True,
                    deleted_at__isnull=True,
                ).exists()
                user = User.objects.select_for_update().filter(pk=member_id, is_active=True, is_bot=False).first()
                if not membership_exists or user is None:
                    return Response({"error": "当前工作区中没有此活跃成员。"}, status=status.HTTP_404_NOT_FOUND)

                if (user.email or "").strip().lower() == email:
                    return Response({"error": "新邮箱与当前邮箱相同。"}, status=status.HTTP_400_BAD_REQUEST)
                if User.objects.filter(email__iexact=email).exclude(pk=user.pk).exists():
                    return Response({"error": "该邮箱已被其他账号使用。"}, status=status.HTTP_400_BAD_REQUEST)

                user.email = email
                user.is_email_verified = False
                user.save(update_fields=["email", "is_email_verified"])
                transaction.on_commit(lambda: _send_email_update_notification(email))
        except IntegrityError:
            return Response({"error": "该邮箱已被其他账号使用。"}, status=status.HTTP_409_CONFLICT)

        return Response({"email": email}, status=status.HTTP_200_OK)
