"""Deletion permissions, dependency guards and soft-delete retention."""

from datetime import date
from uuid import uuid4

import pytest
from rest_framework.test import APIClient

from plane.db.models import (
    Page,
    PeriodicReport,
    Project,
    ResearchAuditEvent,
    ResearchChain,
    ResearchChainEvent,
    ResearchChainNode,
    ResearchChainNodeTask,
    ResearchOutcome,
    ResearchOutcomeLink,
    ResearchProjectProfile,
)
from plane.tests.research_fixtures import add_workspace_member, enable_research, make_user, make_workspace

pytestmark = [pytest.mark.contract, pytest.mark.django_db]


@pytest.fixture
def env(settings):
    settings.RESEARCH_MODULE_ENABLED = True
    owner = make_user()
    other = make_user()
    workspace = make_workspace(owner)
    add_workspace_member(workspace, other)
    enable_research(workspace, research_chain_enabled=True)
    project = Project.objects.create(workspace=workspace, name="Deletion", identifier="DEL")
    profile = ResearchProjectProfile.objects.create(
        workspace=workspace,
        project=project,
        owner=owner,
        chain_kind="RESEARCH_CHAIN",
        chain_visibility="WORKSPACE",
        research_type="RESEARCH_PROJECT",
    )
    chain = ResearchChain.objects.create(
        workspace=workspace,
        project=project,
        owner=owner,
        visibility="WORKSPACE",
        request_id=uuid4().hex,
        payload_hash="hash",
    )
    clients = []
    for actor in (owner, other):
        client = APIClient()
        client.force_authenticate(actor)
        clients.append(client)
    return dict(
        owner=owner,
        workspace=workspace,
        project=project,
        profile=profile,
        chain=chain,
        client=clients[0],
        other=clients[1],
        root=f"/api/research/workspaces/{workspace.slug}/",
    )


def node(env, parent=None):
    return ResearchChainNode.objects.create(
        chain=env["chain"],
        title="Mistaken node",
        node_type="LITERATURE_REVIEW",
        parent_node=parent,
        loop_iteration=1 if parent else 0,
        request_id=uuid4().hex,
        payload_hash="hash",
    )


def report(env, status="DRAFT"):
    page = Page.objects.create(workspace=env["workspace"], owned_by=env["owner"], name="Weekly")
    return PeriodicReport.objects.create(
        workspace=env["workspace"],
        owner=env["owner"],
        project=env["project"],
        page=page,
        report_type="WEEKLY",
        period_key="2026-W42",
        period_start=date(2026, 10, 12),
        period_end=date(2026, 10, 18),
        status=status,
    )


def outcome(env, status="DRAFT"):
    return ResearchOutcome.objects.create(
        workspace=env["workspace"],
        project=env["project"],
        title="Mistaken outcome",
        output_type="PAPER",
        status=status,
    )


def test_empty_project_is_recoverably_deleted_with_profile_and_chain(env):
    response = env["client"].delete(env["root"] + f"projects/{env['project'].pk}/")
    assert response.status_code == 204, response.data
    assert Project.objects.filter(pk=env["project"].pk, deleted_at__isnull=True).exists()
    env["profile"].refresh_from_db()
    env["chain"].refresh_from_db()
    assert env["profile"].workflow_status == "DELETED"
    assert env["profile"].is_active is False
    assert env["chain"].status == "DELETED"
    assert ResearchAuditEvent.objects.filter(action="project.delete", resource_id=env["profile"].pk).exists()
    restored = env["client"].post(env["root"] + f"projects/{env['project'].pk}/restore/", {}, format="json")
    assert restored.status_code == 200, restored.data
    env["profile"].refresh_from_db()
    env["chain"].refresh_from_db()
    assert env["profile"].workflow_status == env["chain"].status == "ACTIVE"
    assert env["profile"].is_active is True


def test_project_deletion_preserves_nodes_and_nonowner_cannot_delete(env):
    item = node(env)
    url = env["root"] + f"projects/{env['project'].pk}/"
    assert env["other"].delete(url).status_code == 403
    response = env["client"].delete(url)
    assert response.status_code == 204, response.data
    assert Project.objects.filter(pk=env["project"].pk).exists()
    assert ResearchChainNode.objects.filter(pk=item.pk).exists()


@pytest.mark.parametrize("kind", ["report", "outcome"])
def test_project_deletion_preserves_research_content(env, kind):
    item = (report if kind == "report" else outcome)(env)
    assert env["client"].delete(env["root"] + f"projects/{env['project'].pk}/").status_code == 204
    item.refresh_from_db()
    assert item.deleted_at is None


