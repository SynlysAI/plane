"""Tests for the Phase 1.5 role-validation fixture management command."""

import json
from io import StringIO

import pytest
from django.core.management import call_command
from django.core.management.base import CommandError

from plane.db.models import (
    MentorBinding,
    OrgUnit,
    OrgUnitMember,
    Project,
    ResearchChain,
    ResearchKnowledgeRequest,
    ResearchUserProfile,
    User,
    WorkspaceMember,
)
from plane.db.management.commands.prepare_phase15_role_validation import (
    BASIC_EMAIL,
    BASIC_UNIT_NAME,
    FIXTURE_PREFIX,
    GUEST_EMAIL,
    INDUSTRY_EMAIL,
    INDUSTRY_UNIT_NAME,
)
from plane.research.utils.org import build_path
from plane.research.utils.role_resolution import resolve_role_context
from plane.tests.research_fixtures import add_workspace_member, enable_research, make_user, make_workspace

pytestmark = pytest.mark.django_db


def _command_json(name, *args, **options):
    """Run a management command and parse JSON stdout.

    Args:
        name: Management command name.
        *args: Positional command arguments.
        **options: Keyword command options.

    Returns:
        Parsed JSON object from command stdout.
    """
    stdout = StringIO()
    call_command(name, *args, stdout=stdout, **options)
    return json.loads(stdout.getvalue())


@pytest.fixture
def phase15_baseline(db):
    """Build the minimal public baseline required by the fixture command."""
    admin = make_user(email="admin@ai4ms.local", first_name="admin")
    workspace = make_workspace(admin, name="Public research", slug="public")
    main_pi = make_user(email="whong@xmu.edu.cn", first_name="洪文晶")
    mentor = make_user(email="jyliu@xmu.edu.cn", first_name="刘俊扬")
    student = make_user(email="qiuzhixin@stu.xmu.edu.cn", first_name="邱智鑫")
    for user in (main_pi, mentor, student):
        add_workspace_member(workspace, user)

    setting = enable_research(workspace, purpose="PUBLIC_RESEARCH")
    setting.main_pi = main_pi
    setting.save(update_fields=["main_pi"])

    unit = OrgUnit.objects.create(
        workspace=workspace,
        name="Phase 1.5 基线课题组",
        unit_type=OrgUnit.UnitType.GROUP,
        path="",
    )
    unit.path = build_path(unit.id, None)
    unit.save(update_fields=["path"])

    ResearchUserProfile.objects.create(user=main_pi, category=ResearchUserProfile.Category.PI)
    ResearchUserProfile.objects.create(user=mentor, category=ResearchUserProfile.Category.ADVISOR)
    ResearchUserProfile.objects.create(user=student, category=ResearchUserProfile.Category.STUDENT)
    OrgUnitMember.objects.create(
        workspace=workspace,
        org_unit=unit,
        user=mentor,
        org_role=OrgUnitMember.OrgRole.ADVISOR,
    )
    OrgUnitMember.objects.create(
        workspace=workspace,
        org_unit=unit,
        user=student,
        org_role=OrgUnitMember.OrgRole.REVIEWER,
    )
    binding = MentorBinding.objects.create(
        workspace=workspace,
        org_unit=unit,
        mentor=mentor,
        mentee=student,
    )
    return {
        "workspace": workspace,
        "admin": admin,
        "main_pi": main_pi,
        "mentor": mentor,
        "student": student,
        "binding": binding,
    }


def test_apply_creates_fixture_accounts_and_mock_project(phase15_baseline):
    """Apply creates industry/guest accounts plus a removable mock research chain."""
    workspace = phase15_baseline["workspace"]

    result = _command_json(
        "prepare_phase15_role_validation",
        workspace=workspace.slug,
        apply=True,
        reset_passwords=True,
        json=True,
    )

    assert result["workspace"] == "public"
    assert result["knowledge_request_state"] == ResearchKnowledgeRequest.State.PENDING_ADMIN
    assert User.objects.filter(email=INDUSTRY_EMAIL).exists()
    assert User.objects.filter(email=BASIC_EMAIL).exists()
    assert User.objects.filter(email=GUEST_EMAIL).exists()
    assert Project.objects.filter(workspace=workspace, name__startswith=FIXTURE_PREFIX).exists()
    assert ResearchChain.objects.filter(pk=result["chain_id"]).exists()

    guest = User.objects.get(email=GUEST_EMAIL)
    guest_context = resolve_role_context(guest, workspace)
    assert guest_context["roles"] == ["Guest"]
    assert guest_context["research_level"] == "NONE"

    industry = User.objects.get(email=INDUSTRY_EMAIL)
    industry_context = resolve_role_context(industry, workspace)
    assert "INDUSTRIALIZATION_OWNER" in industry_context["roles"]
    assert industry_context["research_level"] == "PRINCIPAL"

    basic = User.objects.get(email=BASIC_EMAIL)
    basic_context = resolve_role_context(basic, workspace)
    assert basic_context["roles"] == ["PRINCIPAL"]
    assert basic_context["research_level"] == "PRINCIPAL"
    assert basic_context["business_categories"] == ["BASIC_RESEARCH"]
    assert "INDUSTRIALIZATION_OWNER" not in basic_context["roles"]

    assert result["roles"]["admin"]["password"]
    assert result["roles"]["basic_research_owner"]["password"].startswith("P15!")
    assert result["roles"]["guest"]["password"].startswith("P15!")
    assert guest.is_password_reset_required is True
    assert basic.is_password_reset_required is True


def test_apply_is_idempotent_for_existing_fixture(phase15_baseline):
    """Re-applying keeps the same mock project instead of duplicating it."""
    workspace = phase15_baseline["workspace"]
    first = _command_json(
        "prepare_phase15_role_validation",
        workspace=workspace.slug,
        apply=True,
        json=True,
    )
    second = _command_json(
        "prepare_phase15_role_validation",
        workspace=workspace.slug,
        apply=True,
        json=True,
    )

    assert first["project_id"] == second["project_id"]
    assert first["chain_id"] == second["chain_id"]
    assert Project.objects.filter(workspace=workspace, name__startswith=FIXTURE_PREFIX).count() == 1


def test_cleanup_removes_fixture_users_and_projects(phase15_baseline):
    """Cleanup deletes generated accounts and the mock project tree."""
    workspace = phase15_baseline["workspace"]
    _command_json(
        "prepare_phase15_role_validation",
        workspace=workspace.slug,
        apply=True,
        json=True,
    )

    cleaned = _command_json(
        "prepare_phase15_role_validation",
        workspace=workspace.slug,
        cleanup=True,
        json=True,
    )

    assert cleaned["status"] == "cleaned"
    assert cleaned["removed_projects"] == 1
    assert cleaned["removed_users"] == 3
    assert not User.objects.filter(email__in=[INDUSTRY_EMAIL, BASIC_EMAIL, GUEST_EMAIL]).exists()
    assert not Project.objects.filter(workspace=workspace, name__startswith=FIXTURE_PREFIX).exists()
    assert not OrgUnit.objects.filter(workspace=workspace, name__in=[INDUSTRY_UNIT_NAME, BASIC_UNIT_NAME]).exists()
    assert WorkspaceMember.objects.filter(workspace=workspace, member=phase15_baseline["student"]).exists()


def test_requires_explicit_apply_or_cleanup(phase15_baseline):
    """The command rejects calls that omit both --apply and --cleanup."""
    with pytest.raises(CommandError, match="--apply 或 --cleanup"):
        call_command("prepare_phase15_role_validation", workspace=phase15_baseline["workspace"].slug)
