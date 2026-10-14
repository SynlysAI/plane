# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Assignable-user boundaries and state machine for Research Chain tasks."""

from uuid import UUID, uuid4

from django.db import IntegrityError, transaction
from django.utils import timezone
from django.utils.dateparse import parse_datetime

from plane.db.models import (
    OrgUnitMember,
    ProjectMember,
    ResearchChain,
    ResearchChainEvent,
    ResearchChainNode,
    ResearchChainNodeTask,
    User,
    WorkspaceMember,
)
from plane.research.services.idempotency import payload_hash
from plane.research.utils.acl import (
    ResearchResource,
    build_actor_context,
    check_access,
    org_unit_ancestry,
    primary_advisor_ids,
)
from plane.research.utils.audit import ResearchAuditAction, ResearchResourceType, record_audit_event
from plane.research.utils.collaboration_notifications import (
    notify_task_assigned,
    notify_task_cancelled,
    notify_task_completed,
    notify_task_returned,
    notify_task_submitted,
)
from plane.research.utils.org import READABLE_WORKSPACE_ROLES, active_membership_q
from plane.research.utils.roles import is_research_admin

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
    """Raised when an actor cannot manage or execute a chain task action."""


class ChainTaskValidationError(Exception):
    """Raised when task payload data violates the frozen API contract."""


class ChainTaskStateError(Exception):
    """Raised when a task transition is unavailable from its current state."""


class ChainTaskConflictError(Exception):
    """Raised when an idempotency key is reused with another payload."""


def chain_manager(workspace, user, chain) -> bool:
    """Return whether the caller owns or administers the chain project.

    Args:
        workspace: Workspace used for future scope extensions.
        user: Caller whose chain management role is checked.
        chain: Research chain being managed.

    Returns:
        True when the caller owns the chain or has an active project admin role.
    """
    if is_research_admin(user, workspace.id) or chain.owner_id == user.id:
        return True
    return ProjectMember.objects.filter(
        project_id=chain.project_id,
        member=user,
        role__gte=20,
        is_active=True,
        deleted_at__isnull=True,
    ).exists()


