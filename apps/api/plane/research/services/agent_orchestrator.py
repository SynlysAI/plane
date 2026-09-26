"""Automatic Synlora persona, plugin, tool and resource assembly."""

from dataclasses import asdict, dataclass

from django.utils import timezone

from plane.db.models import AccountLink, ResearchChainUpload
from plane.research.services.context_tokens import issue_context_token
from plane.research.services.synlora import SynloraClient, SynloraError

SYNLORA_PROVIDER = "SYNLORA"
PERSONA_BY_NODE_TYPE = {
    "LITERATURE_REVIEW": "research-literature",
    "RESEARCH_PLAN": "research-planning",
    "EXPERIMENT": "research-experiment",
    "ANALYSIS": "research-analysis",
    "GENERAL_RESEARCH": "research-general",
}
TOOLS_BY_NODE_TYPE = {
    "LITERATURE_REVIEW": frozenset({"knowledge.search", "knowledge.list"}),
    "RESEARCH_PLAN": frozenset({"knowledge.search", "knowledge.list", "file.read"}),
    "EXPERIMENT": frozenset({"file.read", "file.list", "file.write"}),
    "ANALYSIS": frozenset({"file.read", "file.list", "knowledge.search"}),
}
DEFAULT_TOOLS = frozenset({"knowledge.search", "knowledge.list", "file.read"})
REVIEW_TOOLS = frozenset({"knowledge.search", "knowledge.list", "file.read"})


@dataclass
class AgentAssembly:
    """The deterministic result shown to users and sent to Synlora."""

    persona: str
    enabled_plugins: list
    allowed_tools: list
    allowed_knowledge_base_ids: list
    allowed_file_ids: list
    unavailable_reasons: list
    policy_id: str
    scope_kind: str = "OWNER"
    scope_source: str = "chain_owner"
    policy_version: str = "research-agent-policy.v1"


def active_synlora_link(user):
    """Return the user's active Synlora AccountLink or ``None``."""
    return AccountLink.objects.filter(
        local_user=user,
        provider=SYNLORA_PROVIDER,
        status=AccountLink.Status.ACTIVE,
        deleted_at__isnull=True,
    ).first()


def _tool_policy(node_type):
    return TOOLS_BY_NODE_TYPE.get(str(node_type or "").upper(), DEFAULT_TOOLS)


def assemble_agent(*, node, manifest, scope_kind="OWNER", scope_source="chain_owner"):
    """Compute the defensive intersection without user-side scope controls."""
    tools = [
        str(item.get("name") or "") for item in (manifest.get("tools") or []) if str(item.get("name") or "").strip()
    ]
    registry = set(tools)
    requested = REVIEW_TOOLS if scope_kind == "REVIEW" else _tool_policy(node.node_type)
    final_tools = sorted(registry & requested)
    unavailable = []
    if not final_tools:
        unavailable.append("policy_blocked")
    for name in sorted(requested - registry):
        unavailable.append(f"tool_unavailable:{name}")
    plugins = [
        str(item.get("id") or "")
        for item in (manifest.get("plugins") or [])
        if item.get("auto_load") and item.get("health") == "OK"
    ]
    uploads = ResearchChainUpload.objects.filter(
        node=node,
        status__in=(
            ResearchChainUpload.Status.PENDING,
            ResearchChainUpload.Status.PROCESSING,
            ResearchChainUpload.Status.SUCCESS,
        ),
    ).order_by("-created_at")[:50]
    knowledge_ids = sorted({upload.knowledge_base_id for upload in uploads if upload.knowledge_base_id})
    file_ids = sorted({upload.external_upload_id for upload in uploads if upload.external_upload_id})
    persona = PERSONA_BY_NODE_TYPE.get(str(node.node_type or "").upper(), "research-general")
    return AgentAssembly(
        persona=persona,
        enabled_plugins=sorted(set(plugins)),
        allowed_tools=final_tools,
        allowed_knowledge_base_ids=knowledge_ids,
        allowed_file_ids=file_ids,
        unavailable_reasons=unavailable,
        policy_id=f"plane-node:{node.id}",
        scope_kind=scope_kind,
        scope_source=scope_source,
    )


