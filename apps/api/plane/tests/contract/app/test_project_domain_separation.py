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


def test_submit_selects_flow_without_project_configuration(domain_env):
    env = domain_env
    from plane.db.models import AdministrativeProjectApprovalSetting
    flow_id = configure_flow(env)
    AdministrativeProjectApprovalSetting.objects.filter(project=env["project"]).delete()
    created = env["client"].post(f"{env['base']}/administrative/approval-requests/", {
        "project_id": str(env["project"].id), "issue_id": str(env["issue"].id), "flow_id": flow_id,
    }, format="json")
    assert created.status_code == 201, created.data
    assert created.data["flow_id"] == flow_id
    assert created.data["approval_mode"] == "FLOW"


def test_direct_approval_without_template_and_with_history(domain_env):
    env = domain_env
    created = env["client"].post(f"{env['base']}/administrative/approval-requests/", {
        "project_id": str(env["project"].id), "issue_id": str(env["issue"].id),
        "approver_id": str(env["create_user"].id),
    }, format="json")
    assert created.status_code == 201, created.data
    assert created.data["approval_mode"] == "DIRECT"
    assert created.data["approvers"] == [{
        "id": str(env["create_user"].id), "display_name": env["create_user"].display_name,
    }]
    templates = env["client"].get(f"{env['base']}/administrative/approval-flows/")
    assert templates.status_code == 200 and templates.data["results"] == []
    url = f"{env['base']}/administrative/approval-requests/{created.data['id']}/"
    approved = env["admin_client"].post(url, {"action": "APPROVE", "expected_step": 1}, format="json")
    assert approved.status_code == 200, approved.data
    assert approved.data["status"] == "APPROVED"
    assert [entry["action"] for entry in approved.data["history"]] == ["SUBMIT", "APPROVE"]
    # The one-off flow cannot be promoted or edited via the template API.
    assert env["admin_client"].patch(
        f"{env['base']}/administrative/approval-flows/{created.data['flow_id']}/",
        {"name": "不应可编辑", "steps": [{"approver_kind": "ORG_ADMIN"}]}, format="json",
    ).status_code == 404


@pytest.mark.parametrize("selection", ["missing", "both", "invalid_user", "invalid_flow", "other_organization", "inactive_flow"])
def test_submission_validates_per_request_selection(domain_env, selection):
    env = domain_env
    payload = {"project_id": str(env["project"].id), "issue_id": str(env["issue"].id)}
    if selection in ("both", "other_organization", "inactive_flow"):
        from plane.db.models import AdministrativeApprovalFlow, AdministrativeProjectApprovalSetting
        flow_id = configure_flow(env)
        AdministrativeProjectApprovalSetting.objects.filter(project=env["project"]).delete()
        payload["flow_id"] = flow_id
        if selection == "both":
            payload["approver_id"] = str(env["create_user"].id)
        elif selection == "inactive_flow":
            AdministrativeApprovalFlow.objects.filter(pk=flow_id).update(is_active=False)
        else:
            other = AdministrativeOrganization.objects.create(workspace=env["workspace"], name="其他组织")
            AdministrativeApprovalFlow.objects.filter(pk=flow_id).update(organization=other)
    elif selection == "invalid_user":
        outsider = make_user(first_name="其他组织成员")
        WorkspaceMember.objects.create(workspace=env["workspace"], member=outsider, role=15)
        payload["approver_id"] = str(outsider.id)
    elif selection == "invalid_flow":
        payload["flow_id"] = "not-a-uuid"
    response = env["client"].post(f"{env['base']}/administrative/approval-requests/", payload, format="json")
    assert response.status_code == 400, response.data
    assert not AdministrativeApprovalRequest.objects.exists()


def test_regular_member_can_get_approvers_and_revoked_direct_approver_cannot_act(domain_env):
    env = domain_env
    config = env["client"].get(f"{env['base']}/projects/{env['project'].id}/approval-setting/")
    assert config.status_code == 200 and config.data["can_submit"]
    assert str(env["create_user"].id) in {actor["id"] for actor in config.data["approvers"]}
    created = env["client"].post(f"{env['base']}/administrative/approval-requests/", {
        "project_id": str(env["project"].id), "issue_id": str(env["issue"].id),
        "approver_id": str(env["member"].id),
    }, format="json")
    assert created.status_code == 201, created.data
    AdministrativeOrganizationMember.objects.filter(organization=env["organization"], member=env["member"]).delete()
    response = env["client"].post(f"{env['base']}/administrative/approval-requests/{created.data['id']}/", {
        "action": "APPROVE", "expected_step": 1,
    }, format="json")
    assert response.status_code == 403


