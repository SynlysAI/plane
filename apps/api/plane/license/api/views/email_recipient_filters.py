"""仅实例管理员可维护的邮件过滤配置与草稿检查接口。"""

import json

from django.db import transaction
from rest_framework import status
from rest_framework.response import Response

from plane.license.api.permissions import InstanceAdminPermission
from plane.license.models import InstanceConfiguration
from plane.utils.cache import invalidate_cache
from plane.utils.email_recipient_filters import (
    EMAIL_RECIPIENT_FILTERS_KEY,
    EmailRecipientFilterConfigurationError,
    EmailRecipientFilterValidationError,
    get_email_recipient_filters,
    match_email_recipient_filter,
    normalize_recipient_email,
    validate_email_recipient_filters,
)

from .base import BaseAPIView


class EmailRecipientFiltersEndpoint(BaseAPIView):
    """读取或完整保存实例级策略，不依赖 SMTP 开关。"""

    permission_classes = [InstanceAdminPermission]

    def get(self, request):
        """读取最新策略，损坏时拒绝回退为允许发送。"""
        try:
            return Response(get_email_recipient_filters())
        except EmailRecipientFilterConfigurationError:
            return Response(
                {"error": "email_recipient_filters_unavailable"},
                status=status.HTTP_503_SERVICE_UNAVAILABLE,
            )

    @invalidate_cache(path="/api/instances/configurations/", user=False)
    def put(self, request):
        """校验完整草稿并原子保存；空规则与关闭状态均按原值保存。"""
        try:
            policy = validate_email_recipient_filters(request.data)
        except EmailRecipientFilterValidationError as exc:
            return Response({"error": str(exc), "detail": exc.detail}, status=status.HTTP_400_BAD_REQUEST)
        with transaction.atomic():
            InstanceConfiguration.objects.update_or_create(
                key=EMAIL_RECIPIENT_FILTERS_KEY,
                defaults={"value": json.dumps(policy, ensure_ascii=False), "category": "SMTP", "is_encrypted": False},
            )
        return Response(policy)


class EmailRecipientFilterCheckEndpoint(BaseAPIView):
    """检查提交的草稿，不读取已保存策略，也不发送邮件。"""

    permission_classes = [InstanceAdminPermission]

    def post(self, request):
        """返回规范化邮箱、屏蔽结论及命中规则。"""
        if not isinstance(request.data, dict):
            return Response({"error": "invalid_email_recipient_filters"}, status=status.HTTP_400_BAD_REQUEST)
        try:
            policy = validate_email_recipient_filters(request.data.get("policy"))
            email = normalize_recipient_email(request.data.get("email"))
        except EmailRecipientFilterValidationError as exc:
            return Response({"error": str(exc), "detail": exc.detail}, status=status.HTTP_400_BAD_REQUEST)
        except ValueError as exc:
            return Response({"error": "invalid_email", "detail": str(exc)}, status=status.HTTP_400_BAD_REQUEST)
        matched_rule = match_email_recipient_filter(email, policy)
        return Response({"email": email, "blocked": matched_rule is not None, "matched_rule": matched_rule})
