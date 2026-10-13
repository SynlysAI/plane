import asyncio
import copy
import json
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from verify_mcp import COMMENT_MARKER, VerificationError, comment_once, pages, payload, read_report

TEMP_ROOT = Path(__file__).resolve().parents[1]


def result(data=None, *, error=False, text=None):
    return SimpleNamespace(isError=error, structuredContent=data, content=[] if text is None else [SimpleNamespace(type="text", text=text)])


class FakeMCP:
    def __init__(self, replies):
        self.replies, self.calls = iter(replies), []

    async def call_tool(self, name, args):
        self.calls.append((name, dict(args)))
        return result(next(self.replies))


class FakeComments:
    """Model only comment reads/creation; never connect to a real MCP server."""

    def __init__(self, comments=(), *, before_create=None, create_error=None):
        self.comments = copy.deepcopy(list(comments))
        self.before_create = before_create
        self.create_error = create_error
        self.calls = []

    async def call_tool(self, name, args):
        self.calls.append((name, dict(args)))
        if name != "workitem_comment":
            raise AssertionError("Unexpected resource")
        if args["action"] == "list":
            return result(copy.deepcopy(self.comments))
        if args["action"] != "create":
            raise AssertionError("Unexpected action")
        if self.before_create:
            self.before_create(args)
        if self.create_error:
            raise self.create_error
        created = {"id": "new-comment", "comment_html": args["comment_html"]}
        self.comments.append(created)
        return result(copy.deepcopy(created))


class MCPVerificationTests(unittest.TestCase):
    def test_text_application_error_is_not_success(self):
        with self.assertRaises(VerificationError):
            payload(result(text="Error: missing project_id"))

    def test_protocol_error_is_not_success(self):
        with self.assertRaises(VerificationError):
            payload(result({"id": "x"}, error=True))

    def test_wrapped_list(self):
        self.assertEqual(payload(result({"result": [{"id": "x"}]})), [{"id": "x"}])

    def test_complete_cursor_read(self):
        fake = FakeMCP([{"results": [{"id": "a"}], "next_page_results": True, "next_cursor": "next"},
                        {"results": [{"id": "b"}], "next_page_results": False}])
        rows, count = asyncio.run(pages(fake, "workitem", {"action": "list"}))
        self.assertEqual([row["id"] for row in rows], ["a", "b"])
        self.assertEqual(count, 2)
        self.assertEqual(fake.calls[1][1]["cursor"], "next")

    def test_duplicate_rows_fail(self):
        fake = FakeMCP([{"results": [{"id": "a"}, {"id": "a"}], "next_page_results": False}])
        with self.assertRaises(VerificationError):
            asyncio.run(pages(fake, "workitem", {}))

    def test_missing_cursor_fails(self):
        fake = FakeMCP([{"results": [{"id": "a"}], "next_page_results": True}])
        with self.assertRaises(VerificationError):
            asyncio.run(pages(fake, "workitem", {}))

    def test_missing_pagination_is_not_all_tasks(self):
        fake = FakeMCP([{"results": [{"id": "a"}]}])
        with self.assertRaises(VerificationError):
            asyncio.run(pages(fake, "workitem", {}))


