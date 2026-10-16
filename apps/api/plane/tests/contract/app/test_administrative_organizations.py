"""验证行政组织的迁移、权限和项目归属行为。"""

from unittest.mock import patch
from pathlib import Path
import re
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
    ProjectIdentifier,
    ProjectNetwork,
    ProjectMember,
    ProjectNavigationCategory,
    ResearchChain,
    ResearchProjectProfile,
    State,
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
PUBLIC_MIGRATION_PATH = (
    Path(__file__).resolve().parents[4]
    / "plane"
    / "db"
    / "migrations"
    / "0175_rename_default_administrative_organization.py"
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
    assert default.name == "公共"
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


def test_public_migration_renames_default_and_disables_its_members(workspace, create_user):
    """公共组织迁移处理名称冲突并移除无效的默认组织成员。"""
    default = AdministrativeOrganization.objects.get(workspace=workspace, is_default=True)
    default.name = "默认"
    default.save(update_fields=["name", "updated_at"])
    conflicting = AdministrativeOrganization.objects.create(
        workspace=workspace,
        name="公共",
        created_by=create_user,
    )
    for organization in (default, conflicting):
        AdministrativeOrganizationMember.objects.create(
            workspace=workspace,
            organization=organization,
            member=create_user,
            role=AdministrativeOrganizationMember.Role.ADMIN,
            created_by=create_user,
        )

    migration = runpy.run_path(str(PUBLIC_MIGRATION_PATH))
    migration["rename_default_administrative_organizations"](apps, None)

    default.refresh_from_db()
    conflicting.refresh_from_db()
    assert default.name == "公共"
    assert conflicting.name == "公共 (2)"
    assert not AdministrativeOrganizationMember.objects.filter(
        organization=default, is_active=True, deleted_at__isnull=True
    ).exists()
    assert AdministrativeOrganizationMember.objects.filter(
        organization=conflicting, is_active=True, deleted_at__isnull=True
    ).exists()


def test_public_organization_grants_every_workspace_member_edit_role(env):
    """公共组织项目对所有有效工作区成员呈现为可编辑成员角色。"""
    public_project = Project.objects.create(
        workspace=env["workspace"],
        name="公共行政项目",
        identifier=f"PU{uuid4().hex[:6].upper()}",
        administrative_organization=env["default"],
        created_by=env["owner"],
    )
    slug = env["workspace"].slug

    detail = env["ordinary_client"].get(f"/api/workspaces/{slug}/projects/{public_project.id}/")
    assert detail.status_code == 200, detail.data

    projects = env["ordinary_client"].get(f"/api/workspaces/{slug}/projects/", {"scope": "administrative"})
    assert projects.status_code == 200, projects.data
    row = next(item for item in projects.data if str(item["id"]) == str(public_project.id))
    assert row["member_role"] == 15

    renamed = env["ordinary_client"].patch(
        f"/api/workspaces/{slug}/projects/{public_project.id}/",
        {"description": "普通成员不能获得项目管理员权限"},
        format="json",
    )
    assert renamed.status_code == 403

    State.objects.create(
        name="Todo",
        project=public_project,
        workspace=env["workspace"],
        group="unstarted",
        default=True,
    )
    with (
        patch("plane.app.views.issue.base.issue_activity.delay"),
        patch("plane.app.views.issue.base.model_activity.delay"),
        patch("plane.app.views.issue.base.issue_description_version_task.delay"),
    ):
        issue = env["ordinary_client"].post(
            f"/api/workspaces/{slug}/projects/{public_project.id}/issues/",
            {"name": "公共项目工作项"},
            format="json",
        )
    assert issue.status_code == 201, issue.data


def test_public_organization_rejects_member_management(env):
    """公共组织权限来自工作区成员身份，不再提供成员管理。"""
    slug = env["workspace"].slug
    members_url = f"/api/research/workspaces/{slug}/administrative-organizations/{env['default'].id}/members/"

    assert env["owner_client"].get(members_url).status_code == 409
    assert (
        env["owner_client"]
        .post(
            members_url,
            {"member": str(env["ordinary_member"].id), "role": "MEMBER"},
            format="json",
        )
        .status_code
        == 409
    )

    organizations = env["owner_client"].get(f"/api/research/workspaces/{slug}/administrative-organizations/")
    assert organizations.status_code == 200
    public = next(item for item in organizations.data if item["is_default"])
    assert public["name"] == "公共"
    assert public["members"] == []


def test_secret_project_in_public_organization_stays_workspace_invisible(env):
    """公共组织不越过 Plane 项目的 Secret 网络边界。"""
    secret_project = Project.objects.create(
        workspace=env["workspace"],
        name="公共组织私有项目",
        identifier=f"PS{uuid4().hex[:6].upper()}",
        network=ProjectNetwork.SECRET.value,
        administrative_organization=env["default"],
        created_by=env["owner"],
    )
    slug = env["workspace"].slug

    detail = env["ordinary_client"].get(f"/api/workspaces/{slug}/projects/{secret_project.id}/")
    projects = env["ordinary_client"].get(f"/api/workspaces/{slug}/projects/", {"scope": "administrative"})

    assert detail.status_code == 403
    assert projects.status_code == 200
    assert all(str(item["id"]) != str(secret_project.id) for item in projects.data)


def test_workspace_members_can_create_organizations_and_become_admins(env):
    """有效工作区成员可创建行政组织并自动成为组织管理员。"""
    slug = env["workspace"].slug
    organizations_url = f"/api/research/workspaces/{slug}/administrative-organizations/"

    created = env["ordinary_client"].post(organizations_url, {"name": "成员自建协作组"}, format="json")
    assert created.status_code == 201, created.json()
    organization = AdministrativeOrganization.objects.get(workspace=env["workspace"], name="成员自建协作组")
    assert created.json()["id"] == str(organization.id)
    assert created.json()["can_manage"] is True
    assert AdministrativeOrganizationMember.objects.filter(
        organization=organization,
        member=env["ordinary_member"],
        role=AdministrativeOrganizationMember.Role.ADMIN,
        is_active=True,
    ).exists()

    invalid = env["ordinary_client"].post(
        organizations_url,
        {"name": AdministrativeOrganization.PUBLIC_NAME},
        format="json",
    )
    assert invalid.status_code == 422
    duplicated = env["ordinary_client"].post(organizations_url, {"name": "成员自建协作组"}, format="json")
    assert duplicated.status_code == 409

    assert APIClient().post(organizations_url, {"name": "匿名组织"}, format="json").status_code == 401
    outsider = client_for(make_user(first_name="Outsider", last_name="Member"))
    denied = outsider.post(organizations_url, {"name": "外部成员组织"}, format="json")
    assert denied.status_code == 404
    assert not AdministrativeOrganization.objects.filter(workspace=env["workspace"], name="外部成员组织").exists()


def test_organization_list_visibility_follows_membership(env):
    """非管理员仅见公共与本人所属组织；组织管理员可管理所属组织。"""
    slug = env["workspace"].slug
    organizations_url = f"/api/research/workspaces/{slug}/administrative-organizations/"

    ordinary = env["ordinary_client"].get(organizations_url)
    assert ordinary.status_code == 200
    assert [item["name"] for item in ordinary.json()] == ["公共"]

    organization_admin = env["admin_client"].get(organizations_url)
    assert organization_admin.status_code == 200
    admin_names = {item["name"] for item in organization_admin.json()}
    assert admin_names == {"公共", "行政服务中心", "科研保障中心"}
    managed = {item["name"]: item["can_manage"] for item in organization_admin.json()}
    assert managed["行政服务中心"] is True
    assert managed["科研保障中心"] is True
    assert managed["公共"] is False

    owner = env["owner_client"].get(organizations_url)
    assert owner.status_code == 200
    assert {item["name"] for item in owner.json()} == {"公共", "行政服务中心", "科研保障中心"}


def test_deleted_project_names_and_identifiers_can_be_reused(env):
    """软删除项目不再占用名称与标识符。"""
    slug = env["workspace"].slug
    first = env["ordinary_client"].post(
        f"/api/workspaces/{slug}/projects/",
        {
            "name": "可复用名称",
            "identifier": f"RP{uuid4().hex[:4].upper()}",
            "administrative_organization": str(env["default"].id),
        },
        format="json",
    )
    assert first.status_code == 201, first.json()
    deleted_at = timezone.now()
    Project.objects.filter(pk=first.json()["id"]).update(deleted_at=deleted_at)
    ProjectIdentifier.objects.filter(project_id=first.json()["id"]).update(deleted_at=deleted_at)

    reused = env["member_client"].post(
        f"/api/workspaces/{slug}/projects/",
        {
            "name": "可复用名称",
            "identifier": first.json()["identifier"],
            "administrative_organization": str(env["default"].id),
        },
        format="json",
    )
    assert reused.status_code == 201, reused.json()
    Project.objects.filter(pk__in=[first.json()["id"], reused.json()["id"]]).delete()


def test_duplicate_names_and_generated_identifiers(env):
    """同名行政项目允许重复；缺省编号自动生成唯一 PRJ 编号。"""
    slug = env["workspace"].slug
    created_ids = []
    for organization in (env["organization"], env["organization"], env["target"]):
        response = env["admin_client"].post(
            f"/api/workspaces/{slug}/projects/",
            {
                "name": "同名行政项目",
                "administrative_organization": str(organization.id),
            },
            format="json",
        )
        assert response.status_code == 201, response.json()
        created_ids.append(response.json()["id"])
        assert re.fullmatch(r"PRJ[0-9A-F]{6}", response.json()["identifier"])
        assert ProjectIdentifier.objects.filter(
            workspace=env["workspace"], project_id=response.json()["id"], name=response.json()["identifier"]
        ).exists()

    identifiers = [Project.objects.get(pk=project_id).identifier for project_id in created_ids]
    assert len(set(identifiers)) == len(identifiers)
    Project.objects.filter(id__in=created_ids).delete()


def test_explicit_identifier_stays_unique(env):
    """显式传入的编号仍按工作区查重。"""
    slug = env["workspace"].slug
    payload = {
        "name": "显式编号项目",
        "identifier": "EXPLCT01",
        "administrative_organization": str(env["default"].id),
    }
    first = env["owner_client"].post(f"/api/workspaces/{slug}/projects/", payload, format="json")
    assert first.status_code == 201, first.json()

    duplicated = env["owner_client"].post(
        f"/api/workspaces/{slug}/projects/",
        {**payload, "name": "显式编号项目二"},
        format="json",
    )
    assert duplicated.status_code == 400
    assert "identifier" in duplicated.json()
    Project.objects.filter(pk=first.json()["id"]).delete()


def test_explicit_identifier_checks_project_identifier_ledger_drift(env):
    """编号表漂移时，显式编号也必须在保存前返回可处理错误。"""
    slug = env["workspace"].slug
    first = env["owner_client"].post(
        f"/api/workspaces/{slug}/projects/",
        {
            "name": "编号漂移项目",
            "identifier": "DRIFT01",
            "administrative_organization": str(env["default"].id),
        },
        format="json",
    )
    assert first.status_code == 201, first.json()
    project = Project.objects.get(pk=first.json()["id"])
    project.identifier = "DRIFTXX"
    project.save(update_fields=["identifier", "updated_at"])

    duplicated = env["owner_client"].post(
        f"/api/workspaces/{slug}/projects/",
        {
            "name": "编号漂移复用项目",
            "identifier": "DRIFT01",
            "administrative_organization": str(env["default"].id),
        },
        format="json",
    )

    assert duplicated.status_code == 400
    assert "identifier" in duplicated.json()


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


def test_secret_project_in_organization_stays_private_to_members(env):
    """私有项目不向组织成员开放：组织挂靠只是归属分类，不产生访问权限。"""
    slug = env["workspace"].slug
    project = Project.objects.create(
        workspace=env["workspace"],
        name="私有挂组织",
        identifier=f"SP{uuid4().hex[:6].upper()}",
        network=ProjectNetwork.SECRET.value,
        administrative_organization=env["organization"],
        created_by=env["owner"],
    )
    base = f"/api/workspaces/{slug}/projects/{project.id}/"

    # 组织成员：不可读、不在角色地图、不出现在项目列表。
    assert env["member_client"].get(base).status_code == 403
    roles = env["member_client"].get(f"/api/users/me/workspaces/{slug}/project-roles/")
    assert str(project.id) not in roles.json()
    listed = env["member_client"].get(f"/api/workspaces/{slug}/projects/")
    assert all(str(row["id"]) != str(project.id) for row in listed.json())

    # 显式成员仍然可读（私有项目的访问只来自显式授权）。
    ProjectMember.objects.create(
        workspace=env["workspace"],
        project=project,
        member=env["organization_member"],
        role=5,
        created_by=env["owner"],
    )
    assert env["member_client"].get(base).status_code == 200


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
            "administrative_organization": str(env["default"].id),
        },
        format="json",
    )
    assert default_project.status_code == 201, default_project.json()
    assert Project.objects.get(pk=default_project.json()["id"]).administrative_organization == env["default"]

    missing_organization = env["ordinary_client"].post(
        f"/api/workspaces/{slug}/projects/",
        {
            "name": "缺少归属项目",
            "identifier": f"MI{uuid4().hex[:6].upper()}",
        },
        format="json",
    )
    assert missing_organization.status_code == 400
    assert "administrative_organization" in missing_organization.json()


