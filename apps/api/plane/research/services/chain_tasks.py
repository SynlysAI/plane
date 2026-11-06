# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Assignable-user boundaries and state machine for Research Chain tasks."""

from uuid import UUID, uuid4

from bs4 import BeautifulSoup
from django.db import IntegrityError, transaction
from django.utils import timezone
from django.utils.dateparse import parse_datetime

from plane.db.models import (
    FileAsset,
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
    notify_task_deleted,
    notify_task_reopened,
    notify_task_updated,
)
from plane.research.utils.org import READABLE_WORKSPACE_ROLES, active_membership_q
from plane.research.utils.chain_permissions import (
    effective_chain_visibility,
    is_basic_research_chain,
    is_research_workspace_member,
    research_workspace_members,
)
from plane.research.utils.roles import is_research_admin
from plane.research.utils.todo_context import reuse_todo_query
from plane.utils.content_validator import validate_html_content

ORG_SCOPE = "ORG_SCOPE"
COLLABORATOR_SCOPE = "COLLABORATOR"
WORKSPACE_SCOPE = "WORKSPACE"
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


@reuse_todo_query
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
    effective_visibility = effective_chain_visibility(profile, configured_visibility=chain.visibility)
    visibility = {"MEMBERS": "UNIT", "ORG": "ANCESTRY"}.get(effective_visibility, effective_visibility)
    return ResearchResource(
        kind="research_chain",
        workspace_id=chain.workspace_id,
        owner_id=chain.owner_id,
        org_unit_id=getattr(profile, "org_unit_id", None),
        visibility=visibility,
        state=chain.status,
        project_id=chain.project_id,
        is_team_content=effective_visibility != "PRIVATE",
    )


@reuse_todo_query
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


@reuse_todo_query
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


def _clean_instruction(value, task=None):
    """清洗任务说明并限制内嵌图片来源。

    Args:
        value: 原始任务说明 HTML。
        task: 已存在的科研任务；创建阶段为空。

    Returns:
        清洗后的任务说明 HTML。
    """
    valid, _error, cleaned = validate_html_content(str(value or ""))
    if not valid:
        raise ChainTaskValidationError("instruction is not valid rich text.")
    cleaned = cleaned or ""
    document = BeautifulSoup(cleaned, "html.parser")
    nodes = document.find_all(["img", "image-component"])
    if not nodes:
        return cleaned
    if task is None:
        raise ChainTaskValidationError("task instructions cannot reference images before the task exists.")
    prefix = (
        f"/api/research/workspaces/{task.workspace.slug}/chains/{task.chain_id}/"
        f"nodes/{task.node_id}/tasks/{task.id}/instruction-images/"
    )
    for node in nodes:
        source = node.get("src", "")
        asset_id = str(source[len(prefix) :]).rstrip("/") if source.startswith(prefix) else ""
        try:
            valid_asset = bool(UUID(asset_id)) if asset_id else False
        except ValueError:
            valid_asset = False
        if (
            not valid_asset
            or not FileAsset.objects.filter(
                pk=asset_id,
                workspace_id=task.workspace_id,
                entity_type=FileAsset.EntityTypeContext.RESEARCH_TASK_INSTRUCTION_IMAGE,
                entity_identifier=str(task.id),
                is_uploaded=True,
                is_deleted=False,
                deleted_at__isnull=True,
            ).exists()
        ):
            raise ChainTaskValidationError("task instructions do not accept external images.")
    return cleaned


def _task_user_name(user):
    """返回任务动态中使用的用户显示名称。"""
    if user is None:
        return None
    return user.display_name or " ".join(
        part for part in (user.first_name, user.last_name) if part
    ) or user.email


def _task_plain_text(value, limit=240):
    """将任务动态中的评论或原因转换为限长纯文本摘要。"""
    if value is None:
        return ""
    return BeautifulSoup(str(value), "html.parser").get_text(" ", strip=True)[:limit]


