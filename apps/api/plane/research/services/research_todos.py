# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Read-only aggregation of existing research todo sources.

The service deliberately owns no database table and performs no writes.  Each
collector first applies the domain visibility rules and only then projects the
common ``research-todo.v2`` envelope.
"""

import logging
from collections import defaultdict
from datetime import date, datetime, time, timedelta
from time import perf_counter

from django.db.models import OuterRef, Prefetch, Q, Subquery
from django.db.models import TextChoices
from django.utils import timezone

from plane.db.models import (
    ApprovalFlowStep,
    ApprovalRequest,
    PeriodicReport,
    PeriodicReportReadReceipt,
    PeriodicReportSnapshot,
    ReportAccessGrant,
    ResearchAgentRunEvent,
    ResearchAgentSession,
    ResearchChainStage,
    ResearchChainNodeTask,
    ResearchPaperReview,
    ResearchStageInstance,
    StageReviewerAssignment,
    StageReview,
    User,
)
from plane.research.services.chain_tasks import (
    actor_can_assign_task,
    actor_can_cancel_task,
    actor_can_complete_task,
    actor_can_delete_task,
    actor_can_reopen_task,
    chain_writer,
    chain_assignable_user_ids,
)
from plane.research.services.approval_routes import active_approval_route_map
from plane.research.services.chain_stage_approvals import (
    ChainStageRuleError,
    resolve_advisor,
    resolve_principal,
)
from plane.research.services.paper_review import (
    actor_can_review_paper,
    actor_can_submit_paper,
    actor_can_withdraw_paper,
)
from plane.research.utils.action_capabilities import capability_map
from plane.research.utils.acl import build_actor_context, check_access
from plane.research.utils.approvals import step_approver_ids
from plane.research.utils.reports import report_resource, visible_reports_queryset
from plane.research.utils.chain_stage_notifications import STAGE_TITLES
from plane.research.utils.settings import (
    get_workspace_research_settings,
    workspace_research_enabled,
    workspace_research_sections,
)
from plane.research.utils.todo_context import todo_query_context
from plane.research.utils.stages import stage_resource
from plane.research.views.projects import can_read_project_research_metadata
from plane.utils.todo_metrics import count_todo_queries

logger = logging.getLogger("plane.api")

TODO_SCHEMA_VERSION = "research-todo.v2"
TODO_SCOPES = frozenset(("to_me", "mine", "visible"))


class ResearchTodoUrgency(TextChoices):
    """Server-derived due-date urgency for one unified todo."""

    OVERDUE = "OVERDUE", "Overdue"
    DUE_TODAY = "DUE_TODAY", "Due today"
    DUE_SOON = "DUE_SOON", "Due soon"
    NORMAL = "NORMAL", "Normal"


URGENCY_RANK = {
    ResearchTodoUrgency.OVERDUE: 0,
    ResearchTodoUrgency.DUE_TODAY: 1,
    ResearchTodoUrgency.DUE_SOON: 2,
    ResearchTodoUrgency.NORMAL: 3,
}


def _participant(user):
    """Project one user without exposing account contact fields."""
    if user is None:
        return None
    return {"id": str(user.id), "display_name": user.display_name or user.username or str(user.id)}


def _participants(users):
    """Project an ordered user collection without duplicate participants."""
    result = []
    seen = set()
    for user in users:
        if user is None or user.id in seen:
            continue
        seen.add(user.id)
        result.append(_participant(user))
    return result


def _iso(value):
    """Return a stable API timestamp or date."""
    return value.isoformat() if value is not None else None


def research_todo_urgency(due_at, now=None):
    """Derive textual urgency from a domain due date.

    Args:
        due_at: Original domain due date, optionally ``None``.
        now: Current timezone-aware timestamp; defaults to the request time.

    Returns:
        One of ``OVERDUE``, ``DUE_TODAY``, ``DUE_SOON`` or ``NORMAL``.
    """
    if due_at is None:
        return ResearchTodoUrgency.NORMAL
    current = now or timezone.now()
    if isinstance(due_at, date) and not isinstance(due_at, datetime):
        due_at = datetime.combine(due_at, time.max, tzinfo=timezone.get_current_timezone())
    if timezone.is_naive(due_at):
        due_at = timezone.make_aware(due_at, timezone.get_current_timezone())
    if due_at < current:
        return ResearchTodoUrgency.OVERDUE
    if due_at.date() == current.date():
        return ResearchTodoUrgency.DUE_TODAY
    if due_at <= current + timedelta(hours=72):
        return ResearchTodoUrgency.DUE_SOON
    return ResearchTodoUrgency.NORMAL


def _todo(
    *,
    source,
    object_id,
    title,
    context,
    requester,
    assignees,
    business_status,
    handling_status,
    next_action,
    due_at,
    href,
    capabilities,
    trace_ref,
    updated_at,
    project_id=None,
):
    """Build one versioned todo envelope.

    Args:
        source: Canonical source system identifier.
        object_id: Identifier of the original business object.
        title: Short title visible through the object ACL.
        context: Project/node/period context without copying object content.
        requester: User who created or submitted the business object.
        assignees: Current handler projection for display.
        business_status: Unmodified domain status.
        handling_status: Display-only unified status.
        next_action: Next canonical action in the domain flow.
        due_at: Optional domain due date or timestamp.
        href: Frontend deep link to the domain context.
        capabilities: Server-computed action capability map.
        trace_ref: Stable audit/trace reference.
        updated_at: Domain update timestamp.

    Returns:
        A JSON-serialisable ``research-todo.v2`` record.
    """
    urgency = research_todo_urgency(due_at)
    return {
        "schema_version": TODO_SCHEMA_VERSION,
        "id": f"{source}:{object_id}",
        "source": source,
        "object_id": str(object_id),
        "project_id": str(project_id) if project_id else None,
        "title": title,
        "context": context,
        "requester": requester,
        "assignees": assignees,
        "business_status": business_status,
        "handling_status": handling_status,
        "next_action": next_action,
        "due_at": _iso(due_at),
        "urgency": urgency,
        "href": href,
        "capabilities": capabilities,
        "trace_ref": trace_ref,
        "updated_at": _iso(updated_at),
    }


def _chain_feature_enabled(workspace):
    """沿用科研模块原有的全局和工作区开关。"""
    return workspace_research_enabled(workspace)


def _chain_task_initiator(task):
    """Resolve the actual task initiator with historical-data fallbacks."""
    return task.created_by or task.assigned_by or task.chain.owner


def collect_chain_task_todos(workspace, user, scope):
    """Project tasks attached to visible Research Chain nodes.

    Args:
        workspace: Workspace whose tasks are projected.
        user: Current authenticated caller.
        scope: One of ``to_me``, ``mine`` or ``visible``.

    Returns:
        A list of deduplicated ``CHAIN_TASK`` todo envelopes.
    """
    if not _chain_feature_enabled(workspace):
        return []
    statuses = (
        ResearchChainNodeTask.Status.DRAFT,
        ResearchChainNodeTask.Status.ASSIGNED,
        ResearchChainNodeTask.Status.COMPLETED,
    )
    tasks = (
        ResearchChainNodeTask.objects.filter(
            workspace=workspace,
            status__in=statuses,
            deleted_at__isnull=True,
            chain__status="ACTIVE",
            chain__project__research_profile__workflow_status="ACTIVE",
        )
        .exclude(node__status="ARCHIVED")
        .select_related(
            "chain__project__research_profile",
            "chain__project",
            "chain__owner",
            "node",
            "created_by",
            "assignee",
            "assigned_by",
        )
        .only(
            "status",
            "title",
            "due_at",
            "updated_at",
            "metadata",
            "request_id",
            "created_by__display_name",
            "created_by__username",
            "assignee__display_name",
            "assignee__username",
            "assigned_by__display_name",
            "assigned_by__username",
            "node__title",
            "node__status",
            "chain__workspace_id",
            "chain__visibility",
            "chain__status",
            "chain__project__name",
            "chain__project__research_profile",
            "chain__owner__display_name",
            "chain__owner__username",
        )
        .order_by("-updated_at", "-created_at")
    )
    result = []
    assignable_ids_by_chain = {}
    for task in tasks:
        profile = getattr(task.chain.project, "research_profile", None)
        if profile is None or not can_read_project_research_metadata(workspace, user, profile):
            continue
        initiator = _chain_task_initiator(task)
        if scope == "mine" and initiator.id != user.id:
            continue
        if task.chain_id not in assignable_ids_by_chain:
            assignable_ids_by_chain[task.chain_id] = chain_assignable_user_ids(workspace, task.chain)
        assignee_is_valid = task.assignee_id is not None and task.assignee_id in assignable_ids_by_chain[task.chain_id]
        can_complete = actor_can_complete_task(workspace, task, user, assignee_is_valid=assignee_is_valid)
        can_reopen = actor_can_reopen_task(workspace, task, user, assignee_is_valid=assignee_is_valid)
        can_cancel = actor_can_cancel_task(workspace, task, user)
        can_delete = actor_can_delete_task(workspace, task, user)
        editable = task.status in (
            ResearchChainNodeTask.Status.DRAFT,
            ResearchChainNodeTask.Status.ASSIGNED,
        )
        can_edit = editable and chain_writer(workspace, user, task.chain)
        decisions = {
            "view": True,
            "edit": can_edit,
            "assign": actor_can_assign_task(workspace, task, user, assignee_is_valid=assignee_is_valid),
            "complete": can_complete,
            "reopen": can_reopen,
            "cancel": can_cancel and task.status != ResearchChainNodeTask.Status.CANCELLED,
            "delete": can_delete,
        }
        if can_complete:
            next_action = "COMPLETE"
        elif can_reopen:
            next_action = "REOPEN"
        else:
            next_action = "ASSIGN"
        handling = {
            ResearchChainNodeTask.Status.DRAFT: "TODO",
            ResearchChainNodeTask.Status.ASSIGNED: "TODO",
            ResearchChainNodeTask.Status.COMPLETED: "DONE",
        }[task.status]
        assignees = [task.assignee] if task.assignee is not None and assignee_is_valid else []
        todo = _todo(
            source="CHAIN_TASK",
            project_id=task.chain.project_id,
            object_id=task.id,
            title=task.title,
            context=f"{task.chain.project.name} · {task.node.title}",
            requester=_participant(initiator),
            assignees=_participants(assignees),
            business_status=task.status,
            handling_status="BLOCKED" if editable and not assignees else handling,
            next_action=next_action,
            due_at=task.due_at,
            href=f"/{workspace.slug}/research/chains/{task.chain_id}?node={task.node_id}&task={task.id}",
            capabilities=capability_map(
                ("view", "edit", "assign", "complete", "reopen", "cancel", "delete"),
                decisions,
            ),
            trace_ref={
                "resource_type": "research_chain_node_task",
                "resource_id": str(task.id),
                "event_id": task.request_id,
                "trace_id": task.metadata.get("trace_id") if isinstance(task.metadata, dict) else None,
            },
            updated_at=task.updated_at,
        )
        actionable_to_me = can_complete or can_reopen
        editable_to_me = editable and (
            (assignee_is_valid and task.assignee_id == user.id) or (not assignee_is_valid and initiator.id == user.id)
        )
        if scope != "to_me" or actionable_to_me or editable_to_me:
            result.append(todo)
    return result


def _report_assignees(report, route=None):
    """根据批量加载的有效路由解析报告当前承办人。

    Args:
        report: 当前报告。
        route: 报告当前的有效审批路由。

    Returns:
        当前审批人或报告所有者组成的列表。
    """
    if report.status != PeriodicReport.Status.SUBMITTED:
        return [report.owner]
    return [route.reviewer] if route is not None else [report.owner]


def collect_report_todos(workspace, user, scope):
    """Project periodic report read and review work without duplicating a report."""
    if not workspace_research_sections(workspace).get("reports"):
        return []
    context = build_actor_context(user, workspace.id)
    confidential_cache = {}
    latest_snapshot_version = (
        PeriodicReportSnapshot.objects.filter(report_id=OuterRef("pk")).order_by("-version_no").values("version_no")[:1]
    )
    statuses = (
        PeriodicReport.Status.DRAFT,
        PeriodicReport.Status.SUBMITTED,
        PeriodicReport.Status.NEEDS_REVISION,
    )
    queryset = (
        PeriodicReport.objects.filter(workspace=workspace, status__in=statuses, deleted_at__isnull=True)
        .select_related("owner", "org_unit", "page", "project")
        .only(
            "workspace_id",
            "status",
            "visibility",
            "submitted_at",
            "report_type",
            "period_key",
            "period_end",
            "updated_at",
            "created_at",
            "owner__display_name",
            "owner__username",
            "org_unit__workspace_id",
            "org_unit__path",
            "page__name",
            "project__name",
        )
        .annotate(_todo_snapshot_version=Subquery(latest_snapshot_version))
        .prefetch_related(
            Prefetch(
                "access_grants",
                queryset=ReportAccessGrant.objects.only(
                    "report_id", "grantee_user_id", "grantee_org_unit_id", "is_revoked", "expires_at"
                ),
            ),
            Prefetch(
                "read_receipts",
                queryset=PeriodicReportReadReceipt.objects.filter(reader=user).only("report_id", "snapshot_version"),
            ),
        )
        .order_by("-updated_at", "-created_at")
    )
    if scope == "mine":
        queryset = queryset.filter(owner=user)
    else:
        queryset = visible_reports_queryset(queryset, context, confidential_cache=confidential_cache)
    reports = list(queryset)
    routes_by_report = active_approval_route_map(
        "PERIODIC_REPORT",
        [report.id for report in reports if report.status == PeriodicReport.Status.SUBMITTED],
        workspace.id,
    )
    is_workspace_admin = context.is_workspace_admin
    result = []
    for report in reports:
        route = routes_by_report.get(report.id)
        report_handlers = _report_assignees(report, route)
        is_formal_reviewer = any(handler.id == user.id for handler in report_handlers)
        snapshot_version = report._todo_snapshot_version
        receipt_versions = {receipt.snapshot_version for receipt in report.read_receipts.all()}
        read_allowed = (
            report.status == PeriodicReport.Status.SUBMITTED
            and is_formal_reviewer
            and snapshot_version is not None
            and snapshot_version not in receipt_versions
        )
        editable = report.status in (PeriodicReport.Status.DRAFT, PeriodicReport.Status.NEEDS_REVISION)
        can_edit = editable and check_access(user, "edit", report_resource(report, confidential_cache), context=context)
        can_review = report.status == PeriodicReport.Status.SUBMITTED and (
            is_workspace_admin or (route is not None and route.reviewer_id == user.id)
        )
        can_return = can_review
        can_accept = can_review
        decisions = {
            "view": True,
            "read": read_allowed,
            "edit": can_edit,
            "submit": can_edit,
            "review": can_return or can_accept,
            "return": can_return,
            "accept": can_accept,
        }
        if report.status == PeriodicReport.Status.NEEDS_REVISION:
            handling, business_next = "RETURNED", "SUBMIT"
        elif report.status == PeriodicReport.Status.SUBMITTED:
            handling, business_next = "IN_PROGRESS", "REVIEW"
        else:
            handling, business_next = "TODO", "SUBMIT"
        if can_edit:
            next_action = "SUBMIT"
        elif read_allowed:
            next_action = "READ"
        elif decisions["review"]:
            next_action = "REVIEW"
        elif can_return:
            next_action = "RETURN"
        elif can_accept:
            next_action = "ACCEPT"
        else:
            next_action = business_next
        title = report.page.name if report.page_id else f"{report.report_type} report {report.period_key}"
        project_name = report.project.name if report.project_id else workspace.name
        todo = _todo(
            source="REPORT",
            project_id=report.project_id,
            object_id=report.id,
            title=title,
            context=f"{project_name} · {report.period_key}",
            requester=_participant(report.owner),
            assignees=_participants(report_handlers),
            business_status=report.status,
            handling_status=handling,
            next_action=next_action,
            due_at=report.period_end,
            href=f"/{workspace.slug}/research/reports/{report.id}",
            capabilities=capability_map(("view", "read", "edit", "submit", "review", "return", "accept"), decisions),
            trace_ref={"resource_type": "report", "resource_id": str(report.id)},
            updated_at=report.updated_at,
        )
        owner_pending = (
            report.status
            in (
                PeriodicReport.Status.DRAFT,
                PeriodicReport.Status.NEEDS_REVISION,
            )
            and report.owner_id == user.id
        )
        reviewer_pending = report.status == PeriodicReport.Status.SUBMITTED and is_formal_reviewer
        if scope != "to_me" or owner_pending or reviewer_pending:
            result.append(todo)
    return result


def collect_paper_review_todos(workspace, user, scope):
    """Project paper review loops through the existing Chain ACL."""
    if not _chain_feature_enabled(workspace):
        return []
    statuses = (
        ResearchPaperReview.Status.OPEN,
        ResearchPaperReview.Status.WAITING_REVIEW,
        ResearchPaperReview.Status.NEEDS_REVISION,
    )
    reviews = (
        ResearchPaperReview.objects.filter(workspace=workspace, status__in=statuses, deleted_at__isnull=True)
        .select_related(
            "chain__project__research_profile__org_unit",
            "chain__project",
            "node",
            "owner",
            "final_reviewer",
        )
        .only(
            "workspace_id",
            "status",
            "due_at",
            "updated_at",
            "request_id",
            "node__title",
            "owner__display_name",
            "owner__username",
            "final_reviewer__display_name",
            "final_reviewer__username",
            "chain__owner_id",
            "chain__workspace_id",
            "chain__visibility",
            "chain__status",
            "chain__project__name",
            "chain__project__research_profile",
        )
        .order_by("-updated_at", "-created_at")
    )
    result = []
    for review in reviews:
        profile = getattr(review.chain.project, "research_profile", None)
        if profile is None or not can_read_project_research_metadata(workspace, user, profile):
            continue
        if scope == "mine" and review.owner_id != user.id:
            continue
        can_submit = actor_can_submit_paper(workspace, review, user)
        can_review = actor_can_review_paper(workspace, review, user)
        can_withdraw = actor_can_withdraw_paper(workspace, review, user)
        open_for_submit = review.status in (
            ResearchPaperReview.Status.OPEN,
            ResearchPaperReview.Status.NEEDS_REVISION,
        )
        decisions = {
            "view": True,
            "submit": open_for_submit and can_submit,
            "review": can_review and review.status == ResearchPaperReview.Status.WAITING_REVIEW,
            "return": can_review and review.status == ResearchPaperReview.Status.WAITING_REVIEW,
            "accept": can_review and review.status == ResearchPaperReview.Status.WAITING_REVIEW,
            "withdraw": can_withdraw
            and review.status not in (ResearchPaperReview.Status.ACCEPTED, ResearchPaperReview.Status.WITHDRAWN),
        }
        if decisions["submit"]:
            next_action = "SUBMIT"
        elif decisions["return"]:
            next_action = "RETURN"
        elif decisions["accept"]:
            next_action = "ACCEPT"
        elif decisions["withdraw"]:
            next_action = "WITHDRAW"
        elif review.status == ResearchPaperReview.Status.WAITING_REVIEW:
            next_action = "REVIEW"
        else:
            next_action = "SUBMIT"
        handling = {
            ResearchPaperReview.Status.OPEN: "TODO",
            ResearchPaperReview.Status.WAITING_REVIEW: "IN_PROGRESS",
            ResearchPaperReview.Status.NEEDS_REVISION: "RETURNED",
        }[review.status]
        handler = review.final_reviewer if review.status == ResearchPaperReview.Status.WAITING_REVIEW else review.owner
        todo = _todo(
            source="PAPER_REVIEW",
            project_id=review.chain.project_id,
            object_id=review.id,
            title=f"论文评审 · {review.node.title}",
            context=review.chain.project.name,
            requester=_participant(review.owner),
            assignees=_participants([handler]),
            business_status=review.status,
            handling_status=handling,
            next_action=next_action,
            due_at=review.due_at,
            href=f"/{workspace.slug}/research/chains/{review.chain_id}?node={review.node_id}&paper_review={review.id}",
            capabilities=capability_map(("view", "submit", "review", "return", "accept", "withdraw"), decisions),
            trace_ref={
                "resource_type": "research_paper_review",
                "resource_id": str(review.id),
                "event_id": review.request_id,
            },
            updated_at=review.updated_at,
        )
        owner_pending = open_for_submit and review.owner_id == user.id
        reviewer_pending = review.status == ResearchPaperReview.Status.WAITING_REVIEW and can_review
        if scope != "to_me" or owner_pending or reviewer_pending:
            result.append(todo)
    return result


def collect_stage_review_todos(workspace, user, scope):
    """Aggregate stage reviewer assignments into one todo per submitted stage."""
    if not workspace_research_sections(workspace).get("stages"):
        return []
    stages = (
        ResearchStageInstance.objects.filter(
            workspace=workspace,
            status=ResearchStageInstance.Status.SUBMITTED,
            deleted_at__isnull=True,
        )
        .select_related("project", "project__created_by", "project__research_profile__owner")
        .only(
            "workspace_id",
            "status",
            "stage",
            "org_unit_id",
            "updated_at",
            "project__name",
            "project__created_by__display_name",
            "project__created_by__username",
            "project__research_profile__owner__display_name",
            "project__research_profile__owner__username",
            "project__research_profile__research_type",
            "project__research_profile__workspace_id",
            "project__research_profile__deleted_at",
        )
        .order_by("-updated_at", "-created_at")
    )
    stages = list(stages)
    stage_ids = [stage.id for stage in stages]
    if not stage_ids:
        return []

    now = timezone.now()
    assignments_by_stage = defaultdict(list)
    assignments = (
        StageReviewerAssignment.objects.filter(
            stage_instance_id__in=stage_ids,
            is_active=True,
            superseded_at__isnull=True,
            deleted_at__isnull=True,
        )
        .filter(Q(valid_until__isnull=True) | Q(valid_until__gt=now))
        .select_related("reviewer")
        .only("stage_instance_id", "valid_until", "reviewer__display_name", "reviewer__username")
    )
    for assignment in assignments:
        assignments_by_stage[assignment.stage_instance_id].append(assignment)

    reviewed_by_stage = defaultdict(set)
    reviews = StageReview.objects.filter(
        stage_instance_id__in=stage_ids,
        is_superseded=False,
        deleted_at__isnull=True,
    ).values_list("stage_instance_id", "reviewer_id")
    for stage_id, reviewer_id in reviews:
        reviewed_by_stage[stage_id].add(reviewer_id)

    actor_context = build_actor_context(user, workspace.id)
    settings = get_workspace_research_settings(workspace)
    stage_visibility = settings.get("default_report_visibility") or "DIRECT_ADVISOR"
    result = []
    for stage in stages:
        profile = getattr(stage.project, "research_profile", None)
        owner_id = profile.owner_id if profile and profile.deleted_at is None else None
        current_assignments = assignments_by_stage.get(stage.id, [])
        reviewed_ids = reviewed_by_stage.get(stage.id, set())
        resource = stage_resource(
            stage,
            owner_id=owner_id,
            visibility=stage_visibility,
            reviewer_ids=[assignment.reviewer_id for assignment in current_assignments],
        )
        if not check_access(user, "view", resource, context=actor_context):
            continue
        if scope == "mine" and owner_id != user.id:
            continue
        current_assignment = next(
            (assignment for assignment in current_assignments if assignment.reviewer_id == user.id),
            None,
        )
        can_review = current_assignment is not None and current_assignment.reviewer_id not in reviewed_ids
        can_revise = current_assignment is not None and current_assignment.reviewer_id in reviewed_ids
        due_dates = [assignment.valid_until for assignment in current_assignments if assignment.valid_until]
        requester = stage.project.created_by if stage.project.created_by_id == owner_id else None
        if requester is None and owner_id:
            requester = profile.owner if profile else None
        todo = _todo(
            source="STAGE_REVIEW",
            project_id=stage.project_id,
            object_id=stage.id,
            title=f"阶段评审 · {stage.project.name}",
            context=stage.get_stage_display() if hasattr(stage, "get_stage_display") else stage.stage,
            requester=_participant(requester),
            assignees=_participants(
                [
                    assignment.reviewer
                    for assignment in current_assignments
                    if assignment.reviewer_id not in reviewed_ids
                ]
            ),
            business_status=stage.status,
            handling_status="BLOCKED" if not current_assignments else "IN_PROGRESS",
            next_action="REVIEW",
            due_at=min(due_dates) if due_dates else None,
            href=f"/{workspace.slug}/research/projects/{stage.project_id}/stages/{stage.stage}",
            capabilities=capability_map(
                ("view", "review", "revise"), {"view": True, "review": can_review, "revise": can_revise}
            ),
            trace_ref={"resource_type": "research_stage_instance", "resource_id": str(stage.id)},
            updated_at=stage.updated_at,
        )
        if scope != "to_me" or can_review:
            result.append(todo)
    return result


def collect_agent_approval_todos(workspace, user, scope):
    """Project waiting Agent sessions using the existing Agent operator boundary."""
    setting = getattr(workspace, "research_setting", None)
    if not setting or not setting.research_agent_enabled or not _chain_feature_enabled(workspace):
        return []
    latest_event = ResearchAgentRunEvent.objects.filter(
        session_id=OuterRef("pk"),
        event_type__in=("TOOL_CALL", "AI_ACTION"),
    ).order_by("-seq")
    sessions = (
        ResearchAgentSession.objects.filter(
            workspace=workspace,
            status=ResearchAgentSession.Status.WAITING_APPROVAL,
            deleted_at__isnull=True,
            context_grant__revoked_at__isnull=True,
            context_grant__expires_at__gt=timezone.now(),
        )
        .select_related(
            "user",
            "project",
            "project__research_profile",
            "chain_node",
            "chain_node__chain__project__research_profile",
            "context_grant",
        )
        .annotate(
            _todo_latest_event_id=Subquery(latest_event.values("id")[:1]),
            _todo_latest_event_payload=Subquery(latest_event.values("payload")[:1]),
        )
        .order_by("-updated_at", "-created_at")
    )
    result = []
    for session in sessions:
        if session.chain_node.chain.status != "ACTIVE":
            continue
        profile = getattr(session.project, "research_profile", None)
        visible = session.user_id == user.id or (
            profile is not None and can_read_project_research_metadata(workspace, user, profile)
        )
        if not visible or (scope == "mine" and session.user_id != user.id):
            continue
        can_decide = session.user_id == user.id and session.context_grant.scope_kind != "REVIEW"
        payload = session._todo_latest_event_payload or {}
        summary = next(
            (
                str(value)
                for value in (
                    payload.get("input_summary"),
                    payload.get("query"),
                    payload.get("summary"),
                    payload.get("action"),
                )
                if value
            ),
            session.chain_node.title,
        )
        todo = _todo(
            source="AGENT_APPROVAL",
            project_id=session.project_id,
            object_id=session.session_id,
            title=f"Agent 审批 · {session.chain_node.title}",
            context=summary,
            requester=_participant(session.user),
            assignees=_participants([session.user] if can_decide else []),
            business_status=session.status,
            handling_status="IN_PROGRESS" if can_decide else "BLOCKED",
            next_action="APPROVE",
            due_at=None,
            href=f"/{workspace.slug}/research/approvals?tab=agent_approval",
            capabilities=capability_map(
                ("view", "approve", "reject"),
                {"view": True, "approve": can_decide, "reject": can_decide},
            ),
            trace_ref={
                "resource_type": "research_agent_session",
                "resource_id": str(session.session_id),
                "event_id": str(session._todo_latest_event_id) if session._todo_latest_event_id else None,
            },
            updated_at=session.updated_at,
        )
        if scope != "to_me" or can_decide:
            result.append(todo)
    return result


def collect_office_approval_todos(workspace, user, scope):
    """Project pending approval requests and their current flow-step approvers."""
    if not workspace_research_sections(workspace).get("approvals"):
        return []
    requests = (
        ApprovalRequest.objects.filter(
            flow__workspace=workspace,
            status=ApprovalRequest.Status.PENDING,
            deleted_at__isnull=True,
        )
        .select_related("issue", "issue__project", "flow", "requested_by", "org_unit")
        .order_by("-updated_at", "-created_at")
    )
    if scope == "mine":
        requests = requests.filter(requested_by=user)
    requests = list(requests)
    flow_ids = {request.flow_id for request in requests}
    steps_by_flow = defaultdict(dict)
    for step in (
        ApprovalFlowStep.objects.filter(
            flow_id__in=flow_ids,
            is_required=True,
            deleted_at__isnull=True,
        )
        .only("flow_id", "order", "approver_user_id", "approver_org_role")
        .order_by("flow_id", "order")
    ):
        steps_by_flow[step.flow_id][step.order] = step

    approver_cache = {}
    approver_ids_by_request = {}
    all_approver_ids = set()
    current_steps = {}
    for request in requests:
        step = steps_by_flow.get(request.flow_id, {}).get(request.current_step_order)
        current_steps[request.id] = step
        approver_ids = step_approver_ids(request, step, cache=approver_cache) if step else set()
        approver_ids_by_request[request.id] = approver_ids
        all_approver_ids.update(approver_ids)
    active_approvers = {
        approver.id: approver
        for approver in User.objects.filter(id__in=all_approver_ids, is_active=True).only("display_name", "username")
    }

    result = []
    for request in requests:
        approver_ids = approver_ids_by_request[request.id]
        approvers = [approver for approver_id, approver in active_approvers.items() if approver_id in approver_ids]
        can_decide = current_steps[request.id] is not None and user.id in approver_ids
        todo = _todo(
            source="OFFICE_APPROVAL",
            project_id=request.issue.project_id,
            object_id=request.id,
            title=request.issue.name if request.issue_id else "办公审批",
            context=request.flow.name,
            requester=_participant(request.requested_by),
            assignees=_participants(approvers),
            business_status=request.status,
            handling_status="BLOCKED" if not approvers else "IN_PROGRESS",
            next_action="APPROVE",
            due_at=None,
            href=f"/{workspace.slug}/research/approvals?tab=office",
            capabilities=capability_map(
                ("view", "approve", "reject"),
                {"view": True, "approve": can_decide, "reject": can_decide},
            ),
            trace_ref={"resource_type": "approval_request", "resource_id": str(request.id)},
            updated_at=request.updated_at,
        )
        if scope != "to_me" or can_decide:
            result.append(todo)
    return result


def chain_stage_owner_id(stage):
    """Resolve the authoritative research owner for one chain stage."""
    profile = getattr(stage.chain.project, "research_profile", None)
    return profile.owner_id if profile else None


def collect_chain_stage_approval_todos(workspace, user, scope):
    """Project queue or owner-facing thirteen-stage approval states."""
    if not _chain_feature_enabled(workspace):
        return []
    statuses = (
        ("AWAITING_ADVISOR", "AWAITING_PI", "NEEDS_REVISION", "APPROVED")
        if scope == "mine"
        else ("AWAITING_ADVISOR", "AWAITING_PI")
    )
    stages = (
        ResearchChainStage.objects.filter(
            workspace=workspace,
            status__in=statuses,
            deleted_at__isnull=True,
            chain__status="ACTIVE",
            chain__project__research_profile__workflow_status="ACTIVE",
            **({"submitted_at__isnull": False} if scope == "mine" else {}),
        )
        .select_related(
            "chain__project__research_profile",
            "chain__project",
            "chain__owner",
        )
        .select_related("chain__project__research_profile__owner")
        .order_by("-updated_at", "-created_at")
    )
    result = []
    for stage in stages:
        profile = getattr(stage.chain.project, "research_profile", None)
        if profile is None or not can_read_project_research_metadata(workspace, user, profile):
            continue
        owner_id = chain_stage_owner_id(stage)
        if scope == "mine" and owner_id != user.id:
            continue
        reviewer = None
        if stage.status in ("AWAITING_ADVISOR", "AWAITING_PI"):
            try:
                reviewer = (
                    resolve_advisor(stage.chain)
                    if stage.status == "AWAITING_ADVISOR"
                    else resolve_principal(stage.chain)
                )
            except ChainStageRuleError:
                reviewer = None
        can_decide = reviewer is not None and reviewer.id == user.id
        if scope == "to_me" and not can_decide:
            continue
        reviewer_step = (
            "ADVISOR" if stage.status == "AWAITING_ADVISOR" else "PI" if stage.status == "AWAITING_PI" else "OWNER"
        )
        requester = _participant(profile.owner) if profile.owner else _participant(stage.chain.owner)
        if stage.status == "NEEDS_REVISION":
            handling_status = "RETURNED"
            next_action = "SUBMIT"
            assignees = []
        elif stage.status == "APPROVED":
            handling_status = "DONE"
            next_action = "READ"
            assignees = []
        else:
            handling_status = "BLOCKED" if reviewer is None else "IN_PROGRESS"
            next_action = "APPROVE"
            assignees = _participants([reviewer] if reviewer else [])
        todo = _todo(
            source="CHAIN_STAGE_APPROVAL",
            project_id=stage.chain.project_id,
            object_id=stage.id,
            title=f"{stage.chain.project.name} · {STAGE_TITLES.get(stage.stage_code, stage.stage_code)}",
            context=f"科研链阶段审批 · {reviewer_step}",
            requester=requester,
            assignees=assignees,
            business_status=stage.status,
            handling_status=handling_status,
            next_action=next_action,
            due_at=None,
            href=f"/{workspace.slug}/research/chains/{stage.chain_id}?tab=nodes&stage={stage.stage_code.lower()}&approval=1",
            capabilities=capability_map(
                ("view", "approve", "reject"),
                {"view": True, "approve": scope != "mine" and can_decide, "reject": scope != "mine" and can_decide},
            ),
            trace_ref={"resource_type": "research_chain_stage", "resource_id": str(stage.id)},
            updated_at=stage.updated_at,
        )
        result.append(todo)
    return result


def _todo_sort_key(todo, now=None):
    """Return the stable urgency-first ordering key for one todo."""
    now = now or timezone.now()
    due_value = todo.get("due_at")
    due_timestamp = 0.0
    urgency = ResearchTodoUrgency.NORMAL
    if due_value:
        try:
            parsed = datetime.fromisoformat(due_value)
            if "t" not in due_value.lower():
                parsed = parsed.replace(hour=time.max.hour, minute=time.max.minute, second=time.max.second)
            if timezone.is_naive(parsed):
                parsed = timezone.make_aware(parsed, timezone.get_current_timezone())
            due_timestamp = parsed.timestamp()
            urgency = research_todo_urgency(parsed, now)
        except ValueError:
            due_timestamp = 0.0
            urgency = ResearchTodoUrgency.NORMAL
    updated = datetime.fromisoformat(todo["updated_at"])
    if timezone.is_naive(updated):
        updated = timezone.make_aware(updated, timezone.get_current_timezone())
    return (
        todo["handling_status"] != "BLOCKED",
        URGENCY_RANK[urgency],
        due_timestamp,
        -updated.timestamp(),
        todo["id"],
    )


def collect_research_todos(workspace, user, scope, request_id=None):
    """Aggregate all source projections after their original ACL has run.

    Args:
        workspace: Workspace whose todos are projected.
        user: Current authenticated caller.
        scope: ``to_me``, ``mine`` or ``visible``.
        request_id: Request identifier used only by degradation logs.

    Returns:
        A ``(todos, degraded_sources)`` tuple; source order in the degraded list
        is stable and one failed source never suppresses the other sources.
    """
    with todo_query_context():
        return _collect_research_todos(workspace, user, scope, request_id)


def _collect_research_todos(workspace, user, scope, request_id):
    """在请求级只读上下文内聚合各来源，并保留独立降级边界。

    Args:
        workspace: 待办所属工作区。
        user: 接收权限过滤结果的当前用户。
        scope: 原有的待办范围参数。
        request_id: 关联请求与来源日志的标识。

    Returns:
        去重后的待办列表及发生降级的来源列表。
    """
    collectors = (
        ("CHAIN_TASK", collect_chain_task_todos),
        ("REPORT", collect_report_todos),
        ("PAPER_REVIEW", collect_paper_review_todos),
        ("STAGE_REVIEW", collect_stage_review_todos),
        ("CHAIN_STAGE_APPROVAL", collect_chain_stage_approval_todos),
        ("AGENT_APPROVAL", collect_agent_approval_todos),
        ("OFFICE_APPROVAL", collect_office_approval_todos),
    )
    todos = []
    degraded = []
    for source, collector in collectors:
        counter = {"query_count": 0}
        source_todos = []
        failed = False
        started_at = perf_counter()
        try:
            with count_todo_queries() as counter:
                source_todos = collector(workspace, user, scope)
            todos.extend(source_todos)
        except Exception as error:
            failed = True
            logger.exception(
                "Research todo source degraded",
                extra={
                    "event": "research_todo_source_degraded",
                    "source": source,
                    "workspace_id": str(workspace.id),
                    "workspace_slug": workspace.slug,
                    "request_id": request_id,
                    "user_id": str(user.id),
                    "exception_type": type(error).__name__,
                },
            )
            degraded.append(source)
        finally:
            logger.info(
                "Research todo source measured",
                extra={
                    "event": "workspace_todo_source",
                    "source": source,
                    "workspace_id": str(workspace.id),
                    "user_id": str(user.id),
                    "request_id": request_id,
                    "duration_ms": round((perf_counter() - started_at) * 1000, 2),
                    "query_count": counter["query_count"],
                    "result_count": len(source_todos),
                    "degraded": failed,
                },
            )
    deduplicated = {}
    for todo in todos:
        existing = deduplicated.get(todo["id"])
        if existing is None or _todo_sort_key(todo) < _todo_sort_key(existing):
            deduplicated[todo["id"]] = todo
    return sorted(deduplicated.values(), key=_todo_sort_key), degraded
