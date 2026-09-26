"""Resolve a research chain to its shared team knowledge base."""

from dataclasses import dataclass

from django.db import transaction
from django.utils import timezone

from plane.db.models import (
    OrgUnit,
    OrgUnitMember,
    ResearchChain,
    ResearchGroupKnowledgeBinding,
    ResearchKnowledgeRequest,
)
from plane.research.utils.org import active_membership_q
from plane.research.utils.roles import is_research_admin
def _primary_membership(workspace, owner):
    """Return the owner's current primary organisation membership.

    Args:
        workspace: Workspace that owns the membership.
        owner: Chain owner.

    Returns:
        The effective primary membership, or ``None``.
    """
    if owner is None:
        return None
    return (
        OrgUnitMember.objects.filter(
            active_membership_q(),
            workspace=workspace,
            user=owner,
            is_primary=True,
        )
        .select_related("org_unit", "org_unit__parent")
        .first()
    )

SCOPE_GROUP = "GROUP"
SCOPE_LEGACY_CHAIN = "LEGACY_CHAIN"
SCOPE_UNASSIGNED = "UNASSIGNED"
SUPERSEDED_REASON = "group_kb_2026_09_26"


@dataclass
class KnowledgeScope:
    """The knowledge base a chain may upload to."""

    scope: str
    state: str
    external_kb_id: str
    external_kb_name: str
    request_id: str
    org_unit_id: str
    org_unit_name: str
    binding: ResearchGroupKnowledgeBinding | ResearchKnowledgeRequest | None


def nearest_team(unit):
    """Walk a unit and its ancestors until a live TEAM node is found.

    Args:
        unit: Organisation node, or ``None``.

    Returns:
        The nearest TEAM ancestor, including the node itself, or ``None``.
    """
    seen = set()
    current = unit
    while current is not None and current.id not in seen:
        seen.add(current.id)
        if current.deleted_at is None and current.unit_type == OrgUnit.UnitType.TEAM:
            return current
        try:
            current = current.parent
        except OrgUnit.DoesNotExist:
            return None
    return None


def resolve_team_org_unit(chain):
    """Resolve the team that owns a chain's shared knowledge base.

    Args:
        chain: Research chain whose project and owner are loaded.

    Returns:
        The TEAM org unit, or ``None`` when the chain has no team.
    """
    profile = getattr(chain.project, "research_profile", None)
    if profile is not None and profile.org_unit_id:
        team = nearest_team(profile.org_unit)
        if team is not None:
            return team
    membership = _primary_membership(chain.workspace, chain.owner)
    if membership is not None:
        return nearest_team(membership.org_unit)
    return None


def _scope_from_binding(binding, team, scope):
    """Build a scope projection from a group binding or legacy request.

    Args:
        binding: Group binding or per-chain request.
        team: Resolved team, if any.
        scope: ``GROUP`` or ``LEGACY_CHAIN``.

    Returns:
        Knowledge scope for list and upload checks.
    """
    return KnowledgeScope(
        scope=scope,
        state=binding.state,
        external_kb_id=binding.external_kb_id or "",
        external_kb_name=binding.external_kb_name or "",
        request_id=str(binding.id),
        org_unit_id=str(team.id) if team is not None else "",
        org_unit_name=team.name if team is not None else "",
        binding=binding,
    )


def _unassigned_scope():
    """Return the scope used when a chain has no team and no legacy request."""
    return KnowledgeScope(
        scope=SCOPE_UNASSIGNED,
        state=SCOPE_UNASSIGNED,
        external_kb_id="",
        external_kb_name="",
        request_id="",
        org_unit_id="",
        org_unit_name="",
        binding=None,
    )


