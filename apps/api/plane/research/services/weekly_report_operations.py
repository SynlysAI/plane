"""Fixed proposals, live authorization, atomic commits and durable result recovery."""

import hashlib
from datetime import timedelta
from difflib import ndiff

from django.conf import settings
from django.core import signing
from django.db import DatabaseError, transaction
from django.db.models import Q
from django.utils.dateparse import parse_date, parse_datetime
from django.utils import timezone

from plane.db import models as db
from plane.research.services import report_workflow as workflow
from plane.research.services.weekly_report_body import (
    BODY_FIELDS,
    FALLBACK,
    body_hash,
    canonical,
    digest,
    document_body,
    normalize_body,
)
from plane.research.services.weekly_report_catalog import VERSION, validate
from plane.research.services.weekly_report_errors import WeeklyReportError
from plane.research.services.weekly_report_policy import (
    PERIOD_POLICY,
    POLICY_MODELS,
    check_grant,
    consistency_barrier,
)
from plane.research.services.approval_routes import (
    ApprovalRouteError,
    active_approval_route,
    actor_can_review_route,
    approval_route_payload,
    close_active_route,
    routed_resource_ids,
    validate_route_selection,
)
from plane.research.utils.audit import ResearchAuditAction, ResearchResourceType, record_audit_event
from plane.research.utils.notifications import (
    report_reviewer_ids,
    notify_report_accepted,
    notify_report_returned,
    notify_report_withdrawn,
)
from plane.research.utils.acl import build_actor_context, check_access, direct_advisor_ids
from plane.research.utils.periods import InvalidPeriod, parse_period, period_for_offset
from plane.research.utils.reports import (
    active_grants,
    can_transition,
    effective_report_visibility,
    is_editable,
    report_resource,
    visible_reports_queryset,
)
from plane.research.utils.roles import is_research_admin
from plane.research.utils.settings import default_visibility_for, report_timezone_for

REVISION_SALT = "plane.weekly-report.revision.v1"
CURSOR_SALT = "plane.weekly-report.content.v1"


def row_data(row):
    value = {}
    for field in row._meta.concrete_fields:
        item = getattr(row, field.attname)
        if isinstance(item, (bytes, memoryview)):
            item = hashlib.sha256(bytes(item)).hexdigest()
        value[field.attname] = item
    return value


def rows(queryset):
    return [row_data(row) for row in queryset.order_by("pk")]


def report_url(workspace, report_id):
    return f"{(getattr(settings, 'WEB_URL', '') or '').rstrip('/')}/{workspace.slug}/research/reports/{report_id}"


