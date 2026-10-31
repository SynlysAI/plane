"""Direct administrative writes through native serializers/shared saves.

Only create/comment have durable commit receipts. No proposal or approval layer.
"""

import hashlib
import json
import logging

from crum import impersonate
from django.core.serializers.json import DjangoJSONEncoder
from django.db import DatabaseError, IntegrityError, transaction
from django.utils import timezone
from rest_framework.exceptions import PermissionDenied, ValidationError

from plane.app.permissions.base import ROLE
from plane.app.serializers import (
    IssueCommentSerializer,
    IssueCreateSerializer,
    IssueDetailSerializer,
    ProjectSerializer,
)  # noqa: E501
from plane.db.models import (
    DEFAULT_STATES,
    Project,
    ProjectMember,
    ResearchChain,
    ResearchChainNode,
    State,
    UnifiedMCPConnection,
    UnifiedMCPWriteResult,
    WorkspaceMember,
)
from plane.mcp.catalog import ADMIN_SCHEMAS, PROJECT_LIFECYCLE_SCHEMAS, validate
from plane.mcp.authorization import scoped_administrative_projects
from plane.mcp.credentials import unexpired_connections
from plane.mcp.reading import VERSION, UnifiedReadService
from plane.research.services.mcp_catalog import ResearchReadError
from plane.research.utils.audit import record_audit_event
from plane.utils.issue_mutations import issue_action_allowed, save_issue, save_issue_comment
from plane.utils.work_item_required_fields import active_issue_label_ids, active_issue_module_ids
from plane.utils.administrative_projects import (
    get_or_create_default_administrative_organization,
    user_can_manage_administrative_project,
)

logger = logging.getLogger("plane.mcp")


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
        "module_ids": sorted(str(pk) for pk in active_issue_module_ids(issue)),
        "label_ids": sorted(str(pk) for pk in active_issue_label_ids(issue)),
        "start_date": issue.start_date.isoformat() if issue.start_date else None,
        "target_date": issue.target_date.isoformat() if issue.target_date else None,
    }


def project_snapshot(project):
    return {
        "name": project.name,
        "identifier": project.identifier,
        "description_hash": digest(project.description_html),
        "archived_at": project.archived_at.isoformat() if project.archived_at else None,
    }


def research_snapshot(target):
    if isinstance(target, ResearchChain):
        return {
            "project_id": str(target.project_id),
            "owner_id": str(target.owner_id),
            "status": target.status,
            "visibility": target.visibility,
        }
    if isinstance(target, ResearchChainNode):
        return {
            "title": target.title,
            "node_type": target.node_type,
            "status": target.status,
            "assignee_id": str(target.assignee_id) if target.assignee_id else None,
            "loop_iteration": target.loop_iteration,
        }
    return {"id": str(target.pk)}


class UnifiedWriteError(ResearchReadError):
    def __init__(self, code, message, status=400, details=None):
        super().__init__(code, message, status)
        self.details = details or {}


