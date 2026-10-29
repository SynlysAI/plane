# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Candidate resolution and immutable routing for research submissions."""

from uuid import UUID

from django.utils import timezone

from plane.db.models import (
    MentorBinding,
    OrgUnitMember,
    PeriodicReport,
    ResearchApprovalRoute,
    WorkspaceResearchSetting,
)
from plane.research.utils.errors import ResearchErrorCode
from plane.research.utils.acl import org_unit_ancestry
from plane.research.utils.org import active_membership_q
from plane.research.utils.roles import is_research_admin

APPROVAL_ROUTE_SCHEMA_VERSION = "research-approval-route.v1"
ROUTE_RULES = {
    "reviewer_required": True,
    "reviewer_selection": "SINGLE",
    "self_review_allowed": False,
    "cc_allowed": True,
}


class ApprovalRouteError(Exception):
    """Raised when a submission route cannot be resolved or persisted."""

    def __init__(self, error_code, message):
        self.error_code = error_code
        self.message = message
        super().__init__(message)


def _user_id(user_or_id):
    """Return a comparable user ID from a model or raw identifier."""
    return getattr(user_or_id, "id", user_or_id)


def _candidate(user, role):
    """Project one selectable reviewer without account-sensitive fields."""
    return {
        "id": str(user.id),
        "display_name": user.display_name or user.username or user.email,
        "email": user.email,
        "role": role,
    }


def _resource_subject(resource_type, resource):
    """Resolve the business owner and organisation scope of a resource."""
    normalized = str(resource_type or "").upper()
    if normalized == ResearchApprovalRoute.ResourceType.PERIODIC_REPORT:
        return {
            "workspace_id": resource.workspace_id,
            "owner_id": resource.owner_id,
            "org_unit_id": resource.org_unit_id,
        }
    raise ApprovalRouteError(
        ResearchErrorCode.APPROVAL_ROUTE_INVALID,
        "This research resource does not support approval routing.",
    )


def approval_route_candidates(resource_type, resource, submitted_by):
    """Return the ordered, submitter-excluded reviewer candidates for one resource.

    Args:
        resource_type: Resource type code from ``ResearchApprovalRoute``.
        resource: Node task or periodic report being submitted.
        submitted_by: User who will submit the resource.

    Returns:
        A list of candidate projections in default reviewer order.
    """
    subject = _resource_subject(resource_type, resource)
    submitter_id = _user_id(submitted_by)
    today = timezone.localdate()
    ordered = []
    seen = set()

    def add(user, role):
        if user is None or not getattr(user, "is_active", False):
            return
        if user.id in seen or user.id in {submitter_id, subject["owner_id"]}:
            return
        seen.add(user.id)
        ordered.append((user, role))

    bindings = (
        MentorBinding.objects.filter(
            active_membership_q(today),
            workspace_id=subject["workspace_id"],
            mentee_id=subject["owner_id"],
            mentor__is_active=True,
        )
        .select_related("mentor")
        .order_by("-is_primary_advisor", "created_at")
    )
    for binding in bindings:
        add(
            binding.mentor,
            (
                ResearchApprovalRoute.ReviewerRole.PRIMARY_ADVISOR
                if binding.is_primary_advisor
                else ResearchApprovalRoute.ReviewerRole.ADVISOR
            ),
        )

    setting = (
        WorkspaceResearchSetting.objects.filter(
            workspace_id=subject["workspace_id"],
            deleted_at__isnull=True,
        )
        .select_related("main_pi")
        .first()
    )
    if setting is not None:
        add(setting.main_pi, ResearchApprovalRoute.ReviewerRole.MAIN_PI)

    if subject["org_unit_id"]:
        unit_ids = [subject["org_unit_id"], *org_unit_ancestry(subject["org_unit_id"], subject["workspace_id"])]
        memberships = OrgUnitMember.objects.filter(
            active_membership_q(today),
            workspace_id=subject["workspace_id"],
            org_unit_id__in=unit_ids,
            org_role__in=("OWNER", "PI", "UNIT_ADMIN"),
            org_unit__deleted_at__isnull=True,
            user__is_active=True,
        ).select_related("user", "org_unit")
        role_by_unit = {unit_id: index for index, unit_id in enumerate(unit_ids)}
        memberships = sorted(
            memberships,
            key=lambda item: (
                role_by_unit.get(item.org_unit_id, len(unit_ids)),
                {"OWNER": 0, "PI": 1, "UNIT_ADMIN": 2}.get(item.org_role, 3),
                item.user.display_name.lower() if item.user.display_name else item.user.email.lower(),
            ),
        )
        for membership in memberships:
            add(
                membership.user,
                {
                    "OWNER": ResearchApprovalRoute.ReviewerRole.UNIT_OWNER,
                    "PI": ResearchApprovalRoute.ReviewerRole.UNIT_PI,
                    "UNIT_ADMIN": ResearchApprovalRoute.ReviewerRole.UNIT_ADMIN,
                }[membership.org_role],
            )

    candidates = [_candidate(user, role) for user, role in ordered]
    for index, candidate in enumerate(candidates):
        candidate["is_default"] = index == 0
    return candidates


