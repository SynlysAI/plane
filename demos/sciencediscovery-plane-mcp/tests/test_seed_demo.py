"""Meaningful offline coverage: API pagination, ownership, and ambiguous writes."""

from __future__ import annotations

import copy
import json
import sys
import tempfile
import unittest
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from plane_client import PlaneClient, PlaneConfig, PlaneError, load_config
from seed_demo import OWNERSHIP_MARKER, PROJECT_IDENTIFIER, PROJECT_NAME, SeedError, SeedRunner, TASKS, task_marker, write_manifest


class FakePlane:
    def __init__(self) -> None:
        self.projects: list[dict] = []
        self.items: list[dict] = []
        self.states = [{"id": "s-" + group, "group": group} for group in ("completed", "started", "unstarted")]
        self.calls: list[tuple[str, str, dict | None]] = []
        self.timeout_kind: str | None = None
        self.commit_before_timeout = False
        self.page_size = 2

    @property
    def writes(self) -> list[tuple[str, str, dict | None]]:
        return [call for call in self.calls if call[0] != "GET"]

    @staticmethod
    def response(value: object, status: int = 200) -> tuple[int, bytes]:
        return status, json.dumps(value, ensure_ascii=False).encode()

    def __call__(self, method: str, url: str, headers: dict, body: bytes | None, timeout: float) -> tuple[int, bytes]:
        assert headers["X-Api-Key"] == "test-secret-never-log"
        assert timeout == 3.0
        parsed = urlsplit(url)
        payload = json.loads(body) if body else None
        self.calls.append((method, url, payload))
        route = parsed.path.split("/workspaces/lab/", 1)[1]
        if method == "GET":
            if route in {"projects/", "projects-lite/"}:
                resources = self.projects
            elif route.endswith("/states/"):
                resources = self.states
            elif route.endswith("/work-items/"):
                resources = self.items
            elif route == "projects/p1/":
                return self.response(self.projects[0])
            else:
                raise AssertionError("Unexpected fake GET route")
            cursor = parse_qs(parsed.query).get("cursor", ["0"])[0]
            offset = int(cursor)
            page = resources[offset:offset + self.page_size]
            return self.response({
                "results": page, "next_page_results": offset + self.page_size < len(resources),
                "next_cursor": str(offset + self.page_size),
            })
        assert method == "POST"
        kind = "project" if route == "projects/" else "work_item"
        record = {"id": "p1" if kind == "project" else "i" + str(len(self.items) + 1), **payload}
        if kind == "work_item":
            record["sequence_id"] = len(self.items) + 1
        target = self.projects if kind == "project" else self.items
        if self.timeout_kind == kind:
            self.timeout_kind = None
            if self.commit_before_timeout:
                target.append(copy.deepcopy(record))
            raise TimeoutError("test-secret-never-log raw response or network failure")
        target.append(copy.deepcopy(record))
        return self.response(record, 201)


