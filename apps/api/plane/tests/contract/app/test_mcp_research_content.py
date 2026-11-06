"""研发链任务说明为空时，评论和附件仍可发现且不越过授权范围。"""
# ruff: noqa: F401, F811

import asyncio
import io
import json
from datetime import timedelta
from pathlib import Path
import sys
from uuid import uuid4

import pytest
from django.utils import timezone
from docx import Document

from plane.db import models as db
from plane.preview.service import source_metadata
from plane.research.services.mcp_attachment_content import read_attachment_content
from plane.research.services.mcp_catalog import ResearchReadError
from plane.tests.contract.app.test_research_machine_access import invoke as legacy_invoke, scoped_client
from plane.tests.contract.app.test_unified_mcp import (
    collect,
    env,
    invoke,
    issued,
    machine,
    reference,
    rpc,
    unified,
)
from plane.tests.mcp_content_fixtures import attachment_storage, pdf_bytes
from plane.tests.research_fixtures import make_workspace

pytestmark = pytest.mark.contract


def add_comment(e, task, text="完成后的实验讨论"):
    """为指定任务添加与任务状态独立的评论。

    Args:
        e: 合成环境。
        task: 评论所属任务。
        text: 评论正文。

    Returns:
        新建的评论。
    """
    return db.ResearchTaskComment.objects.create(
        task=task,
        actor=e["owner"],
        comment_html=f"<p>{text}</p>",
        comment_stripped=text,
        request_id=uuid4().hex,
    )


def add_attachment(e, task, storage, *, comment=None, name="result.md", data=b"# Real content\n42"):
    """创建真实附件登记，资产 ID 与对外使用的登记 ID 相互独立。

    Args:
        e: 合成环境。
        task: 文件所属任务。
        storage: 内存对象存储。
        comment: 可选的所属评论。
        name: 文件名。
        data: 文件字节。

    Returns:
        描述附件或评论附件登记。
    """
    entity_type = (
        db.FileAsset.EntityTypeContext.RESEARCH_TASK_COMMENT_ATTACHMENT
        if comment
        else db.FileAsset.EntityTypeContext.RESEARCH_TASK_INSTRUCTION_ATTACHMENT
    )
    key = f"synthetic-content/{uuid4().hex}/{name}"
    storage.files[key] = data
    asset = db.FileAsset.objects.create(
        workspace=e["workspace"],
        user=e["owner"],
        asset=key,
        size=len(data),
        is_uploaded=True,
        entity_type=entity_type,
        entity_identifier=str(task.pk),
        attributes={"name": name},
    )
    model = db.ResearchTaskCommentAttachment if comment else db.ResearchChainNodeTaskAttachment
    return model.objects.create(
        **({"comment": comment} if comment else {"task": task}),
        asset=asset,
        file_name=name,
        file_size=len(data),
        content_type="text/markdown",
        uploaded_by=e["owner"],
    )


@pytest.fixture
def populated(unified, attachment_storage):
    """复现空任务说明、已完成任务的后续讨论及两类附件。

    Args:
        unified: MCP 基础环境。
        attachment_storage: 隔离对象存储。

    Returns:
        带评论与附件的合成环境。
    """
    e = unified
    task = e["tasks"][0]
    db.ResearchChainNode.objects.filter(pk=e["node"].pk).update(assignee=e["owner"], status="ACTIVE")
    e["node"].refresh_from_db()
    db.ResearchChainNodeTask.objects.filter(pk=task.pk).update(
        instruction="",
        status="COMPLETED",
        assignee=e["collaborator"],
        completed_at=timezone.now(),
    )
    task.refresh_from_db()
    comment = add_comment(e, task)
    description_file = add_attachment(e, task, attachment_storage)
    comment_file = add_attachment(e, task, attachment_storage, comment=comment, name="discussion.md")
    return {
        **e,
        "task": task,
        "comment": comment,
        "description_file": description_file,
        "comment_file": comment_file,
        "storage": attachment_storage,
    }


