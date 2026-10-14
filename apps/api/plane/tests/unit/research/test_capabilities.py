# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file in the repo root for details.

"""Research navigation levels and the visible menu matrix (v2.5.0)."""

from datetime import timedelta

import pytest
from django.utils import timezone

from plane.db.models import (
    AdministrativeOrganization,
    AdministrativeOrganizationMember,
    MentorBinding,
    OrgUnit,
    OrgUnitMember,
    ResearchUserProfile,
    StageReviewerAssignment,
    StageType,
    WorkspaceResearchSetting,
    WorkspaceMember,
)
from plane.research.utils.capabilities import (
    NAV_APPROVALS,
    NAV_DASHBOARD,
    NAV_KEYS,
    NAV_ORG,
    NAV_OVERVIEW,
    NAV_PROJECTS,
    NAV_RESEARCH_CHAIN,
    NAV_REPORTS,
    NAV_REVIEWS,
    NAV_SUMMARY,
    ResearchLevel,
    build_research_capabilities,
    nav_allowed,
    org_signal_workspace,
    research_level,
)
from plane.research.utils.org import build_path, ensure_root_org_unit
from plane.tests.research_fixtures import (
    add_workspace_member,
    enable_research,
    grant_admin_tag,
    make_user,
    make_workspace,
    pi_workspace,
    public_workspace,
)

pytestmark = pytest.mark.unit


def make_unit(workspace, parent, name, unit_type=OrgUnit.UnitType.GROUP):
    unit = OrgUnit(
        workspace=workspace,
        parent=parent,
        name=name,
        unit_type=unit_type,
        depth=(parent.depth + 1) if parent else 0,
        path="",
    )
    unit.path = build_path(unit.id, parent.path if parent else None)
    unit.save()
    return unit


@pytest.fixture
def env(db):
    owner = make_user(first_name="Owner")
    workspace = make_workspace(owner, slug="public")
    enable_research(workspace)
    root = ensure_root_org_unit(workspace, actor=owner)
    group = make_unit(workspace, root, "器件组")
    OrgUnitMember.objects.create(
        workspace=workspace,
        org_unit=root,
        user=owner,
        org_role=OrgUnitMember.OrgRole.OWNER,
    )
    return {"owner": owner, "workspace": workspace, "root": root, "group": group}


def member_of(env, user, unit=None, org_role=OrgUnitMember.OrgRole.REVIEWER):
    if not WorkspaceMember.objects.filter(workspace=env["workspace"], member=user, deleted_at__isnull=True).exists():
        add_workspace_member(env["workspace"], user)
    return OrgUnitMember.objects.create(
        workspace=env["workspace"],
        org_unit=unit or env["group"],
        user=user,
        org_role=org_role,
    )


def test_technical_administrator_tag_does_not_create_a_research_level(env):
    admin = make_user(first_name="OpsAdmin")
    add_workspace_member(env["workspace"], admin)
    grant_admin_tag(admin, "OPS_ADMIN", actor=env["owner"])

    assert research_level(admin, env["workspace"]) == ResearchLevel.NONE
    capabilities = build_research_capabilities(admin, env["workspace"])
    assert capabilities["nav"] == []
    assert NAV_ORG not in capabilities["nav"]


def test_development_duty_only_opens_integrations(env):
    developer = make_user(first_name="DevAdmin")
    add_workspace_member(env["workspace"], developer)
    grant_admin_tag(developer, "DEV_ADMIN", actor=env["owner"])

    capabilities = build_research_capabilities(developer, env["workspace"])

    assert capabilities["level"] == ResearchLevel.NONE
    assert capabilities["nav"] == []
    assert capabilities["management"]["accounts"] is False
    assert capabilities["management"]["integrations"] is False


def test_configured_main_pi_requires_an_active_org_relation(env):
    main_pi = make_user(first_name="ConfiguredMainPI")
    add_workspace_member(env["workspace"], main_pi)
    setting = WorkspaceResearchSetting.objects.get(workspace=env["workspace"])
    setting.purpose = WorkspaceResearchSetting.Purpose.PUBLIC_RESEARCH
    setting.main_pi = main_pi
    setting.save(update_fields=["purpose", "main_pi", "updated_at"])

    assert build_research_capabilities(main_pi, env["workspace"])["level"] == ResearchLevel.NONE

    member_of(env, main_pi, org_role=OrgUnitMember.OrgRole.PI)
    capabilities = build_research_capabilities(main_pi, env["workspace"])

    assert capabilities["level"] == ResearchLevel.PRINCIPAL
    assert capabilities["is_main_pi"] is True
    assert capabilities["management"]["organization"] is True
    assert capabilities["management"]["workspace"] is False
    assert NAV_ORG in capabilities["nav"]


