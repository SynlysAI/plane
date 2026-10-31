"""Unified research adapters over the existing proposal and task services."""

import logging
from datetime import timezone as datetime_timezone

from crum import impersonate
from django.db import DatabaseError, transaction
from django.db.models import Q
from django.utils import timezone
from django.utils.dateparse import parse_datetime
from rest_framework.exceptions import ValidationError

from plane.db.models import (
    DEFAULT_STATES,
    OrgUnit,
    OrgUnitMember,
    Project,
    ProjectIdentifier,
    ProjectMember,
    ResearchChain,
    ResearchChainEvent,
    ResearchChainNode,
    ResearchChainNodeTask,
    ResearchProjectProfile,
    ResearchUserProfile,
    State,
    UnifiedMCPConnection,
    UnifiedMCPWriteResult,
    WorkspaceMember,
)
from plane.mcp.authorization import active_connection, workspace_access
from plane.mcp.catalog import RESEARCH_PROJECT_LIFECYCLE_SCHEMAS, validate
from plane.mcp.credentials import unexpired_connections
from plane.mcp.reading import VERSION, UnifiedReadService, web_origin
from plane.mcp.writing import UnifiedWriteError, digest, research_snapshot
from plane.research.serializers import ResearchChainNodeTaskSerializer
from plane.research.services.agent_operations import ResearchOperationService, check_membership, workspace_policy
from plane.research.services.chain_tasks import (
    ChainTaskConflictError,
    ChainTaskPermissionError,
    ChainTaskStateError,
    ChainTaskValidationError,
    _ensure_task_parent_writable,
    _replay_task_event,
    actor_can_cancel_task,
    cancel_task,
    chain_writer,
    complete_task,
    review_only_actor,
    reopen_task,
    update_task,
    validate_assignable_user,
)
from plane.research.services.chain_stage_approvals import NODE_TYPE_BY_STAGE, mark_chain_stage_in_progress
from plane.research.services.chain_state import NODE_TYPE_PATTERN, normalize_action, resolve_transition
from plane.research.services.group_knowledge import ensure_group_knowledge_binding
from plane.research.services.mcp_catalog import ResearchReadError
from plane.research.services.operation_authorization import UnifiedOperationAuthorization
from plane.research.utils.audit import ResearchAuditAction, ResearchResourceType, record_audit_event
from plane.research.utils.roles import is_research_admin
from plane.research.views.projects import (
    delete_research_project,
    serialize_profile,
    sync_chain_lifecycle,
    unique_project_name,
    validate_project_org_unit,
    visible_profile_queryset,
)
from plane.utils.project_identifier import identifier_from, unique_identifier

