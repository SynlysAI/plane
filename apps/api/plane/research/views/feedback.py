"""Plane 反馈 BFF：身份由后端签名，权威记录与截图只存 AI4MS。"""

import base64
import hashlib
import hmac
import json
import secrets
import time
from urllib.parse import urlencode

import httpx
from django.conf import settings
from django.http import HttpResponse
from rest_framework.response import Response

from plane.db.models import OrgUnitMember
from plane.research.utils.acl import active_org_units_for, managing_org_units_for
from plane.research.utils.org import is_workspace_admin
from plane.research.utils.roles import is_instance_admin, is_main_pi
from plane.research.views.base import ResearchAPIView


def feedback_principal(request, workspace, *, management=False):
    """构造当前用户可信工作区身份和最小授权范围。

    Args:
        request: 已认证请求。
        workspace: 已验证工作区。
        management: 是否请求管理范围。

    Returns:
        HMAC 绑定的身份；无管理权限时返回 None。
    """
    user = request.user
    principal = {
        "workspace_id": str(workspace.id),
        "user_id": str(user.id),
        "username": (user.display_name or user.first_name or str(user.id))[:100],
        "scope": "self",
        "permissions": ["submit", "read"],
        "org_unit_ids": [],
    }
    primary = OrgUnitMember.objects.filter(
        workspace=workspace,
        user=user,
        is_primary=True,
        deleted_at__isnull=True,
        org_unit_id__in=active_org_units_for(user, workspace.id),
    ).first()
    principal["org_unit_id"] = str(primary.org_unit_id) if primary else None
    if management:
        if is_instance_admin(user):
            principal["scope"] = "workspace"
        elif is_main_pi(user, workspace):
            principal["scope"] = "org"
            principal["org_unit_ids"] = [str(item) for item in managing_org_units_for(user, workspace.id)]
        elif is_workspace_admin(user, workspace.id):
            principal["scope"] = "workspace"
        else:
            return None
        principal["permissions"].append("manage")
    return principal


def proxy_feedback(
    request, workspace, *, target, body=b"", content_type="application/json", binary=False, management=False
):
    """签发短时效请求并转发到固定 AI4MS 后端。

    Args:
        request: Plane 用户请求。
        workspace: 当前工作区。
        target: 固定上游路径及已编码查询。
        body: 待签名的实际请求字节。
        content_type: 请求内容类型。
        binary: 是否为截图读取。
        management: 是否使用管理授权。

    Returns:
        AI4MS 响应或保留表单可重试的受控错误。
    """
    principal = feedback_principal(request, workspace, management=management)
    if principal is None:
        return Response({"error_code": "feedback_denied", "message": "没有反馈管理权限。"}, status=403)
    secret = settings.AI4MS_FEEDBACK_SECRET
    base_url = settings.AI4MS_FEEDBACK_BASE_URL.rstrip("/")
    if len(secret) < 32 or not base_url:
        return Response({"error_code": "feedback_unavailable", "message": "反馈服务未配置，请稍后重试。"}, status=503)
    identity = base64.urlsafe_b64encode(json.dumps(principal, separators=(",", ":")).encode()).decode()
    timestamp = str(int(time.time()))
    nonce = secrets.token_hex(24)
    material = "\n".join([request.method, target, timestamp, nonce, identity, hashlib.sha256(body).hexdigest()])
    headers = {
        "X-Plane-Timestamp": timestamp,
        "X-Plane-Nonce": nonce,
        "X-Plane-Principal": identity,
        "X-Plane-Signature": hmac.new(secret.encode(), material.encode(), hashlib.sha256).hexdigest(),
        "Content-Type": content_type,
    }
    try:
        with httpx.Client(timeout=30, base_url=base_url, follow_redirects=False) as client:
            response = client.request(request.method, target, content=body, headers=headers)
        if response.status_code >= 500:
            return Response(
                {"error_code": "feedback_unavailable", "message": "反馈服务暂不可用，内容已保留，请重试。"}, status=503
            )
        if binary and response.status_code == 200:
            if response.headers.get("Content-Type", "").split(";")[0] not in {"image/png", "image/jpeg", "image/webp"}:
                raise ValueError("Unexpected image response")
            result = HttpResponse(response.content, content_type=response.headers["Content-Type"])
            result["Cache-Control"] = "private, no-store"
            result["X-Content-Type-Options"] = "nosniff"
            return result
        return Response(response.json(), status=response.status_code)
    except (httpx.HTTPError, ValueError):
        return Response(
            {"error_code": "feedback_unavailable", "message": "反馈服务暂不可用，内容已保留，请重试。"}, status=503
        )