def test_project_and_new_organization_are_created_atomically_for_members(env):
    """普通成员创建项目时可新建组织；失败请求不遗留组织。"""
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

    member_created = env["ordinary_client"].post(
        f"/api/workspaces/{slug}/projects/",
        {
            "name": "成员原子组织项目",
            "identifier": f"ND{uuid4().hex[:6].upper()}",
            "new_administrative_organization": "成员自建组织",
        },
        format="json",
    )
    assert member_created.status_code == 201, member_created.json()
    member_organization = AdministrativeOrganization.objects.get(workspace=env["workspace"], name="成员自建组织")
    assert member_organization.projects.filter(pk=member_created.json()["id"]).exists()
    assert AdministrativeOrganizationMember.objects.filter(
        organization=member_organization,
        member=env["ordinary_member"],
        role=AdministrativeOrganizationMember.Role.ADMIN,
        is_active=True,
    ).exists()


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


def test_organization_deletion_requires_and_moves_projects(env):
    """删除组织必须显式指定迁移目标；成功后项目迁移、组织软删。"""
    slug = env["workspace"].slug
    delete_url = f"/api/research/workspaces/{slug}/administrative-organizations/{env['organization'].id}/"

    missing = env["admin_client"].delete(delete_url)
    assert missing.status_code == 400
    assert missing.json()["message"] == "move_to is required."

    self_target = env["admin_client"].delete(f"{delete_url}?move_to={env['organization'].id}")
    assert self_target.status_code == 422

    deleted = env["admin_client"].delete(f"{delete_url}?move_to={env['target'].id}")
    assert deleted.status_code == 204
    env["project"].refresh_from_db()
    assert env["project"].administrative_organization == env["target"]
    env["organization"].refresh_from_db()
    assert env["organization"].deleted_at is not None


