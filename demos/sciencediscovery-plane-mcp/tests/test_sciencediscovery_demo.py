"""Offline behavior tests; no Plane/ScienceDiscovery data or credentials needed."""

import copy
from io import BytesIO
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch
from urllib.error import HTTPError

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import sciencediscovery_demo as demo

TEMP_ROOT = Path(__file__).resolve().parents[1]

MANIFEST = {"schema_version": 1, "workspace_slug": "test-workspace",
            "project": {"id": "project-1", "name": "Demo", "identifier": "SDMCP"},
            "work_items": [{"id": "item-1", "name": "Literature", "key": "literature"},
                           {"id": "item-2", "name": "Analysis", "key": "analysis"}]}
STATE = {"schema_version": 1, "workspace_slug": "test-workspace", "plane_project_id": "project-1",
         "server_id": "custom-123456789abc", "source_id": "custom-123456789abc",
         "science_project_id": "science-project", "inspector_session_id": "inspector-session"}
CONFIG = {"SCIENCEDISCOVERY_BASE_URL": "http://127.0.0.1:14310", "SCIENCE_AGENT_AUTH_TOKEN": "fake-sd-token",
          "PLANE_BASE_URL": "http://127.0.0.1:8001", "PLANE_MCP_BASE_URL": "http://plane-api:8000",
          "PLANE_WORKSPACE_SLUG": "test-workspace", "PLANE_API_KEY": "fake-plane-key",
          "PLANE_MCP_PYTHON": "/app/data/plane-mcp-demo/.venv/bin/python",
          "PLANE_MCP_READ_ONLY_SCRIPT": "/app/data/plane-mcp-demo/read_only_mcp.py"}


def tool(name, actions=None):
    return {"name": name, "annotations": {"readOnlyHint": True}, "inputSchema": {
        "type": "object", "properties": {"action": {"enum": actions or ["list", "retrieve"]}}}}


SERVER = {"id": STATE["server_id"], "sourceId": STATE["source_id"],
          "name": demo.demo_names(MANIFEST)[0], "enabled": True,
          "tools": [tool("project"), tool("workitem"), tool("state", ["list"]), tool(demo.POLICY_TOOL)]}
POLICY = {"policy_version": "1", "read_only": True, "upstream": "plane-mcp-server==0.3.4",
          "allowed_actions": {"project": ["list", "retrieve"], "workitem": ["list", "retrieve"], "state": ["list"]}}


def mcp_result(value, invocation="inspect-1"):
    return {"ok": True, "invocationId": invocation, "durationMs": 4,
            "result": {"data": {"content": [{"type": "text", "text": json.dumps(value)}]}},
            "raw": {"isError": False}}


class FakeClient:
    def __init__(self, registered=True, finished=True):
        self.calls = []
        self.secrets = ["fake-sd-token", "fake-plane-key"]
        self.registered = registered
        self.finished = finished
        self.sessions = []
        self.policies = {"uniprot": "proxy:existing", "pubmed": "inherit"}

    def request(self, method, path, body=None):
        self.calls.append((method, path, copy.deepcopy(body)))
        if path == "/api/mcp/proxy-policies":
            if method == "PUT":
                self.policies = copy.deepcopy(body["policies"])
            return {"policies": copy.deepcopy(self.policies)}
        if path == "/api/mcp/servers":
            return [copy.deepcopy(SERVER)] if self.registered else []
        if path == "/api/mcp/servers/import":
            self.registered = True
            result = copy.deepcopy(SERVER)
            result["enabled"] = False
            return [result]
        if path.endswith("/test") or method == "PUT":
            return copy.deepcopy(SERVER)
        if path.endswith("/inspect"):
            name, args = body["toolName"], body["input"]
            if name == demo.POLICY_TOOL:
                return mcp_result(POLICY)
            if name == "state":
                return mcp_result({"results": [{"id": "state-1", "name": "Done", "group": "completed"}]})
            entity_id = args.get("workitem_id", args.get("project_id"))
            return mcp_result({"id": entity_id, "name": "Demo task", "state": "state-1",
                               "description_html": "<p>Wait for consistency check.</p>"})
        if path == "/api/projects":
            return [{"id": "science-project", "name": demo.demo_names(MANIFEST)[1]}]
        if path.endswith("/sessions?state=active"):
            return []
        if path.endswith("/sessions") and method == "POST":
            self.sessions.append(copy.deepcopy(body))
            return {"id": "new-session", "enabledConnectorIds": body["settingsOverrides"]["enabledConnectorIds"]}
        if method == "PATCH" and "/api/sessions/" in path:
            return {"id": path.rsplit("/", 1)[-1], **body}
        if path.endswith("/runs") and method == "POST":
            return {"id": "run-1", "status": "completed" if self.finished else "queued"}
        if path.endswith("/cancel"):
            return {"cancelled": True, "sessionId": "new-session", "runId": "run-1"}
        if path.endswith("/runs/run-1"):
            return {"id": "run-1", "status": "cancelled"}
        if path.endswith("/events?after=0"):
            events = [{"event": {"type": "run.completed", "message": {"content": "Project-management summary fake-plane-key"}}}]
            for index, name, args in [
                (0, "project", {"action": "retrieve", "project_id": "project-1"}),
                (1, "workitem", {"action": "retrieve", "project_id": "project-1", "workitem_id": "item-1"}),
                (2, "workitem", {"action": "retrieve", "project_id": "project-1", "workitem_id": "item-2"}),
            ]:
                events.append({"event": {"type": "tool.started", "trace": {"id": f"call-{index}", "name": name, "args": args}}})
            return events
        if path.endswith("/mcp/invocations"):
            return [{"id": f"audit-{index}", "sourceId": STATE["source_id"], "status": "succeeded",
                     "toolCallId": f"call-{index}", "mcpToolName": name}
                    for index, name in enumerate(["project", "workitem", "workitem"])]
        raise AssertionError((method, path, body))


