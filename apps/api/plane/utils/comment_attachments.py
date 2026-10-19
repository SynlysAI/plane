"""工作项评论文件的作用域、草稿权限与事务关联。"""

from django.db.models import Q
from django.utils import timezone
from rest_framework.exceptions import ValidationError

from plane.db.models import FileAsset, IssueComment
from plane.utils.administrative_projects import administrative_organization_project_ids, effective_project_member
from plane.utils.workspace_access import user_can_access_workspace
from plane.utils.project_domains import project_domain_allows


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
