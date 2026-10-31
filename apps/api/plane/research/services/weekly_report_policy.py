"""Live personal-report authorization and a conservative PostgreSQL consistency barrier."""

import secrets

import pytz
from django.apps import apps
from django.conf import settings
from django.db import connection, transaction
from django.utils import timezone
from django.views.decorators.debug import sensitive_variables
from rest_framework.authentication import BaseAuthentication

from plane.db import models as db
from plane.mcp.credentials import expires_after, seal_credential, unexpired_connections, valid_lifetime
from plane.research.services.context_tokens import hash_context_token
from plane.research.services.weekly_report_errors import WeeklyReportError
from plane.research.utils.capabilities import NAV_REPORTS, has_active_research_org_relation, nav_allowed
from plane.research.utils.org import READABLE_WORKSPACE_ROLES
from plane.research.utils.settings import report_timezone_for, workspace_research_sections
from plane.research.utils.audit import record_audit_event
from plane.utils.workspace_access import user_can_access_workspace

PERIOD_POLICY = "current_and_previous_week.v1"
OWN_ACTIONS = frozenset({"save_draft", "submit", "withdraw"})
REVIEW_ACTIONS = frozenset({"return", "accept"})
ACTIONS = OWN_ACTIONS | REVIEW_ACTIONS | {"read_reports"}
HEADER = "X-Weekly-Report-Token"

# Existing Page/asset/org endpoints do not share a report row lock. Until all
# those writers have a common finer-grained lock protocol, table write barriers
# prevent phantoms and mid-execution policy changes as well as ordinary updates.
# This is deliberately conservative and enabled only for this opt-in feature.
POLICY_MODELS = (
    db.OrgUnit,
    db.OrgUnitMember,
    db.MentorBinding,
    db.WorkspaceMember,
    db.WorkspaceResearchSetting,
    db.ResearchProjectProfile,
    db.Project,
    db.ProjectMember,
    db.ReportTemplate,
    db.ReportAccessGrant,
    db.PeriodicReportProjectReference,
    db.ResearchUserProfile,
    db.StageReviewerAssignment,
    db.ResearchWorkspaceAccessGrant,
    db.ResearchApprovalRoute,
)
REPORT_MODELS = (
    db.PeriodicReport,
    db.Page,
    db.ReportAttachment,
    db.FileAsset,
    db.PeriodicReportSnapshot,
)


def consistency_barrier(*, sources=False):
    """Must be acquired inside atomic, before taking any policy/report row lock.

    Blocking legacy writers finish first; after acquisition READ COMMITTED sees
    their commits. No relevant UPDATE/INSERT/DELETE can race the final check.
    Timeouts/deadlocks are retryable; they must roll back the whole operation.
    """
    if connection.vendor != "postgresql":
        raise WeeklyReportError("temporarily_unavailable", "Weekly report operations require PostgreSQL.", 503)
    models = set(POLICY_MODELS + REPORT_MODELS + (db.ReportAgentGrant, db.User, db.Workspace))
    from plane.license.models import InstanceAdmin, InstanceRoleAssignment

    models.update((InstanceAdmin, InstanceRoleAssignment))
    if sources:
        # Source resolvers span node links, versions and ACLs. Cover their
        # research domain, not just the one referenced row or its clipped text.
        models.update(
            m for m in apps.get_app_config("db").get_models() if m.__module__.startswith("plane.db.models.research.")
        )
    quote = connection.ops.quote_name
    tables = sorted({quote(model._meta.db_table) for model in models})
    with connection.cursor() as cursor:
        cursor.execute("SET LOCAL lock_timeout = '3s'")
        cursor.execute("LOCK TABLE " + ", ".join(tables) + " IN SHARE ROW EXCLUSIVE MODE")


def check_actor(workspace, user, *, require_feature=True):
    if require_feature and not getattr(settings, "RESEARCH_WEEKLY_REPORT_MCP_ENABLED", False):
        raise WeeklyReportError("reports_disabled", "Weekly report MCP is disabled.", 403)
    if (
        not db.User.objects.filter(pk=user.pk, is_active=True).exists()
        or not user_can_access_workspace(user, workspace_id=workspace.pk)
        or not db.WorkspaceMember.objects.filter(
            workspace=workspace, member=user, is_active=True, role__in=READABLE_WORKSPACE_ROLES
        ).exists()
    ):
        raise WeeklyReportError("scope_denied", "Active workspace membership is required.", 403)
    if require_feature:
        try:
            pytz.timezone(report_timezone_for(workspace))
        except pytz.UnknownTimeZoneError:
            raise WeeklyReportError("policy_changed", "The workspace report timezone is invalid.", 403) from None
        if not workspace_research_sections(workspace)["reports"] or not nav_allowed(user, workspace, NAV_REPORTS):
            raise WeeklyReportError("reports_disabled", "Reports are not available for this account/workspace.", 403)
        if not has_active_research_org_relation(user, workspace):
            raise WeeklyReportError("report_org_required", "An active organisation assignment is required.", 403)