class ConfigurationTests(unittest.TestCase):
    def test_private_config_and_environment_override(self):
        with tempfile.TemporaryDirectory(dir=TEMP_ROOT) as folder:
            file = Path(folder) / "private.json"
            file.write_text(json.dumps(CONFIG), encoding="utf-8")
            config = demo.load_config(file, {"PLANE_API_KEY": "override"})
            self.assertEqual(config["PLANE_API_KEY"], "override")
            self.assertEqual(config["SCIENCE_AGENT_AUTH_TOKEN"], "fake-sd-token")

    def test_requires_missing_token_without_printing_other_secrets(self):
        config = {**CONFIG, "SCIENCE_AGENT_AUTH_TOKEN": ""}
        with self.assertRaisesRegex(demo.DemoError, "Missing SCIENCE_AGENT_AUTH_TOKEN"):
            demo.ScienceClient(config)

    def test_default_mcp_python_uses_linux_scientific_volume(self):
        config = demo.load_config(None, {})
        self.assertEqual(config["PLANE_MCP_PYTHON"], "/app/data/scientific-envs/plane-mcp-demo/.venv/bin/python")

    def test_origin_disallows_credential_and_api_suffix(self):
        for url in ("http://user:secret@localhost", "http://localhost/api/v1", "file:///tmp", "http://localhost?key=x"):
            with self.subTest(url=url), self.assertRaises(demo.DemoError):
                demo.origin(url, "test URL")

    def test_http_failure_never_echoes_token_in_upstream_body(self):
        client = demo.ScienceClient(CONFIG)
        client.opener = Mock()
        client.opener.open.side_effect = HTTPError("http://localhost", 401, "Error", {}, BytesIO(b"fake-plane-key fake-sd-token"))
        with self.assertRaises(demo.DemoError) as captured:
            client.request("GET", "/api/projects")
        self.assertIn("401", str(captured.exception))
        self.assertNotIn("fake-", str(captured.exception))

    def test_redacts_keys_text_and_bearer_values(self):
        data = demo.redact({"api_key": "something-unknown", "nested": ["hello fake-plane-key", "Bearer unexpected-secret"]}, ["fake-plane-key"])
        self.assertEqual(data["api_key"], "[redacted]")
        self.assertNotIn("fake-plane-key", str(data))
        self.assertNotIn("unexpected-secret", str(data))

    def test_manifest_rejects_uncertain_write(self):
        with tempfile.TemporaryDirectory(dir=TEMP_ROOT) as folder:
            file = Path(folder) / "manifest.json"
            file.write_text(json.dumps({**MANIFEST, "pending_write": {"name": "uncertain"}}), encoding="utf-8")
            with self.assertRaisesRegex(demo.DemoError, "pending write"):
                demo.load_manifest(file)


