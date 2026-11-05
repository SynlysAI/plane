"""Email assignment-transfer API contracts for administrative and research work items."""

from uuid import uuid4

import pytest
from rest_framework.test import APIClient

from plane.db.models import (
    Issue,
    IssueAssignee,
    Notification,
    NotificationGenerationOutbox,
    Project,
    ProjectMember,
    ResearchAuditEvent,
    ResearchChainNodeTask,
    State,
    User,
    WorkspaceMember,
)
from plane.tests.research_fixtures import make_research_boundary_fixture
from plane.utils.assignment_transfer import build_assignment_transfer_token

pytestmark = pytest.mark.contract

URL = "/api/email-actions/assignment-transfer/"


def _client(user):
    client = APIClient()
    client.force_authenticate(user=user)
    return client


def _request(token, candidate):
    return {"token": token, "candidate_id": str(candidate.id)}


@pytest.fixture
def administrative_env(db, workspace, create_user):
    """Build a minimal administrative issue whose owner can transfer it."""
    project = Project.objects.create(
        name="行政采购审批",
        identifier=f"AD{uuid4().hex[:3]}",
        workspace=workspace,
        created_by=create_user,
        network=2,
    )
    ProjectMember.objects.create(workspace=workspace, project=project, member=create_user, role=20)
    owner = User.objects.create(email=f"owner-{uuid4().hex[:6]}@example.com", username="email-owner")
    candidate = User.objects.create(email=f"next-{uuid4().hex[:6]}@example.com", username="email-next")
    for user, role in ((owner, 15), (candidate, 15)):
        WorkspaceMember.objects.create(workspace=workspace, member=user, role=role)
        ProjectMember.objects.create(workspace=workspace, project=project, member=user, role=role)
    issue = Issue.objects.create(
        name="采购 NMP 试剂",
        project=project,
        workspace=workspace,
        created_by=create_user,
        state=State.objects.create(
            name="待处理",
            color="#000000",
            group="backlog",
            default=True,
            project=project,
            workspace=workspace,
            created_by=create_user,
        ),
    )
    IssueAssignee.objects.create(workspace=workspace, project=project, issue=issue, assignee=owner)
    return {"workspace": workspace, "project": project, "issue": issue, "owner": owner, "candidate": candidate}


@pytest.fixture
def research_env(db, settings):
    """Build an assigned research task inside the standard research boundary."""
    settings.RESEARCH_MODULE_ENABLED = True
    fixture = make_research_boundary_fixture()
    ProjectMember.objects.create(project=fixture["project"], member=fixture["group_member"], role=15)
    ProjectMember.objects.create(project=fixture["project"], member=fixture["advisor"], role=15)
    task = ResearchChainNodeTask.objects.create(
        workspace=fixture["workspace"],
        chain=fixture["chain"],
        node=fixture["paper_node"],
        title="JACS 审稿意见回复",
        status=ResearchChainNodeTask.Status.ASSIGNED,
        assignee=fixture["group_member"],
        assigned_by=fixture["student"],
        request_id=f"email-task-{uuid4().hex}",
        payload_hash=uuid4().hex,
        created_by=fixture["student"],
    )
    return fixture | {"task": task, "owner": fixture["group_member"], "candidate": fixture["advisor"]}


@pytest.mark.django_db
def test_administrative_transfer_requires_target_owner_login(administrative_env):
    issue = administrative_env["issue"]
    owner = administrative_env["owner"]
    candidate = administrative_env["candidate"]
    token = build_assignment_transfer_token("issue", issue.id, owner.id, owner.id)

    anonymous = APIClient()
    response = anonymous.get(URL, {"token": token, "candidate_id": str(candidate.id)})
    assert response.status_code in {401, 403}

    outsider = User.objects.create(email=f"outsider-{uuid4().hex[:6]}@example.com", username="email-outsider")
    response = _client(outsider).get(URL, {"token": token, "candidate_id": str(candidate.id)})
    assert response.status_code == 403
    assert response.json()["error_code"] == "assignment_transfer_forbidden"


