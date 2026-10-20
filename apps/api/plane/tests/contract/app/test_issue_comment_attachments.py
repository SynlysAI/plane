"""工作项评论附件的上传、事务关联与权限契约。"""

from unittest.mock import patch
from uuid import uuid4

import pytest
from datetime import timedelta
from django.utils import timezone
from django.test import override_settings
from rest_framework.test import APIClient

from plane.db.models import (
    FileAsset,
    Issue,
    IssueComment,
    Project,
    ProjectMember,
    ResearchProjectProfile,
    State,
    User,
    Workspace,
    WorkspaceMember,
    WorkspaceResearchSetting,
)

PPTX_TYPE = "application/vnd.openxmlformats-officedocument.presentationml.presentation"
MEGABYTE = 1024 * 1024


@pytest.fixture
def comment_context(workspace, create_user):
    """创建普通项目及已完成工作项，隔离异步活动与存储调用。"""
    project = Project.objects.create(workspace=workspace, name="过程材料", identifier="FILES", network=0)
    ProjectMember.objects.create(workspace=workspace, project=project, member=create_user, role=20)
    state = State.objects.create(workspace=workspace, project=project, name="完成", group="completed")
    issue = Issue.objects.create(workspace=workspace, project=project, state=state, name="完成后补充文件")
    with (
        patch("plane.app.views.issue.comment.issue_activity.delay"),
        patch("plane.app.views.issue.comment.model_activity.delay"),
        patch("plane.db.mixins.soft_delete_related_objects.delay"),
        patch("plane.app.views.asset.v2.get_asset_object_metadata.delay"),
    ):
        yield workspace, project, issue, create_user


def comments_url(context, comment_id=None):
    """返回评论集合或详情地址。"""
    workspace, project, issue, _ = context
    suffix = f"{comment_id}/" if comment_id else ""
    return f"/api/workspaces/{workspace.slug}/projects/{project.id}/issues/{issue.id}/comments/{suffix}"


def upload_url(context):
    """返回项目资产上传地址。"""
    workspace, project, _, _ = context
    return f"/api/assets/v2/workspaces/{workspace.slug}/projects/{project.id}/"


def limits_url(context):
    """返回项目级评论附件额度地址。"""
    workspace, project, _, _ = context
    return f"/api/assets/v2/workspaces/{workspace.slug}/projects/{project.id}/comment-attachment-limits/"


def configure_limits(workspace, image=1, pdf=2, markdown=3, office=4):
    """为工作区写入四类科研平台上传额度。"""
    return WorkspaceResearchSetting.objects.update_or_create(
        workspace=workspace,
        defaults={
            "image_max_mb": image,
            "pdf_max_mb": pdf,
            "markdown_max_mb": markdown,
            "office_max_mb": office,
        },
    )[0]


def make_asset(context, **overrides):
    """创建已完成上传、尚未关联评论的过程文件。"""
    workspace, project, issue, user = context
    data = dict(
        workspace=workspace,
        project=project,
        issue=issue,
        created_by=user,
        entity_type="COMMENT_ATTACHMENT",
        is_uploaded=True,
        size=128,
        asset=f"{workspace.id}/{uuid4()}.pptx",
        attributes={"name": "过程汇报.pptx", "type": PPTX_TYPE, "size": 128},
    )
    data.update(overrides)
    asset = FileAsset(**data)
    asset.save(disable_auto_set_user=True)
    return asset


