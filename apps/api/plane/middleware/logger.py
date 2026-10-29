# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

# Python imports
import hashlib
import hmac
import logging
import time

# Django imports
from django.conf import settings
from django.http import HttpRequest

# Third party imports
from rest_framework.request import Request

# Module imports
from plane.utils.ip_address import get_client_ip
from plane.utils.exception_logger import log_exception
from plane.bgtasks.logger_task import process_logs
from plane.middleware.request_body_size import is_research_chain_upload

api_logger = logging.getLogger("plane.api.request")


class RequestLoggerMiddleware:
    def __init__(self, get_response):
        self.get_response = get_response

    def _should_log_route(self, request: Request | HttpRequest) -> bool:
        """
        Determines whether a route should be logged based on the request and status code.
        """
        # Don't log health checks
        if request.path == "/" and request.method == "GET":
            return False
        return True

    def __call__(self, request):
        # get the start time
        start_time = time.time()

        # Get the response
        response = self.get_response(request)

        # calculate the duration
        duration = time.time() - start_time

        # Check if logging is required
        log_true = self._should_log_route(request=request)

        # If logging is not required, return the response
        if not log_true:
            return response

        user_id = (
            request.user.id if getattr(request, "user") and getattr(request.user, "is_authenticated", False) else None
        )

        user_agent = request.META.get("HTTP_USER_AGENT", "")

        # Log the request information
        api_logger.info(
            f"{request.method} {request.get_full_path()} {response.status_code}",
            extra={
                "path": request.path,
                "method": request.method,
                "status_code": response.status_code,
                "duration_ms": int(duration * 1000),
                "remote_addr": get_client_ip(request),
                "user_agent": user_agent,
                "user_id": user_id,
            },
        )

        # return the response
        return response


class APITokenLogMiddleware:
    """
    Middleware to log External API requests to PostgreSQL.
    """

    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        # Research-chain uploads enforce their own larger limit and must not be
        # buffered by generic API-token logging before the view parses them.
        request_body = None if is_research_chain_upload(request.path) else request.body
        response = self.get_response(request)
        self.process_request(request, response, request_body)
        return response

    def _safe_decode_body(self, content):
        """
        Safely decodes request/response body content, handling binary data.
        Returns None if content is None, or a string representation of the content.
        """
        # If the content is None, return None
        if content is None:
            return None

        # If the content is an empty bytes object, return None
        if content == b"":
            return None

        # Check if content is binary by looking for common binary file signatures
        if content.startswith(b"\x89PNG") or content.startswith(b"\xff\xd8\xff") or content.startswith(b"%PDF"):
            return "[Binary Content]"

        try:
            return content.decode("utf-8")
        except UnicodeDecodeError:
            return "[Could not decode content]"

    # Headers whose values must never be persisted in plaintext logs
    SENSITIVE_HEADERS = frozenset({"x-api-key", "authorization", "cookie", "x-mcp-csrf", "x-csrftoken",
                                   "x-research-context-token", "x-research-context-hash", "x-weekly-report-token"})

    def _redacted_headers(self, request):
        """
        Returns the request headers as a string with sensitive values redacted,
        so that credentials such as the API key are never stored in plaintext.
        """
        redacted = {
            key: ("[REDACTED]" if key.lower() in self.SENSITIVE_HEADERS else value)
            for key, value in request.headers.items()
        }
        return str(redacted)

    def process_request(self, request, response, request_body):
        # These routes have their own summary-only audit. Never persist bodies
        # or a one-time issued secret, even if an unrelated X-Api-Key was sent.
        if (request.path == "/api/mcp/" or request.path.startswith("/api/mcp/connections/")
                or "/mcp/weekly-report/" in request.path or "/weekly-report-agent/" in request.path):
            return
        api_key_header = "X-Api-Key"
        api_key = request.headers.get(api_key_header)

        # If the API key is not present, return
        if not api_key:
            return

        # 管理员密码核验与临时凭据响应不得随外部 API 日志落库，
        # 即使会话请求额外携带 X-Api-Key 也必须脱敏。
        is_password_reset = request.path.startswith("/api/workspaces/") and request.path.endswith("/reset-password/")
        try:
            is_credential_management = (
                request.path.startswith("/api/mcp/native/")
                or request.path.startswith("/api/users/api-tokens/")
                or (request.path.startswith("/api/research/") and "/mcp/connections/" in request.path)
            )
            if is_password_reset or is_credential_management:
                logged_body = logged_response_body = "[REDACTED]"
            else:
                logged_body = self._safe_decode_body(request_body) if request_body else None
                logged_response_body = self._safe_decode_body(response.content) if response.content else None
            log_data = {
                # Tokenize the (high-entropy) API key into a stable, non-reversible
                # identifier so logs can be correlated to a token without ever
                # persisting the raw key. A keyed HMAC is used rather than a bare
                # hash so the digest cannot be precomputed from a known key value.
                "token_identifier": hmac.new(
                    settings.SECRET_KEY.encode(), api_key.encode(), hashlib.sha256
                ).hexdigest(),
                "path": request.path,
                "method": request.method,
                "query_params": request.META.get("QUERY_STRING", ""),
                "headers": self._redacted_headers(request),
                "body": logged_body,
                "response_body": logged_response_body,
                "response_code": response.status_code,
                "ip_address": get_client_ip(request=request),
                "user_agent": request.META.get("HTTP_USER_AGENT", None),
            }

            process_logs.delay(log_data=log_data)

        except Exception as e:
            log_exception(e)

        return None
