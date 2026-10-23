"""Node-scoped proposals, client-authorized execution and logical idempotency."""

import hashlib
import html
import json
from datetime import timedelta

from django.conf import settings
from django.core import signing
from django.db import transaction
from django.utils import timezone

from plane.db.models import (
    ResearchAgentOperation, ResearchAgentOperationApproval, ResearchAgentWriteGrant,
    ResearchChain, ResearchChainEvent, ResearchChainNode, ResearchChainNodeTask,
    ResearchContextGrant, User, WorkspaceMember, WorkspaceResearchSetting,
)
from plane.research.services.chain_context import CONTENT_KINDS, ResearchReadService
from plane.research.services.chain_mutations import append_task_comment, save_analysis_draft
from plane.research.services.chain_tasks import (
    ChainTaskConflictError, ChainTaskPermissionError, ChainTaskStateError, ChainTaskValidationError,
    actor_can_manage_chain_tasks, create_task, update_task,
)
from plane.research.services.context_tokens import issue_context_token
from plane.research.services.token_lifetimes import node_mcp_token_ttl_seconds
from plane.research.services.mcp_catalog import ResearchReadError, TOOL_NAMES
from plane.research.services.operation_catalog import ACTIONS, OPERATION_TOOL_NAMES, RESOURCE_TYPES, validate_operation
from plane.research.utils.audit import record_audit_event
from plane.research.utils.capabilities import has_active_research_org_relation
from plane.research.utils.org import READABLE_WORKSPACE_ROLES


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, default=str).encode()).hexdigest()


def row_digest(row):
    # Hash complete persisted fields, never the truncated v1 display projection.
    return digest({field.attname: getattr(row, field.attname) for field in row._meta.concrete_fields})


def deployment_enabled():
    if not getattr(settings, "RESEARCH_MCP_ENABLED", False) or not getattr(settings, "RESEARCH_MCP_WRITE_ENABLED", False):
        raise ResearchReadError("disabled", "Research operation MCP is disabled.", 404)


def workspace_policy(workspace, *, lock=False):
    deployment_enabled()
    rows = WorkspaceResearchSetting.objects
    if lock:
        rows = rows.select_for_update()
    setting = rows.filter(workspace=workspace).first()
    if not setting or not setting.module_enabled or not setting.research_chain_enabled or not setting.research_mcp_write_enabled:
        raise ResearchReadError("disabled", "This workspace has not enabled Agent writes.", 403)
    return setting


def allowed_actions(workspace, user, node):
    from plane.research.views.chain_foundation import _node_operator

    actions = {"append_task_comment"}  # Existing research task comments permit visible participants.
    if actor_can_manage_chain_tasks(workspace, node.chain, user):
        actions.update({"create_task", "attach_task_resource"})
    if _node_operator(workspace, user, node):
        actions.update({"save_analysis_draft", "append_research_note"})
    return actions


def check_membership(workspace, user, *, lock=False):
    users = User.objects
    members = WorkspaceMember.objects
    if lock:
        users, members = users.select_for_update(), members.select_for_update()
    if (not users.filter(pk=user.pk, is_active=True).exists()
            or not members.filter(workspace=workspace, member=user, is_active=True, role__in=READABLE_WORKSPACE_ROLES).exists()
            or not has_active_research_org_relation(user, workspace)):
        raise ResearchReadError("scope_denied", "Current workspace or research membership is required.", 403)