def issue_agent_context(*, workspace, user, profile, node, assembly, request_id):
    """Issue a v2 Context grant from the auto assembly result."""
    return issue_context_token(
        workspace=workspace,
        user=user,
        profile=profile,
        chain_node=node,
        request_id=request_id,
        allowed_knowledge_base_ids=assembly.allowed_knowledge_base_ids,
        allowed_file_ids=assembly.allowed_file_ids,
        allowed_plugins=assembly.enabled_plugins,
        allowed_tools=assembly.allowed_tools,
        policy_id=assembly.policy_id,
        scope_kind=assembly.scope_kind,
        scope_source=assembly.scope_source,
        policy_version=assembly.policy_version,
    )


def context_metadata(*, workspace, profile, node, grant, assembly):
    """Build the metadata sent to Synlora; no token is included."""
    return {
        "schema_version": "agent-context.v2",
        "workspace_id": str(workspace.id),
        "workspace_slug": workspace.slug,
        "research_project_id": str(profile.project_id),
        "chain_node_id": str(node.id),
        "context_id": str(grant.context_id),
        "context_hash": grant.context_hash,
        "visibility_scope": grant.visibility_scope,
        "expires_at": grant.expires_at.isoformat(),
        "allowed_knowledge_base_ids": grant.allowed_knowledge_base_ids,
        "allowed_file_ids": grant.allowed_file_ids,
        "allowed_plugins": grant.allowed_plugins,
        "allowed_tools": grant.allowed_tools,
        "policy_id": grant.policy_id,
        "policy_hash": grant.policy_hash,
        "scope_kind": grant.scope_kind,
        "scope_source": grant.scope_source,
        "policy_version": grant.policy_version,
    }


def create_synlora_session(
    *, workspace, user, node, request_id, client=None, scope_kind="OWNER", scope_source="chain_owner"
):
    """Run the complete fail-closed Synlora session assembly pipeline."""
    link = active_synlora_link(user)
    if link is None:
        raise SynloraError("synlora_account_link_inactive", "An active Synlora account link is required.", 403)
    synlora = client or SynloraClient()
    delegated = synlora.exchange_delegated_token(account_link=link, workspace=workspace, user=user)
    token = str(delegated.get("token") or "")
    if not token:
        raise SynloraError("synlora_delegated_auth_failed", "Synlora delegated token exchange failed.", 502)
    manifest = synlora.capabilities(token)
    assembly = assemble_agent(node=node, manifest=manifest, scope_kind=scope_kind, scope_source=scope_source)
    profile = node.chain.project.research_profile
    grant, context_token = issue_agent_context(
        workspace=workspace,
        user=user,
        profile=profile,
        node=node,
        assembly=assembly,
        request_id=f"agent:{request_id}",
    )
    metadata = context_metadata(workspace=workspace, profile=profile, node=node, grant=grant, assembly=assembly)
    remote = synlora.create_session(
        delegated_token=token,
        context_token=context_token,
        payload={
            "title": f"{profile.project.name} · {node.title}"[:120],
            "enabled_plugins": assembly.enabled_plugins,
            "research_context": metadata,
        },
    )
    remote_session_id = str(remote.get("_id") or remote.get("id") or "")
    if not remote_session_id:
        grant.revoked_at = timezone.now()
        grant.save(update_fields=["revoked_at", "updated_at"])
        raise SynloraError("synlora_session_failed", "Synlora did not return a session id.", 502)
    return {
        "grant": grant,
        "context_metadata": metadata,
        "delegated_token": token,
        "delegated_subject": str(delegated.get("subject") or link.external_subject),
        "synlora_session_id": remote_session_id,
        "assembly": asdict(assembly),
    }
