"""Direct administrative writes through native serializers/shared saves.

Only create/comment have durable commit receipts. No proposal or approval layer.
"""

import hashlib
import json

from crum import impersonate
from django.core.serializers.json import DjangoJSONEncoder
from django.db import DatabaseError, IntegrityError, transaction
from django.utils import timezone
from rest_framework.exceptions import PermissionDenied, ValidationError

from plane.app.serializers import IssueCommentSerializer, IssueCreateSerializer, IssueDetailSerializer
from plane.db.models import Project, UnifiedMCPConnection, UnifiedMCPWriteResult
from plane.mcp.catalog import ADMIN_SCHEMAS, validate
from plane.mcp.reading import VERSION, UnifiedReadService
from plane.research.services.mcp_catalog import ResearchReadError
from plane.research.utils.audit import record_audit_event
from plane.utils.issue_mutations import issue_action_allowed, save_issue, save_issue_comment


def digest(value):
    return hashlib.sha256(
        json.dumps(value, sort_keys=True, ensure_ascii=False, default=str, separators=(",", ":")).encode()
    ).hexdigest()


def issue_snapshot(issue):
    return {
        "name": issue.name,
        "description_hash": digest(issue.description_html),
        "priority": issue.priority,
        "state_id": str(issue.state_id) if issue.state_id else None,
        "assignee_ids": sorted(str(pk) for pk in issue.assignees.values_list("pk", flat=True)),
        "start_date": issue.start_date.isoformat() if issue.start_date else None,
        "target_date": issue.target_date.isoformat() if issue.target_date else None,
    }


class UnifiedWriteError(ResearchReadError):
    def __init__(self, code, message, status=400, details=None):
        super().__init__(code, message, status)
        self.details = details or {}