class CommentOnceTests(unittest.TestCase):
    def test_existing_marker_is_reused_without_a_write(self):
        fake = FakeComments([{"id": "existing-comment", "comment_html": "<p>" + COMMENT_MARKER + "</p>"}])
        with tempfile.TemporaryDirectory(dir=TEMP_ROOT) as folder:
            journal = Path(folder) / "comment-journal.json"
            # A visible marker also reconciles an interrupted earlier attempt.
            journal.write_text(json.dumps({"pending": True}), encoding="utf-8")
            observed = asyncio.run(comment_once(fake, "project-1", "task-1", "new report", journal))
            saved = json.loads(journal.read_text(encoding="utf-8"))
        self.assertEqual(observed, {"id": "existing-comment", "reused": True, "read_back": True})
        self.assertEqual([args["action"] for _, args in fake.calls], ["list"])
        self.assertEqual(saved, {"project_id": "project-1", "workitem_id": "task-1", "pending": False,
                                 "comment_id": "existing-comment"})

    def test_first_write_has_durable_pending_journal_and_matching_readback(self):
        with tempfile.TemporaryDirectory(dir=TEMP_ROOT) as folder:
            journal = Path(folder) / "nested" / "comment-journal.json"
            checked = []

            def before_create(args):
                # This callback runs at the POST boundary, before the fake writes.
                self.assertTrue(journal.is_file())
                self.assertEqual(json.loads(journal.read_text(encoding="utf-8")),
                                 {"project_id": "project-1", "workitem_id": "task-1", "pending": True})
                checked.append(dict(args))

            fake = FakeComments(before_create=before_create)
            observed = asyncio.run(comment_once(fake, "project-1", "task-1", "A < B\nNext & final", journal))
            saved = json.loads(journal.read_text(encoding="utf-8"))
            again = asyncio.run(comment_once(fake, "project-1", "task-1", "different report", journal))
        self.assertEqual(observed, {"id": "new-comment", "reused": False, "read_back": True})
        self.assertEqual(again, {"id": "new-comment", "reused": True, "read_back": True})
        self.assertEqual([args["action"] for _, args in fake.calls], ["list", "create", "list", "list"])
        self.assertEqual(len(checked), 1)
        self.assertEqual(checked[0]["project_id"], "project-1")
        self.assertEqual(checked[0]["workitem_id"], "task-1")
        self.assertEqual(checked[0]["comment_html"],
                         "<p>" + COMMENT_MARKER + "</p><p>A &lt; B<br>Next &amp; final</p>")
        self.assertEqual(saved, {"project_id": "project-1", "workitem_id": "task-1", "pending": False,
                                 "comment_id": "new-comment"})

    def test_timed_out_post_stays_pending_and_invisible_comment_is_not_retried(self):
        fake = FakeComments(create_error=TimeoutError("simulated timeout"))
        with tempfile.TemporaryDirectory(dir=TEMP_ROOT) as folder:
            journal = Path(folder) / "comment-journal.json"
            with self.assertRaises(TimeoutError):
                asyncio.run(comment_once(fake, "project-1", "task-1", "report", journal))
            self.assertEqual(json.loads(journal.read_text(encoding="utf-8")),
                             {"project_id": "project-1", "workitem_id": "task-1", "pending": True})
            with self.assertRaisesRegex(VerificationError, "Do not blindly retry"):
                asyncio.run(comment_once(fake, "project-1", "task-1", "report", journal))
            self.assertTrue(json.loads(journal.read_text(encoding="utf-8"))["pending"])
        self.assertEqual([args["action"] for _, args in fake.calls], ["list", "create", "list"])
        self.assertEqual(fake.comments, [])

    def test_multiple_markers_stop_before_any_write_or_journal(self):
        fake = FakeComments([{"id": "comment-1", "comment_html": COMMENT_MARKER},
                             {"id": "comment-2", "comment_html": "<p>" + COMMENT_MARKER + "</p>"}])
        with tempfile.TemporaryDirectory(dir=TEMP_ROOT) as folder:
            journal = Path(folder) / "comment-journal.json"
            with self.assertRaisesRegex(VerificationError, "Multiple demo comments"):
                asyncio.run(comment_once(fake, "project-1", "task-1", "report", journal))
            self.assertFalse(journal.exists())
        self.assertEqual([args["action"] for _, args in fake.calls], ["list"])

    def test_mismatched_readback_keeps_pending_journal(self):
        fake = FakeMCP([[], {"id": "created-comment"},
                        [{"id": "different-comment", "comment_html": COMMENT_MARKER}]])
        with tempfile.TemporaryDirectory(dir=TEMP_ROOT) as folder:
            journal = Path(folder) / "comment-journal.json"
            with self.assertRaisesRegex(VerificationError, "readback did not match"):
                asyncio.run(comment_once(fake, "project-1", "task-1", "report", journal))
            self.assertTrue(json.loads(journal.read_text(encoding="utf-8"))["pending"])
        self.assertEqual([args["action"] for _, args in fake.calls], ["list", "create", "list"])


class ReportTests(unittest.TestCase):
    def test_successful_mcp_verified_json_returns_report(self):
        with tempfile.TemporaryDirectory(dir=TEMP_ROOT) as folder:
            report = Path(folder) / "run-read.json"
            report.write_text(json.dumps({"ok": True, "mcp_verified": True, "report": "  进展总结\n "},
                                         ensure_ascii=False), encoding="utf-8")
            self.assertEqual(read_report(report), "进展总结")

    def test_unsuccessful_or_unverified_json_is_rejected(self):
        cases = (
            {"ok": False, "mcp_verified": True, "report": "report"},
            {"ok": True, "mcp_verified": False, "report": "report"},
            {"ok": True, "report": "report"},
            {"mcp_verified": True, "report": "report"},
            {"ok": "true", "mcp_verified": True, "report": "report"},
            [{"ok": True, "mcp_verified": True, "report": "report"}],
        )
        with tempfile.TemporaryDirectory(dir=TEMP_ROOT) as folder:
            report = Path(folder) / "run-read.json"
            for evidence in cases:
                with self.subTest(evidence=evidence):
                    report.write_text(json.dumps(evidence), encoding="utf-8")
                    with self.assertRaisesRegex(VerificationError, "successful, MCP-verified"):
                        read_report(report)

    def test_verified_json_still_requires_nonempty_bounded_report(self):
        with tempfile.TemporaryDirectory(dir=TEMP_ROOT) as folder:
            report = Path(folder) / "run-read.json"
            for value in (None, "", " \n", "x" * 30_001):
                with self.subTest(report_type=type(value).__name__):
                    report.write_text(json.dumps({"ok": True, "mcp_verified": True, "report": value}), encoding="utf-8")
                    with self.assertRaisesRegex(VerificationError, "1..30000"):
                        read_report(report)


if __name__ == "__main__":
    unittest.main()