def context_args(e, section, *, task=False, **kwargs):
    """构造节点或任务读取参数。

    Args:
        e: 合成环境。
        section: 读取分区。
        task: 是否使用任务作为目标。
        kwargs: 分页或资源类型参数。

    Returns:
        统一 MCP 参数。
    """
    return {
        "target": reference(
            e, "ResearchChainNodeTask" if task else "ResearchChainNode", e["task"] if task else e["node"]
        ),
        "section": section,
        **kwargs,
    }


def read_args(e, obj, kind="task_attachment", **kwargs):
    """构造以附件登记 ID 为标识的正文参数。

    Args:
        e: 合成环境。
        obj: 附件登记。
        kind: 附件类型。
        kwargs: 正文分页参数。

    Returns:
        统一正文读取参数。
    """
    return {"parent": reference(e, "ResearchChainNode", e["node"]), "kind": kind, "resource_id": str(obj.pk), **kwargs}


def test_empty_instruction_still_discovers_completed_task_discussion_and_files(populated):
    """从节点详情的后续参数可取得评论和两类附件。"""
    e = populated
    _, client = issued(e)
    details = invoke(client, "plane_get_context", context_args(e, "details"))["data"]
    assert details["content_summary"] == {
        "task_count": 1,
        "task_comment_count": 1,
        "task_attachment_count": 1,
        "task_comment_attachment_count": 1,
    }
    assert details["assignee"]["id"] == str(e["owner"].pk)
    assert details["status"] == "ACTIVE"
    for call in details["next_calls"]:
        result = invoke(client, call["name"], call["arguments"])
        assert result["data"]
    tasks = collect(client, "plane_list_tasks", {"parent": reference(e, "ResearchChainNode", e["node"])})
    assert tasks[0]["status"] == "COMPLETED"
    assert tasks[0]["assignee"]["id"] == str(e["collaborator"].pk)
    assert tasks[0]["node_status"] == "ACTIVE"
    assert tasks[0]["node_assignee"]["id"] == str(e["owner"].pk)
    task_details = invoke(client, "plane_get_context", context_args(e, "details", task=True))["data"]
    assert task_details["instruction_excerpt"] == ""
    assert task_details["content_summary"] == details["content_summary"]
    comments = collect(client, "plane_get_context", context_args(e, "comments"))
    assert comments[0]["task_id"] == str(e["task"].pk)
    assert comments[0]["text"] == e["comment"].comment_stripped
    assert comments[0]["author"] and comments[0]["created_at"]
    assert comments[0]["content_ref"]["id"] == str(e["comment"].pk)
    assert comments[0]["content_available"]
    resources = collect(client, "plane_get_context", context_args(e, "resources", task=True, limit=1))
    assert {row["kind"] for row in resources} == {"task_attachment", "task_comment_attachment"}
    for row in resources:
        assert row["id"] != row["asset_id"]
        assert row["task_id"] == str(e["task"].pk)
        assert row["file_name"] and row["size_bytes"] and row["content_type"]
        assert row["content_state"] == "readable"
        assert row["content_ref"]["id"] == row["id"]
    assert not e["storage"].reads


def test_node_comments_are_newest_first_and_task_comments_keep_legacy_order(populated):
    """相同时间按 ID 稳定分页，节点最新优先，任务保持原顺序。"""
    e = populated
    second = add_comment(e, e["task"], "第二条讨论")
    third = add_comment(e, e["task"], "第三条讨论")
    same_time = timezone.now() + timedelta(seconds=1)
    db.ResearchTaskComment.objects.filter(pk__in=[second.pk, third.pk]).update(created_at=same_time)
    _, client = issued(e)
    newest = collect(client, "plane_get_context", context_args(e, "comments", limit=1))
    ascending = collect(client, "plane_get_context", context_args(e, "comments", task=True, limit=1))
    assert [row["id"] for row in newest] == [str(pk) for pk in sorted([second.pk, third.pk], reverse=True)] + [
        str(e["comment"].pk)
    ]
    assert [row["id"] for row in ascending] == list(reversed([row["id"] for row in newest]))
    page = invoke(client, "plane_get_context", context_args(e, "comments", limit=1))
    invoke(
        client,
        "plane_get_context",
        context_args(e, "comments", task=True, limit=1, cursor=page["page"]["next_cursor"]),
        error="invalid_cursor",
    )


