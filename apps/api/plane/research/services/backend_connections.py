"""User-level runtime backend connection validation and routing (§5)."""

import ipaddress
import socket
from urllib.parse import urlparse

from django.conf import settings

from plane.db.models import ResearchAgentBackendConnection, WorkspaceResearchSetting


class BackendConnectionError(ValueError):
    """Raised when a self-service backend URL fails SSRF validation."""


def validate_backend_base_url(base_url):
    """Validate one user-supplied SD base URL against the SSRF policy.

    Args:
        base_url: The candidate ``http(s)://host[:port]`` string.

    Raises:
        BackendConnectionError: On unsafe scheme, host or resolved address.
    """
    parsed = urlparse(str(base_url or ""))
    if parsed.scheme not in ("http", "https"):
        raise BackendConnectionError("Only http/https base URLs are allowed.")
    host = (parsed.hostname or "").strip()
    if not host:
        raise BackendConnectionError("The base URL must include a host.")
    try:
        infos = socket.getaddrinfo(host, None)
    except socket.gaierror as exc:
        raise BackendConnectionError("The base URL host could not be resolved.") from exc
    allowed = [ipaddress.ip_network(cidr) for cidr in getattr(settings, "SCIENCE_DISCOVERY_ALLOWED_CIDRS", [])]
    allow_loopback = bool(getattr(settings, "SCIENCE_DISCOVERY_ALLOW_LOOPBACK", False))
    for info in infos:
        address = ipaddress.ip_address(info[4][0])
        if address.is_loopback and allow_loopback:
            continue
        if address.is_loopback:
            raise BackendConnectionError("Loopback addresses are not allowed for self-service backends.")
        # 169.254.0.0/16（含云 metadata 169.254.169.254）与 fe80::/10 均属 link-local。
        if address.is_link_local or address.is_multicast or address.is_reserved or address.is_unspecified:
            raise BackendConnectionError("This address class is not allowed for self-service backends.")
        if allowed and not any(address in network for network in allowed):
            raise BackendConnectionError("The resolved address is outside the allowed network ranges.")


def resolve_science_discovery_connection(workspace, user):
    """Resolve the user's pinned ScienceDiscovery connection for new sessions.

    Args:
        workspace: The visible workspace.
        user: The requesting member.

    Returns:
        An enabled ``ResearchAgentBackendConnection`` or ``None`` (fallback to
        the platform default runtime). Routing honours the workspace governance
        switch and never silently switches on reachability (§5).
    """
    setting = WorkspaceResearchSetting.objects.filter(workspace=workspace).first()
    if setting is None or not setting.research_agent_user_backend_enabled:
        return None
    return (
        ResearchAgentBackendConnection.objects.filter(
            workspace=workspace,
            user=user,
            is_enabled=True,
        )
        .order_by("-created_at")
        .first()
    )
