"""Issue and validate short-lived Research Context exchange tokens."""

import hashlib
import json
import secrets
from datetime import timedelta

from django.conf import settings
from django.utils import timezone
from rest_framework.authentication import BaseAuthentication

from plane.db.models import ResearchContextGrant

CONTEXT_TOKEN_HEADER = "X-Research-Context-Token"


def hash_context_token(raw_token):
    """Hash an opaque bearer token before it is stored or queried."""
    return hashlib.sha256(str(raw_token).encode()).hexdigest()


def context_hash_for(*, workspace_id, user_id, project_id, chain_node_id, visibility_scope):
    """Create a deterministic hash of the immutable token scope."""
    scope = {
        "workspace_id": str(workspace_id),
        "user_id": str(user_id),
        "research_project_id": str(project_id) if project_id else None,
        "chain_node_id": str(chain_node_id) if chain_node_id else None,
        "visibility_scope": str(visibility_scope),
    }
    encoded = json.dumps(scope, sort_keys=True, separators=(",", ":")).encode()
    return hashlib.sha256(encoded).hexdigest()


def context_policy_hash(payload):
    """Hash a v2 capability policy without embedding secrets or tokens."""
    return hashlib.sha256(json.dumps(payload, sort_keys=True, separators=(",", ":"), default=str).encode()).hexdigest()


def agent_context_v3_hash(*, target, subject, policy, manifest_hash, issuer=""):
    """Hash the complete v3 target/subject/policy/manifest identity."""
    payload = {
        "schema_version": "agent-context.v3",
        "issuer": str(issuer or ""),
        "target": target,
        "subject": subject,
        "policy_hash": context_policy_hash(policy),
        "manifest_hash": manifest_hash,
    }
    return context_policy_hash(payload)


def issue_context_token(
    *,
    workspace,
    user,
    profile,
    chain_node=None,
    request_id,
    allowed_knowledge_base_ids=None,
    allowed_file_ids=None,
    allowed_reports=None,
    allowed_plugins=None,
    allowed_tools=None,
    policy_id="",
    scope_kind="OWNER",
    scope_source="chain_owner",
    policy_version="research-agent-policy.v1",
    ttl_seconds=None,
):
    """Create a one-time displayed token and its revocable database grant."""
    if not request_id:
        raise ValueError("request_id is required")
    raw_token = secrets.token_urlsafe(48)
    from plane.research.utils.chain_permissions import effective_chain_visibility

    visibility_scope = effective_chain_visibility(profile)
    allowed_knowledge_base_ids = list(allowed_knowledge_base_ids or [])
    allowed_file_ids = list(allowed_file_ids or [])
    allowed_reports = list(allowed_reports or [])
    allowed_plugins = list(allowed_plugins or [])
    allowed_tools = list(allowed_tools or [])
    policy_hash = context_policy_hash(
        {
            "allowed_knowledge_base_ids": allowed_knowledge_base_ids,
            "allowed_file_ids": allowed_file_ids,
            "allowed_reports": allowed_reports,
            "allowed_plugins": allowed_plugins,
            "allowed_tools": allowed_tools,
        }
    )
    base_hash = context_hash_for(
        workspace_id=workspace.id,
        user_id=user.id,
        project_id=profile.project_id,
        chain_node_id=chain_node.id if chain_node else None,
        visibility_scope=visibility_scope,
    )
    context_hash = (
        context_policy_hash(
            {
                "base_hash": base_hash,
                "allowed_knowledge_base_ids": allowed_knowledge_base_ids,
                "allowed_file_ids": allowed_file_ids,
                "allowed_reports": allowed_reports,
                "allowed_plugins": allowed_plugins,
                "allowed_tools": allowed_tools,
            }
        )
        if any((allowed_knowledge_base_ids, allowed_file_ids, allowed_plugins, allowed_tools, allowed_reports))
        else base_hash
    )
    default_ttl = getattr(settings, "RESEARCH_CONTEXT_TOKEN_TTL_SECONDS", 600)
    ttl_seconds = max(60, int(ttl_seconds if ttl_seconds is not None else default_ttl))
    grant = ResearchContextGrant.objects.create(
        workspace=workspace,
        user=user,
        project_id=profile.project_id,
        research_chain_id=chain_node.chain_id if chain_node else None,
        chain_node=chain_node,
        target_type=ResearchContextGrant.TargetType.RESEARCH_CHAIN_NODE,
        visibility_scope=visibility_scope,
        context_hash=context_hash,
        allowed_knowledge_base_ids=allowed_knowledge_base_ids,
        allowed_file_ids=allowed_file_ids,
        allowed_reports=allowed_reports,
        allowed_plugins=allowed_plugins,
        allowed_tools=allowed_tools,
        policy_id=policy_id,
        policy_hash=policy_hash,
        scope_kind=scope_kind,
        scope_source=scope_source,
        policy_version=policy_version,
        token_hash=hash_context_token(raw_token),
        context_token_encrypted=_encrypt_token(raw_token),
        expires_at=timezone.now() + timedelta(seconds=ttl_seconds),
        request_id=request_id,
        created_by=user,
    )
    return grant, raw_token


