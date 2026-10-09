"""科研列表组合筛选、分页与权限边界的行为契约。"""

from datetime import date
from django.db import connection
from uuid import uuid4

import pytest
from django.utils import timezone
from rest_framework.test import APIClient

from plane.db.models import (
    MentorBinding,
    OrgUnit,
    OrgUnitMember,
    Page,
    PeriodicReport,
    Project,
    ProjectMember,
    ResearchChain,
    ResearchOutcome,
    ResearchProjectProfile,
)
from plane.tests.research_fixtures import add_workspace_member, enable_research, make_user, make_workspace

pytestmark = pytest.mark.contract


def client_for(user):
    """为指定用户创建已认证的请求客户端。"""
    client = APIClient()
    client.force_authenticate(user=user)
    return client


def create_unit(workspace, name, parent=None):
    """创建具有层级路径的组织单元。"""
    unit = OrgUnit.objects.create(
        workspace=workspace,
        name=name,
        parent=parent,
        unit_type="GROUP" if parent else "ROOT",
        depth=parent.depth + 1 if parent else 0,
        path="",
    )
    unit.path = (parent.path if parent else "/") + unit.id.hex + "/"
    unit.save(update_fields=["path"])
    return unit


def create_project(env, owner, name, unit, visibility="PRIVATE", collaborators=()):
    """建立真实项目、科研元数据与研究链，供公共列表接口查询。"""
    project = Project.objects.create(
        workspace=env["workspace"], name=name, identifier=uuid4().hex[:10], created_by=owner
    )
    ResearchProjectProfile.objects.create(
        workspace=env["workspace"],
        project=project,
        owner=owner,
        org_unit=unit,
        research_type="RESEARCH_PROJECT",
        chain_kind="RESEARCH_CHAIN",
        chain_visibility=visibility,
        started_at=date(2026, 10, 1),
        created_by=owner,
    )
    for user in (owner, *collaborators):
        ProjectMember.objects.create(project=project, workspace=env["workspace"], member=user, role=15)
    ResearchChain.objects.create(
        workspace=env["workspace"],
        project=project,
        owner=owner,
        visibility=visibility,
        request_id=uuid4().hex,
        payload_hash="fixture",
        created_by=owner,
    )
    return project


def create_report(env, owner, period, status="DRAFT", visibility="DIRECT_ADVISOR"):
    """建立包含关键词正文标题的个人报告。"""
    page = Page.objects.create(
        workspace=env["workspace"],
        name=f"{owner.first_name} {period}",
        owned_by=owner,
        description_html="<p>Research progress</p>",
        created_by=owner,
    )
    return PeriodicReport.objects.create(
        workspace=env["workspace"],
        owner=owner,
        page=page,
        org_unit=env["group_a"],
        report_type="WEEKLY",
        period_key=period,
        period_start=date(2026, 9, 28),
        period_end=date(2026, 10, 4),
        status=status,
        submitted_at=timezone.now() if status != "DRAFT" else None,
        visibility=visibility,
        created_by=owner,
    )


@pytest.fixture
def env(db, settings):
    """建立学生、导师、主 PI、管理员与两个组织单元。"""
    settings.RESEARCH_MODULE_ENABLED = True
    admin = make_user(first_name="Admin")
    workspace = make_workspace(admin)
    student = make_user(first_name="Student Alpha")
    colleague = make_user(first_name="Student Beta")
    advisor = make_user(first_name="Advisor")
    pi = make_user(first_name="Main PI")
    for user in (student, colleague, advisor, pi):
        add_workspace_member(workspace, user)
    enable_research(workspace, research_chain_enabled=True, main_pi=pi, purpose="PUBLIC_RESEARCH")
    root = create_unit(workspace, "Root")
    group_a = create_unit(workspace, "Group A", root)
    group_b = create_unit(workspace, "Group B", root)
    for user, unit, role in (
        (student, group_a, "REVIEWER"),
        (colleague, group_b, "REVIEWER"),
        (advisor, group_a, "ADVISOR"),
        (pi, root, "PI"),
    ):
        OrgUnitMember.objects.create(workspace=workspace, org_unit=unit, user=user, org_role=role, is_primary=True)
    MentorBinding.objects.create(
        workspace=workspace, org_unit=group_a, mentee=student, mentor=advisor, is_primary_advisor=True
    )
    result = {
        "workspace": workspace,
        "student": student,
        "colleague": colleague,
        "advisor": advisor,
        "pi": pi,
        "admin": admin,
        "group_a": group_a,
        "group_b": group_b,
    }
    result["base"] = f"/api/research/workspaces/{workspace.slug}/"
    return result


