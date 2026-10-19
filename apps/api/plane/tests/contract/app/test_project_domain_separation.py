"""Domain boundary and administrative approvals. Run in the isolated API test environment."""

from datetime import timedelta
from unittest.mock import patch
import pytest
from django.utils import timezone
from rest_framework.test import APIClient
from plane.db.models import (
    AdministrativeApprovalAction, AdministrativeApprovalRequest, AdministrativeOrganization,
    AdministrativeOrganizationMember, Issue, IssueAssignee, Project, ProjectMember,
    ResearchProjectProfile, State, WorkspaceMember, WorkspaceResearchSetting,
)
from plane.tests.research_fixtures import make_user

pytestmark = [pytest.mark.contract, pytest.mark.django_db]


@pytest.fixture
def domain_env(workspace, create_user):
    WorkspaceResearchSetting.objects.update_or_create(workspace=workspace, defaults={"module_enabled": False})
    organization = AdministrativeOrganization.objects.create(workspace=workspace, name="行政测试")
    AdministrativeOrganizationMember.objects.create(workspace=workspace, organization=organization, member=create_user, role="ADMIN")
    member = make_user(first_name="行政成员")
    WorkspaceMember.objects.create(workspace=workspace, member=member, role=15)
    AdministrativeOrganizationMember.objects.create(workspace=workspace, organization=organization, member=member, role="MEMBER")
    project = Project.objects.create(workspace=workspace, name="行政项目", identifier="DOMAIN", administrative_organization=organization, network=2)
    ProjectMember.objects.create(workspace=workspace, project=project, member=create_user, role=20)
    ProjectMember.objects.create(workspace=workspace, project=project, member=member, role=15)
    state = State.objects.create(workspace=workspace, project=project, name="待处理", group="unstarted")
    issue = Issue.objects.create(workspace=workspace, project=project, state=state, name="设备采购", target_date=timezone.localdate() - timedelta(days=60))
    IssueAssignee.objects.create(workspace=workspace, project=project, issue=issue, assignee=member)
    admin_client = APIClient(); admin_client.force_authenticate(create_user)
    client = APIClient(); client.force_authenticate(member)
    base = f"/api/workspaces/{workspace.slug}"
    return locals()


def configure_flow(env, steps=None):
    response = env["admin_client"].post(f"{env['base']}/administrative/approval-flows/", {
        "organization_id": str(env["organization"].id), "name": "采购审批",
        "steps": steps or [{"approver_kind": "ORG_ADMIN"}, {"approver_kind": "USER", "approver_id": str(env["member"].id)}],
    }, format="json")
    assert response.status_code == 201, response.data
    flow_id = response.data["id"]
    selected = env["admin_client"].patch(f"{env['base']}/projects/{env['project'].id}/approval-setting/", {"flow_id": flow_id}, format="json")
    assert selected.status_code == 200, selected.data
    return flow_id


def submit(env):
    return env["client"].post(f"{env['base']}/administrative/approval-requests/", {
        "project_id": str(env["project"].id), "issue_id": str(env["issue"].id),
    }, format="json")


def test_administrative_approval_progress_and_replay(domain_env):
    env = domain_env; configure_flow(env)
    created = submit(env)
    assert created.status_code == 201, created.data
    assert submit(env).status_code == 409
    url = f"{env['base']}/administrative/approval-requests/{created.data['id']}/"
    wrong = env["client"].post(url, {"action": "APPROVE", "expected_step": 1}, format="json")
    assert wrong.status_code == 403
    first = env["admin_client"].post(url, {"action": "APPROVE", "expected_step": 1}, format="json")
    assert first.status_code == 200 and first.data["step"] == 2
    assert env["admin_client"].post(url, {"action": "APPROVE", "expected_step": 1}, format="json").status_code == 409
    final = env["client"].post(url, {"action": "APPROVE", "expected_step": 2}, format="json")
    assert final.status_code == 200 and final.data["status"] == "APPROVED"
    assert AdministrativeApprovalAction.objects.filter(request_id=created.data["id"]).count() == 3


