"""Lifetimes for explicitly issued node MCP connections, separate from exchanges."""
from django.conf import settings

DEFAULT_NODE_MCP_TTL_SECONDS = 7 * 24 * 60 * 60


def node_mcp_token_ttl_seconds():
    return max(60, int(getattr(settings, "RESEARCH_MCP_NODE_TOKEN_TTL_SECONDS", DEFAULT_NODE_MCP_TTL_SECONDS)))