@pytest.mark.django_db
class TestResearchProjectBrowse:
    def test_four_role_default_scope_and_combined_filters_are_replayable(self, env):
        """固定四类身份与两个组织单元的项目筛选结果，防止 ACL 被筛选条件绕过。"""
        own = create_project(env, env["student"], "Alpha graphite", env["group_a"])
        shared = create_project(
            env,
            env["colleague"],
            "Alpha silicon",
            env["group_b"],
            "WORKSPACE",
            collaborators=(env["student"],),
        )
        hidden = create_project(env, env["colleague"], "Alpha secret", env["group_b"])
        ResearchProjectProfile.objects.filter(project=own).update(started_at=date(2026, 10, 1))
        ResearchProjectProfile.objects.filter(project=shared).update(started_at=date(2026, 10, 2))
        ResearchProjectProfile.objects.filter(project=hidden).update(started_at=date(2026, 10, 3))

        url = f"{env['base']}projects/"
        assert {item["id"] for item in client_for(env["student"]).get(url).json()["results"]} == {
            str(own.id),
            str(shared.id),
        }
        assert {item["id"] for item in client_for(env["advisor"]).get(url).json()["results"]} == {
            str(own.id),
            str(shared.id),
        }
        assert {item["id"] for item in client_for(env["pi"]).get(url).json()["results"]} == {
            str(own.id),
            str(shared.id),
            str(hidden.id),
        }
        assert {item["id"] for item in client_for(env["admin"]).get(url).json()["results"]} == {str(shared.id)}

        mine = client_for(env["student"]).get(url, {"mine": "true"}).json()
        assert {item["id"] for item in mine["results"]} == {str(own.id)}
        filtered = client_for(env["admin"]).get(
            url,
            {
                "org_unit": str(env["group_b"].id),
                "owner": str(env["colleague"].id),
                "q": "Alpha",
                "date_from": "2026-10-02",
                "date_to": "2026-10-02",
            },
        ).json()
        assert {item["id"] for item in filtered["results"]} == {str(shared.id)}

        pi_filtered = client_for(env["pi"]).get(
            url,
            {
                "org_unit": str(env["group_b"].id),
                "owner": str(env["colleague"].id),
                "q": "Alpha",
                "date_from": "2026-10-02",
                "date_to": "2026-10-03",
            },
        ).json()
        assert {item["id"] for item in pi_filtered["results"]} == {str(shared.id), str(hidden.id)}

    def test_default_scope_and_keyword_scope_combinations_preserve_acl(self, env):
        own = create_project(env, env["student"], "Alpha graphite", env["group_a"])
        shared = create_project(env, env["colleague"], "Alpha silicon", env["group_b"], collaborators=(env["student"],))
        public = create_project(env, env["colleague"], "Public polymer", env["group_b"], "WORKSPACE")
        create_project(env, env["colleague"], "Alpha secret", env["group_b"])
        client = client_for(env["student"])
        url = f"{env['base']}projects/"

        default = client.get(url)
        assert default.status_code == 200
        assert {item["id"] for item in default.json()["results"]} == {str(own.id), str(shared.id), str(public.id)}
        owned = client.get(url, {"scope": "owned", "q": "graphite"})
        assert [item["id"] for item in owned.json()["results"]] == [str(own.id)]
        participating = client.get(url, {"scope": "participating", "q": "Alpha"})
        assert {item["id"] for item in participating.json()["results"]} == {str(own.id), str(shared.id)}
        secret = client.get(url, {"q": "secret"})
        assert secret.json()["results"] == []

    @pytest.mark.parametrize("endpoint", ["projects", "chains"])
    def test_keyword_and_visibility_are_applied_before_pagination(self, env, endpoint):
        matching = [create_project(env, env["student"], f"Graphite {index}", env["group_a"]) for index in range(3)]
        create_project(env, env["student"], "Polymer excluded", env["group_a"])
        create_project(env, env["colleague"], "Graphite secret", env["group_b"])
        client = client_for(env["student"])
        url = f"{env['base']}{endpoint}/"
        first = client.get(url, {"q": "Graphite", "scope": "owned", "per_page": 2})

        assert first.status_code == 200, first.json()
        assert len(first.json()["results"]) == 2
        assert first.json()["next_page_results"] is True
        second = client.get(
            url, {"q": "Graphite", "scope": "owned", "per_page": 2, "cursor": first.json()["next_cursor"]}
        )
        assert second.status_code == 200
        combined = first.json()["results"] + second.json()["results"]
        result_ids = [item["id"] if endpoint == "projects" else item["project"] for item in combined]
        assert len(result_ids) == len(set(result_ids)) == 3
        assert set(result_ids) == {str(item.id) for item in matching}
        if endpoint == "chains":
            assert first.json()["data"] == first.json()["results"]


