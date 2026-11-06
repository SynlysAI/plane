"""通过真实 ORM、S3 协议模拟和 MCP 契约验证文件完整发布。"""
# ruff: noqa: F401, F811

import base64
import hashlib
import io
from datetime import timedelta
from types import SimpleNamespace
from unittest.mock import patch
from urllib.parse import urlsplit
from uuid import uuid4

import boto3
import pytest
from django.utils import timezone
from moto import mock_aws
from rest_framework.test import APIClient

from plane.bgtasks.mcp_file_task import cleanup_mcp_file_transfers, process_mcp_file_transfer
from plane.db import models as db
from plane.mcp.files import UnifiedFileService
from plane.tests.contract.app.test_unified_mcp import env, invoke, issued, machine, reference, rpc, unified
from plane.tests.contract.app.test_unified_mcp_research_writes import scientific, prepare, execute
from plane.tests.contract.app.test_unified_mcp_writes import native_effects

pytestmark = [pytest.mark.contract, pytest.mark.django_db(transaction=True)]


@pytest.fixture
def files(scientific, native_effects, monkeypatch):
    """使用本任务隔离 S3 桶并手动推进 worker，以观察中间阶段。"""
    for key, value in {
        "AWS_ACCESS_KEY_ID": "testing",
        "AWS_SECRET_ACCESS_KEY": "testing",
        "AWS_S3_BUCKET_NAME": "mcp-files-test",
        "AWS_REGION": "us-east-1",
        "USE_MINIO": "0",
    }.items():
        monkeypatch.setenv(key, value)
    monkeypatch.delenv("AWS_S3_ENDPOINT_URL", raising=False)
    monkeypatch.delenv("MINIO_ENDPOINT_URL", raising=False)
    monkeypatch.setattr(process_mcp_file_transfer, "delay", lambda session_id: None)
    e = scientific
    for project in e["projects"]:
        db.ProjectMember.objects.create(workspace=e["workspace"], project=project, member=e["owner"], role=20)
    with mock_aws():
        storage = boto3.client("s3", region_name="us-east-1")
        storage.create_bucket(Bucket="mcp-files-test")
        yield {**e, "s3": storage, "bucket": "mcp-files-test"}


def destination(e, location="issue_attachment", obj=None, resource_id=None):
    """构造真实父对象和可选论文或报告标识。"""
    if location.startswith("issue_"):
        parent = reference(e, "Issue", obj or e["issues"][0])
    elif location in {"task_instruction", "task_comment"}:
        parent = reference(e, "ResearchChainNodeTask", obj or e["tasks"][0])
    else:
        parent = reference(e, "ResearchChainNode", obj or e["node"])
    return {"parent": parent, "location": location, **({"resource_id": str(resource_id)} if resource_id else {})}


def prepared(e, content, target=None, name="report.md", request_id=None, content_type="text/markdown", **extra):
    """通过 MCP 创建有真实大小和摘要的上传会话。"""
    return invoke(
        e["client"],
        "plane_prepare_file_upload",
        {
            "target": target or destination(e),
            "file_name": name,
            "content_type": content_type,
            "size": len(content),
            "sha256": hashlib.sha256(content).hexdigest(),
            "request_id": request_id or uuid4().hex,
            **extra,
        },
    )


def upload_chunks(e, session, content, size=16384):
    """用现有 Base64 编码发送完整分块文件。"""
    for offset in range(0, len(content), size):
        result = invoke(
            e["client"],
            "plane_upload_file_chunk",
            {
                "session_id": session["session_id"],
                "offset": offset,
                "content_base64": base64.b64encode(content[offset : offset + size]).decode("ascii"),
            },
        )
        assert result["next_offset"] == min(offset + size, len(content))


def finish(e, session, transport="mcp"):
    """确认后运行真实 worker，再通过原请求标识恢复最终结果。"""
    pending = invoke(
        e["client"], "plane_complete_file_upload", {"session_id": session["session_id"], "transport": transport}
    )
    assert pending["phase"] in {"FINALIZING", "READY", "PUBLISHED"}
    process_mcp_file_transfer(session["session_id"])
    return invoke(
        e["client"],
        "plane_get_write_result",
        {"workspace_slug": e["workspace"].slug, "request_id": session["request_id"]},
    )