@transaction.atomic
def issue_write_grant(*, workspace, user, node_id, actions, agent_label, reports=None):
    workspace_policy(workspace, lock=True)
    check_membership(workspace, user, lock=True)
    reader = ResearchReadService(workspace=workspace, user=user)
    node = reader.node(node_id)
    ResearchChain.objects.select_for_update().get(pk=node.chain_id)
    node = ResearchChainNode.objects.select_for_update().get(pk=node.pk)
    node.chain = ResearchChain.objects.get(pk=node.chain_id)
    if node.chain.status != "ACTIVE" or node.status in {"ARCHIVED", "COMPLETED", "WAITING_HUMAN"}:
        raise ResearchReadError("state_conflict", "This node is not open for Agent changes.", 409)
    if not actions or not set(actions) <= ACTIONS & allowed_actions(workspace, user, node):
        raise ResearchReadError("scope_denied", "Some requested actions are not permitted.", 403)
    if ResearchContextGrant.objects.filter(workspace=workspace, user=user, chain_node=node,
            revoked_at__isnull=True, expires_at__gt=timezone.now(), write_grant__isnull=False).count() >= 5:
        raise ResearchReadError("grant_limit", "Revoke an existing node write grant before issuing another.", 409)
    # Report grants pin only explicitly selected, already linked and readable formal versions.
    report_selections = []
    for ref in reports or []:
        obj = reader._lookup(node, "report", ref["id"])
        if obj is None or not reader._allowed(node, "report", obj):
            raise ResearchReadError("not_found", "Report not found in node scope.", 404)
        reader._content(node, "report", obj, ref["version"])
        report_selections.append({"report_id": str(obj.pk), "version_no": ref["version"]})
    grant, raw = issue_context_token(workspace=workspace, user=user, profile=node.chain.project.research_profile,
        chain_node=node, request_id="write-grant:" + timezone.now().isoformat(), allowed_reports=report_selections,
        allowed_tools=sorted(TOOL_NAMES | OPERATION_TOOL_NAMES), policy_version="research-mcp.operations.v2.1",
        scope_source="human_node_write_grant", ttl_seconds=node_mcp_token_ttl_seconds())
    write = ResearchAgentWriteGrant.objects.create(context=grant, allowed_actions=sorted(set(actions)), agent_label=agent_label)
    record_audit_event(workspace=workspace, actor=user, action="research.mcp.grant.issue",
        resource_type="research_context", resource_id=grant.context_id,
        metadata={"node_id": str(node.pk), "actions": write.allowed_actions})
    return write, raw


