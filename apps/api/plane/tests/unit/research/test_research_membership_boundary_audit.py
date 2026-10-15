"""科研组织成员边界发布前审计命令测试。"""

import json
from io import StringIO

import pytest
from django.core.management import call_command

from plane.db.models import OrgUnit, OrgUnitMember, ResearchUserProfile
from plane.tests.research_fixtures import add_workspace_member, make_user, make_workspace

pytestmark = pytest.mark.unit


@pytest.mark.django_db
def test_audit_lists_only_legacy_research_identities_without_org_relation(db):
    owner = make_user(first_name="Workspace")
    workspace = make_workspace(owner, slug="boundary-audit")
    root = OrgUnit.objects.create(
        workspace=workspace,
        name="科研组织",
        unit_type=OrgUnit.UnitType.ROOT,
        depth=0,
        path="",
    )
    root.path = f"/{root.id.hex}/"
    root.save(update_fields=["path"])

    legacy_profile = make_user(first_name="Legacy")
    add_workspace_member(workspace, legacy_profile)
    ResearchUserProfile.objects.create(user=legacy_profile, category=ResearchUserProfile.Category.STUDENT)

    active_member = make_user(first_name="Active")
    add_workspace_member(workspace, active_member)
    ResearchUserProfile.objects.create(user=active_member, category=ResearchUserProfile.Category.STUDENT)
    OrgUnitMember.objects.create(
        workspace=workspace,
        org_unit=root,
        user=active_member,
        org_role=OrgUnitMember.OrgRole.REVIEWER,
    )

    officer = make_user(first_name="Officer")
    add_workspace_member(workspace, officer)

    stdout = StringIO()
    call_command("audit_research_membership_boundary", workspace.slug, json=True, stdout=stdout)
    payload = json.loads(stdout.getvalue())

    assert payload["workspace"] == workspace.slug
    assert {item["email"] for item in payload["accounts"]} == {owner.email, legacy_profile.email}
    reasons = {item["email"]: item["reasons"] for item in payload["accounts"]}
    assert "workspace_admin" in reasons[owner.email]
    assert "research_profile" in reasons[legacy_profile.email]