def test_large_chunk_roundtrip_resume_and_native_web_visibility(files):
    """超过 256 KiB 的文件能够分块续传、网页可见并逐块校验下载。"""
    e = files
    content = b"# synthetic report\n" + b"research results\n" * 20000
    assert len(content) > 262144
    session = prepared(e, content, request_id="large-report")
    first = {
        "session_id": session["session_id"],
        "offset": 0,
        "content_base64": base64.b64encode(content[:16384]).decode(),
    }
    invoke(e["client"], "plane_upload_file_chunk", first)
    assert invoke(e["client"], "plane_upload_file_chunk", first)["duplicate"]
    conflict = {**first, "content_base64": base64.b64encode(b"x" * 16384).decode()}
    invoke(e["client"], "plane_upload_file_chunk", conflict, error="chunk_conflict")
    wrong = invoke(e["client"], "plane_upload_file_chunk", {**first, "offset": 123}, error="invalid_offset")
    assert wrong["next_offset"] == 16384
    resumed = invoke(
        e["client"], "plane_get_write_result", {"workspace_slug": e["workspace"].slug, "request_id": "large-report"}
    )
    assert resumed["next_offset"] == 16384
    for offset in range(16384, len(content), 16384):
        invoke(
            e["client"],
            "plane_upload_file_chunk",
            {
                "session_id": session["session_id"],
                "offset": offset,
                "content_base64": base64.b64encode(content[offset : offset + 16384]).decode(),
            },
        )
    done = finish(e, session)
    assert done["file_complete"] and done["business_published"], done
    asset = db.FileAsset.objects.get(pk=done["result"]["asset_id"])
    assert e["s3"].get_object(Bucket=e["bucket"], Key=asset.asset.name)["Body"].read() == content
    listed = invoke(e["client"], "plane_list_files", destination(e))
    assert listed["data"][0]["file_ref"]["id"] == str(asset.pk)
    web = e["owner_client"].get(
        f"/api/assets/v2/workspaces/{e['workspace'].slug}/projects/{asset.project_id}/issues/{asset.issue_id}/attachments/{asset.pk}/"
    )
    assert web.status_code == 302
    download = invoke(e["client"], "plane_get_file_download", {"file_ref": listed["data"][0]["file_ref"]})
    process_mcp_file_transfer(download["session_id"])
    data, cursor = bytearray(), None
    while True:
        chunk = invoke(
            e["client"],
            "plane_read_file_chunk",
            {"session_id": download["session_id"], **({"cursor": cursor} if cursor else {})},
        )
        raw = base64.b64decode(chunk["content_base64"])
        assert hashlib.sha256(raw).hexdigest() == chunk["chunk_sha256"]
        data.extend(raw)
        cursor = chunk["next_cursor"]
        if chunk["eof"]:
            break
    assert bytes(data) == content and hashlib.sha256(data).hexdigest() == done["sha256"]


def test_http_upload_download_and_final_object_cannot_be_overwritten(files):
    """HTTP 直传使用短期请求，登记后不能重用原地址覆盖最终文件。"""
    e = files
    content = b"# HTTP report\n"
    session = prepared(e, content)
    url = urlsplit(session["http"]["url"])
    path = url.path + "?" + url.query
    http = APIClient()
    assert http.put(path, content, content_type="text/markdown").status_code == 200
    done = finish(e, session, "http")
    assert done["business_published"]
    assert http.put(path, content, content_type="text/markdown").status_code == 409
    download = invoke(e["client"], "plane_get_file_download", {"file_ref": done["file_ref"]})
    process_mcp_file_transfer(download["session_id"])
    download = invoke(
        e["client"],
        "plane_get_write_result",
        {"workspace_slug": e["workspace"].slug, "request_id": download["recovery_request_id"]},
    )
    link = urlsplit(download["http"]["url"])
    response = http.get(link.path + "?" + link.query)
    assert response.status_code == 200
    assert b"".join(response.streaming_content) == content
    assert response["X-File-SHA256"] == hashlib.sha256(content).hexdigest()


