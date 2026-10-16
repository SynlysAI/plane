# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Report state machine and ACL projection."""

from django.db.models import Q
from django.utils import timezone

from plane.db.models import ReportAccessGrant
from plane.research.utils.acl import ResearchResource, direct_advisor_ids

# Only the transitions drawn in the PRD state diagram are allowed (P0-RPT-06).
STATE_TRANSITIONS = {
    "DRAFT": {"SUBMITTED"},
    "SUBMITTED": {"ACCEPTED", "NEEDS_REVISION"},
    "NEEDS_REVISION": {"DRAFT", "SUBMITTED"},
    "ACCEPTED": set(),
}

EDITABLE_STATES = {"DRAFT", "NEEDS_REVISION"}


def can_transition(from_status, to_status) -> bool:
    return to_status in STATE_TRANSITIONS.get(from_status, set())


def is_editable(report) -> bool:
    return report.status in EDITABLE_STATES


def active_grants(report):
    """Custom grants that are still valid, projected for the ACL service."""
    now = timezone.now()
    grants = []
    prefetched = getattr(report, "_prefetched_objects_cache", {}).get("access_grants")
    grants_source = prefetched if prefetched is not None else ReportAccessGrant.objects.filter(report=report)
    for grant in grants_source:
        if grant.is_revoked:
            continue
        if grant.expires_at and grant.expires_at <= now:
            continue
        grants.append(
            {
                "grantee_user": str(grant.grantee_user_id) if grant.grantee_user_id else None,
                "grantee_org_unit": str(grant.grantee_org_unit_id) if grant.grantee_org_unit_id else None,
            }
        )
    return grants


def report_resource(report) -> ResearchResource:
    return ResearchResource(
        kind="report",
        workspace_id=report.workspace_id,
        owner_id=report.owner_id,
        org_unit_id=report.org_unit_id,
        visibility=report.visibility,
        state=report.status,
        # A returned report has a new private revision while readers receive the
        # last immutable snapshot. Before the first submission it is all draft.
        is_draft=report.submitted_at is None,
        grants=active_grants(report),
    )


def supervisor_reader_ids(report, actor_context, mentor_cache=None):
    """Readers whose receipts light the author-facing mentor-read badge.

    Only the report author's active mentors and the workspace main PI count;
    other readers (e.g. workspace admins) are still recorded, they just stay
    invisible to the badge. ``mentor_cache`` is an optional per-request
    ``owner_id -> mentor ids`` dict so list serialisation avoids per-row queries.
    """
    cache = mentor_cache if mentor_cache is not None else {}
    owner_id = report.owner_id
    if owner_id not in cache:
        cache[owner_id] = direct_advisor_ids(owner_id, report.workspace_id)
    reader_ids = set(cache[owner_id])
    if actor_context is not None and actor_context.main_pi_id is not None:
        reader_ids.add(actor_context.main_pi_id)
    return reader_ids


def visible_reports_queryset(queryset, context):
    """Apply the complete report visibility matrix in SQL before pagination."""
    if context.is_workspace_admin:
        return queryset
    owner_scope = Q(owner_id=context.user_id)
    formal = Q(submitted_at__isnull=False)
    if context.is_main_pi:
        audience = formal
    else:
        formal_audience = Q()
        if context.managing_unit_ids:
            formal_audience |= Q(org_unit_id__in=context.managing_unit_ids)
        if context.advises:
            formal_audience |= Q(
                visibility="DIRECT_ADVISOR",
                owner_id__in=context.advises,
            )
        if context.unit_ids:
            formal_audience |= Q(
                visibility="UNIT",
                org_unit_id__in=context.unit_ids,
            )
        formal_audience |= Q(visibility="WORKSPACE")

        active_grant = Q(
            visibility="CUSTOM",
            access_grants__is_revoked=False,
        ) & (Q(access_grants__expires_at__isnull=True) | Q(access_grants__expires_at__gt=timezone.now()))
        grant_recipient = Q(access_grants__grantee_user_id=context.user_id)
        if context.unit_ids:
            grant_recipient |= Q(access_grants__grantee_org_unit_id__in=context.unit_ids)
        formal_audience |= active_grant & grant_recipient
        audience = formal & formal_audience
    return queryset.filter(owner_scope | audience).distinct()