class SeedTests(unittest.TestCase):
    def setUp(self) -> None:
        self.backend = FakePlane()
        self.client = PlaneClient(PlaneConfig("http://plane.test", "lab", "test-secret-never-log", timeout=3.0), transport=self.backend)
        self.saved: dict | None = None

    def save(self, data: dict) -> None:
        self.saved = copy.deepcopy(data)

    def runner(self) -> SeedRunner:
        return SeedRunner(self.client, manifest=self.saved, save_manifest=self.save)

    def test_seed_reuses_four_tasks_and_check_is_read_only(self) -> None:
        manifest = self.runner().run("seed")
        self.assertEqual(len(self.backend.writes), 5)
        self.assertEqual([item["state_group"] for item in manifest["work_items"]], ["completed", "completed", "started", "unstarted"])
        self.assertNotIn("test-secret", json.dumps(manifest))
        self.assertNotIn("pending_write", manifest)
        repeated = self.runner().run("seed")
        self.assertEqual(manifest["work_items"], repeated["work_items"])
        self.runner().run("check")
        self.assertEqual(len(self.backend.writes), 5)
        self.assertTrue(any("cursor=2" in url and "/work-items/" in url for _, url, _ in self.backend.calls))

    def test_read_only_check_does_not_create_missing_project(self) -> None:
        with self.assertRaises(SeedError):
            self.runner().run("check")
        self.assertEqual(self.backend.writes, [])

    def test_unmarked_project_is_never_adopted(self) -> None:
        self.backend.projects = [{"id": "p1", "name": PROJECT_NAME, "identifier": PROJECT_IDENTIFIER, "description": "User business project"}]
        with self.assertRaisesRegex(SeedError, "unmarked"):
            self.runner().run("seed")
        self.assertEqual(self.backend.writes, [])
        with self.assertRaisesRegex(SeedError, "unmarked"):
            self.runner().run("seed", project_id="p1")

    def test_identifier_collision_is_never_adopted(self) -> None:
        self.backend.projects = [{"id": "p1", "name": "Other", "identifier": PROJECT_IDENTIFIER, "description": ""}]
        with self.assertRaises(SeedError):
            self.runner().run("seed")
        self.assertEqual(self.backend.writes, [])

    def test_unowned_same_name_task_fails_before_missing_task_writes(self) -> None:
        self.runner().run("seed")
        self.backend.items = [{"id": "business", "name": TASKS[0]["name"], "state": "s-completed", "description_html": "business"}]
        self.backend.calls.clear()
        with self.assertRaises(SeedError):
            self.runner().run("seed")
        self.assertEqual(self.backend.writes, [])

    def test_missing_state_group_fails_before_creating_any_task(self) -> None:
        self.backend.states = self.backend.states[:2]
        with self.assertRaisesRegex(SeedError, "unstarted"):
            self.runner().run("seed")
        self.assertEqual(len(self.backend.projects), 1)
        self.assertEqual(len(self.backend.items), 0)
        self.backend.states.append({"id": "s-unstarted", "group": "unstarted"})
        self.runner().run("seed")
        self.assertEqual(len(self.backend.projects), 1)
        self.assertEqual(len(self.backend.items), 4)

    def test_project_committed_before_timeout_is_recovered(self) -> None:
        self.backend.timeout_kind = "project"
        self.backend.commit_before_timeout = True
        with self.assertRaises(PlaneError) as raised:
            self.runner().run("seed")
        self.assertTrue(raised.exception.write_outcome_unknown)
        self.assertNotIn("test-secret", str(raised.exception))
        self.assertEqual(self.saved["pending_write"]["kind"], "project")
        self.runner().run("seed")
        self.assertEqual(len(self.backend.projects), 1)
        self.assertEqual(len(self.backend.items), 4)
        self.assertEqual(len(self.backend.writes), 5)

    def test_absent_project_after_timeout_is_not_recreated(self) -> None:
        self.backend.timeout_kind = "project"
        with self.assertRaises(PlaneError):
            self.runner().run("seed")
        with self.assertRaisesRegex(SeedError, "still unknown"):
            self.runner().run("seed")
        self.assertEqual(len(self.backend.writes), 1)
        self.assertEqual(self.backend.projects, [])

    def test_task_committed_before_timeout_is_recovered(self) -> None:
        self.backend.timeout_kind = "work_item"
        self.backend.commit_before_timeout = True
        with self.assertRaises(PlaneError):
            self.runner().run("seed")
        self.assertEqual(self.saved["pending_write"]["key"], "literature")
        self.runner().run("seed")
        self.assertEqual(len(self.backend.items), 4)
        self.assertEqual(len(self.backend.writes), 5)

    def test_absent_task_after_timeout_blocks_further_writes(self) -> None:
        self.backend.timeout_kind = "work_item"
        with self.assertRaises(PlaneError):
            self.runner().run("seed")
        with self.assertRaisesRegex(SeedError, "still unknown"):
            self.runner().run("seed")
        self.assertEqual(len(self.backend.writes), 2)

    def test_partial_run_recovers_by_markers_without_old_manifest(self) -> None:
        self.runner().run("seed")
        self.backend.items = self.backend.items[:2]
        self.saved = None
        self.backend.calls.clear()
        self.runner().run("seed")
        self.assertEqual(len(self.backend.writes), 2)
        self.assertEqual(len(self.backend.items), 4)

    def test_duplicate_marked_task_is_rejected(self) -> None:
        self.runner().run("seed")
        self.backend.items.append({**self.backend.items[0], "id": "duplicate"})
        self.backend.calls.clear()
        with self.assertRaisesRegex(SeedError, "Duplicate"):
            self.runner().run("seed")
        self.assertEqual(self.backend.writes, [])

    def test_changed_task_state_is_not_overwritten(self) -> None:
        self.runner().run("seed")
        self.backend.items[0]["state"] = "s-started"
        self.backend.calls.clear()
        with self.assertRaises(SeedError):
            self.runner().run("seed")
        self.assertEqual(self.backend.writes, [])

    def test_journal_must_be_persisted_before_first_post(self) -> None:
        def failed_save(data: dict) -> None:
            raise SeedError("disk full")
        with self.assertRaisesRegex(SeedError, "disk full"):
            SeedRunner(self.client, save_manifest=failed_save).run("seed")
        self.assertEqual(self.backend.writes, [])

    def test_manifest_cannot_be_reused_for_different_origin(self) -> None:
        self.runner().run("seed")
        self.saved["plane_base_url"] = "http://other.test"
        with self.assertRaises(SeedError):
            self.runner()