@pytest.mark.django_db
@pytest.mark.parametrize(
    ("file_name", "submitted_type", "expected_type"),
    [
        ("clash-verge_1.3.8_amd64.deb", "application/x-deb", "application/x-deb"),
        ("installer.exe", "application/x-msdownload", "application/x-msdownload"),
        (
            "dataset.custom",
            "  Application/X-AI4MS-Dataset; charset=utf-8  ",
            "application/x-ai4ms-dataset",
        ),
        ("unknown.bin", "", "application/octet-stream"),
    ],
)
def test_comment_attachment_accepts_any_file_type(
    session_client,
    comment_context,
    file_name,
    submitted_type,
    expected_type,
):
    """评论文件不限制后缀和 MIME，仅继续使用分类大小额度。"""
    _, _, issue, _ = comment_context
    configure_limits(comment_context[0], office=50)
    payload = {
        "name": file_name,
        "type": submitted_type,
        "size": 34 * MEGABYTE,
        "entity_type": "COMMENT_ATTACHMENT",
        "entity_identifier": str(issue.id),
    }
    with patch("plane.app.views.asset.v2.S3Storage") as storage:
        storage.return_value.generate_presigned_post.return_value = {
            "url": "https://storage.test",
            "fields": {},
        }
        response = session_client.post(upload_url(comment_context), payload, format="json")

    assert response.status_code == 200, response.data
    asset = FileAsset.objects.get(id=response.data["asset_id"])
    assert asset.attributes["type"] == expected_type
    assert asset.size == payload["size"]
    storage.return_value.generate_presigned_post.assert_called_once_with(
        object_name=asset.asset.name,
        file_type=expected_type,
        file_size=50 * MEGABYTE,
    )


@pytest.mark.django_db
def test_upload_pptx_and_keep_image_endpoints_restricted(session_client, comment_context):
    """仅评论文件类型放行 PPTX，保持图片上传约束。"""
    _, _, issue, _ = comment_context
    payload = {
        "name": "过程汇报.pptx",
        "type": PPTX_TYPE,
        "size": 128,
        "entity_type": "COMMENT_ATTACHMENT",
        "entity_identifier": str(issue.id),
    }
    with patch("plane.app.views.asset.v2.S3Storage") as storage:
        storage.return_value.generate_presigned_post.return_value = {"url": "https://storage.test", "fields": {}}
        response = session_client.post(upload_url(comment_context), payload, format="json")
    assert response.status_code == 200
    asset = FileAsset.objects.get(id=response.data["asset_id"])
    assert asset.issue_id == issue.id
    assert asset.comment_id is None
    assert not asset.is_uploaded
    assert (
        session_client.post(
            upload_url(comment_context),
            {**payload, "entity_type": "COMMENT_DESCRIPTION", "entity_identifier": ""},
            format="json",
        ).status_code
        == 400
    )
    for invalid_size in (-1, 0, "bad", 10**15):
        assert (
            session_client.post(
                upload_url(comment_context), {**payload, "size": invalid_size}, format="json"
            ).status_code
            == 400
        )


@pytest.mark.django_db
@override_settings(FILE_SIZE_LIMIT=1 * 1024 * 1024)
@pytest.mark.parametrize(
    ("file_name", "content_type", "category", "limit_mb"),
    [
        ("图版.png", "image/png", "image", 1),
        ("图版.png", "application/octet-stream", "image", 1),
        ("论文.pdf", "application/pdf", "pdf", 2),
        ("记录.md", "text/markdown", "markdown", 3),
        ("记录.markdown", "application/octet-stream", "markdown", 3),
        ("汇报.pptx", PPTX_TYPE, "office", 4),
    ],
)
def test_comment_attachment_uses_workspace_category_limit(
    session_client, comment_context, file_name, content_type, category, limit_mb
):
    """评论附件按工作区平台设置的分类额度签发上传策略。"""
    _, _, issue, _ = comment_context
    configure_limits(comment_context[0])
    base = {
        "name": file_name,
        "type": content_type,
        "entity_type": "COMMENT_ATTACHMENT",
        "entity_identifier": str(issue.id),
    }
    exact_size = limit_mb * MEGABYTE
    with patch("plane.app.views.asset.v2.S3Storage") as storage:
        storage.return_value.generate_presigned_post.return_value = {"url": "https://storage.test", "fields": {}}
        response = session_client.post(upload_url(comment_context), {**base, "size": exact_size}, format="json")
    assert response.status_code == 200, response.data
    asset = FileAsset.objects.get(id=response.data["asset_id"])
    assert asset.size == exact_size
    storage.return_value.generate_presigned_post.assert_called_once_with(
        object_name=asset.asset.name, file_type=content_type, file_size=exact_size
    )

    too_large = session_client.post(upload_url(comment_context), {**base, "size": exact_size + 1}, format="json")
    assert too_large.status_code == 400
    assert too_large.data["error_code"] == "comment_attachment_size_exceeded"
    assert too_large.data["category"] == category
    assert too_large.data["limit_mb"] == limit_mb
    assert too_large.data["limit_bytes"] == exact_size