def test_used_template_is_immutable(domain_env):
    env = domain_env; flow_id = configure_flow(env)
    created = submit(env); assert created.status_code == 201
    changed = env["admin_client"].patch(f"{env['base']}/administrative/approval-flows/{flow_id}/", {
        "name": "新采购审批", "steps": [{"approver_kind": "ORG_ADMIN"}],
    }, format="json")
    assert changed.status_code == 200 and changed.data["version"] == 2
    approval = AdministrativeApprovalRequest.objects.get(pk=created.data["id"])
    assert str(approval.flow_id) == flow_id and approval.flow.steps.count() == 2


def test_revoked_approver_blocks_progress(domain_env):
    env = domain_env; configure_flow(env)
    created = submit(env); assert created.status_code == 201
    WorkspaceMember.objects.filter(workspace=env["workspace"], member=env["member"]).update(is_active=False)
    response = env["admin_client"].post(f"{env['base']}/administrative/approval-requests/{created.data['id']}/", {
        "action": "APPROVE", "expected_step": 1,
    }, format="json")
    assert response.status_code == 409
    assert AdministrativeApprovalRequest.objects.get(pk=created.data["id"]).current_step_order == 1


@pytest.mark.parametrize("action,actor,expected", [("WITHDRAW", "client", "WITHDRAWN"), ("CANCEL", "admin_client", "CANCELLED"), ("REJECT", "admin_client", "REJECTED")])
def test_terminal_actions_and_required_reason(domain_env, action, actor, expected):
    env = domain_env; configure_flow(env); created = submit(env)
    url = f"{env['base']}/administrative/approval-requests/{created.data['id']}/"
    if action != "WITHDRAW":
        assert env[actor].post(url, {"action": action, "expected_step": 1}, format="json").status_code == 400
    result = env[actor].post(url, {"action": action, "expected_step": 1, "comment": "测试原因"}, format="json")
    assert result.status_code == 200 and result.data["status"] == expected


def test_todos_include_old_assigned_tasks_and_degrade_independently(domain_env):
    env = domain_env
    response = env["client"].get(f"{env['base']}/todos/")
    assert response.status_code == 200, response.data
    assert response.data["results"][0]["domain"] == "ADMINISTRATIVE"
    assert response.data["results"][0]["urgency"] == "OVERDUE"
    assert response.data["results"][0]["object_id"] == str(env["issue"].id)
    with patch("plane.app.views.workspace.todos.research_admitted", return_value=True), patch(
        "plane.app.views.workspace.todos.collect_research_todos", side_effect=RuntimeError("source unavailable")
    ):
        result = env["client"].get(f"{env['base']}/todos/")
    assert len(result.data["results"]) == 1 and "RESEARCH" in result.data["degraded_sources"]


def test_research_backing_project_cannot_be_used_for_administrative_approval(domain_env):
    env = domain_env; configure_flow(env)
    ResearchProjectProfile.objects.create(workspace=env["workspace"], project=env["project"], owner=env["member"])
    assert submit(env).status_code == 404
    assert env["client"].get(f"{env['base']}/projects/{env['project'].id}/issues/").status_code == 403


def test_context_strict_boolean_and_admin_authorization(domain_env):
    env = domain_env; url = f"{env['base']}/context/"
    response = env["client"].get(url)
    assert response.status_code == 200 and response.data["navigation"]["administrative"]
    assert not response.data["workspace_enabled"]
    assert env["client"].patch(url, {"research_enabled": True}, format="json").status_code == 403
    assert env["admin_client"].patch(url, {"research_enabled": "false"}, format="json").status_code == 400
    enabled = env["admin_client"].patch(url, {"research_enabled": True}, format="json")
    assert enabled.status_code == 200 and enabled.data["sections"]["research_chain"]


def test_project_member_is_visible_in_tree_without_organization_membership(domain_env):
    env = domain_env
    AdministrativeOrganizationMember.objects.filter(organization=env["organization"], member=env["member"]).delete()
    response = env["client"].get(f"/api/research/workspaces/{env['workspace'].slug}/administrative-organizations/")
    assert response.status_code == 200
    org = next(item for item in response.data if item["id"] == str(env["organization"].id))
    assert str(env["project"].id) in org["project_ids"]
    env["project"].archived_at = timezone.now(); env["project"].save()
    response = env["client"].get(f"/api/research/workspaces/{env['workspace'].slug}/administrative-organizations/")
    assert all(str(env["project"].id) not in item["project_ids"] for item in response.data)