def ensure_group_knowledge_binding(chain, actor=None):
    """Create or revive the single knowledge binding for a chain's team.

    Args:
        chain: Research chain to attach.
        actor: User recorded as the creator of a new binding.

    Returns:
        The team binding, or ``None`` when the chain has no team.
    """
    team = resolve_team_org_unit(chain)
    if team is None:
        return None
    existing = ResearchGroupKnowledgeBinding.all_objects.filter(workspace=chain.workspace, org_unit=team).first()
    if existing is not None:
        if existing.deleted_at is not None:
            existing.deleted_at = None
            if existing.state == ResearchGroupKnowledgeBinding.State.ARCHIVED:
                existing.state = ResearchGroupKnowledgeBinding.State.PENDING_ADMIN
            existing.save(update_fields=["deleted_at", "state", "updated_at"])
        return existing
    return ResearchGroupKnowledgeBinding.objects.create(
        workspace=chain.workspace,
        org_unit=team,
        request_key=f"team:{team.id}",
        state=ResearchGroupKnowledgeBinding.State.PENDING_ADMIN,
        created_by=actor,
    )


def knowledge_scope_for_chain(chain, *, ensure=False, actor=None):
    """Resolve whether a chain uses a legacy KB, a team KB, or neither.

    Args:
        chain: Research chain to resolve.
        ensure: Create the team binding when the chain belongs to a team.
        actor: Creator recorded when ``ensure`` inserts a binding.

    Returns:
        The upload and list scope for this chain.
    """
    legacy = ResearchKnowledgeRequest.objects.filter(chain=chain, deleted_at__isnull=True).first()
    if legacy is not None and legacy.state == ResearchKnowledgeRequest.State.READY and legacy.external_kb_id:
        return _scope_from_binding(legacy, resolve_team_org_unit(chain), SCOPE_LEGACY_CHAIN)
    team = resolve_team_org_unit(chain)
    if team is not None:
        binding = (
            ensure_group_knowledge_binding(chain, actor)
            if ensure
            else ResearchGroupKnowledgeBinding.objects.filter(
                workspace=chain.workspace, org_unit=team, deleted_at__isnull=True
            ).first()
        )
        if binding is None:
            return _unassigned_scope()
        return _scope_from_binding(binding, team, SCOPE_GROUP)
    if legacy is not None and legacy.state != ResearchKnowledgeRequest.State.ARCHIVED:
        return _scope_from_binding(legacy, None, SCOPE_LEGACY_CHAIN)
    return _unassigned_scope()


def external_kb_conflicts(external_id, team):
    """Return whether an external KB is already owned by another team.

    Args:
        external_id: WeKnora knowledge base id being bound.
        team: Team that wants to use the id.

    Returns:
        True when another team or an unrelated legacy chain already owns it.
    """
    if ResearchGroupKnowledgeBinding.objects.filter(external_kb_id=external_id, deleted_at__isnull=True).exclude(
        org_unit=team
    ).exists():
        return True
    legacy_rows = ResearchKnowledgeRequest.objects.filter(
        external_kb_id=external_id,
        state=ResearchKnowledgeRequest.State.READY,
        deleted_at__isnull=True,
    ).select_related("chain", "chain__project", "chain__project__research_profile", "chain__project__research_profile__org_unit", "chain__owner")
    for row in legacy_rows:
        other = resolve_team_org_unit(row.chain)
        if other is None or other.id != team.id:
            return True
    return False


def _item_kb_id(item):
    """Return the knowledge-base id carried by a normalised search item.

    Args:
        item: Search item from RAGPortal.

    Returns:
        The external knowledge-base id, or an empty string.
    """
    metadata = item.get("metadata") or {}
    return str(item.get("external_parent_id") or metadata.get("knowledge_base_id") or metadata.get("kb_id") or "")


def member_team_ids(user, workspace):
    """Return TEAM ids visible through the caller's active memberships.

    Args:
        user: Request user.
        workspace: Workspace that owns the memberships.

    Returns:
        Ids of TEAM nodes, including a parent TEAM of a child-unit membership.
    """
    if user is None or not getattr(user, "is_authenticated", False):
        return set()
    memberships = OrgUnitMember.objects.filter(active_membership_q(), workspace=workspace, user=user).select_related(
        "org_unit"
    )
    teams = set()
    for membership in memberships:
        team = nearest_team(membership.org_unit)
        if team is not None:
            teams.add(team.id)
    return teams


