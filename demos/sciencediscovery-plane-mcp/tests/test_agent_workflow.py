"""Offline behavioral and real STDIO protocol tests for the general workflow."""

from __future__ import annotations

import asyncio
import copy
import json
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client
from mcp.server.stdio import stdio_server
from mcp.types import CallToolResult, TextContent, Tool

from agent_mcp import create_server, tools
from agent_workflow import AgentWorkflow, WorkflowError, parse_task_link, unpack
from plane_client import PlaneConfig

PROJECT = "11111111-1111-4111-8111-111111111111"
TASK = "22222222-2222-4222-8222-222222222222"
STATE = "33333333-3333-4333-8333-333333333333"
UI = "http://plane.lab:3000"
URL = f"{UI}/lab/projects/{PROJECT}/issues/{TASK}"
BROWSE = f"{UI}/lab/browse/LAB-3/"
CONFIG = PlaneConfig("http://plane-api.lab:8000", "lab", "test-user-token")


def result(value, *, error=False):
    return CallToolResult(isError=error, content=[TextContent(type="text", text=json.dumps(value))], structuredContent=value if isinstance(value, dict) else {"result": value})


def schema(name):
    return Tool(name=name, inputSchema={
        "type": "object", "properties": {
            "action": {"type": "string", "enum": ["list", "retrieve", "create", "update", "delete"]},
            **{key: {"type": "string"} for key in ("project_id", "workitem_id", "comment_id", "state_id", "cursor", "comment_html")},
            "per_page": {"type": "integer"},
        }, "required": ["action"],
    })


class FakePlaneMCP:
    def __init__(self):
        self.calls = []
        self.comments = [{"id": "old-comment", "comment_html": "<p>Check test temperature.</p>"}]
        self.projects = [{"id": PROJECT, "identifier": "LAB", "name": "Materials", "description": "Study cycling performance"}]
        self.item = {"id": TASK, "project": PROJECT, "name": "Analyze capacity fade", "sequence_id": 3, "description_html": "<p>Compare test conditions.</p>", "state": STATE}
        self.denied = False
        self.create_mode = "normal"
        self.on_create = None
        self.bad_pagination = False
        self.retrieve_wrong_id = False
        self.readback_wrong = False
        self.create_started = None
        self.create_continue = None

    async def list_tools(self, **kwargs):
        return SimpleNamespace(tools=[schema(name) for name in ("project", "workitem", "state", "workitem_comment", "delete_everything")], nextCursor=None)

    async def call_tool(self, name, arguments):
        args = copy.deepcopy(arguments)
        self.calls.append((name, args))
        if self.denied:
            return result({"error": "forbidden"}, error=True)
        action = args["action"]
        if action == "create":
            if name != "workitem_comment":
                raise AssertionError("Unexpected write")
            if self.on_create:
                self.on_create(args)
            if self.create_started:
                self.create_started.set()
                await self.create_continue.wait()
            if self.create_mode != "timeout-before":
                self.comments.append({"id": "created-comment", "comment_html": args["comment_html"]})
            if self.create_mode.startswith("timeout"):
                raise TimeoutError("Bearer SECRET_NEVER_EXPOSE")
            return result(copy.deepcopy(self.comments[-1]))
        if action == "retrieve":
            value = copy.deepcopy(self.projects[0] if name == "project" else self.item if name == "workitem" else {"id": STATE, "name": "In progress", "group": "started"})
            if self.retrieve_wrong_id and name == "workitem":
                value["id"] = "wrong-task"
            return result(value)
        rows = self.projects if name == "project" else [self.item] if name == "workitem" else self.comments
        rows = copy.deepcopy(rows)
        if self.readback_wrong and name == "workitem_comment" and len(rows) > 1:
            rows[-1]["comment_html"] += "edited"
        if self.bad_pagination:
            return result({"results": rows})
        # Always exercise pagination, including the one-row final page.
        offset = int(args.get("cursor", "0"))
        batch = rows[offset:offset + 1]
        more = offset + 1 < len(rows)
        return result({"results": batch, "next_page_results": more, "next_cursor": str(offset + 1) if more else None})

    @property
    def writes(self):
        return [args for name, args in self.calls if args["action"] == "create"]


