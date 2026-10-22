"""统一预览地址与业务权限适配。"""

from types import SimpleNamespace

from django.db.models import Q
from django.conf import settings
from rest_framework.exceptions import NotFound, PermissionDenied
from plane.db.models import FileAsset, Issue, ReportAttachment
from plane.app.permissions import allow_permission, ROLE
from rest_framework.response import Response
from plane.utils.comment_attachments import can_access_comment_attachment
from plane.utils.project_domains import project_domain_allows
from plane.research.utils.config import research_module_enabled
from plane.preview.service import file_kind


def preview_url(asset):
    """返回资产预览入口；关闭功能时不暴露入口。"""
    if (
        not settings.ATTACHMENT_PREVIEW_ENABLED
        or not asset.workspace_id
        or file_kind(asset.attributes.get("name", "")) == "unsupported"
    ):
        return None
    return f"/api/assets/v2/workspaces/{asset.workspace.slug}/previews/assets/{asset.id}/"


def report_preview_url(attachment):
    """报告入口绑定附件登记，避免跨正式版本复用身份。"""
    if not settings.ATTACHMENT_PREVIEW_ENABLED or file_kind(attachment.file_name) == "unsupported":
        return None
    return f"/api/assets/v2/workspaces/{attachment.report.workspace.slug}/previews/reports/{attachment.id}/"


@allow_permission([ROLE.ADMIN, ROLE.MEMBER, ROLE.GUEST], research_review_read=True)
def _project_read(view, request, **kwargs):
    """复用工作项附件下载的项目角色判断。"""
    return True


def resolve_source(view, request, slug, source, source_id):
    """依据来源重新校验业务读取权限，返回已上传的源资产。

    Args:
        view: 当前预览视图。
        request: 已认证请求。
        slug: URL 工作区。
        source: reports 或 assets。
        source_id: 附件登记或文件资产 ID。

    Returns:
        当前用户允许读取的 FileAsset；拒绝时抛出 API 异常。
    """
    if source == "reports":
        if not research_module_enabled():
            raise NotFound()
        workspace, error = view.get_workspace(section="reports")
        if error:
            raise PermissionDenied()
        attachment = (
            ReportAttachment.all_objects.select_related("asset", "report")
            .filter(
                pk=source_id,
                report__workspace=workspace,
                report__deleted_at__isnull=True,
            )
            .filter(Q(deleted_at__isnull=True) | Q(official_version_no__isnull=False))
            .first()
        )
        if attachment is None:
            raise NotFound()
        from plane.app.views.asset.v2 import can_download_research_asset
        from plane.research.views.attachments import ResearchReportAttachmentDetailEndpoint

        _, error = ResearchReportAttachmentDetailEndpoint()._attachment(
            request, workspace, attachment.report_id, attachment.id, action="download"
        )
        if error or not can_download_research_asset(request.user, attachment.asset):
            raise NotFound()
        asset = attachment.asset
    else:
        asset = (
            FileAsset.objects.select_related("workspace")
            .filter(pk=source_id, workspace__slug=slug, is_uploaded=True, is_deleted=False)
            .first()
        )
        if asset is None:
            raise NotFound()
        if asset.entity_type == "COMMENT_ATTACHMENT":
            if not asset.comment_id or not can_access_comment_attachment(request.user, asset):
                raise NotFound()
        elif asset.entity_type == "ISSUE_ATTACHMENT":
            if (
                not asset.issue_id
                or not Issue.objects.filter(
                    pk=asset.issue_id, project_id=asset.project_id, workspace_id=asset.workspace_id
                ).exists()
            ):
                raise NotFound()
            if not project_domain_allows(request.user, slug, asset.project_id, write=False):
                raise PermissionDenied()
            result = _project_read(
                view, SimpleNamespace(user=request.user, method="GET"), slug=slug, project_id=asset.project_id
            )
            if isinstance(result, Response):
                raise PermissionDenied()
        elif asset.entity_type == "RESEARCH_TASK_COMMENT_ATTACHMENT":
            if not research_module_enabled():
                raise NotFound()
            from plane.research.utils.capabilities import NAV_RESEARCH_CHAIN
            from plane.research.views.chain_tasks import _task_context

            view.nav_capability = NAV_RESEARCH_CHAIN
            link = (
                asset.research_task_comment_attachments.filter(
                    deleted_at__isnull=True, comment__deleted_at__isnull=True, comment__task__deleted_at__isnull=True
                )
                .select_related("comment__task")
                .first()
            )
            if link is None:
                raise NotFound()
            task = link.comment.task
            workspace, _, _, _ = _task_context(view, request, slug, task.chain_id, task.node_id, task.id)
            if workspace is None or str(task.id) != asset.entity_identifier:
                raise NotFound()
        else:
            raise NotFound()
    if asset.is_deleted or asset.deleted_at or not asset.is_uploaded:
        raise NotFound()
    return asset