@pytest.mark.parametrize("location", ["issue_comment", "task_comment"])
def test_attachment_only_comment_is_published_once(files, location):
    """文件确认与评论发布分开，纯附件评论重试不重复关联。"""
    e = files
    target = destination(e, location)
    session = prepared(e, b"# comment report\n", target=target)
    upload_chunks(e, session, b"# comment report\n")
    done = finish(e, session)
    assert done["file_complete"] and not done["business_published"]
    attachment_id = done["result"]["asset_id"]
    if location == "issue_comment":
        args = {"target": target["parent"], "request_id": "comment-file-once", "attachment_ids": [attachment_id]}
        comment = invoke(e["client"], "plane_add_comment", args)
        assert invoke(e["client"], "plane_add_comment", args)["object_id"] == comment["object_id"]
        assert db.IssueComment.objects.filter(pk=comment["object_id"]).count() == 1
    else:
        proposal = prepare(
            e,
            "append_task_comment",
            {"task_id": str(e["tasks"][0].pk), "attachment_ids": [attachment_id]},
            request_id="comment-file-once",
        )
        comment = execute(e, proposal)
        assert comment["status"] == "COMMITTED", comment
        assert execute(e, proposal)["result"]["object_id"] == comment["result"]["object_id"]
        assert db.ResearchTaskCommentAttachment.objects.filter(asset_id=attachment_id).count() == 1
    recovered = invoke(
        e["client"],
        "plane_get_write_result",
        {"workspace_slug": e["workspace"].slug, "request_id": session["request_id"]},
    )
    assert recovered["business_published"] and recovered["result"]["comment_id"]
    listed = invoke(e["client"], "plane_list_files", target)
    assert len(listed["data"]) == 1


def test_task_comment_upload_uses_comment_permission_without_task_management(files, monkeypatch):
    """可评论的科研参与者能上传附件，不需要任务管理权限。"""
    e = files
    monkeypatch.setattr("plane.mcp.file_business.actor_can_manage_chain_tasks", lambda *args: False)
    monkeypatch.setattr(
        "plane.research.services.agent_operations.allowed_actions",
        lambda *args: {"append_task_comment"},
    )
    target = destination(e, "task_comment")
    session = prepared(e, b"# comment attachment\n", target=target)
    upload_chunks(e, session, b"# comment attachment\n")
    result = finish(e, session)
    assert result["file_complete"] and not result["business_published"]

    monkeypatch.setattr("plane.research.services.agent_operations.allowed_actions", lambda *args: set())
    invoke(
        e["client"],
        "plane_prepare_file_upload",
        {
            "target": target,
            "file_name": "denied.md",
            "content_type": "text/markdown",
            "size": 1,
            "sha256": hashlib.sha256(b"x").hexdigest(),
            "request_id": "comment-permission-denied",
        },
        error="permission_denied",
    )


def test_paper_candidate_does_not_submit_until_explicit_request(files):
    """候选文件上传不改变审核状态，显式提交仅生成一个审核版本。"""
    e = files
    e["node"].node_type = "PAPER_WRITING"
    e["node"].save(update_fields=["node_type"])
    review = db.ResearchPaperReview.objects.create(
        workspace=e["workspace"],
        chain=e["chain"],
        node=e["node"],
        owner=e["owner"],
        request_id=uuid4().hex,
        payload_hash="a" * 64,
    )
    target = destination(e, "paper_version", resource_id=review.pk)
    session = prepared(e, b"# Paper candidate\n", target=target, name="paper.md")
    upload_chunks(e, session, b"# Paper candidate\n")
    done = finish(e, session)
    assert done["file_complete"] and not done["business_published"]
    review.refresh_from_db()
    assert review.status == "OPEN" and review.current_version_no == 0
    assert not review.versions.exists()
    args = {"session_id": session["session_id"], "request_id": "paper-submit-once", "change_summary": "补充实验结果"}
    result = invoke(e["client"], "plane_submit_paper_version", args)
    assert result["business_published"] and result["result"]["version"] == 1
    assert (
        invoke(e["client"], "plane_submit_paper_version", args)["result"]["version_id"]
        == result["result"]["version_id"]
    )
    version = db.ResearchPaperReviewVersion.objects.get(pk=result["result"]["version_id"])
    assert version.request_id == args["request_id"]
    review.refresh_from_db()
    assert review.status == "WAITING_REVIEW" and review.versions.count() == 1
    missing_version = dict(result["file_ref"])
    missing_version.pop("version")
    invoke(e["client"], "plane_get_file_download", {"file_ref": missing_version}, error="version_required")