def test_node_resource_aggregation_and_task_bound_resource_coexist(populated):
    """默认汇总可见节点资源，任务附件与绑定业务资源同时存在。"""
    e = populated
    external = db.ResearchExternalReference.objects.create(
        workspace=e["workspace"],
        system="RAGPORTAL",
        external_type="URL",
        external_id=uuid4().hex,
        title="绑定实验资料",
        acl_hint={"public": True},
    )
    db.ResearchChainNodeTask.objects.filter(pk=e["task"].pk).update(
        resource_type="EXTERNAL_REF", resource_id=external.pk
    )
    foreign_file = add_attachment(e, e["tasks"][1], e["storage"])
    _, client = issued(e)
    rows = collect(client, "plane_get_context", context_args(e, "resources", task=True, limit=1))
    assert {row["id"] for row in rows} == {str(external.pk), str(e["description_file"].pk), str(e["comment_file"].pk)}
    all_rows = collect(client, "plane_get_context", context_args(e, "resources", limit=1))
    assert {row["id"] for row in rows} <= {row["id"] for row in all_rows}
    assert str(foreign_file.pk) not in {row["id"] for row in all_rows}
    only_files = collect(
        client, "plane_get_context", context_args(e, "resources", task=True, resource_kind="task_comment_attachment")
    )
    assert [row["id"] for row in only_files] == [str(e["comment_file"].pk)]


@pytest.mark.parametrize(
    "kind,key", [("task_attachment", "description_file"), ("task_comment_attachment", "comment_file")]
)
def test_shared_reader_body_pagination_hash_and_change_detection(populated, kind, key):
    """统一和旧科研入口共享正文，长内容分页保持哈希并检测变化。"""
    e = populated
    obj = e[key]
    text = "# 实验记录\n测量值 42\n" * 100
    e["storage"].files[obj.asset.asset.name] = text.encode()
    _, client = issued(e)
    args = read_args(e, obj, kind, max_chars=256)
    pieces, hashes = [], set()
    first = invoke(client, "plane_read_resource", args)
    current = first
    while True:
        pieces.append(current["data"]["text"])
        hashes.add(current["data"]["content_hash"])
        if not current["page"]["has_more"]:
            break
        current = invoke(client, "plane_read_resource", {**args, "cursor": current["page"]["next_cursor"]})
    assert len(pieces) > 1 and len(hashes) == 1
    assert json.loads("".join(pieces))["text"] == text
    legacy_client, _, _ = scoped_client(e)
    legacy = legacy_invoke(
        e,
        "read_research_resource",
        {
            "node_id": str(e["node"].pk),
            "kind": kind,
            "resource_id": str(obj.pk),
            "max_chars": 16000,
        },
        legacy_client,
    )
    assert legacy.status_code == 200, legacy.json()
    assert json.loads(legacy.json()["data"]["text"])["text"] == text
    _, other_client = issued(e)
    invoke(
        other_client, "plane_read_resource", {**args, "cursor": first["page"]["next_cursor"]}, error="invalid_cursor"
    )
    e["storage"].files[obj.asset.asset.name] = b"Changed source body"
    invoke(client, "plane_read_resource", {**args, "cursor": first["page"]["next_cursor"]}, error="version_changed")
    invoke(client, "plane_read_resource", {**args, "version": 1}, error="version_invalid")
    assert all(body.closed for body in e["storage"].bodies)


def test_real_docx_tables_are_readable_through_unified_mcp(populated):
    """无 PDF 预览的 DOCX 表格可通过正式 MCP 入口读取。"""
    e = populated
    document = Document()
    document.add_paragraph("研究结论")
    table = document.add_table(rows=1, cols=2)
    table.cell(0, 0).text = "样品"
    table.cell(0, 1).text = "测量值 42"
    output = io.BytesIO()
    document.save(output)
    obj = add_attachment(e, e["task"], e["storage"], name="result.docx", data=output.getvalue())
    _, client = issued(e)
    result = invoke(client, "plane_read_resource", read_args(e, obj))
    text = json.loads(result["data"]["text"])["text"]
    assert "研究结论" in text and "样品\t测量值 42" in text
    assert not db.AssetPreview.objects.filter(asset=obj.asset).exists()


