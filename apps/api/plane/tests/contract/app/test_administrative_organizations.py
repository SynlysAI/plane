"""验证行政组织的迁移、权限和项目归属行为。"""

from unittest.mock import patch
from pathlib import Path
import runpy
from uuid import uuid4

import pytest
from django.apps import apps
from django.utils import timezone
from rest_framework.test import APIClient

from plane.db.models import (
    AdministrativeOrganization,
    AdministrativeOrganizationMember,
    Project,
    ProjectMember,
    ProjectNavigationCategory,
    ResearchProjectProfile,
    WorkspaceMember,
)
from plane.tests.research_fixtures import (
    add_workspace_member,
    enable_research,
    make_user,
    make_workspace,
)

pytestmark = [pytest.mark.contract, pytest.mark.django_db]

MIGRATION_PATH = (
    Path(__file__).resolve().parents[4] / "plane" / "db" / "migrations" / "0171_administrative_organizations.py"
)


def client_for(user):
    """返回已认证的 API 客户端。"""
    client = APIClient()
    client.force_authenticate(user=user)
    return client


@pytest.fixture
def env():
    """创建行政组织测试所需的工作区、用户、组织和项目。"""
    owner = make_user(first_name="Organization", last_name="Owner")
    workspace = make_workspace(owner, name=f"Administrative organization {uuid4().hex[:6]}")
    enable_research(workspace)
    default = AdministrativeOrganization.objects.get(workspace=workspace, is_default=True)
    organization = AdministrativeOrganization.objects.create(workspace=workspace, name="行政服务中心", created_by=owner)
    target = AdministrativeOrganization.objects.create(workspace=workspace, name="科研保障中心", created_by=owner)
    organization_admin = make_user(first_name="Organization", last_name="Admin")
    organization_member = make_user(first_name="Organization", last_name="Member")
    ordinary_member = make_user(first_name="Ordinary", last_name="Member")
    for user in (organization_admin, organization_member, ordinary_member):
        add_workspace_member(workspace, user)
    AdministrativeOrganizationMember.objects.create(
        workspace=workspace,
        organization=organization,
        member=organization_admin,
        role=AdministrativeOrganizationMember.Role.ADMIN,
        created_by=owner,
    )
    AdministrativeOrganizationMember.objects.create(
        workspace=workspace,
        organization=target,
        member=organization_admin,
        role=AdministrativeOrganizationMember.Role.ADMIN,
        created_by=owner,
    )
    AdministrativeOrganizationMember.objects.create(
        workspace=workspace,
        organization=organization,
        member=organization_member,
        role=AdministrativeOrganizationMember.Role.MEMBER,
        created_by=owner,
    )
    project = Project.objects.create(
        workspace=workspace,
        name="固定资产盘点",
        identifier=f"AO{uuid4().hex[:6].upper()}",
        administrative_organization=organization,
        created_by=owner,
    )
    return {
        "owner": owner,
        "workspace": workspace,
        "default": default,
        "organization": organization,
        "target": target,
        "organization_admin": organization_admin,
        "organization_member": organization_member,
        "ordinary_member": ordinary_member,
        "project": project,
        "owner_client": client_for(owner),
        "admin_client": client_for(organization_admin),
        "member_client": client_for(organization_member),
        "ordinary_client": client_for(ordinary_member),
    }


@pytest.fixture(autouse=True)
def no_async_side_effects():
    """屏蔽项目详情和创建流程中的异步任务。"""
    with (
        patch("plane.app.views.project.base.recent_visited_task.delay"),
        patch("plane.app.views.project.base.model_activity.delay"),
    ):
        yield