def _task_change_value(field, value):
    """将任务字段转换为可安全写入首页动态的短文本。"""
    if value is None:
        return None
    if field == "assignee":
        return _task_user_name(value) if hasattr(value, "display_name") else str(value)
    if field == "status":
        return {
            ResearchChainNodeTask.Status.DRAFT: "草稿",
            ResearchChainNodeTask.Status.ASSIGNED: "已指派",
            ResearchChainNodeTask.Status.COMPLETED: "已完成",
            ResearchChainNodeTask.Status.CANCELLED: "已取消",
        }.get(str(value), str(value))
    if field == "resource_type":
        return {
            ResearchChainNodeTask.ResourceType.NONE: "无关联资源",
            ResearchChainNodeTask.ResourceType.REPORT: "报告",
            ResearchChainNodeTask.ResourceType.STAGE_MATERIAL: "阶段材料",
            ResearchChainNodeTask.ResourceType.OUTCOME: "成果",
            ResearchChainNodeTask.ResourceType.PAPER_REVIEW: "论文评审",
            ResearchChainNodeTask.ResourceType.SNAPSHOT: "快照",
            ResearchChainNodeTask.ResourceType.EXTERNAL_REF: "外部引用",
        }.get(str(value), str(value))
    if field == "due_at":
        return value.isoformat() if hasattr(value, "isoformat") else str(value)
    if field == "instruction":
        return _task_plain_text(value) or None
    return str(value)[:240]


def _task_changes(old_values, new_values):
    """构造任务字段级前后值，忽略没有发生变化的字段。"""
    changes = []
    for field, old_value in old_values.items():
        new_value = new_values.get(field)
        old_display = _task_change_value(field, old_value)
        new_display = _task_change_value(field, new_value)
        if old_display == new_display and (field != "assignee" or old_value == new_value):
            continue
        changes.append({"field": field, "old_value": old_display, "new_value": new_display})
    return changes


def _task_creation_changes(task):
    """构造任务创建时实际写入字段的初始变更。"""
    fields = ["title", "status"]
    if task.instruction:
        fields.append("instruction")
    if task.due_at:
        fields.append("due_at")
    if task.resource_type != ResearchChainNodeTask.ResourceType.NONE:
        fields.append("resource_type")
    if task.resource_id:
        fields.append("resource_id")
    if task.assignee_id:
        fields.append("assignee")
    return _task_changes(
        {field: None for field in fields},
        {
            "title": task.title,
            "status": task.status,
            "instruction": task.instruction,
            "due_at": task.due_at,
            "resource_type": task.resource_type,
            "resource_id": task.resource_id,
            "assignee": task.assignee,
        },
    )


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


def assignable_project_members(workspace, chain):
    """查询可承担科研任务的有效课题成员。

    Args:
        workspace: 当前工作区。
        chain: 任务所属研究链。

    Returns:
        账号、工作区关系及课题关系均有效的成员查询集。
    """
    workspace_members = WorkspaceMember.objects.filter(
        workspace_id=workspace.id,
        role__in=READABLE_WORKSPACE_ROLES,
        is_active=True,
        deleted_at__isnull=True,
    ).values("member_id")
    return ProjectMember.objects.filter(
        workspace_id=workspace.id,
        project_id=chain.project_id,
        project__workspace_id=workspace.id,
        member_id__in=workspace_members,
        member__is_active=True,
        role__in=READABLE_WORKSPACE_ROLES,
        is_active=True,
        deleted_at__isnull=True,
    )


def assignable_chain_members(workspace, chain):
    """统一查询研究链可指派成员，不自动创建课题成员关系。

    Args:
        workspace: 当前工作区。
        chain: 行动项所属研究链。

    Returns:
        基础研究返回有效科研席位，其他研究链返回原有课题成员查询集。
    """
    if chain.workspace_id != workspace.id:
        return WorkspaceMember.objects.none()
    if is_basic_research_chain(getattr(chain.project, "research_profile", None)):
        return research_workspace_members(workspace)
    return assignable_project_members(workspace, chain)


def can_list_assignable_users(workspace, chain, actor):
    """判断调用方是否可读取该研究链的指派候选人。

    Args:
        workspace: 当前工作区。
        chain: 目标研究链。
        actor: 当前登录用户。

    Returns:
        基础研究链科研读者或原有课题写入者返回 True。
    """
    return (
        is_basic_research_chain(getattr(chain.project, "research_profile", None))
        and is_research_workspace_member(workspace, actor)
    ) or actor_can_manage_chain_tasks(workspace, chain, actor)


