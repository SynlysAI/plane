"""Contract coverage for scoped project navigation categories."""

from uuid import uuid4

import pytest
from rest_framework.test import APIClient

from plane.db.models import (
    OrgUnit,
    Project,
    ProjectMember,
    ProjectNavigationCategory,
    ResearchProjectProfile,
)
from plane.tests.research_fixtures import add_workspace_member, enable_research, make_user, make_workspace

pytestmark = pytest.mark.contract


def client_for(user):
    """Create an API client authenticated as the supplied user.

    Args:
        user: The user on whose behalf requests are made.

    Returns:
        An authenticated DRF test client.
    """
    client = APIClient()
    client.force_authenticate(user=user)
    return client


@pytest.fixture(autouse=True)
def research_module_on(settings):
    """Keep the research module enabled for every navigation contract."""
    settings.RESEARCH_MODULE_ENABLED = True


def create_unit(workspace, name, parent=None):
    """Create an OrgUnit with the materialized path used in production.

    Args:
        workspace: The owning workspace.
        name: The unit display name.
        parent: The optional parent unit.

    Returns:
        The saved organization unit.
    """
    unit = OrgUnit.objects.create(
        workspace=workspace,
        name=name,
        parent=parent,
        unit_type=OrgUnit.UnitType.GROUP if parent else OrgUnit.UnitType.ROOT,
        depth=parent.depth + 1 if parent else 0,
        path="",
    )
    unit.path = f"{parent.path if parent else '/'}{unit.id.hex}/"
    unit.save(update_fields=["path"])
    return unit


@pytest.fixture
def navigation_env(db):
    """Create a workspace, visible research/admin projects, and an org path."""
    admin = make_user(first_name="Navigation Admin")
    workspace = make_workspace(admin)
    enable_research(workspace, research_chain_enabled=True)
    member = make_user(first_name="Navigation Member")
    add_workspace_member(workspace, member)

    root = create_unit(workspace, "前沿材料研究院")
    lab = create_unit(workspace, "分子材料实验室", root)
    group = create_unit(workspace, "界面催化组", lab)

    research_project = Project.objects.create(
        workspace=workspace,
        name="催化剂界面失活机理研究",
        identifier=uuid4().hex[:10].upper(),
        created_by=member,
    )
    ResearchProjectProfile.objects.create(
        workspace=workspace,
        project=research_project,
        owner=member,
        org_unit=group,
        chain_kind=ResearchProjectProfile.ChainKind.RESEARCH_CHAIN,
        chain_visibility=ResearchProjectProfile.ChainVisibility.WORKSPACE,
        workflow_status=ResearchProjectProfile.WorkflowStatus.ACTIVE,
        created_by=member,
    )
    ProjectMember.objects.create(
        project=research_project, workspace=workspace, member=member, role=15
    )

    administrative_project = Project.objects.create(
        workspace=workspace,
        name="设备采购协作",
        identifier=uuid4().hex[:10].upper(),
        created_by=admin,
    )

    return {
        "workspace": workspace,
        "admin": admin,
        "member": member,
        "root": root,
        "lab": lab,
        "group": group,
        "research_project": research_project,
        "administrative_project": administrative_project,
        "admin_client": client_for(admin),
        "member_client": client_for(member),
        "url": f"/api/research/workspaces/{workspace.slug}/navigation/categories/",
        "move_url": f"/api/research/workspaces/{workspace.slug}/navigation/projects/",
    }


def tree_node(nodes, name):
    """Find a node by name in a shallow navigation payload.

    Args:
        nodes: The category payload list.
        name: The category name.

    Returns:
        The first matching node, or ``None``.
    """
    return next((node for node in nodes if node["name"] == name), None)


def find_node(nodes, name):
    """Depth-first search for a navigation node by name.

    Args:
        nodes: The current navigation node list.
        name: The node name.

    Returns:
        The first matching node at any depth, or ``None``.
    """
    for node in nodes:
        if node["name"] == name:
            return node
        descendant = find_node(node["children"], name)
        if descendant is not None:
            return descendant
    return None


