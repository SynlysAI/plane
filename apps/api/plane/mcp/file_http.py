"""通过短期凭据提供 HTTP 文件直传和下载，不暴露 MCP 长期密钥。"""

from urllib.parse import quote

from django.core import signing
from django.http import FileResponse
from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework.views import APIView

from plane.mcp.authorization import active_connection
from plane.mcp.files import HTTP_TTL_SECONDS, TOKEN_SALT, UnifiedFileService
from plane.mcp.file_storage import TransferStorage
from plane.research.services.mcp_catalog import ResearchReadError


class UnifiedFileHTTPEndpoint(APIView):
    """临时令牌只授权一个会话和一种方向，实时复核原连接权限。"""

    authentication_classes = []
    permission_classes = [AllowAny]
    throttle_classes = []
    parser_classes = []
    http_method_names = ["get", "put", "options"]

    def service(self, request, session_id, direction):
        """核对令牌的期限、会话、方向和连接密钥代次。"""
        # 强制执行 ALLOWED_HOSTS 校验，避免不可信 Host 影响对外发布的文件地址。
        request.get_host()
        try:
            state = signing.loads(request.query_params.get("credential", ""), salt=TOKEN_SALT, max_age=HTTP_TTL_SECONDS)
            connection = active_connection(state["connection"])
            if (
                connection is None
                or state["session"] != str(session_id)
                or state["direction"] != direction
                or state["credential_hash"] != connection.token_hash
            ):
                raise ValueError()
        except (signing.BadSignature, ValueError, KeyError, TypeError):
            raise ResearchReadError(
                "file_credential_invalid", "临时凭据已过期或失效，请通过 MCP 恢复会话获取新凭据。", 403
            ) from None
        return UnifiedFileService(connection, request=request)

    def get(self, request, session_id):
        """下载校验完成的不可变快照。"""
        service = self.service(request, session_id, "download")
        transfer, _ = service.session(session_id)
        if transfer.direction != "download" or transfer.state != "READY":
            raise ResearchReadError("download_not_ready", "下载快照尚未准备完成。", 409)
        storage = TransferStorage()
        obj = storage.client.get_object(Bucket=storage.bucket, Key=transfer.final_key)
        response = FileResponse(obj["Body"], content_type=transfer.content_type)
        response["Content-Length"] = str(transfer.size)
        response["Content-Disposition"] = "attachment; filename*=UTF-8''" + quote(transfer.file_name)
        response["X-File-SHA256"] = transfer.sha256
        return response

    def put(self, request, session_id):
        """接收 Agent 已有 HTTP 工具发送的原始文件字节。"""
        service = self.service(request, session_id, "upload")
        transfer, _ = service.session(session_id, write=True)
        if request.content_type != transfer.content_type:
            raise ResearchReadError("content_type_mismatch", "请使用准备接口返回的 Content-Type。", 422)
        return Response(service.receive_http(session_id, request.stream))

    def handle_exception(self, exc):
        """返回不携带临时凭据的可操作错误。"""
        if isinstance(exc, ResearchReadError):
            return Response({"error_code": exc.code, "message": str(exc)}, status=exc.status)
        return super().handle_exception(exc)

    def finalize_response(self, request, response, *args, **kwargs):
        """禁止浏览器缓存和引用页传播临时地址。"""
        response = super().finalize_response(request, response, *args, **kwargs)
        response["Cache-Control"] = "no-store"
        response["Referrer-Policy"] = "no-referrer"
        response["X-Content-Type-Options"] = "nosniff"
        return response