@pytest.mark.django_db
def test_administrative_transfer_updates_owner_and_queues_native_effects(administrative_env):
    env = administrative_env
    token = build_assignment_transfer_token("issue", env["issue"].id, env["owner"].id, env["owner"].id)
    client = _client(env["owner"])

    preview = client.get(URL, {"token": token, "candidate_id": str(env["candidate"].id)})
    assert preview.status_code == 200, preview.json()
    assert preview.json()["entity_type"] == "administrative_work_item"
    assert preview.json()["title"] == env["issue"].name
    assert not NotificationGenerationOutbox.objects.filter(payload__issue_id=str(env["issue"].id)).exists()

    confirmed = client.post(URL, _request(token, env["candidate"]), format="json")
    assert confirmed.status_code == 200, confirmed.json()
    assert confirmed.json()["status"] == "completed"
    assert list(env["issue"].issue_assignee.values_list("assignee_id", flat=True)) == [env["candidate"].id]
    outbox = NotificationGenerationOutbox.objects.get(payload__issue_id=str(env["issue"].id))
    assert outbox.payload["email_assignment_transfer"] is True

    repeated = client.post(URL, _request(token, env["candidate"]), format="json")
    assert repeated.status_code == 200
    assert repeated.json()["status"] == "already_completed"
    assert NotificationGenerationOutbox.objects.filter(payload__issue_id=str(env["issue"].id)).count() == 1


@pytest.mark.django_db
def test_research_transfer_preserves_events_audit_and_notification(research_env):
    task = research_env["task"]
    token = build_assignment_transfer_token(
        "research_chain_task", task.id, research_env["owner"].id, research_env["owner"].id
    )
    response = _client(research_env["owner"]).post(
        URL, _request(token, research_env["candidate"]), format="json"
    )

    assert response.status_code == 200, response.json()
    task.refresh_from_db()
    assert task.assignee_id == research_env["candidate"].id
    assert task.assigned_by_id == research_env["owner"].id
    audit = ResearchAuditEvent.objects.get(
        workspace=research_env["workspace"], resource_id=task.id, action="task.update"
    )
    assert audit.metadata["email_assignment_transfer"] is True
    assert audit.metadata["assignee"] == str(research_env["candidate"].id)
    assert Notification.objects.filter(
        entity_name="research_chain_task",
        receiver=research_env["candidate"],
        data__action="assigned",
    ).exists()


@pytest.mark.django_db
def test_transfer_rejects_invalid_candidate_and_changed_owner(research_env):
    task = research_env["task"]
    owner = research_env["owner"]
    invalid_token = build_assignment_transfer_token(
        "research_chain_task", task.id, owner.id, owner.id
    )
    invalid = _client(owner).post(
        URL, _request(invalid_token, research_env["guest"]), format="json"
    )
    assert invalid.status_code == 422
    assert invalid.json()["error_code"] == "assignment_candidate_invalid"

    task.assignee = research_env["student"]
    task.save(update_fields=["assignee", "updated_at"])
    changed = _client(owner).post(
        URL, _request(invalid_token, research_env["candidate"]), format="json"
    )
    assert changed.status_code == 409
    assert changed.json()["error_code"] == "assignment_changed"


@pytest.mark.django_db
def test_tampered_token_is_rejected(administrative_env):
    response = APIClient().get(URL, {"token": "not-a-signed-token", "candidate_id": str(uuid4())})
    assert response.status_code in {401, 403, 400}


@pytest.mark.django_db
def test_malformed_candidate_id_is_rejected_without_server_error(administrative_env):
    env = administrative_env
    token = build_assignment_transfer_token("issue", env["issue"].id, env["owner"].id, env["owner"].id)
    response = _client(env["owner"]).post(
        URL,
        {"token": token, "candidate_id": "not-a-uuid"},
        format="json",
    )

    assert response.status_code == 422
    assert response.json()["error_code"] == "assignment_candidate_invalid"
