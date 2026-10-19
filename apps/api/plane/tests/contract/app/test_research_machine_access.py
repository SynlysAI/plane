"""Machine credentials, node scope, pagination and actual node content reads.

These tests are provided for the repository's authorised backend test environment;
they were not executed as part of the implementation request.
"""

from datetime import timedelta
from uuid import uuid4

import pytest
from django.utils import timezone
from rest_framework.test import APIClient

from plane.db.models import (
    APIToken, ExperimentRecord, ResearchAnalysisResult, ResearchChain,
    ResearchChainEvent, ResearchChainNode, ResearchChainNodeTask, ResearchTaskComment,
)
from plane.research.services.context_tokens import issue_context_token
from plane.research.services.mcp_catalog import TOOL_NAMES
from plane.tests.contract.app.test_research_chain_mvp import env  # noqa: F401

pytestmark = pytest.mark.contract


@pytest.fixture
def machine(env, settings):
    settings.RESEARCH_MCP_ENABLED = True
    chain = ResearchChain.objects.create(workspace=env["workspace"], project=env["private_project"],
        owner=env["owner"], visibility="PRIVATE", request_id=uuid4().hex, payload_hash="a" * 64)
    node = ResearchChainNode.objects.create(chain=chain, node_type="ANALYSIS", title="Read this analysis",
        request_id=uuid4().hex, payload_hash="a" * 64)
    other = ResearchChainNode.objects.create(chain=chain, node_type="EXPERIMENT", title="Other node",
        request_id=uuid4().hex, payload_hash="b" * 64)
    token = APIToken.objects.create(user=env["owner"], workspace=env["workspace"])
    api = APIClient()
    api.credentials(HTTP_X_API_KEY=token.token)
    return {**env, "chain": chain, "node": node, "other": other, "token": token, "api": api,
            "root": f"/api/research/workspaces/{env['workspace'].slug}/agent-access/"}


def invoke(machine, name, arguments, client=None):
    return (client or machine["api"]).post(machine["root"] + f"tools/{name}/", arguments, format="json")


def scoped_client(machine):
    grant, raw = issue_context_token(workspace=machine["workspace"], user=machine["owner"],
        profile=machine["private_profile"], chain_node=machine["node"], request_id=uuid4().hex,
        allowed_tools=sorted(TOOL_NAMES), policy_version="research-mcp.read.v1")
    api = APIClient()
    api.credentials(HTTP_X_RESEARCH_CONTEXT_TOKEN=raw, HTTP_X_RESEARCH_CONTEXT_HASH=grant.context_hash)
    return api, grant, raw


def event(machine, **values):
    return ResearchChainEvent.objects.create(chain=machine["chain"], node=machine["node"],
        event_id=uuid4().hex, request_id=uuid4().hex, occurred_at=timezone.now(),
        event_type="OUTPUT", summary="An observed result", **values)


def test_personal_api_key_discovers_ten_read_only_tools_without_session(machine):
    response = machine["api"].get(machine["root"] + "tools/")
    assert response.status_code == 200
    assert {tool["name"] for tool in response.json()["tools"]} == TOOL_NAMES
    assert response["Cache-Control"] == "no-store"
    assert invoke(machine, "get_research_chain", {"chain_id": str(machine["chain"].id)}).status_code == 200
    assert invoke(machine, "delete_node", {"node_id": str(machine["node"].id)}).status_code == 400


def test_workspace_bound_key_cannot_use_another_workspace(machine):
    from plane.tests.research_fixtures import make_workspace

    other = make_workspace(machine["owner"], name="Other workspace")
    machine["token"].workspace = other
    machine["token"].save(update_fields=["workspace"])
    assert machine["api"].get(machine["root"] + "tools/").status_code == 404


def test_node_grant_filters_chain_counts_and_denies_sibling_reads(machine):
    api, grant, _ = scoped_client(machine)
    response = invoke(machine, "list_research_nodes", {"chain_id": str(machine["chain"].id)}, api)
    assert response.status_code == 200
    assert [node["id"] for node in response.json()["data"]] == [str(machine["node"].id)]
    response = invoke(machine, "get_research_chain", {"chain_id": str(machine["chain"].id)}, api)
    assert response.json()["data"]["node_count_in_scope"] == 1
    assert invoke(machine, "get_research_node_context", {"node_id": str(machine["other"].id)}, api).status_code == 404
    grant.revoked_at = timezone.now()
    grant.save(update_fields=["revoked_at"])
    assert invoke(machine, "get_research_node_context", {"node_id": str(machine["node"].id)}, api).status_code == 401


