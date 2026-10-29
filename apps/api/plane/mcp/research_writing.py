"""Unified research adapters over the existing proposal and task services."""

from datetime import timezone as datetime_timezone

from crum import impersonate
from django.db import DatabaseError, transaction
from django.utils import timezone
from django.utils.dateparse import parse_datetime
from rest_framework.exceptions import ValidationError

from plane.db.models import ResearchChain, ResearchChainNode, ResearchChainNodeTask
from plane.mcp.authorization import active_connection
from plane.mcp.catalog import validate
from plane.mcp.reading import VERSION, UnifiedReadService, web_origin
from plane.mcp.writing import UnifiedWriteError, digest
from plane.research.serializers import ResearchChainNodeTaskSerializer
from plane.research.services.agent_operations import ResearchOperationService
from plane.research.services.chain_tasks import (
    ChainTaskConflictError,
    ChainTaskPermissionError,
    ChainTaskStateError,
    ChainTaskValidationError,
    _ensure_task_parent_writable,
    _replay_task_event,
    actor_can_cancel_task,
    cancel_task,
    complete_task,
    reopen_task,
    update_task,
    validate_assignable_user,
)
from plane.research.services.mcp_catalog import ResearchReadError
from plane.research.services.operation_authorization import UnifiedOperationAuthorization
from plane.research.utils.audit import record_audit_event


def task_snapshot(task):
    return {
        "title": task.title,
        "instruction_hash": digest(task.instruction),
        "assignee": str(task.assignee_id) if task.assignee_id else None,
        "due_at": task.due_at.astimezone(datetime_timezone.utc).isoformat() if task.due_at else None,
        "status": task.status,
        "resource_type": task.resource_type,
        "resource_id": str(task.resource_id) if task.resource_id else None,
    }


def proposal_projection(value, workspace, node):
    actions = ["get_research_operation"]
    if (
        value["status"] in {"PROPOSED", "APPROVED"}
        and parse_datetime(value["expires_at"]) > timezone.now()
        and node.chain.status == "ACTIVE"
        and node.status not in {"ARCHIVED", "COMPLETED", "WAITING_HUMAN"}
    ):
        actions.append("execute_research_operation")
    return {
        **value,
        "schema_version": VERSION,
        "native_schema_version": value["schema_version"],
        "domain": "research",
        "object_type": "ResearchAgentOperation",
        "id": value["operation_id"],
        "parent": {
            "domain": "research",
            "object_type": "ResearchChainNode",
            "workspace_slug": workspace.slug,
            "id": value["node_id"],
        },
        "name": value["action"],
        "url": web_origin() + value["review_path"],
        "allowed_actions": actions,
        "execution_mode": "proposal",
    }