def test_migration_creates_default_and_flattens_legacy_categories(workspace, create_user):
    """迁移创建唯一默认组织，并按路径保留旧行政分类归属。"""
    root = ProjectNavigationCategory.objects.create(
        workspace=workspace,
        scope=ProjectNavigationCategory.Scope.ADMINISTRATIVE,
        name="行政服务",
        created_by=create_user,
    )
    child = ProjectNavigationCategory.objects.create(
        workspace=workspace,
        scope=ProjectNavigationCategory.Scope.ADMINISTRATIVE,
        name="财务",
        parent=root,
        created_by=create_user,
    )
    path_prefix = ProjectNavigationCategory.objects.create(
        workspace=workspace,
        scope=ProjectNavigationCategory.Scope.ADMINISTRATIVE,
        name="路径",
        created_by=create_user,
    )
    path_leaf = ProjectNavigationCategory.objects.create(
        workspace=workspace,
        scope=ProjectNavigationCategory.Scope.ADMINISTRATIVE,
        name="叶子",
        parent=path_prefix,
        created_by=create_user,
    )
    literal_path = ProjectNavigationCategory.objects.create(
        workspace=workspace,
        scope=ProjectNavigationCategory.Scope.ADMINISTRATIVE,
        name="路径 / 叶子",
        created_by=create_user,
    )
    root_project = Project.objects.create(
        workspace=workspace,
        name=" root project ",
        identifier=f"MG{uuid4().hex[:6].upper()}",
        navigation_category=root,
        created_by=create_user,
    )
    child_project = Project.objects.create(
        workspace=workspace,
        name="child project",
        identifier=f"MC{uuid4().hex[:6].upper()}",
        navigation_category=child,
        created_by=create_user,
    )
    path_leaf_project = Project.objects.create(
        workspace=workspace,
        name="path leaf project",
        identifier=f"ML{uuid4().hex[:6].upper()}",
        navigation_category=path_leaf,
        created_by=create_user,
    )
    literal_path_project = Project.objects.create(
        workspace=workspace,
        name="literal path project",
        identifier=f"MT{uuid4().hex[:6].upper()}",
        navigation_category=literal_path,
        created_by=create_user,
    )
    default_project = Project.objects.create(
        workspace=workspace,
        name="default project",
        identifier=f"MD{uuid4().hex[:6].upper()}",
        created_by=create_user,
    )
    research_project = Project.objects.create(
        workspace=workspace,
        name="research project",
        identifier=f"MR{uuid4().hex[:6].upper()}",
        navigation_category=root,
        created_by=create_user,
    )
    ResearchProjectProfile.objects.create(
        workspace=workspace,
        project=research_project,
        owner=create_user,
        created_by=create_user,
    )

    migration = runpy.run_path(str(MIGRATION_PATH))
    migration["create_administrative_organizations"](apps, None)
    migration["create_administrative_organizations"](apps, None)

    defaults = AdministrativeOrganization.objects.filter(workspace=workspace, is_default=True)
    assert defaults.count() == 1
    default = defaults.get()
    assert default.name == "默认"
    root_project.refresh_from_db()
    child_project.refresh_from_db()
    default_project.refresh_from_db()
    research_project.refresh_from_db()
    path_leaf_project.refresh_from_db()
    literal_path_project.refresh_from_db()
    assert root_project.administrative_organization.name == "行政服务"
    assert child_project.administrative_organization.name == "行政服务 / 财务"
    assert default_project.administrative_organization == default
    assert research_project.administrative_organization is None
    assert path_leaf_project.administrative_organization.name == "路径 / 叶子"
    assert literal_path_project.administrative_organization.name == "路径 / 叶子 (2)"
    assert not ProjectNavigationCategory.objects.filter(
        workspace=workspace,
        scope=ProjectNavigationCategory.Scope.ADMINISTRATIVE,
        deleted_at__isnull=True,
    ).exists()


def test_organization_membership_grants_and_revokes_inherited_read_access(env):
    """组织成员可读项目但不能编辑；移出后显式项目权限仍保留。"""
    slug = env["workspace"].slug
    project_url = f"/api/workspaces/{slug}/projects/{env['project'].id}/"

    assert env["member_client"].get(project_url).status_code == 200
    assert env["member_client"].patch(project_url, {"name": "越权修改"}, format="json").status_code == 403

    ProjectMember.objects.create(
        workspace=env["workspace"],
        project=env["project"],
        member=env["organization_member"],
        role=5,
        created_by=env["owner"],
    )
    relation = AdministrativeOrganizationMember.objects.get(
        organization=env["organization"], member=env["organization_member"]
    )
    relation.is_active = False
    relation.deleted_at = timezone.now()
    relation.save(update_fields=["is_active", "deleted_at", "updated_at"])

    assert env["member_client"].get(project_url).status_code == 200
    other_project = Project.objects.create(
        workspace=env["workspace"],
        name="仅组织可见",
        identifier=f"OO{uuid4().hex[:6].upper()}",
        administrative_organization=env["organization"],
        created_by=env["owner"],
    )
    assert env["member_client"].get(f"/api/workspaces/{slug}/projects/{other_project.id}/").status_code == 403


def test_project_organization_assignment_requires_organization_admin(env):
    """普通成员不能把新项目挂到任意组织；组织管理员和默认归属可用。"""
    slug = env["workspace"].slug
    denied = env["ordinary_client"].post(
        f"/api/workspaces/{slug}/projects/",
        {
            "name": "越权归属项目",
            "identifier": f"DA{uuid4().hex[:6].upper()}",
            "administrative_organization": str(env["organization"].id),
        },
        format="json",
    )
    assert denied.status_code == 400
    assert "administrative_organization" in denied.json()

    allowed = env["admin_client"].post(
        f"/api/workspaces/{slug}/projects/",
        {
            "name": "组织归属项目",
            "identifier": f"AA{uuid4().hex[:6].upper()}",
            "administrative_organization": str(env["organization"].id),
        },
        format="json",
    )
    assert allowed.status_code == 201, allowed.json()
    assert Project.objects.get(pk=allowed.json()["id"]).administrative_organization == env["organization"]

    default_project = env["ordinary_client"].post(
        f"/api/workspaces/{slug}/projects/",
        {
            "name": "默认归属项目",
            "identifier": f"AD{uuid4().hex[:6].upper()}",
        },
        format="json",
    )
    assert default_project.status_code == 201, default_project.json()
    assert Project.objects.get(pk=default_project.json()["id"]).administrative_organization == env["default"]