logger = logging.getLogger("plane.mcp.research")


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

    def begin(self, workspace_slug):
        """Lock and revalidate a dynamic read-write research connection."""
        connection = (
            UnifiedMCPConnection.objects.select_related("owner")
            .select_for_update(of=("self",))
            .filter(
                pk=self.connection.pk,
                owner__is_active=True,
                revoked_at__isnull=True,
                deleted_at__isnull=True,
            )
            .filter(unexpired_connections())
            .first()
        )
        if connection is None:
            raise ResearchReadError("scope_denied", "Connection is no longer valid.", 403)
        self.connection = connection
        self.reader = UnifiedReadService(connection)
        workspace = self.reader.workspace(workspace_slug)
        workspace_access(connection.owner, workspace, "research")
        workspace_policy(workspace)
        check_membership(workspace, connection.owner)
        entry = next(entry for entry in connection.scope["workspaces"] if entry["workspace_id"] == str(workspace.pk))
        if entry["domains"].get("research") != "read_write" or not connection.scope["include_future_objects"]:
            raise ResearchReadError("scope_denied", "This connection cannot write research objects.", 403)
        return connection, self.reader, workspace

    def replay(self, workspace, args, name, request_hash):
        """Return a prior creation receipt after exact request-hash checks."""
        receipt = UnifiedMCPWriteResult.all_objects.filter(
            connection=self.connection, workspace=workspace, request_id=args["request_id"]
        ).first()
        if receipt is None:
            return None
        if receipt.deleted_at or receipt.request_hash != request_hash or receipt.tool != name:
            raise ResearchReadError("idempotency_conflict", "request_id was used for a different write.", 409)
        return receipt

    @staticmethod
    def receipt_result(connection, workspace, name, args, request_hash, target, snapshot):
        """Persist and project a non-idempotent research creation receipt."""
        receipt = UnifiedMCPWriteResult.objects.create(
            connection=connection,
            workspace=workspace,
            request_id=args["request_id"],
            tool=name,
            request_hash=request_hash,
            issue_id=None,
            object_type=type(target).__name__,
            object_id=target.pk,
            result=snapshot,
        )
        return {
            "schema_version": VERSION,
            "status": "COMMITTED",
            "execution_mode": "direct",
            "receipt_id": str(receipt.pk),
            "readback": "verified",
        }  # noqa: E501

    @transaction.atomic
    def create_research_project(self, args):
        """Create a native research project and its initial chain projection."""
        connection, reader, workspace = self.begin(args["workspace_slug"])
        owner = connection.owner
        is_admin = is_research_admin(owner, workspace.pk)
        requested_owner = owner
        if args.get("owner_id"):
            if not is_admin:
                raise ResearchReadError("permission_denied", "Only research admins may choose another owner.", 403)
            owner_membership = WorkspaceMember.objects.filter(
                workspace=workspace, member_id=args["owner_id"], member__is_active=True, is_active=True
            ).first()
            if owner_membership is None:
                raise ResearchReadError("invalid_arguments", "Owner is not an active member.", 422)
            requested_owner = owner_membership.member
        if not (
            OrgUnitMember.objects.filter(
                workspace=workspace,
                user=owner,
                deleted_at__isnull=True,
            ).exists()
            or ResearchUserProfile.objects.filter(user=owner, deleted_at__isnull=True).exists()
            or is_admin
        ):
            raise ResearchReadError("permission_denied", "Research relation is required.", 403)
        unit = None
        if args.get("org_unit_id"):
            unit = OrgUnit.objects.filter(workspace=workspace, pk=args["org_unit_id"]).first()
            if unit is None:
                raise ResearchReadError("invalid_arguments", "Org unit not found.", 422)
        unit, _ = validate_project_org_unit(workspace, requested_owner, unit, can_override=is_admin)
        collaborators = list(
            WorkspaceMember.objects.filter(
                workspace=workspace,
                member_id__in=args.get("collaborator_ids", []),
                member__is_active=True,
                is_active=True,
                deleted_at__isnull=True,
            )
        )
        if len({str(item.member_id) for item in collaborators}) != len(set(args.get("collaborator_ids", []))):
            raise ResearchReadError("invalid_arguments", "Every collaborator must be active.", 422)
        request_hash = digest(
            {"tool": "plane_create_research_project", "workspace": str(workspace.pk), "arguments": args}
        )  # noqa: E501
        receipt = self.replay(workspace, args, "plane_create_research_project", request_hash)
        if receipt is not None:
            profile = ResearchProjectProfile.objects.filter(project_id=receipt.object_id).first()
            return {
                "schema_version": VERSION,
                "status": "COMMITTED",
                "execution_mode": "direct",
                "receipt_id": str(receipt.pk),
                "data": serialize_profile(profile),
                "readback": "verified",
            }  # noqa: E501
        base_name = args.get("name") or f"{requested_owner.display_name or requested_owner.email} 科研项目"
        name = unique_project_name(workspace, base_name.strip())
        identifier = unique_identifier(workspace, identifier_from(args.get("identifier") or name))
        with impersonate(owner):
            project = Project.objects.create(
                workspace=workspace,
                name=name,
                identifier=identifier,
                network=0,
                created_by=owner,
            )
            ProjectIdentifier.objects.create(name=identifier, project=project, workspace=workspace)
            State.objects.bulk_create(
                [
                    State(
                        name=item["name"],
                        color=item["color"],
                        project=project,
                        sequence=item["sequence"],
                        workspace=workspace,
                        group=item["group"],
                        default=item.get("default", False),
                        created_by=owner,
                    )
                    for item in DEFAULT_STATES
                ]
            )
            ProjectMember.objects.create(project=project, member=requested_owner, role=20, created_by=owner)
            if requested_owner.pk != owner.pk:
                ProjectMember.objects.create(project=project, member=owner, role=20, created_by=owner)
            existing = {requested_owner.pk, owner.pk}
            ProjectMember.objects.bulk_create(
                [
                    ProjectMember(project=project, member=item.member, role=15, created_by=owner)
                    for item in collaborators
                    if item.member_id not in existing
                ]
            )
            profile = ResearchProjectProfile.objects.create(
                project=project,
                workspace=workspace,
                owner=requested_owner,
                org_unit=unit,
                research_type=args.get("research_type", "RESEARCH_PROJECT"),
                chain_kind=ResearchProjectProfile.ChainKind.RESEARCH_CHAIN,
                chain_visibility=args.get("chain_visibility", "PRIVATE"),
                started_at=args.get("started_at") or timezone.localdate(),
                expected_end_at=args.get("expected_end_at"),
                created_by=owner,
            )
            chain = ResearchChain.objects.create(
                project=project,
                workspace=workspace,
                owner=requested_owner,
                visibility=profile.chain_visibility,
                request_id=f"project:{project.pk}",
                payload_hash=digest({"request_id": f"project:{project.pk}"}),
                created_by=owner,
            )
            ensure_group_knowledge_binding(chain, owner)
        record_audit_event(
            workspace=workspace,
            actor=owner,
            action=ResearchAuditAction.PROJECT_CREATE,
            resource_type=ResearchResourceType.PROJECT_PROFILE,
            resource_id=profile.pk,
            org_unit=unit,
            metadata={"project": str(project.pk), "owner": str(requested_owner.pk), "source": "mcp"},
        )
        return {
            **self.receipt_result(
                connection,
                workspace,
                "plane_create_research_project",
                args,
                request_hash,
                project,
                {**research_snapshot(project), "chain_id": str(chain.pk)},
            ),
            "target": {
                "domain": "research",
                "object_type": "ResearchChain",
                "workspace_slug": workspace.slug,
                "id": str(chain.pk),
            },  # noqa: E501
            "data": serialize_profile(profile),
        }

    def profile(self, workspace, project_id, *, lock=False):
        rows = visible_profile_queryset(workspace, self.connection.owner).filter(project_id=project_id)
        if lock:
            visible_id = rows.values_list("pk", flat=True).first()
            if visible_id is None:
                profile = None
            else:
                profile = (
                    ResearchProjectProfile.objects.select_for_update(of=("self",))
                    .select_related("project", "project__research_chain", "owner", "org_unit")
                    .get(pk=visible_id)
                )
        else:
            profile = rows.first()
        if profile is None:
            raise ResearchReadError("not_found", "Research project not found.", 404)
        return profile

    @transaction.atomic
    def update_research_project(self, args):
        connection, reader, workspace = self.begin(args["workspace_slug"])
        owner = connection.owner
        profile = self.profile(workspace, args["project_id"], lock=True)
        if not is_research_admin(owner, workspace.pk) and profile.owner_id != owner.pk:
            raise ResearchReadError("permission_denied", "Only the owner or research admin may update.", 403)
        if profile.workflow_status == ResearchProjectProfile.WorkflowStatus.DELETED:
            raise ResearchReadError("state_conflict", "Restore the deleted project first.", 409)
        project = Project.objects.select_for_update().get(pk=profile.project_id, workspace=workspace)
        profile.project = project
        changes = args["changes"]
        fields = []
        if "name" in changes:
            name = changes["name"].strip()
            if not name or Project.objects.filter(workspace=workspace, name=name).exclude(pk=project.pk).exists():
                raise ResearchReadError("invalid_arguments", "Project name is empty or already used.", 422)
            project.name = name
            project.save(update_fields=["name", "updated_at"])
        if "owner_id" in changes:
            if not is_research_admin(owner, workspace.pk):
                raise ResearchReadError("permission_denied", "Only admins may change owner.", 403)
            member = WorkspaceMember.objects.filter(
                workspace=workspace, member_id=changes["owner_id"], member__is_active=True, is_active=True
            ).first()
            if member is None:
                raise ResearchReadError("invalid_arguments", "Owner is not an active member.", 422)
            profile.owner = member.member
            fields.append("owner")
        if "org_unit_id" in changes:
            unit = None
            if changes["org_unit_id"]:
                unit = OrgUnit.objects.filter(workspace=workspace, pk=changes["org_unit_id"]).first()
                if unit is None:
                    raise ResearchReadError("invalid_arguments", "Org unit not found.", 422)
            unit, _ = validate_project_org_unit(
                workspace, profile.owner, unit, can_override=is_research_admin(owner, workspace.pk)
            )
            profile.org_unit = unit
            fields.append("org_unit")
        for field in ("research_type", "chain_visibility"):
            if field in changes:
                setattr(profile, field, changes[field])
                fields.append(field)
        for field in ("started_at", "expected_end_at"):
            if field in changes:
                setattr(profile, field, changes[field])
                fields.append(field)
        if fields:
            profile.save(update_fields=[*fields, "updated_at"])
        sync_chain_lifecycle(profile, owner_changed="owner_id" in changes)
        if "chain_visibility" in changes:
            chain = ResearchChain.objects.select_for_update().filter(project=project).first()
            if chain is not None:
                chain.visibility = profile.chain_visibility
                chain.save(update_fields=["visibility", "updated_at"])
        record_audit_event(
            workspace=workspace,
            actor=owner,
            action=ResearchAuditAction.PROJECT_UPDATE,
            resource_type=ResearchResourceType.PROJECT_PROFILE,
            resource_id=profile.pk,
            metadata={"project": str(project.pk), "source": "mcp"},
        )
        chain_id = getattr(profile.project.research_chain, "pk", None)
        return {
            "schema_version": VERSION,
            "status": "COMMITTED",
            "execution_mode": "direct",
            "target": {
                "domain": "research",
                "object_type": "ResearchChain",
                "workspace_slug": workspace.slug,
                "id": str(chain_id),
            },  # noqa: E501
            "data": serialize_profile(profile),
            "readback": "verified",
        }

    @transaction.atomic
    def archive_research_project(self, args, restore=False):
        connection, reader, workspace = self.begin(args["workspace_slug"])
        profile = self.profile(workspace, args["project_id"], lock=True)
        if not is_research_admin(connection.owner, workspace.pk) and profile.owner_id != connection.owner.pk:
            raise ResearchReadError("permission_denied", "Only the owner or research admin may change lifecycle.", 403)
        if profile.workflow_status == ResearchProjectProfile.WorkflowStatus.DELETED:
            raise ResearchReadError("state_conflict", "Restore the deleted project first.", 409)
        profile.workflow_status = (
            ResearchProjectProfile.WorkflowStatus.ACTIVE if restore else ResearchProjectProfile.WorkflowStatus.ARCHIVED
        )
        profile.is_active = restore
        profile.save(update_fields=["workflow_status", "is_active", "updated_at"])
        sync_chain_lifecycle(profile)
        chain_id = getattr(profile.project.research_chain, "pk", None)
        record_audit_event(
            workspace=workspace,
            actor=connection.owner,
            action=ResearchAuditAction.PROJECT_RESTORE if restore else ResearchAuditAction.PROJECT_ARCHIVE,
            resource_type=ResearchResourceType.PROJECT_PROFILE,
            resource_id=profile.pk,
            metadata={"project": str(profile.project_id), "source": "mcp"},
        )
        return {
            "schema_version": VERSION,
            "status": "COMMITTED",
            "execution_mode": "direct",
            "target": {
                "domain": "research",
                "object_type": "ResearchChain",
                "workspace_slug": workspace.slug,
                "id": str(chain_id),
            },  # noqa: E501
            "data": serialize_profile(profile),
            "readback": "verified",
        }

    def restore_research_project(self, args):
        return self.archive_research_project(args, restore=True)

    @transaction.atomic
    def delete_research_project(self, args):
        connection, reader, workspace = self.begin(args["workspace_slug"])
        profile = self.profile(workspace, args["project_id"])
        if args["confirm_name"] != profile.project.name:
            raise ResearchReadError("invalid_arguments", "confirm_name does not match the project name.", 422)
        if not is_research_admin(connection.owner, workspace.pk) and profile.owner_id != connection.owner.pk:
            raise ResearchReadError("permission_denied", "Only the owner or research admin may delete.", 403)
        project_id = profile.project_id
        chain_id = getattr(profile.project.research_chain, "pk", None)
        delete_research_project(profile, self.request)
        return {
            "schema_version": VERSION,
            "status": "COMMITTED",
            "execution_mode": "direct",
            "target": {
                "domain": "research",
                "object_type": "ResearchChain",
                "workspace_slug": workspace.slug,
                "id": str(chain_id),
            },  # noqa: E501
            "data": None,
            "readback": "deleted",
            "project_id": str(project_id),
        }

    def chain(self, workspace, chain_id, *, lock=False):
        reader = self.reader.reader(workspace)
        chain = reader.chains().filter(pk=chain_id).first()
        if chain is None:
            raise ResearchReadError("not_found", "Research chain not found.", 404)
        if lock:
            chain = ResearchChain.objects.select_for_update().get(pk=chain.pk)
        return chain

    @transaction.atomic
    def create_research_chain(self, args):
        connection, reader, workspace = self.begin(args["workspace_slug"])
        profile = self.profile(workspace, args["project_id"], lock=True)
        if not is_research_admin(connection.owner, workspace.pk) and profile.owner_id != connection.owner.pk:
            raise ResearchReadError("permission_denied", "Only the owner or research admin may create a chain.", 403)
        if profile.chain_kind != ResearchProjectProfile.ChainKind.RESEARCH_CHAIN:
            raise ResearchReadError("invalid_arguments", "Only research-chain projects are supported.", 422)
        if getattr(profile.project.research_chain, "pk", None) is not None:
            return {
                "schema_version": VERSION,
                "status": "COMMITTED",
                "execution_mode": "direct",
                "data": serialize_profile(profile),
                "readback": "already_exists",
            }  # noqa: E501
        visibility = args.get("visibility", profile.chain_visibility)
        if visibility != profile.chain_visibility:
            raise ResearchReadError("invalid_arguments", "Visibility must match the research project.", 422)
        request_hash = digest(
            {"tool": "plane_create_research_chain", "workspace": str(workspace.pk), "arguments": args}
        )  # noqa: E501
        receipt = self.replay(workspace, args, "plane_create_research_chain", request_hash)
        if receipt is not None:
            chain = ResearchChain.objects.get(pk=receipt.object_id)
            return {
                "schema_version": VERSION,
                "status": "COMMITTED",
                "execution_mode": "direct",
                "receipt_id": str(receipt.pk),
                "data": reader.chain_data(chain, workspace),
                "readback": "verified",
            }  # noqa: E501
        chain = ResearchChain.objects.create(
            project=profile.project,
            workspace=workspace,
            owner=profile.owner,
            visibility=visibility,
            request_id=args["request_id"],
            payload_hash=request_hash,
            created_by=connection.owner,
        )
        ensure_group_knowledge_binding(chain, connection.owner)
        record_audit_event(
            workspace=workspace,
            actor=connection.owner,
            action="mcp.write",
            resource_type=ResearchResourceType.RESEARCH_CHAIN,
            resource_id=chain.pk,
            metadata={"tool": "plane_create_research_chain", "project_id": str(profile.project_id)},
        )
        return {
            **self.receipt_result(
                connection,
                workspace,
                "plane_create_research_chain",
                args,
                request_hash,
                chain,
                research_snapshot(chain),
            ),  # noqa: E501
            "target": reader.reference("research", "ResearchChain", chain, workspace),
            "data": reader.chain_data(chain, workspace),
        }

    def node(self, workspace, node_id, *, lock=False):
        rows = self.reader.reader(workspace).nodes().filter(pk=node_id)
        node = rows.first()
        if node is None:
            raise ResearchReadError("not_found", "Research node not found.", 404)
        if lock:
            chain = ResearchChain.objects.select_for_update().get(pk=node.chain_id)
            node = ResearchChainNode.objects.select_for_update().get(pk=node.pk)
            node.chain = chain
        return node

    @transaction.atomic
    def create_research_node(self, args):
        connection, reader, workspace = self.begin(args["workspace_slug"])
        chain = self.chain(workspace, args["chain_id"], lock=True)
        if not chain_writer(workspace, connection.owner, chain):
            raise ResearchReadError("permission_denied", "Current role cannot append to this chain.", 403)
        if chain.status != ResearchChain.Status.ACTIVE:
            raise ResearchReadError("state_conflict", "Chain is not active.", 409)
        node_type = args["node_type"]
        if NODE_TYPE_PATTERN.fullmatch(node_type) is None:
            raise ResearchReadError("invalid_arguments", "Invalid node type.", 422)
        parent = None
        if args.get("parent_node_id"):
            parent = chain.nodes.filter(pk=args["parent_node_id"]).first()
            if parent is None:
                raise ResearchReadError("invalid_arguments", "Parent node is outside this chain.", 422)
        iteration = args.get("loop_iteration", 0)
        if (parent is None and iteration != 0) or (parent is not None and iteration < 1):
            raise ResearchReadError("invalid_arguments", "Root/child loop iteration is invalid.", 422)
        request_hash = digest({"tool": "plane_create_research_node", "workspace": str(workspace.pk), "arguments": args})
        receipt = self.replay(workspace, args, "plane_create_research_node", request_hash)
        if receipt is not None:
            node = ResearchChainNode.objects.get(pk=receipt.object_id)
            return {
                "schema_version": VERSION,
                "status": "COMMITTED",
                "execution_mode": "direct",
                "receipt_id": str(receipt.pk),
                "data": reader.node_data(node, workspace),
                "readback": "verified",
            }  # noqa: E501
        content_hash = digest({"arguments": args})
        with impersonate(connection.owner):
            node = ResearchChainNode.objects.create(
                chain=chain,
                node_type=node_type,
                title=args["title"],
                parent_node=parent,
                loop_iteration=iteration,
                assignee_id=args.get("assignee_id") or connection.owner.pk,
                request_id=args["request_id"],
                payload_hash=content_hash,
                created_by=connection.owner,
            )
            event_id = digest({"request_id": args["request_id"], "kind": "NODE_CREATED"})
            ResearchChainEvent.objects.create(
                chain=chain,
                node=node,
                event_id=event_id,
                request_id=f"node-created-{event_id[:48]}",
                actor=connection.owner,
                event_type="NODE_CREATED",
                occurred_at=timezone.now(),
                summary=f"Created node: {node.title}",
                content_hash=digest({"request_id": args["request_id"], "kind": "NODE_CREATED"}),
            )
            mark_chain_stage_in_progress(node)
        record_audit_event(
            workspace=workspace,
            actor=connection.owner,
            action="mcp.write",
            resource_type=ResearchResourceType.RESEARCH_CHAIN,
            resource_id=chain.pk,
            metadata={"tool": "plane_create_research_node", "node_id": str(node.pk)},
        )
        return {
            **self.receipt_result(
                connection, workspace, "plane_create_research_node", args, request_hash, node, research_snapshot(node)
            ),  # noqa: E501
            "target": reader.reference("research", "ResearchChainNode", node, workspace),
            "data": reader.node_data(node, workspace),
        }

    @transaction.atomic
    def update_research_node(self, args):
        connection, reader, workspace = self.begin(args["workspace_slug"])
        node = self.node(workspace, args["node_id"], lock=True)
        if (
            not chain_writer(workspace, connection.owner, node.chain)
            or node.chain.status != ResearchChain.Status.ACTIVE
            or node.status == "ARCHIVED"
        ):  # noqa: E501
            raise ResearchReadError("permission_denied", "Current role cannot edit this node.", 403)
        fields = []
        for field in ("title", "node_type"):
            if field in args["changes"]:
                value = args["changes"][field]
                if field == "node_type" and NODE_TYPE_PATTERN.fullmatch(value) is None:
                    raise ResearchReadError("invalid_arguments", "Invalid node type.", 422)
                setattr(node, field, value)
                fields.append(field)
        if "assignee_id" in args["changes"]:
            node.assignee_id = args["changes"]["assignee_id"]
            fields.append("assignee")
        if not fields:
            raise ResearchReadError("invalid_arguments", "No node changes were supplied.", 422)
        node.save(update_fields=[*fields, "updated_at"])
        record_audit_event(
            workspace=workspace,
            actor=connection.owner,
            action="mcp.write",
            resource_type=ResearchResourceType.RESEARCH_CHAIN,
            resource_id=node.chain_id,
            metadata={"tool": "plane_update_research_node", "node_id": str(node.pk), "fields": fields},
        )
        return {
            "schema_version": VERSION,
            "status": "COMMITTED",
            "execution_mode": "direct",
            "target": reader.reference("research", "ResearchChainNode", node, workspace),
            "data": reader.node_data(node, workspace),
            "readback": "verified",
        }

    @transaction.atomic
    def transition_research_node(self, args):
        connection, reader, workspace = self.begin(args["workspace_slug"])
        node = self.node(workspace, args["node_id"], lock=True)
        action = normalize_action(args["action"])
        if action in {"SUBMIT_REVIEW", "APPROVE", "RETURN"} and node.node_type in set(NODE_TYPE_BY_STAGE.values()):
            raise ResearchReadError("state_conflict", "Mapped stages use the stage approval API.", 409)
        reason = args.get("reason", "")
        if action in {"FAIL", "RETURN"} and not reason:
            raise ResearchReadError("invalid_arguments", "A reason is required for FAIL and RETURN.", 422)
        if not (
            chain_writer(workspace, connection.owner, node.chain)
            or (
                node.assignee_id == connection.owner.pk
                and not review_only_actor(workspace, connection.owner, node.chain)
            )
        ):
            raise ResearchReadError("permission_denied", "Only node operators may transition this node.", 403)
        if node.chain.status != ResearchChain.Status.ACTIVE:
            raise ResearchReadError("state_conflict", "Chain is not active.", 409)
        transition = resolve_transition(node.status, action)
        if transition is None:
            raise ResearchReadError("state_conflict", f"{action} is not allowed from {node.status}.", 409)
        new_status, event_type = transition
        content_hash = digest({key: value for key, value in args.items() if key != "workspace_slug"})
        event_id = digest({"request_id": args["request_id"], "action": action})
        if ResearchChainEvent.objects.filter(Q(request_id=args["request_id"]) | Q(event_id=event_id)).first():
            existing = ResearchChainEvent.objects.get(event_id=event_id)
            if existing.content_hash != content_hash or str(existing.node_id) != str(node.pk):
                raise ResearchReadError("idempotency_conflict", "request_id was already used.", 409)
            return {
                "schema_version": VERSION,
                "status": "COMMITTED",
                "execution_mode": "direct",
                "event_id": str(existing.pk),
                "data": reader.node_data(node, workspace),
                "readback": "verified",
            }  # noqa: E501
        node.status = new_status
        node.save(update_fields=["status", "updated_at"])
        event = ResearchChainEvent.objects.create(
            chain=node.chain,
            node=node,
            event_id=event_id,
            request_id=args["request_id"],
            actor=connection.owner,
            event_type=event_type,
            occurred_at=timezone.now(),
            refs=[{"kind": "node", "id": str(node.pk), "version": new_status}],
            summary=reason or f"{action}: {node.title}",
            content_hash=content_hash,
        )
        record_audit_event(
            workspace=workspace,
            actor=connection.owner,
            action="mcp.write",
            resource_type=ResearchResourceType.RESEARCH_CHAIN,
            resource_id=node.chain_id,
            metadata={"tool": "plane_transition_research_node", "node_id": str(node.pk), "event_id": str(event.pk)},
        )
        return {
            "schema_version": VERSION,
            "status": "COMMITTED",
            "execution_mode": "direct",
            "request_id": args["request_id"],
            "event_id": str(event.pk),
            "target": reader.reference("research", "ResearchChainNode", node, workspace),
            "data": reader.node_data(node, workspace),
            "readback": "verified",
        }

    def execute(self, name, arguments):
        args = validate(name, arguments)
        try:
            if name in RESEARCH_PROJECT_LIFECYCLE_SCHEMAS:
                return getattr(self, name.removeprefix("plane_"))(args)
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
            logger.exception("Unified research MCP write outcome is uncertain")
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