@pytest.mark.django_db
def test_research_tree_projects_org_ancestors_and_custom_category(navigation_env):
    created = navigation_env["admin_client"].post(
        navigation_env["url"],
        {
            "scope": "RESEARCH",
            "name": "重点课题",
            "org_unit": str(navigation_env["group"].id),
        },
        format="json",
    )
    assert created.status_code == 201

    moved = navigation_env["admin_client"].post(
        f"{navigation_env['move_url']}{navigation_env['research_project'].id}/move/",
        {"scope": "RESEARCH", "category": created.json()["id"]},
        format="json",
    )
    assert moved.status_code == 200

    response = navigation_env["admin_client"].get(navigation_env["url"], {"scope": "RESEARCH"})
    assert response.status_code == 200
    root = tree_node(response.json()["categories"], "前沿材料研究院")
    assert root is not None
    lab = tree_node(root["children"], "分子材料实验室")
    assert lab is not None
    group = tree_node(lab["children"], "界面催化组")
    assert group is not None
    custom = tree_node(group["children"], "重点课题")
    assert custom is not None
    assert custom["kind"] == "CUSTOM"
    assert custom["projects"][0]["id"] == str(navigation_env["research_project"].id)
    assert response.json()["uncategorized"] == []


@pytest.mark.django_db
def test_category_scope_isolation_and_member_write_is_denied(navigation_env):
    created = navigation_env["admin_client"].post(
        navigation_env["url"],
        {"scope": "ADMINISTRATIVE", "name": "采购与资产"},
        format="json",
    )
    assert created.status_code == 201

    denied = navigation_env["member_client"].post(
        navigation_env["url"],
        {"scope": "ADMINISTRATIVE", "name": "成员分类"},
        format="json",
    )
    assert denied.status_code == 403

    empty_research_category = navigation_env["admin_client"].post(
        navigation_env["url"],
        {
            "scope": "RESEARCH",
            "name": "空组织分类",
            "org_unit": str(navigation_env["group"].id),
        },
        format="json",
    )
    assert empty_research_category.status_code == 201

    research_tree = navigation_env["member_client"].get(navigation_env["url"], {"scope": "RESEARCH"})
    administrative_tree = navigation_env["member_client"].get(
        navigation_env["url"], {"scope": "ADMINISTRATIVE"}
    )
    assert research_tree.status_code == 200
    assert administrative_tree.status_code == 200
    assert tree_node(research_tree.json()["categories"], "前沿材料研究院") is not None
    assert "空组织分类" not in str(research_tree.json()["categories"])
    assert administrative_tree.json()["categories"] == []
    assert administrative_tree.json()["uncategorized"][0]["id"] == str(
        navigation_env["administrative_project"].id
    )


@pytest.mark.django_db
def test_category_depth_and_duplicate_rules(navigation_env):
    root = navigation_env["admin_client"].post(
        navigation_env["url"], {"scope": "RESEARCH", "name": "一级分类"}, format="json"
    )
    assert root.status_code == 201
    parent_id = root.json()["id"]
    for name in ("二级分类", "三级分类"):
        response = navigation_env["admin_client"].post(
            navigation_env["url"],
            {"scope": "RESEARCH", "name": name, "parent": parent_id},
            format="json",
        )
        assert response.status_code == 201
        parent_id = response.json()["id"]

    too_deep = navigation_env["admin_client"].post(
        navigation_env["url"],
        {"scope": "RESEARCH", "name": "超出层级", "parent": parent_id},
        format="json",
    )
    duplicate = navigation_env["admin_client"].post(
        navigation_env["url"], {"scope": "RESEARCH", "name": "一级分类"}, format="json"
    )
    assert too_deep.status_code == 422
    assert duplicate.status_code == 409


@pytest.mark.django_db
def test_non_empty_category_requires_explicit_uncategorized_migration(navigation_env):
    created = navigation_env["admin_client"].post(
        navigation_env["url"],
        {"scope": "ADMINISTRATIVE", "name": "非空分类"},
        format="json",
    )
    assert created.status_code == 201
    category_id = created.json()["id"]
    move_url = f"{navigation_env['move_url']}{navigation_env['administrative_project'].id}/move/"
    moved = navigation_env["admin_client"].post(
        move_url,
        {"scope": "ADMINISTRATIVE", "category": category_id},
        format="json",
    )
    assert moved.status_code == 200

    blocked = navigation_env["admin_client"].delete(f"{navigation_env['url']}{category_id}/")
    assert blocked.status_code == 409
    assert ProjectNavigationCategory.objects.filter(pk=category_id, deleted_at__isnull=True).exists()

    member_count = ProjectMember.objects.count()
    deleted = navigation_env["admin_client"].delete(
        f"{navigation_env['url']}{category_id}/?move_to=uncategorized"
    )
    assert deleted.status_code == 204
    navigation_env["administrative_project"].refresh_from_db()
    assert navigation_env["administrative_project"].navigation_category is None
    assert not ProjectNavigationCategory.objects.filter(
        pk=category_id, deleted_at__isnull=True
    ).exists()
    assert ProjectMember.objects.count() == member_count