@pytest.mark.django_db
class TestResearchReportBrowse:
    def test_four_role_default_scope_and_combined_filters_are_replayable(self, env):
        """固定报告浏览矩阵，确保默认范围与筛选始终叠加科研 ACL。"""
        own = create_report(env, env["student"], "2026-W40", "SUBMITTED")
        shared = create_report(env, env["colleague"], "2026-W41", "SUBMITTED", "WORKSPACE")
        hidden = create_report(env, env["colleague"], "2026-W42", "SUBMITTED", "PRIVATE")
        PeriodicReport.objects.filter(pk=own.id).update(
            period_start=date(2026, 10, 1), period_end=date(2026, 10, 1)
        )
        PeriodicReport.objects.filter(pk=shared.id).update(
            org_unit=env["group_b"], period_start=date(2026, 10, 2), period_end=date(2026, 10, 2)
        )
        PeriodicReport.objects.filter(pk=hidden.id).update(
            org_unit=env["group_b"], period_start=date(2026, 10, 3), period_end=date(2026, 10, 3)
        )

        url = f"{env['base']}reports/"
        assert {item["id"] for item in client_for(env["student"]).get(url).json()["results"]} == {
            str(own.id),
            str(shared.id),
        }
        assert {item["id"] for item in client_for(env["advisor"]).get(url).json()["results"]} == {
            str(own.id),
            str(shared.id),
        }
        assert {item["id"] for item in client_for(env["pi"]).get(url).json()["results"]} == {
            str(own.id),
            str(shared.id),
            str(hidden.id),
        }
        assert {item["id"] for item in client_for(env["admin"]).get(url).json()["results"]} == {str(shared.id)}

        mine = client_for(env["student"]).get(url, {"mine": "true"}).json()
        assert {item["id"] for item in mine["results"]} == {str(own.id)}
        filtered = client_for(env["admin"]).get(
            url,
            {
                "org_unit": str(env["group_b"].id),
                "owner": str(env["colleague"].id),
                "q": "Student Beta",
                "date_from": "2026-10-02",
                "date_to": "2026-10-02",
            },
        ).json()
        assert {item["id"] for item in filtered["results"]} == {str(shared.id)}

        pi_filtered = client_for(env["pi"]).get(
            url,
            {
                "org_unit": str(env["group_b"].id),
                "owner": str(env["colleague"].id),
                "q": "Student Beta",
                "date_from": "2026-10-02",
                "date_to": "2026-10-03",
            },
        ).json()
        assert {item["id"] for item in pi_filtered["results"]} == {str(shared.id), str(hidden.id)}

    def test_mine_keyword_and_review_scopes_use_report_acl(self, env):
        submitted = create_report(env, env["student"], "2026-W40", "SUBMITTED")
        create_report(env, env["student"], "2026-W39", "DRAFT")
        create_report(env, env["student"], "2026-W38", "ACCEPTED")
        hidden = create_report(env, env["colleague"], "2026-W40", "SUBMITTED", "PRIVATE")
        url = f"{env['base']}reports/"

        mine = client_for(env["student"]).get(url, {"scope": "mine", "q": "2026-W40"})
        assert mine.status_code == 200
        assert [item["id"] for item in mine.json()["results"]] == [str(submitted.id)]
        review = client_for(env["advisor"]).get(url, {"scope": "review", "q": "Student Alpha"})
        assert review.status_code == 200
        assert [item["id"] for item in review.json()["results"]] == [str(submitted.id)]
        unrelated = client_for(env["colleague"]).get(url, {"scope": "review"})
        assert unrelated.json()["results"] == []
        default = client_for(env["advisor"]).get(url)
        assert str(hidden.id) not in {item["id"] for item in default.json()["results"]}