@pytest.mark.parametrize("status", ["ARCHIVED", "DELETED", "COMPLETED"])
def test_inactive_chain_retains_draft_nodes_until_restored(env, status):
    item = node(env)
    env["chain"].status = status
    env["chain"].save(update_fields=["status"])
    response = env["client"].delete(env["root"] + f"nodes/{item.pk}/")
    assert response.status_code == 409, response.data
    assert ResearchChainNode.objects.filter(pk=item.pk).exists()


def test_draft_node_deletion_retains_creation_event_and_releases_iteration(env):
    parent = node(env)
    child = node(env, parent)
    event = ResearchChainEvent.objects.create(
        chain=env["chain"],
        node=child,
        event_id=uuid4().hex,
        request_id=uuid4().hex,
        actor=env["owner"],
        actor_type="USER",
        source_system="PLANE",
        event_type="NODE_CREATED",
        occurred_at=child.created_at,
        content_hash="hash",
    )
    url = env["root"] + f"nodes/{child.pk}/"
    assert env["other"].delete(url).status_code == 403
    response = env["client"].delete(url)
    assert response.status_code == 204, response.data
    assert env["client"].get(url).status_code == 404
    assert ResearchChainEvent.objects.filter(pk=event.pk).exists()
    replacement = node(env, parent)
    assert replacement.loop_iteration == child.loop_iteration


@pytest.mark.parametrize("dependency", ["task", "child", "event", "state"])
def test_node_with_work_or_history_is_not_deleted(env, dependency):
    item = node(env)
    if dependency == "task":
        ResearchChainNodeTask.objects.create(
            workspace=env["workspace"],
            chain=env["chain"],
            node=item,
            title="Task",
            request_id=uuid4().hex,
            payload_hash="hash",
            created_by=env["owner"],
        )
    elif dependency == "child":
        node(env, item)
    elif dependency == "event":
        ResearchChainEvent.objects.create(
            chain=env["chain"],
            node=item,
            event_id=uuid4().hex,
            request_id=uuid4().hex,
            event_type="NODE_STARTED",
            source_system="PLANE",
            actor_type="USER",
            occurred_at=item.created_at,
            content_hash="hash",
        )
    else:
        item.status = "ACTIVE"
        item.save(update_fields=["status"])
    response = env["client"].delete(env["root"] + f"nodes/{item.pk}/")
    assert response.status_code == 409, response.data
    assert ResearchChainNode.objects.filter(pk=item.pk).exists()


def test_author_can_delete_draft_report_and_recreate_its_period(env):
    item = report(env)
    url = env["root"] + f"reports/{item.pk}/"
    assert env["client"].get(url).data["can_delete"] is True
    assert env["other"].delete(url).status_code in (403, 404)
    response = env["client"].delete(url)
    assert response.status_code == 204, response.data
    assert env["client"].get(url).status_code == 404
    assert not Page.objects.filter(pk=item.page_id).exists()
    assert PeriodicReport.all_objects.filter(pk=item.pk).exists()
    assert report(env).period_key == item.period_key


@pytest.mark.parametrize("status", ["SUBMITTED", "NEEDS_REVISION", "ACCEPTED"])
def test_reports_with_workflow_history_cannot_be_deleted(env, status):
    item = report(env, status)
    url = env["root"] + f"reports/{item.pk}/"
    assert env["client"].get(url).data["can_delete"] is False
    assert env["client"].delete(url).status_code == 409
    assert PeriodicReport.objects.filter(pk=item.pk).exists()


def test_draft_outcome_deletion_checks_permissions_and_soft_deletes(env):
    item = outcome(env)
    url = env["root"] + f"outcomes/{item.pk}/"
    assert env["client"].get(url).data["can_delete"] is True
    assert env["other"].delete(url).status_code in (403, 404)
    response = env["client"].delete(url)
    assert response.status_code == 204, response.data
    assert env["client"].get(url).status_code == 404
    assert ResearchOutcome.all_objects.filter(pk=item.pk).exists()


@pytest.mark.parametrize("dependency", ["published", "link"])
def test_formal_or_linked_outcomes_cannot_be_deleted(env, dependency):
    item = outcome(env, "PUBLISHED" if dependency == "published" else "DRAFT")
    if dependency == "link":
        target = report(env)
        ResearchOutcomeLink.objects.create(outcome=item, target_type="PERIODIC_REPORT", target_id=target.pk)
        assert env["client"].delete(env["root"] + f"reports/{target.pk}/").status_code == 409
    assert env["client"].delete(env["root"] + f"outcomes/{item.pk}/").status_code == 409
    assert ResearchOutcome.objects.filter(pk=item.pk).exists()
