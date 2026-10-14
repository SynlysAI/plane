# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Research navigation capabilities (v2.5.0).

Whether a research surface is reachable is decided by two independent axes:

* the workspace sub switches say whether the surface exists in this workspace
  at all (``workspace_research_sections``);
* the caller's research level says how much of that surface the person may
  reach.

The level is derived from relations the platform already stores - the seated
workspace or instance administrator, the organisation tree, mentor bindings,
stage reviewer assignments and the research profile. OPS/DEV/MAIN_PI tags do
not raise the caller to ADMIN. Nothing extra is written, so editing the
organisation tree changes the menu on the next request.

Levels, highest first:

``ADMIN``
    seated workspace administrator (role 20) or seated instance administrator.
    Organisation membership is not required.
``PRINCIPAL``
    a managing organisation role (node owner, principal investigator, unit
    administrator) on an effective node.
``MENTOR``
    advisor organisation role, an effective mentor binding, or an effective
    stage reviewer assignment.
``RESEARCHER``
    any other organisation relation (the student seat is ``REVIEWER``) or a
    research profile.
``NONE``
    nothing of the above: the research menu stays hidden.

This module is the single source of truth: the identity endpoint publishes the
result and the API views enforce it, so the menu and the endpoints can never
disagree.
"""

from dataclasses import dataclass

from django.db.models import Q
from django.utils import timezone

from plane.db.models import (
    MentorBinding,
    OrgUnitMember,
    ResearchUserProfile,
    StageReviewerAssignment,
    Workspace,
)
from plane.research.utils.org import active_membership_q
from plane.research.utils.roles import (
    PI_WORKSPACE_SLUG,
    PUBLIC_WORKSPACE_SLUG,
    can_configure_integrations,
    can_operate_workspace,
    is_account_compat_admin,
    is_main_pi,
    is_research_admin,
)
from plane.research.utils.settings import workspace_research_sections


class ResearchLevel:
    """Research visibility tiers, highest first."""

    ADMIN = "ADMIN"
    PRINCIPAL = "PRINCIPAL"
    MENTOR = "MENTOR"
    RESEARCHER = "RESEARCHER"
    NONE = "NONE"


LEVELS = (
    ResearchLevel.ADMIN,
    ResearchLevel.PRINCIPAL,
    ResearchLevel.MENTOR,
    ResearchLevel.RESEARCHER,
    ResearchLevel.NONE,
)

# Managing organisation roles: the node itself, its principal investigators and
# its unit administrators (mirrors ``org.MANAGING_ORG_ROLES``).
PRINCIPAL_ORG_ROLES = (
    OrgUnitMember.OrgRole.OWNER,
    OrgUnitMember.OrgRole.PI,
    OrgUnitMember.OrgRole.UNIT_ADMIN,
)

MENTOR_ORG_ROLES = (OrgUnitMember.OrgRole.ADVISOR,)

# Navigation keys shared with the frontend constants (P0-UI-01, P1-UI-01).
NAV_OVERVIEW = "overview"
NAV_DASHBOARD = "dashboard"
NAV_REPORTS = "reports"
NAV_SUMMARY = "summary"
NAV_PROJECTS = "projects"
NAV_REVIEWS = "reviews"
NAV_APPROVALS = "approvals"
NAV_ORG = "org"
NAV_SYSTEM = "system"
NAV_TEMPLATES = "templates"
NAV_IDENTITY = "identity"
NAV_PLATFORM = "platform"
NAV_AUDIT = "audit"
NAV_INTEGRATIONS = "integrations"
NAV_RESEARCH_CHAIN = "research_chain"

NAV_BUSINESS_KEYS = (
    NAV_DASHBOARD,
    NAV_REPORTS,
    NAV_SUMMARY,
    NAV_PROJECTS,
    NAV_REVIEWS,
    NAV_APPROVALS,
)

NAV_SETTINGS_KEYS = (
    NAV_ORG,
    NAV_SYSTEM,
    NAV_TEMPLATES,
    NAV_IDENTITY,
    NAV_PLATFORM,
    NAV_AUDIT,
    NAV_INTEGRATIONS,
    NAV_RESEARCH_CHAIN,
)

# Canonical render order; the frontend keeps its own order and only filters by
# this set.
NAV_KEYS = (NAV_OVERVIEW, *NAV_BUSINESS_KEYS, *NAV_SETTINGS_KEYS)

# Which workspace sub switch owns each key. ``None`` means the key only needs
# the module itself to be on.
NAV_SECTION_KEYS = {
    NAV_OVERVIEW: None,
    NAV_DASHBOARD: "reports",
    NAV_REPORTS: "reports",
    NAV_SUMMARY: "reports",
    NAV_PROJECTS: "reports",
    NAV_TEMPLATES: "reports",
    NAV_REVIEWS: "stages",
    NAV_APPROVALS: "approvals",
    NAV_ORG: "org",
    NAV_SYSTEM: "org",
    NAV_IDENTITY: "org",
    NAV_PLATFORM: "org",
    NAV_AUDIT: "org",
    NAV_INTEGRATIONS: "integrations",
    NAV_RESEARCH_CHAIN: "research_chain",
}

# Keys each level opens. ``overview`` is implicit for every registered account.
LEVEL_NAV_KEYS = {
    ResearchLevel.ADMIN: frozenset(NAV_KEYS),
    ResearchLevel.PRINCIPAL: frozenset(
        (
            NAV_OVERVIEW,
            NAV_DASHBOARD,
            NAV_REPORTS,
            NAV_SUMMARY,
            NAV_PROJECTS,
            NAV_REVIEWS,
            NAV_APPROVALS,
            NAV_ORG,
            NAV_RESEARCH_CHAIN,
        )
    ),
    ResearchLevel.MENTOR: frozenset(
        (
            NAV_OVERVIEW,
            NAV_DASHBOARD,
            NAV_REPORTS,
            NAV_SUMMARY,
            NAV_PROJECTS,
            NAV_REVIEWS,
            NAV_APPROVALS,
            NAV_RESEARCH_CHAIN,
        )
    ),
    ResearchLevel.RESEARCHER: frozenset(
        (
            NAV_OVERVIEW,
            NAV_REPORTS,
            NAV_PROJECTS,
            NAV_RESEARCH_CHAIN,
        )
    ),
    ResearchLevel.NONE: frozenset(),
}


@dataclass(frozen=True)
class ResearchSignals:
    """Raw relations behind the level decision, resolved once per request."""

    is_admin: bool = False
    is_main_pi: bool = False
    is_principal: bool = False
    is_mentor: bool = False
    is_stage_reviewer: bool = False
    has_org_relation: bool = False
    has_profile: bool = False
    can_configure_integrations: bool = False
    can_operate_workspace: bool = False
    can_manage_accounts: bool = False

    @property
    def level(self):
        return research_level_from_signals(self)


def empty_signals() -> ResearchSignals:
    return ResearchSignals()


def org_signal_workspace(workspace):
    """The workspace holding the organisation relations used for the level.

    The main PI workspace mirrors the seat of organisation owners and main PIs
    (``sync_main_pi_workspace_seat``) and reads its aggregates from the public
    workspace, so its level resolves against the public organisation tree.
    Every other workspace resolves against itself.
    """
    if workspace is None:
        return None
    if getattr(workspace, "slug", None) != PI_WORKSPACE_SLUG:
        return workspace
    return Workspace.objects.filter(slug=PUBLIC_WORKSPACE_SLUG, deleted_at__isnull=True).first() or workspace


def _org_roles(user, workspace_id, on_date):
    return set(
        OrgUnitMember.objects.filter(
            active_membership_q(on_date),
            workspace_id=workspace_id,
            user=user,
            org_unit__workspace_id=workspace_id,
            org_unit__deleted_at__isnull=True,
            org_unit__is_active=True,
        ).values_list("org_role", flat=True)
    )


def has_active_research_org_relation(user, workspace, on_date=None):
    """判断调用方是否可通过科研 API 的组织关系门禁。

    科研管理员即使没有 OrgUnitMember 也会在此处返回 True，仅用于 API 门禁旁路，
    不会伪造 identity 中的 org_units 列表。

    Args:
        user: 当前请求用户。
        workspace: URL 对应的工作区或工作区主键。
        on_date: 用于生效期判断的日期，默认当天。

    Returns:
        科研管理员，或存在未删除、生效中且所属组织节点有效的成员关系时为 True。
    """
    if user is None or not getattr(user, "is_authenticated", False) or workspace is None:
        return False
    workspace_id = getattr(workspace, "id", workspace)
    if is_research_admin(user, workspace_id):
        return True
    signal_workspace = org_signal_workspace(workspace)
    signal_workspace_id = getattr(signal_workspace, "id", None)
    if signal_workspace_id is None:
        return False
    on_date = on_date or timezone.localdate()
    return bool(_org_roles(user, signal_workspace_id, on_date))


def _is_mentor(user, workspace_id, on_date):
    return MentorBinding.objects.filter(
        active_membership_q(on_date),
        workspace_id=workspace_id,
        mentor=user,
    ).exists()


def _is_stage_reviewer(user, workspace_id, now=None):
    """An assignment still valid: active, not superseded and not expired."""
    now = now or timezone.now()
    return (
        StageReviewerAssignment.objects.filter(
            stage_instance__workspace_id=workspace_id,
            stage_instance__deleted_at__isnull=True,
            reviewer=user,
            is_active=True,
            superseded_at__isnull=True,
            deleted_at__isnull=True,
        )
        .filter(Q(valid_until__isnull=True) | Q(valid_until__gt=now))
        .exists()
    )


def _has_profile(user):
    return ResearchUserProfile.objects.filter(user=user, deleted_at__isnull=True).exists()


def research_signals(user, workspace, on_date=None, now=None) -> ResearchSignals:
    """Resolve every relation the level needs (workspace scoped)."""
    if user is None or not getattr(user, "is_authenticated", False):
        return empty_signals()
    if workspace is None:
        return empty_signals()

    on_date = on_date or timezone.localdate()
    signal_workspace = org_signal_workspace(workspace)
    signal_workspace_id = getattr(signal_workspace, "id", None)

    roles = _org_roles(user, signal_workspace_id, on_date) if signal_workspace_id else set()
    has_org_relation = bool(roles)
    is_admin = is_research_admin(user, workspace.id)
    is_principal = bool(roles & set(PRINCIPAL_ORG_ROLES))
    is_mentor = bool(roles & set(MENTOR_ORG_ROLES)) or (
        has_org_relation and _is_mentor(user, signal_workspace_id, on_date)
    )
    is_stage_reviewer = (
        has_org_relation and _is_stage_reviewer(user, signal_workspace_id, now) if signal_workspace_id else False
    )

    return ResearchSignals(
        # Workspace and instance administrators retain research access even
        # without an organisation-unit assignment.
        is_admin=is_admin,
        is_main_pi=has_org_relation and is_main_pi(user, workspace),
        is_principal=is_principal,
        is_mentor=is_mentor,
        is_stage_reviewer=is_stage_reviewer,
        has_org_relation=has_org_relation,
        has_profile=has_org_relation and _has_profile(user),
        can_configure_integrations=is_admin or (has_org_relation and can_configure_integrations(user, workspace)),
        can_operate_workspace=is_admin or (has_org_relation and can_operate_workspace(user, workspace)),
        can_manage_accounts=is_admin or (has_org_relation and is_account_compat_admin(user, workspace)),
    )


def research_level_from_signals(signals: ResearchSignals) -> str:
    """Pure mapping from relations to the level (highest match wins)."""
    if signals.is_admin:
        return ResearchLevel.ADMIN
    if signals.is_main_pi or signals.is_principal:
        return ResearchLevel.PRINCIPAL
    # An assigned stage reviewer sits on the mentor tier: the assignment is what
    # opens the review surface, whatever the rest of the relations say.
    if signals.is_mentor or signals.is_stage_reviewer:
        return ResearchLevel.MENTOR
    if signals.has_org_relation or signals.has_profile:
        return ResearchLevel.RESEARCHER
    return ResearchLevel.NONE


def research_level(user, workspace, on_date=None, signals=None) -> str:
    signals = signals or research_signals(user, workspace, on_date)
    return research_level_from_signals(signals)


def level_nav_keys(level, is_stage_reviewer=False) -> set:
    """Keys the level opens, before the workspace sub switches are applied."""
    keys = set(LEVEL_NAV_KEYS.get(level, LEVEL_NAV_KEYS[ResearchLevel.NONE]))
    if is_stage_reviewer:
        # "Waiting for me" is granted per person: an assigned reviewer sees the
        # inbox even from the lowest level (v2.5.0 matrix).
        keys.add(NAV_REVIEWS)
    return keys


def signal_nav_keys(signals: ResearchSignals) -> set:
    keys = level_nav_keys(signals.level, is_stage_reviewer=signals.is_stage_reviewer)
    if signals.can_configure_integrations:
        keys.add(NAV_INTEGRATIONS)
    if signals.can_operate_workspace:
        keys.update((NAV_PLATFORM, NAV_AUDIT))
    if signals.can_manage_accounts:
        keys.add(NAV_SYSTEM)
    return keys


def section_allows(sections, key) -> bool:
    section = NAV_SECTION_KEYS.get(key)
    if section is None:
        return True
    return bool((sections or {}).get(section))


def nav_allowed(user, workspace, key, on_date=None, signals=None) -> bool:
    """Enforcement answer: may this caller reach the surface behind ``key``?

    The workspace sub switch is deliberately not part of the answer - the views
    already refuse a disabled section, and the endpoints that stay reachable
    while the module is off must keep behaving that way (configuration pages).
    """
    signals = signals or research_signals(user, workspace, on_date)
    return key in signal_nav_keys(signals)


def build_research_capabilities(user, workspace, on_date=None, signals=None) -> dict:
    """The payload published by ``identity/me`` and rendered by the frontend."""
    signals = signals or research_signals(user, workspace, on_date)
    level = research_level_from_signals(signals)
    keys = signal_nav_keys(signals)
    sections = workspace_research_sections(workspace) if workspace is not None else {}
    return {
        "level": level,
        "nav": [key for key in NAV_KEYS if key in keys and section_allows(sections, key)],
        "is_mentor": signals.is_mentor,
        "is_main_pi": signals.is_main_pi,
        "is_stage_reviewer": signals.is_stage_reviewer,
        "management": {
            "workspace": signals.is_admin,
            "organization": signals.is_admin or signals.is_main_pi or signals.is_principal,
            "integrations": signals.can_configure_integrations,
            "operations": signals.can_operate_workspace,
            "accounts": signals.can_manage_accounts,
        },
    }