def test_request_list_combines_scope_and_status_filters(domain_env):
    env = domain_env
    configure_flow(env)
    created = submit(env)
    url = f"{env['base']}/administrative/approval-requests/"
    pending = env["admin_client"].get(url, {"scope": "to_me", "status": "PENDING"})
    assert [item["id"] for item in pending.data["results"]] == [created.data["id"]]
    assert env["client"].get(url, {"scope": "mine", "status": "completed"}).data["results"] == []
    env["client"].post(f"{url}{created.data['id']}/", {"action": "WITHDRAW", "expected_step": 1}, format="json")
    finished = env["client"].get(url, {"scope": "mine", "status": "WITHDRAWN"})
    assert [item["id"] for item in finished.data["results"]] == [created.data["id"]]
    assert env["client"].get(url, {"scope": "visible", "status": "unknown"}).status_code == 400


def test_personal_center_excludes_unrelated_but_project_includes_all(domain_env):
    env = domain_env
    unrelated = env["admin_client"].post(f"{env['base']}/administrative/approval-requests/", {
        "project_id": str(env["project"].id), "issue_id": str(env["issue"].id),
        "approver_id": str(env["create_user"].id),
    }, format="json")
    assert unrelated.status_code == 201, unrelated.data
    url = f"{env['base']}/administrative/approval-requests/"
    for scope in ("related", "visible", "completed", "mine", "to_me"):
        result = env["client"].get(url, {"scope": scope})
        assert result.status_code == 200 and result.data["results"] == []
    # A project member can read the same approval in the project's own view.
    result = env["client"].get(url, {"scope": "visible", "project_id": str(env["project"].id)})
    assert [item["id"] for item in result.data["results"]] == [unrelated.data["id"]]
    detail_url = f"{url}{unrelated.data['id']}/"
    assert env["client"].get(detail_url).status_code == 404
    assert env["client"].get(detail_url, {"project_id": str(env["project"].id)}).status_code == 200
    # Viewing the project does not grant an unrelated member approval rights.
    assert env["client"].post(detail_url, {"action": "APPROVE", "expected_step": 1}, format="json").status_code == 403


def test_personal_center_includes_upcoming_and_completed_approver(domain_env):
    env = domain_env
    flow_id = configure_flow(env)
    created = env["admin_client"].post(f"{env['base']}/administrative/approval-requests/", {
        "project_id": str(env["project"].id), "issue_id": str(env["issue"].id), "flow_id": flow_id,
    }, format="json")
    assert created.status_code == 201, created.data
    url = f"{env['base']}/administrative/approval-requests/"
    result = env["client"].get(url, {"scope": "related"})
    assert [item["id"] for item in result.data["results"]] == [created.data["id"]]
    assert result.data["results"][0]["can_act"] is False
    assert env["client"].get(url, {"scope": "to_me"}).data["results"] == []
    detail_url = f"{url}{created.data['id']}/"
    env["admin_client"].post(detail_url, {"action": "APPROVE", "expected_step": 1}, format="json")
    approved = env["client"].post(detail_url, {"action": "APPROVE", "expected_step": 2}, format="json")
    assert approved.status_code == 200 and approved.data["status"] == "APPROVED"
    result = env["client"].get(url, {"scope": "related", "status": "completed"})
    assert [item["id"] for item in result.data["results"]] == [created.data["id"]]
    assert env["client"].get(detail_url).status_code == 200
    assert env["client"].get(url, {"scope": "mine"}).data["results"] == []