class UnifiedWriteService:
    def __init__(self, connection, request):
        self.connection, self.request = connection, request

    def begin(self, workspace_slug):
        """Lock and revalidate a dynamic read-write administrative connection."""
        connection = (
            UnifiedMCPConnection.objects.select_related("owner")
            .select_for_update(of=("self",))
            .filter(
                unexpired_connections(),
                pk=self.connection.pk,
                owner__is_active=True,
                revoked_at__isnull=True,
            )
            .first()
        )
        if connection is None:
            raise ResearchReadError("scope_denied", "Connection is no longer valid.", 403)
        self.connection = connection
        self.reader = UnifiedReadService(connection)
        workspace = self.reader.workspace(workspace_slug)
        entry = next(entry for entry in connection.scope["workspaces"] if entry["workspace_id"] == str(workspace.pk))
        if entry["domains"].get("administrative") != "read_write" or not connection.scope["include_future_objects"]:
            raise ResearchReadError("scope_denied", "This connection cannot write administrative projects.", 403)
        return connection, self.reader, workspace

    def replay(self, workspace, args, name, request_hash):
        """Return an existing create receipt or verify its request identity."""
        receipt = UnifiedMCPWriteResult.all_objects.filter(
            connection=self.connection, workspace=workspace, request_id=args["request_id"]
        ).first()
        if receipt is None:
            return None
        if receipt.deleted_at or receipt.request_hash != request_hash or receipt.tool != name:
            raise ResearchReadError("idempotency_conflict", "request_id was used for a different write.", 409)
        return receipt

    def commit_result(self, workspace, target, name, args, request_hash, *, issue=None, result=None):
        """Build a direct-write result and durable receipt for non-idempotent creates."""
        committed = result or project_snapshot(target) if target else result
        receipt = UnifiedMCPWriteResult.objects.create(
            connection=self.connection,
            workspace=workspace,
            request_id=args["request_id"],
            tool=name,
            request_hash=request_hash,
            issue_id=getattr(issue, "pk", None),
            object_type=type(target).__name__ if target is not None else "Issue",
            object_id=target.pk if target is not None else issue.pk,
            result=committed,
        )
        return {
            "schema_version": VERSION,
            "status": "COMMITTED",
            "execution_mode": "direct",
            "request_id": args["request_id"],
            "receipt_id": str(receipt.pk),
            "target": self.reader.reference("administrative", "Project", target, workspace)
            if target is not None
            else self.reader.reference("administrative", "Issue", issue, workspace),
            "data": self.reader.project_data(target, workspace) if target is not None else None,
            "commit": committed,
            "readback": "verified",
        }

    @transaction.atomic
    def create_project(self, args):
        """Create an administrative project through the native serializer."""
        connection, reader, workspace = self.begin(args["workspace_slug"])
        owner = connection.owner
        if not WorkspaceMember.objects.filter(
            workspace=workspace, member=owner, is_active=True, role__in=(ROLE.ADMIN.value, ROLE.MEMBER.value)
        ).exists():
            raise ResearchReadError("permission_denied", "Workspace member rights are required.", 403)
        request_hash = digest({"tool": "plane_create_project", "workspace": str(workspace.pk), "arguments": args})
        receipt = self.replay(workspace, args, "plane_create_project", request_hash)
        if receipt is not None:
            return self.present(receipt, strict=True)
        organization = args.get("administrative_organization_id")
        if organization is None:
            organization = get_or_create_default_administrative_organization(workspace).pk
        payload = {
            key: value
            for key, value in {
                "name": args["name"],
                "identifier": args["identifier"],
                "description_html": args.get("description_html", ""),
                "project_lead": args.get("project_lead_id"),
                "default_assignee": args.get("default_assignee_id"),
                "administrative_organization": str(organization),
            }.items()
            if value is not None
        }
        serializer = ProjectSerializer(
            data=payload,
            context={"workspace_id": workspace.pk, "request": self.request},
        )
        serializer.is_valid(raise_exception=True)
        with impersonate(owner):
            project = serializer.save()
            ProjectMember.objects.create(project=project, member=owner, role=ROLE.ADMIN.value)
            if project.project_lead_id and project.project_lead_id != owner.pk:
                ProjectMember.objects.create(project=project, member_id=project.project_lead_id, role=ROLE.ADMIN.value)
            State.objects.bulk_create(
                [
                    State(
                        name=state["name"],
                        color=state["color"],
                        project=project,
                        sequence=state["sequence"],
                        workspace=workspace,
                        group=state["group"],
                        default=state.get("default", False),
                        created_by=owner,
                    )
                    for state in DEFAULT_STATES
                ]
            )
        record_audit_event(
            workspace=workspace,
            actor=owner,
            action="mcp.write",
            resource_type="unified_mcp_connection",
            resource_id=connection.pk,
            metadata={"tool": "plane_create_project", "project_id": str(project.pk)},
        )
        return self.commit_result(workspace, project, "plane_create_project", args, request_hash)

    def scoped_project(self, workspace, project_id, *, archived=None):
        rows = (
            Project.objects.filter(workspace=workspace)
            if archived is True
            else scoped_administrative_projects(self.connection, workspace)
        )
        if archived is True:
            rows = rows.filter(archived_at__isnull=False)
        elif archived is False:
            rows = rows.filter(archived_at__isnull=True)
        project = rows.select_for_update().filter(pk=project_id).first()
        if project is None:
            raise ResearchReadError("not_found", "Project not found in current scope.", 404)
        return project

    @staticmethod
    def require_project_manager(user, workspace, project):
        allowed = (
            WorkspaceMember.objects.filter(
                workspace=workspace, member=user, is_active=True, role=ROLE.ADMIN.value
            ).exists()
            or user_can_manage_administrative_project(user, workspace.slug, project.pk)
            or ProjectMember.objects.filter(
                project=project, member=user, role=ROLE.ADMIN.value, is_active=True
            ).exists()
        )
        if not allowed:
            raise ResearchReadError("permission_denied", "Current project role cannot manage this project.", 403)

    @transaction.atomic
    def update_project(self, args):
        connection, reader, workspace = self.begin(args["workspace_slug"])
        project = self.scoped_project(workspace, args["project_id"], archived=False)
        self.require_project_manager(connection.owner, workspace, project)
        mapping = {
            "project_lead_id": "project_lead",
            "default_assignee_id": "default_assignee",
            "administrative_organization_id": "administrative_organization",
        }
        payload = {mapping.get(key, key): value for key, value in args["changes"].items()}
        serializer = ProjectSerializer(
            project,
            data=payload,
            context={"workspace_id": workspace.pk, "request": self.request},
            partial=True,
        )
        serializer.is_valid(raise_exception=True)
        with impersonate(connection.owner):
            serializer.save()
        record_audit_event(
            workspace=workspace,
            actor=connection.owner,
            action="mcp.write",
            resource_type="unified_mcp_connection",
            resource_id=connection.pk,
            metadata={"tool": "plane_update_project", "project_id": str(project.pk)},
        )
        return {
            "schema_version": VERSION,
            "status": "COMMITTED",
            "execution_mode": "direct",
            "target": reader.reference("administrative", "Project", project, workspace),
            "data": reader.project_data(project, workspace),
            "readback": "verified",
        }

    @transaction.atomic
    def archive_project(self, args, restore=False):
        connection, reader, workspace = self.begin(args["workspace_slug"])
        project = self.scoped_project(workspace, args["project_id"], archived=True if restore else None)
        self.require_project_manager(connection.owner, workspace, project)
        project.archived_at = None if restore else timezone.now()
        project.save(update_fields=["archived_at", "updated_at"])
        record_audit_event(
            workspace=workspace,
            actor=connection.owner,
            action="mcp.write",
            resource_type="unified_mcp_connection",
            resource_id=connection.pk,
            metadata={
                "tool": "plane_restore_project" if restore else "plane_archive_project",
                "project_id": str(project.pk),
            },  # noqa: E501
        )
        return {
            "schema_version": VERSION,
            "status": "COMMITTED",
            "execution_mode": "direct",
            "target": reader.reference("administrative", "Project", project, workspace),
            "data": reader.project_data(project, workspace),
            "readback": "verified",
        }

    def restore_project(self, args):
        return self.archive_project(args, restore=True)

    @transaction.atomic
    def delete_project(self, args):
        connection, reader, workspace = self.begin(args["workspace_slug"])
        project = self.scoped_project(workspace, args["project_id"])
        if args["confirm_name"] != project.name:
            raise ResearchReadError("invalid_arguments", "confirm_name does not match the project name.", 422)
        self.require_project_manager(connection.owner, workspace, project)
        project_id = project.pk
        project.delete()
        record_audit_event(
            workspace=workspace,
            actor=connection.owner,
            action="mcp.write",
            resource_type="unified_mcp_connection",
            resource_id=connection.pk,
            metadata={"tool": "plane_delete_project", "project_id": str(project_id)},
        )
        return {
            "schema_version": VERSION,
            "status": "COMMITTED",
            "execution_mode": "direct",
            "target": {
                "domain": "administrative",
                "object_type": "Project",
                "workspace_slug": workspace.slug,
                "id": str(project_id),
            },
            "data": None,
            "readback": "deleted",
        }

    @transaction.atomic
    def delete_task(self, args):
        connection, reader, workspace = self.begin(args["target"]["workspace_slug"])
        _, kind, issue = reader.resolve(args["target"])
        issue = reader.issues(workspace).select_for_update(of=("self",)).filter(pk=issue.pk).first()
        if issue is None:
            raise ResearchReadError("not_found", "Task not found in current scope.", 404)
        if args["confirm_name"] != issue.name:
            raise ResearchReadError("invalid_arguments", "confirm_name does not match the task name.", 422)
        if not issue_action_allowed(connection.owner, issue.project, "update", issue):
            raise ResearchReadError("permission_denied", "Current native task role cannot delete this task.", 403)
        issue.delete()
        record_audit_event(
            workspace=workspace,
            actor=connection.owner,
            action="mcp.write",
            resource_type="unified_mcp_connection",
            resource_id=connection.pk,
            metadata={"tool": "plane_delete_task", "issue_id": str(issue.pk)},
        )
        return {
            "schema_version": VERSION,
            "status": "COMMITTED",
            "execution_mode": "direct",
            "target": reader.reference("administrative", "Issue", issue, workspace),
            "data": None,
            "readback": "deleted",
        }

    def execute(self, name, arguments):
        args = validate(name, arguments)
        if name not in ADMIN_SCHEMAS and name not in PROJECT_LIFECYCLE_SCHEMAS:
            raise ResearchReadError("invalid_arguments", "Not an administrative write/result tool.")
        try:
            if name == "plane_get_write_result":
                return self.get_result(args)
            if name in PROJECT_LIFECYCLE_SCHEMAS:
                return getattr(self, name.removeprefix("plane_"))(args)
            with transaction.atomic():
                connection = (
                    UnifiedMCPConnection.objects.select_related("owner")
                    .select_for_update(of=("self",))
                    .filter(
                        unexpired_connections(),
                        pk=self.connection.pk,
                        owner__is_active=True,
                        revoked_at__isnull=True,
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
            logger.exception("Native unified MCP write hit a database constraint")
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
            if receipt.object_type == "Project":
                reference = {
                    "domain": "administrative",
                    "object_type": "Project",
                    "workspace_slug": workspace.slug,
                    "id": str(receipt.object_id),
                }
                try:
                    _, _, project = self.reader.resolve(reference)
                except ResearchReadError:
                    chain_id = receipt.result.get("chain_id")
                    if not chain_id:
                        raise
                    _, _, chain = self.reader.resolve(
                        {
                            "domain": "research",
                            "object_type": "ResearchChain",
                            "workspace_slug": workspace.slug,
                            "id": str(chain_id),
                        }
                    )
                    result.update(
                        object_type="ResearchChain",
                        object_id=str(chain.pk),
                        issue_id=None,
                        commit=receipt.result,
                        data=self.reader.chain_data(chain, workspace),
                        readback="pending",
                    )
                    return result
                result.update(
                    object_type=receipt.object_type,
                    object_id=str(receipt.object_id),
                    issue_id=None,
                    commit=receipt.result,
                    data=self.reader.project_data(project, workspace),
                    readback="verified" if project_snapshot(project) == receipt.result else "changed",
                )
                return result
            if receipt.object_type in {"ResearchChain", "ResearchChainNode"}:
                reference = {
                    "domain": "research",
                    "object_type": receipt.object_type,
                    "workspace_slug": workspace.slug,
                    "id": str(receipt.object_id),
                }
                _, _, target = self.reader.resolve(reference)
                result.update(
                    object_type=receipt.object_type,
                    object_id=str(receipt.object_id),
                    issue_id=None,
                    commit=receipt.result,
                    data=self.reader.chain_data(target, workspace)
                    if receipt.object_type == "ResearchChain"
                    else self.reader.node_data(target, workspace),
                    readback="verified" if research_snapshot(target) == receipt.result else "changed",
                )
                return result
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
