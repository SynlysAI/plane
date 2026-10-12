# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Shared helpers for research module tests."""

from datetime import date
from uuid import uuid4

from django.utils import timezone
from plane.db.models import (
    MentorBinding,
    OrgUnit,
    OrgUnitMember,
    Page,
    PeriodicReport,
    PeriodicReportSnapshot,
    Project,
    ProjectMember,
    ResearchChain,
    ResearchChainNode,
    ResearchProjectProfile,
    User,
    Workspace,
    WorkspaceMember,
    WorkspaceResearchSetting,
)
from plane.license.models import Instance, InstanceAdmin, InstanceRoleAssignment
from plane.utils.constants import DEFAULT_TIMEZONE

WORKSPACE_ADMIN_ROLE = 20
WORKSPACE_MEMBER_ROLE = 15
WORKSPACE_GUEST_ROLE = 5


def make_user(email=None, first_name="Research", last_name="User", is_active=True):
    email = email or f"user-{uuid4().hex[:8]}@example.com"
    user = User.objects.create(
        email=email,
        username=email,
        first_name=first_name,
        last_name=last_name,
        is_active=is_active,
    )
    user.set_password("test-password")
    user.save()
    return user


def make_workspace(owner, name="Research Workspace", slug=None, timezone=DEFAULT_TIMEZONE):
    slug = slug or f"ws-{uuid4().hex[:8]}"
    workspace = Workspace.objects.create(
        name=name,
        owner=owner,
        slug=slug,
        timezone=timezone,
    )
    WorkspaceMember.objects.create(
        workspace=workspace,
        member=owner,
        role=WORKSPACE_ADMIN_ROLE,
    )
    return workspace


def add_workspace_member(workspace, user, role=WORKSPACE_MEMBER_ROLE):
    return WorkspaceMember.objects.create(workspace=workspace, member=user, role=role)


def org_units_url(workspace, suffix=""):
    return f"/api/research/workspaces/{workspace.slug}/org-units/{suffix}"


def mentors_url(workspace, suffix=""):
    return f"/api/research/workspaces/{workspace.slug}/mentors/{suffix}"


def enable_research(workspace, **overrides):
    """Turn the research module on for a workspace (P0-CFG-02)."""
    defaults = {
        "module_enabled": True,
        "org_enabled": True,
        "report_enabled": True,
        "approval_enabled": True,
    }
    defaults.update(overrides)
    setting, _ = WorkspaceResearchSetting.objects.update_or_create(
        workspace=workspace,
        defaults=defaults,
    )
    return setting


def make_research_org_unit(workspace, name, parent=None, unit_type=OrgUnit.UnitType.GROUP):
    """Create one organisation node with the repository's materialised path convention.

    Args:
        workspace: Workspace that owns the organisation node.
        name: Stable display name used by boundary contract tests.
        parent: Parent node; ``None`` creates a root node.
        unit_type: Organisation node type.

    Returns:
        The created organisation node with its materialised path populated.
    """
    unit = OrgUnit.objects.create(
        workspace=workspace,
        name=name,
        parent=parent,
        unit_type=unit_type,
        depth=(parent.depth + 1) if parent else 0,
        path="",
    )
    unit.path = f"{parent.path if parent else '/'}{str(unit.id).replace('-', '')}/"
    unit.save(update_fields=["path"])
    return unit


