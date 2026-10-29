"""Restricted AST, complete representations and the frozen tool contract."""

import json
from pathlib import Path

import pytest

from plane.research.services.weekly_report_body import body_hash, normalize_body
from plane.research.services.weekly_report_catalog import SCHEMAS, validate
from plane.research.services.weekly_report_errors import WeeklyReportError
from plane.utils.html_processor import strip_tags

pytestmark = pytest.mark.unit


def test_ast_keeps_editor_html_and_text_in_agreement():
    body = normalize_body(
        "## 本周完成\r\n\r\n- **完成** *验证* [资料](https://example.com)\n\n"
        "> 下一步\n\n1. 计划\n\n```python\nprint('<safe>')\n```\n\n---"
    )
    assert "\r" not in body["body_markdown"]
    assert body["description_json"]["type"] == "doc"
    assert {n["type"] for n in body["description_json"]["content"]} == {
        "heading",
        "bulletList",
        "blockquote",
        "orderedList",
        "codeBlock",
        "horizontalRule",
    }
    assert "<strong>" in body["description_html"] and "&lt;safe&gt;" in body["description_html"]
    assert body["description_stripped"] == strip_tags(body["description_html"])
    assert body_hash(body) == body["body_hash"]


@pytest.mark.parametrize(
    "markdown",
    [
        "<script>alert(1)</script>",
        "hello <b>raw HTML</b>",
        "![image](https://example.com/image.png)",
        "[unsafe](javascript:alert)",
        "[resource](/api/assets/private)",
        "#### unsupported heading",
        "| A | B |\n|---|---|",
        "~~strikethrough~~",
        "[resource](https://plane.test/api/private)",
    ],
)
def test_unsupported_or_unauthorized_resources_fail_without_silent_removal(markdown):
    with pytest.raises(WeeklyReportError) as error:
        normalize_body(markdown)
    assert error.value.code == "invalid_markdown"


@pytest.mark.parametrize("markdown", ["x" * 50001, "- item\n" * 2500], ids=["character_limit", "node_limit"])
def test_character_and_editor_structure_limits_are_enforced(markdown):
    with pytest.raises(WeeklyReportError) as error:
        normalize_body(markdown)
    assert error.value.code == "body_too_large"


def test_backend_schemas_equal_phase_one_frozen_contract():
    root = Path(__file__).resolve().parents[6]
    frozen = json.loads((root / "docs/plans/mcp-weekly-report-contract-v1.schemas.json").read_text(encoding="utf-8"))
    assert SCHEMAS == frozen["tools"]
    with pytest.raises(WeeklyReportError) as error:
        validate([], {})
    assert error.value.code == "invalid_arguments"


def test_weekly_tokens_and_one_time_management_responses_are_never_logged():
    from unittest.mock import Mock, patch
    from django.http import HttpResponse
    from django.test import RequestFactory
    from plane.middleware.logger import APITokenLogMiddleware

    logger = APITokenLogMiddleware(Mock())
    request = RequestFactory().post(
        "/api/research/workspaces/test/mcp/weekly-report/connections/",
        HTTP_X_API_KEY="unrelated-key",
        HTTP_X_WEEKLY_REPORT_TOKEN="pwr_private",
    )
    assert "pwr_private" not in logger._redacted_headers(request)
    response = HttpResponse(b'{"headers":{"X-Weekly-Report-Token":"pwr_private"}}')
    with patch("plane.middleware.logger.process_logs") as logs:
        logger.process_request(request, response, b"private-body")
    logs.delay.assert_not_called()