class ResearchOperationService:
    def __init__(self, *, workspace, user, grant=None):
        self.workspace, self.user, self.grant = workspace, user, grant
        self.reader = ResearchReadService(workspace=workspace, user=user, grant=grant)

    def authenticate(self, name, *, lock=False):
        workspace_policy(self.workspace, lock=lock)
        check_membership(self.workspace, self.user, lock=lock)
        if self.grant is None:
            raise ResearchReadError("write_grant_required", "A separately issued node write grant is required.", 403)
        grants = ResearchContextGrant.objects
        if lock:
            grants = grants.select_for_update()
        grant = grants.filter(pk=self.grant.pk, workspace=self.workspace, user=self.user,
            revoked_at__isnull=True, expires_at__gt=timezone.now()).first()
        if not grant or not grant.chain_node_id or name not in grant.allowed_tools:
            raise ResearchReadError("scope_denied", "Write grant is expired, revoked or outside tool scope.", 403)
        write = ResearchAgentWriteGrant.objects.filter(context=grant).first()
        if not write:
            raise ResearchReadError("write_grant_required", "Read grants do not permit Agent operations.", 403)
        self.grant, self.write = grant, write
        self.reader = ResearchReadService(workspace=self.workspace, user=self.user, grant=grant)
        return write

    def execute(self, name, arguments):
        args = validate_operation(name, arguments)
        self.authenticate(name)
        try:
            return getattr(self, name)(**args)
        except (ChainTaskPermissionError, ChainTaskStateError, ChainTaskConflictError, ChainTaskValidationError) as exc:
            code, status = ("permission_denied", 403) if isinstance(exc, ChainTaskPermissionError) else ("state_conflict", 409)
            raise ResearchReadError(code, str(exc), status) from None

    def context(self, node_id, action, *, lock=False, mutable=True):
        node = self.reader.node(node_id)
        if action not in self.write.allowed_actions or action not in allowed_actions(self.workspace, self.user, node):
            raise ResearchReadError("permission_denied", "This action is outside the current write permission.", 403)
        if lock:
            chain = ResearchChain.objects.select_for_update().get(pk=node.chain_id)
            node = ResearchChainNode.objects.select_for_update().get(pk=node.pk)
            node.chain = chain
        if mutable and (node.chain.status != "ACTIVE" or node.status in {"ARCHIVED", "COMPLETED", "WAITING_HUMAN"}):
            raise ResearchReadError("state_conflict", "The chain or node is no longer open for Agent changes.", 409)
        return node

    def source_state(self, node, refs, *, lock=False):
        result = []
        for ref in sorted(refs, key=lambda item: (item["kind"], item["id"], item.get("version", 0))):
            obj = self.reader._lookup(node, ref["kind"], ref["id"])
            if obj is None:
                raise ResearchReadError("not_found", "Source not found in node scope.", 404)
            if lock:
                obj = type(obj).objects.select_for_update().get(pk=obj.pk)
            if not self.reader._allowed(node, ref["kind"], obj):
                raise ResearchReadError("not_found", "Source not found in node scope.", 404)
            body_hash = None
            if ref["usage"] == "body" or ref.get("version") is not None and ref["kind"] in CONTENT_KINDS:
                body, _ = self.reader._content(node, ref["kind"], obj, ref.get("version"))
                body_hash = digest(body)
            elif ref.get("version") is not None:
                projection = self.reader._resource_data(node, ref["kind"], obj)
                if projection is None or projection.get("version") != ref["version"]:
                    raise ResearchReadError("version_changed", "Source metadata version does not match.", 409)
            result.append({"ref": ref, "row_hash": row_digest(obj), "body_hash": body_hash})
        return result

    def preconditions(self, node, action, payload, refs, *, lock=False):
        value = {"chain": row_digest(node.chain), "node": row_digest(node),
                 "target": {"node_title": node.title, "project_name": node.chain.project.name}}
        if "task_id" in payload:
            tasks = ResearchChainNodeTask.objects
            if lock:
                tasks = tasks.select_for_update()
            task = tasks.filter(pk=payload["task_id"], workspace=self.workspace, chain=node.chain, node=node).first()
            if not task:
                raise ResearchReadError("not_found", "Task not found in node scope.", 404)
            if action == "attach_task_resource" and (task.resource_type != "NONE" or task.resource_id is not None
                    or task.status not in {"DRAFT", "ASSIGNED", "NEEDS_REVISION"}):
                raise ResearchReadError("state_conflict", "Only an editable task without a binding can receive a resource.", 409)
            value["task"] = row_digest(task)
            value["target"].update(task_id=str(task.pk), task_title=task.title)
        sources = list(refs)
        if action == "attach_task_resource":
            sources.append({"kind": RESOURCE_TYPES[payload["resource_type"]], "id": payload["resource_id"],
                            "usage": "metadata", **({"version": payload["version"]} if "version" in payload else {})})
            if payload["resource_type"] in {"REPORT", "SNAPSHOT"} and "version" not in payload:
                raise ResearchReadError("version_required", "Report and snapshot attachments require an explicit version.")
        value["sources"] = self.source_state(node, sources, lock=lock)
        return value

    def seal(self, operation):
        return digest({"workspace": str(operation.workspace_id), "user": str(operation.user_id),
            "node": str(operation.node_id), "grant": str(operation.original_grant_id),
            "request_id": operation.request_id, "action": operation.action, "payload": operation.payload,
            "sources": operation.source_refs, "preconditions": operation.preconditions,
            "agent_label": operation.agent_label, "expires_at": operation.expires_at.isoformat()})

    def audit(self, operation, action):
        return record_audit_event(workspace=self.workspace, actor=self.user, action="research.mcp.operation." + action,
            resource_type="research_agent_operation", resource_id=operation.pk,
            metadata={"node_id": str(operation.node_id), "action": operation.action, "hash": operation.proposal_hash})

    def present(self, operation):
        if self.seal(operation) != operation.proposal_hash:
            raise ResearchReadError("proposal_changed", "Immutable proposal verification failed.", 409)
        return {"schema_version": "research-mcp.operations.v2.1", "operation_id": str(operation.pk),
            "node_id": str(operation.node_id), "chain_id": str(operation.node.chain_id), "action": operation.action,
            "payload": operation.payload, "source_refs": operation.source_refs, "preconditions": operation.preconditions,
            "target": operation.preconditions.get("target", {}),
            "proposal_hash": operation.proposal_hash, "agent_label": operation.agent_label, "status": operation.status,
            "expires_at": operation.expires_at.isoformat(), "result": operation.result,
            "effects": "Changes one target; records Agent provenance and audit. No assignment, lifecycle transition or external call.",
            "confirmation_mode": "agent_client",
            "review_path": (f"/{self.workspace.slug}/research/chains/{operation.node.chain_id}/"
                            f"?tab=nodes&node={operation.node_id}")}

    @transaction.atomic
    def prepare_research_operation(self, request_id, node_id, action, payload, source_refs=None):
        self.authenticate("prepare_research_operation", lock=True)
        node = self.context(node_id, action, lock=True)
        request_hash = digest({"node_id": str(node.pk), "action": action, "payload": payload, "sources": source_refs or []})
        previous = ResearchAgentOperation.all_objects.filter(workspace=self.workspace, user=self.user, request_id=request_id).first()
        if previous:
            if previous.deleted_at or previous.request_hash != request_hash:
                raise ResearchReadError("idempotency_conflict", "request_id was already used for a different proposal.", 409)
            return self.present(previous)
        operation = ResearchAgentOperation(workspace=self.workspace, user=self.user, node=node,
            original_grant=self.write, request_id=request_id, action=action, payload=payload, source_refs=source_refs or [],
            preconditions=self.preconditions(node, action, payload, source_refs or [], lock=True), request_hash=request_hash,
            agent_label=self.write.agent_label, expires_at=timezone.now() + timedelta(hours=24))
        operation.proposal_hash = self.seal(operation)
        operation.save()
        self.audit(operation, "prepare")
        return self.present(operation)

    def load(self, operation_id, *, lock=False):
        rows = ResearchAgentOperation.objects
        if lock:
            rows = rows.select_for_update()
        operation = rows.filter(pk=operation_id, workspace=self.workspace, user=self.user,
                                node_id=self.grant.chain_node_id).first()
        if not operation:
            raise ResearchReadError("not_found", "Operation not found in current scope.", 404)
        self.context(operation.node_id, operation.action, mutable=False)
        if self.seal(operation) != operation.proposal_hash:
            raise ResearchReadError("proposal_changed", "Immutable proposal verification failed.", 409)
        self.check_visibility(operation)
        return operation

    def check_visibility(self, operation):
        node = self.reader.node(operation.node_id)
        refs = list(operation.source_refs)
        if operation.action == "attach_task_resource":
            refs.append({"kind": RESOURCE_TYPES[operation.payload["resource_type"]], "id": operation.payload["resource_id"]})
        for ref in refs:
            obj = self.reader._lookup(node, ref["kind"], ref["id"])
            if obj is None or not self.reader._allowed(node, ref["kind"], obj):
                raise ResearchReadError("not_found", "Operation sources are no longer visible.", 404)

    def get_research_operation(self, operation_id):
        operation = self.load(operation_id)
        if operation.status == "COMMITTED":
            return self.readback(operation)
        return self.present(operation)

    def list_research_operations(self, node_id, cursor=None, limit=10):
        self.reader.node(node_id)
        rows = ResearchAgentOperation.objects.filter(workspace=self.workspace, user=self.user, node_id=node_id,
                                                     action__in=self.write.allowed_actions).order_by("id")
        if cursor:
            try:
                state = signing.loads(cursor, salt="research.operations.list", max_age=3600)
                if state["node"] != str(node_id) or state["user"] != str(self.user.pk):
                    raise ValueError()
                rows = rows.filter(pk__gt=state["after"])
            except (signing.BadSignature, ValueError, KeyError, TypeError):
                raise ResearchReadError("invalid_cursor", "Invalid operation cursor.") from None
        candidates = list(rows[:limit + 1])
        data, anchor, used = [], None, 0
        for item in candidates[:limit]:
            if item.action not in allowed_actions(self.workspace, self.user, item.node):
                anchor = item
                continue
            try:
                self.check_visibility(item)
            except ResearchReadError:
                anchor = item
                continue
            value = self.present(item)
            size = len(json.dumps(value, ensure_ascii=False))
            if data and used + size > 24000:
                break
            data.append(value)
            used += size
            anchor = item
        more = bool(anchor and (len(candidates) > limit or anchor != candidates[-1]))
        return {"data": data, "page": {"has_more": more,
            "next_cursor": signing.dumps({"node": str(node_id), "user": str(self.user.pk), "after": str(anchor.pk)}, salt="research.operations.list") if more else None}}

    @transaction.atomic
    def cancel_research_operation(self, operation_id):
        self.authenticate("cancel_research_operation", lock=True)
        operation = self.load(operation_id, lock=True)
        if operation.status == "CANCELLED":
            return self.present(operation)
        if operation.status not in {"PROPOSED", "APPROVED"}:
            raise ResearchReadError("state_conflict", "Only an unexecuted proposal can be cancelled.", 409)
        operation.status = "CANCELLED"
        operation.save(update_fields=["status", "updated_at"])
        self.audit(operation, "cancel")
        return self.present(operation)

    def execute_research_operation(self, operation_id):
        with transaction.atomic():
            self.authenticate("execute_research_operation", lock=True)
            operation = self.load(operation_id, lock=True)
            if operation.status != "COMMITTED":
                if operation.expires_at <= timezone.now():
                    operation.status = "EXPIRED"
                    operation.save(update_fields=["status", "updated_at"])
                elif operation.status in {"PROPOSED", "APPROVED"}:
                    # The authenticated execute call is the client's authorization
                    # to submit this immutable proposal. Do not require a second
                    # platform approval or manufacture a human approval record.
                    node = self.context(operation.node_id, operation.action, lock=True)
                    current = self.preconditions(node, operation.action, operation.payload, operation.source_refs, lock=True)
                    if current != operation.preconditions:
                        operation.status = "CONFLICT"
                        operation.save(update_fields=["status", "updated_at"])
                        self.audit(operation, "conflict")
                    else:
                        result = self.apply(operation, node)
                        audit = self.audit(operation, "commit")
                        operation.result = {**result, "audit_id": str(audit.pk), "readback": "pending"}
                        operation.status = "COMMITTED"
                        operation.save(update_fields=["status", "result", "updated_at"])
                else:
                    raise ResearchReadError("operation_not_executable", "This proposal is no longer executable.", 403)
        if operation.status != "COMMITTED":
            raise ResearchReadError("operation_" + operation.status.lower(), "Proposal expired or its preconditions changed; prepare a new proposal.", 409)
        return self.readback(operation)

    def apply(self, operation, node):
        payload, action = operation.payload, operation.action
        request_id = "mcp-op:" + str(operation.pk)
        refs = [{k: v for k, v in ref.items() if k != "usage"} for ref in operation.source_refs]
        if action == "create_task":
            target, _ = create_task(workspace=self.workspace, chain=node.chain, node=node, actor=self.user,
                                    payload={**payload, "request_id": request_id})
            kind = "task"
        elif action == "append_task_comment":
            task = ResearchChainNodeTask.objects.get(pk=payload["task_id"], node=node)
            target, _ = append_task_comment(task=task, actor=self.user, request_id=request_id,
                                           html="<p>" + html.escape(payload["text"]).replace("\n", "<br>") + "</p>")
            kind = "task_comment"
        elif action == "save_analysis_draft":
            target, _ = save_analysis_draft(workspace=self.workspace, node=node, actor=self.user,
                payload={**payload, "input_refs": refs, "tool_version": "research-mcp.v2.1"}, request_id=request_id)
            kind = "analysis"
        elif action == "attach_task_resource":
            task = ResearchChainNodeTask.objects.get(pk=payload["task_id"], node=node)
            target = update_task(task=task, actor=self.user, payload={"resource_type": payload["resource_type"], "resource_id": payload["resource_id"]})
            kind = "task"
            refs.append({"kind": RESOURCE_TYPES[payload["resource_type"]], "id": payload["resource_id"],
                         **({"version": payload["version"]} if "version" in payload else {})})
        else:
            target, kind = None, "event"
        metadata = {"operation_id": str(operation.pk), "agent_label": operation.agent_label,
                    "grant_id": str(self.grant.context_id), "proposing_user_id": str(operation.user_id),
                    "executing_user_id": str(self.user.pk), "authorization_source": "agent_client"}
        if hasattr(operation, "approval"):
            metadata["approving_user_id"] = str(operation.approval.actor_id)
        if target:
            refs.append({"kind": kind, "id": str(target.pk)})
        event = ResearchChainEvent.objects.create(chain=node.chain, node=node, event_id=request_id,
            request_id=request_id + ":provenance", actor=self.user, actor_type="AGENT", source_system="MCP",
            event_type="RESEARCH_NOTE" if action == "append_research_note" else "DATA_CHANGE", occurred_at=timezone.now(),
            trace_id=str(operation.pk), refs=refs, metadata=metadata,
            summary=payload["text"] if action == "append_research_note" else f"Agent {action}: {target.pk}",
            content_hash=operation.proposal_hash)
        if target is None:
            target = event
        return {"kind": kind, "object_id": str(target.pk), "node_id": str(node.pk),
                "status": getattr(target, "status", None), "event_id": str(event.pk)}

    def readback(self, operation):
        result = dict(operation.result)
        try:
            # A fresh resolver rechecks current ACL, target existence and public projection.
            self.reader = ResearchReadService(workspace=self.workspace, user=self.user, grant=self.grant)
            self.reader.execute("read_research_resource", {"node_id": str(operation.node_id), "kind": result["kind"],
                                "resource_id": result["object_id"], "max_chars": 8000})
            node = self.reader.node(operation.node_id)
            target = self.reader._lookup(node, result["kind"], result["object_id"])
            payload = operation.payload
            if operation.action == "create_task":
                matches = (target.title == payload["title"] and target.instruction == payload.get("instruction", "")
                           and target.status == "DRAFT" and target.assignee_id is None and target.due_at is None)
            elif operation.action == "append_task_comment":
                expected = "<p>" + html.escape(payload["text"]).replace("\n", "<br>") + "</p>"
                from plane.research.serializers.task_comment import ResearchTaskCommentSerializer
                serializer = ResearchTaskCommentSerializer(data={"comment_html": expected})
                serializer.is_valid(raise_exception=True)
                matches = target.comment_html == serializer.validated_data["comment_html"]
            elif operation.action == "save_analysis_draft":
                matches = (target.method == payload["method"] and target.summary == payload["summary"]
                           and target.conclusion == payload.get("conclusion", "") and target.status == "DRAFT")
            elif operation.action == "attach_task_resource":
                matches = target.resource_type == payload["resource_type"] and str(target.resource_id) == payload["resource_id"]
            else:
                matches = target.summary == payload["text"] and target.trace_id == str(operation.pk)
            result["readback"] = "verified" if matches else "changed"
            result["current_status"] = getattr(target, "status", None)
        except Exception:
            # Business commit already happened. A verification outage must not
            # invite another mutation or misreport the operation as uncommitted.
            result["readback"] = "pending"
        try:
            ResearchAgentOperation.objects.filter(pk=operation.pk, status="COMMITTED").update(result=result)
        except Exception:
            result["readback"] = "pending"
        operation.result = result
        return self.present(operation)


