"""Fixed proposals, live authorization, atomic commits and durable result recovery."""

import hashlib
from datetime import timedelta
from difflib import ndiff

from django.conf import settings
from django.core import signing
from django.db import DatabaseError, transaction
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
from plane.research.utils.audit import record_audit_event
from plane.research.utils.notifications import report_reviewer_ids
from plane.research.utils.acl import build_actor_context, direct_advisor_ids
from plane.research.utils.periods import InvalidPeriod, parse_period, period_for_offset
from plane.research.utils.reports import active_grants, effective_report_visibility, is_editable
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
        actions = sorted(self.grant.allowed_actions) if not report or is_editable(report) else []
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
    def prepare_weekly_report_operation(
        self, request_id, action, period_key, expected_revision, body_markdown, source_refs=None
    ):
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
                "creates_in_app_notifications": action == "submit" and bool(env["reviewer_ids"]),
                "external_delivery": "none",
            },
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
            expires_at=min(timezone.now() + timedelta(minutes=15), self.grant.expires_at),
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
