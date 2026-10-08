"""正式报告 Context 固定版本、逐次授权与 Agent 注入契约。"""

from datetime import timedelta
from uuid import uuid4

import pytest
from django.utils import timezone

from plane.db.models import (
    Page,
    PeriodicReport,
    PeriodicReportSnapshot,
    Project,
    ReportAccessGrant,
    ResearchAgentSession,
)
from plane.research.services.context_tokens import issue_context_token
from plane.research.views import agent as agent_view
from plane.tests.contract.app.test_research_agent_plugin import (
    _create_agent_session,
    agent_url,
    env as agent_environment,  # noqa: F401 - pytest 按名称发现导入的夹具。
    synlora_orchestration as fake_synlora,  # noqa: F401 - 外部服务边界夹具。
)

pytestmark = pytest.mark.contract


@pytest.fixture
def env(agent_environment):  # noqa: F811 - pytest 注入同名夹具值。
    """复用 Agent 真实模型夹具，保持授权与会话测试口径一致。"""
    return agent_environment


@pytest.fixture(autouse=True)
def synlora_boundary(fake_synlora):  # noqa: F811 - pytest 注入同名夹具值。
    """仅将外部 Synlora 替换为已有确定性边界夹具。"""


def formal_report(env, project=None, owner=None, *, formal=True, text="Formal report body"):
    """建立当前页面已修改但正式版本仍冻结的报告及办公附件清单。"""
    author = owner or env["owner"]
    page = Page.objects.create(
        workspace=env["workspace"],
        owned_by=author,
        name="Report",
        created_by=author,
        description_html="<p>PRIVATE DRAFT CONTENT MUST NOT LEAK</p>",
    )
    report = PeriodicReport.objects.create(
        workspace=env["workspace"],
        owner=author,
        project=project or env["project"],
        page=page,
        report_type="WEEKLY",
        period_key=f"2026-{uuid4().hex[:6]}",
        period_start=timezone.localdate(),
        period_end=timezone.localdate(),
        status="NEEDS_REVISION" if formal else "DRAFT",
        visibility="PRIVATE",
        submitted_at=timezone.now() if formal else None,
        created_by=author,
    )
    if formal:
        snapshot(env, report, 1, text)
    return report


def snapshot(env, report, version, text):
    """冻结报告正文并保存尚未扫描、解析的办公二进制元数据。"""
    return PeriodicReportSnapshot.objects.create(
        report=report,
        version_no=version,
        snapshot_status="SUBMITTED",
        description_json={},
        description_html=f"<p>{text}</p>",
        description_stripped=text,
        description_binary=b"EDITOR-BINARY-NOT-MODEL-CONTENT",
        attachment_manifest=[
            {
                "file_name": "OFFICE-ATTACHMENT-SECRET.docx",
                "content_type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                "size": 128,
                "asset_id": uuid4().hex,
            }
        ],
        submitted_by=env["owner"],
    )


def selection(report, version=1):
    """返回客户端明确选择的报告 ID 与正式版本。"""
    return {"report_id": str(report.id), "version_no": version}


def issue(env, selections):
    """通过公开接口创建含固定正式报告清单的 Context 授权。"""
    response = env["client"].post(
        f"/api/research/workspaces/{env['workspace'].slug}/context/exchange-token/",
        {"request_id": uuid4().hex, "research_project_id": str(env["project"].id), "reports": selections},
        format="json",
    )
    return response


def content_url(env, grant):
    """返回固定 Context 授权的受控正式正文读取入口。"""
    return f"/api/research/workspaces/{env['workspace'].slug}/context/{grant.context_id}/report-content/"


def grant_for(env, report):
    """直接签发真实授权，为逐次授权变化测试保留可控 token。"""
    return issue_context_token(
        workspace=env["workspace"],
        user=env["owner"],
        profile=env["profile"],
        request_id=uuid4().hex,
        allowed_reports=[selection(report)],
    )[0]


def bind_session(env, grant):
    """创建真实 Agent 会话并关联待验证授权。"""
    payload = _create_agent_session(env)
    session = ResearchAgentSession.objects.get(session_id=payload["session_id"])
    session.context_grant = grant
    session.save(update_fields=["context_grant"])
    return session


def send_message(env, session, **payload):
    """发送依赖当前固定正式版本的 Agent 消息。"""
    return env["client"].post(
        agent_url(env, f"sessions/{session.session_id}/messages/"),
        {"request_id": uuid4().hex, "content": "Explain my results", **payload},
        format="json",
    )


def test_formal_content_and_agent_message_use_snapshot_with_source_and_unparsed_manifest(env, monkeypatch):
    report = formal_report(env)
    grant = grant_for(env, report)
    response = env["client"].get(content_url(env, grant))

    assert response.status_code == 200, response.json()
    content = response.json()["reports"][0]
    assert content["report_id"] == str(report.id)
    assert content["version_no"] == 1
    assert content["text"] == "Formal report body"
    assert "PRIVATE DRAFT" not in str(content)
    assert content["source"] == "plane"
    assert str(report.id) in content["source_url"]
    assert content["attachments"][0]["parsed"] is False
    assert content["attachments"][0]["scan_status"] == "not_scanned"

    sent = []

    def capture_message(self, **kwargs):
        """记录传入外部 Agent 的消息，用于验证引用正文边界。"""
        sent.append(kwargs["content"])
        return []

    monkeypatch.setattr(agent_view.SynloraClient, "send_message", capture_message)
    session = bind_session(env, grant)
    message = send_message(env, session)

    assert message.status_code == 200, message.json()
    assert len(sent) == 1
    assert "Formal report body" in sent[0]
    assert "正式版本 v1" in sent[0]
    assert str(report.id) in sent[0]
    assert "Explain my results" in sent[0]
    assert "OFFICE-ATTACHMENT-SECRET" not in sent[0]
    assert "EDITOR-BINARY" not in sent[0]
    assert "PRIVATE DRAFT" not in sent[0]


