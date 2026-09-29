"""Resolve the Phase 1.5 validation roles from current workspace data."""

from django.utils import timezone

from plane.db.models import MentorBinding, OrgUnitMember, ResearchUserProfile, WorkspaceMember
from plane.research.utils.capabilities import ResearchLevel, research_signals
from plane.research.utils.org import active_membership_q
from plane.research.utils.roles import is_main_pi, is_research_admin


ROLE_ORDER = (
    "ADMIN",
    "PRINCIPAL",
    "INDUSTRIALIZATION_OWNER",
    "MENTOR",
    "RESEARCHER",
    "NONE",
    "Guest",
)


def resolve_role_context(user, workspace, on_date=None):
    """Resolve validation roles and evidence-safe relation counts for a user.

    Args:
        user: Authenticated Plane user to inspect.
        workspace: Workspace whose membership and organisation tree are tested.
        on_date: Optional date used for effective relation checks.

    Returns:
        A JSON-serializable role context suitable for the identity endpoint and
        role-validation evidence. It contains no credentials or email address.
    """
    on_date = on_date or timezone.localdate()
    membership = WorkspaceMember.objects.filter(
        workspace=workspace,
        member=user,
        is_active=True,
        deleted_at__isnull=True,
    ).first()
    if membership is None:
        return {
            "research_level": ResearchLevel.NONE,
            "roles": ["NONE"],
            "org_units": [],
            "business_categories": [],
            "mentor_binding_count": 0,
            "workspace_role": None,
        }

    memberships = list(
        OrgUnitMember.objects.filter(
            active_membership_q(on_date),
            workspace=workspace,
            user=user,
            org_unit__is_active=True,
        ).select_related("org_unit")
    )
    profile = ResearchUserProfile.objects.filter(user=user, deleted_at__isnull=True).first()
    bindings = MentorBinding.objects.filter(
        active_membership_q(on_date),
        workspace=workspace,
        mentor=user,
    )
    binding_count = bindings.count()
    signals = research_signals(user, workspace, on_date=on_date)
    roles = set()

    if is_research_admin(user, workspace):
        roles.add("ADMIN")
    if is_main_pi(user, workspace) or signals.is_principal:
        roles.add("PRINCIPAL")
    if any(
        member.org_unit.business_category == "INDUSTRIALIZATION"
        and member.org_role in {"OWNER", "PI"}
        for member in memberships
    ):
        roles.add("INDUSTRIALIZATION_OWNER")
    if (
        profile is not None
        and profile.category == ResearchUserProfile.Category.ADVISOR
        and any(member.org_role == "ADVISOR" for member in memberships)
        and binding_count > 0
    ):
        roles.add("MENTOR")
    if (
        profile is not None
        and profile.category == ResearchUserProfile.Category.STUDENT
        and any(member.org_role == "REVIEWER" for member in memberships)
    ):
        roles.add("RESEARCHER")
    if not roles:
        roles.add("Guest" if membership.role == 5 else "NONE")

    resolved_level = "NONE" if membership.role == 5 and not memberships else signals.level
    return {
        "research_level": resolved_level,
        "roles": [role for role in ROLE_ORDER if role in roles],
        "org_units": [
            {
                "id": str(member.org_unit_id),
                "role": member.org_role,
                "business_category": member.org_unit.business_category,
            }
            for member in memberships
        ],
        "business_categories": sorted(
            {member.org_unit.business_category for member in memberships if member.org_unit.business_category}
        ),
        "mentor_binding_count": binding_count,
        "workspace_role": membership.role,
    }