@pytest.mark.parametrize("state", ["missing", "stale", "wrong_converter", "failed", "ready"])
def test_office_requires_existing_current_source_pdf_preview(populated, settings, state):
    """其他 Office 格式只读取匹配指纹和转换版本的现成 PDF。"""
    e = populated
    obj = add_attachment(e, e["task"], e["storage"], name="result.xlsx", data=b"synthetic office source")
    fingerprint = source_metadata(e["storage"], obj.asset)[0]
    converted = pdf_bytes("Preview measured value 42")
    key = f"synthetic-preview/{uuid4().hex}.pdf"
    if state != "missing":
        db.AssetPreview.objects.create(
            asset=obj.asset,
            fingerprint="0" * 64 if state == "stale" else fingerprint,
            converter_version="previous-version" if state == "wrong_converter" else settings.ATTACHMENT_PREVIEW_VERSION,
            kind="pdf",
            status="failed" if state == "failed" else "ready",
            object_key=key,
            size=len(converted),
            content_type="application/pdf",
        )
        e["storage"].files[key] = converted
    count = db.AssetPreview.objects.count()
    _, client = issued(e)
    result = invoke(
        client, "plane_read_resource", read_args(e, obj), error=None if state == "ready" else "preview_unavailable"
    )
    if state == "ready":
        body = json.loads(result["data"]["text"])
        assert body["extraction_source"] == "preview" and "Preview measured value 42" in body["text"]
        assert e["storage"].reads == [key]
    else:
        assert not e["storage"].reads
    assert db.AssetPreview.objects.count() == count


@pytest.mark.parametrize(
    "kind,key", [("task_attachment", "description_file"), ("task_comment_attachment", "comment_file")]
)
@pytest.mark.parametrize(
    "mutation",
    [
        "attachment_deleted",
        "asset_deleted",
        "asset_soft_deleted",
        "not_uploaded",
        "wrong_workspace",
        "wrong_entity",
        "wrong_task_identifier",
        "task_deleted",
        "task_wrong_chain",
        "task_wrong_workspace",
        "comment_deleted",
        "node_deleted",
        "chain_deleted",
    ],
)
def test_attachment_counts_and_bodies_recheck_every_parent_and_asset(populated, kind, key, mutation):
    """伪造归属或删除任一父记录时，数量与正文均不泄露且不读存储。"""
    e = populated
    obj = e[key]
    _, client = issued(e)
    foreign = make_workspace(e["owner"])
    if mutation == "attachment_deleted":
        type(obj).all_objects.filter(pk=obj.pk).update(deleted_at=timezone.now())
    elif mutation == "asset_deleted":
        db.FileAsset.objects.filter(pk=obj.asset_id).update(is_deleted=True)
    elif mutation == "asset_soft_deleted":
        db.FileAsset.all_objects.filter(pk=obj.asset_id).update(deleted_at=timezone.now())
    elif mutation == "not_uploaded":
        db.FileAsset.objects.filter(pk=obj.asset_id).update(is_uploaded=False)
    elif mutation == "wrong_workspace":
        db.FileAsset.objects.filter(pk=obj.asset_id).update(workspace=foreign)
    elif mutation == "wrong_entity":
        db.FileAsset.objects.filter(pk=obj.asset_id).update(entity_type="ISSUE_ATTACHMENT")
    elif mutation == "wrong_task_identifier":
        db.FileAsset.objects.filter(pk=obj.asset_id).update(entity_identifier=str(e["tasks"][1].pk))
    elif mutation == "task_deleted":
        db.ResearchChainNodeTask.all_objects.filter(pk=e["task"].pk).update(deleted_at=timezone.now())
    elif mutation == "task_wrong_chain":
        other_chain = db.ResearchChain.objects.create(
            workspace=e["workspace"],
            project=e["public_project"],
            owner=e["owner"],
            request_id=uuid4().hex,
            payload_hash="a" * 64,
        )
        db.ResearchChainNodeTask.objects.filter(pk=e["task"].pk).update(chain=other_chain)
    elif mutation == "task_wrong_workspace":
        db.ResearchChainNodeTask.objects.filter(pk=e["task"].pk).update(workspace=foreign)
    elif mutation == "comment_deleted":
        db.ResearchTaskComment.all_objects.filter(pk=e["comment"].pk).update(deleted_at=timezone.now())
        if kind == "task_attachment":
            details = invoke(client, "plane_get_context", context_args(e, "details"))["data"]
            counts = details["content_summary"]
            assert counts["task_attachment_count"] == 1 and counts["task_comment_attachment_count"] == 0
            invoke(client, "plane_read_resource", read_args(e, obj, kind))
            return
    elif mutation == "node_deleted":
        db.ResearchChainNode.all_objects.filter(pk=e["node"].pk).update(deleted_at=timezone.now())
    else:
        db.ResearchChain.all_objects.filter(pk=e["chain"].pk).update(deleted_at=timezone.now())
    invoke(client, "plane_read_resource", read_args(e, obj, kind), error="not_found")
    if mutation not in {"node_deleted", "chain_deleted"}:
        details = invoke(client, "plane_get_context", context_args(e, "details"))["data"]
        assert details["content_summary"][f"{kind}_count"] == 0
        rows = collect(client, "plane_get_context", context_args(e, "resources", resource_kind=kind))
        assert rows == []
    assert not e["storage"].reads


