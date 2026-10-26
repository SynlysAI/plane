"""Automatic Synlora persona, plugin, tool and resource assembly."""

from dataclasses import asdict, dataclass
from urllib.parse import quote, urlsplit

from django.conf import settings
from django.utils import timezone

from plane.db.models import ResearchChainUpload
from plane.research.services.context_tokens import issue_context_token
from plane.research.services.sciencediscovery import ScienceDiscoveryClient, ScienceDiscoveryError
from plane.research.services.specialist_catalog import specialist_id_for_node

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

# ScienceDiscovery 的桥接工具面（read_file/list_files 由 SD 会话工作区原生提供）。
# General SD workspace tools; research tools use a separate scoped connector.
SCIENCE_DISCOVERY_MANIFEST = {
    "tools": [{"name": "read_file"}, {"name": "list_files"}],
    "plugins": [],
}


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


def issue_agent_context(*, workspace, user, profile, node, assembly, request_id, allowed_reports=None):
    """Issue a v2 Context grant from the auto assembly result."""
    return issue_context_token(
        workspace=workspace,
        user=user,
        profile=profile,
        chain_node=node,
        request_id=request_id,
        allowed_knowledge_base_ids=assembly.allowed_knowledge_base_ids,
        allowed_file_ids=assembly.allowed_file_ids,
        allowed_reports=allowed_reports,
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
        "allowed_reports": grant.allowed_reports,
        "allowed_plugins": grant.allowed_plugins,
        "allowed_tools": grant.allowed_tools,
        "policy_id": grant.policy_id,
        "policy_hash": grant.policy_hash,
        "scope_kind": grant.scope_kind,
        "scope_source": grant.scope_source,
        "policy_version": grant.policy_version,
    }



def create_science_discovery_session(
    *,
    workspace,
    user,
    node,
    request_id,
    client=None,
    connection=None,
    scope_kind="OWNER",
    scope_source="chain_owner",
):
    """Run the fail-closed ScienceDiscovery session assembly pipeline.

    Mirrors :func:`create_synlora_session` but needs no delegated token: the
    single-user SD instance is addressed by the server-side bearer token only.
    """
    science_discovery = client or ScienceDiscoveryClient(connection=connection)
    if not science_discovery.configured:
        raise ScienceDiscoveryError(
            "science_discovery_not_configured",
            "ScienceDiscovery runtime is not configured.",
        )
    assembly = assemble_agent(
        node=node,
        manifest=SCIENCE_DISCOVERY_MANIFEST,
        scope_kind=scope_kind,
        scope_source=scope_source,
    )
    profile = node.chain.project.research_profile
    research_enabled = bool(getattr(settings, "RESEARCH_MCP_ENABLED", False)) and bool(
        getattr(settings, "SCIENCE_DISCOVERY_RESEARCH_MCP_ENABLED", True)
    )
    report_selections = None
    if research_enabled:
        from plane.research.services.chain_context import node_report_selections
        from plane.research.services.mcp_catalog import TOOL_NAMES

        assembly.allowed_tools = sorted(TOOL_NAMES)
        assembly.unavailable_reasons = []
        assembly.policy_version = "research-mcp.read.v1"
        report_selections = node_report_selections(workspace, user, node)
    grant, context_token = issue_agent_context(
        workspace=workspace,
        user=user,
        profile=profile,
        node=node,
        assembly=assembly,
        request_id=f"agent:{request_id}",
        allowed_reports=report_selections,
    )
    project_name = f"plane-{str(profile.project_id)[:8]}-{profile.project.name}"[:120]
    research_binding = None
    try:
        if research_enabled:
            origin = str(getattr(settings, "RESEARCH_MCP_PUBLIC_BASE_URL", "") or "").rstrip("/")
            try:
                parts = urlsplit(origin)
                valid = (parts.scheme in {"http", "https"} and parts.hostname
                         and parts.username is None and parts.password is None and not parts.query and not parts.fragment
                         and parts.path in ("", "/") and parts.port != 0
                         and not any(char.isspace() for char in origin))
            except ValueError:
                valid = False
            if not valid:
                raise ScienceDiscoveryError("research_mcp_not_configured", "Set a backend RESEARCH_MCP_PUBLIC_BASE_URL reachable from ScienceDiscovery.", 503)
            research_binding = science_discovery.create_research_connector(
                workspace=workspace, user=user, grant=grant, token=context_token,
                url=f"{origin}/api/research/workspaces/{quote(workspace.slug, safe='')}/agent-access/mcp/",
            )
        sd_project_id = science_discovery.create_project(name=project_name)
        # 专业智能体开箱即用：按节点类型幂等下发目录并取 specialistId（§10）。
        # 下发失败不阻断会话——SD 默认人设兜底。
        specialist_id = specialist_id_for_node(science_discovery, node.node_type)
        sd_session_id = science_discovery.create_session(
            project_id=sd_project_id,
            title=f"{profile.project.name} · {node.title}"[:120],
            **({"specialist_id": specialist_id} if specialist_id else {}),
            **({"connector_ids": [research_binding["source_id"]]} if research_binding else {}),
        )
    except ScienceDiscoveryError:
        grant.revoked_at = timezone.now()
        grant.save(update_fields=["revoked_at", "updated_at"])
        if research_binding:
            try:
                science_discovery.remove_research_connector(research_binding["server_id"])
            except ScienceDiscoveryError:
                pass
        raise
    return {
        "grant": grant,
        "sd_project_id": sd_project_id,
        "sd_session_id": sd_session_id,
        "assembly": {**asdict(assembly), **({"research_mcp": research_binding} if research_binding else {})},
    }
