"""始终鉴权的预览状态和内容接口。"""

import re
from django.conf import settings
from django.http import HttpResponse, StreamingHttpResponse
from rest_framework.exceptions import NotFound
from rest_framework.response import Response
from plane.research.views.base import ResearchAPIView
from plane.preview.access import resolve_source
from plane.preview.service import PERMANENT_ERRORS, PreviewError, file_kind, get_preview
from plane.settings.storage import S3Storage


def byte_range(value, size):
    """解析单段 HTTP Range，拒绝无效及多段范围。

    Args:
        value: Range 请求头。
        size: 对象字节数。

    Returns:
        起止字节（含末尾），无范围时返回 None。
    """
    if not value:
        return None
    match = re.fullmatch(r"bytes=(\d*)-(\d*)", value)
    if not match or not any(match.groups()):
        raise ValueError("Invalid range")
    first, last = match.groups()
    if first:
        start, end = int(first), min(int(last), size - 1) if last else size - 1
    else:
        start, end = max(0, size - int(last)), size - 1
    if start > end or start >= size:
        raise ValueError("Unsatisfiable range")
    return start, end


class AttachmentPreviewEndpoint(ResearchAPIView):
    """在源业务授权下创建、查询及读取附件预览。"""

    research_module_required = False

    def get(self, request, slug, source, source_id, content=False):
        """查询状态或有界流式读取当前源版本对应的派生内容。"""
        return self._respond(request, slug, source, source_id, content=content)

    def post(self, request, slug, source, source_id, content=False):
        """按需创建或重试预览，不修改源文件。"""
        if content:
            return Response(status=405)
        return self._respond(request, slug, source, source_id, create=True)

    def _respond(self, request, slug, source, source_id, *, content=False, create=False):
        """统一功能开关、业务鉴权、状态与错误响应。"""
        if not settings.ATTACHMENT_PREVIEW_ENABLED:
            return Response({"status": "unsupported", "error_code": "preview_disabled"}, status=503)
        asset = resolve_source(self, request, slug, source, source_id)
        try:
            preview = get_preview(asset, create=create, retry=bool(request.data.get("retry")) if create else False)
            if content:
                if preview is None or preview.status != "ready":
                    raise NotFound()
                return self._content(request, preview)
            state = preview.status if preview else "pending"
            return Response(
                {
                    "status": state,
                    "kind": preview.kind if preview else file_kind(asset.attributes.get("name", "")),
                    "error_code": preview.error_code if preview else "",
                    "retryable": bool(preview and state == "failed" and preview.error_code not in PERMANENT_ERRORS),
                    "content_url": request.path.rstrip("/") + "/content/" if state == "ready" else None,
                },
                headers={"Cache-Control": "private, no-store"},
            )
        except PreviewError as error:
            return Response(
                {"status": "failed", "error_code": str(error), "retryable": str(error) not in PERMANENT_ERRORS},
                status=422,
            )

    @staticmethod
    def _content(request, preview):
        """读取私有对象，不向客户端暴露可复用的对象存储签名。"""
        try:
            selected = byte_range(request.headers.get("Range"), preview.size)
        except ValueError:
            return HttpResponse(status=416, headers={"Content-Range": f"bytes */{preview.size}"})
        storage = S3Storage()
        args = {"Bucket": storage.aws_storage_bucket_name, "Key": preview.object_key}
        if selected:
            args["Range"] = f"bytes={selected[0]}-{selected[1]}"
        try:
            result = storage.server_s3_client.get_object(**args)
        except Exception as error:
            raise NotFound() from error
        body = result["Body"]

        def chunks():
            """消费者结束或断连时释放存储连接。"""
            try:
                while chunk := body.read(64 * 1024):
                    yield chunk
            finally:
                body.close()

        response = StreamingHttpResponse(chunks(), status=206 if selected else 200, content_type=preview.content_type)
        response._resource_closers.append(body.close)
        response["Cache-Control"] = "private, no-store"
        response["X-Content-Type-Options"] = "nosniff"
        response["Content-Security-Policy"] = "default-src 'none'; sandbox"
        response["Accept-Ranges"] = "bytes"
        response["Content-Length"] = selected[1] - selected[0] + 1 if selected else preview.size
        if selected:
            response["Content-Range"] = f"bytes {selected[0]}-{selected[1]}/{preview.size}"
        return response
