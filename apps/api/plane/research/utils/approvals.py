# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Approval step resolution and Issue state progression."""

from django.utils import timezone

from plane.db.models import (
    ApprovalAction,
    ApprovalFlowStep,
    Issue,
    OrgUnitMember,
    State,
    User,
)
from plane.research.utils.acl import org_unit_scope_ids
from plane.research.utils.org import active_membership_q

MANAGING_ROLES = ("OWNER", "PI", "UNIT_ADMIN", "ADVISOR", "REVIEWER")


def flow_steps(flow):
    return list(
        ApprovalFlowStep.objects.filter(flow=flow, is_required=True).order_by("order")
    )


def step_approver_ids(request, step, cache=None):
    """解析步骤审批人，可在一次只读聚合中复用组织角色查询。

    Args:
        request: 当前审批请求。
        step: 当前审批步骤。
        cache: 可选的请求级缓存字典。

    Returns:
        明确指定或由组织角色解析得到的审批人 ID 集合。
    """
    if step.approver_user_id:
        return {step.approver_user_id}
    if not step.approver_org_role:
        return set()

    today = timezone.localdate()
    key = (request.org_unit_id, request.flow.workspace_id, step.approver_org_role, today)
    if cache is not None and key in cache:
        return set(cache[key])

    scope_key = ("org_unit_scope", request.org_unit_id, request.flow.workspace_id)
    if cache is not None and scope_key in cache:
        scope = cache[scope_key]
    else:
        scope = org_unit_scope_ids(request.org_unit_id, request.flow.workspace_id)
        if cache is not None:
            cache[scope_key] = scope
    if not scope:
        if cache is not None:
            cache[key] = set()
        return set()
    memberships = OrgUnitMember.objects.filter(
        active_membership_q(today),
        workspace_id=request.flow.workspace_id,
        org_unit_id__in=scope,
        org_role=step.approver_org_role,
    )
    approver_ids = set(memberships.values_list("user_id", flat=True))
    if cache is not None:
        cache[key] = approver_ids
    return approver_ids


def current_step(request):
    for step in flow_steps(request.flow):
        if step.order == request.current_step_order:
            return step
    return None


def can_act_on_current_step(request, actor):
    step = current_step(request)
    if step is None:
        return False, None
    return actor.id in step_approver_ids(request, step), step


def step_is_satisfied(request, step):
    """``ANY`` needs one approval, ``ALL`` needs every resolved approver."""
    approved = set(
        ApprovalAction.objects.filter(
            request=request,
            step=step,
            action=ApprovalAction.Action.APPROVE,
        ).values_list("actor_id", flat=True)
    )
    required = step_approver_ids(request, step)
    if not required:
        # nobody resolvable (e.g. the role is empty): the step does not block
        return bool(approved)
    if step.approver_mode == ApprovalFlowStep.ApproverMode.ALL:
        return required.issubset(approved)
    return bool(approved & required)


def next_step_order(request):
    for step in flow_steps(request.flow):
        if step.order > request.current_step_order:
            return step.order
    return None


def move_issue_state(request, *, approved):
    """Advance the linked Issue without touching its history (P0-APR-01)."""
    issue = Issue.objects.filter(pk=request.issue_id).first()
    if issue is None:
        return None
    target_group = "completed" if approved else "backlog"
    state = (
        State.objects.filter(project_id=issue.project_id, group=target_group, deleted_at__isnull=True)
        .order_by("sequence")
        .first()
    )
    if state is None:
        return None
    issue.state = state
    issue.save(update_fields=["state", "updated_at"])
    return state


def pending_approver_users(request):
    step = current_step(request)
    if step is None:
        return []
    return list(User.objects.filter(id__in=step_approver_ids(request, step), is_active=True))