class LinkTests(unittest.TestCase):
    def test_supported_routes_and_query_filters(self):
        self.assertEqual(parse_task_link(URL + "?panel=open#comment", UI, "lab").workitem_id, TASK)
        parsed = parse_task_link(BROWSE, UI, "lab")
        self.assertEqual((parsed.identifier, parsed.sequence_id), ("LAB", 3))
        self.assertEqual(parse_task_link("http://plane.lab/lab/browse/LAB-3", "http://plane.lab:80", "lab").sequence_id, 3)

    def test_foreign_origins_workspaces_and_unsupported_routes_rejected(self):
        for url in (
            URL.replace("plane.lab", "attacker.lab"), URL.replace("/lab/", "/private/"),
            URL.replace("http://", "https://"), URL.replace(":3000", ":3001"),
            URL.replace("http://", "http://token@"), "/lab/browse/LAB-3", "file:///lab/browse/LAB-3",
            URL.replace(TASK, "not-a-uuid"), BROWSE.replace("LAB-3", "LAB-0"),
            BROWSE.replace("LAB-3", "LAB-3%2F.."), UI + "/lab/projects", URL + "\n",
            URL.replace("/issues/", "/archives/issues/"),
        ):
            with self.subTest(url=url), self.assertRaises(WorkflowError):
                parse_task_link(url, UI, "lab")


class WorkflowTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.fake = FakePlaneMCP()
        self.workflow = self.new_workflow()
        await self.workflow.discover()

    def new_workflow(self, config=CONFIG, *, enable_publish=True):
        return AgentWorkflow(self.fake, config, UI, Path(self.directory.name), enable_publish=enable_publish)

    async def test_reads_current_task_state_and_all_comments(self):
        self.fake.comments.extend({"id": f"comment-{i}", "comment_html": str(i)} for i in range(3))
        context = await self.workflow.read_task_context(BROWSE)
        self.assertEqual(context["identifier"], "LAB-3")
        self.assertEqual(context["task_url"], URL)
        self.assertEqual(context["task"]["description_html"], self.fake.item["description_html"])
        self.assertEqual(len(context["comments"]), 4)
        self.assertEqual(context["state"]["group"], "started")
        self.assertTrue(context["context_scope"]["comments_complete"])
        self.assertFalse(context["context_scope"]["attachment_contents_fetched"])
        self.assertFalse(self.fake.writes)

    async def test_uuid_route_avoids_project_wide_lists(self):
        await self.workflow.read_task_context(URL)
        self.assertFalse(any(name in {"project", "workitem"} and args["action"] == "list" for name, args in self.fake.calls))

    async def test_permissions_resource_identity_and_incomplete_pages_fail(self):
        self.fake.denied = True
        with self.assertRaises(WorkflowError):
            await self.workflow.read_task_context(URL)
        self.fake.denied = False
        self.fake.retrieve_wrong_id = True
        with self.assertRaises(WorkflowError):
            await self.workflow.read_task_context(URL)
        self.fake.retrieve_wrong_id = False
        self.fake.bad_pagination = True
        with self.assertRaises(WorkflowError):
            await self.workflow.read_task_context(BROWSE)

    async def test_duplicate_project_identifier_and_task_sequence_rejected(self):
        self.fake.projects.append({"id": "other-project", "identifier": "LAB"})
        with self.assertRaises(WorkflowError):
            await self.workflow.read_task_context(BROWSE)

    async def test_draft_preview_is_exact_and_does_not_write_plane(self):
        progress = "已完成：核对温度\n发现：A < B & C\n下一步：补充对照"
        draft = await self.workflow.prepare_progress(URL, progress)
        again = await self.workflow.prepare_progress(BROWSE, progress)
        self.assertEqual(draft["progress"], progress)
        self.assertEqual(again["draft_id"], draft["draft_id"])
        changed = await self.workflow.prepare_progress(URL, progress + "\n新修改")
        self.assertNotEqual(changed["draft_id"], draft["draft_id"])
        self.assertFalse(self.fake.writes)
        self.assertNotIn(CONFIG.api_key, self.workflow.store.path(draft["draft_id"]).read_text(encoding="utf-8"))

    async def test_disabled_publishing_has_only_read_tool(self):
        workflow = self.new_workflow(enable_publish=False)
        await workflow.discover()
        self.assertEqual([tool.name for tool in tools(False)], ["read_task_context"])
        with self.assertRaises(WorkflowError):
            await workflow.prepare_progress(URL, "progress")
        with self.assertRaises(WorkflowError):
            await workflow.publish_progress("a" * 64, True)

    async def test_bad_progress_and_missing_approval_never_write(self):
        for body in ("", " ", "x" * 30001, "null\x00byte", None):
            with self.assertRaises(WorkflowError):
                await self.workflow.prepare_progress(URL, body)
        draft = await self.workflow.prepare_progress(URL, "review me")
        for approved in (False, 1, "true", None):
            with self.assertRaises(WorkflowError):
                await self.workflow.publish_progress(draft["draft_id"], approved)
        self.assertFalse(self.fake.writes)

    async def test_publish_journals_before_create_escapes_html_and_verifies_readback(self):
        draft = await self.workflow.prepare_progress(URL, "A < B\n<script> & done")
        checked = []

        def before_create(args):
            checked.append(self.workflow.store.load(draft["draft_id"])["status"])

        self.fake.on_create = before_create
        observed = await self.workflow.publish_progress(draft["draft_id"], True)
        self.assertEqual(checked, ["pending"])
        self.assertEqual(observed["task_url"], URL)
        self.assertTrue(observed["read_back"])
        self.assertTrue(observed["plane_writes"])
        self.assertIn("A &lt; B<br>&lt;script&gt; &amp; done", self.fake.writes[0]["comment_html"])
        self.assertEqual(self.workflow.store.load(draft["draft_id"])["status"], "published")

    async def test_repeated_publish_after_process_restart_never_duplicates(self):
        draft = await self.workflow.prepare_progress(URL, "progress")
        first = await self.workflow.publish_progress(draft["draft_id"], True)
        restarted = self.new_workflow()
        await restarted.discover()
        second = await restarted.publish_progress(draft["draft_id"], True)
        self.assertEqual(first["comment_id"], second["comment_id"])
        self.assertTrue(second["reused"])
        self.assertFalse(second["plane_writes"])
        self.assertEqual(len(self.fake.writes), 1)

    async def test_ambiguous_committed_write_reconciles_without_post(self):
        draft = await self.workflow.prepare_progress(URL, "progress")
        self.fake.create_mode = "timeout-after"
        with self.assertRaises(WorkflowError) as raised:
            await self.workflow.publish_progress(draft["draft_id"], True)
        self.assertNotIn("SECRET_NEVER_EXPOSE", str(raised.exception))
        self.assertEqual(self.workflow.store.load(draft["draft_id"])["status"], "pending")
        observed = await self.workflow.publish_progress(draft["draft_id"], True)
        self.assertTrue(observed["reused"])
        self.assertEqual(len(self.fake.writes), 1)

    async def test_ambiguous_uncommitted_write_stays_pending_without_post(self):
        draft = await self.workflow.prepare_progress(URL, "progress")
        self.fake.create_mode = "timeout-before"
        for _ in range(2):
            with self.assertRaises(WorkflowError):
                await self.workflow.publish_progress(draft["draft_id"], True)
        self.assertEqual(len(self.fake.writes), 1)

    async def test_readback_edits_and_duplicate_markers_fail_closed(self):
        draft = await self.workflow.prepare_progress(URL, "progress")
        self.fake.readback_wrong = True
        with self.assertRaises(WorkflowError):
            await self.workflow.publish_progress(draft["draft_id"], True)
        self.fake.readback_wrong = False
        self.fake.comments.append(copy.deepcopy(self.fake.comments[-1]) | {"id": "duplicate"})
        with self.assertRaises(WorkflowError):
            await self.workflow.publish_progress(draft["draft_id"], True)
        self.assertEqual(len(self.fake.writes), 1)

    async def test_deleted_published_comment_is_not_recreated(self):
        draft = await self.workflow.prepare_progress(URL, "progress")
        await self.workflow.publish_progress(draft["draft_id"], True)
        self.fake.comments.pop()
        with self.assertRaises(WorkflowError):
            await self.workflow.publish_progress(draft["draft_id"], True)
        self.assertEqual(len(self.fake.writes), 1)

    async def test_credentials_are_isolated_and_revocation_rechecked(self):
        draft = await self.workflow.prepare_progress(URL, "progress")
        other = self.new_workflow(PlaneConfig(CONFIG.base_url, "lab", "other-student-token"))
        await other.discover()
        with self.assertRaises(WorkflowError):
            await other.publish_progress(draft["draft_id"], True)
        self.fake.denied = True
        with self.assertRaises(WorkflowError):
            await self.workflow.publish_progress(draft["draft_id"], True)
        self.assertFalse(self.fake.writes)

    async def test_tampered_draft_and_path_traversal_rejected(self):
        draft = await self.workflow.prepare_progress(URL, "progress")
        saved = self.workflow.store.load(draft["draft_id"])
        saved["body"] = "unreviewed edit"
        self.workflow.store.path(draft["draft_id"]).write_text(json.dumps(saved))
        for key in (draft["draft_id"], "../other-user", "a" * 63):
            with self.assertRaises(WorkflowError):
                await self.workflow.publish_progress(key, True)
        self.assertFalse(self.fake.writes)

    async def test_concurrent_clients_cannot_double_post_same_draft(self):
        draft = await self.workflow.prepare_progress(URL, "progress")
        self.fake.create_started, self.fake.create_continue = asyncio.Event(), asyncio.Event()
        first = asyncio.create_task(self.workflow.publish_progress(draft["draft_id"], True))
        await self.fake.create_started.wait()
        try:
            other = self.new_workflow()
            await other.discover()
            with self.assertRaises(WorkflowError):
                await other.publish_progress(draft["draft_id"], True)
        finally:
            self.fake.create_continue.set()
            await first
        self.assertEqual(len(self.fake.writes), 1)


