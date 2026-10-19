"""Isolated, network-free bridge checks: python -m plane.mcp.tests.

Uses no application database, Redis, migrations, credentials, or Docker stack.
"""
import json
import unittest
from types import SimpleNamespace
from unittest.mock import patch

import django
from django.conf import settings

if __name__ == "__main__":
    isolated = dict(
        SECRET_KEY="isolated-mcp-tests-only", ROOT_URLCONF="plane.mcp.urls",
        INSTALLED_APPS=["django.contrib.auth", "django.contrib.contenttypes"],
        DATABASES={}, DATABASE_ROUTERS=[], AUTH_USER_MODEL="auth.User", ALLOWED_HOSTS=["testserver"], MIDDLEWARE=[],
        CACHES={"default": {"BACKEND": "django.core.cache.backends.locmem.LocMemCache"}},
        REST_FRAMEWORK={"DEFAULT_THROTTLE_CLASSES": []},
    )
    if settings.configured:
        for key, value in isolated.items():
            setattr(settings, key, value)
    else:
        settings.configure(**isolated)
    django.setup()

import httpx
from django.core import signing
from django.middleware.csrf import get_token
from django.test import SimpleTestCase, override_settings
from rest_framework.test import APIRequestFactory

from plane.mcp.views import COOKIE, COOKIE_PATH, SALT, NativeMCPBridgeEndpoint