def test_forged_node_and_asset_id_cannot_read_files(populated):
    """跨节点、跨工作区或使用资产 ID 代替登记 ID 均拒绝。"""
    e = populated
    _, client = issued(e)
    args = read_args(e, e["description_file"])
    invoke(
        client, "plane_read_resource", {**args, "resource_id": str(e["description_file"].asset_id)}, error="not_found"
    )
    invoke(
        client,
        "plane_read_resource",
        {**args, "parent": reference(e, "ResearchChainNode", e["other"])},
        error="not_found",
    )
    foreign = make_workspace(e["owner"])
    invoke(
        client,
        "plane_read_resource",
        {**args, "parent": {**args["parent"], "workspace_slug": foreign.slug}},
        error="not_found",
    )
    assert not e["storage"].reads


def test_frozen_attachment_scope_and_parent_scope_remain_closed(populated):
    """冻结连接登记新类型；旧连接缺少类型或父引用时继续拒绝。"""
    e = populated
    _, dynamic = issued(e)
    frozen, snapshot = issued(e, future=False)
    new_file = add_attachment(e, e["task"], e["storage"], name="later.md")
    dynamic_count = invoke(dynamic, "plane_get_context", context_args(e, "details"))["data"]["content_summary"]
    frozen_count = invoke(snapshot, "plane_get_context", context_args(e, "details"))["data"]["content_summary"]
    assert dynamic_count["task_attachment_count"] == 2 and frozen_count["task_attachment_count"] == 1
    invoke(dynamic, "plane_read_resource", read_args(e, new_file))
    invoke(snapshot, "plane_read_resource", read_args(e, new_file), error="not_found")
    for kind, key in (("task_attachment", "description_file"), ("task_comment_attachment", "comment_file")):
        invoke(snapshot, "plane_read_resource", read_args(e, e[key], kind))
    record = db.UnifiedMCPConnection.objects.get(pk=frozen["id"])
    resources = record.scope["workspaces"][0]["snapshot"]["resources"][str(e["node"].pk)]
    resources.pop("task_attachment")
    resources["task_comment"] = []
    record.save(update_fields=["scope"])
    e["storage"].reads.clear()
    invoke(snapshot, "plane_read_resource", read_args(e, e["description_file"]), error="not_found")
    invoke(
        snapshot, "plane_read_resource", read_args(e, e["comment_file"], "task_comment_attachment"), error="not_found"
    )
    counts = invoke(snapshot, "plane_get_context", context_args(e, "details"))["data"]["content_summary"]
    assert (
        counts["task_attachment_count"] == counts["task_comment_attachment_count"] == counts["task_comment_count"] == 0
    )
    assert not e["storage"].reads


