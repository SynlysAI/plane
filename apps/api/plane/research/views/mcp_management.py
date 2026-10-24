# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Session-only management of existing node-scoped research MCP credentials."""

from uuid import uuid4

from django.conf import settings
from django.core import signing
from django.db import transaction
from django.db.models import Q
from django.middleware.csrf import get_token
from django.utils import timezone
from django.views.decorators.debug import sensitive_variables
from rest_framework.authentication import SessionAuthentication
from rest_framework.response import Response

from plane.db.models import ResearchContextGrant
from plane.research.services.agent_operations import (
    allowed_actions,
    check_membership,
    issue_write_grant,
    workspace_policy,
)
from plane.research.services.chain_context import ResearchReadService
from plane.research.services.context_tokens import issue_context_token
from plane.research.services.mcp_catalog import ResearchReadError, TOOL_NAMES
from plane.research.services.token_lifetimes import node_mcp_token_ttl_seconds
from plane.research.utils.audit import record_audit_event
from plane.research.views.agent_operations import ResearchHumanOperationsEndpoint

SOURCES = ("human_node_read_grant", "human_node_write_grant")
CURSOR_SALT = "research-mcp.management.v1"
PAGE_SIZE = 30


class ResearchMCPManagementBase(ResearchHumanOperationsEndpoint):
    authentication_classes = [SessionAuthentication]
    research_module_required = False

    def context(self, node_id=None):
        from plane.research.utils.config import research_module_enabled

        if not research_module_enabled():
            raise ResearchReadError("disabled", "科研模块未开放。", 404)
        if not getattr(settings, "RESEARCH_MCP_ENABLED", False):
            raise ResearchReadError("disabled", "科研 MCP 未开放。", 404)
        workspace, error = self.get_workspace(section="research_chain", nav=None)
        if error:
            return None, None, error
        reader = ResearchReadService(workspace=workspace, user=self.request.user)
        return workspace, reader.node(node_id) if node_id else reader, None

    def page(self, rows, binding, present):
        cursor = self.request.query_params.get("cursor")
        if cursor:
            try:
                value = signing.loads(cursor, salt=CURSOR_SALT, max_age=3600)
                if value["binding"] != binding:
                    raise ValueError()
                rows = rows.filter(pk__gt=self.parse_uuid(value["id"]))
            except (signing.BadSignature, KeyError, TypeError, ValueError):
                raise ResearchReadError("invalid_cursor", "分页已失效或不属于当前查询，请重新加载。") from None
        batch = list(rows.order_by("pk")[: PAGE_SIZE + 1])
        return {
            "results": [present(row) for row in batch[:PAGE_SIZE]],
            "next_cursor": signing.dumps({"binding": binding, "id": str(batch[PAGE_SIZE - 1].pk)}, salt=CURSOR_SALT)
            if len(batch) > PAGE_SIZE
            else None,
        }


def node_capabilities(workspace, user, node):
    try:
        workspace_policy(workspace)
    except ResearchReadError:
        return [], "科研受控写入开关未开放；仍可生成只读连接。"
    if node.chain.status != "ACTIVE" or node.status in {"ARCHIVED", "COMPLETED", "WAITING_HUMAN"}:
        return [], "科研链或节点当前状态不允许写入。"
    actions = sorted(allowed_actions(workspace, user, node))
    return actions, "" if actions else "当前账号没有节点操作权限。"


class ResearchMCPCandidatesEndpoint(ResearchMCPManagementBase):
    http_method_names = ["get", "options"]

    def get(self, request, slug):
        workspace, reader, error = self.context()
        if error:
            return error
        search = request.query_params.get("q", "").strip()[:200]
        chain_id = request.query_params.get("chain_id", "")
        binding = [str(workspace.pk), str(request.user.pk), chain_id, search, "candidates"]
        if chain_id:
            chain = reader.chain(self.parse_uuid(chain_id))
            rows = reader.nodes(chain)
            if (
                search
                and search.casefold() not in chain.project.name.casefold()
                and search.casefold() not in workspace.name.casefold()
            ):
                rows = rows.filter(title__icontains=search)

            def present(node):
                actions, reason = node_capabilities(workspace, request.user, node)
                return {
                    "id": str(node.pk),
                    "chain_id": str(chain.pk),
                    "title": node.title,
                    "status": node.status,
                    "actions": actions,
                    "write_unavailable_reason": reason,
                }
        else:
            rows = reader.chains()
            if search and search.casefold() not in workspace.name.casefold():
                # Search both chain and node names; pagination never truncates hidden matches.
                matching = reader.nodes().filter(title__icontains=search).values("chain_id")
                rows = rows.filter(Q(project__name__icontains=search) | Q(pk__in=matching))

            def present(chain):
                return {"id": str(chain.pk), "title": chain.project.name, "status": chain.status}

        return Response(
            {
                **self.page(rows, binding, present),
                "csrf_token": get_token(request._request),
                "ttl_seconds": node_mcp_token_ttl_seconds(),
            }
        )