def test_legacy_main_pi_label_does_not_grant_business_or_admin_access(env):
    legacy = make_user(first_name="LegacyMainPI")
    add_workspace_member(env["workspace"], legacy)
    grant_admin_tag(legacy, "MAIN_PI", actor=env["owner"])

    capabilities = build_research_capabilities(legacy, env["workspace"])

    assert capabilities["level"] == ResearchLevel.NONE
    assert capabilities["nav"] == []
    assert capabilities["management"]["accounts"] is False


def test_workspace_administrator_requires_an_active_org_relation(env):
    administrator = make_user(first_name="UnregisteredAdmin")
    add_workspace_member(env["workspace"], administrator, role=20)

    assert research_level(administrator, env["workspace"]) == ResearchLevel.NONE

    member_of(env, administrator, org_role=OrgUnitMember.OrgRole.UNIT_ADMIN)
    assert research_level(administrator, env["workspace"]) == ResearchLevel.ADMIN
    assert research_level(env["owner"], env["workspace"]) == ResearchLevel.ADMIN


def test_administrative_organization_member_is_not_researcher(env):
    officer = make_user(first_name="AdministrativeOfficer")
    add_workspace_member(env["workspace"], officer)
    organization = AdministrativeOrganization.objects.create(
        workspace=env["workspace"],
        name="行政办公室",
        created_by=env["owner"],
    )
    AdministrativeOrganizationMember.objects.create(
        workspace=env["workspace"],
        organization=organization,
        member=officer,
        role=AdministrativeOrganizationMember.Role.ADMIN,
        created_by=env["owner"],
    )

    assert research_level(officer, env["workspace"]) == ResearchLevel.NONE
    assert build_research_capabilities(officer, env["workspace"])["nav"] == []


@pytest.mark.parametrize(
    "org_role",
    [OrgUnitMember.OrgRole.OWNER, OrgUnitMember.OrgRole.PI, OrgUnitMember.OrgRole.UNIT_ADMIN],
)
def test_managing_org_role_is_principal(env, org_role):
    user = make_user(first_name=f"Principal-{org_role}")
    member_of(env, user, org_role=org_role)

    assert research_level(user, env["workspace"]) == ResearchLevel.PRINCIPAL


def test_advisor_role_is_mentor(env):
    user = make_user(first_name="Advisor")
    member_of(env, user, org_role=OrgUnitMember.OrgRole.ADVISOR)

    assert research_level(user, env["workspace"]) == ResearchLevel.MENTOR


def test_mentor_binding_without_org_relation_is_none(env):
    mentor = make_user(first_name="BoundMentor")
    mentee = make_user(first_name="Mentee")
    add_workspace_member(env["workspace"], mentor)
    member_of(env, mentee)
    MentorBinding.objects.create(workspace=env["workspace"], mentor=mentor, mentee=mentee)

    assert research_level(mentor, env["workspace"]) == ResearchLevel.NONE


def test_stage_reviewer_assignment_promotes_to_mentor(env):
    pi_user = make_user(first_name="MainPI")
    member_of(env, pi_user, org_role=OrgUnitMember.OrgRole.PI)
    reviewer = make_user(first_name="AssignedReviewer")
    member_of(env, reviewer)
    stage = make_stage(env, pi_user)
    StageReviewerAssignment.objects.create(
        stage_instance=stage,
        reviewer=reviewer,
        reviewer_role="REVIEWER",
        is_required=False,
        assignment_kind=StageReviewerAssignment.AssignmentKind.MANUAL,
    )

    capabilities = build_research_capabilities(reviewer, env["workspace"])

    assert capabilities["level"] == ResearchLevel.MENTOR
    assert capabilities["is_stage_reviewer"] is True
    assert NAV_REVIEWS in capabilities["nav"]