class UnifiedResearchWriteService:
    def __init__(self, connection, request):
        self.connection, self.request = connection, request

    def execute(self, name, arguments):
        args = validate(name, arguments)
        try:
            if name in {"plane_update_task", "plane_transition_task"}:
                return self.direct(name, args)
            return self.operation(name, args)
        except ChainTaskPermissionError as exc:
            raise ResearchReadError("permission_denied", str(exc), 403) from None
        except ChainTaskConflictError as exc:
            raise ResearchReadError("idempotency_conflict", str(exc), 409) from None
        except ChainTaskStateError as exc:
            raise ResearchReadError("state_conflict", str(exc), 409) from None
        except (ChainTaskValidationError, ValidationError) as exc:
            raise UnifiedWriteError(
                "invalid_arguments",
                "Native research task validation rejected the write.",
                422,
                {"field_errors": getattr(exc, "detail", str(exc)), "write_outcome": "rolled_back"},
            ) from None
        except DatabaseError:
            raise UnifiedWriteError(
                "write_unavailable",
                "Outcome uncertain: query the same proposal or read the task before retrying.",
                503,
                {"write_outcome": "unknown"},
            ) from None

    def operation(self, name, args):
        reader = UnifiedReadService(self.connection)
        if "node" in args:
            workspace, _, node = reader.resolve(args["node"])
        else:
            workspace = reader.workspace(args["workspace_slug"])
            node = None
        authorization = UnifiedOperationAuthorization(self.connection)
        service = ResearchOperationService(workspace=workspace, user=self.connection.owner, authorization=authorization)
        native_name = name.removeprefix("plane_")
        if name == "plane_prepare_research_operation":
            native_args = {key: value for key, value in args.items() if key != "node"}
            native_args["node_id"] = str(node.pk)
        elif name == "plane_list_research_operations":
            # The existing listing is bounded to 20; smaller pages remain complete.
            service.authenticate(native_name)
            value = service.list_research_operations(
                node_id=str(node.pk),
                cursor=args.get("cursor"),
                limit=min(args.get("limit", 20), 20),
                request_id=args.get("request_id"),
            )
            value["data"] = [proposal_projection(item, workspace, node) for item in value["data"]]
            return {"schema_version": VERSION, "execution_mode": "proposal", **value}
        else:
            native_args = {"operation_id": args["operation_id"]}
        with impersonate(self.connection.owner):
            # Prepare/execute own their transactions and authenticate again while locked.
            value = service.execute(native_name, native_args)
        self.connection = authorization.connection
        # Separate current-scope readback must not expose a historical proposal after revocation.
        try:
            authorization.authenticate(workspace, self.connection.owner, "get_research_operation")
            service.reader = authorization.reader(workspace, self.connection.owner)
            current_node = service.reader.node(value["node_id"])
            service.load(value["operation_id"])
        except ResearchReadError:
            if name == "plane_execute_research_operation" and value["status"] == "COMMITTED":
                return {
                    "schema_version": VERSION,
                    "status": "COMMITTED",
                    "operation_id": value["operation_id"],
                    "execution_mode": "proposal",
                    "result": {"readback": "pending"},
                }
            raise
        return proposal_projection(value, workspace, current_node)

    def direct(self, name, args):
        authorization = UnifiedOperationAuthorization(self.connection)
        with transaction.atomic():
            reader = UnifiedReadService(self.connection)
            workspace, _, target = reader.resolve(args["target"])
            authorization.authenticate(
                workspace,
                self.connection.owner,
                "update_task" if name == "plane_update_task" else "transition_task",
                lock=True,
            )
            self.connection = authorization.connection
            # Lock in the same parent -> node -> task order used by the native services.
            chain = ResearchChain.objects.select_for_update().get(pk=target.chain_id)
            node = ResearchChainNode.objects.select_for_update().get(pk=target.node_id)
            task = ResearchChainNodeTask.objects.select_for_update().get(pk=target.pk)
            task.chain, task.node = chain, node
            _ensure_task_parent_writable(chain, node)
            with impersonate(self.connection.owner):
                if name == "plane_update_task":
                    serializer = ResearchChainNodeTaskSerializer(
                        task, data=args["changes"], partial=True, context={"request": self.request}
                    )
                    serializer.is_valid(raise_exception=True)
                    task = update_task(
                        task=task, actor=self.connection.owner, payload=serializer.validated_data, request=self.request
                    )
                    expected = task_snapshot(task)
                    event = None
                else:
                    task, event = self.transition(task, args)
                    expected = {"status": event.metadata["status"]}
                record_audit_event(
                    workspace=workspace,
                    actor=self.connection.owner,
                    action="mcp.write",
                    resource_type="unified_mcp_connection",
                    resource_id=self.connection.pk,
                    metadata={
                        "tool": name,
                        "node_id": str(task.node_id),
                        "task_id": str(task.pk),
                        "request_id": args.get("request_id"),
                        "authorization_source": "unified_mcp.v1",
                    },
                )
        result = {
            "schema_version": VERSION,
            "status": "COMMITTED",
            "execution_mode": "direct",
            "target": reader.reference("research", "ResearchChainNodeTask", task, workspace),
            "readback": "pending",
            "data": None,
        }
        if event is not None:
            result.update(request_id=args["request_id"], event_id=str(event.pk), commit=expected)
        try:
            current = active_connection(self.connection.pk)
            if current is None:
                result.pop("commit", None)
                result.pop("event_id", None)
                return result
            fresh = UnifiedReadService(current)
            _, _, current_task = fresh.resolve(result["target"])
            snapshot = task_snapshot(current_task)
            result.update(
                data=fresh.task_data(current_task, workspace),
                readback="verified" if all(snapshot[key] == value for key, value in expected.items()) else "changed",
            )
        except ResearchReadError:
            result.pop("commit", None)
            result.pop("event_id", None)
        except Exception:
            pass  # The business commit already happened; never repeat it for a read outage.
        return result

    def transition(self, task, args):
        action = args["action"]
        owner = self.connection.owner
        # Native completion/reopening predicates include state. A committed replay
        # still rechecks current identity/assignment without requiring the old state.
        permitted = (
            task.assignee_id == owner.pk and validate_assignable_user(task.workspace, task.chain, owner.pk)
            if action in {"complete", "reopen"}
            else actor_can_cancel_task(task.workspace, task, owner)
        )
        if not permitted:
            raise ChainTaskPermissionError("The current native task role does not permit this action.")
        request_id = "unified-task:" + digest(
            {
                "connection": str(self.connection.pk),
                "workspace": str(task.workspace_id),
                "request_id": args["request_id"],
            }
        )
        content_hash = digest(
            {"task": str(task.pk), "arguments": {key: value for key, value in args.items() if key != "target"}}
        )
        event_type = {
            "reopen": "TASK_REOPENED",
            "complete": "TASK_COMPLETED",
            "cancel": "TASK_CANCELLED",
        }[action]
        existing = _replay_task_event(task, request_id, event_type, content_hash)
        if existing is not None:
            return task, existing
        kwargs = {
            "task": task,
            "actor": owner,
            "request_id": request_id,
            "content_hash": content_hash,
            "request": self.request,
        }
        if action in {"reopen", "cancel"}:
            kwargs["reason"] = args["reason"]
        elif action == "complete":
            kwargs["comment"] = args.get("comment", "")
        task, _ = {"reopen": reopen_task, "complete": complete_task, "cancel": cancel_task}[action](**kwargs)
        return task, _replay_task_event(task, request_id, event_type, content_hash)
