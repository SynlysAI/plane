"""Plane 反馈 BFF 的身份签名、权限范围、截图及上游故障契约。"""

import base64
import hashlib
import hmac
import json
from email.parser import BytesParser
from email.policy import default

import httpx
import pytest
from django.core.files.uploadedfile import SimpleUploadedFile

from plane.db.models import WorkspaceMember
from plane.tests.research_fixtures import make_instance_admin
from plane.tests.contract.app.test_research_browse import client_for, env as browse_environment  # noqa: F401

pytestmark = pytest.mark.contract
SECRET = "plane-feedback-test-independent-secret-32-bytes"


@pytest.fixture
def env(browse_environment, settings):  # noqa: F811 - pytest 注入导入夹具。
    """复用两组织与多角色夹具，并设置独立反馈签名密钥。"""
    settings.AI4MS_FEEDBACK_SECRET = SECRET
    settings.AI4MS_FEEDBACK_BASE_URL = "https://ai4ms.test"
    return browse_environment


@pytest.fixture
def upstream(monkeypatch):
    """仅替换外部 AI4MS 网络边界，保留真实认证、请求和签名字节。"""
    calls = []
    responses = []

    class UpstreamClient:
        def __init__(self, **_kwargs):
            """接受生产客户端配置。"""

        def __enter__(self):
            """返回受控外部客户端。"""
            return self

        def __exit__(self, *_args):
            """退出无额外副作用。"""

        def request(self, method, target, **kwargs):
            """记录请求并返回指定外部响应。"""
            calls.append({"method": method, "target": target, **kwargs})
            result = (
                responses.pop(0)
                if responses
                else httpx.Response(200, json={"success": True, "data": {"results": [], "count": 0}})
            )
            if isinstance(result, Exception):
                raise result
            return result

    monkeypatch.setattr("plane.research.views.feedback.httpx.Client", UpstreamClient)
    return {"calls": calls, "responses": responses}


def principal(call):
    """解码实际发给 AI4MS 的受签名身份。"""
    return json.loads(base64.urlsafe_b64decode(call["headers"]["X-Plane-Principal"]))


def feedback_url(env, suffix=""):
    """返回当前测试工作区的反馈 BFF 路由。"""
    return f"{env['base']}feedback/{suffix}"


def multipart_payload(call):
    """从真实代理 multipart 字节读取表单与截图。"""
    envelope = (
        f"Content-Type: {call['headers']['Content-Type']}\r\nMIME-Version: 1.0\r\n\r\n".encode() + call["content"]
    )
    parts = list(BytesParser(policy=default).parsebytes(envelope).iter_parts())
    data = json.loads(parts[0].get_payload(decode=True))
    return data, parts[1:]


def test_feedback_hmac_binds_actual_request_workspace_actor_and_scope(env, upstream):
    response = client_for(env["student"]).get(
        feedback_url(env),
        {
            "status": "open",
            "q": "graphite",
            "scope": "self",
            "user_id": str(env["admin"].id),
            "org_unit_ids": str(env["group_b"].id),
        },
    )

    assert response.status_code == 200
    call = upstream["calls"][0]
    actor = principal(call)
    assert actor["workspace_id"] == str(env["workspace"].id)
    assert actor["user_id"] == str(env["student"].id)
    assert actor["scope"] == "self"
    assert actor["org_unit_id"] == str(env["group_a"].id)
    assert "manage" not in actor["permissions"]
    assert "user_id" not in call["target"]
    assert "org_unit_ids" not in call["target"]
    headers = call["headers"]
    material = "\n".join(
        [
            call["method"],
            call["target"],
            headers["X-Plane-Timestamp"],
            headers["X-Plane-Nonce"],
            headers["X-Plane-Principal"],
            hashlib.sha256(call["content"]).hexdigest(),
        ]
    )
    expected = hmac.new(SECRET.encode(), material.encode(), hashlib.sha256).hexdigest()
    assert hmac.compare_digest(headers["X-Plane-Signature"], expected)
    assert "Authorization" not in headers


