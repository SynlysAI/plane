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


def issue_context_token(
    *,
    workspace,
    user,
    profile,
    chain_node=None,
    request_id,
):
    """Create a one-time displayed token and its revocable database grant."""
    if not request_id:
        raise ValueError("request_id is required")
    raw_token = secrets.token_urlsafe(48)
    visibility_scope = profile.chain_visibility
    context_hash = context_hash_for(
        workspace_id=workspace.id,
        user_id=user.id,
        project_id=profile.project_id,
        chain_node_id=chain_node.id if chain_node else None,
        visibility_scope=visibility_scope,
    )
    ttl_seconds = max(60, int(getattr(settings, "RESEARCH_CONTEXT_TOKEN_TTL_SECONDS", 600)))
    grant = ResearchContextGrant.objects.create(
        workspace=workspace,
        user=user,
        project_id=profile.project_id,
        chain_node=chain_node,
        visibility_scope=visibility_scope,
        context_hash=context_hash,
        token_hash=hash_context_token(raw_token),
        expires_at=timezone.now() + timedelta(seconds=ttl_seconds),
        request_id=request_id,
        created_by=user,
    )
    return grant, raw_token


def load_context_grant(raw_token):
    """Resolve a token hash to a still-valid grant, or return ``None``."""
    if not raw_token:
        return None
    grant = (
        ResearchContextGrant.objects.select_related("workspace", "user", "project", "chain_node")
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
    from plane.research.utils.org import is_workspace_admin

    if grant.user_id != actor.id and not is_workspace_admin(actor, workspace.id):
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
