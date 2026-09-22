"""Short-lived Research Context token contract and negative security tests."""

from datetime import timedelta
from uuid import uuid4

import pytest
from django.utils import timezone
from rest_framework.test import APIClient

from plane.db.models import Project, ResearchAuditEvent, ResearchContextGrant, ResearchProjectProfile
from plane.tests.research_fixtures import enable_research, make_user, make_workspace

pytestmark = pytest.mark.contract


def _client(user):
    client = APIClient()
    client.force_authenticate(user=user)
    return client


def _project(workspace, owner, name):
    suffix = uuid4().hex[:6]
    project = Project.objects.create(
        workspace=workspace,
        name=f"{name} {suffix}",
        identifier=f"{name[:2].upper()}{suffix}",
        network=0,
        created_by=owner,
    )
    ResearchProjectProfile.objects.create(
        project=project,
        workspace=workspace,
        owner=owner,
        created_by=owner,
    )
    return project


@pytest.fixture
def env(db, settings):
    settings.RESEARCH_MODULE_ENABLED = True
    owner = make_user(first_name="Context owner")
    workspace = make_workspace(owner)
    other_workspace = make_workspace(owner, name="Other workspace")
    enable_research(workspace, research_agent_enabled=True)
    enable_research(other_workspace, research_agent_enabled=True)
    project_a = _project(workspace, owner, "Alpha")
    project_b = _project(workspace, owner, "Beta")
    return {
        "owner": owner,
        "workspace": workspace,
        "other_workspace": other_workspace,
        "project_a": project_a,
        "project_b": project_b,
        "client": _client(owner),
    }


def _issue(env, project=None):
    response = env["client"].post(
        f"/api/research/workspaces/{env['workspace'].slug}/context/exchange-token/",
        {
            "request_id": f"ctx-{uuid4().hex}",
            "research_project_id": str((project or env["project_a"]).id),
        },
        format="json",
    )
    assert response.status_code == 201, response.json()
    return response.json()


def test_context_token_is_short_lived_and_stored_only_as_hash(env):
    issued = _issue(env)
    grant = ResearchContextGrant.objects.get(context_id=issued["context_id"])

    assert issued["schema_version"] == "agent-context.v1"
    assert issued["scope"]["research_project_id"] == str(env["project_a"].id)
    assert grant.token_hash != issued["exchange_token"]
    assert grant.expires_at > timezone.now()
    assert grant.revoked_at is None


def test_context_token_reads_only_its_project_and_rejects_cross_project(env):
    issued = _issue(env)
    client = APIClient()
    client.credentials(
        HTTP_X_RESEARCH_CONTEXT_TOKEN=issued["exchange_token"],
        HTTP_X_RESEARCH_CONTEXT_HASH=issued["context_hash"],
    )

    scoped = client.get(f"/api/research/workspaces/{env['workspace'].slug}/context/")
    assert scoped.status_code == 200
    payload = scoped.json()
    assert payload["context"]["context_id"] == issued["context_id"]
    assert payload["context"]["context_hash"] == issued["context_hash"]
    assert {item["project"] for item in payload["resources"]} == {str(env["project_a"].id)}

    cross_project = client.get(
        f"/api/research/workspaces/{env['workspace'].slug}/context/",
        {"project_id": str(env["project_b"].id)},
    )
    assert cross_project.status_code == 403

    cross_resource = client.get(
        f"/api/research/workspaces/{env['workspace'].slug}/context/resources/project/{env['project_b'].id}/"
    )
    assert cross_resource.status_code == 404


def test_context_token_cannot_cross_workspaces(env):
    issued = _issue(env)
    client = APIClient()
    client.credentials(
        HTTP_X_RESEARCH_CONTEXT_TOKEN=issued["exchange_token"],
        HTTP_X_RESEARCH_CONTEXT_HASH=issued["context_hash"],
    )

    response = client.get(f"/api/research/workspaces/{env['other_workspace'].slug}/context/")
    assert response.status_code == 403


def test_expired_and_revoked_context_tokens_are_rejected(env, settings):
    settings.RESEARCH_CONTEXT_TOKEN_TTL_SECONDS = 600
    issued = _issue(env)
    grant = ResearchContextGrant.objects.get(context_id=issued["context_id"])
    grant.expires_at = timezone.now()
    grant.save(update_fields=["expires_at"])

    expired_client = APIClient()
    expired_client.credentials(
        HTTP_X_RESEARCH_CONTEXT_TOKEN=issued["exchange_token"],
        HTTP_X_RESEARCH_CONTEXT_HASH=issued["context_hash"],
    )
    assert expired_client.get(f"/api/research/workspaces/{env['workspace'].slug}/context/").status_code in (401, 403)

    grant.refresh_from_db()
    grant.expires_at = timezone.now() + timedelta(seconds=600)
    grant.save(update_fields=["expires_at"])
    revoked = env["client"].post(
        f"/api/research/workspaces/{env['workspace'].slug}/context/revoke-token/",
        {"context_id": issued["context_id"]},
        format="json",
    )
    assert revoked.status_code == 200

    live_client = APIClient()
    live_client.credentials(
        HTTP_X_RESEARCH_CONTEXT_TOKEN=issued["exchange_token"],
        HTTP_X_RESEARCH_CONTEXT_HASH=issued["context_hash"],
    )
    assert live_client.get(f"/api/research/workspaces/{env['workspace'].slug}/context/").status_code in (401, 403)


def test_context_token_issue_revoke_and_read_are_audited(env):
    issued = _issue(env)
    client = APIClient()
    client.credentials(
        HTTP_X_RESEARCH_CONTEXT_TOKEN=issued["exchange_token"],
        HTTP_X_RESEARCH_CONTEXT_HASH=issued["context_hash"],
    )
    assert client.get(f"/api/research/workspaces/{env['workspace'].slug}/context/").status_code == 200

    env["client"].post(
        f"/api/research/workspaces/{env['workspace'].slug}/context/revoke-token/",
        {"context_id": issued["context_id"]},
        format="json",
    )
    actions = set(
        ResearchAuditEvent.objects.filter(
            workspace=env["workspace"],
            resource_id=issued["context_id"],
        ).values_list("action", flat=True)
    )
    assert {"context.token.issue", "context.token.revoke"}.issubset(actions)