class SafetyAndInspectorTests(unittest.TestCase):
    def test_project_description_fallback_and_expanded_state(self):
        entity = demo.safe_entity({"id": "item-1", "name": "Task", "description": "<p>Project overview</p>",
                                   "state": {"id": "state-1", "name": "Done", "group": "completed"}})
        self.assertEqual(entity["description"].strip(), "Project overview")
        self.assertEqual(entity["state"], "state-1")
        self.assertEqual(entity["state_id"], "state-1")
        self.assertEqual(entity["state_name"], "Done")
        self.assertEqual(entity["state_group"], "completed")

    def test_default_manifest_matches_seed_cli(self):
        parsed = demo.parser().parse_args(["verify"])
        self.assertEqual(parsed.manifest.name, "demo-manifest.json")

    def test_register_reuses_server_and_enables_session(self):
        client = FakeClient()
        state = demo.register(client, CONFIG, MANIFEST)
        self.assertEqual(state["source_id"], STATE["source_id"])
        self.assertFalse(any(path.endswith("/import") for _, path, _ in client.calls))
        update = next(body for method, path, body in client.calls if method == "PUT" and path != "/api/mcp/proxy-policies")
        self.assertTrue(update["enabled"])
        self.assertEqual(update["env"]["PLANE_BASE_URL"], "http://plane-api:8000")
        self.assertEqual(update["env"]["LOG_PAYLOADS"], "false")
        self.assertEqual(update["env"]["LOG_USER_INFO"], "false")
        self.assertNotIn("NO_PROXY", update["env"])
        self.assertNotIn("no_proxy", update["env"])
        self.assertEqual(update["args"], [CONFIG["PLANE_MCP_READ_ONLY_SCRIPT"]])
        patch_body = next(body for method, _, body in client.calls if method == "PATCH")
        self.assertEqual(patch_body, {"enabledConnectorIds": [STATE["source_id"]]})
        self.assertNotIn("fake-plane-key", json.dumps(state))

    def test_register_imports_disabled_then_enables(self):
        client = FakeClient(registered=False)
        demo.register(client, CONFIG, MANIFEST)
        imported = next(body for _, path, body in client.calls if path.endswith("/import"))
        self.assertFalse(next(iter(imported["mcpServers"].values()))["enabled"])
        self.assertTrue(any(method == "PUT" and body.get("enabled") for method, _, body in client.calls))

    def test_register_sets_only_demo_proxy_to_none_before_test(self):
        client = FakeClient()
        original = copy.deepcopy(client.policies)
        demo.register(client, CONFIG, MANIFEST)
        self.assertEqual(client.policies, {**original, STATE["server_id"]: "none"})
        policy_index = next(index for index, (method, path, _) in enumerate(client.calls)
                            if method == "PUT" and path == "/api/mcp/proxy-policies")
        test_index = next(index for index, (_, path, _) in enumerate(client.calls) if path.endswith("/test"))
        self.assertLess(policy_index, test_index)

    def test_missing_policy_response_is_an_error(self):
        client = Mock()
        client.request.return_value = {"unexpected": {}}
        with self.assertRaisesRegex(demo.DemoError, "proxy policies response"):
            demo.set_direct_proxy_policy(client, STATE["server_id"])

    def test_writing_tool_catalog_is_rejected(self):
        server = copy.deepcopy(SERVER)
        server["tools"][0]["inputSchema"]["properties"]["action"]["enum"].append("delete")
        with self.assertRaisesRegex(demo.DemoError, "read-only proxy"):
            demo.require_read_only_catalog(server)

    def test_comment_write_or_unrelated_tool_is_rejected(self):
        for extra in (tool("workitem_comment", ["list", "create"]), tool("shell", ["list"])):
            server = copy.deepcopy(SERVER)
            server["tools"].append(extra)
            with self.subTest(tool=extra["name"]), self.assertRaises(demo.DemoError):
                demo.require_read_only_catalog(server)

    def test_sciencediscovery_catalog_without_annotations_is_supported(self):
        server = copy.deepcopy(SERVER)
        for item in server["tools"]:
            item.pop("annotations", None)
            item["description"] = "Read-only demo tool"
            item["schemaHash"] = "example-hash"
        demo.require_read_only_catalog(server)
        server["tools"][1]["inputSchema"]["properties"]["action"]["enum"].append("create")
        with self.assertRaises(demo.DemoError):
            demo.require_read_only_catalog(server)

    def test_explicit_false_read_only_annotation_is_rejected(self):
        server = copy.deepcopy(SERVER)
        server["tools"][0]["annotations"]["readOnlyHint"] = False
        with self.assertRaises(demo.DemoError):
            demo.require_read_only_catalog(server)

    def test_http_200_inspector_failure_is_an_error(self):
        client = Mock()
        client.request.return_value = {"ok": False, "error": "fake-plane-key"}
        with self.assertRaises(demo.DemoError) as captured:
            demo.inspect(client, STATE, "workitem", {"action": "retrieve"})
        self.assertNotIn("fake-plane-key", str(captured.exception))

    def test_verify_uses_exact_ids_and_never_comment_writes(self):
        client = FakeClient()
        evidence = demo.verify(client, STATE, MANIFEST)
        reads = [body for _, path, body in client.calls if path.endswith("/inspect")]
        task_reads = [body["input"] for body in reads if body["toolName"] == "workitem"]
        self.assertEqual([item["workitem_id"] for item in task_reads], ["item-1", "item-2"])
        self.assertTrue(all(item["action"] == "retrieve" for item in task_reads))
        self.assertFalse(any(body["toolName"] == "workitem_comment" for body in reads))
        self.assertEqual(evidence["work_items"][0]["state_group"], "completed")
        self.assertFalse(evidence["plane_writes"])

    def test_manifest_mismatch_stops_before_network(self):
        client = FakeClient()
        with self.assertRaises(demo.DemoError):
            demo.verify(client, {**STATE, "plane_project_id": "another-project"}, MANIFEST)
        self.assertEqual(client.calls, [])