def make_research_boundary_fixture():
    """Build the Phase 1.6 collaboration-boundary fixture from current models.

    The fixture intentionally stops before the new task, read-receipt and
    paper-review models: L0 only freezes the actors, organisation scope, chain
    node and official report snapshot needed by later contract tests.

    Returns:
        A mapping with users, organisation nodes, project, chain, PAPER_WRITING
        node, submitted weekly report and its v3 official snapshot.
    """
    suffix = uuid4().hex[:6].upper()
    workspace_admin = make_user(first_name="Workspace", last_name="Admin")
    workspace = make_workspace(
        workspace_admin,
        name=f"Public research workspace {suffix}",
        slug=f"research-boundary-{suffix.lower()}",
    )
    enable_research(
        workspace,
        purpose=WorkspaceResearchSetting.Purpose.PUBLIC_RESEARCH,
        research_chain_enabled=True,
    )

    student = make_user(first_name="Student", last_name=suffix)
    advisor = make_user(first_name="Direct", last_name="Advisor")
    group_member = make_user(first_name="Group", last_name="Member")
    principal = make_user(first_name="Principal", last_name="PI")
    ancestor = make_user(first_name="Ancestor", last_name="Manager")
    descendant = make_user(first_name="Descendant", last_name="Member")
    cross_org = make_user(first_name="Cross-org", last_name="Collaborator")
    guest = make_user(first_name="Guest", last_name="User")
    for user in (student, advisor, group_member, principal, ancestor, descendant, cross_org):
        add_workspace_member(workspace, user, role=WORKSPACE_MEMBER_ROLE)
    add_workspace_member(workspace, guest, role=WORKSPACE_GUEST_ROLE)

    root = make_research_org_unit(workspace, "Root", None, OrgUnit.UnitType.ROOT)
    institute = make_research_org_unit(workspace, "Institute", root, OrgUnit.UnitType.INSTITUTE)
    direction_a = make_research_org_unit(workspace, "Direction A", institute, OrgUnit.UnitType.TEAM)
    group_a1 = make_research_org_unit(workspace, "Group A1", direction_a, OrgUnit.UnitType.GROUP)
    child_group = make_research_org_unit(workspace, "Child Group A1-1", group_a1, OrgUnit.UnitType.GROUP)
    direction_b = make_research_org_unit(workspace, "Direction B", institute, OrgUnit.UnitType.TEAM)
    group_b1 = make_research_org_unit(workspace, "Group B1", direction_b, OrgUnit.UnitType.GROUP)

    memberships = (
        (group_a1, student, OrgUnitMember.OrgRole.OWNER, True),
        (group_a1, advisor, OrgUnitMember.OrgRole.ADVISOR, False),
        (group_a1, group_member, OrgUnitMember.OrgRole.REVIEWER, True),
        (institute, principal, OrgUnitMember.OrgRole.PI, False),
        (direction_a, ancestor, OrgUnitMember.OrgRole.UNIT_ADMIN, True),
        (child_group, descendant, OrgUnitMember.OrgRole.REVIEWER, True),
        (group_b1, cross_org, OrgUnitMember.OrgRole.REVIEWER, True),
    )
    for org_unit, user, org_role, is_primary in memberships:
        OrgUnitMember.objects.create(
            workspace=workspace,
            org_unit=org_unit,
            user=user,
            org_role=org_role,
            is_primary=is_primary,
        )
    MentorBinding.objects.create(
        workspace=workspace,
        org_unit=group_a1,
        mentee=student,
        mentor=advisor,
        is_primary_advisor=True,
    )
    WorkspaceResearchSetting.objects.filter(workspace=workspace).update(main_pi=principal)

    project = Project.objects.create(
        workspace=workspace,
        name=f"Research boundary {suffix}",
        identifier=f"RB{suffix}",
        network=0,
        created_by=student,
    )
    ResearchProjectProfile.objects.create(
        project=project,
        workspace=workspace,
        owner=student,
        org_unit=group_a1,
        chain_kind=ResearchProjectProfile.ChainKind.RESEARCH_CHAIN,
        chain_visibility=ResearchProjectProfile.ChainVisibility.ORG,
        created_by=student,
    )
    cross_org_member = ProjectMember.objects.create(project=project, member=cross_org, role=WORKSPACE_MEMBER_ROLE)

    chain = ResearchChain.objects.create(
        project=project,
        workspace=workspace,
        owner=student,
        status=ResearchChain.Status.ACTIVE,
        visibility="ORG",
        request_id=f"boundary-chain-{uuid4().hex}",
        payload_hash=uuid4().hex,
    )
    paper_node = ResearchChainNode.objects.create(
        chain=chain,
        node_type="PAPER_WRITING",
        title="论文写作",
        status=ResearchChainNode.Status.ACTIVE,
        assignee=student,
        request_id=f"boundary-paper-node-{uuid4().hex}",
        payload_hash=uuid4().hex,
    )

    page = Page.objects.create(
        workspace=workspace,
        name="2026-W41 weekly report",
        description_json={"type": "doc", "content": []},
        description_html="<p>Official version 3</p>",
        owned_by=student,
        access=Page.PRIVATE_ACCESS,
    )
    report = PeriodicReport.objects.create(
        workspace=workspace,
        project=project,
        owner=student,
        org_unit=group_a1,
        page=page,
        report_type=PeriodicReport.ReportType.WEEKLY,
        period_key="2026-W41",
        period_start=date(2026, 10, 5),
        period_end=date(2026, 10, 11),
        status=PeriodicReport.Status.SUBMITTED,
        submitted_at=timezone.now(),
    )
    snapshot = PeriodicReportSnapshot.objects.create(
        report=report,
        version_no=3,
        snapshot_status=PeriodicReport.Status.SUBMITTED,
        description_json=page.description_json,
        description_html=page.description_html,
        description_stripped="Official version 3",
        submitted_by=student,
    )

    return {
        "workspace_admin": workspace_admin,
        "student": student,
        "advisor": advisor,
        "group_member": group_member,
        "principal": principal,
        "ancestor": ancestor,
        "descendant": descendant,
        "cross_org": cross_org,
        "guest": guest,
        "workspace": workspace,
        "root": root,
        "institute": institute,
        "direction_a": direction_a,
        "group_a1": group_a1,
        "child_group": child_group,
        "direction_b": direction_b,
        "group_b1": group_b1,
        "project": project,
        "project_profile": project.research_profile,
        "cross_org_project_member": cross_org_member,
        "chain": chain,
        "paper_node": paper_node,
        "report": report,
        "snapshot": snapshot,
    }