@pytest.mark.django_db
def test_comment_attachment_limits_endpoint_only_returns_project_scoped_limits(session_client, comment_context):
    """额度接口复用项目访问权限，且只暴露四类评论附件限制。"""
    workspace, _, _, user = comment_context
    setting = configure_limits(workspace, image=6, pdf=7, markdown=8, office=9)
    research_project = Project.objects.create(
        workspace=workspace,
        name="科研项目",
        identifier="RESEARCH",
        network=0,
    )
    ResearchProjectProfile.objects.create(
        project=research_project,
        workspace=workspace,
        owner=user,
        chain_kind=ResearchProjectProfile.ChainKind.RESEARCH_CHAIN,
    )
    ProjectMember.objects.create(workspace=workspace, project=research_project, member=user, role=20)
    response = session_client.get(limits_url(comment_context))
    assert response.status_code == 200
    assert response.data == {
        "image": {"max_mb": 6, "max_bytes": 6 * MEGABYTE},
        "pdf": {"max_mb": 7, "max_bytes": 7 * MEGABYTE},
        "markdown": {"max_mb": 8, "max_bytes": 8 * MEGABYTE},
        "office": {"max_mb": 9, "max_bytes": 9 * MEGABYTE},
    }
    research_url = (
        f"/api/assets/v2/workspaces/{workspace.slug}/projects/{research_project.id}/comment-attachment-limits/"
    )
    assert session_client.get(research_url).data == response.data

    outsider = User.objects.create(email=f"{uuid4()}@example.com", username=uuid4().hex)
    WorkspaceMember.objects.create(workspace=workspace, member=outsider, role=15)
    client = APIClient()
    client.force_authenticate(user=outsider)
    assert client.get(limits_url(comment_context)).status_code == 403
    setting.refresh_from_db()
    assert setting.module_enabled is False


@pytest.mark.django_db
@override_settings(FILE_SIZE_LIMIT=5 * 1024 * 1024)
def test_non_comment_asset_keeps_global_file_size_limit(session_client, comment_context):
    """非评论资产仍记录并签发全局 FILE_SIZE_LIMIT。"""
    _, _, _, _ = comment_context
    payload = {
        "name": "正文图片.png",
        "type": "image/png",
        "size": 6 * MEGABYTE,
        "entity_type": "COMMENT_DESCRIPTION",
        "entity_identifier": "",
    }
    with patch("plane.app.views.asset.v2.S3Storage") as storage:
        storage.return_value.generate_presigned_post.return_value = {"url": "https://storage.test", "fields": {}}
        response = session_client.post(upload_url(comment_context), payload, format="json")
    assert response.status_code == 200
    assert FileAsset.objects.get(id=response.data["asset_id"]).size == 5 * MEGABYTE
    storage.return_value.generate_presigned_post.assert_called_once_with(
        object_name=FileAsset.objects.get(id=response.data["asset_id"]).asset.name,
        file_type="image/png",
        file_size=5 * MEGABYTE,
    )