class ProtocolTests(unittest.IsolatedAsyncioTestCase):
    async def test_real_stdio_discovery_context_preview_and_publish(self):
        with tempfile.TemporaryDirectory() as folder:
            parameters = StdioServerParameters(command=sys.executable, args=[str(Path(__file__).resolve()), "--fake-stdio", folder])
            async with stdio_client(parameters) as streams:
                async with ClientSession(*streams) as session:
                    await session.initialize()
                    catalogue = await session.list_tools()
                    self.assertEqual({tool.name for tool in catalogue.tools}, {"read_task_context", "prepare_progress", "publish_progress"})
                    self.assertTrue(next(tool for tool in catalogue.tools if tool.name == "read_task_context").annotations.readOnlyHint)
                    self.assertFalse(next(tool for tool in catalogue.tools if tool.name == "publish_progress").annotations.readOnlyHint)
                    context = unpack(await session.call_tool("read_task_context", {"task_url": BROWSE}))
                    self.assertEqual(context["task"]["id"], TASK)
                    for name, args in (("workitem_comment", {"action": "create"}), ("publish_progress", {"draft_id": "a" * 64, "approved": False}), ("read_task_context", {"task_url": URL, "command": "delete"})):
                        self.assertTrue((await session.call_tool(name, args)).isError)
                    draft = unpack(await session.call_tool("prepare_progress", {"task_url": URL, "progress": "Reviewed progress"}))
                    published = unpack(await session.call_tool("publish_progress", {"draft_id": draft["draft_id"], "approved": True}))
                    self.assertTrue(published["read_back"])
                    repeated = unpack(await session.call_tool("publish_progress", {"draft_id": draft["draft_id"], "approved": True}))
                    self.assertEqual(repeated["comment_id"], published["comment_id"])
                    self.assertTrue(repeated["reused"])


async def fake_stdio(folder):
    workflow = AgentWorkflow(FakePlaneMCP(), CONFIG, UI, Path(folder), enable_publish=True)
    await workflow.discover()
    server = create_server(workflow)
    async with stdio_server() as streams:
        await server.run(*streams, server.create_initialization_options())


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "--fake-stdio":
        asyncio.run(fake_stdio(sys.argv[2]))
    else:
        unittest.main()