def _candidate_items(workspace, chain) -> list[dict]:
    """Build the complete assignable-user boundary for a chain.

    Args:
        workspace: Workspace that must own the chain.
        chain: Research chain whose organisation boundary is resolved.

    Returns:
        Serialized candidate users ordered by scope and research identity.
    """
    today = timezone.localdate()
    project_members = assignable_chain_members(workspace, chain)
    active_project_user_ids = set(project_members.values_list("member_id", flat=True))
    profile = getattr(chain.project, "research_profile", None)
    workspace_scope = is_basic_research_chain(profile)
    unit_ids = []
    if profile is not None and profile.org_unit_id:
        unit_ids.append(profile.org_unit_id)
        unit_ids.extend(org_unit_ancestry(profile.org_unit_id, workspace.id))

    memberships_by_user: dict[UUID, OrgUnitMember] = {}
    unit_ranks = {unit_id: index for index, unit_id in enumerate(unit_ids)}
    if unit_ids or workspace_scope:
        memberships = OrgUnitMember.objects.filter(
            active_membership_q(today),
            workspace_id=workspace.id,
            org_unit__deleted_at__isnull=True,
            user_id__in=active_project_user_ids,
            user__is_active=True,
        ).select_related("org_unit", "user")
        if workspace_scope:
            memberships = memberships.filter(org_unit__is_active=True)
        else:
            memberships = memberships.filter(org_unit_id__in=unit_ids)
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
            "scope": WORKSPACE_SCOPE if workspace_scope else ORG_SCOPE,
        }
        for membership in memberships_by_user.values()
    ]
    org_user_ids = set(memberships_by_user)

    collaborators = project_members.exclude(member_id__in=org_user_ids).select_related("member")
    data.extend(
        {
            "user_id": str(collaborator.member_id),
            "display_name": collaborator.member.display_name or collaborator.member.email,
            "org_unit_id": None,
            "org_unit_name": None,
            "org_role": None,
            "is_primary": False,
            "scope": WORKSPACE_SCOPE if workspace_scope else COLLABORATOR_SCOPE,
        }
        for collaborator in collaborators
    )

    scope_order = {WORKSPACE_SCOPE: 0, ORG_SCOPE: 1, COLLABORATOR_SCOPE: 2}
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
    if not can_list_assignable_users(workspace, chain, actor):
        raise ChainTaskPermissionError("The actor cannot manage chain tasks.")
    return _candidate_items(workspace, chain)


def chain_assignable_user_ids(workspace, chain) -> set[UUID]:
    """Return the server-side assignable-user ID set for one Chain.

    Args:
        workspace: Workspace that must own the chain.
        chain: Research chain whose assignable-user boundary is resolved.

    Returns:
        A set of user IDs that can currently own tasks in the chain.
    """
    return set(assignable_chain_members(workspace, chain).values_list("member_id", flat=True))


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

    return assignable_chain_members(workspace, chain).filter(member_id=parsed_user_id).exists()


def actor_can_assign_task(workspace, task, actor, *, assignee_is_valid=None):
    """判断原有写入者或基础研究链当前承办人是否可以改派。

    Args:
        workspace: 行动项所在工作区。
        task: 待改派行动项。
        actor: 当前登录用户。
        assignee_is_valid: 可选的已计算承办人有效性。

    Returns:
        行动项可写且调用方具有原有权限或当前有效承办人权限时返回 True。
    """
    if actor is None or not getattr(actor, "is_authenticated", False):
        return False
    if (
        task.chain.status != ResearchChain.Status.ACTIVE
        or task.node.status == ResearchChainNode.Status.ARCHIVED
        or task.status not in (ResearchChainNodeTask.Status.DRAFT, ResearchChainNodeTask.Status.ASSIGNED)
    ):
        return False
    if chain_writer(workspace, actor, task.chain):
        return True
    return is_basic_research_chain(getattr(task.chain.project, "research_profile", None)) and actor_can_complete_task(
        workspace, task, actor, assignee_is_valid=assignee_is_valid
    )


def actor_can_complete_task(workspace, task, actor, *, assignee_is_valid=None) -> bool:
    """Return whether the current assignee can mark an action-item task complete.

    Args:
        workspace: Workspace that must own the task.
        task: Research Chain node task to complete.
        actor: User requesting completion.
        assignee_is_valid: Read-project candidate validity when it is already known.

    Returns:
        True when the actor is the valid current assignee and completion is allowed.
    """
    if actor is None or not getattr(actor, "is_authenticated", False):
        return False
    if task.assignee_id != actor.id or task.status not in (
        ResearchChainNodeTask.Status.DRAFT,
        ResearchChainNodeTask.Status.ASSIGNED,
    ):
        return False
    if assignee_is_valid is None:
        assignee_is_valid = validate_assignable_user(workspace, task.chain, task.assignee_id)
    return assignee_is_valid