def test_personal_history_preserved_after_organization_role_changes(domain_env):
    env = domain_env
    AdministrativeOrganizationMember.objects.filter(organization=env["organization"], member=env["member"]).update(role="ADMIN")
    flow_id = configure_flow(env, [{"approver_kind": "ORG_ADMIN"}])
    created = env["admin_client"].post(f"{env['base']}/administrative/approval-requests/", {
        "project_id": str(env["project"].id), "issue_id": str(env["issue"].id), "flow_id": flow_id,
    }, format="json")
    assert created.status_code == 201, created.data
    url = f"{env['base']}/administrative/approval-requests/"
    assert len(env["client"].get(url, {"scope": "related"}).data["results"]) == 1
    env["client"].post(f"{url}{created.data['id']}/", {"action": "APPROVE", "expected_step": 1}, format="json")
    AdministrativeOrganizationMember.objects.filter(organization=env["organization"], member=env["member"]).update(role="MEMBER")
    result = env["client"].get(url, {"scope": "related"})
    assert [item["id"] for item in result.data["results"]] == [created.data["id"]]


def test_project_approval_view_rejects_inaccessible_and_mismatched_context(domain_env):
    env = domain_env
    configure_flow(env)
    created = submit(env)
    other_project = Project.objects.create(workspace=env["workspace"], name="其他项目", identifier="OTHER", network=2)
    url = f"{env['base']}/administrative/approval-requests/"
    assert env["client"].get(url, {"scope": "visible", "project_id": str(other_project.id)}).status_code == 404
    assert env["client"].get(f"{url}{created.data['id']}/", {"project_id": str(other_project.id)}).status_code == 404
    # Even a related approval disappears if project access is revoked.
    ProjectMember.objects.filter(project=env["project"], member=env["member"]).delete()
    AdministrativeOrganizationMember.objects.filter(organization=env["organization"], member=env["member"]).delete()
    assert env["client"].get(url, {"scope": "related"}).data["results"] == []
    assert env["client"].get(f"{url}{created.data['id']}/").status_code == 404


def test_project_viewer_reads_work_item_and_history_without_action_rights(domain_env):
    env = domain_env
    from plane.db.models import FileAsset
    env["issue"].description_html = "<p>采购一台显微镜，预算 3 万元。</p>"
    env["issue"].priority = "high"
    env["issue"].save()
    asset = FileAsset.objects.create(
        workspace=env["workspace"], project=env["project"], issue=env["issue"],
        entity_type=FileAsset.EntityTypeContext.ISSUE_ATTACHMENT, is_uploaded=True,
        asset="approval-test/quote.pdf", attributes={"name": "采购报价.pdf"},
    )
    hidden = FileAsset.objects.create(
        workspace=env["workspace"], project=env["project"], issue=env["issue"],
        entity_type=FileAsset.EntityTypeContext.ISSUE_ATTACHMENT, is_uploaded=False,
        asset="approval-test/pending.pdf", attributes={"name": "未完成上传.pdf"},
    )
    created = env["admin_client"].post(f"{env['base']}/administrative/approval-requests/", {
        "project_id": str(env["project"].id), "issue_id": str(env["issue"].id),
        "approver_id": str(env["create_user"].id),
    }, format="json")
    assert created.status_code == 201, created.data
    url = f"{env['base']}/administrative/approval-requests/{created.data['id']}/"
    assert env["client"].get(url).status_code == 404
    response = env["client"].get(url, {"project_id": str(env["project"].id)})
    assert response.status_code == 200, response.data
    assert response.data["work_item"]["description_html"] == env["issue"].description_html
    assert response.data["work_item"]["identifier"] == f"DOMAIN-{env['issue'].sequence_id}"
    assert response.data["work_item"]["priority"] == "high"
    assert response.data["work_item"]["assignees"][0]["id"] == str(env["member"].id)
    assert [item["id"] for item in response.data["work_item"]["attachments"]] == [str(asset.id)]
    assert response.data["history"][0]["action"] == "SUBMIT"
    assert response.data["steps"][0]["approver_name"] == env["create_user"].display_name
    assert not any(response.data[key] for key in ("can_act", "can_cancel", "can_withdraw"))
    env["admin_client"].post(url, {"action": "APPROVE", "expected_step": 1}, format="json")
    ended = env["client"].get(url, {"project_id": str(env["project"].id)})
    assert ended.status_code == 200 and ended.data["status"] == "APPROVED"
    assert not any(ended.data[key] for key in ("can_act", "can_cancel", "can_withdraw"))
    assert len(ended.data["history"]) == 2
