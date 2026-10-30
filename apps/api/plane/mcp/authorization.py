"""Database-backed unified identity and live, intersected read authorization.

No child grants, caches, distributed locks or upstream credentials are created.
"""

import hashlib
import secrets

from django.conf import settings
from django.db import transaction
from django.db.models import Count, Q
from django.utils import timezone
from django.utils.dateparse import parse_datetime
from django.views.decorators.debug import sensitive_variables
from rest_framework.authentication import BaseAuthentication, get_authorization_header
from rest_framework.exceptions import AuthenticationFailed

from plane.db.models import ResearchContextGrant, UnifiedMCPConnection, User, Workspace, WorkspaceMember
from plane.mcp.catalog import CREATE_SCHEMA, matches
from plane.mcp.credentials import (
    DEFAULT_TTL_DAYS,
    expires_after,
    seal_credential,
    unexpired_connections,
    valid_lifetime,
)
from plane.research.services.mcp_catalog import RESOURCE_KINDS, TOOL_NAMES, ResearchReadError
from plane.research.utils.capabilities import has_active_research_org_relation
from plane.research.utils.audit import record_audit_event
from plane.research.utils.org import READABLE_WORKSPACE_ROLES
from plane.research.utils.settings import workspace_research_sections
from plane.utils.administrative_projects import visible_administrative_projects
from plane.utils.workspace_access import user_can_access_workspace

SNAPSHOT_LIMIT = 10000


def token_hash(raw):
    return hashlib.sha256(raw.encode()).hexdigest()


def active_connection(connection_id):
    return (
        UnifiedMCPConnection.objects.select_related("owner")
        .filter(unexpired_connections(), pk=connection_id, owner__is_active=True, revoked_at__isnull=True)
        .first()
    )


class UnifiedTokenAuthentication(BaseAuthentication):
    @sensitive_variables()
    def authenticate(self, request):
        header = get_authorization_header(request)
        parts = header.split()
        if len(parts) != 2 or parts[0].lower() != b"bearer":
            raise AuthenticationFailed("A unified MCP Bearer credential is required.")
        try:
            raw = parts[1].decode("ascii")
        except UnicodeDecodeError:
            raise AuthenticationFailed("Invalid unified MCP credential.") from None
        if len(raw) != 47 or not raw.startswith("pum_"):
            raise AuthenticationFailed("Invalid unified MCP credential.")
        connection = (
            UnifiedMCPConnection.objects.select_related("owner")
            .filter(
                unexpired_connections(),
                token_hash=token_hash(raw),
                owner__is_active=True,
                revoked_at__isnull=True,
            )
            .first()
        )
        if connection is None:
            raise AuthenticationFailed("Invalid, expired or revoked unified MCP credential.")
        UnifiedMCPConnection.objects.filter(pk=connection.pk).update(last_used_at=timezone.now())
        return connection.owner, connection

    def authenticate_header(self, request):
        return 'Bearer realm="plane-unified-mcp"'


def workspace_access(user, workspace, domain):
    member = WorkspaceMember.objects.filter(workspace=workspace, member=user, is_active=True).first()
    if not member or not user.is_active or not user_can_access_workspace(user, workspace_id=workspace.pk):
        raise ResearchReadError("scope_denied", "Workspace is outside the current permission.", 403)
    if domain == "research" and (
        not getattr(settings, "RESEARCH_MCP_ENABLED", False)
        or member.role not in READABLE_WORKSPACE_ROLES
        or not workspace_research_sections(workspace)["research_chain"]
        or not has_active_research_org_relation(user, workspace)
    ):
        raise ResearchReadError("scope_denied", "Research access is not currently available.", 403)


def active_unified_read_count(user, workspace, node_id=None, *, capability="read"):
    """Count broad scopes too, so legacy issuance cannot bypass the node limit."""
    rows = UnifiedMCPConnection.objects.filter(
        unexpired_connections(),
        owner=user,
        revoked_at__isnull=True,
        scope__workspaces__contains=[{"workspace_id": str(workspace.pk), "domains": {"research": capability}}],
    )
    if node_id is not None:
        rows = rows.filter(
            Q(scope__include_future_objects=True)
            | Q(
                scope__workspaces__contains=[{"workspace_id": str(workspace.pk), "snapshot": {"nodes": [str(node_id)]}}]
            )
        )
    return rows.count()