def make_instance(name="PiLab Test Instance"):
    """Create (or reuse) the singleton instance row."""
    instance = Instance.objects.first()
    if instance is not None:
        return instance
    return Instance.objects.create(
        instance_name=name,
        instance_id=f"test-{uuid4().hex[:8]}",
        current_version="2.4.0",
        is_setup_done=True,
    )


def make_instance_admin(user=None, role=20):
    """Grant the god-mode instance administrator seat."""
    instance = make_instance()
    admin_user = user or make_user(email=f"instance-admin-{uuid4().hex[:6]}@example.com")
    InstanceAdmin.objects.get_or_create(instance=instance, user=admin_user, defaults={"role": role})
    return admin_user


def grant_admin_tag(user, role, actor=None):
    """Grant one of the three administrator tags."""
    instance = make_instance()
    return InstanceRoleAssignment.objects.create(
        instance=instance,
        user=user,
        role=role,
        assigned_by=actor,
    )


def invite_codes_url(workspace, suffix=""):
    return f"/api/research/workspaces/{workspace.slug}/invite-codes/{suffix}"


def user_imports_url(workspace, suffix=""):
    return f"/api/research/workspaces/{workspace.slug}/user-imports/{suffix}"


def pi_aggregate_url(workspace):
    return f"/api/research/workspaces/{workspace.slug}/aggregate/"


def public_workspace(owner=None, slug="public", name="公共工作区"):
    """Create the public workspace used by invite codes and imports."""
    owner = owner or make_user(email=f"public-owner-{uuid4().hex[:6]}@example.com")
    workspace = Workspace.objects.filter(slug=slug, deleted_at__isnull=True).first()
    if workspace is not None:
        return workspace
    workspace = make_workspace(owner, name=name, slug=slug)
    enable_research(workspace, purpose=WorkspaceResearchSetting.Purpose.PUBLIC_RESEARCH)
    return workspace


def pi_workspace(owner=None, slug="pi", name="主PI工作区"):
    owner = owner or make_user(email=f"pi-owner-{uuid4().hex[:6]}@example.com")
    workspace = Workspace.objects.filter(slug=slug, deleted_at__isnull=True).first()
    if workspace is not None:
        return workspace
    workspace = make_workspace(owner, name=name, slug=slug)
    enable_research(workspace, purpose=WorkspaceResearchSetting.Purpose.PI_PRIVATE)
    return workspace