def actor_can_reopen_task(workspace, task, actor, *, assignee_is_valid=None) -> bool:
    """Return whether the current assignee can reopen a completed task.

    Args:
        workspace: Workspace that must own the task.
        task: Research Chain node task to reopen.
        actor: User requesting reopening.
        assignee_is_valid: Read-project candidate validity when it is already known.

    Returns:
        True when the actor is the valid current assignee of a completed task.
    """
    if actor is None or not getattr(actor, "is_authenticated", False):
        return False
    if task.assignee_id != actor.id or task.status != ResearchChainNodeTask.Status.COMPLETED:
        return False
    if assignee_is_valid is None:
        assignee_is_valid = validate_assignable_user(workspace, task.chain, task.assignee_id)
    return assignee_is_valid


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


def actor_can_delete_task(workspace, task, actor) -> bool:
    """Return whether an actor may soft-delete a task.

    Args:
        workspace: Workspace that owns the task.
        task: Research Chain node task to delete.
        actor: User requesting deletion.

    Returns:
        True when the actor created the task or manages its chain.
    """
    if actor is None or not getattr(actor, "is_authenticated", False):
        return False
    return task.created_by_id == actor.id or chain_manager(workspace, actor, task.chain)


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
        raise ChainTaskPermissionError("请先将负责人添加为有效课题成员。")
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
    # Keep the minimum project context with the immutable event so a later
    # soft/hard deletion of the task cannot erase the home-feed subject.
    metadata = dict(metadata or {})
    project = task.chain.project
    metadata.setdefault("project_id", str(project.id))
    metadata.setdefault("project_name", project.name)
    metadata.setdefault("project_identifier", project.identifier)
    metadata.setdefault("chain_id", str(task.chain_id))
    metadata.setdefault("node_id", str(task.node_id))
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
    rows = (
        ResearchChainNodeTask.objects.filter(workspace=workspace, chain=chain, node=node)
        .select_related(
            "workspace", "chain__project__research_profile__org_unit", "node", "assignee", "assigned_by", "completed_by"
        )
        .prefetch_related("instruction_attachments__asset")
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
                raise ChainTaskPermissionError("请先将负责人添加为有效课题成员。")
            _ensure_task_parent_writable(locked_chain, node)
            task = ResearchChainNodeTask.objects.create(
                workspace=workspace,
                chain=chain,
                node=node,
                title=title,
                instruction=_clean_instruction(payload.get("instruction")),
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
                metadata={
                    "status": task.status,
                    "entity_name": task.title,
                    "changes": _task_creation_changes(task),
                },
                content_hash=digest,
            )
            _write_task_audit(
                task=task,
                actor=actor,
                action=ResearchAuditAction.TASK_CREATE,
                metadata={
                    "node": str(node.id),
                    "status": task.status,
                    "entity_name": task.title,
                    "changes": _task_creation_changes(task),
                },
                request=request,
            )
            notify_task_updated(
                task, actor, ["instruction"], previous_instruction="", assignment_changed=assignee is not None
            )
        return task, True
    except IntegrityError:
        existing = _replay_task(workspace, chain, node, request_id, digest)
        if existing is not None:
            return existing, False
        raise ChainTaskConflictError("request_id was already used.") from None


def update_task(*, task, actor, payload, request=None, source="WEB"):
    """Update editable task fields without changing lifecycle state directly.

    Args:
        task: Research Chain node task to update.
        actor: User editing or assigning the task.
        payload: Validated partial payload.
        request: Optional HTTP request used for audit client metadata.
        source: 转派入口来源，原生网页使用 WEB，MCP 使用 MCP。

    Returns:
        The updated task.

    Raises:
        ChainTaskPermissionError: When the actor or new assignee is denied.
        ChainTaskValidationError: When an editable field is invalid.
        ChainTaskStateError: When the task or its parent is read-only.
    """
    if not actor_can_manage_chain_tasks(task.workspace, task.chain, actor):
        if set(payload) != {"assignee"} or not actor_can_assign_task(task.workspace, task, actor):
            raise ChainTaskPermissionError("Only chain writers can update tasks.")
        next_assignee = payload["assignee"]
        transferred, _changed = transfer_task_by_current_assignee(
            task=task,
            actor=actor,
            assignee_id=getattr(next_assignee, "id", next_assignee),
            request=request,
            source=source,
        )
        return transferred
    if task.status not in (
        ResearchChainNodeTask.Status.DRAFT,
        ResearchChainNodeTask.Status.ASSIGNED,
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
        next_instruction = _clean_instruction(payload["instruction"], task)
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
    try:
        with transaction.atomic():
            locked_chain = ResearchChain.objects.select_for_update().get(pk=task.chain_id)
            locked_node = ResearchChainNode.objects.select_for_update().get(pk=task.node_id)
            _ensure_task_parent_writable(locked_chain, locked_node)
            locked_task = (
                ResearchChainNodeTask.objects.select_for_update(of=("self",))
                .select_related("assignee")
                .get(pk=task.pk)
            )
            locked_task.chain = locked_chain
            locked_task.node = locked_node
            if not actor_can_manage_chain_tasks(locked_task.workspace, locked_chain, actor):
                raise ChainTaskPermissionError("Only chain writers can update tasks.")
            assignee_changed = "assignee" in payload and next_assignee.id != locked_task.assignee_id
            if "assignee" in payload and not validate_assignable_user(
                locked_task.workspace, locked_chain, next_assignee.id
            ):
                raise ChainTaskPermissionError("请先将负责人添加为有效课题成员。")
            if locked_task.status not in (
                ResearchChainNodeTask.Status.DRAFT,
                ResearchChainNodeTask.Status.ASSIGNED,
            ):
                raise ChainTaskStateError("Completed or cancelled tasks are read-only.")
            previous_values = {
                "title": locked_task.title,
                "instruction": locked_task.instruction,
                "due_at": locked_task.due_at,
                "resource_type": locked_task.resource_type,
                "resource_id": locked_task.resource_id,
                "status": locked_task.status,
            }
            previous_assignee_id = locked_task.assignee_id
            previous_assignee = locked_task.assignee
            next_title = next_title if "title" in payload else locked_task.title
            next_due_at = next_due_at if "due_at" in payload else locked_task.due_at
            if "resource_type" in payload or "resource_id" in payload:
                next_resource_type, next_resource_id = _resource_values(
                    {
                        "resource_type": payload.get("resource_type", locked_task.resource_type),
                        "resource_id": payload.get("resource_id", locked_task.resource_id),
                    }
                )
            else:
                next_resource_type, next_resource_id = locked_task.resource_type, locked_task.resource_id
            previous_instruction = locked_task.instruction
            if "instruction" not in payload:
                next_instruction = previous_instruction
            changed_fields = sorted(
                field
                for field, value in (
                    ("title", next_title),
                    ("instruction", next_instruction),
                    ("due_at", next_due_at),
                    ("resource_type", next_resource_type),
                    ("resource_id", next_resource_id),
                )
                if getattr(locked_task, field) != value
            )
            if assignee_changed:
                changed_fields.append("assignee")
                changed_fields.sort()
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
            if locked_task.status != previous_values["status"] and "status" not in changed_fields:
                changed_fields.append("status")
                changed_fields.sort()
            update_fields = {*changed_fields, "updated_by", "updated_at"}
            if assignee_changed:
                update_fields.update({"assigned_by"})
                if previous_assignee_id is None:
                    update_fields.update({"status"})
            locked_task.save(update_fields=list(update_fields))

            changes = _task_changes(
                previous_values | {"assignee": previous_assignee},
                {
                    "title": locked_task.title,
                    "instruction": locked_task.instruction,
                    "due_at": locked_task.due_at,
                    "resource_type": locked_task.resource_type,
                    "resource_id": locked_task.resource_id,
                    "assignee": locked_task.assignee,
                    "status": locked_task.status,
                },
            )

            if changes:
                _write_task_audit(
                    task=locked_task,
                    actor=actor,
                    action=ResearchAuditAction.TASK_UPDATE,
                    metadata={
                        "fields": changed_fields,
                        "changes": changes,
                        "entity_name": locked_task.title,
                    },
                    request=request,
                )
            if assignee_changed and any(change["field"] == "assignee" for change in changes):
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
                        "entity_name": locked_task.title,
                        "changes": [change for change in changes if change["field"] == "assignee"],
                    },
                    content_hash=payload_hash(
                        {"task_id": str(locked_task.id), "assignee": str(locked_task.assignee_id)}
                    ),
                )
            if changes:
                notify_task_updated(
                    locked_task,
                    actor,
                    changed_fields,
                    previous_instruction=previous_instruction,
                    assignment_changed=assignee_changed,
                )
            return locked_task
    except IntegrityError as error:
        raise ChainTaskConflictError("The task could not be updated consistently.") from error


