"""Contract coverage for the unified workspace global search endpoint."""

from uuid import uuid4

import pytest
from rest_framework.test import APIClient

from plane.db.models import Issue, Project, ProjectMember, ResearchChain, ResearchProjectProfile
from plane.app.views.search.base import GlobalSearchEndpoint
from plane.tests.research_fixtures import (
    add_workspace_member,
    enable_research,
    make_org_member,
    make_user,
    make_workspace,
)

pytestmark = pytest.mark.contract


@pytest.fixture(autouse=True)
def research_module_on(settings):
    """Keep the research module enabled for global-search contracts."""
    settings.RESEARCH_MODULE_ENABLED = True


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


def create_project(workspace, name, identifier, actor):
    """Create a non-archived project with a workspace-unique identifier."""
    return Project.objects.create(
        workspace=workspace,
        name=name,
        identifier=identifier,
        created_by=actor,
    )


@pytest.fixture
def global_search_env(db):
    """Create visible and hidden research/admin projects for one requester."""
    admin = make_user(first_name="Search Admin")
    workspace = make_workspace(admin, name="全局搜索工作区")
    enable_research(workspace, research_chain_enabled=True)

    member = make_user(first_name="Search Member")
    add_workspace_member(workspace, member)
    make_org_member(workspace, member, org_role="REVIEWER")

    suffix = uuid4().hex[:4].upper()
    chain_project = create_project(
        workspace,
        "产业化联合开发课题",
        f"RS{suffix}",
        member,
    )
    ResearchProjectProfile.objects.create(
        workspace=workspace,
        project=chain_project,
        owner=member,
        chain_kind=ResearchProjectProfile.ChainKind.RESEARCH_CHAIN,
        chain_visibility=ResearchProjectProfile.ChainVisibility.WORKSPACE,
        workflow_status=ResearchProjectProfile.WorkflowStatus.ACTIVE,
        created_by=member,
    )
    chain = ResearchChain.objects.create(
        project=chain_project,
        workspace=workspace,
        owner=member,
        visibility=ResearchProjectProfile.ChainVisibility.WORKSPACE,
        request_id=f"search-chain-{uuid4()}",
        payload_hash=f"search-chain-{uuid4()}",
        created_by=member,
    )

    team_project = create_project(
        workspace,
        "产业化团队协作课题",
        f"TM{suffix}",
        member,
    )
    ResearchProjectProfile.objects.create(
        workspace=workspace,
        project=team_project,
        owner=member,
        research_type=ResearchProjectProfile.ResearchType.RESEARCH_PROJECT,
        chain_kind=ResearchProjectProfile.ChainKind.LEGACY_TRAINING,
        chain_visibility=ResearchProjectProfile.ChainVisibility.WORKSPACE,
        workflow_status=ResearchProjectProfile.WorkflowStatus.ACTIVE,
        created_by=member,
    )

    administrative_project = create_project(
        workspace,
        "产业化设备采购",
        f"AD{suffix}",
        admin,
    )

    hidden_project = create_project(
        workspace,
        "保密产业化课题",
        f"HD{suffix}",
        admin,
    )
    ResearchProjectProfile.objects.create(
        workspace=workspace,
        project=hidden_project,
        owner=admin,
        chain_kind=ResearchProjectProfile.ChainKind.RESEARCH_CHAIN,
        chain_visibility=ResearchProjectProfile.ChainVisibility.PRIVATE,
        workflow_status=ResearchProjectProfile.WorkflowStatus.ACTIVE,
        created_by=admin,
    )

    research_issue = Issue.objects.create(
        workspace=workspace,
        project=chain_project,
        name="产业化实验任务",
        created_by=member,
    )
    administrative_issue = Issue.objects.create(
        workspace=workspace,
        project=administrative_project,
        name="产业化采购任务",
        created_by=admin,
    )
    ProjectMember.objects.create(
        workspace=workspace,
        project=administrative_project,
        member=member,
        role=15,
    )

    return {
        "workspace": workspace,
        "admin": admin,
        "member": member,
        "chain_project": chain_project,
        "chain": chain,
        "team_project": team_project,
        "administrative_project": administrative_project,
        "hidden_project": hidden_project,
        "research_issue": research_issue,
        "administrative_issue": administrative_issue,
        "client": client_for(member),
        "url": f"/api/workspaces/{workspace.slug}/search/",
    }


def search(env, params):
    """Request the global-search endpoint with query parameters."""
    return env["client"].get(env["url"], params)


def project_names(response):
    """Return project names from a global-search response."""
    return [project["name"] for project in response.json()["results"]["project"]]


@pytest.mark.django_db
def test_global_search_returns_visible_research_and_administrative_projects(global_search_env):
    response = search(global_search_env, {"search": "产业化", "workspace_search": "true"})

    assert response.status_code == 200
    names = project_names(response)
    assert "产业化联合开发课题" in names
    assert "产业化团队协作课题" in names
    assert "产业化设备采购" in names
    assert "保密产业化课题" not in names


@pytest.mark.django_db
def test_global_search_matches_research_project_identifier(global_search_env):
    response = search(
        global_search_env,
        {"search": global_search_env["chain_project"].identifier.lower(), "workspace_search": "true"},
    )

    assert response.status_code == 200
    assert project_names(response) == ["产业化联合开发课题"]


@pytest.mark.django_db
def test_global_search_includes_visible_research_work_items(global_search_env):
    response = search(global_search_env, {"search": "任务", "workspace_search": "true"})

    assert response.status_code == 200
    issue_names = [issue["name"] for issue in response.json()["results"]["issue"]]
    assert "产业化实验任务" in issue_names
    assert "产业化采购任务" in issue_names


@pytest.mark.django_db
def test_global_search_project_scope_excludes_other_projects(global_search_env):
    response = search(
        global_search_env,
        {
            "search": "产业化",
            "workspace_search": "false",
            "project_id": str(global_search_env["chain_project"].id),
        },
    )

    assert response.status_code == 200
    payload = response.json()["results"]
    assert project_names(response) == ["产业化联合开发课题"]
    assert [issue["name"] for issue in payload["issue"]] == ["产业化实验任务"]


@pytest.mark.django_db
def test_global_search_project_results_include_research_route_metadata(global_search_env):
    response = search(global_search_env, {"search": "课题", "workspace_search": "true"})

    assert response.status_code == 200
    projects = {project["name"]: project for project in response.json()["results"]["project"]}
    chain_project = projects["产业化联合开发课题"]
    team_project = projects["产业化团队协作课题"]
    assert chain_project["route_kind"] == "RESEARCH_CHAIN"
    assert chain_project["chain_id"] == str(global_search_env["chain"].id)
    assert team_project["route_kind"] == "TEAM_RESEARCH"
    assert team_project["chain_id"] is None


def test_global_search_resolves_project_visibility_once_per_request(global_search_env, monkeypatch):
    """All searched entities reuse one visible-project resolution per request."""
    calls = 0
    original = GlobalSearchEndpoint.visible_projects

    def visible_projects_spy(self, slug):
        """Count visibility resolutions while preserving the real queryset."""
        nonlocal calls
        calls += 1
        return original(self, slug)

    monkeypatch.setattr(GlobalSearchEndpoint, "visible_projects", visible_projects_spy)

    response = search(global_search_env, {"search": "产业化", "workspace_search": "true"})

    assert response.status_code == 200
    assert calls == 1