@pytest.mark.django_db
class TestWorkspaceOutcomeBrowse:
    def test_workspace_query_pages_visible_results_and_creation_projects(self, env):
        own_project = create_project(env, env["student"], "Own project", env["group_a"])
        other_project = create_project(env, env["colleague"], "Other project", env["group_b"])
        outcomes = [
            ResearchOutcome.objects.create(
                workspace=env["workspace"],
                project=own_project,
                title=f"Graphite {index}",
                output_type="PAPER",
                status="PUBLISHED",
                visibility="PRIVATE",
                created_by=env["student"],
            )
            for index in range(3)
        ]
        ResearchOutcome.objects.create(
            workspace=env["workspace"],
            project=other_project,
            title="Graphite secret",
            status="DRAFT",
            visibility="PRIVATE",
            created_by=env["colleague"],
        )
        client = client_for(env["student"])
        url = f"{env['base']}outcomes/"
        params = {"q": "Graphite", "scope": "mine", "status": "PUBLISHED", "output_type": "PAPER", "per_page": 2}
        first = client.get(url, params)

        assert first.status_code == 200, first.json()
        assert len(first.json()["results"]) == 2
        assert first.json()["create_projects"] == [{"id": str(own_project.id), "name": own_project.name}]
        second = client.get(url, {**params, "cursor": first.json()["next_cursor"]})
        listed = first.json()["results"] + second.json()["results"]
        assert {item["id"] for item in listed} == {str(item.id) for item in outcomes}
        assert len(listed) == 3
        outsider = make_user(first_name="Not a member")
        assert client_for(outsider).get(url).status_code == 404

    @pytest.mark.parametrize("role", ["student", "advisor", "pi", "admin"])
    def test_workspace_and_project_outcome_lists_make_the_same_acl_decision(self, env, role):
        project = create_project(env, env["student"], "Graphite", env["group_a"])
        for status in ("DRAFT", "PUBLISHED"):
            for visibility in ("PRIVATE", "DIRECT_ADVISOR", "UNIT", "WORKSPACE"):
                ResearchOutcome.objects.create(
                    workspace=env["workspace"],
                    project=project,
                    title=f"{status} {visibility}",
                    status=status,
                    visibility=visibility,
                    created_by=env["student"],
                )
        client = client_for(env[role])

        project_list = client.get(f"{env['base']}projects/{project.id}/outcomes/")
        workspace_list = client.get(f"{env['base']}outcomes/")

        expected = {
            "student": {"DRAFT", "PUBLISHED"},
            "advisor": {"PUBLISHED"},
            "pi": {"PUBLISHED"},
            "admin": {"PUBLISHED"},
        }[role]
        if role == "student":
            expected_visibilities = {"PRIVATE", "DIRECT_ADVISOR", "UNIT", "WORKSPACE"}
        elif role in {"advisor", "pi"}:
            expected_visibilities = {"PRIVATE", "DIRECT_ADVISOR", "UNIT", "WORKSPACE"}
        else:
            expected_visibilities = {"WORKSPACE"}

        assert project_list.status_code == workspace_list.status_code == 200
        project_results = project_list.json()["results"]
        workspace_results = workspace_list.json()["results"]
        assert {(item["status"], item["visibility"]) for item in workspace_results} == {
            (status, visibility)
            for status in expected
            for visibility in expected_visibilities
        }
        assert {item["id"] for item in workspace_results} == {item["id"] for item in project_results}

    @pytest.mark.django_db
    def test_workspace_outcome_date_filter_uses_publication_date(self, env):
        project = create_project(env, env["student"], "Publication project", env["group_a"])
        ResearchOutcome.objects.create(
            workspace=env["workspace"],
            project=project,
            title="Earlier registration",
            output_type="PAPER",
            status="PUBLISHED",
            visibility="WORKSPACE",
            published_at=date(2026, 9, 1),
            created_by=env["student"],
        )
        later = ResearchOutcome.objects.create(
            workspace=env["workspace"],
            project=project,
            title="Later publication",
            output_type="PAPER",
            status="PUBLISHED",
            visibility="WORKSPACE",
            published_at=date(2026, 10, 3),
            created_by=env["student"],
        )

        response = client_for(env["student"]).get(
            f"{env['base']}outcomes/", {"date_from": "2026-10-02", "date_to": "2026-10-04"}
        )

        assert response.status_code == 200
        assert [item["id"] for item in response.json()["results"]] == [str(later.id)]
        assert response.json()["results"][0]["published_at"] == "2026-10-03"

    @pytest.mark.django_db
    def test_create_project_projection_does_not_grow_linearly_with_projects(self, env):
        def request_count(start, end):
            for index in range(start, end):
                create_project(env, env["student"], f"Creation project {index}", env["group_a"])
            connection.force_debug_cursor = True
            connection.queries_log.clear()
            try:
                response = client_for(env["student"]).get(f"{env['base']}outcomes/")
                assert response.status_code == 200
                return len(connection.queries_log)
            finally:
                connection.force_debug_cursor = False

        small = request_count(0, 3)
        large = request_count(3, 10)
        assert large - small <= 4

    @pytest.mark.parametrize("endpoint", ["projects", "reports", "outcomes", "chains"])
    def test_invalid_scope_is_rejected_consistently(self, env, endpoint):
        response = client_for(env["student"]).get(f"{env['base']}{endpoint}/", {"scope": "unknown"})
        assert response.status_code == 400
