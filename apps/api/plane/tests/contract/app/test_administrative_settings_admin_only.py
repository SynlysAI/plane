"""Administrative module, label, and view configuration lock tests."""

import pytest
from rest_framework.test import APIClient

from plane.db.models import (
    APIToken,
    IssueView,
    Label,
    Module,
    Project,
    ProjectMember,
    ResearchProjectProfile,
    WorkspaceMember,
    WorkspaceResearchSetting,
)
from plane.tests.research_fixtures import make_user
from plane.utils.administrative_projects import administrative_settings_write_blocked

pytestmark = [pytest.mark.contract, pytest.mark.django_db]


@pytest.fixture
def lock_env(workspace, create_user):
    """Create an administrative project with a non-workspace project administrator."""
    setting = WorkspaceResearchSetting.objects.create(workspace=workspace, module_enabled=False)
    project_admin = make_user(first_name="Project", last_name="Admin")
    WorkspaceMember.objects.create(workspace=workspace, member=project_admin, role=15)

    project = Project.objects.create(
        workspace=workspace,
        name="行政配置项目",
        identifier="ADMINLOCK",
        module_view=True,
        issue_views_view=True,
    )
    ProjectMember.objects.create(workspace=workspace, project=project, member=project_admin, role=20)
    module = Module.objects.create(workspace=workspace, project=project, name="已有模块")
    label = Label.objects.create(workspace=workspace, project=project, name="已有标签", color="#123456")
    view = IssueView.objects.create(
        workspace=workspace,
        project=project,
        name="已有项目视图",
        owned_by=project_admin,
    )
    view.save(created_by_id=project_admin.id)
    global_view = IssueView.objects.create(
        workspace=workspace,
        name="已有共享视图",
        owned_by=project_admin,
    )
    global_view.save(created_by_id=project_admin.id)
    research_project = Project.objects.create(
        workspace=workspace,
        name="科研项目",
        identifier="RESEARCH",
        module_view=False,
    )
    ProjectMember.objects.create(workspace=workspace, project=research_project, member=project_admin, role=20)
    ResearchProjectProfile.objects.create(workspace=workspace, project=research_project, owner=create_user)

    workspace_admin_client = APIClient()
    workspace_admin_client.force_authenticate(create_user)
    project_admin_client = APIClient()
    project_admin_client.force_authenticate(project_admin)
    project_admin_token = APIToken.objects.create(
        user=project_admin,
        label="project-admin",
        token="project-admin-token",
    )
    external_client = APIClient()
    external_client.credentials(HTTP_X_API_KEY=project_admin_token.token)

    return {
        "workspace": workspace,
        "setting": setting,
        "project": project,
        "research_project": research_project,
        "module": module,
        "label": label,
        "view": view,
        "global_view": global_view,
        "project_admin": project_admin,
        "workspace_admin_client": workspace_admin_client,
        "project_admin_client": project_admin_client,
        "external_client": external_client,
        "base": f"/api/workspaces/{workspace.slug}",
        "external_base": f"/api/v1/workspaces/{workspace.slug}",
    }


def test_context_manages_administrative_settings_lock(lock_env):
    """Only workspace or system administrators may change the lock."""
    env = lock_env
    url = f"{env['base']}/context/"

    initial = env["project_admin_client"].get(url)
    assert initial.status_code == 200, initial.data
    assert initial.data["workspace"]["administrative_settings_admin_only"] is False

    assert (
        env["project_admin_client"].patch(url, {"administrative_settings_admin_only": True}, format="json").status_code
        == 403
    )
    assert (
        env["workspace_admin_client"]
        .patch(url, {"administrative_settings_admin_only": "yes"}, format="json")
        .status_code
        == 400
    )

    enabled = env["workspace_admin_client"].patch(url, {"administrative_settings_admin_only": True}, format="json")
    assert enabled.status_code == 200, enabled.data
    assert enabled.data["workspace"]["administrative_settings_admin_only"] is True
    env["setting"].refresh_from_db()
    assert env["setting"].administrative_settings_admin_only is True