@transaction.atomic
def decide_operation(*, workspace, user, node_id, operation_id, proposal_hash, decision):
    workspace_policy(workspace, lock=True)
    check_membership(workspace, user, lock=True)
    operation = ResearchAgentOperation.objects.select_for_update().filter(
        pk=operation_id, workspace=workspace, user=user, node_id=node_id).first()
    if not operation:
        raise ResearchReadError("not_found", "Operation not found.", 404)
    service = ResearchOperationService(workspace=workspace, user=user)
    node = service.reader.node(node_id)
    service.check_visibility(operation)
    if operation.action not in allowed_actions(workspace, user, node):
        raise ResearchReadError("permission_denied", "Current business permission is required.", 403)
    if proposal_hash != operation.proposal_hash or service.seal(operation) != proposal_hash:
        raise ResearchReadError("proposal_changed", "Review the current immutable proposal before deciding.", 409)
    if operation.status == decision and hasattr(operation, "approval"):
        return service.present(operation)
    if operation.status != "PROPOSED" or operation.expires_at <= timezone.now():
        raise ResearchReadError("state_conflict", "This proposal cannot be reviewed now.", 409)
    ResearchAgentOperationApproval.objects.create(operation=operation, actor=user, proposal_hash=proposal_hash,
                                                decision=decision, expires_at=operation.expires_at)
    operation.status = decision
    operation.save(update_fields=["status", "updated_at"])
    service.audit(operation, decision.lower())
    return service.present(operation)