@pytest.mark.django_db
def test_delete_rejects_self_and_descendant_targets(navigation_env):
    root = navigation_env["admin_client"].post(
        navigation_env["url"], {"scope": "ADMINISTRATIVE", "name": "根分类"}, format="json"
    )
    child = navigation_env["admin_client"].post(
        navigation_env["url"],
        {"scope": "ADMINISTRATIVE", "name": "子分类", "parent": root.json()["id"]},
        format="json",
    )
    assert root.status_code == 201
    assert child.status_code == 201

    self_target = navigation_env["admin_client"].delete(
        f"{navigation_env['url']}{root.json()['id']}/?move_to={root.json()['id']}",
    )
    descendant_target = navigation_env["admin_client"].delete(
        f"{navigation_env['url']}{root.json()['id']}/?move_to={child.json()['id']}",
    )
    assert self_target.status_code == 422
    assert descendant_target.status_code == 422


@pytest.mark.django_db
def test_project_move_rejects_wrong_scope_without_changing_relationship(navigation_env):
    category = navigation_env["admin_client"].post(
        navigation_env["url"],
        {"scope": "ADMINISTRATIVE", "name": "采购与资产"},
        format="json",
    )
    assert category.status_code == 201
    before = navigation_env["research_project"].navigation_category_id
    response = navigation_env["admin_client"].post(
        f"{navigation_env['move_url']}{navigation_env['research_project'].id}/move/",
        {"scope": "ADMINISTRATIVE", "category": category.json()["id"]},
        format="json",
    )
    navigation_env["research_project"].refresh_from_db()
    assert response.status_code == 409
    assert navigation_env["research_project"].navigation_category_id == before


@pytest.mark.django_db
def test_category_manager_still_cannot_move_an_invisible_project(navigation_env):
    hidden_project = Project.objects.create(
        workspace=navigation_env["workspace"],
        name="私有课题",
        identifier=uuid4().hex[:10].upper(),
        created_by=navigation_env["member"],
    )
    ResearchProjectProfile.objects.create(
        workspace=navigation_env["workspace"],
        project=hidden_project,
        owner=navigation_env["member"],
        org_unit=navigation_env["group"],
        chain_kind=ResearchProjectProfile.ChainKind.RESEARCH_CHAIN,
        chain_visibility=ResearchProjectProfile.ChainVisibility.PRIVATE,
        workflow_status=ResearchProjectProfile.WorkflowStatus.ACTIVE,
        created_by=navigation_env["member"],
    )
    category = navigation_env["admin_client"].post(
        navigation_env["url"],
        {"scope": "RESEARCH", "name": "不可见目标分类"},
        format="json",
    )
    assert category.status_code == 201

    tree = navigation_env["admin_client"].get(navigation_env["url"], {"scope": "RESEARCH"})
    response = navigation_env["admin_client"].post(
        f"{navigation_env['move_url']}{hidden_project.id}/move/",
        {"scope": "RESEARCH", "category": category.json()["id"]},
        format="json",
    )
    hidden_project.refresh_from_db()
    assert response.status_code == 403
    assert hidden_project.navigation_category is None
    assert "私有课题" not in str(tree.json())


@pytest.mark.django_db
def test_active_legacy_research_project_keeps_its_existing_route(navigation_env):
    legacy = Project.objects.create(
        workspace=navigation_env["workspace"],
        name="博士培养项目",
        identifier=uuid4().hex[:10].upper(),
        created_by=navigation_env["member"],
    )
    ResearchProjectProfile.objects.create(
        workspace=navigation_env["workspace"],
        project=legacy,
        owner=navigation_env["member"],
        org_unit=navigation_env["group"],
        research_type=ResearchProjectProfile.ResearchType.PHD,
        chain_kind=ResearchProjectProfile.ChainKind.LEGACY_TRAINING,
        chain_visibility=ResearchProjectProfile.ChainVisibility.WORKSPACE,
        workflow_status=ResearchProjectProfile.WorkflowStatus.ACTIVE,
        created_by=navigation_env["member"],
    )

    research_tree = navigation_env["member_client"].get(
        navigation_env["url"], {"scope": "RESEARCH"}
    )
    administrative_tree = navigation_env["member_client"].get(
        navigation_env["url"], {"scope": "ADMINISTRATIVE"}
    )
    group = find_node(research_tree.json()["categories"], "界面催化组")
    assert group is not None
    legacy_payload = next(
        (project for project in group["projects"] if project["id"] == str(legacy.id)), None
    )
    assert legacy_payload == {
        "id": str(legacy.id),
        "name": "博士培养项目",
        "identifier": legacy.identifier,
        "kind": "LEGACY_RESEARCH",
    }
    assert all(project["id"] != str(legacy.id) for project in administrative_tree.json()["uncategorized"])