def active_approval_route(resource_type, resource_id, workspace_id=None):
    """Return the active route for one resource, if present."""
    query = ResearchApprovalRoute.objects.select_related("workspace", "submitted_by", "reviewer").filter(
        resource_type=str(resource_type or "").upper(),
        resource_id=resource_id,
        status=ResearchApprovalRoute.Status.ACTIVE,
        deleted_at__isnull=True,
    )
    if workspace_id is not None:
        query = query.filter(workspace_id=workspace_id)
    return query.first()


def active_approval_route_map(resource_type, resource_ids, workspace_id):
    """Return a resource-ID keyed map of active routes for one page."""
    return {
        route.resource_id: route
        for route in ResearchApprovalRoute.objects.select_related("workspace", "submitted_by", "reviewer").filter(
            workspace_id=workspace_id,
            resource_type=str(resource_type or "").upper(),
            resource_id__in=resource_ids,
            status=ResearchApprovalRoute.Status.ACTIVE,
            deleted_at__isnull=True,
        )
    }


def approval_route_detail(route):
    """Project one persisted route for task and report serializers."""
    if route is None:
        return None
    reviewer = route.reviewer
    return {
        "id": str(route.id),
        "resource_type": route.resource_type,
        "resource_id": str(route.resource_id),
        "status": route.status,
        "reviewer": str(route.reviewer_id),
        "reviewer_role": route.reviewer_role,
        "reviewer_detail": _candidate(reviewer, route.reviewer_role),
        "submitted_by": str(route.submitted_by_id),
        "cc_user_ids": [str(user_id) for user_id in route.cc_user_ids],
        "created_at": route.created_at.isoformat(),
    }


def approval_route_payload(resource_type, resource, submitted_by):
    """Build the reusable route candidate response for a submission candidate."""
    candidates = approval_route_candidates(resource_type, resource, submitted_by)
    route = active_approval_route(resource_type, resource.id, resource.workspace_id)
    return {
        "schema_version": APPROVAL_ROUTE_SCHEMA_VERSION,
        "resource_type": str(resource_type or "").upper(),
        "resource_id": str(resource.id),
        "candidates": candidates,
        "default_reviewer_id": candidates[0]["id"] if candidates else None,
        "rules": ROUTE_RULES,
        "active_route": approval_route_detail(route),
    }


def _normalise_id(value, field_name):
    """Parse one route user identifier without leaking ORM errors."""
    try:
        return str(UUID(str(value)))
    except (TypeError, ValueError):
        raise ApprovalRouteError(
            ResearchErrorCode.APPROVAL_REVIEWER_INVALID,
            f"{field_name} must be a valid UUID.",
        ) from None


def validate_route_selection(resource_type, resource, submitted_by, reviewer_id, cc_user_ids):
    """Validate a single reviewer and carbon-copy set against the live candidate group."""
    candidates = approval_route_candidates(resource_type, resource, submitted_by)
    candidate_by_id = {item["id"]: item for item in candidates}
    if reviewer_id in (None, ""):
        raise ApprovalRouteError(
            ResearchErrorCode.APPROVAL_REVIEWER_REQUIRED,
            "Select one reviewer before submitting.",
        )
    reviewer = _normalise_id(reviewer_id, "reviewer_id")
    if reviewer == str(_user_id(submitted_by)):
        raise ApprovalRouteError(
            ResearchErrorCode.APPROVAL_REVIEWER_SELF,
            "The submitter cannot review their own submission.",
        )
    if reviewer not in candidate_by_id:
        raise ApprovalRouteError(
            ResearchErrorCode.APPROVAL_REVIEWER_INVALID,
            "The selected reviewer is not in this submission's approval group.",
        )

    raw_cc = cc_user_ids or []
    if not isinstance(raw_cc, (list, tuple)):
        raise ApprovalRouteError(
            ResearchErrorCode.APPROVAL_CC_INVALID,
            "cc_user_ids must be an array of user IDs.",
        )
    cc_ids = []
    for value in raw_cc:
        user_id = _normalise_id(value, "cc_user_ids")
        if user_id == reviewer:
            raise ApprovalRouteError(
                ResearchErrorCode.APPROVAL_CC_INVALID,
                "The reviewer cannot also be carbon-copied.",
            )
        if user_id == str(_user_id(submitted_by)):
            raise ApprovalRouteError(
                ResearchErrorCode.APPROVAL_CC_INVALID,
                "The submitter cannot carbon-copy themselves.",
            )
        if user_id not in candidate_by_id:
            raise ApprovalRouteError(
                ResearchErrorCode.APPROVAL_CC_INVALID,
                "A carbon-copy user is not in this submission's approval group.",
            )
        if user_id not in cc_ids:
            cc_ids.append(user_id)

    selected = candidate_by_id[reviewer]
    return {
        "reviewer_id": reviewer,
        "reviewer_role": selected["role"],
        "cc_user_ids": cc_ids,
        "candidate_snapshot": candidates,
    }


