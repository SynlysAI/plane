"""科研组织成员与行政人员在科研 API 上的权限边界。"""

import pytest
from rest_framework.test import APIClient

from plane.db.models import (
    AdministrativeOrganization,
    AdministrativeOrganizationMember,
    OrgUnit,
    OrgUnitMember,
    Project,
)
from plane.tests.research_fixtures import (
    add_workspace_member,
    enable_research,
    make_user,
    make_workspace,
)

pytestmark = pytest.mark.contract


def client_for(user):
    """创建以指定用户身份请求的 API 客户端。

    Args:
        user: 发起请求的用户。

    Returns:
        已通过强制认证的测试客户端。
    """
    client = APIClient()
    client.force_authenticate(user=user)
    return client


def create_org_unit(workspace, name, parent=None):
    """创建带物化路径的科研组织节点。

    Args:
        workspace: 组织所属工作区。
        name: 节点名称。
        parent: 可选父节点。

    Returns:
        已保存的组织节点。
    """
    unit = OrgUnit.objects.create(
        workspace=workspace,
        name=name,
        parent=parent,
        unit_type=OrgUnit.UnitType.ROOT if parent is None else OrgUnit.UnitType.GROUP,
        depth=parent.depth + 1 if parent else 0,
        path="",
    )
    unit.path = f"{parent.path if parent else '/'}{unit.id.hex}/"
    unit.save(update_fields=["path"])
    return unit


@pytest.fixture(autouse=True)
def research_module_on(settings):
    """开启部署级科研模块，便于单独测试开关联动。"""
    settings.RESEARCH_MODULE_ENABLED = True


@pytest.fixture
def env(db):
    """构造科研组织成员、行政组织成员和纯工作区管理员三类用户。"""
    admin = make_user(first_name="Research", last_name="Owner")
    workspace = make_workspace(admin, slug="membership-boundary")
    enable_research(workspace, research_chain_enabled=True)

    root = create_org_unit(workspace, "科研组织")
    group = create_org_unit(workspace, "材料组", root)
    OrgUnitMember.objects.create(
        workspace=workspace,
        org_unit=root,
        user=admin,
        org_role=OrgUnitMember.OrgRole.OWNER,
    )

    researcher = make_user(first_name="Researcher")
    add_workspace_member(workspace, researcher)
    OrgUnitMember.objects.create(
        workspace=workspace,
        org_unit=group,
        user=researcher,
        org_role=OrgUnitMember.OrgRole.REVIEWER,
    )

    officer = make_user(first_name="Administrative", last_name="Officer")
    add_workspace_member(workspace, officer)
    administrative_organization = AdministrativeOrganization.objects.create(
        workspace=workspace,
        name="行政办公室",
        created_by=admin,
    )
    AdministrativeOrganizationMember.objects.create(
        workspace=workspace,
        organization=administrative_organization,
        member=officer,
        role=AdministrativeOrganizationMember.Role.ADMIN,
        created_by=admin,
    )
    administrative_project = Project.objects.create(
        workspace=workspace,
        name="行政采购项目",
        identifier="ADMBOUND",
        created_by=admin,
    )
    administrative_project.administrative_organization = administrative_organization
    administrative_project.save(update_fields=["administrative_organization", "updated_at"])

    plain_admin = make_user(first_name="Plain", last_name="Admin")
    add_workspace_member(workspace, plain_admin, role=20)

    slug = workspace.slug
    return {
        "admin": admin,
        "researcher": researcher,
        "officer": officer,
        "plain_admin": plain_admin,
        "administrative_project": administrative_project,
        "identity_url": f"/api/research/workspaces/{slug}/identity/me/",
        "administrative_organizations_url": f"/api/research/workspaces/{slug}/administrative-organizations/",
        "navigation_url": f"/api/research/workspaces/{slug}/navigation/categories/",
        "research_projects_url": f"/api/research/workspaces/{slug}/projects/",
        "chains_url": f"/api/research/workspaces/{slug}/chains/",
        "plane_projects_url": f"/api/workspaces/{slug}/projects/",
    }


def test_administrative_officer_keeps_plane_and_administrative_access_only(env):
    officer_client = client_for(env["officer"])

    identity = officer_client.get(env["identity_url"])
    organizations = officer_client.get(env["administrative_organizations_url"])
    administrative_tree = officer_client.get(env["navigation_url"], {"scope": "ADMINISTRATIVE"})
    plane_projects = officer_client.get(env["plane_projects_url"])
    research_tree = officer_client.get(env["navigation_url"], {"scope": "RESEARCH"})
    research_category = officer_client.post(
        env["navigation_url"],
        {"scope": "RESEARCH", "name": "越权分类"},
        format="json",
    )
    research_projects = officer_client.get(env["research_projects_url"])
    chains = officer_client.get(env["chains_url"])

    assert identity.status_code == 200
    assert identity.json()["capabilities"]["level"] == "NONE"
    assert identity.json()["capabilities"]["nav"] == []
    assert organizations.status_code == 200
    assert administrative_tree.status_code == 200
    assert str(env["administrative_project"].id) in str(administrative_tree.json())
    assert plane_projects.status_code == 200
    assert research_tree.status_code == 403
    assert research_category.status_code == 403
    assert research_projects.status_code == 403
    assert chains.status_code == 403


def test_workspace_administrator_without_org_relation_has_research_admin_access(env):
    """工作区管理员无需科研组织关系即拥有科研最高权限。"""
    client = client_for(env["plain_admin"])

    identity = client.get(env["identity_url"])
    research_tree = client.get(env["navigation_url"], {"scope": "RESEARCH"})
    research_projects = client.get(env["research_projects_url"])
    chains = client.get(env["chains_url"])

    assert identity.status_code == 200
    assert identity.json()["user"]["is_workspace_admin"] is True
    assert identity.json()["user"]["is_research_admin"] is True
    assert identity.json()["user"]["org_units"] == []
    assert identity.json()["capabilities"]["level"] == "ADMIN"
    assert research_tree.status_code == 200
    assert research_projects.status_code == 200
    assert chains.status_code == 200


def test_active_org_member_keeps_research_access(env):
    client = client_for(env["researcher"])

    identity = client.get(env["identity_url"])
    research_tree = client.get(env["navigation_url"], {"scope": "RESEARCH"})
    research_projects = client.get(env["research_projects_url"])
    chains = client.get(env["chains_url"])
    administrative_tree = client.get(env["navigation_url"], {"scope": "ADMINISTRATIVE"})

    assert identity.status_code == 200
    assert identity.json()["capabilities"]["level"] == "RESEARCHER"
    assert research_tree.status_code == 200
    assert research_projects.status_code == 200
    assert chains.status_code == 200
    assert administrative_tree.status_code == 200


def test_administrative_api_survives_research_module_switch(env, settings):
    settings.RESEARCH_MODULE_ENABLED = False
    client = client_for(env["officer"])

    identity = client.get(env["identity_url"])
    organizations = client.get(env["administrative_organizations_url"])
    administrative_tree = client.get(env["navigation_url"], {"scope": "ADMINISTRATIVE"})
    research_tree = client.get(env["navigation_url"], {"scope": "RESEARCH"})
    research_projects = client.get(env["research_projects_url"])

    assert identity.status_code == 200
    assert organizations.status_code == 200
    assert administrative_tree.status_code == 200
    assert research_tree.status_code == 404
    assert research_projects.status_code == 404