class ResearchFeedbackEndpoint(ResearchAPIView):
    """提交与本人分页列表，无额外研究业务权限要求。"""

    def get(self, request, slug):
        """本人或管理分页查询，筛选参数仅透传白名单。"""
        workspace, error = self.get_workspace(nav=None, require_enabled=False)
        if error:
            return error
        params = {
            key: request.GET[key]
            for key in (
                "page",
                "page_size",
                "feedback_type",
                "status",
                "module",
                "q",
                "date_from",
                "date_to",
            )
            if request.GET.get(key)
        }
        target = "/api/v1/plane-feedback" + ("?" + urlencode(params) if params else "")
        return proxy_feedback(request, workspace, target=target, management=request.GET.get("scope") == "manage")

    def post(self, request, slug):
        """限制截图数量大小后构造 multipart；剥离 URL 查询与片段。"""
        workspace, error = self.get_workspace(nav=None, require_enabled=False)
        if error:
            return error
        from urllib.parse import urlsplit

        screenshots = request.FILES.getlist("screenshots")
        if len(screenshots) > 3 or any(not 0 < image.size <= 10 * 1024 * 1024 for image in screenshots):
            return Response(
                {"error_code": "feedback_invalid", "message": "最多 3 张截图，每张不超过 10 MB。"}, status=422
            )
        data = {
            key: str(request.data.get(key) or "")
            for key in ("content", "feedback_type", "path", "browser", "module", "idempotency_key")
        }
        data["path"] = urlsplit(data["path"]).path or "/"
        files = [("payload", (None, json.dumps(data, separators=(",", ":"))))] + [
            ("screenshots", ("screenshot", image.read(), image.content_type)) for image in screenshots
        ]
        outgoing = httpx.Request("POST", "http://bff.invalid/api/v1/plane-feedback", files=files)
        body = outgoing.read()
        return proxy_feedback(
            request,
            workspace,
            target="/api/v1/plane-feedback",
            body=body,
            content_type=outgoing.headers["Content-Type"],
        )


class ResearchFeedbackStatusEndpoint(ResearchAPIView):
    """管理处置与上游相同组织范围。"""

    def patch(self, request, slug, feedback_id):
        """转发状态和说明，操作者由 HMAC 身份确定。"""
        workspace, error = self.get_workspace(nav=None, require_enabled=False)
        if error:
            return error
        body = json.dumps({"status": request.data.get("status"), "comment": request.data.get("comment")}).encode()
        return proxy_feedback(
            request, workspace, target=f"/api/v1/plane-feedback/{feedback_id}/status", body=body, management=True
        )


class ResearchFeedbackScreenshotEndpoint(ResearchAPIView):
    """本人和管理截图读取统一应用范围检查。"""

    def get(self, request, slug, feedback_id, screenshot_id):
        """向 AI4MS 请求受控截图，Plane 不持久化副本。"""
        workspace, error = self.get_workspace(nav=None, require_enabled=False)
        if error:
            return error
        return proxy_feedback(
            request,
            workspace,
            target=f"/api/v1/plane-feedback/{feedback_id}/screenshots/{screenshot_id}",
            binary=True,
            management=request.GET.get("scope") == "manage",
        )
