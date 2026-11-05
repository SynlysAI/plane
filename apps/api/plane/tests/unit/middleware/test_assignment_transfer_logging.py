"""邮件转派令牌不得出现在结构化日志、调试输出及外部 API 审计中。"""

from unittest.mock import Mock, patch

import pytest
from django.contrib.auth.models import AnonymousUser
from django.http import HttpResponse
from django.test import RequestFactory

from plane.app.views.base import BaseAPIView
from plane.middleware.logger import APITokenLogMiddleware, RequestLoggerMiddleware
from plane.utils.request_log_path import request_path_for_logging

pytestmark = pytest.mark.unit
TOKEN = "private-assignment-token"
PATH = "/api/email-actions/assignment-transfer/"


def test_transfer_query_is_hidden_from_structured_logs(caplog):
    """保留接口和状态信息，但不输出转派令牌。"""
    request = RequestFactory().get(PATH, {"token": TOKEN, "candidate_id": "next"})
    request.user = AnonymousUser()
    middleware = RequestLoggerMiddleware(Mock(return_value=HttpResponse()))

    with caplog.at_level("INFO", logger="plane.api.request"):
        middleware(request)

    assert f"GET {PATH} 200" in caplog.text
    assert TOKEN not in caplog.text
    assert "candidate_id" not in caplog.text


def test_other_routes_keep_their_query_parameters():
    """其他业务接口保留既有请求日志格式。"""
    request = RequestFactory().get("/api/workspaces/", {"page": "2"})
    assert request_path_for_logging(request) == "/api/workspaces/?page=2"


def test_transfer_query_is_hidden_from_debug_output(settings, capsys):
    """DEBUG 模式中的查询计数输出也不能包含转派令牌。"""
    settings.DEBUG = True
    request = RequestFactory().get(PATH, {"token": TOKEN, "candidate_id": "next"})
    BaseAPIView.as_view()(request)

    output = capsys.readouterr().out
    assert PATH in output
    assert TOKEN not in output
    assert "candidate_id" not in output


@pytest.mark.parametrize("method", ["get", "post"])
def test_transfer_credentials_never_enter_external_api_audit(method):
    """即使附带外部 API key，也不记录邮件转派请求或响应正文。"""
    request = getattr(RequestFactory(), method)(
        PATH, {"token": TOKEN, "candidate_id": "next"}, HTTP_X_API_KEY="unrelated-key"
    )
    middleware = APITokenLogMiddleware(Mock())
    with patch("plane.middleware.logger.process_logs") as process_logs:
        middleware.process_request(request, HttpResponse(b"{}"), request.body)
    process_logs.delay.assert_not_called()
