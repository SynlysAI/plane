"""Human-only workspace choices for the unified connection page."""
# ruff: noqa: F811, F401

import pytest
from rest_framework.test import APIClient

from plane.db import models as db
from plane.tests.contract.app.test_unified_mcp import env, machine, unified, issued, payload, MANAGEMENT
from plane.tests.research_fixtures import make_workspace

pytestmark = [pytest.mark.contract, pytest.mark.django_db]
OPTIONS = MANAGEMENT + "options/"


def test_options_use_current_native_scope_policy_and_do_not_mint_credentials(unified, settings):
    e = unified
    page = e["owner_client"].get(OPTIONS).json()
    assert page["csrf_token"] and page["ttl_seconds"] > 0 and page["max_workspaces"] == 20
    assert page["write_requires_future_objects"] is True
    assert page["results"] == [
        {
            "id": str(e["workspace"].pk),
            "slug": e["workspace"].slug,
            "name": e["workspace"].name,
            "domains": {"administrative": ["read", "read_write"], "research": ["read"]},
        }
    ]
    settings.RESEARCH_MCP_WRITE_ENABLED = True
    db.WorkspaceResearchSetting.objects.filter(workspace=e["workspace"]).update(research_mcp_write_enabled=True)
    assert e["owner_client"].get(OPTIONS).json()["results"][0]["domains"]["research"] == ["read", "read_write"]
    settings.RESEARCH_MCP_ENABLED = False
    assert "research" not in e["owner_client"].get(OPTIONS).json()["results"][0]["domains"]
    assert not db.UnifiedMCPConnection.objects.exists() and not db.ResearchContextGrant.objects.exists()


def test_options_page_complete_owner_bound_and_private_workspace_filtered(unified):
    e = unified
    for index in range(2):
        make_workspace(e["owner"], name=f"Extra {index}")
    private = make_workspace(e["owner"], name="Private seat")
    db.WorkspaceResearchSetting.objects.create(workspace=private, purpose="PI_PRIVATE", main_pi=e["collaborator"])
    seen, cursor = [], None
    while True:
        response = e["owner_client"].get(OPTIONS, {"limit": 1, **({"cursor": cursor} if cursor else {})})
        assert response.status_code == 200, response.data
        page = response.json()
        seen += [row["id"] for row in page["results"]]
        cursor = page["next_cursor"]
        if not cursor:
            break
        assert e["collaborator_client"].get(OPTIONS, {"cursor": cursor}).status_code == 400
    assert len(seen) == 3 and str(private.pk) not in seen
    db.WorkspaceMember.objects.filter(workspace=e["workspace"], member=e["owner"]).update(is_active=False)
    assert str(e["workspace"].pk) not in {row["id"] for row in e["owner_client"].get(OPTIONS).json()["results"]}


def test_options_are_session_only_and_reject_unbounded_or_unknown_inputs(unified):
    e = unified
    _, bearer = issued(e)
    assert bearer.get(OPTIONS).status_code in (401, 403)
    assert APIClient().get(OPTIONS).status_code in (401, 403)
    for args in (
        {"limit": 0},
        {"limit": 51},
        {"limit": "bad"},
        {"cursor": "tampered"},
        {"owner_id": str(e["owner"].pk)},
    ):
        assert e["owner_client"].get(OPTIONS, args).status_code == 400
    assert e["owner_client"].post(OPTIONS, {}, format="json").status_code == 405


def test_options_do_not_replace_write_time_authorization(unified):
    e = unified
    assert e["owner_client"].get(OPTIONS).status_code == 200
    db.WorkspaceMember.objects.filter(workspace=e["workspace"], member=e["owner"]).update(is_active=False)
    response = e["owner_client"].post(MANAGEMENT, payload(e), format="json")
    assert response.status_code == 403
    assert not db.UnifiedMCPConnection.objects.exists()
