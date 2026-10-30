"""Project-level administrative module, label, and view lock tests."""

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
    """Create locked and unlocked administrative projects in one workspace."""
    WorkspaceResearchSetting.objects.create(workspace=workspace, module_enabled=False)
    project_admin = make_user(first_name="Project", last_name="Admin")
    project_member = make_user(first_name="Project", last_name="Member")
    WorkspaceMember.objects.create(workspace=workspace, member=project_admin, role=15)
    WorkspaceMember.objects.create(workspace=workspace, member=project_member, role=15)

    locked_project = Project.objects.create(
        workspace=workspace,
        name="锁定行政项目",
        identifier="LOCKED",
        module_view=True,
        issue_views_view=True,
        administrative_settings_admin_only=True,
    )
    unlocked_project = Project.objects.create(
        workspace=workspace,
        name="开放行政项目",
        identifier="UNLOCKED",
        module_view=True,
        issue_views_view=True,
    )
    for project in (locked_project, unlocked_project):
        ProjectMember.objects.create(workspace=workspace, project=project, member=project_admin, role=20)
        ProjectMember.objects.create(workspace=workspace, project=project, member=project_member, role=15)

    module = Module.objects.create(workspace=workspace, project=locked_project, name="已有模块")
    Label.objects.create(workspace=workspace, project=locked_project, name="已有标签", color="#123456")
    view = IssueView.objects.create(
        workspace=workspace,
        project=locked_project,
        name="已有项目视图",
        owned_by=project_member,
    )
    view.save(created_by_id=project_member.id)
    research_project = Project.objects.create(
        workspace=workspace,
        name="科研项目",
        identifier="RESEARCH",
        module_view=True,
        administrative_settings_admin_only=True,
    )
    ProjectMember.objects.create(workspace=workspace, project=research_project, member=create_user, role=20)
    ProjectMember.objects.create(workspace=workspace, project=research_project, member=project_admin, role=20)
    ProjectMember.objects.create(workspace=workspace, project=research_project, member=project_member, role=15)
    ResearchProjectProfile.objects.create(workspace=workspace, project=research_project, owner=create_user)

    workspace_admin_client = APIClient()
    workspace_admin_client.force_authenticate(create_user)
    project_admin_client = APIClient()
    project_admin_client.force_authenticate(project_admin)
    project_member_client = APIClient()
    project_member_client.force_authenticate(project_member)
    project_member_token = APIToken.objects.create(
        user=project_member,
        label="project-member",
        token="project-member-token",
    )
    external_client = APIClient()
    external_client.credentials(HTTP_X_API_KEY=project_member_token.token)

    return {
        "workspace": workspace,
        "locked_project": locked_project,
        "unlocked_project": unlocked_project,
        "research_project": research_project,
        "module": module,
        "view": view,
        "project_admin": project_admin,
        "project_member": project_member,
        "workspace_admin_client": workspace_admin_client,
        "project_admin_client": project_admin_client,
        "project_member_client": project_member_client,
        "external_client": external_client,
        "base": f"/api/workspaces/{workspace.slug}",
        "external_base": f"/api/v1/workspaces/{workspace.slug}",
    }


def test_workspace_context_no_longer_manages_project_lock(lock_env):
    """The retired workspace payload field is neither returned nor accepted."""
    env = lock_env
    url = f"{env['base']}/context/"

    initial = env["project_member_client"].get(url)
    assert initial.status_code == 200, initial.data
    assert "administrative_settings_admin_only" not in initial.data["workspace"]
    assert (
        env["workspace_admin_client"]
        .patch(url, {"administrative_settings_admin_only": True}, format="json")
        .status_code
        == 400
    )