def transfer_task_by_current_assignee(*, task, actor, assignee_id, request=None, source="EMAIL"):
    """Let the current assignee hand a task to another valid chain member.

    This path is intentionally narrower than ``update_task``: it accepts only the
    next owner, is authorized by the current assignee rather than a chain writer,
    and preserves the normal event, audit, and notification effects.

    Args:
        task: Research Chain node task selected by a signed email link.
        actor: Authenticated current assignee who confirmed the transfer.
        assignee_id: Server-validated next owner identifier.
        request: Confirmation API request used for audit metadata.
        source: 转派来源 WEB、MCP 或 EMAIL，既有邮件入口保持 EMAIL。

    Returns:
        A tuple of the locked task and whether this call changed its owner.
    """
    with transaction.atomic():
        locked_chain = ResearchChain.objects.select_for_update().get(pk=task.chain_id)
        locked_node = ResearchChainNode.objects.select_for_update().get(pk=task.node_id)
        _ensure_task_parent_writable(locked_chain, locked_node)
        locked_task = (
            ResearchChainNodeTask.objects.select_for_update(of=("self",))
            .select_related("assignee")
            .get(pk=task.pk)
        )
        locked_task.chain = locked_chain
        locked_task.node = locked_node
        if (
            actor is None
            or not getattr(actor, "is_authenticated", False)
            or locked_task.assignee_id != actor.id
            or locked_task.status not in (ResearchChainNodeTask.Status.DRAFT, ResearchChainNodeTask.Status.ASSIGNED)
        ):
            raise ChainTaskPermissionError("Only the current assignee can transfer this task.")
        basic_chain = is_basic_research_chain(getattr(locked_chain.project, "research_profile", None))
        if (source != "EMAIL" and not basic_chain) or (
            basic_chain and not validate_assignable_user(locked_task.workspace, locked_chain, actor.id)
        ):
            raise ChainTaskPermissionError("The current assignee cannot transfer this research task.")
        if not validate_assignable_user(locked_task.workspace, locked_chain, assignee_id):
            raise ChainTaskValidationError("The next assignee is outside the chain boundary.")

        next_assignee = User.objects.get(pk=assignee_id, is_active=True)
        if next_assignee.id == locked_task.assignee_id:
            return locked_task, False

        previous_assignee_id = locked_task.assignee_id
        previous_assignee = locked_task.assignee
        locked_task.assignee = next_assignee
        locked_task.assigned_by = actor
        locked_task.updated_by = actor
        locked_task.save(update_fields=["assignee", "assigned_by", "updated_by", "updated_at"])

        metadata = {
            "fields": ["assignee"],
            "previous_assignee": str(previous_assignee_id),
            "assignee": str(next_assignee.id),
            "email_assignment_transfer": source == "EMAIL",
            "assignment_transfer_source": source,
            "entity_name": locked_task.title,
            "changes": _task_changes(
                {"assignee": previous_assignee},
                {"assignee": next_assignee},
            ),
        }
        request_id = f"task-{source.lower()}-transfer-{locked_task.id}-{next_assignee.id}-{uuid4().hex[:12]}"
        content = {
            "task_id": str(locked_task.id),
            "previous_assignee": str(previous_assignee_id),
            "assignee": str(next_assignee.id),
        }
        _write_task_event(
            task=locked_task,
            actor=actor,
            request_id=request_id[:128],
            event_type="TASK_ASSIGNED",
            summary=f"Assigned task: {locked_task.title}",
            metadata=metadata,
            content_hash=payload_hash(content),
        )
        _write_task_audit(
            task=locked_task,
            actor=actor,
            action=ResearchAuditAction.TASK_UPDATE,
            metadata=metadata,
            request=request,
        )
        notify_task_assigned(locked_task, actor)
        return locked_task, True