@pytest.mark.django_db
def test_comment_attachment_limits_do_not_leak_across_workspaces(session_client, comment_context):
    """每个项目只读取所属工作区的平台额度。"""
    user = comment_context[3]
    other_workspace = Workspace.objects.create(name="另一工作区", owner=user, slug=f"ws-{uuid4().hex[:12]}")
    WorkspaceMember.objects.create(workspace=other_workspace, member=user, role=20)
    other_project = Project.objects.create(
        workspace=other_workspace,
        name="另一工作区项目",
        identifier="OTHERWS",
        network=0,
    )
    ProjectMember.objects.create(workspace=other_workspace, project=other_project, member=user, role=20)
    other_issue = Issue.objects.create(workspace=other_workspace, project=other_project, name="另一任务")
    configure_limits(comment_context[0], office=4)
    configure_limits(other_workspace, office=11)
    payload = {
        "name": "跨区汇报.pptx",
        "type": PPTX_TYPE,
        "size": 11 * MEGABYTE,
        "entity_type": "COMMENT_ATTACHMENT",
        "entity_identifier": str(other_issue.id),
    }
    url = f"/api/assets/v2/workspaces/{other_workspace.slug}/projects/{other_project.id}/"
    with patch("plane.app.views.asset.v2.S3Storage") as storage:
        storage.return_value.generate_presigned_post.return_value = {"url": "https://storage.test", "fields": {}}
        response = session_client.post(url, payload, format="json")
    assert response.status_code == 200, response.data
    storage.return_value.generate_presigned_post.assert_called_once_with(
        object_name=FileAsset.objects.get(id=response.data["asset_id"]).asset.name,
        file_type=PPTX_TYPE,
        file_size=11 * MEGABYTE,
    )


@pytest.mark.django_db
def test_attachment_only_comment_roundtrip_and_edit_semantics(session_client, comment_context):
    """纯附件发布后可读取；省略保持、空数组清空。"""
    asset = make_asset(comment_context)
    response = session_client.post(
        comments_url(comment_context), {"comment_html": "<p></p>", "attachment_ids": [str(asset.id)]}, format="json"
    )
    assert response.status_code == 201, response.data
    comment_id = response.data["id"]
    asset.refresh_from_db()
    assert str(asset.comment_id) == str(comment_id)
    attachment = response.data["file_attachments"][0]
    assert attachment["name"] == "过程汇报.pptx"
    assert attachment["download_url"].endswith(f"download/{asset.id}/")
    assert "attachment_ids" not in response.data
    url = comments_url(comment_context, comment_id)
    kept = session_client.patch(url, {"comment_html": "<p>过程文件</p>"}, format="json")
    assert len(kept.data["file_attachments"]) == 1
    removed = session_client.patch(url, {"attachment_ids": []}, format="json")
    assert removed.status_code == 200
    assert removed.data["file_attachments"] == []
    asset.refresh_from_db()
    assert asset.is_deleted and asset.deleted_at is not None


@pytest.mark.django_db
@pytest.mark.parametrize(
    "invalid", ["not_uploaded", "other_user", "other_issue", "other_project", "already_linked", "deleted"]
)
def test_invalid_asset_does_not_create_partial_comment(session_client, comment_context, invalid):
    """拒绝不属于当前评论草稿的文件，且不留下半条评论。"""
    workspace, project, issue, user = comment_context
    overrides = {}
    if invalid == "not_uploaded":
        overrides["is_uploaded"] = False
    elif invalid == "other_user":
        overrides["created_by"] = User.objects.create(email=f"{uuid4()}@example.com", username=uuid4().hex)
    elif invalid == "other_issue":
        overrides["issue"] = Issue.objects.create(workspace=workspace, project=project, name="其他任务")
    elif invalid == "other_project":
        overrides["project"] = Project.objects.create(workspace=workspace, name="其他项目", identifier="OTHER")
    elif invalid == "already_linked":
        overrides["comment"] = IssueComment.objects.create(
            workspace=workspace, project=project, issue=issue, actor=user, comment_html="<p>原评论</p>"
        )
    else:
        overrides["is_deleted"] = True
    asset = make_asset(comment_context, **overrides)
    count = IssueComment.objects.count()
    response = session_client.post(
        comments_url(comment_context),
        {"comment_html": "<p>不得部分保存</p>", "attachment_ids": [str(asset.id)]},
        format="json",
    )
    assert response.status_code == 400
    assert IssueComment.objects.count() == count


