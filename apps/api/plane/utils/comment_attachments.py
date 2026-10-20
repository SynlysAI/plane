"""工作项评论文件的作用域、草稿权限与事务关联。"""

from dataclasses import dataclass
import os

from django.db.models import Q
from django.utils import timezone
from rest_framework.exceptions import ValidationError

from plane.db.models import FileAsset, IssueComment
from plane.research.utils.settings import get_workspace_research_settings
from plane.utils.administrative_projects import administrative_organization_project_ids, effective_project_member
from plane.utils.workspace_access import user_can_access_workspace
from plane.utils.project_domains import project_domain_allows


@dataclass(frozen=True)
class CommentAttachmentSizeLimit:
    """评论附件某一分类的有效上传额度。"""

    category: str
    max_mb: int
    max_bytes: int


def comment_attachment_limits(workspace):
    """读取工作区科研平台设置中的四类评论附件额度。

    Args:
        workspace: 评论附件所属项目的工作区。

    Returns:
        以 image、pdf、markdown、office 为键的 MB 与字节限额。
    """
    settings = get_workspace_research_settings(workspace)
    return {
        "image": settings["image_max_mb"],
        "pdf": settings["pdf_max_mb"],
        "markdown": settings["markdown_max_mb"],
        "office": settings["office_max_mb"],
    }


def resolve_comment_attachment_limit(file_name, content_type, limits):
    """按文件名和 MIME 解析评论附件所属分类及额度。

    该函数只决定额度，不放宽 ``ATTACHMENT_MIME_TYPES`` 白名单；除图片、
    PDF 和 Markdown 外的已允许格式统一使用办公及其他附件额度。

    Args:
        file_name: 请求提供的文件名。
        content_type: 请求或浏览器签名检测得到的 MIME 类型。
        limits: 四类平台的 MB 额度。

    Returns:
        包含分类、MB 额度与字节额度的对象。

    Raises:
        ValueError: 平台设置中存在无效额度时抛出。
    """
    extension = os.path.splitext(str(file_name or ""))[1].lower()
    normalized_type = str(content_type or "").split(";", 1)[0].strip().lower()
    if extension == ".pdf" or normalized_type == "application/pdf":
        category = "pdf"
    elif extension in {".md", ".markdown"} or normalized_type in {"text/markdown", "text/x-markdown"}:
        category = "markdown"
    elif normalized_type.startswith("image/") or extension in {".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"}:
        category = "image"
    else:
        category = "office"
    try:
        max_mb = int(limits[category])
        if max_mb < 0:
            raise ValueError
    except (KeyError, TypeError, ValueError) as error:
        raise ValueError(f"Invalid {category} comment attachment limit.") from error
    return CommentAttachmentSizeLimit(category=category, max_mb=max_mb, max_bytes=max_mb * 1024 * 1024)


def can_access_comment_attachment(user, asset, *, mutate=False):
    """判断评论文件是否可读取，或作为本人未发布草稿被修改。

    Args:
        user: 当前用户。
        asset: 待访问的文件。
        mutate: 是否请求直接修改底层文件。

    Returns:
        有权执行对应操作时返回 True。
    """
    if asset.is_deleted or asset.deleted_at or not asset.issue_id or not asset.project_id:
        return False
    slug = asset.workspace.slug
    if not user_can_access_workspace(user, workspace_slug=slug):
        return False
    if not project_domain_allows(user, slug, asset.project_id, write=mutate):
        return False
    member = effective_project_member(user, slug, asset.project_id)
    if member is None and not (
        not mutate and administrative_organization_project_ids(user, slug).filter(id=asset.project_id).exists()
    ):
        return False
    if not asset.comment_id:
        return asset.created_by_id == user.id
    if mutate:
        # 已发布附件只能通过评论事务增删，不能绕过评论作者权限直接改文件。
        return False
    return IssueComment.objects.filter(
        id=asset.comment_id,
        issue_id=asset.issue_id,
        project_id=asset.project_id,
        workspace_id=asset.workspace_id,
        project__archived_at__isnull=True,
    ).exists()


def lock_comment_attachments(attachment_ids, *, issue, user, comment=None):
    """锁定并校验附件，拒绝跨任务、他人草稿和重复关联。

    Args:
        attachment_ids: 本次保存的完整附件 ID 列表。
        issue: 目标工作项。
        user: 当前操作者。
        comment: 编辑时的目标评论，创建时为空。

    Returns:
        已按固定顺序加锁、可用于本次保存的文件列表。
    """
    if len(attachment_ids) > 10 or len(set(attachment_ids)) != len(attachment_ids):
        raise ValidationError({"attachment_ids": "每条评论最多附加 10 个不同文件。"})
    allowed = Q(comment__isnull=True, created_by=user)
    if comment is not None:
        allowed |= Q(comment=comment)
    assets = list(
        FileAsset.objects.select_for_update()
        .filter(
            allowed,
            id__in=attachment_ids,
            entity_type=FileAsset.EntityTypeContext.COMMENT_ATTACHMENT,
            workspace_id=issue.workspace_id,
            project_id=issue.project_id,
            issue=issue,
            is_uploaded=True,
            is_deleted=False,
        )
        .order_by("id")
    )
    if len(assets) != len(attachment_ids):
        raise ValidationError({"attachment_ids": "附件未上传完成、已失效或不属于当前评论。"})
    return assets


def sync_comment_attachments(comment, assets, user):
    """在调用方事务中关联新文件，并停用从评论移除的文件。

    Args:
        comment: 已保存的评论。
        assets: 已锁定且验证通过的目标文件集合。
        user: 当前操作者。
    """
    ids = [asset.id for asset in assets]
    comment.assets.filter(entity_type=FileAsset.EntityTypeContext.COMMENT_ATTACHMENT).exclude(id__in=ids).update(
        is_deleted=True,
        deleted_at=timezone.now(),
        updated_by=user,
    )
    FileAsset.objects.filter(id__in=ids).update(comment=comment, updated_by=user)
    getattr(comment, "_prefetched_objects_cache", {}).pop("assets", None)