def test_feedback_submission_strips_url_secrets_and_keeps_three_actual_screenshots_and_retry_key(env, upstream):
    screenshots = [
        SimpleUploadedFile(f"shot-{index}.png", b"\x89PNG\r\n\x1a\nimage", content_type="image/png")
        for index in range(3)
    ]
    payload = {
        "content": "Feedback description",
        "feedback_type": "bug",
        "path": "https://plane.test/lab/research?token=secret#private",
        "browser": "Test browser",
        "idempotency_key": "retry-unchanged",
        "screenshots": screenshots,
        "page_body": "PAGE BODY MUST NOT BE CAPTURED",
        "workspace_id": "spoofed",
        "user_id": "spoofed",
    }

    response = client_for(env["student"]).post(feedback_url(env), payload, format="multipart")

    assert response.status_code == 200
    call = upstream["calls"][0]
    data, images = multipart_payload(call)
    assert data["path"] == "/lab/research"
    assert data["idempotency_key"] == "retry-unchanged"
    assert len(images) == 3
    assert all(part.get_payload(decode=True) == b"\x89PNG\r\n\x1a\nimage" for part in images)
    assert "page_body" not in data
    assert b"PAGE BODY MUST NOT BE CAPTURED" not in call["content"]
    assert b"token=secret" not in call["content"]


@pytest.mark.parametrize("role,scope", [("student", None), ("advisor", None), ("pi", "org"), ("admin", "workspace")])
def test_management_scope_is_derived_from_role_and_organization_tree(env, upstream, role, scope):
    response = client_for(env[role]).get(feedback_url(env), {"scope": "manage"})

    if scope is None:
        assert response.status_code == 403
        assert upstream["calls"] == []
    else:
        assert response.status_code == 200
        actor = principal(upstream["calls"][0])
        assert actor["scope"] == scope
        assert "manage" in actor["permissions"]
        if scope == "org":
            assert {str(env["group_a"].id), str(env["group_b"].id)}.issubset(set(actor["org_unit_ids"]))


def test_screenshot_reads_and_status_changes_use_the_same_signed_management_scope(env, upstream):
    upstream["responses"].append(
        httpx.Response(200, content=b"\x89PNG\r\n\x1a\n", headers={"Content-Type": "image/png"})
    )
    client = client_for(env["pi"])
    image = client.get(feedback_url(env, "feedback-1/screenshots/shot-1/"), {"scope": "manage"})
    updated = client.patch(
        feedback_url(env, "feedback-1/status/"), {"status": "done", "comment": "Resolved"}, format="json"
    )

    assert image.status_code == updated.status_code == 200
    assert image["Cache-Control"] == "private, no-store"
    assert image["X-Content-Type-Options"] == "nosniff"
    assert principal(upstream["calls"][0])["scope"] == principal(upstream["calls"][1])["scope"] == "org"
    assert json.loads(upstream["calls"][1]["content"]) == {"status": "done", "comment": "Resolved"}
    assert (
        client_for(env["student"])
        .patch(feedback_url(env, "feedback-1/status/"), {"status": "done", "comment": "x"}, format="json")
        .status_code
        == 403
    )


def test_main_pi_workspace_admin_seat_remains_org_scoped_and_instance_admin_is_workspace_scoped(env, upstream):
    """主 PI 的工作区管理员座位不得扩宽其反馈组织范围。"""
    WorkspaceMember.objects.filter(workspace=env["workspace"], member=env["pi"]).update(role=20)
    main_pi = client_for(env["pi"]).get(feedback_url(env), {"scope": "manage"})
    assert main_pi.status_code == 200
    assert principal(upstream["calls"][-1])["scope"] == "org"

    make_instance_admin(env["advisor"])
    administrator = client_for(env["advisor"]).get(feedback_url(env), {"scope": "manage"})
    assert administrator.status_code == 200
    assert principal(upstream["calls"][-1])["scope"] == "workspace"


@pytest.mark.parametrize(
    "failure",
    [
        httpx.ConnectError("offline"),
        httpx.Response(503, json={"error": "offline"}),
        httpx.Response(200, content=b"not-json"),
    ],
)
def test_upstream_failure_returns_retryable_error_without_replacing_identity(env, upstream, failure):
    upstream["responses"].append(failure)

    response = client_for(env["student"]).get(feedback_url(env))

    assert response.status_code == 503
    assert response.json()["error_code"] == "feedback_unavailable"
    assert principal(upstream["calls"][0])["user_id"] == str(env["student"].id)


@pytest.mark.parametrize("count,size", [(4, 10), (1, 0), (1, 10 * 1024 * 1024 + 1)])
def test_invalid_screenshot_count_and_size_are_rejected_before_proxy(env, upstream, count, size):
    files = [SimpleUploadedFile(f"shot-{index}.png", b"x" * size, content_type="image/png") for index in range(count)]

    response = client_for(env["student"]).post(
        feedback_url(env), {"content": "x", "screenshots": files}, format="multipart"
    )

    assert response.status_code in (413, 422)
    assert upstream["calls"] == []