@pytest.mark.django_db
def test_delete_comment_revokes_all_download_aliases(session_client, comment_context):
    """删除评论后，通用下载接口和附件接口均不可绕过权限。"""
    workspace, project, issue, _ = comment_context
    asset = make_asset(comment_context)
    response = session_client.post(
        comments_url(comment_context), {"comment_html": "<p>材料</p>", "attachment_ids": [str(asset.id)]}, format="json"
    )
    assert response.status_code == 201
    assert session_client.delete(comments_url(comment_context, response.data["id"])).status_code == 204
    asset.refresh_from_db()
    assert asset.is_deleted
    paths = [
        f"/api/assets/v2/workspaces/{workspace.slug}/projects/{project.id}/{asset.id}/",
        f"/api/assets/v2/workspaces/{workspace.slug}/projects/{project.id}/download/{asset.id}/",
        f"/api/assets/v2/workspaces/{workspace.slug}/download/{asset.id}/",
        f"/api/assets/v2/workspaces/{workspace.slug}/projects/{project.id}/issues/{issue.id}/attachments/{asset.id}/",
    ]
    with patch("plane.app.views.asset.v2.S3Storage") as storage:
        for path in paths:
            assert session_client.get(path).status_code in (403, 404)
        storage.return_value.generate_presigned_url.assert_not_called()


@pytest.mark.django_db
def test_pending_file_is_private_and_published_file_follows_comment_access(session_client, comment_context):
    """临时文件仅本人可见，发布后项目成员可下载而不可直接删除。"""
    workspace, project, _, _ = comment_context
    member = User.objects.create(email=f"{uuid4()}@example.com", username=uuid4().hex)
    WorkspaceMember.objects.create(workspace=workspace, member=member, role=15)
    ProjectMember.objects.create(workspace=workspace, project=project, member=member, role=15)
    other = APIClient()
    other.force_authenticate(user=member)
    asset = make_asset(comment_context)
    url = f"{upload_url(comment_context)}{asset.id}/"
    assert other.get(url).status_code == 403
    created = session_client.post(
        comments_url(comment_context),
        {"comment_html": "<p>可读材料</p>", "attachment_ids": [str(asset.id)]},
        format="json",
    )
    assert created.status_code == 201
    with patch("plane.app.views.asset.v2.S3Storage") as storage:
        storage.return_value.generate_presigned_url.return_value = "https://storage.test/download"
        assert other.get(url).status_code == 302
    assert other.delete(url).status_code == 403
    assert session_client.delete(url).status_code == 403


@pytest.mark.django_db
def test_edit_add_remove_and_failed_save_is_atomic(session_client, comment_context):
    """编辑增删在同一事务中生效，校验失败保留原文和原附件。"""
    first = make_asset(comment_context)
    created = session_client.post(
        comments_url(comment_context),
        {
            "comment_html": "<p>原说明</p>",
            "attachment_ids": [str(first.id)],
        },
        format="json",
    )
    assert created.status_code == 201
    url = comments_url(comment_context, created.data["id"])
    second = make_asset(comment_context)
    failed = session_client.patch(
        url,
        {
            "comment_html": "<p>不应生效</p>",
            "attachment_ids": [str(second.id), str(uuid4())],
        },
        format="json",
    )
    assert failed.status_code == 400
    first.refresh_from_db()
    second.refresh_from_db()
    assert not first.is_deleted and second.comment_id is None
    assert IssueComment.objects.get(id=created.data["id"]).comment_html == "<p>原说明</p>"
    updated = session_client.patch(url, {"attachment_ids": [str(second.id)]}, format="json")
    assert updated.status_code == 200
    first.refresh_from_db()
    assert first.is_deleted
    assert updated.data["file_attachments"][0]["id"] == str(second.id)
    assert updated.data["edited_at"] is not None