class ResearchMCPConnectionsEndpoint(ResearchMCPManagementBase):
    http_method_names = ["get", "post", "options"]

    def owned(self, workspace):
        return ResearchContextGrant.objects.filter(
            workspace=workspace, user=self.request.user, scope_source__in=SOURCES, chain_node__isnull=False
        ).select_related("chain_node__chain__project", "write_grant")

    @staticmethod
    def present(grant):
        write = getattr(grant, "write_grant", None)
        return {
            "id": str(grant.context_id),
            "label": grant.connection_label or (write.agent_label if write else "科研只读连接"),
            "workspace": grant.workspace.slug,
            "chain_id": str(grant.chain_node.chain_id),
            "chain_title": grant.chain_node.chain.project.name,
            "node_id": str(grant.chain_node_id),
            "node_title": grant.chain_node.title,
            "mode": "write" if write else "read",
            "actions": write.allowed_actions if write else [],
            "created_at": grant.created_at.isoformat(),
            "expires_at": grant.expires_at.isoformat(),
            "revoked_at": grant.revoked_at.isoformat() if grant.revoked_at else None,
            "last_used_at": grant.last_used_at.isoformat() if grant.last_used_at else None,
        }

    def get(self, request, slug):
        # Revocation/listing remain available when a feature switch is disabled.
        workspace, error = self.get_workspace(require_enabled=False, research_member=False, nav=None)
        if error:
            return error
        binding = [str(workspace.pk), str(request.user.pk), "connections"]
        return Response(
            {
                **self.page(self.owned(workspace).select_related("workspace"), binding, self.present),
                "csrf_token": get_token(request._request),
            }
        )

    @sensitive_variables()
    @transaction.atomic
    def post(self, request, slug):
        data = request.data
        if (
            not isinstance(data, dict)
            or set(data) != {"node_id", "label", "mode", "actions"}
            or not isinstance(data.get("mode"), str)
            or data["mode"] not in {"read", "write"}
            or not isinstance(data.get("label"), str)
            or not 1 <= len(data["label"].strip()) <= 100
            or any(ord(c) < 32 for c in data["label"])
            or not isinstance(data.get("actions"), list)
            or any(not isinstance(a, str) for a in data["actions"])
        ):
            raise ResearchReadError("invalid_arguments", "请提供节点、连接名称及明确的能力。")
        workspace, node, error = self.context(self.parse_uuid(data["node_id"]))
        if error:
            return error
        if data["mode"] == "write":
            # The existing issuer owns lock order (workspace policy, then user).
            write, raw = issue_write_grant(
                workspace=workspace,
                user=request.user,
                node_id=node.pk,
                actions=data["actions"],
                agent_label=data["label"].strip(),
            )
            grant = write.context
            protocol = "agent-operations"
        else:
            check_membership(workspace, request.user, lock=True)
            if data["actions"]:
                raise ResearchReadError("scope_denied", "只读连接不能授予写入能力。", 403)
            if (
                self.owned(workspace)
                .filter(
                    chain_node=node, write_grant__isnull=True, revoked_at__isnull=True, expires_at__gt=timezone.now()
                )
                .count()
                >= 5
            ):
                raise ResearchReadError("grant_limit", "此节点已有 5 条有效只读连接，请先撤销旧连接。", 409)
            grant, raw = issue_context_token(
                workspace=workspace,
                user=request.user,
                profile=node.chain.project.research_profile,
                chain_node=node,
                request_id="node-read:" + uuid4().hex,
                allowed_tools=sorted(TOOL_NAMES),
                scope_source="human_node_read_grant",
                policy_version="research-mcp.v1",
                ttl_seconds=node_mcp_token_ttl_seconds(),
            )
            protocol = "agent-access"
            record_audit_event(
                workspace=workspace,
                actor=request.user,
                action="research.mcp.grant.issue",
                resource_type="research_context",
                resource_id=grant.context_id,
                metadata={"node_id": str(node.pk), "actions": []},
            )
        grant.connection_label = data["label"].strip()
        grant.save(update_fields=["connection_label", "updated_at"])
        return Response(
            {
                **self.present(grant),
                "mcp_path": f"/api/research/workspaces/{slug}/{protocol}/mcp/",
                "headers": {"X-Research-Context-Token": raw, "X-Research-Context-Hash": grant.context_hash},
            },
            status=201,
        )


class ResearchMCPRevokeEndpoint(ResearchMCPConnectionsEndpoint):
    http_method_names = ["post", "options"]

    @transaction.atomic
    def post(self, request, slug, context_id):
        workspace, error = self.get_workspace(require_enabled=False, research_member=False, nav=None)
        if error:
            return error
        grant = self.owned(workspace).select_for_update(of=("self",)).filter(context_id=context_id).first()
        if grant is None:
            raise ResearchReadError("not_found", "当前账号在此工作区没有这条连接。", 404)
        if grant.revoked_at is None:
            grant.revoked_at = timezone.now()
            grant.save(update_fields=["revoked_at", "updated_at"])
            record_audit_event(
                workspace=workspace,
                actor=request.user,
                action="research.mcp.grant.revoke",
                resource_type="research_context",
                resource_id=grant.context_id,
            )
        return Response({"revoked": True})