@pytest.mark.parametrize("change", ["expired", "revoked", "version-changed", "association-removed", "acl-revoked"])
def test_content_and_next_agent_message_recheck_every_authorization_boundary(env, change, monkeypatch):
    report = formal_report(env)
    if change == "acl-revoked":
        report.owner = env["other"]
        report.visibility = "CUSTOM"
        report.save(update_fields=["owner", "visibility"])
        access = ReportAccessGrant.objects.create(report=report, grantee_user=env["owner"], granted_by=env["other"])
    grant = grant_for(env, report)
    session = bind_session(env, grant)
    if change == "expired":
        grant.expires_at = timezone.now() - timedelta(seconds=1)
        grant.save(update_fields=["expires_at"])
    elif change == "revoked":
        grant.revoked_at = timezone.now()
        grant.save(update_fields=["revoked_at"])
    elif change == "version-changed":
        snapshot(env, report, 2, "NEW VERSION MUST NOT SILENTLY REPLACE V1")
    elif change == "association-removed":
        report.project = None
        report.save(update_fields=["project"])
    else:
        access.is_revoked = True
        access.save(update_fields=["is_revoked"])
    sent = []

    def capture_message(self, **kwargs):
        """标记外部调用，确保授权失败发生在向模型发送之前。"""
        sent.append(kwargs["content"])
        return []

    monkeypatch.setattr(agent_view.SynloraClient, "send_message", capture_message)

    read = env["client"].get(content_url(env, grant))
    message = send_message(env, session)

    assert read.status_code in (403, 409), read.json()
    assert message.status_code in (403, 409), message.json()
    assert read.json()["error_code"] in {
        "report_context_expired",
        "report_context_denied",
        "report_context_version_changed",
    }
    assert sent == []


@pytest.mark.parametrize("scenario", ["draft", "unassociated", "wrong-project", "wrong-version", "oversized"])
def test_context_issue_rejects_draft_cross_project_version_drift_and_character_limit(env, scenario):
    report = formal_report(env, formal=scenario != "draft", text="x" * 50001 if scenario == "oversized" else "Official")
    if scenario == "unassociated":
        report.project = None
        report.save(update_fields=["project"])
    elif scenario == "wrong-project":
        report.project = Project.objects.create(
            workspace=env["workspace"], name="Other project", identifier=uuid4().hex[:8], created_by=env["owner"]
        )
        report.save(update_fields=["project"])
    chosen = selection(report, 2 if scenario == "wrong-version" else 1)

    response = issue(env, [chosen])

    assert response.status_code in (403, 409, 422), response.json()
    assert (
        response.json()["error_code"]
        == {
            "draft": "report_context_draft",
            "unassociated": "report_context_denied",
            "wrong-project": "report_context_denied",
            "wrong-version": "report_context_version_changed",
            "oversized": "report_context_too_large",
        }[scenario]
    )


def test_report_identity_and_version_are_bound_to_context_and_policy_hashes(env):
    first = formal_report(env)
    second = formal_report(env)
    grant_a = grant_for(env, first)
    grant_b = grant_for(env, second)
    snapshot(env, first, 2, "Updated official body")
    issued = issue(env, [selection(first, 2)])

    assert issued.status_code == 201, issued.json()
    assert len({grant_a.context_hash, grant_b.context_hash, issued.json()["context_hash"]}) == 3
    assert grant_a.policy_hash != grant_b.policy_hash


def test_formal_html_preserves_official_document_structure(env):
    """固定正式 HTML 须保留标题与远程图片的编辑结构。"""
    report = formal_report(env, formal=False)
    report.submitted_at = timezone.now()
    report.status = "SUBMITTED"
    report.save(update_fields=["submitted_at", "status"])
    PeriodicReportSnapshot.objects.create(
        report=report,
        version_no=1,
        snapshot_status="SUBMITTED",
        submitted_by=env["owner"],
        description_html=(
            '<h1>Official heading</h1><p>Paragraph</p><img src="https://example.com/formal.png" alt="Figure">'
        ),
        description_stripped="Official heading Paragraph",
    )
    grant = grant_for(env, report)

    response = env["client"].get(content_url(env, grant))

    assert response.status_code == 200, response.json()
    html = response.json()["reports"][0]["html"]
    assert "<h1>Official heading</h1>" in html
    assert 'src="https://example.com/formal.png"' in html


def test_content_read_checks_grant_owner_and_supplied_context_hash(env):
    grant = grant_for(env, formal_report(env))

    wrong_owner = env["other_client"].get(content_url(env, grant))
    wrong_hash = env["client"].get(content_url(env, grant), HTTP_X_RESEARCH_CONTEXT_HASH="0" * 64)

    assert wrong_owner.status_code in (403, 404)
    assert wrong_hash.status_code == 403, wrong_hash.json()


def test_report_options_only_expose_visible_associated_formal_versions(env):
    visible = formal_report(env)
    formal_report(env, formal=False)
    standalone = formal_report(env)
    standalone.project = None
    standalone.save(update_fields=["project"])
    formal_report(env, owner=env["other"])

    response = env["client"].get(
        f"/api/research/workspaces/{env['workspace'].slug}/formal-reports/",
        {"project_id": str(env["project"].id)},
    )

    assert response.status_code == 200, response.json()
    assert [item["report_id"] for item in response.json()["results"]] == [str(visible.id)]
    assert response.json()["association_hint"]