def group_binding_map(workspace):
    """Map a ready external knowledge-base id to its team.

    Args:
        workspace: Workspace that owns the bindings.

    Returns:
        External KB id to org-unit id.
    """
    return {
        row.external_kb_id: row.org_unit_id
        for row in ResearchGroupKnowledgeBinding.objects.filter(workspace=workspace, deleted_at__isnull=True).exclude(
            external_kb_id=""
        )
    }


def allowed_group_kb_ids(user, workspace):
    """Return group libraries the caller may search in full.

    Args:
        user: Request user.
        workspace: Workspace that owns the bindings.

    Returns:
        External knowledge-base ids. Administrators may read every team library.
    """
    bindings = group_binding_map(workspace)
    if not bindings:
        return set()
    if is_research_admin(user, workspace):
        return set(bindings)
    teams = member_team_ids(user, workspace)
    return {kb_id for kb_id, unit_id in bindings.items() if unit_id in teams}


def grant_group_library_access(items, user, workspace):
    """Let team members pass the source ACL for their shared library.

    Metadata is not a chain filter. Membership in the TEAM, including through a
    child unit, is what grants retrieval of the whole library.

    Args:
        items: Raw search items.
        user: Request user.
        workspace: Workspace being searched.

    Returns:
        Items with the caller added to the ACL of their own team libraries.
    """
    allowed = allowed_group_kb_ids(user, workspace)
    if not allowed:
        return items
    user_id = str(getattr(user, "id", "") or "")
    granted = []
    for item in items:
        if _item_kb_id(item) not in allowed:
            granted.append(item)
            continue
        hint = dict(item.get("acl_hint") or {})
        users = {str(value) for value in hint.get("users", [])}
        users.add(user_id)
        updated = dict(item)
        updated["acl_hint"] = {**hint, "users": sorted(users)}
        granted.append(updated)
    return granted


def filter_group_library_items(items, user, workspace):
    """Drop group-library documents the caller is not allowed to read.

    Args:
        items: Normalised search items.
        user: Request user.
        workspace: Workspace that owns the bindings.

    Returns:
        Items with other teams' shared libraries removed.
    """
    bindings = group_binding_map(workspace)
    if not bindings or is_research_admin(user, workspace):
        return items
    allowed = allowed_group_kb_ids(user, workspace)
    visible = []
    for item in items:
        kb_id = _item_kb_id(item)
        if kb_id and kb_id in bindings and kb_id not in allowed:
            continue
        visible.append(item)
    return visible


def migrate_pending_chain_requests():
    """Archive unfinished per-chain requests into one binding per team.

    Returns:
        Number of chain requests archived.
    """
    archived = 0
    rows = ResearchKnowledgeRequest.objects.exclude(
        state__in=(ResearchKnowledgeRequest.State.READY, ResearchKnowledgeRequest.State.ARCHIVED)
    ).select_related(
        "chain",
        "chain__project",
        "chain__project__research_profile",
        "chain__project__research_profile__org_unit",
        "chain__owner",
        "chain__workspace",
    )
    with transaction.atomic():
        for row in rows:
            if not isinstance(row.chain, ResearchChain):
                continue
            team = resolve_team_org_unit(row.chain)
            if team is None:
                continue
            binding = ensure_group_knowledge_binding(row.chain, row.created_by)
            summary = dict(row.parameter_summary or {})
            summary["superseded_by_group_binding_id"] = str(binding.id)
            summary["superseded_reason"] = SUPERSEDED_REASON
            row.state = ResearchKnowledgeRequest.State.ARCHIVED
            row.parameter_summary = summary
            row.updated_at = timezone.now()
            row.save(update_fields=["state", "parameter_summary", "updated_at"])
            archived += 1
    return archived