def available_actions(workspace, user):
    """Return the role-aware actions this account may put in a weekly token.

    Args:
        workspace: Workspace owning the personal weekly reports.
        user: Human account requesting a new connection.

    Returns:
        A sorted action list; object-level checks still run on every call.
    """
    check_actor(workspace, user)
    actions = {"read_reports"}
    from plane.research.services.report_workflow import resolve_report_context
    from plane.research.utils.role_resolution import resolve_role_context

    context = resolve_report_context(workspace=workspace, actor=user, payload={})
    if context.report_org_unit is not None:
        actions.update(OWN_ACTIONS)
    roles = set(resolve_role_context(user, workspace).get("roles", []))
    if roles & {"ADMIN", "PRINCIPAL", "MENTOR"}:
        actions.update(REVIEW_ACTIONS)
    return sorted(actions)


def check_grant(grant, workspace, user, *, action=None, lock=False):
    queryset = db.ReportAgentGrant.objects
    if lock:
        queryset = queryset.select_for_update()
    current = queryset.filter(
        pk=grant.pk,
        workspace=workspace,
        user=user,
        purpose="weekly_report",
        report_type="WEEKLY",
        period_policy=PERIOD_POLICY,
    ).first()
    if current is None:
        raise WeeklyReportError("weekly_grant_required", "A personal weekly report credential is required.", 401)
    if current.revoked_at:
        raise WeeklyReportError("grant_revoked", "This weekly report connection was revoked.", 403)
    if current.expires_at and current.expires_at <= timezone.now():
        raise WeeklyReportError("grant_expired", "This weekly report connection expired.", 403)
    check_actor(workspace, user)
    if not set(current.allowed_actions) or not set(current.allowed_actions) <= ACTIONS:
        raise WeeklyReportError("scope_denied", "Invalid credential actions.", 403)
    if action and action not in current.allowed_actions:
        raise WeeklyReportError("scope_denied", "This connection does not allow that action.", 403)
    return current


@transaction.atomic
@sensitive_variables()
def issue_grant(*, workspace, user, label, actions, ttl_days):
    consistency_barrier()
    check_actor(workspace, user)
    if (
        not isinstance(label, str)
        or not 1 <= len(label.strip()) <= 100
        or any(ord(c) < 32 or ord(c) == 127 for c in label)
        or not isinstance(actions, list)
        or not actions
        or any(not isinstance(action, str) for action in actions)
        or not set(actions) <= ACTIONS
        or len(set(actions)) != len(actions)
        or not valid_lifetime(ttl_days)
    ):
        raise WeeklyReportError("invalid_arguments", "Choose a name, explicit actions and an allowed lifetime.")
    if set(actions) & OWN_ACTIONS:
        from plane.research.services.report_workflow import resolve_report_context

        context = resolve_report_context(workspace=workspace, actor=user, payload={})
        if context.report_org_unit is None:
            raise WeeklyReportError("report_org_required", "A primary organisation assignment is required.", 403)
    if (
        db.ReportAgentGrant.objects.filter(
            unexpired_connections(), workspace=workspace, user=user, revoked_at__isnull=True
        ).count()
        >= 10
    ):
        raise WeeklyReportError("grant_limit", "Revoke an existing weekly report connection first.", 409)
    raw = "pwr_" + secrets.token_urlsafe(32)
    grant = db.ReportAgentGrant.objects.create(
        workspace=workspace,
        user=user,
        label=label.strip(),
        allowed_actions=sorted(actions),
        token_hash=hash_context_token(raw),
        token_encrypted=seal_credential(raw),
        expires_at=expires_after(ttl_days),
    )
    record_audit_event(
        workspace=workspace,
        actor=user,
        action="report.mcp.grant.issue",
        resource_type="report_agent_grant",
        resource_id=grant.pk,
        metadata={"actions": grant.allowed_actions, "ttl_days": ttl_days},
    )
    return grant, raw


class WeeklyReportTokenAuthentication(BaseAuthentication):
    @sensitive_variables()
    def authenticate(self, request):
        raw = request.headers.get(HEADER)
        if not raw or not isinstance(raw, str) or not raw.startswith("pwr_") or not 40 <= len(raw) <= 128:
            raise WeeklyReportError("weekly_grant_required", "A dedicated weekly report token is required.", 401)
        if not raw.isascii() or any(ord(c) < 33 or ord(c) > 126 for c in raw):
            raise WeeklyReportError("weekly_grant_required", "Invalid weekly report credential.", 401)
        grant = (
            db.ReportAgentGrant.objects.select_related("user", "workspace")
            .filter(token_hash=hash_context_token(raw), purpose="weekly_report", report_type="WEEKLY")
            .first()
        )
        if not grant:
            raise WeeklyReportError("weekly_grant_required", "Invalid weekly report credential.", 401)
        check_grant(grant, grant.workspace, grant.user)
        db.ReportAgentGrant.objects.filter(pk=grant.pk).update(last_used_at=timezone.now())
        return grant.user, grant

    def authenticate_header(self, request):
        return HEADER