def _run_task_action(*, task, actor, request_id, event_type, content_hash, action, request, metadata, guard):
    """Lock, replay, transition, and record one task state action."""
    with transaction.atomic():
        locked_chain = ResearchChain.objects.select_for_update().get(pk=task.chain_id)
        locked_node = ResearchChainNode.objects.select_for_update().get(pk=task.node_id)
        _ensure_task_parent_writable(locked_chain, locked_node)
        locked_task = (
            ResearchChainNodeTask.objects.select_for_update(of=("self",))
            .select_related("assignee")
            .get(pk=task.pk)
        )
        guard(locked_task)
        existing_event = _replay_task_event(locked_task, request_id, event_type, content_hash)
        if existing_event is not None:
            return locked_task, False
        previous_status = locked_task.status
        action(locked_task)
        action_metadata = dict(metadata)
        for summary_field in ("comment", "reason"):
            if summary_field in action_metadata:
                action_metadata[summary_field] = _task_plain_text(action_metadata[summary_field])
        action_metadata["entity_name"] = locked_task.title
        action_metadata["changes"] = _task_changes(
            {"status": previous_status},
            {"status": locked_task.status},
        )
        _write_task_event(
            task=locked_task,
            actor=actor,
            request_id=request_id,
            event_type=event_type,
            summary=f"{event_type}: {locked_task.title}",
            metadata=action_metadata | {"status": locked_task.status},
            content_hash=content_hash,
        )
        _write_task_audit(
            task=locked_task,
            actor=actor,
            action={
                "TASK_COMPLETED": ResearchAuditAction.TASK_COMPLETE,
                "TASK_REOPENED": ResearchAuditAction.TASK_REOPEN,
                "TASK_CANCELLED": ResearchAuditAction.TASK_CANCEL,
            }[event_type],
            metadata=action_metadata | {"status": locked_task.status},
            request=request,
        )
        if event_type == "TASK_COMPLETED":
            notify_task_completed(locked_task, actor, metadata.get("comment", ""))
        elif event_type == "TASK_REOPENED":
            notify_task_reopened(locked_task, actor, metadata.get("reason", ""))
        elif event_type == "TASK_CANCELLED":
            notify_task_cancelled(locked_task, actor, metadata.get("reason", ""))
        return locked_task, True