def test_research_node_file_is_registered_and_downloaded_from_one_snapshot(files, monkeypatch):
    """科研链节点文件复用知识库登记，并从本地不可变快照下载。"""
    e = files
    content = b"# Chain file\n"
    item = {
        "external_id": "knowledge-chain-file",
        "external_parent_id": "knowledge-base",
        "title": "chain-file.md",
        "source_url": "/api/uploads/upstream-upload",
        "metadata": {"upload_id": "upstream-upload", "parse_status": "success"},
    }
    client = SimpleNamespace(
        enabled=True,
        upload=lambda **_kwargs: SimpleNamespace(items=[item], degraded=False),
        upload_detail=lambda _identity: SimpleNamespace(items=[item], degraded=False),
    )
    connection = SimpleNamespace(base_url="https://ragportal.example")
    scope = SimpleNamespace(state="READY", external_kb_id="knowledge-base", scope="WORKSPACE", org_unit_id=None)
    monkeypatch.setattr("plane.bgtasks.mcp_file_task.rag_client", lambda _workspace: (client, connection))
    monkeypatch.setattr("plane.bgtasks.mcp_file_task.ready_knowledge_scope", lambda *_args: scope)

    session = prepared(e, content, target=destination(e, "node_file"), name="chain-file.md")
    upload_chunks(e, session, content)
    done = finish(e, session)
    assert done["file_complete"] and done["business_published"], done
    assert db.ResearchChainUpload.objects.get(pk=done["result"]["upload_id"]).status == "SUCCESS"

    listing = invoke(e["client"], "plane_list_files", destination(e, "node_file"))
    file_ref = listing["data"][0]["file_ref"]
    assert file_ref["id"] == done["result"]["upload_id"]
    download = invoke(e["client"], "plane_get_file_download", {"file_ref": file_ref})
    process_mcp_file_transfer(download["session_id"])
    offset, cursor, chunks = 0, None, bytearray()
    while offset < len(content):
        chunk = invoke(
            e["client"],
            "plane_read_file_chunk",
            {
                "session_id": download["session_id"],
                "chunk_size": 4,
                **({"cursor": cursor} if cursor else {}),
            },
        )
        raw = base64.b64decode(chunk["content_base64"])
        assert chunk["offset"] == offset
        chunks.extend(raw)
        offset += len(raw)
        cursor = chunk["next_cursor"]
    assert bytes(chunks) == content
    assert hashlib.sha256(chunks).hexdigest() == done["sha256"]


def test_formal_report_attachments_are_bound_to_authorized_snapshot_version(files):
    """正式周报附件按显式版本列举和下载，不能从其他快照借用。"""
    e = files
    page = db.Page.objects.create(workspace=e["workspace"], name="Formal report", owned_by=e["owner"])
    report = db.PeriodicReport.objects.create(
        workspace=e["workspace"],
        project=e["chain"].project,
        owner=e["owner"],
        org_unit=e["group"],
        page=page,
        report_type="WEEKLY",
        period_key="2026-W42",
        period_start="2026-10-12",
        period_end="2026-10-18",
        status="SUBMITTED",
        submitted_at=timezone.now(),
    )
    e["tasks"][0].resource_type = "REPORT"
    e["tasks"][0].resource_id = str(report.pk)
    e["tasks"][0].save(update_fields=["resource_type", "resource_id"])

    manifests = []
    for version, content in ((1, b"# Week 1\n"), (2, b"# Week 2\n")):
        name = f"week-{version}.md"
        key = f"{e['workspace'].pk}/{uuid4().hex}-{name}"
        digest = hashlib.sha256(content).hexdigest()
        asset = db.FileAsset.objects.create(
            workspace=e["workspace"],
            user=e["owner"],
            created_by=e["owner"],
            entity_type=db.FileAsset.EntityTypeContext.REPORT_ATTACHMENT,
            entity_identifier=str(report.pk),
            asset=key,
            attributes={"name": name, "type": "text/markdown", "sha256": digest},
            size=len(content),
            is_uploaded=True,
        )
        attachment = db.ReportAttachment.objects.create(
            report=report,
            asset=asset,
            kind=db.ReportAttachment.Kind.MARKDOWN,
            file_name=name,
            file_size=len(content),
            content_type="text/markdown",
            uploaded_by=e["owner"],
        )
        e["s3"].put_object(Bucket=e["bucket"], Key=key, Body=content)
        manifests.append(
            {
                "attachment_id": str(attachment.pk),
                "asset_id": str(asset.pk),
                "file_name": name,
                "file_size": len(content),
                "content_type": "text/markdown",
                "kind": "MARKDOWN",
            }
        )
    for version, manifest in ((1, manifests[:1]), (2, manifests)):
        db.PeriodicReportSnapshot.objects.create(
            report=report,
            version_no=version,
            snapshot_status="SUBMITTED",
            attachment_manifest=manifest,
            submitted_by=e["owner"],
        )

    target = destination(e, "report_attachment", resource_id=report.pk)
    invoke(e["client"], "plane_list_files", target, error="version_required")
    first = invoke(e["client"], "plane_list_files", {**target, "version": 1})
    second = invoke(e["client"], "plane_list_files", {**target, "version": 2})
    assert {item["file_name"] for item in first["data"]} == {"week-1.md"}
    assert {item["file_name"] for item in second["data"]} == {"week-1.md", "week-2.md"}
    missing_version = dict(first["data"][0]["file_ref"])
    missing_version.pop("version")
    invoke(e["client"], "plane_get_file_download", {"file_ref": missing_version}, error="version_required")

    week_two = next(item for item in second["data"] if item["file_name"] == "week-2.md")
    download = invoke(e["client"], "plane_get_file_download", {"file_ref": week_two["file_ref"]})
    process_mcp_file_transfer(download["session_id"])
    chunk = invoke(
        e["client"],
        "plane_read_file_chunk",
        {"session_id": download["session_id"], "chunk_size": 64},
    )
    assert base64.b64decode(chunk["content_base64"]) == b"# Week 2\n"