def chain_lifecycle_manager(workspace, user, chain, *, workspace_admin=None) -> bool:
    """Return whether the caller may archive, restore, or delete a chain.

    Args:
        workspace: Workspace that owns the chain.
        user: Caller whose lifecycle authority is checked.
        chain: Research chain being managed.
        workspace_admin: Optional pre-resolved workspace administrator state.

    Returns:
        True when the caller owns or administers the chain project, or is an
        active administrator of the chain's workspace.
    """
    if workspace_admin is None:
        workspace_admin = is_research_admin(user, workspace.id)
    return workspace_admin or chain_manager(workspace, user, chain)


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

    Research administrators are never review-only: they hold both write and
    review authority even without an organisation assignment. This check must
    run before the main-PI short-circuit so a seated administrator who is also
    the configured main PI is not locked into a read-only review role.

    Args:
        workspace: Workspace that owns the chain.
        user: Caller whose review-only status is checked.
        chain: Research chain being accessed.

    Returns:
        True when the caller may review but not mutate the chain.
    """
    if chain.owner_id == user.id:
        return False
    if is_research_admin(user, workspace.id):
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
    if is_research_admin(user, workspace.id):
        return True
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
        memberships = OrgUnitMember.objects.filter(
            active_membership_q(today),
            workspace_id=workspace.id,
            org_unit_id__in=unit_ids,
            org_unit__deleted_at__isnull=True,
            user_id__in=active_workspace_user_ids,
            user__is_active=True,
        ).select_related("org_unit", "user")
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


def actor_can_review_task(workspace, task, actor) -> bool:
    """Return whether an actor holds research review rights for a task.

    Args:
        workspace: Workspace that must own the task.
        task: Research Chain node task under review.
        actor: User requesting a review action.

    Returns:
        True when the actor is a research administrator or a review-only reviewer.
    """
    if actor is None or not getattr(actor, "is_authenticated", False):
        return False
    if is_research_admin(actor, workspace.id):
        return True
    return review_only_actor(workspace, actor, task.chain)


def actor_can_cancel_task(workspace, task, actor) -> bool:
    """Return whether an actor may cancel a task.

    Args:
        workspace: Workspace that must own the task.
        task: Research Chain node task to cancel.
        actor: User requesting cancellation.

    Returns:
        True when the actor manages the task's chain.
    """
    if actor is None or not getattr(actor, "is_authenticated", False):
        return False
    return chain_manager(workspace, actor, task.chain)


def actor_can_submit_task(workspace, task, actor) -> bool:
    """Return whether the current assignee may submit a task now.

    Args:
        workspace: Workspace used for future scope extensions.
        task: Research Chain node task to submit.
        actor: User requesting submission.

    Returns:
        True when the actor is the assignee and the state accepts submission.
    """
    if actor is None or not getattr(actor, "is_authenticated", False):
        return False
    return task.assignee_id == actor.id and task.status in (
        ResearchChainNodeTask.Status.ASSIGNED,
        ResearchChainNodeTask.Status.NEEDS_REVISION,
    )


def _request_id(payload) -> str:
    """Extract and bound-check an idempotency key."""
    request_id = str(payload.get("request_id") or "").strip()
    if not request_id:
        raise ChainTaskValidationError("request_id is required.")
    if len(request_id) > 128:
        raise ChainTaskValidationError("request_id must contain at most 128 characters.")
    return request_id


def _parse_datetime(value, field_name):
    """Parse an optional API datetime value.

    Args:
        value: Raw datetime value supplied by a serializer or service caller.
        field_name: Field name used in validation errors.

    Returns:
        The parsed timezone-aware datetime, or None for an empty value.
    """
    if value in (None, ""):
        return None
    if hasattr(value, "tzinfo"):
        return value
    parsed = parse_datetime(str(value))
    if parsed is None:
        raise ChainTaskValidationError(f"{field_name} must be an ISO-8601 datetime.")
    if parsed.tzinfo is None:
        parsed = timezone.make_aware(parsed)
    return parsed


def _resource_values(payload):
    """Normalize and pair the task resource reference.

    Args:
        payload: Validated task payload containing resource fields.

    Returns:
        A ``(resource_type, resource_id)`` tuple.
    """
    raw_type = payload.get("resource_type")
    resource_type = str(raw_type or ResearchChainNodeTask.ResourceType.NONE).upper()
    if resource_type not in ResearchChainNodeTask.ResourceType.values:
        raise ChainTaskValidationError("resource_type is not supported.")
    raw_id = payload.get("resource_id")
    if resource_type == ResearchChainNodeTask.ResourceType.NONE:
        if raw_id not in (None, ""):
            raise ChainTaskValidationError("resource_id must be empty when resource_type is NONE.")
        return resource_type, None
    if raw_id in (None, ""):
        raise ChainTaskValidationError("resource_id is required for a task resource reference.")
    try:
        return resource_type, UUID(str(raw_id))
    except (TypeError, ValueError):
        raise ChainTaskValidationError("resource_id must be a valid UUID.") from None


def _assignee_from_payload(workspace, chain, payload):
    """Resolve and server-validate an optional task assignee.

    Args:
        workspace: Workspace that must own the chain.
        chain: Research chain whose candidate boundary applies.
        payload: Validated task payload containing ``assignee``.

    Returns:
        The resolved User, or None when no assignee was supplied.
    """
    value = payload.get("assignee")
    if value in (None, ""):
        return None
    user_id = value.id if hasattr(value, "id") else value
    if not validate_assignable_user(workspace, chain, user_id):
        raise ChainTaskPermissionError("assignee is outside the chain's assignable-user boundary.")
    return User.objects.get(pk=user_id, is_active=True)


def _ensure_task_parent_writable(chain, node):
    """Reject writes when a chain or archived node is read-only."""
    if chain.status != ResearchChain.Status.ACTIVE:
        raise ChainTaskStateError("Archived or completed chains are read-only.")
    if node.status == ResearchChainNode.Status.ARCHIVED:
        raise ChainTaskStateError("Archived nodes have read-only tasks.")


def _task_refs(task):
    """Build the standard chain/node/task event reference list."""
    return [
        {"kind": "chain", "id": str(task.chain_id)},
        {"kind": "node", "id": str(task.node_id)},
        {"kind": "task", "id": str(task.id), "status": task.status},
    ]


def _event_id_for_request(request_id, event_type, task_id):
    """Build a deterministic task event id."""
    return payload_hash({"request_id": request_id, "kind": event_type, "task_id": str(task_id)})


def _write_task_event(*, task, actor, request_id, event_type, summary, metadata, content_hash):
    """Append one immutable task fact to the Chain timeline."""
    return ResearchChainEvent.objects.create(
        chain=task.chain,
        node=task.node,
        event_id=_event_id_for_request(request_id, event_type, task.id),
        request_id=request_id,
        actor=actor,
        actor_type="USER",
        source_system="PLANE",
        event_type=event_type,
        occurred_at=timezone.now(),
        refs=_task_refs(task),
        summary=summary,
        content_hash=content_hash,
        metadata=metadata,
    )


def _write_task_audit(*, task, actor, action, metadata, request=None):
    """Append the audit-side record for a task mutation."""
    return record_audit_event(
        workspace=task.workspace,
        action=action,
        resource_type=ResearchResourceType.RESEARCH_CHAIN_NODE_TASK,
        resource_id=task.id,
        org_unit=getattr(task.chain.project.research_profile, "org_unit", None),
        actor=actor,
        metadata=metadata,
        request=request,
    )


def _replay_task_event(task, request_id, event_type, content_hash):
    """Return an existing task event or reject an incompatible replay."""
    existing = ResearchChainEvent.objects.filter(request_id=request_id).select_related("chain", "node").first()
    event_id = _event_id_for_request(request_id, event_type, task.id)
    if existing is None:
        existing = ResearchChainEvent.objects.filter(event_id=event_id).first()
    if existing is None:
        return None
    task_ref = next((ref for ref in existing.refs if ref.get("kind") == "task"), None)
    if (
        existing.chain_id != task.chain_id
        or existing.node_id != task.node_id
        or task_ref is None
        or task_ref.get("id") != str(task.id)
        or existing.event_type != event_type
        or existing.content_hash != content_hash
    ):
        raise ChainTaskConflictError("request_id was already used with another task action.")
    return existing


def _replay_task(workspace, chain, node, request_id, content_hash):
    """Return an idempotent task creation replay when it is compatible."""
    existing = (
        ResearchChainNodeTask.objects.select_related("workspace", "chain", "node", "assignee", "assigned_by")
        .filter(request_id=request_id)
        .first()
    )
    if existing is None:
        return None
    if (
        existing.workspace_id != workspace.id
        or existing.chain_id != chain.id
        or existing.node_id != node.id
        or existing.payload_hash != content_hash
    ):
        raise ChainTaskConflictError("request_id was already used with another task payload.")
    return existing


def list_tasks(*, workspace, chain, node, status=None, assignee_id=None, due_before=None):
    """List tasks attached to a visible node without mutating node state.

    Args:
        workspace: Workspace that must own the chain.
        chain: Research chain owning the node.
        node: Research chain node whose tasks are listed.
        status: Optional uppercase task status filter.
        assignee_id: Optional assignee UUID filter.
        due_before: Optional inclusive due-at upper bound.

    Returns:
        A queryset of tasks ordered by creation time.

    Raises:
        ChainTaskValidationError: When a filter value is malformed.
    """
    rows = ResearchChainNodeTask.objects.filter(workspace=workspace, chain=chain, node=node).select_related(
        "workspace", "chain", "node", "assignee", "assigned_by"
    )
    if status:
        normalized_status = str(status).upper()
        if normalized_status not in ResearchChainNodeTask.Status.values:
            raise ChainTaskValidationError("status is not a supported task status.")
        rows = rows.filter(status=normalized_status)
    if assignee_id not in (None, ""):
        try:
            rows = rows.filter(assignee_id=UUID(str(assignee_id)))
        except (TypeError, ValueError):
            raise ChainTaskValidationError("assignee must be a valid UUID.") from None
    parsed_due_before = _parse_datetime(due_before, "due_before")
    if parsed_due_before is not None:
        rows = rows.filter(due_at__lte=parsed_due_before)
    return rows.order_by("-created_at", "-updated_at")


def create_task(*, workspace, chain, node, actor, payload, request=None):
    """Create an idempotent Research Chain node task.

    Args:
        workspace: Workspace that must own the chain.
        chain: Active research chain receiving the task.
        node: Chain node that owns the task.
        actor: User creating the task.
        payload: Validated JSON payload with an idempotency key.
        request: Optional HTTP request used for audit client metadata.

    Returns:
        A ``(task, created)`` tuple; replayed requests return ``created=False``.

    Raises:
        ChainTaskPermissionError: When the actor or assignee is outside scope.
        ChainTaskValidationError: When required payload fields are invalid.
        ChainTaskStateError: When the parent chain or node is read-only.
        ChainTaskConflictError: When the request id is reused inconsistently.
    """
    request_id = _request_id(payload)
    digest = payload_hash(payload)
    if not actor_can_manage_chain_tasks(workspace, chain, actor):
        raise ChainTaskPermissionError("Only chain writers can create tasks.")
    existing = _replay_task(workspace, chain, node, request_id, digest)
    if existing is not None:
        return existing, False

    title = str(payload.get("title") or "").strip()
    if not title or len(title) > 500:
        raise ChainTaskValidationError("title is required and must contain at most 500 characters.")
    assignee = _assignee_from_payload(workspace, chain, payload)
    due_at = _parse_datetime(payload.get("due_at"), "due_at")
    resource_type, resource_id = _resource_values(payload)
    try:
        with transaction.atomic():
            locked_chain = ResearchChain.objects.select_for_update().get(pk=chain.pk)
            if not actor_can_manage_chain_tasks(workspace, locked_chain, actor):
                raise ChainTaskPermissionError("Only chain writers can create tasks.")
            if assignee is not None and not validate_assignable_user(workspace, locked_chain, assignee.id):
                raise ChainTaskPermissionError("assignee is outside the chain's assignable-user boundary.")
            _ensure_task_parent_writable(locked_chain, node)
            task = ResearchChainNodeTask.objects.create(
                workspace=workspace,
                chain=chain,
                node=node,
                title=title,
                instruction=str(payload.get("instruction") or ""),
                status=(
                    ResearchChainNodeTask.Status.ASSIGNED
                    if assignee is not None
                    else ResearchChainNodeTask.Status.DRAFT
                ),
                assignee=assignee,
                assigned_by=actor if assignee is not None else None,
                due_at=due_at,
                resource_type=resource_type,
                resource_id=resource_id,
                request_id=request_id,
                payload_hash=digest,
                created_by=actor,
                updated_by=actor,
            )
            _write_task_event(
                task=task,
                actor=actor,
                request_id=request_id,
                event_type="TASK_CREATED",
                summary=f"Created task: {task.title}",
                metadata={"status": task.status},
                content_hash=digest,
            )
            _write_task_audit(
                task=task,
                actor=actor,
                action=ResearchAuditAction.TASK_CREATE,
                metadata={"node": str(node.id), "status": task.status},
                request=request,
            )
            if assignee is not None:
                notify_task_assigned(task, actor)
        return task, True
    except IntegrityError:
        existing = _replay_task(workspace, chain, node, request_id, digest)
        if existing is not None:
            return existing, False
        raise ChainTaskConflictError("request_id was already used.") from None


def update_task(*, task, actor, payload, request=None):
    """Update editable task fields without changing lifecycle state directly.

    Args:
        task: Research Chain node task to update.
        actor: User editing or assigning the task.
        payload: Validated partial payload.
        request: Optional HTTP request used for audit client metadata.

    Returns:
        The updated task.

    Raises:
        ChainTaskPermissionError: When the actor or new assignee is denied.
        ChainTaskValidationError: When an editable field is invalid.
        ChainTaskStateError: When the task or its parent is read-only.
    """
    if not actor_can_manage_chain_tasks(task.workspace, task.chain, actor):
        raise ChainTaskPermissionError("Only chain writers can update tasks.")
    if task.status not in (
        ResearchChainNodeTask.Status.DRAFT,
        ResearchChainNodeTask.Status.ASSIGNED,
        ResearchChainNodeTask.Status.NEEDS_REVISION,
    ):
        raise ChainTaskStateError("Completed or cancelled tasks are read-only.")
    if "assignee" in payload and payload["assignee"] in (None, ""):
        raise ChainTaskValidationError("An assigned task assignee cannot be cleared.")

    next_assignee = task.assignee
    if "assignee" in payload:
        next_assignee = _assignee_from_payload(task.workspace, task.chain, payload)
    next_title = task.title
    if "title" in payload:
        next_title = str(payload["title"] or "").strip()
        if not next_title or len(next_title) > 500:
            raise ChainTaskValidationError("title is required and must contain at most 500 characters.")
    next_instruction = task.instruction
    if "instruction" in payload:
        next_instruction = str(payload["instruction"] or "")
    next_due_at = task.due_at
    if "due_at" in payload:
        next_due_at = _parse_datetime(payload["due_at"], "due_at")
    next_resource_type, next_resource_id = task.resource_type, task.resource_id
    if "resource_type" in payload or "resource_id" in payload:
        next_resource_type, next_resource_id = _resource_values(
            {
                "resource_type": payload.get("resource_type", task.resource_type),
                "resource_id": payload.get("resource_id", task.resource_id),
            }
        )

    assignee_changed = next_assignee is not None and next_assignee.id != task.assignee_id
    changed_fields = sorted(
        field
        for field, current, next_value in (
            ("title", task.title, next_title),
            ("instruction", task.instruction, next_instruction),
            ("due_at", task.due_at, next_due_at),
            ("resource_type", task.resource_type, next_resource_type),
            ("resource_id", task.resource_id, next_resource_id),
        )
        if current != next_value
    )
    if assignee_changed:
        changed_fields.append("assignee")
        changed_fields.sort()

    try:
        with transaction.atomic():
            locked_chain = ResearchChain.objects.select_for_update().get(pk=task.chain_id)
            locked_node = ResearchChainNode.objects.select_for_update().get(pk=task.node_id)
            _ensure_task_parent_writable(locked_chain, locked_node)
            locked_task = ResearchChainNodeTask.objects.select_for_update().get(pk=task.pk)
            if not actor_can_manage_chain_tasks(locked_task.workspace, locked_chain, actor):
                raise ChainTaskPermissionError("Only chain writers can update tasks.")
            if assignee_changed and not validate_assignable_user(locked_task.workspace, locked_chain, next_assignee.id):
                raise ChainTaskPermissionError("assignee is outside the chain's assignable-user boundary.")
            if locked_task.status not in (
                ResearchChainNodeTask.Status.DRAFT,
                ResearchChainNodeTask.Status.ASSIGNED,
                ResearchChainNodeTask.Status.NEEDS_REVISION,
            ):
                raise ChainTaskStateError("Completed or cancelled tasks are read-only.")
            previous_assignee_id = locked_task.assignee_id
            locked_task.title = next_title
            locked_task.instruction = next_instruction
            locked_task.due_at = next_due_at
            locked_task.resource_type = next_resource_type
            locked_task.resource_id = next_resource_id
            if assignee_changed:
                locked_task.assignee = next_assignee
                locked_task.assigned_by = actor
                if locked_task.status == ResearchChainNodeTask.Status.DRAFT:
                    locked_task.status = ResearchChainNodeTask.Status.ASSIGNED
            locked_task.updated_by = actor
            update_fields = {*changed_fields, "updated_by", "updated_at"}
            if assignee_changed:
                update_fields.update({"assigned_by"})
                if previous_assignee_id is None:
                    update_fields.update({"status"})
            locked_task.save(update_fields=list(update_fields))

            _write_task_audit(
                task=locked_task,
                actor=actor,
                action=ResearchAuditAction.TASK_UPDATE,
                metadata={"fields": changed_fields},
                request=request,
            )
            if assignee_changed:
                assignment_request_id = f"task-assigned-{locked_task.id}-{uuid4().hex}"
                _write_task_event(
                    task=locked_task,
                    actor=actor,
                    request_id=assignment_request_id[:128],
                    event_type="TASK_ASSIGNED",
                    summary=f"Assigned task: {locked_task.title}",
                    metadata={
                        "previous_assignee": str(previous_assignee_id) if previous_assignee_id else None,
                        "assignee": str(locked_task.assignee_id),
                    },
                    content_hash=payload_hash(
                        {"task_id": str(locked_task.id), "assignee": str(locked_task.assignee_id)}
                    ),
                )
                notify_task_assigned(locked_task, actor)
            return locked_task
    except IntegrityError as error:
        raise ChainTaskConflictError("The task could not be updated consistently.") from error


def _run_task_action(*, task, actor, request_id, event_type, content_hash, action, request, metadata, guard):
    """Lock, replay, transition, and record one task state action."""
    with transaction.atomic():
        locked_chain = ResearchChain.objects.select_for_update().get(pk=task.chain_id)
        locked_node = ResearchChainNode.objects.select_for_update().get(pk=task.node_id)
        _ensure_task_parent_writable(locked_chain, locked_node)
        locked_task = ResearchChainNodeTask.objects.select_for_update().get(pk=task.pk)
        guard(locked_task)
        existing_event = _replay_task_event(locked_task, request_id, event_type, content_hash)
        if existing_event is not None:
            return locked_task, False
        action(locked_task)
        _write_task_event(
            task=locked_task,
            actor=actor,
            request_id=request_id,
            event_type=event_type,
            summary=f"{event_type}: {locked_task.title}",
            metadata=metadata | {"status": locked_task.status},
            content_hash=content_hash,
        )
        _write_task_audit(
            task=locked_task,
            actor=actor,
            action={
                "TASK_SUBMITTED": ResearchAuditAction.TASK_SUBMIT,
                "TASK_RETURNED": ResearchAuditAction.TASK_RETURN,
                "TASK_COMPLETED": ResearchAuditAction.TASK_COMPLETE,
                "TASK_CANCELLED": ResearchAuditAction.TASK_CANCEL,
            }[event_type],
            metadata=metadata | {"status": locked_task.status},
            request=request,
        )
        if event_type == "TASK_SUBMITTED":
            notify_task_submitted(locked_task, actor)
        elif event_type == "TASK_RETURNED":
            notify_task_returned(locked_task, actor, metadata.get("reason", ""))
        elif event_type == "TASK_COMPLETED":
            notify_task_completed(locked_task, actor, metadata.get("comment", ""))
        elif event_type == "TASK_CANCELLED":
            notify_task_cancelled(locked_task, actor, metadata.get("reason", ""))
        return locked_task, True


def submit_task(*, task, actor, request_id, content_hash, request=None):
    """Submit a task as its current assignee.

    Args:
        task: Research Chain node task to submit.
        actor: User claiming to be the current assignee.
        request_id: Idempotency key supplied by the caller.
        content_hash: Stable payload hash used for replay.
        request: Optional HTTP request used for audit client metadata.

    Returns:
        A ``(task, changed)`` tuple.
    """
    request_id = _request_id({"request_id": request_id})
    if not actor_can_submit_task(task.workspace, task, actor):
        raise ChainTaskPermissionError("Only the current assignee can submit this task.")

    def action(locked_task):
        if locked_task.status not in (
            ResearchChainNodeTask.Status.ASSIGNED,
            ResearchChainNodeTask.Status.NEEDS_REVISION,
        ):
            raise ChainTaskStateError(f"SUBMIT is not allowed from {locked_task.status}.")
        locked_task.status = ResearchChainNodeTask.Status.SUBMITTED
        locked_task.submitted_at = timezone.now()
        locked_task.updated_by = actor
        locked_task.save(update_fields=["status", "submitted_at", "updated_by", "updated_at"])

    return _run_task_action(
        task=task,
        actor=actor,
        request_id=request_id,
        event_type="TASK_SUBMITTED",
        content_hash=content_hash,
        action=action,
        request=request,
        metadata={},
        guard=lambda locked_task: _require_submit_permission(locked_task, actor),
    )


def _require_submit_permission(task, actor):
    """Recheck submit authority after the task row has been locked."""
    if task.assignee_id != actor.id:
        raise ChainTaskPermissionError("Only the current assignee can submit this task.")


def return_task(*, task, actor, reason, request_id, content_hash, request=None):
    """Return a submitted task for revision.

    Args:
        task: Research Chain node task to return.
        actor: Reviewer returning the task.
        reason: Required revision reason.
        request_id: Idempotency key supplied by the caller.
        content_hash: Stable payload hash used for replay.
        request: Optional HTTP request used for audit client metadata.

    Returns:
        A ``(task, changed)`` tuple.
    """
    request_id = _request_id({"request_id": request_id})
    reason = str(reason or "").strip()
    if not reason:
        raise ChainTaskValidationError("reason is required.")
    if not actor_can_review_task(task.workspace, task, actor):
        raise ChainTaskPermissionError("Only research reviewers can return tasks.")

    def action(locked_task):
        if locked_task.status != ResearchChainNodeTask.Status.SUBMITTED:
            raise ChainTaskStateError(f"RETURN is not allowed from {locked_task.status}.")
        locked_task.status = ResearchChainNodeTask.Status.NEEDS_REVISION
        locked_task.updated_by = actor
        locked_task.save(update_fields=["status", "updated_by", "updated_at"])

    return _run_task_action(
        task=task,
        actor=actor,
        request_id=request_id,
        event_type="TASK_RETURNED",
        content_hash=content_hash,
        action=action,
        request=request,
        metadata={"reason": reason[:500]},
        guard=lambda locked_task: _require_review_permission(locked_task, actor),
    )


def _require_review_permission(task, actor):
    """Recheck review authority after related ACL inputs may have changed."""
    if not actor_can_review_task(task.workspace, task, actor):
        raise ChainTaskPermissionError("Only research reviewers can manage submitted tasks.")


def complete_task(*, task, actor, comment="", request_id=None, content_hash="", request=None):
    """Complete a submitted task after research review.

    Args:
        task: Research Chain node task to complete.
        actor: Reviewer accepting the task.
        comment: Optional completion comment.
        request_id: Idempotency key supplied by the caller.
        content_hash: Stable payload hash used for replay.
        request: Optional HTTP request used for audit client metadata.

    Returns:
        A ``(task, changed)`` tuple.
    """
    request_id = _request_id({"request_id": request_id})
    if not actor_can_review_task(task.workspace, task, actor):
        raise ChainTaskPermissionError("Only research reviewers can complete tasks.")

    def action(locked_task):
        if locked_task.status != ResearchChainNodeTask.Status.SUBMITTED:
            raise ChainTaskStateError(f"COMPLETE is not allowed from {locked_task.status}.")
        locked_task.status = ResearchChainNodeTask.Status.COMPLETED
        locked_task.completed_at = timezone.now()
        locked_task.updated_by = actor
        locked_task.save(update_fields=["status", "completed_at", "updated_by", "updated_at"])

    return _run_task_action(
        task=task,
        actor=actor,
        request_id=request_id,
        event_type="TASK_COMPLETED",
        content_hash=content_hash,
        action=action,
        request=request,
        metadata={"comment": str(comment or "")[:500]},
        guard=lambda locked_task: _require_review_permission(locked_task, actor),
    )


def cancel_task(*, task, actor, reason, request_id, content_hash, request=None):
    """Cancel an open task as a chain manager.

    Args:
        task: Research Chain node task to cancel.
        actor: Chain manager cancelling the task.
        reason: Required cancellation reason.
        request_id: Idempotency key supplied by the caller.
        content_hash: Stable payload hash used for replay.
        request: Optional HTTP request used for audit client metadata.

    Returns:
        A ``(task, changed)`` tuple.
    """
    request_id = _request_id({"request_id": request_id})
    reason = str(reason or "").strip()
    if not reason:
        raise ChainTaskValidationError("reason is required.")
    if not actor_can_cancel_task(task.workspace, task, actor):
        raise ChainTaskPermissionError("Only chain managers can cancel tasks.")

    def action(locked_task):
        if locked_task.status not in (
            ResearchChainNodeTask.Status.DRAFT,
            ResearchChainNodeTask.Status.ASSIGNED,
            ResearchChainNodeTask.Status.NEEDS_REVISION,
        ):
            raise ChainTaskStateError(f"CANCEL is not allowed from {locked_task.status}.")
        locked_task.status = ResearchChainNodeTask.Status.CANCELLED
        locked_task.updated_by = actor
        locked_task.save(update_fields=["status", "updated_by", "updated_at"])

    return _run_task_action(
        task=task,
        actor=actor,
        request_id=request_id,
        event_type="TASK_CANCELLED",
        content_hash=content_hash,
        action=action,
        request=request,
        metadata={"reason": reason[:500]},
        guard=lambda locked_task: _require_cancel_permission(locked_task, actor),
    )


def _require_cancel_permission(task, actor):
    """Recheck management authority while the task row is locked."""
    if not chain_manager(task.workspace, actor, task.chain):
        raise ChainTaskPermissionError("Only chain managers can cancel tasks.")