def test_organization_deletion_requires_target_organization_admin(env):
    """源组织管理员不能把项目迁往自己仅有成员身份的目标组织。"""
    slug = env["workspace"].slug
    target_relation = AdministrativeOrganizationMember.objects.get(
        organization=env["target"], member=env["organization_admin"]
    )
    target_relation.role = AdministrativeOrganizationMember.Role.MEMBER
    target_relation.save(update_fields=["role", "updated_at"])
    delete_url = f"/api/research/workspaces/{slug}/administrative-organizations/{env['organization'].id}/"

    denied = env["admin_client"].delete(f"{delete_url}?move_to={env['target'].id}")

    assert denied.status_code == 403
    env["organization"].refresh_from_db()
    assert env["organization"].deleted_at is None
    env["project"].refresh_from_db()
    assert env["project"].administrative_organization == env["organization"]


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


def test_soft_deleted_research_chain_cannot_join_administrative_organization(env):
    """研究链软删除后仍保留科研生命周期边界，不能转行政归属。"""
    project = Project.objects.create(
        workspace=env["workspace"],
        name="已归档研究链项目",
        identifier=f"SC{uuid4().hex[:6].upper()}",
        created_by=env["owner"],
    )
    chain = ResearchChain.objects.create(
        project=project,
        workspace=env["workspace"],
        owner=env["owner"],
        request_id=f"soft-chain-{uuid4()}",
        payload_hash=f"soft-chain-{uuid4()}",
    )
    chain.deleted_at = timezone.now()
    chain.save(update_fields=["deleted_at", "updated_at"])

    response = env["owner_client"].post(
        f"/api/research/workspaces/{env['workspace'].slug}/administrative-projects/{project.id}/organization/",
        {"organization": str(env["target"].id)},
        format="json",
    )

    assert response.status_code == 404
    project.refresh_from_db()
    assert project.administrative_organization is None