def issue_agent_dock_context_token(
    *,
    workspace,
    user,
    target_type,
    request_id,
    project=None,
    research_chain=None,
    chain_node=None,
    visibility_scope="PRIVATE",
    allowed_tools=None,
    allowed_plugins=None,
    allowed_mcp_ids=None,
    allowed_knowledge_base_ids=None,
    allowed_file_ids=None,
    allowed_reports=None,
    manifest=None,
    policy_id="",
    scope_kind="OWNER",
    scope_source="workspace_member",
    policy_version="agent-dock-policy.v1",
    ttl_seconds=None,
    issuer="",
):
    """Issue an agent-context.v3 grant for any supported dock target.

    Args:
        workspace: Workspace that owns the target and token.
        user: Authenticated Plane user after server-side ACL checks.
        target_type: One of WORKSPACE, PROJECT, RESEARCH_CHAIN, or node.
        request_id: Caller-provided idempotency key.
        project: Authorized project, when target is project-scoped.
        research_chain: Authorized chain, when chain-scoped.
        chain_node: Authorized node, when node-scoped.
        visibility_scope: Existing research visibility vocabulary.
        allowed_tools/plugins/mcp/files/knowledge/reports: Capability hard bounds.
        manifest: Safe summary and bounded resource references.
        policy_id: Stable policy identifier.
        scope_kind: OWNER or REVIEW.
        scope_source: Authorization source description.
        policy_version: Versioned policy name.
        ttl_seconds: Optional token lifetime.
        issuer: Normalized Plane issuer base URL for multi-instance callbacks.

    Returns:
        ``(grant, raw_token)``; the raw token is never persisted in clear text.
    """
    if not request_id:
        raise ValueError("request_id is required")
    if target_type not in ResearchContextGrant.TargetType.values:
        raise ValueError("Unsupported Agent Dock target type")
    if target_type == ResearchContextGrant.TargetType.PROJECT and project is None:
        raise ValueError("PROJECT context requires project")
    if target_type == ResearchContextGrant.TargetType.RESEARCH_CHAIN and research_chain is None:
        raise ValueError("RESEARCH_CHAIN context requires research_chain")
    if target_type == ResearchContextGrant.TargetType.RESEARCH_CHAIN_NODE and chain_node is None:
        raise ValueError("RESEARCH_CHAIN_NODE context requires chain_node")

    target = {
        "type": target_type,
        "workspace_id": str(workspace.id),
        "workspace_slug": workspace.slug,
        "project_id": str(project.id) if project else None,
        "research_chain_id": str(research_chain.id) if research_chain else None,
        "chain_node_id": str(chain_node.id) if chain_node else None,
    }
    delegated_subject = f"plane-ws-{workspace.id}-user-{user.id}"
    subject = {
        "plane_user_id": str(user.id),
        "delegated_subject": delegated_subject,
        "scope_kind": scope_kind,
        "scope_source": scope_source,
    }
    policy = {
        "policy_id": policy_id,
        "policy_version": policy_version,
        "visibility_scope": visibility_scope,
        "allowed_tools": list(allowed_tools or []),
        "allowed_plugins": list(allowed_plugins or []),
        "allowed_mcp_ids": list(allowed_mcp_ids or []),
        "allowed_knowledge_base_ids": list(allowed_knowledge_base_ids or []),
        "allowed_file_ids": list(allowed_file_ids or []),
    }
    normalized_issuer = str(issuer or "").rstrip("/")
    safe_manifest = {
        "version": 1,
        "hash": "",
        **({"issuer": normalized_issuer} if normalized_issuer else {}),
        "summary": str((manifest or {}).get("summary") or "")[:12000],
        "resources": list((manifest or {}).get("resources") or [])[:100],
    }
    page_context = (manifest or {}).get("page_context")
    if isinstance(page_context, dict):
        safe_manifest["page_context"] = page_context
    safe_manifest["hash"] = context_policy_hash(
        {
            "summary": safe_manifest["summary"],
            "resources": safe_manifest["resources"],
            **({"page_context": safe_manifest["page_context"]} if "page_context" in safe_manifest else {}),
        }
    )
    target_filter = {"workspace": workspace, "user": user, "target_type": target_type}
    if project is not None:
        target_filter["project"] = project
    if research_chain is not None:
        target_filter["research_chain"] = research_chain
    if chain_node is not None:
        target_filter["chain_node"] = chain_node
    context_version = ResearchContextGrant.objects.filter(**target_filter).count() + 1
    context_hash = agent_context_v3_hash(
        target=target,
        subject=subject,
        policy=policy,
        manifest_hash=safe_manifest["hash"],
        issuer=normalized_issuer,
    )
    raw_token = secrets.token_urlsafe(48)
    default_ttl = getattr(settings, "RESEARCH_CONTEXT_TOKEN_TTL_SECONDS", 600)
    ttl = max(60, int(ttl_seconds if ttl_seconds is not None else default_ttl))
    grant = ResearchContextGrant.objects.create(
        workspace=workspace,
        user=user,
        project=project,
        research_chain=research_chain,
        chain_node=chain_node,
        target_type=target_type,
        visibility_scope=visibility_scope,
        context_hash=context_hash,
        context_version=context_version,
        context_manifest=safe_manifest,
        allowed_knowledge_base_ids=policy["allowed_knowledge_base_ids"],
        allowed_file_ids=policy["allowed_file_ids"],
        allowed_reports=list(allowed_reports or []),
        allowed_plugins=policy["allowed_plugins"],
        allowed_tools=policy["allowed_tools"],
        allowed_mcp_ids=policy["allowed_mcp_ids"],
        policy_id=policy_id,
        policy_hash=context_policy_hash(policy),
        scope_kind=scope_kind,
        scope_source=scope_source,
        policy_version=policy_version,
        token_hash=hash_context_token(raw_token),
        context_token_encrypted=_encrypt_token(raw_token),
        expires_at=timezone.now() + timedelta(seconds=ttl),
        request_id=request_id,
        created_by=user,
    )
    return grant, raw_token


