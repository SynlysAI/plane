"""Fixed-target bridge to the existing native Issue MCP self-service portal.

No machine protocol, Plane session, API key fallback, or research grant is
forwarded. The upstream portal remains the only issuer of native credentials.
"""

import json
import re
from urllib.parse import urlsplit

import httpx
from django.conf import settings
from django.core import signing
from django.middleware.csrf import get_token
from django.utils.decorators import method_decorator
from django.views.decorators.debug import sensitive_post_parameters, sensitive_variables
from rest_framework.authentication import SessionAuthentication
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView


COOKIE = "plane_native_mcp_bridge"
COOKIE_PATH = "/api/mcp/native/"
SALT = "plane.native-mcp-bridge.v1"
MAX_AGE = 1800
MAX_RESPONSE = 262144


def portal_origin(setting_name="NATIVE_MCP_PORTAL_URL"):
    value = getattr(settings, setting_name, "").strip().rstrip("/")
    try:
        parsed = urlsplit(value)
        parsed.port
    except ValueError:
        return None
    if (parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username
            or parsed.password or parsed.path or parsed.query or parsed.fragment):
        return None
    return value


@method_decorator(sensitive_post_parameters(), name="dispatch")
class NativeMCPBridgeEndpoint(APIView):
    authentication_classes = [SessionAuthentication]
    permission_classes = [IsAuthenticated]
    http_method_names = ["get", "post", "options"]
    # Login credentials and upstream sessions must never reach an error reporter.

    def finalize_response(self, request, response, *args, **kwargs):
        response = super().finalize_response(request, response, *args, **kwargs)
        response["Cache-Control"] = "no-store"
        response["Referrer-Policy"] = "no-referrer"
        return response

    def get(self, request, action):
        if action not in {"options", "session", "tokens"}:
            return Response({"error": "接口不存在。"}, status=404)
        return self.forward(request, action)

    def post(self, request, action):
        fields = {"login": {"plane_token"}, "tokens": {"workspace", "label", "days", "publish"}, "logout": set()}
        allowed = fields.get(action)
        if re.fullmatch(r"tokens/[a-f0-9]{32}/revoke", action):
            allowed = set()
        if allowed is None:
            return Response({"error": "接口不存在。"}, status=404)
        if request.content_type != "application/json" or not isinstance(request.data, dict):
            return Response({"error": "请求格式必须为 JSON。"}, status=415)
        if len(json.dumps(request.data, ensure_ascii=False).encode("utf-8")) > 8192:
            return Response({"error": "请求内容过长。"}, status=413)
        if set(request.data) - allowed:
            return Response({"error": "请求内容无效。"}, status=400)
        return self.forward(request, action)

    @sensitive_variables()
    def forward(self, request, action):
        request._request.sensitive_post_parameters = "__ALL__"
        origin = portal_origin()
        if not origin:
            return Response({"error": "行政项目接入尚未配置，请联系管理员设置 NATIVE_MCP_PORTAL_URL。"}, status=503)
        internal = getattr(settings, "NATIVE_MCP_PORTAL_INTERNAL_URL", "").strip()
        target = portal_origin("NATIVE_MCP_PORTAL_INTERNAL_URL") if internal else origin
        if not target:
            return Response({"error": "行政项目接入的内部服务地址配置无效，请联系管理员。"}, status=503)
        headers = {"Accept": "application/json", "Origin": origin, "Host": urlsplit(origin).netloc}
        # Never copy request.headers or the browser's Cookie/Authorization.
        cookie = request.COOKIES.get(COOKIE)
        if cookie:
            try:
                bound = signing.loads(cookie, salt=SALT, max_age=MAX_AGE)
                if (bound["owner"] == str(request.user.pk) and bound["origin"] == origin
                        and bound.get("target", origin) == target):
                    headers["Cookie"] = "plane_mcp_portal=" + bound["session"]
            except (signing.BadSignature, KeyError, TypeError):
                pass
        if request.method == "POST" and action != "login":
            headers["X-MCP-CSRF"] = request.headers.get("X-MCP-CSRF", "")[:256]
        try:
            with httpx.Client(timeout=15, follow_redirects=False, trust_env=False) as client:
                with client.stream(request.method, target + "/connect/api/" + action, headers=headers,
                                   json=request.data if request.method == "POST" else None) as upstream:
                    if upstream.is_redirect:
                        return Response({"error": "行政接入服务返回了重定向，请检查服务地址。"}, status=502)
                    raw = bytearray()
                    for chunk in upstream.iter_bytes():
                        raw.extend(chunk)
                        if len(raw) > MAX_RESPONSE:
                            raise ValueError("oversized upstream response")
                    data = json.loads(raw)
                    if not isinstance(data, dict):
                        raise ValueError("invalid upstream response")
                    response = Response(data, status=upstream.status_code)
                    if upstream.is_success and action == "options":
                        response.data = {**data, "portal_url": origin + "/connect", "csrf_token": get_token(request._request)}
                    if upstream.is_success and action == "login":
                        session = upstream.cookies.get("plane_mcp_portal")
                        if not session or not re.fullmatch(r"[A-Za-z0-9_-]{1,256}", session):
                            raise ValueError("invalid upstream session")
                        value = signing.dumps({"owner": str(request.user.pk), "origin": origin, "target": target, "session": session}, salt=SALT)
                        response.set_cookie(COOKIE, value, max_age=MAX_AGE, path=COOKIE_PATH,
                                            httponly=True, secure=request.is_secure(), samesite="Strict")
                    if (action == "logout" and upstream.is_success) or upstream.status_code == 401:
                        response.delete_cookie(COOKIE, path=COOKIE_PATH, samesite="Strict")
                    return response
        except (httpx.HTTPError, httpx.InvalidURL, ValueError, KeyError):
            # Errors must not include request bodies, cookies, or upstream details.
            return Response({"error": "无法连接行政项目接入服务，请稍后重试。"}, status=502)