def test_stage_reviewer_assignment_without_org_relation_is_none(env):
    pi_user = make_user(first_name="OrgMainPI")
    member_of(env, pi_user, org_role=OrgUnitMember.OrgRole.PI)
    external_reviewer = make_user(first_name="ExternalReviewer")
    add_workspace_member(env["workspace"], external_reviewer)
    stage = make_stage(env, pi_user)
    StageReviewerAssignment.objects.create(
        stage_instance=stage,
        reviewer=external_reviewer,
        reviewer_role="REVIEWER",
        is_required=False,
        assignment_kind=StageReviewerAssignment.AssignmentKind.MANUAL,
    )

    capabilities = build_research_capabilities(external_reviewer, env["workspace"])

    assert capabilities["level"] == ResearchLevel.NONE
    assert capabilities["is_stage_reviewer"] is False
    assert capabilities["nav"] == []


def make_stage(env, owner):
    from plane.db.models import Project, ResearchProjectProfile, ResearchStageInstance

    project = Project.objects.create(
        workspace=env["workspace"],
        name=f"Stage project {owner.id}",
        identifier=f"P{str(owner.id)[:6]}",
        created_by=owner,
    )
    ResearchProjectProfile.objects.create(
        project=project,
        workspace=env["workspace"],
        owner=owner,
        org_unit=env["group"],
        research_type=ResearchProjectProfile.ResearchType.PHD,
        workflow_status=ResearchProjectProfile.WorkflowStatus.ACTIVE,
        created_by=owner,
    )
    return ResearchStageInstance.objects.create(
        workspace=env["workspace"],
        project=project,
        org_unit=env["group"],
        stage=StageType.OPENING,
        status=ResearchStageInstance.Status.SUBMITTED,
        sort_order=2,
        created_by=owner,
    )


def test_revoked_assignment_drops_the_reviewer_signal(env):
    pi_user = make_user(first_name="MainPI")
    member_of(env, pi_user, org_role=OrgUnitMember.OrgRole.PI)
    reviewer = make_user(first_name="StudentReviewer")
    member_of(env, reviewer)
    stage = make_stage(env, pi_user)
    assignment = StageReviewerAssignment.objects.create(
        stage_instance=stage,
        reviewer=reviewer,
        reviewer_role="REVIEWER",
        is_required=False,
        assignment_kind=StageReviewerAssignment.AssignmentKind.MANUAL,
    )

    assignment.is_active = False
    assignment.superseded_at = timezone.now()
    assignment.save(update_fields=["is_active", "superseded_at", "updated_at"])

    capabilities = build_research_capabilities(reviewer, env["workspace"])

    assert capabilities["level"] == ResearchLevel.RESEARCHER
    assert capabilities["is_stage_reviewer"] is False
    assert NAV_REVIEWS not in capabilities["nav"]


def test_student_seat_is_researcher(env):
    student = make_user(first_name="Student")
    member_of(env, student)

    capabilities = build_research_capabilities(student, env["workspace"])

    assert capabilities["level"] == ResearchLevel.RESEARCHER
    assert capabilities["nav"] == [NAV_OVERVIEW, NAV_REPORTS, NAV_PROJECTS]


def test_research_profile_alone_is_none(env):
    intern = make_user(first_name="Intern")
    add_workspace_member(env["workspace"], intern)
    ResearchUserProfile.objects.create(user=intern, category=ResearchUserProfile.Category.STUDENT)

    assert research_level(intern, env["workspace"]) == ResearchLevel.NONE


def test_account_without_any_relation_is_none(env):
    stranger = make_user(first_name="Stranger")
    add_workspace_member(env["workspace"], stranger)

    capabilities = build_research_capabilities(stranger, env["workspace"])

    assert capabilities["level"] == ResearchLevel.NONE
    assert capabilities["nav"] == []
    assert nav_allowed(stranger, env["workspace"], NAV_REPORTS) is False


def test_expired_org_relation_drops_the_level(env):
    student = make_user(first_name="Alumni")
    membership = member_of(env, student)
    membership.effective_to = timezone.localdate() - timedelta(days=1)
    membership.save(update_fields=["effective_to", "updated_at"])

    assert research_level(student, env["workspace"]) == ResearchLevel.NONE


def test_inactive_or_deleted_org_unit_drops_the_level(env):
    student = make_user(first_name="RetiredGroupStudent")
    member_of(env, student)
    env["group"].is_active = False
    env["group"].save(update_fields=["is_active", "updated_at"])

    assert research_level(student, env["workspace"]) == ResearchLevel.NONE