class WeeklyReportService:
    def __init__(self, *, grant):
        self.grant, self.workspace, self.user = grant, grant.workspace, grant.user

    def authenticate(self, action=None, *, lock=False):
        workspace = db.Workspace.objects.filter(pk=self.workspace.pk).first()
        user = db.User.objects.filter(pk=self.user.pk).first()
        if workspace is None or user is None:
            raise WeeklyReportError("scope_denied", "Account or workspace is no longer active.", 403)
        self.workspace, self.user = workspace, user
        self.grant = check_grant(self.grant, self.workspace, self.user, action=action, lock=lock)

    def binding(self, period):
        return {
            "workspace": str(self.workspace.pk),
            "user": str(self.user.pk),
            "grant": str(self.grant.pk),
            "period": period,
        }

    def identity(self):
        return {
            "workspace_id": str(self.workspace.pk),
            "user_id": str(self.user.pk),
            "display_name": str(self.user.display_name or self.user.first_name or "")[:255],
        }

    def authenticate_read(self, *, lock=False):
        """Authenticate catalog reads without broadening legacy write grants."""
        self.authenticate("read_reports", lock=lock)

    def visible_report(self, report_id, *, lock=False):
        """Load one report through the native visibility matrix.

        Args:
            report_id: Target report identifier.
            lock: Whether to lock the report row for a proposal or review commit.

        Returns:
            A visible PeriodicReport, or raises a non-leaky not-found error.
        """
        rows = workflow.report_queryset(self.workspace).select_related(
            "workspace", "owner", "org_unit", "page", "project"
        )
        if lock:
            rows = rows.select_for_update(of=("self",))
        report = rows.filter(pk=report_id, report_type="WEEKLY").first()
        context = build_actor_context(self.user, self.workspace.pk)
        if report is None or not check_access(self.user, "view", report_resource(report), context=context):
            raise WeeklyReportError("not_found", "Report not found in current scope.", 404)
        return report

    @staticmethod
    def report_body(report):
        """Return the body a reader is authorized to see at the current state."""
        snapshot = None
        if report.submitted_at is not None:
            snapshot = report.official_snapshots.order_by("-version_no").first()
        source = snapshot if snapshot is not None else report.page
        return {field: getattr(source, field) for field in BODY_FIELDS}

    @staticmethod
    def report_projection(report):
        """Project bounded report metadata without copying serializer internals."""
        route = active_approval_route("PERIODIC_REPORT", report.pk, report.workspace_id)
        return {
            "id": str(report.pk),
            "workspace_id": str(report.workspace_id),
            "owner": {
                "id": str(report.owner_id),
                "display_name": str(report.owner.display_name or report.owner.username or "")[:255],
            },
            "org_unit_id": str(report.org_unit_id) if report.org_unit_id else None,
            "project_id": str(report.project_id) if report.project_id else None,
            "report_type": report.report_type,
            "period_key": report.period_key,
            "period_start": str(report.period_start),
            "period_end": str(report.period_end),
            "timezone": report.timezone,
            "status": report.status,
            "visibility": effective_report_visibility(report),
            "submitted_at": report.submitted_at.isoformat() if report.submitted_at else None,
            "accepted_at": report.accepted_at.isoformat() if report.accepted_at else None,
            "reviewer_id": str(report.reviewer_id) if report.reviewer_id else None,
            "official_version": report.official_snapshots.order_by("-version_no")
            .values_list("version_no", flat=True)
            .first()
            or 0,
            "approval_route_id": str(route.pk) if route else None,
            "reviewer_of_route_id": str(route.reviewer_id) if route else None,
            "url": report_url(report.workspace, report.pk),
        }

    def report_revision(self, report, content):
        """Sign a report-specific revision bound to grant, actor and content state."""
        route = active_approval_route("PERIODIC_REPORT", report.pk, report.workspace_id)
        state_hash = digest(
            {
                "report": row_data(report),
                "content": content,
                "route": row_data(route) if route else None,
            }
        )
        value = {
            "workspace": str(self.workspace.pk),
            "user": str(self.user.pk),
            "grant": str(self.grant.pk),
            "report": str(report.pk),
            "state_hash": state_hash,
        }
        return signing.dumps(value, salt=REVISION_SALT), state_hash

    def check_report_revision(self, revision, report, content):
        """Verify a report revision without accepting another report's token."""
        route = active_approval_route("PERIODIC_REPORT", report.pk, report.workspace_id)
        state_hash = digest(
            {"report": row_data(report), "content": content, "route": row_data(route) if route else None}
        )
        expected = {
            "workspace": str(self.workspace.pk),
            "user": str(self.user.pk),
            "grant": str(self.grant.pk),
            "report": str(report.pk),
            "state_hash": state_hash,
        }
        try:
            supplied = signing.loads(revision, salt=REVISION_SALT, max_age=900)
        except (signing.BadSignature, TypeError, ValueError):
            supplied = None
        if supplied != expected:
            raise WeeklyReportError(
                "report_revision_conflict", "Report, body or approval state changed; prepare again.", 409
            )

    def audit(self, action, operation, **extra):
        return record_audit_event(
            workspace=self.workspace,
            actor=self.user,
            action="report.mcp.operation." + action,
            resource_type="report_agent_operation",
            resource_id=operation.pk,
            metadata={
                "operation_id": str(operation.pk),
                "grant_id": str(self.grant.pk),
                "agent_label": self.grant.label,
                "source_system": "MCP",
                "actor_type": "AGENT",
                "authorization_source": "agent_client",
                "action": operation.action,
                "period_key": operation.period_key,
                "proposal_hash": operation.proposal_hash,
                **extra,
            },
        )

    def environment(self, period_key):
        zone = report_timezone_for(self.workspace)
        allowed_keys = [period_for_offset("WEEKLY", offset, zone)[0] for offset in (-1, 0)]
        try:
            key, start, end = parse_period("WEEKLY", period_key, zone)
        except InvalidPeriod:
            raise WeeklyReportError("report_period_denied", "Invalid weekly period.", 403) from None
        if key != period_key or key not in allowed_keys:
            raise WeeklyReportError("report_period_denied", "Only the current and previous week are allowed.", 403)
        context = workflow.resolve_report_context(
            workspace=self.workspace, actor=self.user, payload={"period_key": key}
        )
        if context.report_org_unit is None:
            raise WeeklyReportError("report_org_required", "A primary organisation assignment is required.", 403)
        report = (
            workflow.report_queryset(self.workspace)
            .filter(owner=self.user, report_type="WEEKLY", period_key=key)
            .first()
        )
        if report and report.owner_id != self.user.pk:
            raise WeeklyReportError("report_owner_denied", "Only your own report may be changed.", 403)
        template_body = (
            document_body(context.template_content)
            if context.template
            else {field: normalize_body(FALLBACK)[field] for field in BODY_FIELDS}
        )
        template = {
            "id": str(context.template.pk) if context.template else None,
            "version": digest(
                {"template": row_data(context.template) if context.template else None, "resolved": template_body}
            ),
            "is_fallback": context.template is None,
        }
        visibility = effective_report_visibility(report) if report else context.requested_visibility
        ceiling = default_visibility_for(
            "WEEKLY", self.workspace, report.org_unit if report else context.report_org_unit
        )
        own_actions = {"save_draft", "submit"}
        actions = sorted(own_actions & set(self.grant.allowed_actions)) if not report or is_editable(report) else []
        org_unit_id = report.org_unit_id if report else context.report_org_unit.pk
        audience = {
            "workspace_id": str(self.workspace.pk),
            "org_unit_id": str(org_unit_id),
            "direct_advisor_ids": sorted(
                str(pk) for pk in direct_advisor_ids(self.user.pk, self.workspace.pk, org_unit_id)
            ),
            "custom_grants": active_grants(report) if report else [],
        }
        notification_report = report or db.PeriodicReport(
            workspace=self.workspace,
            owner=self.user,
            org_unit=context.report_org_unit,
            project=context.profile.project if context.profile else None,
        )
        reviewer_ids = sorted(str(reviewer.pk) for reviewer in report_reviewer_ids(notification_report))
        approval = approval_route_payload("PERIODIC_REPORT", notification_report, self.user)
        if len(reviewer_ids) > 1000:
            raise WeeklyReportError("response_too_large", "Too many notification recipients.", 413)
        summary = f"Visibility: {visibility}; policy ceiling: {ceiling}; scope: {canonical(audience)}"
        if len(summary) > 2000:
            raise WeeklyReportError(
                "response_too_large", "The effective audience exceeds the proposal display limit.", 413
            )
        policy = {
            "version": PERIOD_POLICY,
            "allowed_period_keys": allowed_keys,
            "allowed_actions": actions,
            "effective_visibility": visibility,
            "audience_summary": summary,
        }
        policy_state = {}
        policy_state["notification_recipients"] = reviewer_ids
        actor = build_actor_context(self.user, self.workspace.pk)
        policy_state["effective_actor"] = {
            key: sorted(str(item) for item in value) if isinstance(value, (set, frozenset)) else value
            for key, value in vars(actor).items()
        }
        for model in POLICY_MODELS:
            fields = {f.name for f in model._meta.fields}
            if "workspace" in fields:
                queryset = model.objects.filter(workspace=self.workspace)
            elif "report" in fields:
                queryset = model.objects.filter(report__workspace=self.workspace)
            else:
                continue
            policy_state[model.__name__] = rows(queryset)
        # Account, private-workspace admission and instance admin changes also
        # invalidate a proposal. No secrets or complete rows leave this hash.
        from plane.license.models import InstanceAdmin, InstanceRoleAssignment

        policy_state["instance_admin"] = rows(InstanceAdmin.objects.filter(user=self.user))
        policy_state["instance_roles"] = rows(InstanceRoleAssignment.objects.filter(user=self.user))
        policy_state["accounts"] = list(
            db.User.objects.filter(member_workspace__workspace=self.workspace)
            .order_by("pk")
            .values("id", "is_active", "display_name", "first_name", "last_name")
        )
        policy_state["workspace"] = row_data(self.workspace)
        policy_state["template"] = template
        policy["policy_hash"] = digest(
            {"state": policy_state, "policy": policy, "grant_actions": self.grant.allowed_actions}
        )
        report_state = None
        report_content = None
        if report:
            page = report.page
            report_content = {field: getattr(page, field) for field in BODY_FIELDS}
            if not is_editable(report):
                snapshot = report.official_snapshots.order_by("-version_no").first()
                report_content = (
                    {field: getattr(snapshot, field) for field in BODY_FIELDS} if snapshot else report_content
                )
            report_state = {
                "report": row_data(report),
                "page": row_data(page),
                "attachments": rows(db.ReportAttachment.objects.filter(report=report)),
                "images": rows(db.FileAsset.objects.filter(workspace=self.workspace, entity_identifier=str(report.pk))),
                "assets": rows(db.FileAsset.objects.filter(research_report_attachments__report=report)),
                "snapshots": rows(db.PeriodicReportSnapshot.objects.filter(report=report)),
            }
        state_hash = digest({"binding": self.binding(key), "policy": policy, "report": report_state})
        return {
            "context": context,
            "report": report,
            "period": {"report_type": "WEEKLY", "key": key, "start": str(start), "end": str(end), "timezone": zone},
            "policy": policy,
            "template": template,
            "state_hash": state_hash,
            "content": {"template_content": template_body, "report_content": report_content},
            "reviewer_ids": reviewer_ids,
            "approval": approval,
        }

    def check_revision(self, revision, env):
        try:
            value = signing.loads(revision, salt=REVISION_SALT, max_age=900)
            if value != {**self.binding(env["period"]["key"]), "state_hash": env["state_hash"]}:
                raise ValueError()
        except (signing.BadSignature, ValueError, TypeError):
            raise WeeklyReportError(
                "report_revision_conflict", "Report, body, membership or policy changed; prepare again.", 409
            ) from None

    @transaction.atomic
    def get_weekly_report_context(self, period_offset=None, period_key=None, cursor=None):
        consistency_barrier()
        self.authenticate()
        if period_key is None:
            period_key = period_for_offset("WEEKLY", period_offset, report_timezone_for(self.workspace))[0]
        env = self.environment(period_key)
        revision = signing.dumps({**self.binding(period_key), "state_hash": env["state_hash"]}, salt=REVISION_SALT)
        text = canonical(env["content"])
        if len(text.encode()) > 2 * 1024 * 1024:
            raise WeeklyReportError("body_too_large", "Existing template/report content exceeds the context limit.")
        stream_hash, offset = digest(env["content"]), 0
        binding = {**self.binding(period_key), "state_hash": env["state_hash"], "body_hash": stream_hash}
        if cursor:
            try:
                position = signing.loads(cursor, salt=CURSOR_SALT, max_age=900)
                offset = position.pop("offset")
                if type(offset) is not int or not 0 <= offset <= len(text):
                    raise ValueError()
                if position != binding:
                    raise WeeklyReportError(
                        "report_revision_conflict", "Content changed while paging; restart context.", 409
                    )
            except (signing.BadSignature, ValueError, KeyError, TypeError):
                raise WeeklyReportError("invalid_cursor", "Invalid, expired or out-of-scope content cursor.") from None
        end = min(offset + 8000, len(text))
        next_cursor = signing.dumps({**binding, "offset": end}, salt=CURSOR_SALT) if end < len(text) else None
        report = env["report"]
        return {
            "contract_version": VERSION,
            "identity": self.identity(),
            "period": env["period"],
            "policy": env["policy"],
            "template": env["template"],
            "revision": revision,
            "report": {
                "id": str(report.pk),
                "status": report.status,
                "official_version": report.official_snapshots.order_by("-version_no")
                .values_list("version_no", flat=True)
                .first()
                or 0,
                "url": report_url(self.workspace, report.pk),
            }
            if report
            else None,
            "content_page": {
                "encoding": "utf-8-json",
                "text": text[offset:end],
                "offset": offset,
                "total_chars": len(text),
                "body_hash": stream_hash,
                "next_cursor": next_cursor,
                "complete": next_cursor is None,
            },
            "approval": env["approval"],
        }

    @transaction.atomic
    def list_weekly_reports(
        self,
        scope="all",
        status=None,
        period_key=None,
        owner_id=None,
        org_unit_id=None,
        query=None,
        date_from=None,
        date_to=None,
        cursor=None,
        limit=20,
    ):
        """Page weekly reports through the native visibility matrix."""
        consistency_barrier()
        self.authenticate_read()
        filters = {
            "scope": scope,
            "status": status,
            "period_key": period_key,
            "owner_id": owner_id,
            "org_unit_id": org_unit_id,
            "query": query,
            "date_from": date_from,
            "date_to": date_to,
        }
        binding = {"workspace": str(self.workspace.pk), "user": str(self.user.pk), "filters": filters}
        rows = workflow.report_queryset(self.workspace).filter(report_type="WEEKLY")
        rows = visible_reports_queryset(rows, build_actor_context(self.user, self.workspace.pk))
        if scope == "mine":
            rows = rows.filter(owner=self.user)
        elif scope == "review":
            rows = rows.filter(status="SUBMITTED").exclude(owner=self.user)
            if not is_research_admin(self.user, self.workspace.pk):
                rows = rows.filter(id__in=routed_resource_ids(self.workspace.pk, "PERIODIC_REPORT", self.user))
        if status:
            rows = rows.filter(status=status)
        if period_key:
            rows = rows.filter(period_key=period_key)
        if owner_id:
            rows = rows.filter(owner_id=owner_id)
        if org_unit_id:
            rows = rows.filter(org_unit_id=org_unit_id)
        parsed_from = parse_date(date_from) if date_from else None
        parsed_to = parse_date(date_to) if date_to else None
        if (
            (date_from and parsed_from is None)
            or (date_to and parsed_to is None)
            or (parsed_from and parsed_to and parsed_from > parsed_to)
        ):
            raise WeeklyReportError("invalid_arguments", "Invalid report date filters.")
        if parsed_from:
            rows = rows.filter(period_end__gte=parsed_from)
        if parsed_to:
            rows = rows.filter(period_start__lte=parsed_to)
        if query:
            rows = rows.filter(
                Q(page__name__icontains=query)
                | Q(period_key__icontains=query)
                | Q(owner__display_name__icontains=query)
                | Q(owner__first_name__icontains=query)
            )
        rows = rows.order_by("-period_start", "-created_at", "-pk")
        if cursor:
            try:
                state = signing.loads(cursor, salt=CURSOR_SALT, max_age=900)
                after = state.pop("after")
                if state != binding or not isinstance(after, dict):
                    raise ValueError()
                anchor_date = parse_date(after["period_start"])
                anchor_time = parse_datetime(after["created_at"])
                rows = rows.filter(
                    Q(period_start__lt=anchor_date)
                    | Q(period_start=anchor_date, created_at__lt=anchor_time)
                    | Q(period_start=anchor_date, created_at=anchor_time, pk__lt=after["id"])
                )
            except (signing.BadSignature, ValueError, KeyError, TypeError):
                raise WeeklyReportError("invalid_cursor", "Invalid or out-of-scope report cursor.") from None
        items = list(rows.select_related("workspace", "owner", "org_unit", "page", "project")[: limit + 1])
        next_cursor = None
        if len(items) > limit:
            anchor = items[limit - 1]
            next_cursor = signing.dumps(
                {
                    **binding,
                    "after": {
                        "period_start": str(anchor.period_start),
                        "created_at": anchor.created_at.isoformat(),
                        "id": str(anchor.pk),
                    },
                },
                salt=CURSOR_SALT,
            )
        return {
            "contract_version": VERSION,
            "identity": self.identity(),
            "results": [self.report_projection(item) for item in items[:limit]],
            "next_cursor": next_cursor,
        }

    @transaction.atomic
    def get_weekly_report(self, report_id, cursor=None):
        """Read one visible report and a bounded page of authorized body content."""
        consistency_barrier()
        self.authenticate_read()
        report = self.visible_report(report_id)
        content = self.report_body(report)
        revision, state_hash = self.report_revision(report, content)
        text = canonical({"report_content": content})
        stream_hash, offset = digest(content), 0
        binding = {"report": str(report.pk), "state_hash": state_hash, "body_hash": stream_hash}
        if cursor:
            try:
                position = signing.loads(cursor, salt=CURSOR_SALT, max_age=900)
                offset = position.pop("offset")
                if type(offset) is not int or not 0 <= offset <= len(text) or position != binding:
                    raise ValueError()
            except (signing.BadSignature, ValueError, KeyError, TypeError):
                raise WeeklyReportError("invalid_cursor", "Invalid, expired or out-of-scope content cursor.") from None
        end = min(offset + 8000, len(text))
        next_cursor = signing.dumps({**binding, "offset": end}, salt=CURSOR_SALT) if end < len(text) else None
        return {
            "contract_version": VERSION,
            "identity": self.identity(),
            "report": self.report_projection(report),
            "revision": revision,
            "content_page": {
                "encoding": "utf-8-json",
                "text": text[offset:end],
                "offset": offset,
                "total_chars": len(text),
                "body_hash": stream_hash,
                "next_cursor": next_cursor,
                "complete": next_cursor is None,
            },
        }

    @transaction.atomic
    def list_weekly_report_history(self, report_id, cursor=None, limit=50):
        """Page append-only review history for one visible report."""
        consistency_barrier()
        self.authenticate_read()
        report = self.visible_report(report_id)
        binding = {"workspace": str(self.workspace.pk), "user": str(self.user.pk), "report": str(report.pk)}
        rows = db.ReportReviewLog.objects.filter(report=report).select_related("actor").order_by("-created_at", "-pk")
        if cursor:
            try:
                state = signing.loads(cursor, salt=CURSOR_SALT, max_age=900)
                after = state.pop("after")
                if state != binding or not isinstance(after, str):
                    raise ValueError()
                rows = rows.filter(Q(pk__lt=after))
            except (signing.BadSignature, ValueError, KeyError, TypeError):
                raise WeeklyReportError("invalid_cursor", "Invalid or expired history cursor.") from None
        items = list(rows[: limit + 1])
        next_cursor = (
            signing.dumps({**binding, "after": str(items[limit - 1].pk)}, salt=CURSOR_SALT)
            if len(items) > limit
            else None
        )
        return {
            "contract_version": VERSION,
            "identity": self.identity(),
            "report": self.report_projection(report),
            "results": [
                {
                    "id": str(item.pk),
                    "action": item.action,
                    "from_status": item.from_status,
                    "to_status": item.to_status,
                    "comment": item.comment,
                    "snapshot_version": item.snapshot_version,
                    "actor_id": str(item.actor_id),
                    "created_at": item.created_at.isoformat(),
                }
                for item in items[:limit]
            ],
            "next_cursor": next_cursor,
        }

    def source_state(self, refs):
        if not refs:
            return []
        from plane.research.services.chain_context import CONTENT_KINDS, ResearchReadService, _json
        from plane.research.services.mcp_catalog import ResearchReadError

        reader = ResearchReadService(workspace=self.workspace, user=self.user)
        result = []
        for ref in refs:
            try:
                node = reader.node(ref["node_id"])
                obj = reader._lookup(node, ref["kind"], ref["id"])
                if obj is None or not reader._allowed(node, ref["kind"], obj):
                    raise WeeklyReportError("source_changed", "Source is not currently visible in its node.", 409)
                if ref["kind"] in CONTENT_KINDS:
                    value, version = reader._content(node, ref["kind"], obj, ref["version"])
                else:
                    value = reader._resource_data(node, ref["kind"], obj)
                    version = value.get("version") or value.get("current_version_no") if value else None
                content_hash = hashlib.sha256(_json(value).encode()).hexdigest()
                if version != ref["version"] or content_hash != ref["content_hash"]:
                    raise WeeklyReportError("source_changed", "Source version/hash changed or cannot be verified.", 409)
                result.append(
                    {
                        "ref": ref,
                        "row_hash": digest(row_data(obj)),
                        "node_hash": digest(row_data(node)),
                        "chain_hash": digest(row_data(node.chain)),
                        "content_hash": content_hash,
                    }
                )
            except ResearchReadError:
                raise WeeklyReportError(
                    "source_changed", "Source is no longer visible or its version changed.", 409
                ) from None
        return result

    def seal(self, operation):
        return digest(
            {
                "contract_version": VERSION,
                "binding": self.binding(operation.period_key),
                "request_id": operation.request_id,
                "action": operation.action,
                "payload": operation.payload,
                "expected_revision": operation.expected_revision,
                "preconditions": operation.preconditions,
                "expires_at": operation.expires_at.isoformat(),
            }
        )

    def load(self, operation_id, *, lock=False):
        query = db.ReportAgentOperation.objects
        if lock:
            query = query.select_for_update()
        operation = query.filter(pk=operation_id, workspace=self.workspace, user=self.user, grant=self.grant).first()
        if operation is None:
            raise WeeklyReportError("not_found", "Operation not found in this credential's scope.", 404)
        if operation.proposal_hash != self.seal(operation):
            raise WeeklyReportError("proposal_changed", "Immutable proposal verification failed.", 409, operation.pk)
        return operation

    def present(self, operation):
        if operation.proposal_hash != self.seal(operation):
            raise WeeklyReportError("proposal_changed", "Immutable proposal verification failed.", 409, operation.pk)
        return {
            "contract_version": VERSION,
            "operation_id": str(operation.pk),
            "request_id": operation.request_id,
            "status": operation.status,
            "action": operation.action,
            "identity": operation.payload["identity"],
            "period": operation.payload["period"],
            "report_id": str(operation.report_id) if operation.report_id else None,
            "expected_revision": operation.expected_revision,
            "proposal_hash": operation.proposal_hash,
            "expires_at": operation.expires_at.isoformat(),
            "proposal": operation.payload["proposal"],
            "result": operation.result if operation.status == "COMMITTED" else None,
            "readback": "pending" if operation.status == "COMMITTED" else "not_applicable",
            "failure": operation.failure,
        }

    @transaction.atomic
    def prepare_report_review(
        self,
        request_id,
        action,
        report_id,
        expected_revision,
        comment="",
    ):
        """Persist an immutable owner-withdrawal or routed-review proposal."""
        consistency_barrier()
        self.authenticate(action, lock=True)
        report = self.visible_report(report_id, lock=True)
        target = {"withdraw": "DRAFT", "return": "NEEDS_REVISION", "accept": "ACCEPTED"}[action]
        if not can_transition(report.status, target):
            raise WeeklyReportError("report_state_conflict", "The report status does not allow this action.", 409)
        if action == "withdraw" and report.owner_id != self.user.pk:
            raise WeeklyReportError("report_owner_denied", "Only the report owner may withdraw it.", 403)
        if action in {"return", "accept"} and not actor_can_review_route(
            self.workspace, "PERIODIC_REPORT", report.pk, self.user
        ):
            raise WeeklyReportError("scope_denied", "This report is not routed to the current reviewer.", 403)
        if action == "return" and not comment.strip():
            raise WeeklyReportError("invalid_arguments", "A reason is required when returning a report.", 422)
        content = self.report_body(report)
        self.check_report_revision(expected_revision, report, content)
        request_hash = digest(
            {"action": action, "report_id": str(report.pk), "expected_revision": expected_revision, "comment": comment}
        )
        previous = db.ReportAgentOperation.objects.filter(
            workspace=self.workspace, user=self.user, request_id=request_id
        ).first()
        if previous:
            if previous.request_hash != request_hash or previous.grant_id != self.grant.pk:
                raise WeeklyReportError("idempotency_conflict", "request_id already belongs to another proposal.", 409)
            self.expire(previous)
            return self.readback(previous) if previous.status == "COMMITTED" else self.present(previous)
        _, state_hash = self.report_revision(report, content)
        route = active_approval_route("PERIODIC_REPORT", report.pk, self.workspace.pk)
        proposal = {
            "report_id": str(report.pk),
            "comment": comment,
            "state_hash": state_hash,
            "effects": {
                "changes_status_to": target,
                "closes_approval_route": route is not None,
                "appends_review_log": True,
                "writes_audit": True,
                "creates_in_app_notifications": True,
                "changes_body": False,
            },
            "approval_route_id": str(route.pk) if route else None,
            "agent_label": self.grant.label,
        }
        operation = db.ReportAgentOperation(
            workspace=self.workspace,
            user=self.user,
            grant=self.grant,
            report=report,
            request_id=request_id,
            action=action,
            period_key=report.period_key,
            expected_revision=expected_revision,
            payload={
                "identity": self.identity(),
                "period": {
                    "report_type": "WEEKLY",
                    "key": report.period_key,
                    "start": str(report.period_start),
                    "end": str(report.period_end),
                    "timezone": report.timezone,
                },
                "proposal": proposal,
            },
            preconditions={"state_hash": state_hash},
            request_hash=request_hash,
            expires_at=min(
                timezone.now() + timedelta(minutes=15), self.grant.expires_at or timezone.now() + timedelta(minutes=15)
            ),
        )
        operation.proposal_hash = self.seal(operation)
        self.bounded(self.present(operation))
        operation.save()
        self.audit("prepare", operation)
        return self.present(operation)

    @transaction.atomic
    def prepare_weekly_report_operation(
        self,
        request_id,
        action,
        period_key=None,
        expected_revision=None,
        body_markdown=None,
        source_refs=None,
        reviewer_id=None,
        cc_user_ids=None,
        report_id=None,
        comment=None,
    ):
        if action in {"withdraw", "return", "accept"}:
            return self.prepare_report_review(
                request_id=request_id,
                action=action,
                report_id=report_id,
                expected_revision=expected_revision,
                comment=comment or "",
            )
        refs = source_refs or []
        consistency_barrier(sources=bool(refs))
        self.authenticate(action, lock=True)
        request_hash = digest(
            {
                "action": action,
                "period_key": period_key,
                "expected_revision": expected_revision,
                "body_markdown": body_markdown,
                "source_refs": refs,
                "reviewer_id": reviewer_id,
                "cc_user_ids": cc_user_ids or [],
            }
        )
        previous = db.ReportAgentOperation.objects.filter(
            workspace=self.workspace, user=self.user, request_id=request_id
        ).first()
        if previous:
            if previous.request_hash != request_hash or previous.grant_id != self.grant.pk:
                raise WeeklyReportError("idempotency_conflict", "request_id already belongs to another proposal.", 409)
            self.expire(previous)
            return self.readback(previous) if previous.status == "COMMITTED" else self.present(previous)
        env = self.environment(period_key)
        self.check_revision(expected_revision, env)
        if action not in env["policy"]["allowed_actions"]:
            raise WeeklyReportError(
                "report_already_submitted", "A submitted/accepted report cannot be overwritten.", 409
            )
        normalized = normalize_body(body_markdown)
        source_state = self.source_state(refs)
        report = env["report"]
        approval_selection = None
        if action == "submit":
            approval_resource = report or db.PeriodicReport(
                workspace=self.workspace,
                owner=self.user,
                org_unit=env["context"].report_org_unit,
                project=env["context"].profile.project if env["context"].profile else None,
            )
            try:
                approval_selection = validate_route_selection(
                    "PERIODIC_REPORT", approval_resource, self.user, reviewer_id, cc_user_ids or []
                )
            except ApprovalRouteError as error:
                raise WeeklyReportError(error.error_code, error.message, 422) from error
        old = env["content"]["report_content"]
        delta = list(
            ndiff(
                (old["description_stripped"] or "").splitlines() if old else [],
                normalized["description_stripped"].splitlines(),
            )
        )
        proposal = {
            "normalized_body": normalized,
            "template": env["template"],
            "policy": env["policy"],
            "source_refs": [
                {
                    **ref,
                    "note": ref.get("note"),
                    "verification": "visible_version_checked",
                    "read_evidence": "declared_only",
                }
                for ref in refs
            ],
            "diff": {
                "previous_body_hash": body_hash(old) if old else None,
                "proposed_body_hash": normalized["body_hash"],
                "added_lines": sum(line.startswith("+ ") for line in delta),
                "removed_lines": sum(line.startswith("- ") for line in delta),
                "summary": "Replace the draft body with the complete normalized body shown in this proposal.",
            },
            "effects": {
                "creates_report": report is None,
                "saves_draft": action == "save_draft",
                "changes_status_to": "SUBMITTED" if action == "submit" else report.status if report else "DRAFT",
                "appends_official_snapshot": action == "submit",
                "appends_review_log": action == "submit",
                "writes_audit": True,
                "creates_in_app_notifications": action == "submit" and approval_selection is not None,
                "approval": (
                    {
                        "reviewer_id": approval_selection["reviewer_id"],
                        "reviewer_role": approval_selection["reviewer_role"],
                        "cc_user_ids": approval_selection["cc_user_ids"],
                    }
                    if approval_selection
                    else None
                ),
                "external_delivery": "none",
            },
            "approval": (
                {
                    "reviewer_id": approval_selection["reviewer_id"],
                    "reviewer_role": approval_selection["reviewer_role"],
                    "cc_user_ids": approval_selection["cc_user_ids"],
                }
                if approval_selection
                else None
            ),
            "agent_label": self.grant.label,
        }
        operation = db.ReportAgentOperation(
            workspace=self.workspace,
            user=self.user,
            grant=self.grant,
            report=report,
            request_id=request_id,
            action=action,
            period_key=period_key,
            expected_revision=expected_revision,
            payload={"identity": self.identity(), "period": env["period"], "proposal": proposal},
            preconditions={"state_hash": env["state_hash"], "sources": source_state},
            request_hash=request_hash,
            expires_at=min(
                timezone.now() + timedelta(minutes=15),
                self.grant.expires_at or timezone.now() + timedelta(minutes=15),
            ),
        )
        operation.proposal_hash = self.seal(operation)
        # Reject oversized prepared responses before creating even an operation.
        self.bounded(self.present(operation))
        operation.save()
        self.audit("prepare", operation)
        return self.present(operation)

    def expire(self, operation):
        if operation.status == "PROPOSED" and operation.expires_at <= timezone.now():
            operation.status = "EXPIRED"
            operation.failure = {"error_code": "proposal_expired", "message": "The proposal expired; prepare again."}
            operation.save(update_fields=["status", "failure", "updated_at"])

    @transaction.atomic
    def get_weekly_report_operation(self, operation_id):
        self.authenticate()
        operation = self.load(operation_id, lock=True)
        self.expire(operation)
        return self.readback(operation) if operation.status == "COMMITTED" else self.present(operation)

    @transaction.atomic
    def cancel_weekly_report_operation(self, operation_id):
        self.authenticate()
        operation = self.load(operation_id, lock=True)
        self.expire(operation)
        if operation.status == "PROPOSED":
            operation.status = "CANCELLED"
            operation.save(update_fields=["status", "updated_at"])
            self.audit("cancel", operation)
        return self.readback(operation) if operation.status == "COMMITTED" else self.present(operation)

    def execute_report_review(self, operation):
        """Commit one already-authorized withdrawal or routed review proposal."""
        report = self.visible_report(operation.report_id, lock=True)
        action = operation.action
        proposal = operation.payload["proposal"]
        target = {"withdraw": "DRAFT", "return": "NEEDS_REVISION", "accept": "ACCEPTED"}[action]
        if not can_transition(report.status, target):
            raise WeeklyReportError("report_state_conflict", "The report status does not allow this action.", 409)
        if action == "withdraw" and report.owner_id != self.user.pk:
            raise WeeklyReportError("report_owner_denied", "Only the report owner may withdraw it.", 403)
        if action in {"return", "accept"} and not actor_can_review_route(
            self.workspace, "PERIODIC_REPORT", report.pk, self.user
        ):
            raise WeeklyReportError("scope_denied", "This report is not routed to the current reviewer.", 403)
        content = self.report_body(report)
        revision, state_hash = self.report_revision(report, content)
        self.check_report_revision(operation.expected_revision, report, content)
        if state_hash != operation.preconditions["state_hash"]:
            raise WeeklyReportError("report_revision_conflict", "Report state changed; prepare again.", 409)
        comment = str(proposal.get("comment") or "")
        if action == "return" and not comment.strip():
            raise WeeklyReportError("invalid_arguments", "A reason is required when returning a report.", 422)
        previous = report.status
        route = close_active_route("PERIODIC_REPORT", report.pk, self.workspace.pk, self.user)
        report.status = target
        if action == "withdraw":
            report.submitted_at = None
            report.accepted_at = None
            report.reviewer = None
        elif action == "accept":
            report.accepted_at = timezone.now()
            report.reviewer = self.user
        else:
            report.reviewer = self.user
        report.save(
            update_fields=["status", "submitted_at", "accepted_at", "reviewer", "updated_at"]
            if action == "withdraw"
            else ["status", "accepted_at", "reviewer", "updated_at"]
        )
        snapshot_version = (
            report.official_snapshots.order_by("-version_no").values_list("version_no", flat=True).first()
        )
        db.ReportReviewLog.objects.create(
            report=report,
            actor=self.user,
            action={
                "withdraw": db.ReportReviewLog.Action.REOPEN,
                "return": db.ReportReviewLog.Action.RETURN,
                "accept": db.ReportReviewLog.Action.ACCEPT,
            }[action],
            from_status=previous,
            to_status=target,
            comment=comment,
            snapshot_version=str(snapshot_version) if snapshot_version is not None else None,
        )
        audit = self.audit("commit", operation, report_id=str(report.pk), review_action=action)
        business_audit = record_audit_event(
            workspace=self.workspace,
            actor=self.user,
            action={
                "withdraw": ResearchAuditAction.REPORT_WITHDRAW,
                "return": ResearchAuditAction.REPORT_RETURN,
                "accept": ResearchAuditAction.REPORT_ACCEPT,
            }[action],
            resource_type=ResearchResourceType.REPORT,
            resource_id=report.pk,
            org_unit=report.org_unit,
            metadata={
                "period_key": report.period_key,
                "report_type": report.report_type,
                "snapshot_version": snapshot_version,
                "approval_route": str(route.pk) if route else None,
                "operation_id": str(operation.pk),
            },
        )
        notifications = {
            "withdraw": lambda: notify_report_withdrawn(report, self.user, comment, route=route),
            "return": lambda: notify_report_returned(report, self.user, comment, route=route),
            "accept": lambda: notify_report_accepted(report, self.user, route=route),
        }[action]()
        if len(notifications) > 1000:
            raise WeeklyReportError("response_too_large", "Too many notification recipients.", 413)
        operation.result = {
            "report_id": str(report.pk),
            "period": operation.payload["period"],
            "status": report.status,
            "snapshot_version": snapshot_version,
            "report_url": report_url(self.workspace, report.pk),
            "operation_audit_id": str(audit.pk),
            "business_audit_id": str(business_audit.pk),
            "committed_at": timezone.now().isoformat(),
            "notification_record_ids": [str(item.pk) for item in notifications],
            "approval_route_id": str(route.pk) if route else None,
            "reviewer_id": str(self.user.pk) if action != "withdraw" else None,
        }
        operation.status = "COMMITTED"
        operation.save(update_fields=["result", "status", "updated_at"])
        return operation

    def execute_weekly_report_operation(self, operation_id):
        try:
            with transaction.atomic():
                # Take the barrier first to avoid upgrading a table while a
                # competing operation already holds a report row. Operation and
                # grant row locks follow; all new entry points use this order.
                refs = (
                    db.ReportAgentOperation.objects.filter(pk=operation_id, grant=self.grant)
                    .values_list("payload", flat=True)
                    .first()
                )
                consistency_barrier(sources=bool(refs and refs.get("proposal", {}).get("source_refs")))
                self.authenticate(lock=True)
                operation = self.load(operation_id, lock=True)
                self.expire(operation)
                if operation.status != "PROPOSED":
                    return self.readback(operation) if operation.status == "COMMITTED" else self.present(operation)
                self.authenticate(operation.action, lock=True)
                if operation.action in {"withdraw", "return", "accept"}:
                    operation = self.execute_report_review(operation)
                    return self.readback(operation)
                env = self.environment(operation.period_key)
                self.check_revision(operation.expected_revision, env)
                if operation.action not in env["policy"]["allowed_actions"]:
                    raise WeeklyReportError("report_already_submitted", "The report is no longer editable.", 409)
                refs = [
                    {k: v for k, v in ref.items() if k not in {"verification", "read_evidence"}}
                    for ref in operation.payload["proposal"]["source_refs"]
                ]
                # Optional notes have a stable null representation in responses.
                for ref in refs:
                    if ref.get("note") is None:
                        ref.pop("note", None)
                if self.source_state(refs) != operation.preconditions["sources"]:
                    raise WeeklyReportError("source_changed", "Source content or visibility changed.", 409)
                report = env["report"] or workflow.create_report_draft(
                    workspace=self.workspace, actor=self.user, payload={"period_key": operation.period_key}
                )
                if report.owner_id != self.user.pk:
                    raise WeeklyReportError("report_owner_denied", "Only your own report may be changed.", 403)
                proposed = operation.payload["proposal"]["normalized_body"]
                payload = {field: proposed[field] for field in BODY_FIELDS if field != "description_stripped"}
                payload["description_binary"] = ""
                if operation.action == "submit":
                    approval = operation.payload["proposal"]["approval"]
                    payload.update(
                        reviewer_id=approval["reviewer_id"],
                        cc_user_ids=approval["cc_user_ids"],
                    )
                    report = workflow.submit_report(
                        workspace=self.workspace, actor=self.user, report_id=report.pk, payload=payload
                    )
                    snapshot = report.official_snapshots.order_by("-version_no").first()
                    version = snapshot.version_no
                else:
                    report = workflow.save_report_body(
                        workspace=self.workspace, actor=self.user, report_id=report.pk, payload=payload
                    )
                    version = None
                saved = {field: getattr(report.page, field) for field in BODY_FIELDS}
                if body_hash(saved) != proposed["body_hash"] or report.page.description_binary is not None:
                    raise WeeklyReportError("body_changed", "Saved body differs from the authorized proposal.", 409)
                audit = self.audit(
                    "commit",
                    operation,
                    report_id=str(report.pk),
                    snapshot_version=version,
                    source_refs=operation.payload["proposal"]["source_refs"],
                )
                notifications = getattr(report, "_workflow_notifications", [])
                if len(notifications) > 1000:
                    raise WeeklyReportError("response_too_large", "Too many notification recipients.", 413)
                operation.report = report
                operation.result = {
                    "report_id": str(report.pk),
                    "period": operation.payload["period"],
                    "status": report.status,
                    "snapshot_version": version,
                    "body_hash": proposed["body_hash"],
                    "report_url": report_url(self.workspace, report.pk),
                    "audit_id": str(audit.pk),
                    "committed_at": timezone.now().isoformat(),
                    "notification_record_ids": [str(item.pk) for item in notifications],
                    "approval_route_id": (
                        str(report._workflow_approval_route.pk) if operation.action == "submit" else None
                    ),
                    "reviewer_id": (
                        str(report._workflow_approval_route.reviewer_id) if operation.action == "submit" else None
                    ),
                }
                operation.status = "COMMITTED"
                operation.save(update_fields=["report", "result", "status", "updated_at"])
        except (WeeklyReportError, workflow.ReportWorkflowError) as error:
            if isinstance(error, workflow.ReportWorkflowError):
                error = WeeklyReportError(
                    error.data.get("error_code", "report_state_conflict"),
                    error.data.get("message", "Report body validation failed."),
                    error.status_code,
                )
            # The business transaction has rolled back before a rejection is
            # persisted. A revoked token still cannot query an operation.
            with transaction.atomic():
                rejected = (
                    db.ReportAgentOperation.objects.select_for_update()
                    .filter(
                        pk=operation_id, grant=self.grant, user=self.user, workspace=self.workspace, status="PROPOSED"
                    )
                    .first()
                )
                if rejected:
                    rejected.status = "REJECTED"
                    rejected.failure = {"error_code": error.code, "message": str(error)}
                    rejected.save(update_fields=["status", "failure", "updated_at"])
            error.operation_id = operation_id
            raise error from None
        # No exception after the business commit may turn it into a failed write.
        return self.readback(operation)

    def readback(self, operation):
        value = self.present(operation)
        try:
            result = operation.result
            if "body_hash" not in result:
                report = db.PeriodicReport.objects.filter(pk=result["report_id"]).first()
                value["readback"] = (
                    "verified" if report is not None and report.status == result["status"] else "pending"
                )
                return value
            if result["snapshot_version"] is not None:
                target = db.PeriodicReportSnapshot.objects.get(
                    report_id=result["report_id"], version_no=result["snapshot_version"]
                )
                current = {field: getattr(target, field) for field in BODY_FIELDS}
                if body_hash(current) == result["body_hash"]:
                    value["readback"] = "verified"
            else:
                # Drafts are mutable; the durable historical result remains true
                # even if a later edit means its body can no longer be verified.
                target = db.PeriodicReport.objects.select_related("page").get(pk=result["report_id"])
                if body_hash({field: getattr(target.page, field) for field in BODY_FIELDS}) == result["body_hash"]:
                    value["readback"] = "verified"
        except Exception:
            value["readback"] = "pending"
        return value

    @staticmethod
    def bounded(value):
        if len(canonical(value).encode()) > 2 * 1024 * 1024:
            raise WeeklyReportError("response_too_large", "Response exceeds the 2 MiB limit.", 413)
        return value

    def execute(self, name, arguments):
        args = validate(name, arguments)
        try:
            self.authenticate()
            value = getattr(self, name)(**args)
            return self.bounded(value)
        except workflow.ReportWorkflowError as error:
            raise WeeklyReportError(
                error.data.get("error_code", "report_state_conflict"),
                error.data.get("message", "Report body validation failed."),
                error.status_code,
            ) from None
        except DatabaseError:
            raise WeeklyReportError(
                "temporarily_unavailable",
                "Database contention or outage; recover the same request/operation.",
                503,
                args.get("operation_id"),
            ) from None