@pytest.mark.django_db
def test_legacy_comment_and_empty_comment_validation(session_client, comment_context):
    """兼容未传附件字段的调用，新增附件协议拒绝空评论和重复 ID。"""
    legacy = session_client.post(
        comments_url(comment_context),
        {
            "comment_html": "<p>旧客户端文字</p>",
            "attachments": [],
        },
        format="json",
    )
    assert legacy.status_code == 201
    assert legacy.data["attachments"] == [] and legacy.data["file_attachments"] == []
    assert (
        session_client.post(
            comments_url(comment_context),
            {
                "comment_html": "<p></p>",
                "attachment_ids": [],
            },
            format="json",
        ).status_code
        == 400
    )
    asset = make_asset(comment_context)
    for ids in ([str(asset.id)] * 2, [str(uuid4()) for _ in range(11)]):
        assert (
            session_client.post(
                comments_url(comment_context),
                {
                    "comment_html": "<p>校验</p>",
                    "attachment_ids": ids,
                },
                format="json",
            ).status_code
            == 400
        )


@pytest.mark.django_db
def test_upload_rejects_wrong_work_item_scope(session_client, comment_context):
    """上传目标必须属于当前项目和工作区。"""
    workspace, _, _, _ = comment_context
    other_project = Project.objects.create(workspace=workspace, name="另一项目", identifier="SCOPED")
    other_issue = Issue.objects.create(workspace=workspace, project=other_project, name="另一任务")
    response = session_client.post(
        upload_url(comment_context),
        {
            "name": "process.pptx",
            "type": PPTX_TYPE,
            "size": 128,
            "entity_type": "COMMENT_ATTACHMENT",
            "entity_identifier": str(other_issue.id),
        },
        format="json",
    )
    assert response.status_code == 404


@pytest.mark.django_db
def test_cleanup_only_expires_unbound_comment_files(comment_context):
    """过期清理覆盖已上传草稿，保留已发布评论的文件。"""
    from plane.bgtasks.file_asset_task import delete_unuploaded_file_asset

    workspace, project, issue, user = comment_context
    comment = IssueComment.objects.create(workspace=workspace, project=project, issue=issue, actor=user)
    pending = make_asset(comment_context)
    published = make_asset(comment_context, comment=comment)
    fresh = make_asset(comment_context)
    FileAsset.objects.filter(id__in=[pending.id, published.id]).update(created_at=timezone.now() - timedelta(days=8))
    delete_unuploaded_file_asset()
    assert not FileAsset.objects.filter(id=pending.id).exists()
    assert FileAsset.objects.filter(id__in=[published.id, fresh.id]).count() == 2


@pytest.mark.django_db
def test_published_file_download_denies_workspace_outsider(session_client, comment_context):
    """仅工作区成员身份不足以下载私有项目评论文件。"""
    workspace, project, _, _ = comment_context
    asset = make_asset(comment_context)
    created = session_client.post(
        comments_url(comment_context),
        {
            "comment_html": "<p>私有材料</p>",
            "attachment_ids": [str(asset.id)],
        },
        format="json",
    )
    assert created.status_code == 201
    outsider = User.objects.create(email=f"{uuid4()}@example.com", username=uuid4().hex)
    WorkspaceMember.objects.create(workspace=workspace, member=outsider, role=15)
    client = APIClient()
    client.force_authenticate(user=outsider)
    paths = [
        f"/api/assets/v2/workspaces/{workspace.slug}/projects/{project.id}/{asset.id}/",
        f"/api/assets/v2/workspaces/{workspace.slug}/projects/{project.id}/download/{asset.id}/",
        f"/api/assets/v2/workspaces/{workspace.slug}/download/{asset.id}/",
    ]
    with patch("plane.app.views.asset.v2.S3Storage") as storage:
        for path in paths:
            assert client.get(path).status_code == 403
        storage.return_value.generate_presigned_url.assert_not_called()


@pytest.mark.django_db
def test_inline_image_comment_remains_compatible(session_client, comment_context):
    """允许仅含内嵌图片的原有评论，不要求附加文件。"""
    response = session_client.post(
        comments_url(comment_context),
        {
            "comment_html": '<p><img src="https://example.com/process.png"></p>',
            "attachment_ids": [],
        },
        format="json",
    )
    assert response.status_code == 201
    assert "process.png" in response.data["comment_html"]
    assert response.data["file_attachments"] == []