def _encrypt_token(raw_token: str) -> str:
    """Encrypt an opaque token for server-side continuation calls."""
    from plane.license.utils.encryption import encrypt_data

    return encrypt_data(raw_token)


def load_context_grant(raw_token):
    """Resolve a token hash to a still-valid grant, or return ``None``."""
    if not raw_token:
        return None
    grant = (
        ResearchContextGrant.objects.select_related(
            "workspace", "user", "project", "research_chain", "chain_node"
        )
        .filter(
            token_hash=hash_context_token(raw_token),
            deleted_at__isnull=True,
            revoked_at__isnull=True,
            expires_at__gt=timezone.now(),
            user__is_active=True,
        )
        .first()
    )
    return grant


def revoke_context_grant(*, workspace, context_id, actor):
    """Revoke a grant by context id; only the owner or an admin may do so."""
    grant = ResearchContextGrant.objects.filter(workspace=workspace, context_id=context_id).first()
    if grant is None:
        return None
    from plane.research.utils.roles import is_research_admin

    if grant.user_id != actor.id and not is_research_admin(actor, workspace.id):
        return False
    if grant.revoked_at is None:
        grant.revoked_at = timezone.now()
        grant.updated_by = actor
        grant.save(update_fields=["revoked_at", "updated_by", "updated_at"])
    return grant


class ResearchContextTokenAuthentication(BaseAuthentication):
    """Authenticate an external Agent with a scoped, short-lived token."""

    keyword = "ResearchContext"

    def authenticate(self, request):
        raw_token = request.headers.get(CONTEXT_TOKEN_HEADER)
        if not raw_token:
            return None
        grant = load_context_grant(raw_token)
        if grant is None:
            from rest_framework.exceptions import AuthenticationFailed

            raise AuthenticationFailed("Invalid or expired research context token.")
        return grant.user, grant

    def authenticate_header(self, request):
        return self.keyword
