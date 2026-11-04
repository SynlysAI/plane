"""MCP Streamable HTTP 端点共享的协议兼容工具。"""

DEFAULT_PROTOCOL = "2025-06-18"
SUPPORTED_PROTOCOLS = ("2025-03-26", "2025-06-18")
JSON_ACCEPT_PRECEDENCE = {"application/json": 3, "application/*": 2, "*/*": 1}


def _json_accept_quality(item):
    """解析一个 Accept 媒体项对 JSON 响应的匹配优先级和质量。

    Args:
        item: 逗号分隔前的单个 Accept 媒体项，可包含 ``q`` 参数。

    Returns:
        ``(匹配优先级, 质量)``；不匹配 JSON 或质量参数非法时返回 None。
    """
    media, *parameters = item.split(";")
    quality = 1.0
    for parameter in parameters:
        name, separator, value = parameter.strip().partition("=")
        if separator and name.strip().lower() == "q":
            try:
                quality = float(value)
            except ValueError:
                return None
            if not 0.0 <= quality <= 1.0:
                return None
    precedence = JSON_ACCEPT_PRECEDENCE.get(media.strip().lower())
    return (precedence, quality) if precedence is not None else None


def accepts_json_response(request, require_header=True):
    """检查客户端是否能接收此 MCP 端点返回的 JSON 响应。

    Args:
        request: 已通过机器凭据认证的 Django/DRF 请求。
        require_header: 是否要求客户端显式携带 Accept 头。

    Returns:
        Accept 头显式或通过通配符支持 ``application/json`` 时返回 True；
        同时支持 SSE 的既有客户端仍会因包含 JSON 而通过；对原本不校验
        Accept 的旧入口，可设置 ``require_header=False`` 以继续接受省略头。
    """
    offered = [item for item in request.headers.get("Accept", "").split(",") if item.strip()]
    if not require_header and not offered:
        return True
    matches = [match for match in (_json_accept_quality(item) for item in offered) if match is not None]
    if not matches:
        return False
    # 精确媒体类型的质量覆盖通配符，因此 application/json;q=0 不能被 */* 放行。
    best = max(matches, key=lambda value: (value[0], value[1]))
    return best[1] > 0


def protocol_header_valid(request, message=None):
    """校验可选的 MCP 协议版本头，不将其与初始化参数强耦合。

    Args:
        request: 已通过机器凭据认证的 Django/DRF 请求。
        message: 已解析的 JSON-RPC 消息；initialize 的版本以请求参数为准。

    Returns:
        Header 省略或为受支持版本时返回 True；后续请求显式携带不受支持
        版本时返回 False。部分客户端会在 initialize 上提前注入未来版本
        Header，此时等待参数协商结果，不用传输层 Header 拦截。
    """
    version = request.headers.get("MCP-Protocol-Version")
    if not version or version in SUPPORTED_PROTOCOLS:
        return True
    return isinstance(message, dict) and message.get("method") == "initialize"


def negotiate_protocol(version):
    """为 initialize 响应选择一个服务端支持的 MCP 协议版本。

    Args:
        version: 客户端请求的协议版本；较新客户端可能先提交服务端未知版本。

    Returns:
        请求版本受支持时返回原值；未知或更新版本返回服务端支持的最新版本。
    """
    return version if version in SUPPORTED_PROTOCOLS else DEFAULT_PROTOCOL
