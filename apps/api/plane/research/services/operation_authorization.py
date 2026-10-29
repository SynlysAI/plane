"""Explicit legacy-node and unified-connection authorization for shared operations.

These adapters verify real persisted credentials. They never mint child grants.
"""

import hashlib
import json

from django.utils import timezone

from plane.db.models import ResearchAgentWriteGrant, ResearchContextGrant, UnifiedMCPConnection
from plane.research.services.chain_context import ResearchReadService
from plane.research.services.mcp_catalog import ResearchReadError
from plane.research.services.operation_catalog import ACTIONS, OPERATION_TOOL_NAMES


class NodeOperationAuthorization:
    def __init__(self, grant):
        self.grant = grant

    def reader(self, workspace, user):
        return ResearchReadService(workspace=workspace, user=user, grant=self.grant)

    def authenticate(self, workspace, user, name, *, lock=False):
        from plane.research.services.agent_operations import check_membership, workspace_policy

        workspace_policy(workspace, lock=lock)
        check_membership(workspace, user, lock=lock)
        if self.grant is None:
            raise ResearchReadError("write_grant_required", "A separately issued node write grant is required.", 403)
        rows = ResearchContextGrant.objects.select_for_update() if lock else ResearchContextGrant.objects
        grant = rows.filter(
            pk=self.grant.pk, workspace=workspace, user=user, revoked_at__isnull=True, expires_at__gt=timezone.now()
        ).first()
        if not grant or not grant.chain_node_id or name not in grant.allowed_tools:
            raise ResearchReadError("scope_denied", "Write grant is expired, revoked or outside tool scope.", 403)
        write = ResearchAgentWriteGrant.objects.filter(context=grant).first()
        if not write:
            raise ResearchReadError("write_grant_required", "Read grants do not permit Agent operations.", 403)
        self.grant, self.write = grant, write

    @property
    def actions(self):
        return set(self.write.allowed_actions)

    @property
    def original_source(self):
        return {"original_grant": self.write}

    @property
    def agent_label(self):
        return self.write.agent_label

    @property
    def operation_filters(self):
        return {"original_connection__isnull": True, "node_id": self.grant.chain_node_id}

    @property
    def cursor_binding(self):
        return {}  # Preserve legacy cursor bytes/meaning.

    @property
    def provenance(self):
        return {"grant_id": str(self.grant.context_id)}


class UnifiedOperationAuthorization:
    def __init__(self, connection):
        self.connection = connection

    def reader(self, workspace, user):
        from plane.mcp.authorization import UnifiedReadAuthorization

        if self.connection.owner_id != user.pk:
            raise ResearchReadError("scope_denied", "Connection owner does not match the actor.", 403)
        return ResearchReadService(
            workspace=workspace, user=user, authorization=UnifiedReadAuthorization(self.connection, workspace)
        )

    def authenticate(self, workspace, user, name, *, lock=False):
        from plane.mcp.authorization import workspace_access
        from plane.research.services.agent_operations import check_membership, workspace_policy

        # Match revocation's connection lock before acquiring legacy policy/user locks.
        rows = UnifiedMCPConnection.objects.select_for_update(of=("self",)) if lock else UnifiedMCPConnection.objects
        connection = (
            rows.select_related("owner")
            .filter(
                pk=self.connection.pk,
                owner=user,
                owner__is_active=True,
                revoked_at__isnull=True,
                expires_at__gt=timezone.now(),
            )
            .first()
        )
        if connection is None:
            raise ResearchReadError("scope_denied", "Connection is no longer valid.", 403)
        entry = next((item for item in connection.scope["workspaces"] if item["workspace_id"] == str(workspace.pk)), {})
        if entry.get("domains", {}).get("research") != "read_write":
            raise ResearchReadError("scope_denied", "Research writes are outside this connection scope.", 403)
        if not connection.scope["include_future_objects"]:
            raise ResearchReadError("scope_denied", "Research writes require dynamic scope.", 403)
        if name not in OPERATION_TOOL_NAMES | {"update_task", "transition_task"}:
            raise ResearchReadError("scope_denied", "This research action is not available.", 403)
        self.connection = connection
        workspace_access(user, workspace, "research")
        workspace_policy(workspace, lock=lock)
        check_membership(workspace, user, lock=lock)

    @property
    def actions(self):
        return ACTIONS  # The shared service intersects this with current business roles.

    @property
    def original_source(self):
        return {"original_connection": self.connection}

    @property
    def agent_label(self):
        return self.connection.name

    @property
    def operation_filters(self):
        return {"original_connection": self.connection}

    @property
    def cursor_binding(self):
        scope_hash = hashlib.sha256(json.dumps(self.connection.scope, sort_keys=True).encode()).hexdigest()
        return {"connection": str(self.connection.pk), "scope": scope_hash}

    @property
    def provenance(self):
        return {"connection_id": str(self.connection.pk), "credential_source": "unified_mcp.v1"}
