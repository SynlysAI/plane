"""User-level runtime backend connection validation and routing (§5)."""

import ipaddress
import socket
from urllib.parse import urlparse

from django.conf import settings

from plane.db.models import ResearchAgentBackendConnection, WorkspaceResearchSetting

_LOOPBACK_HOSTS = {"localhost", "127.0.0.1", "::1"}
_LOOPBACK_UNAVAILABLE_MESSAGE = "本机地址需要管理员开启转发，或改填 Plane 可访问的内网地址。"


class BackendConnectionError(ValueError):
    """Raised when a self-service backend URL fails SSRF validation."""


def _is_loopback_host(host):
    """判断 host 是否为回环地址（含 localhost）。

    Args:
        host: URL hostname，不含端口。

    Returns:
        是否为本机回环。
    """
    normalized = (host or "").strip().lower().rstrip(".")
    if normalized in _LOOPBACK_HOSTS:
        return True
    try:
        return ipaddress.ip_address(normalized).is_loopback
    except ValueError:
        return False


def _parse_backend_url(base_url):
    """解析并校验 scheme 与 host。

    Args:
        base_url: 候选地址。

    Returns:
        ``(parsed, host)``。

    Raises:
        BackendConnectionError: scheme 或 host 不合法。
    """
    parsed = urlparse(str(base_url or "").strip())
    if parsed.scheme not in ("http", "https"):
        raise BackendConnectionError("Only http/https base URLs are allowed.")
    host = (parsed.hostname or "").strip()
    if not host:
        raise BackendConnectionError("The base URL must include a host.")
    return parsed, host


def resolve_backend_request_url(base_url):
    """把用户填写的 SD 地址解析成 Plane 服务端实际请求的地址。

    回环地址（127.0.0.1 / localhost / ::1）在配置了
    ``SCIENCE_DISCOVERY_LOOPBACK_UPSTREAM`` 时改写为该上游；否则仅在
    ``SCIENCE_DISCOVERY_ALLOW_LOOPBACK`` 开启时原样返回。

    Args:
        base_url: 用户保存的 ``http(s)://host[:port]``。

    Returns:
        实际请求用的 base URL（无尾斜杠）。

    Raises:
        BackendConnectionError: scheme/host 不合法，或回环且未配置转发。
    """
    _parsed, host = _parse_backend_url(base_url)
    normalized = str(base_url or "").strip().rstrip("/")
    if not _is_loopback_host(host):
        return normalized
    upstream = str(getattr(settings, "SCIENCE_DISCOVERY_LOOPBACK_UPSTREAM", "") or "").strip().rstrip("/")
    if upstream:
        return upstream
    if bool(getattr(settings, "SCIENCE_DISCOVERY_ALLOW_LOOPBACK", False)):
        return normalized
    raise BackendConnectionError(_LOOPBACK_UNAVAILABLE_MESSAGE)


def validate_backend_base_url(base_url):
    """Validate one user-supplied SD base URL against the SSRF policy.

    Args:
        base_url: The candidate ``http(s)://host[:port]`` string.

    Raises:
        BackendConnectionError: On unsafe scheme, host or resolved address.
    """
    request_url = resolve_backend_request_url(base_url)
    _parsed, host = _parse_backend_url(request_url)
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
            raise BackendConnectionError(_LOOPBACK_UNAVAILABLE_MESSAGE)
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