def complete_task(*, task, actor, comment="", request_id=None, content_hash="", request=None):
    """Mark an action-item task complete as its current assignee.

    Args:
        task: Research Chain node task to complete.
        actor: Current assignee marking the task complete.
        comment: Optional completion note retained in the timeline.
        request_id: Idempotency key supplied by the caller.
        content_hash: Stable payload hash used for replay.
        request: Optional HTTP request used for audit metadata.

    Returns:
        A ``(task, changed)`` tuple.
    """
    request_id = _request_id({"request_id": request_id})
    if not actor_can_complete_task(task.workspace, task, actor):
        raise ChainTaskPermissionError("Only the current assignee can complete this task.")

    def action(locked_task):
        if locked_task.status not in (
            ResearchChainNodeTask.Status.DRAFT,
            ResearchChainNodeTask.Status.ASSIGNED,
        ):
            raise ChainTaskStateError(f"COMPLETE is not allowed from {locked_task.status}.")
        locked_task.status = ResearchChainNodeTask.Status.COMPLETED
        locked_task.completed_at = timezone.now()
        locked_task.completed_by = actor
        locked_task.updated_by = actor
        locked_task.save(
            update_fields=[
                "status",
                "completed_at",
                "completed_by",
                "updated_by",
                "updated_at",
            ]
        )
        return None

    return _run_task_action(
        task=task,
        actor=actor,
        request_id=request_id,
        event_type="TASK_COMPLETED",
        content_hash=content_hash,
        action=action,
        request=request,
        metadata={"comment": _task_plain_text(comment)},
        guard=lambda locked_task: _require_complete_permission(locked_task, actor),
    )


def reopen_task(*, task, actor, reason="", request_id=None, content_hash="", request=None):
    """Reopen a completed action-item task as its current assignee.

    Args:
        task: Research Chain node task to reopen.
        actor: Current assignee reopening the task.
        reason: Optional reopening note retained in the timeline.
        request_id: Idempotency key supplied by the caller.
        content_hash: Stable payload hash used for replay.
        request: Optional HTTP request used for audit metadata.

    Returns:
        A ``(task, changed)`` tuple.
    """
    request_id = _request_id({"request_id": request_id})
    if not actor_can_reopen_task(task.workspace, task, actor):
        raise ChainTaskPermissionError("Only the current assignee can reopen this task.")

    def action(locked_task):
        if locked_task.status != ResearchChainNodeTask.Status.COMPLETED:
            raise ChainTaskStateError(f"REOPEN is not allowed from {locked_task.status}.")
        locked_task.status = ResearchChainNodeTask.Status.ASSIGNED
        locked_task.completed_at = None
        locked_task.completed_by = None
        locked_task.updated_by = actor
        locked_task.save(
            update_fields=[
                "status",
                "completed_at",
                "completed_by",
                "updated_by",
                "updated_at",
            ]
        )
        return None

    return _run_task_action(
        task=task,
        actor=actor,
        request_id=request_id,
        event_type="TASK_REOPENED",
        content_hash=content_hash,
        action=action,
        request=request,
        metadata={"reason": _task_plain_text(reason)},
        guard=lambda locked_task: _require_reopen_permission(locked_task, actor),
    )