def test_org_unit_from_another_workspace_does_not_grant_access(env):
    student = make_user(first_name="CrossWorkspaceStudent")
    add_workspace_member(env["workspace"], student)
    other_owner = make_user(first_name="OtherOwner")
    other_workspace = make_workspace(other_owner)
    other_root = make_unit(other_workspace, None, "外区根节点", OrgUnit.UnitType.ROOT)
    other_group = make_unit(other_workspace, other_root, "外区课题组")
    OrgUnitMember.objects.create(
        workspace=env["workspace"],
        org_unit=other_group,
        user=student,
        org_role=OrgUnitMember.OrgRole.REVIEWER,
    )

    assert research_level(student, env["workspace"]) == ResearchLevel.NONE


def test_mentor_menu_includes_the_scoped_overview(env):
    mentor = make_user(first_name="Advisor")
    member_of(env, mentor, org_role=OrgUnitMember.OrgRole.ADVISOR)

    capabilities = build_research_capabilities(mentor, env["workspace"])

    assert capabilities["level"] == ResearchLevel.MENTOR
    assert NAV_SUMMARY in capabilities["nav"]
    assert NAV_DASHBOARD in capabilities["nav"]
    assert NAV_ORG not in capabilities["nav"]


def test_principal_menu_opens_the_board_and_the_org_tree(env):
    pi_user = make_user(first_name="MainPI")
    member_of(env, pi_user, org_role=OrgUnitMember.OrgRole.PI)

    capabilities = build_research_capabilities(pi_user, env["workspace"])

    assert capabilities["level"] == ResearchLevel.PRINCIPAL
    assert {NAV_DASHBOARD, NAV_ORG, NAV_SUMMARY} <= set(capabilities["nav"])


def test_administrator_menu_covers_every_key(env):
    capabilities = build_research_capabilities(env["owner"], env["workspace"])

    assert capabilities["level"] == ResearchLevel.ADMIN
    assert set(capabilities["nav"]) == set(NAV_KEYS) - {NAV_RESEARCH_CHAIN}
    assert NAV_RESEARCH_CHAIN not in capabilities["nav"]


def test_disabled_sub_switch_removes_its_keys(env):
    enable_research(env["workspace"], approval_enabled=False, stage_enabled=False)

    capabilities = build_research_capabilities(env["owner"], env["workspace"])

    assert NAV_APPROVALS not in capabilities["nav"]
    assert NAV_REVIEWS not in capabilities["nav"]
    # the level itself is unchanged: the switch only hides the surface
    assert capabilities["level"] == ResearchLevel.ADMIN
    assert nav_allowed(env["owner"], env["workspace"], NAV_APPROVALS) is True


def test_reviewer_extra_key_is_applied_per_person(env):
    pi_user = make_user(first_name="MainPI")
    member_of(env, pi_user, org_role=OrgUnitMember.OrgRole.PI)
    student = make_user(first_name="Student")
    member_of(env, student)
    other_student = make_user(first_name="Other")
    member_of(env, other_student)
    stage = make_stage(env, pi_user)
    StageReviewerAssignment.objects.create(
        stage_instance=stage,
        reviewer=student,
        reviewer_role="REVIEWER",
        is_required=False,
        assignment_kind=StageReviewerAssignment.AssignmentKind.MANUAL,
    )

    assert NAV_REVIEWS in build_research_capabilities(student, env["workspace"])["nav"]
    assert NAV_REVIEWS not in build_research_capabilities(other_student, env["workspace"])["nav"]


def test_pi_workspace_resolves_against_the_public_tree(db):
    admin = make_user(first_name="Admin")
    public = public_workspace(owner=admin)
    enable_research(public)
    pi_area = pi_workspace(owner=admin)
    enable_research(pi_area)
    root = ensure_root_org_unit(public, actor=admin)
    group = make_unit(public, root, "器件组")

    pi_user = make_user(first_name="MainPI")
    add_workspace_member(public, pi_user)
    add_workspace_member(pi_area, pi_user)
    OrgUnitMember.objects.create(
        workspace=public,
        org_unit=group,
        user=pi_user,
        org_role=OrgUnitMember.OrgRole.PI,
    )

    assert org_signal_workspace(pi_area).id == public.id
    assert research_level(pi_user, pi_area) == ResearchLevel.PRINCIPAL
    assert nav_allowed(pi_user, pi_area, NAV_DASHBOARD) is True
    # the seat in the main PI workspace is not a research relation of its own
    bystander = make_user(first_name="Bystander")
    add_workspace_member(public, bystander)
    add_workspace_member(pi_area, bystander)
    assert research_level(bystander, pi_area) == ResearchLevel.NONE
