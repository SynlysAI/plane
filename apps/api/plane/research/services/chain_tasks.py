# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Assignable-user boundaries for Research Chain node tasks."""

from uuid import UUID

from django.utils import timezone

from plane.db.models import OrgUnitMember, ProjectMember, WorkspaceMember
from plane.research.utils.acl import (
    ResearchResource,
    build_actor_context,
    check_access,
    org_unit_ancestry,
    primary_advisor_ids,
)
from plane.research.utils.org import READABLE_WORKSPACE_ROLES, active_membership_q

ORG_SCOPE = "ORG_SCOPE"
COLLABORATOR_SCOPE = "COLLABORATOR"
ORG_ROLE_ORDER = {
    OrgUnitMember.OrgRole.OWNER: 0,
    OrgUnitMember.OrgRole.PI: 1,
    OrgUnitMember.OrgRole.ADVISOR: 2,
    OrgUnitMember.OrgRole.UNIT_ADMIN: 3,
    OrgUnitMember.OrgRole.REVIEWER: 4,
}


class ChainTaskPermissionError(Exception):
    """Raised when an actor cannot manage assignable users for a chain."""


def chain_manager(workspace, user, chain) -> bool:
    """Return whether the caller can manage chain lifecycle and collaborators.

    Args:
        workspace: Workspace used for future scope extensions.
        user: Caller whose chain management role is checked.
        chain: Research chain being managed.

    Returns:
        True when the caller owns the chain or administers its project.
    """
    if chain.owner_id == user.id:
        return True
    return ProjectMember.objects.filter(
        project_id=chain.project_id,
        member=user,
        role__gte=20,
        is_active=True,
        deleted_at__isnull=True,
    ).exists()


def chain_resource(chain) -> ResearchResource:
    """Project a Chain into the ACL shape used by review scope checks.

    Args:
        chain: Research chain to project.

    Returns:
        The minimal ACL resource representation of the chain.
    """
    profile = getattr(chain.project, "research_profile", None)
    visibility = {"MEMBERS": "UNIT", "ORG": "ANCESTRY"}.get(chain.visibility, chain.visibility)
    return ResearchResource(
        kind="research_chain",
        workspace_id=chain.workspace_id,
        owner_id=chain.owner_id,
        org_unit_id=getattr(profile, "org_unit_id", None),
        visibility=visibility,
        state=chain.status,
        project_id=chain.project_id,
        is_team_content=chain.visibility != "PRIVATE",
    )


def review_only_actor(workspace, user, chain) -> bool:
    """Return whether an actor has review scope without mutable Chain rights.

    Args:
        workspace: Workspace that owns the chain.
        user: Caller whose review-only status is checked.
        chain: Research chain being accessed.

    Returns:
        True when the caller may review but not mutate the chain.
    """
    if chain.owner_id == user.id:
        return False
    context = build_actor_context(user, workspace.id)
    if context.is_main_pi:
        return True
    if user.id in primary_advisor_ids(chain.owner_id, workspace.id):
        return True
    if chain_manager(workspace, user, chain):
        return False
    return check_access(user, "review", chain_resource(chain), context=context)


def chain_writer(workspace, user, chain) -> bool:
    """Return whether a caller may append mutable Chain data.

    Args:
        workspace: Workspace that owns the chain.
        user: Caller whose writer role is checked.
        chain: Research chain being written.

    Returns:
        True when the caller owns, manages, or belongs to the project.
    """
    if review_only_actor(workspace, user, chain):
        return False
    if chain_manager(workspace, user, chain):
        return True
    return ProjectMember.objects.filter(
        project_id=chain.project_id,
        member=user,
        role__gte=15,
        is_active=True,
        deleted_at__isnull=True,
    ).exists()


def actor_can_manage_chain_tasks(workspace, chain, actor) -> bool:
    """Return whether an actor can manage tasks for a chain.

    Args:
        workspace: Workspace that must own the chain.
        chain: Research chain being managed.
        actor: User requesting the candidate list or task mutation.

    Returns:
        True when the actor has the chain's writer or manager rights.
    """
    if actor is None or not getattr(actor, "is_authenticated", False):
        return False
    return chain_writer(workspace, actor, chain)


