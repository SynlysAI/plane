"""Tests for the Phase 1.5 role-resolution contract."""

import pytest

from plane.db.models import MentorBinding, OrgUnit, OrgUnitMember, ResearchUserProfile
from plane.research.utils.org import build_path
from plane.research.utils.role_resolution import resolve_role_context
from plane.tests.research_fixtures import add_workspace_member, make_user, make_workspace

pytestmark = pytest.mark.django_db


def make_unit(workspace, name, business_category=None):
    """Create a minimal organisation unit for a role-resolution test."""
    unit = OrgUnit.objects.create(
        workspace=workspace,
        name=name,
        unit_type=OrgUnit.UnitType.GROUP,
        business_category=business_category,
        path="",
    )
    unit.path = build_path(unit.id, None)
    unit.save(update_fields=["path"])
    return unit


def add_org_member(workspace, unit, user, role):
    """Add an effective organisation relation."""
    return OrgUnitMember.objects.create(workspace=workspace, org_unit=unit, user=user, org_role=role)


def test_resolves_industrialization_owner_and_researcher_roles():
    """Industrialisation ownership is an overlay, while the level stays principal."""
    admin = make_user()
    workspace = make_workspace(admin)
    owner = make_user()
    add_workspace_member(workspace, owner)
    unit = make_unit(workspace, "Industrialisation", OrgUnit.BusinessCategory.INDUSTRIALIZATION)
    add_org_member(workspace, unit, owner, OrgUnitMember.OrgRole.OWNER)
    ResearchUserProfile.objects.create(user=owner, category=ResearchUserProfile.Category.PI)

    context = resolve_role_context(owner, workspace)

    assert context["research_level"] == "PRINCIPAL"
    assert context["roles"] == ["PRINCIPAL", "INDUSTRIALIZATION_OWNER"]
    assert context["business_categories"] == ["INDUSTRIALIZATION"]


def test_requires_advisor_profile_and_binding_for_mentor_role():
    """An advisor relation without a profile and binding is not a test mentor."""
    admin = make_user()
    workspace = make_workspace(admin)
    mentor = make_user()
    student = make_user()
    add_workspace_member(workspace, mentor)
    add_workspace_member(workspace, student)
    unit = make_unit(workspace, "Research")
    add_org_member(workspace, unit, mentor, OrgUnitMember.OrgRole.ADVISOR)
    ResearchUserProfile.objects.create(user=mentor, category=ResearchUserProfile.Category.ADVISOR)
    ResearchUserProfile.objects.create(user=student, category=ResearchUserProfile.Category.STUDENT)
    MentorBinding.objects.create(workspace=workspace, org_unit=unit, mentor=mentor, mentee=student)

    context = resolve_role_context(mentor, workspace)

    assert context["roles"] == ["MENTOR"]
    assert context["mentor_binding_count"] == 1


def test_guest_and_none_are_distinguished():
    """Workspace members without research relations are NONE; guests remain Guest."""
    admin = make_user()
    workspace = make_workspace(admin)
    none_user = make_user()
    guest = make_user()
    add_workspace_member(workspace, none_user)
    add_workspace_member(workspace, guest, role=5)

    assert resolve_role_context(none_user, workspace)["roles"] == ["NONE"]
    assert resolve_role_context(guest, workspace)["roles"] == ["Guest"]
