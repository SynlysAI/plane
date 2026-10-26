"""始终鉴权的预览状态和内容接口。"""

from django.conf import settings
from rest_framework.exceptions import NotFound
from rest_framework.response import Response
from plane.research.views.base import ResearchAPIView
from plane.preview.access import resolve_source
from plane.preview.content import byte_range, stream_preview_content
from plane.preview.service import PERMANENT_ERRORS, PreviewError, file_kind, get_preview

__all__ = ["AttachmentPreviewEndpoint", "byte_range", "stream_preview_content"]


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
                return stream_preview_content(request, preview)
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