@pytest.mark.parametrize("revoke", ["connection", "membership", "grant"])
def test_attachment_reads_stop_after_authorization_is_revoked(populated, revoke):
    """连接、成员资格和旧节点授权撤销后停止正文读取。"""
    e = populated
    value, client = issued(e)
    legacy, grant, _ = scoped_client(e)
    e["storage"].files[e["description_file"].asset.asset.name] = b"Long source body " * 100
    args = read_args(e, e["description_file"], max_chars=256)
    first = invoke(client, "plane_read_resource", args)
    args["cursor"] = first["page"]["next_cursor"]
    assert args["cursor"]
    e["storage"].reads.clear()
    if revoke == "connection":
        db.UnifiedMCPConnection.objects.filter(pk=value["id"]).update(revoked_at=timezone.now())
        assert (
            rpc(
                client, "tools/call", {"name": "plane_read_resource", "arguments": read_args(e, e["description_file"])}
            ).status_code
            == 401
        )
    elif revoke == "membership":
        db.WorkspaceMember.objects.filter(workspace=e["workspace"], member=e["owner"]).update(is_active=False)
        invoke(client, "plane_read_resource", args, error="scope_denied")
    else:
        db.ResearchContextGrant.objects.filter(pk=grant.pk).update(revoked_at=timezone.now())
        response = legacy_invoke(
            e,
            "read_research_resource",
            {
                "node_id": str(e["node"].pk),
                "kind": "task_attachment",
                "resource_id": str(e["description_file"].pk),
            },
            legacy,
        )
        assert response.status_code == 401
    assert not e["storage"].reads


@pytest.mark.django_db(transaction=True)
def test_attachment_navigation_through_real_http_and_stdio_sdk(populated, live_server):
    """真实 TCP 与 STDIO SDK 均能发现并读取两类附件。"""
    import httpx
    from mcp import ClientSession, StdioServerParameters
    from mcp.client.stdio import stdio_client
    from mcp.client.streamable_http import streamable_http_client

    e = populated
    issued_value, _ = issued(e)
    parent = reference(e, "ResearchChainNode", e["node"])

    async def scenario():
        """在两种传输中完整读取合成科研附件。"""
        async with httpx.AsyncClient(
            headers={"Authorization": "Bearer " + issued_value["secret"]},
            trust_env=False,
        ) as http:
            async with streamable_http_client(live_server.url + "/api/mcp/", http_client=http) as streams:
                async with ClientSession(*streams[:2]) as session:
                    await session.initialize()
                    details = await session.call_tool("plane_get_context", {"target": parent, "section": "details"})
                    assert not details.isError
                    assert details.structuredContent["data"]["content_summary"]["task_comment_attachment_count"] == 1
                    comments = await session.call_tool("plane_get_context", {"target": parent, "section": "comments"})
                    assert not comments.isError
                    assert comments.structuredContent["data"][0]["task_id"] == str(e["task"].pk)
                    result = await session.call_tool("plane_read_resource", read_args(e, e["description_file"]))
                    assert not result.isError
                    assert json.loads(result.structuredContent["data"]["text"])["text"] == "# Real content\n42"
        script = Path(__file__).resolve().parents[6] / "demos/sciencediscovery-plane-mcp/research_mcp.py"
        parameters = StdioServerParameters(
            command=sys.executable,
            args=[str(script)],
            env={
                "PLANE_BASE_URL": live_server.url,
                "PLANE_WORKSPACE_SLUG": e["workspace"].slug,
                "PLANE_API_KEY": e["token"].token,
                "NO_PROXY": "127.0.0.1,localhost",
            },
        )
        async with stdio_client(parameters) as streams:
            async with ClientSession(*streams) as session:
                await session.initialize()
                tools = (await session.list_tools()).tools
                schema = next(tool.inputSchema for tool in tools if tool.name == "read_research_resource")
                assert "task_comment_attachment" in schema["properties"]["kind"]["enum"]
                result = await session.call_tool(
                    "read_research_resource",
                    {
                        "node_id": str(e["node"].pk),
                        "kind": "task_comment_attachment",
                        "resource_id": str(e["comment_file"].pk),
                    },
                )
                assert not result.isError
                assert json.loads(result.structuredContent["data"]["text"])["text"] == "# Real content\n42"

    asyncio.run(scenario())