def active_unified_write_count(user, workspace, node_id=None):
    return active_unified_read_count(user, workspace, node_id, capability="read_write")


class UnifiedReadAuthorization:
    """Explicit verified read context, passed into the shared research reader."""

    def __init__(self, connection, workspace):
        self.connection = connection
        self.workspace = workspace
        self.user = connection.owner
        self.authenticate()

    def authenticate(self, tool=None):
        current = active_connection(self.connection.pk)
        if current is None or current.owner_id != self.user.pk:
            raise ResearchReadError("scope_denied", "Connection is no longer valid.", 403)
        self.connection, self.user = current, current.owner
        self.entry = next(
            (entry for entry in current.scope["workspaces"] if entry["workspace_id"] == str(self.workspace.pk)), None
        )
        if not self.entry or "research" not in self.entry["domains"]:
            raise ResearchReadError("scope_denied", "Research is outside this connection scope.", 403)
        workspace_access(self.user, self.workspace, "research")
        if tool is not None and tool not in TOOL_NAMES:
            raise ResearchReadError("scope_denied", "This authorization permits research reads only.", 403)

    @property
    def binding(self):
        return {"connection": str(self.connection.pk), "scope": self.connection.scope}

    @property
    def snapshot(self):
        return self.entry.get("snapshot")

    def scoped_chains(self, rows):
        return rows.filter(pk__in=self.snapshot["chains"]) if self.snapshot is not None else rows

    def scoped_nodes(self, rows):
        return rows.filter(pk__in=self.snapshot["nodes"]) if self.snapshot is not None else rows

    def scoped_rows(self, rows):
        if self.snapshot is not None:
            return rows.filter(created_at__lte=parse_datetime(self.connection.scope["snapshot_at"]))
        return rows

    def scoped_resources(self, rows, node, kind):
        if self.snapshot is not None:
            ids = self.snapshot["resources"].get(str(node.pk), {}).get(kind, [])
            return self.scoped_rows(rows).filter(pk__in=ids)
        return rows

    def report_versions(self, report):
        return self.scoped_rows(report.official_snapshots.all())


def scoped_administrative_projects(connection, workspace):
    workspace_access(connection.owner, workspace, "administrative")
    entry = next((item for item in connection.scope["workspaces"] if item["workspace_id"] == str(workspace.pk)), None)
    if not entry or "administrative" not in entry["domains"]:
        raise ResearchReadError("scope_denied", "Administrative projects are outside this connection scope.", 403)
    rows = visible_administrative_projects(connection.owner, workspace.slug).filter(archived_at__isnull=True)
    if not connection.scope["include_future_objects"]:
        rows = rows.filter(pk__in=entry["snapshot"]["projects"])
    return rows