def test_markdown_body_limits_and_request_id_conflicts(files):
    """正文入口按 UTF-8 字节限制，大正文可用普通通道。"""
    e = files
    args = {
        "target": destination(e, "task_instruction"),
        "file_name": "报告.md",
        "text": "# 报告\n真实结果",
        "request_id": "markdown-body",
    }
    result = invoke(e["client"], "plane_upload_markdown", args)
    process_mcp_file_transfer(result["session_id"])
    retried = invoke(e["client"], "plane_upload_markdown", args)
    assert retried["file_complete"] and retried["business_published"], retried
    assert retried["result"]["attachment_id"] == retried["file_ref"]["id"]
    invoke(e["client"], "plane_upload_markdown", {**args, "text": "changed"}, error="idempotency_conflict")
    invoke(
        e["client"],
        "plane_upload_markdown",
        {**args, "request_id": "too-large-body", "text": "测" * 90000},
        error="markdown_text_limit",
    )
    with patch("plane.mcp.files.FileBusiness.limits", return_value={"markdown_max_mb": 0}):
        invoke(
            e["client"], "plane_upload_markdown", {**args, "request_id": "workspace-limit"}, error="markdown_text_limit"
        )


def test_wrong_hash_offset_type_and_cross_object_are_rejected(files):
    """校验失败不能登记，跨对象引用和未完成文件不能发布。"""
    e = files
    session = prepared(e, b"expected", sha256="0" * 64)
    upload_chunks(e, session, b"expected")
    failed = finish(e, session)
    assert failed["phase"] == "FAILED" and not failed["file_complete"]
    assert failed["error_code"] == "checksum_mismatch"
    session = prepared(e, b"# valid\n")
    upload_chunks(e, session, b"# valid\n")
    done = finish(e, session)
    forged = {**done["file_ref"], "parent": destination(e, obj=e["issues"][1])["parent"]}
    invoke(e["client"], "plane_get_file_download", {"file_ref": forged}, error="not_found")
    invoke(
        e["client"],
        "plane_upload_file_chunk",
        {"session_id": session["session_id"], "offset": 0, "content_base64": "bad!"},
        error="invalid_base64",
    )


def test_live_permission_revocation_and_cleanup_preserve_published_files(files):
    """临时地址实时失效，清理仅删除未发布文件和快照。"""
    e = files
    session = prepared(e, b"# pending\n", target=destination(e, "task_comment"))
    upload_chunks(e, session, b"# pending\n")
    done = finish(e, session)
    published = prepared(e, b"# published\n")
    upload_chunks(e, published, b"# published\n")
    public = finish(e, published)
    db.UnifiedMCPFileTransfer.objects.filter(pk__in=[session["session_id"], published["session_id"]]).update(
        expires_at=timezone.now() - timedelta(seconds=1)
    )
    cleanup_mcp_file_transfers()
    assert db.FileAsset.all_objects.get(pk=done["result"]["asset_id"]).is_deleted
    assert not db.FileAsset.objects.get(pk=public["result"]["asset_id"]).is_deleted
    recovered = invoke(
        e["client"],
        "plane_get_write_result",
        {"workspace_slug": e["workspace"].slug, "request_id": published["request_id"]},
    )
    assert recovered["business_published"]
    pending = prepared(e, b"# revoke\n")
    link = urlsplit(pending["http"]["url"])
    db.UnifiedMCPConnection.objects.filter(pk=e["connection"]["id"]).update(revoked_at=timezone.now())
    response = APIClient().put(link.path + "?" + link.query, b"# revoke\n", content_type="text/markdown")
    assert response.status_code == 403
    assert response.data["error_code"] == "file_credential_invalid"