@override_settings(NATIVE_MCP_PORTAL_URL="https://native.test", NATIVE_MCP_PORTAL_INTERNAL_URL="", CSRF_TRUSTED_ORIGINS=[])
class NativeBridgeTests(SimpleTestCase):
    def setUp(self):
        self.factory = APIRequestFactory(enforce_csrf_checks=True)
        self.seen = []
        self.upstream_status = 200
        self.upstream_data = {"name": "Native user", "csrf": "native-csrf", "workspaces": ["public"], "allow_publish": False, "max_token_days": 7}
        self.upstream_headers = {}
        self.real_client = httpx.Client

        def respond(request):
            self.seen.append(request)
            return httpx.Response(self.upstream_status, json=self.upstream_data, headers=self.upstream_headers)

        transport = httpx.MockTransport(respond)
        self.mock_client = patch("plane.mcp.views.httpx.Client", side_effect=lambda **kwargs: self.real_client(transport=transport, **kwargs)).start()
        self.addCleanup(patch.stopall)

    def request(self, action="options", *, data=None, user="plane-user", csrf=True, origin=None, cookie=None):
        path = COOKIE_PATH + action + "/"
        request = self.factory.get(path) if data is None else self.factory.post(path, data, format="json")
        if user:
            request.user = SimpleNamespace(pk=user, is_authenticated=True, is_active=True)
        if csrf:
            request.META["HTTP_X_CSRFTOKEN"] = get_token(request)
            request.COOKIES["csrftoken"] = request.META["CSRF_COOKIE"]
        request.META["HTTP_AUTHORIZATION"] = "Bearer never-forward"
        request.META["HTTP_X_API_KEY"] = "never-forward-pat"
        request.META["HTTP_X_RESEARCH_CONTEXT_TOKEN"] = "never-forward-research"
        request.META["HTTP_X_MCP_CSRF"] = "native-csrf"
        if cookie:
            request.COOKIES[COOKIE] = cookie
        if origin:
            request.META["HTTP_ORIGIN"] = origin
        return NativeMCPBridgeEndpoint.as_view()(request, action=action)

    def bound_cookie(self, user="plane-user", origin="https://native.test"):
        return signing.dumps({"owner": user, "origin": origin, "session": "upstream-session"}, salt=SALT)

    def test_reads_live_options_without_forwarding_plane_credentials(self):
        response = self.request()
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data["max_token_days"], 7)
        self.assertIn("csrf_token", response.data)
        headers = self.seen[0].headers
        for name in ("Authorization", "X-API-Key", "X-Research-Context-Token", "Cookie"):
            self.assertNotIn(name, headers)
        self.assertEqual(str(self.seen[0].url), "https://native.test/connect/api/options")
        self.assertEqual(response["Cache-Control"], "no-store")

    def test_anonymous_and_bearer_only_cannot_manage(self):
        self.assertEqual(self.request(user=None).status_code, 403)
        self.assertFalse(self.seen)

    def test_login_requires_plane_csrf(self):
        self.assertEqual(self.request("login", data={"plane_token": "test-pat"}, csrf=False).status_code, 403)
        self.assertFalse(self.seen)

    def test_foreign_origin_rejected_before_upstream(self):
        self.assertEqual(self.request("login", data={"plane_token": "test-pat"}, origin="https://foreign.test").status_code, 403)
        self.assertFalse(self.seen)

    def test_login_cookie_is_bound_and_http_only(self):
        self.upstream_headers = {"Set-Cookie": "plane_mcp_portal=upstream-session; Path=/connect; HttpOnly"}
        response = self.request("login", data={"plane_token": "test-pat"})
        self.assertEqual(response.status_code, 200)
        cookie = response.cookies[COOKIE]
        self.assertTrue(cookie["httponly"])
        self.assertEqual(cookie["samesite"], "Strict")
        self.assertEqual(cookie["path"], COOKIE_PATH)
        self.assertEqual(signing.loads(cookie.value, salt=SALT)["owner"], "plane-user")
        self.assertEqual(json.loads(self.seen[0].content), {"plane_token": "test-pat"})

    def test_native_csrf_and_only_native_cookie_forwarded(self):
        response = self.request("tokens", data={"workspace": "public", "label": "Agent", "days": 1, "publish": False}, cookie=self.bound_cookie())
        self.assertEqual(response.status_code, 200)
        self.assertEqual(self.seen[0].headers["cookie"], "plane_mcp_portal=upstream-session")
        self.assertEqual(self.seen[0].headers["x-mcp-csrf"], "native-csrf")
        self.assertEqual(self.seen[0].headers["origin"], "https://native.test")
        self.assertNotIn("X-CSRFToken", self.seen[0].headers)

    def test_other_plane_user_cannot_reuse_native_session(self):
        self.request("session", user="other", cookie=self.bound_cookie())
        self.assertNotIn("Cookie", self.seen[0].headers)

    def test_changed_upstream_cannot_reuse_native_session(self):
        self.request("session", cookie=self.bound_cookie(origin="https://old.test"))
        self.assertNotIn("Cookie", self.seen[0].headers)

    def test_tampered_cookie_is_not_forwarded(self):
        self.request("session", cookie=self.bound_cookie() + "tampered")
        self.assertNotIn("Cookie", self.seen[0].headers)

    def test_expired_cookie_is_not_forwarded(self):
        with patch("django.core.signing.time.time", return_value=1):
            cookie = self.bound_cookie()
        self.request("session", cookie=cookie)
        self.assertNotIn("Cookie", self.seen[0].headers)

    def test_no_general_proxy_machine_or_research_paths(self):
        for action in ("mcp", "../mcp", "https://evil.test", "approve_research_operation", "tokens/x/revoke", "session"):
            self.assertEqual(self.request(action, data={}).status_code, 404)
        self.assertFalse(self.seen)

    def test_extra_fields_cannot_choose_target(self):
        self.assertEqual(self.request("login", data={"plane_token": "test-pat", "url": "https://evil.test"}).status_code, 400)
        self.assertFalse(self.seen)

    def test_disabled_and_invalid_configuration(self):
        for value in ("", "file:///tmp", "https://name:pass@native.test", "https://native.test/connect", "https://native.test?url=bad"):
            with override_settings(NATIVE_MCP_PORTAL_URL=value):
                self.assertEqual(self.request().status_code, 503)
        self.assertFalse(self.seen)

    def test_redirect_is_not_followed(self):
        self.upstream_status = 302
        self.upstream_headers = {"Location": "https://evil.test"}
        self.assertEqual(self.request().status_code, 502)
        self.assertEqual(len(self.seen), 1)

    def test_revocation_uses_existing_native_endpoint(self):
        identifier = "a" * 32
        self.request(f"tokens/{identifier}/revoke", data={}, cookie=self.bound_cookie())
        self.assertEqual(str(self.seen[0].url), f"https://native.test/connect/api/tokens/{identifier}/revoke")

    def test_upstream_denial_is_preserved_and_clears_bridge_cookie(self):
        self.upstream_status = 401
        self.upstream_data = {"error": "Session expired"}
        response = self.request("session", cookie=self.bound_cookie())
        self.assertEqual(response.status_code, 401)
        self.assertEqual(response.cookies[COOKIE]["max-age"], 0)

    def test_errors_do_not_echo_sensitive_request(self):
        self.mock_client.side_effect = httpx.ConnectError("secret request detail")
        response = self.request("login", data={"plane_token": "test-pat"})
        self.assertEqual(response.status_code, 502)
        self.assertNotIn("test-pat", str(response.data))
        self.assertNotIn("secret request detail", str(response.data))

    @override_settings(NATIVE_MCP_PORTAL_URL="http://localhost:8765", NATIVE_MCP_PORTAL_INTERNAL_URL="http://host.docker.internal:8765")
    def test_local_container_transport_preserves_public_portal_identity(self):
        response = self.request()
        self.assertEqual(response.status_code, 200)
        self.assertEqual(str(self.seen[0].url), "http://host.docker.internal:8765/connect/api/options")
        self.assertEqual(self.seen[0].headers["host"], "localhost:8765")
        self.assertEqual(self.seen[0].headers["origin"], "http://localhost:8765")
        self.assertEqual(response.data["portal_url"], "http://localhost:8765/connect")
        self.assertNotIn("host.docker.internal", str(response.data))

    @override_settings(NATIVE_MCP_PORTAL_INTERNAL_URL="http://internal.test:8765")
    def test_changed_transport_cannot_reuse_an_old_native_session(self):
        self.request("session", cookie=self.bound_cookie())
        self.assertNotIn("Cookie", self.seen[0].headers)

    @override_settings(NATIVE_MCP_PORTAL_INTERNAL_URL="https://internal.test/not-an-origin")
    def test_invalid_transport_fails_closed(self):
        self.assertEqual(self.request().status_code, 503)
        self.assertFalse(self.seen)


if __name__ == "__main__":
    unittest.main()