def create_approval_route(
    *,
    workspace,
    resource_type,
    resource,
    submitted_by,
    reviewer_id,
    cc_user_ids=None,
    request_id,
):
    """Validate and persist the route for one new submission."""
    selection = validate_route_selection(resource_type, resource, submitted_by, reviewer_id, cc_user_ids)
    if active_approval_route(resource_type, resource.id, resource.workspace_id) is not None:
        raise ApprovalRouteError(
            ResearchErrorCode.APPROVAL_ROUTE_CONFLICT,
            "This submission already has an active approval route.",
        )
    return ResearchApprovalRoute.objects.create(
        workspace=workspace,
        resource_type=str(resource_type or "").upper(),
        resource_id=resource.id,
        submitted_by=submitted_by,
        reviewer_id=selection["reviewer_id"],
        reviewer_role=selection["reviewer_role"],
        cc_user_ids=selection["cc_user_ids"],
        candidate_snapshot=selection["candidate_snapshot"],
        request_id=request_id[:128],
    )


def close_active_route(resource_type, resource_id, workspace_id, actor=None):
    """Supersede the active route after withdrawal, review, or cancellation."""
    route = active_approval_route(resource_type, resource_id, workspace_id)
    if route is None:
        return None
    route.status = ResearchApprovalRoute.Status.SUPERSEDED
    route.superseded_at = timezone.now()
    if actor is not None:
        route.updated_by = actor
    route.save(update_fields=["status", "superseded_at", "updated_by", "updated_at"])
    return route


def actor_can_review_route(workspace, resource_type, resource_id, actor):
    """Return whether the actor is the routed reviewer or a research administrator."""
    if actor is None or not getattr(actor, "is_authenticated", False):
        return False
    if is_research_admin(actor, workspace.id):
        return True
    route = active_approval_route(resource_type, resource_id, workspace.id)
    return route is not None and route.reviewer_id == actor.id


def routed_resource_ids(workspace_id, resource_type, reviewer):
    """Return resource IDs actively routed to one reviewer."""
    return list(
        ResearchApprovalRoute.objects.filter(
            workspace_id=workspace_id,
            resource_type=str(resource_type or "").upper(),
            reviewer_id=reviewer.id,
            status=ResearchApprovalRoute.Status.ACTIVE,
            deleted_at__isnull=True,
        ).values_list("resource_id", flat=True)
    )


def route_users(route):
    """Resolve the reviewer and carbon-copy users for notification delivery."""
    from plane.db.models import User

    if route is None:
        return [], []
    user_ids = [UUID(str(user_id)) for user_id in [route.reviewer_id, *route.cc_user_ids]]
    users = {user.id: user for user in User.objects.filter(id__in=user_ids, is_active=True)}
    reviewer_id = UUID(str(route.reviewer_id))
    reviewer = users.get(reviewer_id)
    cc_users = [users[UUID(str(user_id))] for user_id in route.cc_user_ids if UUID(str(user_id)) in users]
    return ([reviewer] if reviewer else []), cc_users


def backfill_legacy_report_routes():
    """Backfill active routes for report submissions created before explicit routing."""
    reports = PeriodicReport.objects.filter(
        status=PeriodicReport.Status.SUBMITTED, deleted_at__isnull=True
    ).select_related("workspace", "owner", "org_unit")
    for report in reports:
        _backfill_one(ResearchApprovalRoute.ResourceType.PERIODIC_REPORT, report, report.owner)
    return True


def _backfill_one(resource_type, resource, submitted_by):
    """Create a deterministic legacy route when a valid candidate exists."""
    if active_approval_route(resource_type, resource.id, resource.workspace_id) is not None:
        return None
    candidates = approval_route_candidates(resource_type, resource, submitted_by)
    if not candidates:
        return None
    selected = candidates[0]
    return ResearchApprovalRoute.objects.create(
        workspace_id=resource.workspace_id,
        resource_type=resource_type,
        resource_id=resource.id,
        submitted_by=submitted_by,
        reviewer_id=selected["id"],
        reviewer_role=selected["role"],
        cc_user_ids=[],
        candidate_snapshot=candidates,
        request_id=f"legacy-{resource_type.lower()}-{resource.id}"[:128],
    )