def _require_complete_permission(task, actor):
    """Recheck completion authority after the task row has been locked."""
    if not actor_can_complete_task(task.workspace, task, actor):
        raise ChainTaskPermissionError("Only the current assignee can complete this task.")


def _require_reopen_permission(task, actor):
    """Recheck reopening authority after the task row has been locked."""
    if not actor_can_reopen_task(task.workspace, task, actor):
        raise ChainTaskPermissionError("Only the current assignee can reopen this task.")


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
            ResearchChainNodeTask.Status.COMPLETED,
        ):
            raise ChainTaskStateError(f"CANCEL is not allowed from {locked_task.status}.")
        locked_task.status = ResearchChainNodeTask.Status.CANCELLED
        locked_task.completed_at = None
        locked_task.completed_by = None
        locked_task.updated_by = actor
        locked_task.save(update_fields=["status", "completed_at", "completed_by", "updated_by", "updated_at"])
        return None

    return _run_task_action(
        task=task,
        actor=actor,
        request_id=request_id,
        event_type="TASK_CANCELLED",
        content_hash=content_hash,
        action=action,
        request=request,
        metadata={"reason": _task_plain_text(reason)},
        guard=lambda locked_task: _require_cancel_permission(locked_task, actor),
    )


def _require_cancel_permission(task, actor):
    """Recheck management authority while the task row is locked."""
    if not chain_manager(task.workspace, actor, task.chain):
        raise ChainTaskPermissionError("Only chain managers can cancel tasks.")


def delete_task(*, task, actor, request=None):
    """Soft-delete one action-item task while preserving its audit trail.

    Args:
        task: Research Chain node task to delete.
        actor: Task creator or chain manager requesting deletion.
        request: Optional HTTP request used for audit client metadata.

    Returns:
        The soft-deleted task instance.

    Raises:
        ChainTaskPermissionError: When the actor did not create or manage the task.
        ChainTaskStateError: When the parent chain or node is read-only.
    """
    if not actor_can_delete_task(task.workspace, task, actor):
        raise ChainTaskPermissionError("Only the task creator or chain managers can delete this task.")

    request_id = f"task-delete-{task.id}-{uuid4().hex[:12]}"[:128]
    metadata = {
        "title": task.title[:500],
        "status": task.status,
        "resource_type": task.resource_type,
        "resource_id": str(task.resource_id) if task.resource_id else None,
        "entity_name": task.title,
        "changes": [{"field": "status", "old_value": task.status, "new_value": "DELETED"}],
    }
    content_hash = payload_hash({"task_id": str(task.id), **metadata})

    with transaction.atomic():
        locked_chain = ResearchChain.objects.select_for_update().get(pk=task.chain_id)
        locked_node = ResearchChainNode.objects.select_for_update().get(pk=task.node_id)
        _ensure_task_parent_writable(locked_chain, locked_node)
        locked_task = ResearchChainNodeTask.objects.select_for_update().get(pk=task.pk)
        if not actor_can_delete_task(locked_task.workspace, locked_task, actor):
            raise ChainTaskPermissionError("Only the task creator or chain managers can delete this task.")

        _write_task_event(
            task=locked_task,
            actor=actor,
            request_id=request_id,
            event_type="TASK_DELETED",
            summary=f"Deleted task: {locked_task.title}",
            metadata=metadata,
            content_hash=content_hash,
        )
        _write_task_audit(
            task=locked_task,
            actor=actor,
            action=ResearchAuditAction.TASK_DELETE,
            metadata=metadata,
            request=request,
        )
        notify_task_deleted(locked_task, actor)
        locked_task.deleted_at = timezone.now()
        locked_task.updated_by = actor
        locked_task.save(update_fields=["deleted_at", "updated_by", "updated_at"])
        return locked_task