@sensitive_variables()
@transaction.atomic
def issue_connection(user, data):
    if (
        not matches(CREATE_SCHEMA, data)
        or any(ord(c) < 32 or ord(c) == 127 for c in data["name"])
        or not valid_lifetime(data.get("ttl_days", DEFAULT_TTL_DAYS))
    ):
        raise ResearchReadError(
            "invalid_arguments", "Choose a name, workspaces, capabilities and explicit future-object scope."
        )
    if not data["include_future_objects"] and any(
        "read_write" in entry["domains"].values() for entry in data["workspaces"]
    ):
        raise ResearchReadError(
            "capability_unavailable",
            "read_write requires dynamic scope so newly created tasks and comments can be read back.",
            409,
        )
    ids = [str(entry["workspace_id"]).lower() for entry in data["workspaces"]]
    if len(set(ids)) != len(ids):
        raise ResearchReadError("invalid_arguments", "Duplicate workspaces are not permitted.")
    user = User.objects.select_for_update().get(pk=user.pk, is_active=True)
    scope = {
        "version": 1,
        "include_future_objects": data["include_future_objects"],
        "snapshot_at": timezone.now().isoformat(),
        "workspaces": [],
    }
    snapshot_size = 0
    for supplied in data["workspaces"]:
        workspace = Workspace.objects.filter(pk=supplied["workspace_id"]).first()
        if workspace is None:
            raise ResearchReadError("scope_denied", "Workspace is outside the current permission.", 403)
        for domain in supplied["domains"]:
            workspace_access(user, workspace, domain)
        entry = {"workspace_id": str(workspace.pk), "domains": supplied["domains"]}
        if "research" in supplied["domains"]:
            writable = supplied["domains"]["research"] == "read_write"
            if writable:
                from plane.research.services.agent_operations import workspace_policy

                workspace_policy(workspace)
            count = active_unified_read_count(user, workspace, capability="read_write" if writable else "read")
            if count >= 5:
                raise ResearchReadError("grant_limit", "Revoke an existing research connection first.", 409)
            # No grant=None machine path: this internal discovery is for the
            # authenticated human issuer, before there is any machine credential.
            from plane.research.services.chain_context import ResearchReadService

            reader = ResearchReadService(workspace=workspace, user=user)
            nodes = reader.nodes()
            legacy = ResearchContextGrant.objects.filter(
                workspace=workspace,
                user=user,
                chain_node__in=nodes,
                write_grant__isnull=not writable,
                revoked_at__isnull=True,
                expires_at__gt=timezone.now(),
            )
            if not writable:
                legacy = legacy.filter(scope_source="human_node_read_grant")
            if legacy.values("chain_node_id").annotate(total=Count("id")).filter(total__gte=5 - count).exists():
                raise ResearchReadError("grant_limit", "A visible node has reached its connection-category limit.", 409)
        if not data["include_future_objects"]:
            snapshot = {"projects": [], "chains": [], "nodes": [], "resources": {}}

            def identities(rows):
                nonlocal snapshot_size
                values = [
                    str(pk)
                    for pk in rows.filter(created_at__lte=parse_datetime(scope["snapshot_at"])).values_list(
                        "pk", flat=True
                    )[: SNAPSHOT_LIMIT + 1]
                ]
                snapshot_size += len(values)
                if snapshot_size > SNAPSHOT_LIMIT:
                    raise ResearchReadError(
                        "scope_too_large", "Snapshot exceeds 10000 references; choose dynamic scope.", 413
                    )
                return values

            if "administrative" in supplied["domains"]:
                snapshot["projects"] = identities(
                    visible_administrative_projects(user, workspace.slug).filter(archived_at__isnull=True)
                )
            if "research" in supplied["domains"]:
                snapshot["chains"] = identities(reader.chains())
                snapshot["nodes"] = identities(reader.nodes())
                for node in reader.nodes().filter(pk__in=snapshot["nodes"]).iterator(chunk_size=100):
                    resources = {}
                    for kind in RESOURCE_KINDS:
                        allowed = []
                        for resource in (
                            reader._candidates(node, kind)
                            .filter(created_at__lte=parse_datetime(scope["snapshot_at"]))
                            .iterator(chunk_size=100)
                        ):
                            if reader._allowed(node, kind, resource):
                                allowed.append(str(resource.pk))
                                snapshot_size += 1
                                if snapshot_size > SNAPSHOT_LIMIT:
                                    raise ResearchReadError(
                                        "scope_too_large",
                                        "Snapshot exceeds 10000 references; choose dynamic scope.",
                                        413,
                                    )
                        resources[kind] = allowed
                    snapshot["resources"][str(node.pk)] = resources
            entry["snapshot"] = snapshot
        scope["workspaces"].append(entry)
    raw = "pum_" + secrets.token_urlsafe(32)
    connection = UnifiedMCPConnection.objects.create(
        owner=user,
        name=data["name"].strip(),
        token_hash=token_hash(raw),
        token_encrypted=seal_credential(raw),
        scope=scope,
        expires_at=expires_after(data.get("ttl_days", DEFAULT_TTL_DAYS)),
    )
    for entry in scope["workspaces"]:
        record_audit_event(
            workspace=Workspace.objects.get(pk=entry["workspace_id"]),
            actor=user,
            action="mcp.connection.issue",
            resource_type="unified_mcp_connection",
            resource_id=connection.pk,
            metadata={"domains": entry["domains"], "include_future_objects": scope["include_future_objects"]},
        )
    return connection, raw