def test_lock_restricts_administrative_project_configuration(lock_env):
    """Project administrators lose only the locked feature settings."""
    env = lock_env
    env["setting"].administrative_settings_admin_only = True
    env["setting"].save(update_fields=["administrative_settings_admin_only", "updated_at"])
    project_url = f"{env['base']}/projects/{env['project'].id}/"

    for field in ("module_view", "issue_views_view", "is_module_required", "is_label_required"):
        response = env["project_admin_client"].patch(project_url, {field: False}, format="json")
        assert response.status_code == 403, response.data
        assert "已由工作区管理员锁定" in str(response.data["error"])

    unchanged = env["project_admin_client"].patch(project_url, {"name": "行政配置项目更新"}, format="json")
    assert unchanged.status_code == 200, unchanged.data
    assert unchanged.data["name"] == "行政配置项目更新"

    allowed = env["workspace_admin_client"].patch(project_url, {"module_view": False}, format="json")
    assert allowed.status_code == 200, allowed.data
    assert allowed.data["module_view"] is False


def test_lock_restricts_module_label_and_view_writes_but_keeps_reads(lock_env):
    """Existing options stay selectable while their definitions are locked."""
    env = lock_env
    env["setting"].administrative_settings_admin_only = True
    env["setting"].save(update_fields=["administrative_settings_admin_only", "updated_at"])
    project_base = f"{env['base']}/projects/{env['project'].id}"

    module_create = env["project_admin_client"].post(f"{project_base}/modules/", {"name": "新模块"}, format="json")
    module_update = env["project_admin_client"].patch(
        f"{project_base}/modules/{env['module'].id}/", {"name": "修改模块"}, format="json"
    )
    label_create = env["project_admin_client"].post(
        f"{project_base}/issue-labels/", {"name": "新标签", "color": "#654321"}, format="json"
    )
    label_update = env["project_admin_client"].patch(
        f"{project_base}/issue-labels/{env['label'].id}/", {"name": "修改标签"}, format="json"
    )
    view_create = env["project_admin_client"].post(f"{project_base}/views/", {"name": "新视图"}, format="json")
    view_update = env["project_admin_client"].patch(
        f"{project_base}/views/{env['view'].id}/", {"name": "修改视图"}, format="json"
    )
    global_view_update = env["project_admin_client"].patch(
        f"{env['base']}/views/{env['global_view'].id}/", {"name": "修改共享视图"}, format="json"
    )

    responses = [module_create, module_update, label_create, label_update, view_create, view_update, global_view_update]
    assert {response.status_code for response in responses} == {403}
    assert all("已由工作区管理员锁定" in str(response.data["error"]) for response in responses)

    assert env["project_admin_client"].get(f"{project_base}/modules/").status_code == 200
    assert env["project_admin_client"].get(f"{project_base}/issue-labels/").status_code == 200
    assert env["project_admin_client"].get(f"{project_base}/views/").status_code == 200
    assert env["project_admin_client"].get(f"{env['base']}/views/").status_code == 200

    external_module = env["external_client"].post(
        f"{env['external_base']}/projects/{env['project'].id}/modules/", {"name": "外部新模块"}, format="json"
    )
    assert external_module.status_code == 403, external_module.data


def test_research_project_and_unlocked_workspace_keep_existing_permissions(lock_env):
    """The lock applies only to administrative projects while enabled."""
    env = lock_env
    unlocked_module = env["project_admin_client"].post(
        f"{env['base']}/projects/{env['project'].id}/modules/", {"name": "解锁模块"}, format="json"
    )
    assert unlocked_module.status_code == 201, unlocked_module.data

    env["setting"].administrative_settings_admin_only = True
    env["setting"].save(update_fields=["administrative_settings_admin_only", "updated_at"])
    assert not administrative_settings_write_blocked(env["project_admin"], env["workspace"], env["research_project"])