class RunTests(unittest.TestCase):
    def test_read_run_enables_only_proxy_and_requires_actual_mcp_coverage(self):
        client = FakeClient()
        with tempfile.TemporaryDirectory(dir=TEMP_ROOT) as folder:
            file = Path(folder) / "run.json"
            evidence = demo.run_analysis(client, CONFIG, STATE, MANIFEST, "run-read", 2, 0.1, file)
            saved = file.read_text(encoding="utf-8")
        self.assertEqual(client.sessions[0]["settingsOverrides"]["enabledConnectorIds"], [STATE["source_id"]])
        self.assertEqual(client.sessions[0]["settingsOverrides"]["enabledSkillLibraries"], [])
        self.assertEqual(client.sessions[0]["approvalMode"], "always_allow")
        self.assertTrue(evidence["mcp_verified"])
        self.assertEqual(len(evidence["model_mcp_calls"]), 3)
        self.assertNotIn("fake-plane-key", saved)
        self.assertFalse(any(body and body.get("toolName") == "workitem_comment" for _, _, body in client.calls))

    def test_snapshot_run_explicitly_disables_all_connectors(self):
        client = FakeClient()
        with tempfile.TemporaryDirectory(dir=TEMP_ROOT) as folder:
            evidence = demo.run_analysis(client, CONFIG, STATE, MANIFEST, "run-snapshot", 2, 0.1, Path(folder) / "run.json")
        self.assertEqual(client.sessions[0]["settingsOverrides"]["enabledConnectorIds"], [])
        self.assertTrue(evidence["mcp_verified"])
        prompt = next(body["content"] for _, path, body in client.calls if path.endswith("/runs"))
        self.assertIn("快照", prompt)

    def test_completed_run_without_all_requested_reads_is_not_success(self):
        client = FakeClient()
        original = client.request
        def request(method, path, body=None):
            value = original(method, path, body)
            return value[:2] if path.endswith("/mcp/invocations") else value
        client.request = request
        with tempfile.TemporaryDirectory(dir=TEMP_ROOT) as folder:
            file = Path(folder) / "run.json"
            with self.assertRaisesRegex(demo.DemoError, "MCP reads verified=False"):
                demo.run_analysis(client, CONFIG, STATE, MANIFEST, "run-read", 2, 0.1, file)
            self.assertFalse(json.loads(file.read_text(encoding="utf-8"))["ok"])

    def test_bounded_wait_cancels_the_owned_run_and_saves_ids(self):
        client = FakeClient(finished=False)
        with tempfile.TemporaryDirectory(dir=TEMP_ROOT) as folder, patch.object(demo.time, "monotonic", side_effect=[0, 2]):
            file = Path(folder) / "run.json"
            with self.assertRaises(demo.DemoError):
                demo.run_analysis(client, CONFIG, STATE, MANIFEST, "run-read", 1, 0.1, file)
            evidence = json.loads(file.read_text(encoding="utf-8"))
        self.assertTrue(evidence["timed_out"])
        self.assertEqual(evidence["run_id"], "run-1")
        self.assertTrue(any(path.endswith("/runs/run-1/cancel") for _, path, _ in client.calls))


if __name__ == "__main__":
    unittest.main()