def test_project_admin_manages_project_level_lock(lock_env):
    """Project administrators can configure each project independently."""
    env = lock_env
    locked_url = f"{env['base']}/projects/{env['locked_project'].id}/"
    unlocked_url = f"{env['base']}/projects/{env['unlocked_project'].id}/"

    locked = env["project_admin_client"].get(locked_url)
    unlocked = env["project_admin_client"].get(unlocked_url)
    assert locked.status_code == 200, locked.data
    assert unlocked.status_code == 200, unlocked.data
    assert locked.data["administrative_settings_admin_only"] is True
    assert unlocked.data["administrative_settings_admin_only"] is False

    disabled = env["project_admin_client"].patch(
        locked_url, {"administrative_settings_admin_only": False}, format="json"
    )
    assert disabled.status_code == 200, disabled.data
    assert disabled.data["administrative_settings_admin_only"] is False

    enabled = env["project_admin_client"].patch(
        locked_url, {"administrative_settings_admin_only": True}, format="json"
    )
    assert enabled.status_code == 200, enabled.data
    assert enabled.data["administrative_settings_admin_only"] is True

    invalid = env["project_admin_client"].patch(
        locked_url, {"administrative_settings_admin_only": "unsupported"}, format="json"
    )
    assert invalid.status_code == 400, invalid.data
    denied = env["project_member_client"].patch(
        unlocked_url, {"administrative_settings_admin_only": True}, format="json"
    )
    assert denied.status_code == 403, denied.data


def test_project_lock_has_independent_permission_results(lock_env):
    """Only non-administrator members are blocked in a locked administrative project."""
    env = lock_env
    assert administrative_settings_write_blocked(env["project_member"], env["locked_project"])
    assert not administrative_settings_write_blocked(env["project_member"], env["unlocked_project"])
    assert not administrative_settings_write_blocked(env["project_admin"], env["locked_project"])
    assert not administrative_settings_write_blocked(env["project_member"], env["research_project"])


def test_project_administrator_keeps_locked_configuration_fields(lock_env):
    """Project administrators remain the designated configurators after enabling the lock."""
    env = lock_env
    project_url = f"{env['base']}/projects/{env['locked_project'].id}/"

    allowed = env["project_admin_client"].patch(project_url, {"module_view": False}, format="json")
    assert allowed.status_code == 200, allowed.data
    assert allowed.data["module_view"] is False

    env["locked_project"].refresh_from_db()
    env["locked_project"].module_view = True
    env["locked_project"].save(update_fields=["module_view", "updated_at"])

    unchanged = env["project_admin_client"].patch(project_url, {"name": "锁定行政项目更新"}, format="json")
    assert unchanged.status_code == 200, unchanged.data
    assert unchanged.data["name"] == "锁定行政项目更新"


def test_lock_restricts_module_and_view_writes_but_keeps_reads(lock_env):
    """Existing options stay selectable while their definitions are locked."""
    env = lock_env
    locked_base = f"{env['base']}/projects/{env['locked_project'].id}"
    unlocked_base = f"{env['base']}/projects/{env['unlocked_project'].id}"

    locked_module = env["project_member_client"].post(f"{locked_base}/modules/", {"name": "新模块"}, format="json")
    locked_view = env["project_member_client"].post(f"{locked_base}/views/", {"name": "新视图"}, format="json")
    assert locked_module.status_code == 403, locked_module.data
    assert "已由项目管理员锁定" in str(locked_module.data["error"])
    assert locked_view.status_code == 403, locked_view.data
    assert "已由项目管理员锁定" in str(locked_view.data["error"])

    unlocked_module = env["project_member_client"].post(
        f"{unlocked_base}/modules/", {"name": "开放模块"}, format="json"
    )
    assert unlocked_module.status_code == 201, unlocked_module.data

    module_update = env["project_member_client"].patch(
        f"{locked_base}/modules/{env['module'].id}/", {"name": "修改模块"}, format="json"
    )
    view_update = env["project_member_client"].patch(
        f"{locked_base}/views/{env['view'].id}/", {"name": "修改视图"}, format="json"
    )
    assert module_update.status_code == 403, module_update.data
    assert view_update.status_code == 403, view_update.data

    label_write = env["project_member_client"].post(
        f"{locked_base}/issue-labels/", {"name": "新标签", "color": "#654321"}, format="json"
    )
    assert label_write.status_code == 403, label_write.data

    assert env["project_member_client"].get(f"{locked_base}/modules/").status_code == 200
    assert env["project_member_client"].get(f"{locked_base}/issue-labels/").status_code == 200
    assert env["project_member_client"].get(f"{locked_base}/views/").status_code == 200

    external_module = env["external_client"].post(
        f"{env['external_base']}/projects/{env['locked_project'].id}/modules/", {"name": "外部新模块"}, format="json"
    )
    assert external_module.status_code == 403, external_module.data
