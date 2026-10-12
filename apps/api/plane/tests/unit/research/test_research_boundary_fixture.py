"""Structural checks for the Phase 1.6 L0 backend fixture."""

import pytest

from plane.db.models import MentorBinding, OrgUnitMember, ProjectMember, WorkspaceMember
from plane.tests.research_fixtures import make_research_boundary_fixture

pytestmark = [pytest.mark.unit, pytest.mark.django_db]


def test_research_boundary_fixture_freezes_collaboration_actors_and_objects():
    """Verify the L0 fixture without asserting unimplemented collaboration APIs."""
    fixture = make_research_boundary_fixture()

    assert fixture["project_profile"].chain_kind == "RESEARCH_CHAIN"
    assert fixture["project_profile"].org_unit == fixture["group_a1"]
    assert fixture["chain"].status == "ACTIVE"
    assert fixture["paper_node"].node_type == "PAPER_WRITING"
    assert fixture["paper_node"].status == "ACTIVE"

    assert fixture["report"].period_key == "2026-W41"
    assert fixture["report"].status == "SUBMITTED"
    assert fixture["snapshot"].version_no == 3
    assert fixture["snapshot"].description_html == "<p>Official version 3</p>"

    assert MentorBinding.objects.filter(
        workspace=fixture["workspace"],
        mentee=fixture["student"],
        mentor=fixture["advisor"],
        is_primary_advisor=True,
    ).exists()
    assert ProjectMember.objects.filter(
        project=fixture["project"],
        member=fixture["cross_org"],
        is_active=True,
    ).exists()
    assert OrgUnitMember.objects.filter(
        workspace=fixture["workspace"],
        org_unit=fixture["child_group"],
        user=fixture["descendant"],
    ).exists()
    assert WorkspaceMember.objects.get(workspace=fixture["workspace"], member=fixture["workspace_admin"]).role == 20
    assert WorkspaceMember.objects.get(workspace=fixture["workspace"], member=fixture["guest"]).role == 5

    assignable_users = {
        fixture["student"].id,
        fixture["advisor"].id,
        fixture["group_member"].id,
        fixture["principal"].id,
        fixture["ancestor"].id,
        fixture["cross_org"].id,
    }
    in_scope_units = [fixture["group_a1"], fixture["institute"], fixture["direction_a"], fixture["group_b1"]]
    actual_users = set(OrgUnitMember.objects.filter(org_unit__in=in_scope_units).values_list("user_id", flat=True))
    assert actual_users == assignable_users
    assert not OrgUnitMember.objects.filter(
        workspace=fixture["workspace"],
        user__in=[fixture["workspace_admin"], fixture["guest"]],
    ).exists()