def _candidate_items(workspace, chain) -> list[dict]:
    """Build the complete assignable-user boundary for a chain.

    Args:
        workspace: Workspace that must own the chain.
        chain: Research chain whose organisation boundary is resolved.

    Returns:
        Serialized candidate users ordered by scope and research identity.
    """
    today = timezone.localdate()
    active_workspace_user_ids = set(
        WorkspaceMember.objects.filter(
            workspace_id=workspace.id,
            member__is_active=True,
            role__in=READABLE_WORKSPACE_ROLES,
            is_active=True,
            deleted_at__isnull=True,
        ).values_list("member_id", flat=True)
    )
    profile = getattr(chain.project, "research_profile", None)
    unit_ids = []
    if profile is not None and profile.org_unit_id:
        unit_ids.append(profile.org_unit_id)
        unit_ids.extend(org_unit_ancestry(profile.org_unit_id, workspace.id))

    memberships_by_user: dict[UUID, OrgUnitMember] = {}
    unit_ranks = {unit_id: index for index, unit_id in enumerate(unit_ids)}
    if unit_ids:
        memberships = (
            OrgUnitMember.objects.filter(
                active_membership_q(today),
                workspace_id=workspace.id,
                org_unit_id__in=unit_ids,
                org_unit__deleted_at__isnull=True,
                user_id__in=active_workspace_user_ids,
                user__is_active=True,
            ).select_related("org_unit", "user")
        )
        for membership in memberships:
            rank = (
                not membership.is_primary,
                unit_ranks.get(membership.org_unit_id, len(unit_ranks)),
                ORG_ROLE_ORDER.get(membership.org_role, len(ORG_ROLE_ORDER)),
            )
            existing = memberships_by_user.get(membership.user_id)
            if existing is None or rank < (
                not existing.is_primary,
                unit_ranks.get(existing.org_unit_id, len(unit_ranks)),
                ORG_ROLE_ORDER.get(existing.org_role, len(ORG_ROLE_ORDER)),
            ):
                memberships_by_user[membership.user_id] = membership

    data = [
        {
            "user_id": str(membership.user_id),
            "display_name": membership.user.display_name or membership.user.email,
            "org_unit_id": str(membership.org_unit_id),
            "org_unit_name": membership.org_unit.name,
            "org_role": membership.org_role,
            "is_primary": membership.is_primary,
            "scope": ORG_SCOPE,
        }
        for membership in memberships_by_user.values()
    ]
    org_user_ids = set(memberships_by_user)

    collaborators = (
        ProjectMember.objects.filter(
            project_id=chain.project_id,
            member_id__in=active_workspace_user_ids,
            member__is_active=True,
            is_active=True,
            deleted_at__isnull=True,
        )
        .exclude(member_id__in=org_user_ids)
        .select_related("member")
    )
    data.extend(
        {
            "user_id": str(collaborator.member_id),
            "display_name": collaborator.member.display_name or collaborator.member.email,
            "org_unit_id": None,
            "org_unit_name": None,
            "org_role": None,
            "is_primary": False,
            "scope": COLLABORATOR_SCOPE,
        }
        for collaborator in collaborators
    )

    scope_order = {ORG_SCOPE: 0, COLLABORATOR_SCOPE: 1}
    return sorted(
        data,
        key=lambda item: (
            scope_order[item["scope"]],
            not item["is_primary"],
            ORG_ROLE_ORDER.get(item["org_role"], len(ORG_ROLE_ORDER)),
            item["display_name"].lower(),
        ),
    )


def list_assignable_users(workspace, chain, actor) -> list[dict]:
    """List users that can be assigned to tasks in a research chain.

    Args:
        workspace: Workspace that must own the chain.
        chain: Research chain whose organisation boundary is resolved.
        actor: User requesting the candidate list.

    Returns:
        Serialized candidate users ordered by scope and research identity.

    Raises:
        ChainTaskPermissionError: When the actor cannot manage chain tasks.
    """
    if not actor_can_manage_chain_tasks(workspace, chain, actor):
        raise ChainTaskPermissionError("The actor cannot manage chain tasks.")
    return _candidate_items(workspace, chain)


def validate_assignable_user(workspace, chain, user_id) -> bool:
    """Validate that a user is in a chain's server-side assignee candidate set.

    Args:
        workspace: Workspace that must own the chain.
        chain: Research chain whose boundary is checked.
        user_id: Candidate user ID.

    Returns:
        True when the ID is assignable; False for invalid or excluded IDs.
    """
    try:
        parsed_user_id = UUID(str(user_id))
    except (TypeError, ValueError):
        return False

    return str(parsed_user_id) in {item["user_id"] for item in _candidate_items(workspace, chain)}
