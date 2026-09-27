"""AccountLink lifecycle, conflict and revocation propagation tests."""

from datetime import timedelta
from uuid import uuid4

import pytest
from django.utils import timezone
from rest_framework.test import APIClient

from plane.db.models import AccountLink, Project, ResearchAuditEvent, ResearchContextGrant, ResearchProjectProfile
from plane.tests.research_fixtures import add_workspace_member, enable_research, make_user, make_workspace

pytestmark = pytest.mark.contract


def _client(user):
    client = APIClient()
    client.force_authenticate(user=user)
    return client


@pytest.fixture
def env(db, settings):
    settings.RESEARCH_MODULE_ENABLED = True
    owner = make_user(first_name="Link owner")
    workspace = make_workspace(owner)
    member = make_user(first_name="Link member")
    add_workspace_member(workspace, member)
    enable_research(workspace, research_account_link_enabled=True, research_agent_enabled=True)
    suffix = uuid4().hex[:6]
    project = Project.objects.create(
        workspace=workspace,
        name=f"Account link project {suffix}",
        identifier=f"AL{suffix}",
        network=0,
        created_by=owner,
    )
    ResearchProjectProfile.objects.create(project=project, workspace=workspace, owner=owner, created_by=owner)
    return {
        "owner": owner,
        "member": member,
        "workspace": workspace,
        "project": project,
        "client": _client(owner),
    }


def links_url(env, suffix=""):
    return f"/api/research/workspaces/{env['workspace'].slug}/account-links/{suffix}"


def payload(env, subject, **overrides):
    data = {
        "request_id": f"link-{uuid4().hex}",
        "provider": "ragportal",
        "external_subject": subject,
        "local_user_id": str(env["owner"].id),
    }
    data.update(overrides)
    return data


def test_account_link_requires_verification_and_is_idempotent(env):
    request = payload(env, "subject-a")
    created = env["client"].post(links_url(env), request, format="json")
    assert created.status_code == 201, created.json()
    link = created.json()
    assert link["schema_version"] == "account-link.v1"
    assert link["status"] == "PENDING"
    assert link["verification_code"]

    replay = env["client"].post(links_url(env), request, format="json")
    assert replay.status_code == 200
    assert "verification_code" not in replay.json()
    assert replay.json()["id"] == link["id"]

    wrong = env["client"].post(
        links_url(env, f"{link['id']}/confirm/"),
        {"verification_code": "wrong-code"},
        format="json",
    )
    assert wrong.status_code == 403
    confirmed = env["client"].post(
        links_url(env, f"{link['id']}/confirm/"),
        {"verification_code": link["verification_code"]},
        format="json",
    )
    assert confirmed.status_code == 200
    assert confirmed.json()["status"] == "ACTIVE"
    assert confirmed.json()["verified_at"]


def test_account_link_supports_multiple_subjects_but_rejects_email_conflicts(env):
    first = env["client"].post(links_url(env), payload(env, "subject-a"), format="json")
    second = env["client"].post(links_url(env), payload(env, "subject-b"), format="json")
    assert first.status_code == 201
    assert second.status_code == 201
    assert first.json()["canonical_identity"] == second.json()["canonical_identity"]

    duplicate_subject = env["client"].post(links_url(env), payload(env, "subject-a"), format="json")
    assert duplicate_subject.status_code == 409

    email_conflict = env["client"].post(
        links_url(env),
        payload(
            env,
            "member-subject",
            local_user_id=str(env["member"].id),
            canonical_identity=env["owner"].email.lower(),
        ),
        format="json",
    )
    assert email_conflict.status_code == 409

    conflicts = env["client"].get(
        links_url(env, "conflicts/"),
        {"provider": "ragportal", "external_subject": "subject-a"},
    )
    assert conflicts.status_code == 200
    assert conflicts.json()["count"] == 1


def test_expired_account_link_verification_fails(env):
    created = env["client"].post(links_url(env), payload(env, "subject-a"), format="json")
    link_id = created.json()["id"]
    AccountLink.objects.filter(pk=link_id).update(verification_expires_at=timezone.now() - timedelta(seconds=1))
    response = env["client"].post(
        links_url(env, f"{link_id}/confirm/"),
        {"verification_code": created.json()["verification_code"]},
        format="json",
    )
    assert response.status_code == 403


def test_account_link_revocation_revokes_live_context_tokens(env):
    issued_context = env["client"].post(
        f"/api/research/workspaces/{env['workspace'].slug}/context/exchange-token/",
        {
            "request_id": f"ctx-{uuid4().hex}",
            "research_project_id": str(env["project"].id),
        },
        format="json",
    )
    assert issued_context.status_code == 201
    context = issued_context.json()
    created_link = env["client"].post(links_url(env), payload(env, "subject-a"), format="json")
    assert created_link.status_code == 201

    revoked = env["client"].post(links_url(env, f"{created_link.json()['id']}/revoke/"), format="json")
    assert revoked.status_code == 200
    assert revoked.json()["status"] == "REVOKED"

    token_client = APIClient()
    token_client.credentials(
        HTTP_X_RESEARCH_CONTEXT_TOKEN=context["exchange_token"],
        HTTP_X_RESEARCH_CONTEXT_HASH=context["context_hash"],
    )
    response = token_client.get(f"/api/research/workspaces/{env['workspace'].slug}/context/")
    assert response.status_code in (401, 403)
    assert not ResearchContextGrant.objects.filter(context_id=context["context_id"], revoked_at__isnull=True).exists()

    actions = set(
        ResearchAuditEvent.objects.filter(
            workspace=env["workspace"],
            resource_id=created_link.json()["id"],
        ).values_list("action", flat=True)
    )
    assert "account.link.create" in actions
    assert "account.link.revoke" in actions