class UnifiedWriteService:
    def __init__(self, connection, request):
        self.connection, self.request = connection, request

    def execute(self, name, arguments):
        args = validate(name, arguments)
        if name not in ADMIN_SCHEMAS:
            raise ResearchReadError("invalid_arguments", "Not an administrative write/result tool.")
        try:
            if name == "plane_get_write_result":
                return self.get_result(args)
            with transaction.atomic():
                connection = (
                    UnifiedMCPConnection.objects.select_related("owner")
                    .select_for_update(of=("self",))
                    .filter(
                        pk=self.connection.pk,
                        owner__is_active=True,
                        revoked_at__isnull=True,
                        expires_at__gt=timezone.now(),
                    )
                    .first()
                )
                if connection is None:
                    raise ResearchReadError("scope_denied", "Connection is no longer valid.", 403)
                self.connection = connection
                self.reader = UnifiedReadService(connection)
                reference = args.get("parent", args.get("target"))
                workspace, kind, target = self.reader.resolve(reference)
                entry = next(
                    entry for entry in connection.scope["workspaces"] if entry["workspace_id"] == str(workspace.pk)
                )
                if entry["domains"].get("administrative") != "read_write":
                    raise ResearchReadError(
                        "scope_denied", "This connection is read-only for administrative tasks.", 403
                    )
                if not connection.scope["include_future_objects"]:
                    raise ResearchReadError("scope_denied", "Administrative writes require dynamic scope.", 403)
                project_id = target.pk if kind == "Project" else target.project_id
                project = (
                    Project.objects.select_for_update()
                    .filter(pk=project_id, workspace=workspace, archived_at__isnull=True)
                    .first()
                )
                if project is None:
                    raise ResearchReadError("not_found", "Active project not found.", 404)
                if kind == "Issue":
                    target = self.reader.issues(workspace).select_for_update(of=("self",)).filter(pk=target.pk).first()
                    if target is None:
                        raise ResearchReadError("not_found", "Task not found in current scope.", 404)
                    target.project = project
                action = (
                    "create" if name == "plane_create_task" else "comment" if name == "plane_add_comment" else "update"
                )
                if not issue_action_allowed(connection.owner, project, action, target if kind == "Issue" else None):
                    raise ResearchReadError(
                        "permission_denied", "Current native task permissions do not allow this action.", 403
                    )
                request_hash = digest(
                    {
                        "tool": name,
                        "workspace": str(workspace.pk),
                        "target": str(target.pk),
                        "type": kind,
                        "arguments": {
                            key: value for key, value in args.items() if key not in {"request_id", "parent", "target"}
                        },
                    }
                )
                receipt = None
                if "request_id" in args:
                    receipt = UnifiedMCPWriteResult.all_objects.filter(
                        connection=connection, workspace=workspace, request_id=args["request_id"]
                    ).first()
                    if receipt is not None:
                        if receipt.deleted_at or receipt.request_hash != request_hash or receipt.tool != name:
                            raise ResearchReadError(
                                "idempotency_conflict", "request_id was used for a different write.", 409
                            )
                with impersonate(connection.owner):
                    if receipt is None:
                        if name == "plane_create_task":
                            payload = {key: value for key, value in args.items() if key not in {"parent", "request_id"}}
                            if kind == "Issue":
                                payload["parent_id"] = str(target.pk)
                            serializer = IssueCreateSerializer(
                                data=payload,
                                context={
                                    "project_id": project.pk,
                                    "workspace_id": workspace.pk,
                                    "default_assignee_id": project.default_assignee_id,
                                    "actor": connection.owner,
                                },
                            )
                            serializer.is_valid(raise_exception=True)
                            changed = save_issue(
                                serializer=serializer, project=project, actor=connection.owner, request=self.request
                            )
                            committed = issue_snapshot(changed)
                            receipt = self.receipt(
                                workspace,
                                args["request_id"],
                                name,
                                request_hash,
                                changed,
                                "Issue",
                                changed.pk,
                                committed,
                            )
                        elif name == "plane_add_comment":
                            serializer = IssueCommentSerializer(
                                data={"comment_html": args["comment_html"], "attachment_ids": []},
                                context={"request": self.request, "attachment_issue": target},
                            )
                            serializer.is_valid(raise_exception=True)
                            changed = save_issue_comment(
                                serializer=serializer, issue=target, actor=connection.owner, request=self.request
                            )
                            receipt = self.receipt(
                                workspace,
                                args["request_id"],
                                name,
                                request_hash,
                                target,
                                "IssueComment",
                                changed.pk,
                                {"comment_hash": digest(changed.comment_html)},
                            )
                        else:
                            payload = args["changes"] if name == "plane_update_task" else {"state_id": args["state_id"]}
                            previous = json.dumps(IssueDetailSerializer(target).data, cls=DjangoJSONEncoder)
                            before = issue_snapshot(target)
                            serializer = IssueCreateSerializer(
                                target,
                                data=payload,
                                partial=True,
                                context={
                                    "project_id": project.pk,
                                    "workspace_id": workspace.pk,
                                    "actor": connection.owner,
                                },
                            )
                            serializer.is_valid(raise_exception=True)
                            # Repeating an absolute assignment/state edit need not emit duplicate effects.
                            identical = all(
                                before.get(key) == value for key, value in payload.items() if key != "description_html"
                            ) and (
                                "description_html" not in payload
                                or target.description_html == serializer.validated_data["description_html"]
                            )
                            if not identical:
                                target = save_issue(
                                    serializer=serializer,
                                    project=project,
                                    actor=connection.owner,
                                    request=self.request,
                                    previous=previous,
                                )
                            committed = issue_snapshot(target)
                        record_audit_event(
                            workspace=workspace,
                            actor=connection.owner,
                            action="mcp.write",
                            resource_type="unified_mcp_connection",
                            resource_id=connection.pk,
                            metadata={
                                "tool": name,
                                "request_id": args.get("request_id"),
                                "project_id": str(project.pk),
                                "issue_id": str(receipt.issue_id if receipt is not None else target.pk),
                            },
                        )
            if receipt is not None:
                return self.present(receipt)
            return self.present_update(workspace, target, committed)
        except ValidationError as exc:
            raise UnifiedWriteError(
                "invalid_arguments",
                "Native task validation rejected the write.",
                422,
                {"field_errors": exc.detail, "write_outcome": "rolled_back"},
            ) from None
        except PermissionDenied:
            raise ResearchReadError("permission_denied", "Current native task permission was denied.", 403) from None
        except IntegrityError:
            raise UnifiedWriteError(
                "state_conflict",
                "A native database constraint rejected this write.",
                409,
                {"write_outcome": "rolled_back"},
            ) from None
        except DatabaseError:
            raise UnifiedWriteError(
                "write_unavailable",
                (
                    "Write outcome is uncertain; look up the same request_id before retrying."
                    if args.get("request_id")
                    else "Edit outcome is uncertain; read the current task before deciding whether to retry."
                ),
                503,
                {"request_id": args.get("request_id"), "write_outcome": "unknown"},
            ) from None

    def receipt(self, workspace, request_id, tool, request_hash, issue, object_type, object_id, result):
        return UnifiedMCPWriteResult.objects.create(
            connection=self.connection,
            workspace=workspace,
            request_id=request_id,
            tool=tool,
            request_hash=request_hash,
            issue_id=issue.pk,
            object_type=object_type,
            object_id=object_id,
            result=result,
        )

    def get_result(self, args):
        from plane.mcp.authorization import active_connection

        current = active_connection(self.connection.pk)
        if current is None:
            raise ResearchReadError("scope_denied", "Connection is no longer valid.", 403)
        self.connection = current
        self.reader = UnifiedReadService(current)
        workspace = self.reader.workspace(args["workspace_slug"])
        receipt = UnifiedMCPWriteResult.objects.filter(
            connection=current, workspace=workspace, request_id=args["request_id"]
        ).first()
        if receipt is None:
            raise ResearchReadError("not_found", "No committed result found; retry only with the same request_id.", 404)
        return self.present(receipt, strict=True)

    def present(self, receipt, strict=False):
        result = {
            "schema_version": VERSION,
            "status": "COMMITTED",
            "execution_mode": "direct",
            "request_id": receipt.request_id,
            "readback": "pending",
            "data": None,
        }
        try:
            from plane.mcp.authorization import active_connection

            current = active_connection(self.connection.pk)
            if current is None:
                raise ResearchReadError("scope_denied", "Connection is no longer valid.", 403)
            self.reader = UnifiedReadService(current)
            workspace = receipt.workspace
            reference = {
                "domain": "administrative",
                "object_type": "Issue",
                "workspace_slug": workspace.slug,
                "id": str(receipt.issue_id),
            }
            _, _, issue = self.reader.resolve(reference)
            if receipt.object_type == "Issue":
                data = self.reader.issue_data(issue, workspace)
                snapshot = issue_snapshot(issue)
            else:
                comment = self.reader.comments(issue).filter(pk=receipt.object_id).first()
                if comment is None:
                    raise ResearchReadError("not_found", "Comment is no longer readable.", 404)
                data = self.reader.comment_data(comment, workspace)
                snapshot = {"comment_hash": digest(comment.comment_html)}
            result.update(
                object_type=receipt.object_type,
                object_id=str(receipt.object_id),
                issue_id=str(receipt.issue_id),
                commit=receipt.result,
                data=data,
                readback="verified" if snapshot == receipt.result else "changed",
            )
        except ResearchReadError:
            if strict:
                raise
        except Exception:
            # The transaction already committed. Never manufacture a failed write
            # or retry the mutation because its separate readback is unavailable.
            pass
        return result

    def present_update(self, workspace, issue, committed):
        result = {
            "schema_version": VERSION,
            "status": "COMMITTED",
            "execution_mode": "direct",
            "readback": "pending",
            "data": None,
            "target": self.reader.reference("administrative", "Issue", issue, workspace),
        }
        try:
            from plane.mcp.authorization import active_connection

            current = active_connection(self.connection.pk)
            if current is None:
                raise ResearchReadError("scope_denied", "Connection is no longer valid.", 403)
            self.reader = UnifiedReadService(current)
            _, _, fresh = self.reader.resolve(result["target"])
            result.update(
                data=self.reader.issue_data(fresh, workspace),
                readback="verified" if issue_snapshot(fresh) == committed else "changed",
            )
        except Exception:
            pass
        return result