def test_invalid_context_does_not_fall_back_to_valid_api_key(machine):
    api, grant, raw = scoped_client(machine)
    grant.expires_at = timezone.now() - timedelta(seconds=1)
    grant.save(update_fields=["expires_at"])
    api.credentials(HTTP_X_API_KEY=machine["token"].token, HTTP_X_RESEARCH_CONTEXT_TOKEN=raw,
                    HTTP_X_RESEARCH_CONTEXT_HASH=grant.context_hash)
    assert api.get(machine["root"] + "tools/").status_code == 401


def test_events_beyond_500_remain_reachable_without_duplicates(machine):
    ResearchChainEvent.objects.bulk_create([
        ResearchChainEvent(chain=machine["chain"], node=machine["node"], event_id=uuid4().hex,
            request_id=uuid4().hex, occurred_at=timezone.now(), event_type="OUTPUT", summary=f"Result {i}")
        for i in range(503)
    ])
    args = {"node_id": str(machine["node"].id), "limit": 50}
    seen = []
    while True:
        response = invoke(machine, "list_research_node_events", args)
        assert response.status_code == 200
        value = response.json()
        seen.extend(item["event_id"] for item in value["data"])
        if not value["page"]["has_more"]:
            break
        args["cursor"] = value["page"]["next_cursor"]
    assert len(seen) == len(set(seen)) == 503


def test_cursor_cannot_be_reused_for_another_node(machine):
    event(machine)
    event(machine)
    result = invoke(machine, "list_research_node_events", {"node_id": str(machine["node"].id), "limit": 1}).json()
    response = invoke(machine, "list_research_node_events", {"node_id": str(machine["other"].id),
        "limit": 1, "cursor": result["page"]["next_cursor"]})
    assert response.status_code == 400


def test_experiment_requires_real_node_reference_even_for_project_owner(machine):
    record = ExperimentRecord.objects.create(workspace=machine["workspace"], project=machine["private_project"],
        owner=machine["owner"], sequence_no=1, title="Measured experiment", result="Measured value: 88")
    args = {"node_id": str(machine["node"].id), "kind": "experiment", "resource_id": str(record.id)}
    assert invoke(machine, "read_research_resource", args).status_code == 404
    event(machine, refs=[{"kind": "experiment", "id": str(record.id)}])
    response = invoke(machine, "read_research_resource", args)
    assert response.status_code == 200
    assert "Measured value: 88" in response.json()["data"]["text"]


def test_comment_tool_reads_research_comments_without_issuing_native_comments(machine):
    task = ResearchChainNodeTask.objects.create(workspace=machine["workspace"], chain=machine["chain"],
        node=machine["node"], title="Repeat measurement", request_id=uuid4().hex, payload_hash="a" * 64)
    ResearchTaskComment.objects.create(task=task, actor=machine["owner"], comment_html="<p>Use three replicates</p>",
        comment_stripped="Use three replicates", request_id=uuid4().hex)
    response = invoke(machine, "list_research_task_comments", {"task_id": str(task.id)})
    assert response.status_code == 200
    assert response.json()["data"][0]["text"] == "Use three replicates"


@pytest.mark.parametrize("replacement", ["New observation " * 200, "Short changed body"])
def test_chunk_cursor_detects_analysis_changes(machine, replacement):
    result = ResearchAnalysisResult.objects.create(workspace=machine["workspace"], chain=machine["chain"],
        node=machine["node"], method="comparison", summary="Long observation " * 200,
        request_id=uuid4().hex, payload_hash="a" * 64)
    args = {"node_id": str(machine["node"].id), "kind": "analysis", "resource_id": str(result.id), "max_chars": 256}
    first = invoke(machine, "read_research_resource", args)
    assert first.status_code == 200
    result.summary = replacement
    result.save(update_fields=["summary"])
    args["cursor"] = first.json()["page"]["next_cursor"]
    assert invoke(machine, "read_research_resource", args).status_code == 409


def test_direct_mcp_discovery_and_calls_use_the_same_scope(machine, settings):
    api, _, _ = scoped_client(machine)
    url = machine["root"] + "mcp/"
    response = api.post(url, {"jsonrpc": "2.0", "id": 1, "method": "tools/list"}, format="json")
    assert response.status_code == 200
    assert len(response.json()["result"]["tools"]) == 10
    response = api.post(url, {"jsonrpc": "2.0", "id": 2, "method": "tools/call",
        "params": {"name": "get_research_node_context", "arguments": {"node_id": str(machine["other"].id)}}}, format="json")
    assert response.json()["result"]["isError"] is True
    settings.RESEARCH_MCP_ENABLED = False
    assert api.post(url, {"jsonrpc": "2.0", "id": 3, "method": "ping"}, format="json").status_code == 404