class ClientTests(unittest.TestCase):
    def config(self) -> PlaneConfig:
        return PlaneConfig("https://plane.test/", "lab", "test-secret-never-log", timeout=3.0)

    def test_consumes_all_pages_and_preserves_query(self) -> None:
        calls = []
        def transport(method, url, headers, body, timeout):
            calls.append(url)
            page = len(calls)
            return FakePlane.response({"results": [{"id": str(page)}], "next_page_results": page < 3, "next_cursor": str(page)})
        client = PlaneClient(self.config(), transport=transport)
        result = client.list_all(client.workspace_path + "projects/", query={"order_by": "name"})
        self.assertEqual([row["id"] for row in result], ["1", "2", "3"])
        self.assertTrue(all("order_by=name" in url for url in calls))

    def test_repeated_cursor_fails_instead_of_looping(self) -> None:
        counter = 0
        def transport(*args):
            nonlocal counter
            counter += 1
            return FakePlane.response({"results": [{"id": str(counter)}], "next_page_results": True, "next_cursor": "same"})
        client = PlaneClient(self.config(), transport=transport)
        with self.assertRaisesRegex(PlaneError, "repeated"):
            client.list_projects()
        self.assertEqual(counter, 2)

    def test_missing_pagination_metadata_fails_closed(self) -> None:
        client = PlaneClient(self.config(), transport=lambda *args: FakePlane.response({"results": [{"id": "1"}], "next_cursor": "cursor"}))
        with self.assertRaisesRegex(PlaneError, "metadata"):
            client.list_projects()

    def test_repeated_resource_across_pages_fails(self) -> None:
        client = PlaneClient(self.config(), transport=lambda *args: FakePlane.response({"results": [{"id": "same"}], "next_page_results": True, "next_cursor": "cursor"}))
        with self.assertRaisesRegex(PlaneError, "repeated a resource"):
            client.list_projects()

    def test_http_error_body_and_secrets_are_never_reported(self) -> None:
        client = PlaneClient(self.config(), transport=lambda *args: (500, b'test-secret-never-log private body'))
        with self.assertRaises(PlaneError) as raised:
            client.create_project({"name": "Demo"})
        self.assertIn("HTTP 500", str(raised.exception))
        self.assertNotIn("test-secret", str(raised.exception))
        self.assertNotIn("private body", str(raised.exception))
        self.assertTrue(raised.exception.write_outcome_unknown)

    def test_invalid_json_write_is_uncertain(self) -> None:
        client = PlaneClient(self.config(), transport=lambda *args: (201, b"<html>test-secret-never-log</html>"))
        with self.assertRaises(PlaneError) as raised:
            client.create_project({})
        self.assertTrue(raised.exception.write_outcome_unknown)
        self.assertNotIn("test-secret", str(raised.exception))

    def test_configuration_env_overrides_private_json(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "private.json"
            path.write_text(json.dumps({"PLANE_BASE_URL": "https://plane.test", "PLANE_WORKSPACE_SLUG": "old", "PLANE_API_KEY": "private-key"}), encoding="utf-8")
            cfg = load_config(path, environ={"PLANE_WORKSPACE_SLUG": "new"})
            self.assertEqual(cfg.workspace_slug, "new")
            self.assertEqual(cfg.api_key, "private-key")
            self.assertNotIn("private-key", repr(cfg))

    def test_invalid_config_never_echoes_url_credentials(self) -> None:
        with self.assertRaises(PlaneError) as raised:
            PlaneConfig("https://user:secret@plane.test", "lab", "key")
        self.assertNotIn("secret", str(raised.exception))

    def test_manifest_atomic_round_trip_contains_no_credentials(self) -> None:
        # Atomic rename is allowed in the workspace; managed Windows sandboxes
        # can deny os.replace in the OS-level shared temporary directory.
        with tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parents[1]) as folder:
            path = Path(folder) / "nested" / "manifest.json"
            write_manifest(path, {"project": {"id": "p1"}})
            self.assertEqual(json.loads(path.read_text()), {"project": {"id": "p1"}})
            self.assertFalse(path.with_suffix(".json.tmp").exists())


if __name__ == "__main__":
    unittest.main()
