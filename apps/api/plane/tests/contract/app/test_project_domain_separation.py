"""Domain boundary and read-only administrative approval history."""

from datetime import timedelta
from unittest.mock import patch
import pytest
from django.utils import timezone
from rest_framework.test import APIClient
from plane.db.models import (
    AdministrativeApprovalAction,
    AdministrativeApprovalFlow,
    AdministrativeApprovalRequest,
    AdministrativeApprovalStep,
    AdministrativeOrganization,
    AdministrativeOrganizationMember,
    Issue,
    IssueAssignee,
    Project,
    ProjectMember,
    State,
    WorkspaceMember,
    WorkspaceResearchSetting,
)
from plane.tests.research_fixtures import make_user

pytestmark = [pytest.mark.contract, pytest.mark.django_db]


@pytest.fixture
def domain_env(workspace, create_user):
    WorkspaceResearchSetting.objects.update_or_create(workspace=workspace, defaults={"module_enabled": False})
    organization = AdministrativeOrganization.objects.create(workspace=workspace, name="行政测试")
    AdministrativeOrganizationMember.objects.create(
        workspace=workspace, organization=organization, member=create_user, role="ADMIN"
    )
    member = make_user(first_name="行政成员")
    WorkspaceMember.objects.create(workspace=workspace, member=member, role=15)
    AdministrativeOrganizationMember.objects.create(
        workspace=workspace, organization=organization, member=member, role="MEMBER"
    )
    project = Project.objects.create(
        workspace=workspace, name="行政项目", identifier="DOMAIN", administrative_organization=organization, network=2
    )
    ProjectMember.objects.create(workspace=workspace, project=project, member=create_user, role=20)
    ProjectMember.objects.create(workspace=workspace, project=project, member=member, role=15)
    state = State.objects.create(workspace=workspace, project=project, name="待处理", group="unstarted")
    issue = Issue.objects.create(
        workspace=workspace,
        project=project,
        state=state,
        name="设备采购",
        target_date=timezone.localdate() - timedelta(days=60),
    )
    IssueAssignee.objects.create(workspace=workspace, project=project, issue=issue, assignee=member)
    admin_client = APIClient()
    admin_client.force_authenticate(create_user)
    client = APIClient()
    client.force_authenticate(member)
    base = f"/api/workspaces/{workspace.slug}"
    return locals()


def make_flow(env):
    """直接用 ORM 构造历史审批流程，模拟接口下线前遗留的数据。"""
    flow = AdministrativeApprovalFlow.objects.create(
        workspace=env["workspace"], organization=env["organization"], name="采购审批"
    )
    AdministrativeApprovalStep.objects.create(flow=flow, order=1, approver_kind="ORG_ADMIN")
    return flow


def submit(env):
    return env["client"].post(
        f"{env['base']}/administrative/approval-requests/",
        {
            "project_id": str(env["project"].id),
            "issue_id": str(env["issue"].id),
        },
        format="json",
    )


def test_todos_include_old_assigned_tasks_and_degrade_independently(domain_env):
    env = domain_env
    response = env["client"].get(f"{env['base']}/todos/")
    assert response.status_code == 200, response.data
    assert response.data["results"][0]["domain"] == "ADMINISTRATIVE"
    assert response.data["results"][0]["urgency"] == "OVERDUE"
    assert response.data["results"][0]["object_id"] == str(env["issue"].id)
    with (
        patch("plane.app.views.workspace.todos.research_admitted", return_value=True),
        patch("plane.app.views.workspace.todos.collect_research_todos", side_effect=RuntimeError("source unavailable")),
    ):
        result = env["client"].get(f"{env['base']}/todos/")
    assert len(result.data["results"]) == 1 and "RESEARCH" in result.data["degraded_sources"]


def test_context_strict_boolean_and_admin_authorization(domain_env):
    env = domain_env
    url = f"{env['base']}/context/"
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
    env["project"].archived_at = timezone.now()
    env["project"].save()
    response = env["client"].get(f"/api/research/workspaces/{env['workspace'].slug}/administrative-organizations/")
    assert all(str(env["project"].id) not in item["project_ids"] for item in response.data)


def test_retired_approval_configuration_endpoints_are_removed(domain_env):
    env = domain_env
    assert env["admin_client"].get(f"{env['base']}/administrative/approval-flows/").status_code == 404
    assert (
        env["admin_client"].get(
            f"{env['base']}/administrative/organizations/{env['organization'].id}/approvers/"
        ).status_code
        == 404
    )
    assert (
        env["admin_client"].get(f"{env['base']}/projects/{env['project'].id}/approval-setting/").status_code == 404
    )


def test_assignment_approves_pending_administrative_request(domain_env):
    """Replacing an administrative work-item owner completes its pending request."""
    env = domain_env
    flow = make_flow(env)
    approval = AdministrativeApprovalRequest.objects.create(
        workspace=env["workspace"],
        project=env["project"],
        issue=env["issue"],
        flow=flow,
        requested_by=env["member"],
    )

    with (
        patch("plane.app.views.issue.base.issue_activity.delay"),
        patch("plane.app.views.issue.base.model_activity.delay"),
        patch("plane.app.views.issue.base.issue_description_version_task.delay"),
    ):
        response = env["admin_client"].patch(
            f"{env['base']}/projects/{env['project'].id}/issues/{env['issue'].id}/",
            {"assignee_ids": [str(env["create_user"].id)]},
            format="json",
        )

    assert response.status_code == 204, response.data
    approval.refresh_from_db()
    assert approval.status == "APPROVED"
    action = AdministrativeApprovalAction.objects.filter(request=approval).latest("created_at")
    assert action.action == "APPROVE"
    assert action.actor_id == env["create_user"].id
    assert action.comment == "负责人指派后自动完成审批。"
    assert list(IssueAssignee.objects.filter(issue=env["issue"]).values_list("assignee_id", flat=True)) == [
        env["create_user"].id
    ]


def test_administrative_approval_submission_is_retired(domain_env):
    """New administrative approval requests cannot bypass direct assignment."""
    env = domain_env
    response = submit(env)

    assert response.status_code == 400
    assert not AdministrativeApprovalRequest.objects.exists()