def test_project_and_new_organization_are_created_atomically(env):
    """创建项目时新建组织与项目同事务，项目失败不遗留组织。"""
    slug = env["workspace"].slug
    organization_count = AdministrativeOrganization.objects.filter(workspace=env["workspace"]).count()
    payload = {
        "name": "原子组织项目",
        "identifier": f"NO{uuid4().hex[:6].upper()}",
        "new_administrative_organization": "流程改革办公室",
    }
    created = env["owner_client"].post(f"/api/workspaces/{slug}/projects/", payload, format="json")
    assert created.status_code == 201, created.json()
    organization = AdministrativeOrganization.objects.get(workspace=env["workspace"], name="流程改革办公室")
    assert organization.projects.filter(pk=created.json()["id"]).exists()
    assert AdministrativeOrganizationMember.objects.filter(
        organization=organization,
        member=env["owner"],
        role=AdministrativeOrganizationMember.Role.ADMIN,
        is_active=True,
    ).exists()

    failed = env["owner_client"].post(
        f"/api/workspaces/{slug}/projects/",
        {**payload, "identifier": f"NF{uuid4().hex[:6].upper()}"},
        format="json",
    )
    assert failed.status_code == 400
    assert AdministrativeOrganization.objects.filter(workspace=env["workspace"]).count() == organization_count + 1

    denied = env["ordinary_client"].post(
        f"/api/workspaces/{slug}/projects/",
        {
            "name": "越权原子组织项目",
            "identifier": f"ND{uuid4().hex[:6].upper()}",
            "new_administrative_organization": "成员自建组织",
        },
        format="json",
    )
    assert denied.status_code == 400
    assert not AdministrativeOrganization.objects.filter(workspace=env["workspace"], name="成员自建组织").exists()


def test_organization_member_management_and_rejoin(env):
    """组织管理员可管理成员；软删除后的成员可重新加入。"""
    slug = env["workspace"].slug
    members_url = f"/api/research/workspaces/{slug}/administrative-organizations/{env['organization'].id}/members/"
    assert env["ordinary_client"].get(members_url).status_code == 403
    assert env["admin_client"].get(members_url).status_code == 200

    added = env["admin_client"].post(
        members_url,
        {"member": str(env["ordinary_member"].id), "role": "MEMBER"},
        format="json",
    )
    assert added.status_code == 201, added.json()
    relation = AdministrativeOrganizationMember.objects.get(
        organization=env["organization"], member=env["ordinary_member"]
    )
    relation.is_active = False
    relation.deleted_at = timezone.now()
    relation.save(update_fields=["is_active", "deleted_at", "updated_at"])

    rejoined = env["admin_client"].post(
        members_url,
        {"member": str(env["ordinary_member"].id), "role": "ADMIN"},
        format="json",
    )
    assert rejoined.status_code == 200, rejoined.json()
    relation.refresh_from_db()
    assert relation.is_active is True
    assert relation.deleted_at is None
    assert relation.role == AdministrativeOrganizationMember.Role.ADMIN


def test_workspace_removal_deactivates_organization_membership(env):
    """移出工作区会撤销组织身份，重新加入工作区不自动恢复。"""
    membership = WorkspaceMember.objects.get(workspace=env["workspace"], member=env["organization_member"])
    membership.deleted_at = timezone.now()
    membership.save(update_fields=["deleted_at", "updated_at"])
    relation = AdministrativeOrganizationMember.all_objects.get(
        organization=env["organization"], member=env["organization_member"]
    )
    assert relation.is_active is False
    assert relation.deleted_at is not None

    membership.deleted_at = None
    membership.save(update_fields=["deleted_at", "updated_at"])
    relation.refresh_from_db()
    assert relation.is_active is False
    assert relation.deleted_at is not None


def test_default_organization_and_project_move_boundaries(env):
    """默认组织不可改名或删除；项目移动遵守组织管理边界。"""
    slug = env["workspace"].slug
    default_url = f"/api/research/workspaces/{slug}/administrative-organizations/{env['default'].id}/"
    assert env["owner_client"].patch(default_url, {"name": "新默认"}, format="json").status_code == 409
    assert env["owner_client"].delete(f"{default_url}?move_to={env['target'].id}").status_code == 409

    move_url = f"/api/research/workspaces/{slug}/administrative-projects/{env['project'].id}/organization/"
    denied = env["ordinary_client"].post(move_url, {"organization": str(env["target"].id)}, format="json")
    assert denied.status_code == 403

    moved = env["admin_client"].post(move_url, {"organization": str(env["target"].id)}, format="json")
    assert moved.status_code == 200, moved.json()
    env["project"].refresh_from_db()
    assert env["project"].administrative_organization == env["target"]

    moved_default = env["admin_client"].post(move_url, {"organization": None}, format="json")
    assert moved_default.status_code == 200, moved_default.json()
    env["project"].refresh_from_db()
    assert env["project"].administrative_organization == env["default"]
