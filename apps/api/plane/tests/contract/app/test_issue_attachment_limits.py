"""工作项附件复用工作区分类上传额度的契约。"""

from unittest.mock import patch

import pytest
from django.test import override_settings
from rest_framework.test import APIClient

from plane.db.models import (
    FileAsset,
    Issue,
    Project,
    ProjectMember,
    State,
    User,
    WorkspaceResearchSetting,
    WorkspaceMember,
)

MEGABYTE = 1024 * 1024
PPTX_TYPE = "application/vnd.openxmlformats-officedocument.presentationml.presentation"


@pytest.fixture
def attachment_context(workspace, create_user):
    """创建可上传附件的标准项目工作项。"""
    project = Project.objects.create(workspace=workspace, name="行政材料", identifier="ADMFILES", network=0)
    ProjectMember.objects.create(workspace=workspace, project=project, member=create_user, role=20)
    state = State.objects.create(workspace=workspace, project=project, name="进行中", group="started")
    issue = Issue.objects.create(workspace=workspace, project=project, state=state, name="补充行政材料")
    return workspace, project, issue, create_user


def attachments_url(context):
    """返回 V2 工作项附件上传地址。"""
    workspace, project, issue, _ = context
    return f"/api/assets/v2/workspaces/{workspace.slug}/projects/{project.id}/issues/{issue.id}/attachments/"


def configure_limits(workspace, image=20, pdf=100, markdown=5, office=50):
    """写入与评论附件一致的四级工作区额度。"""
    return WorkspaceResearchSetting.objects.update_or_create(
        workspace=workspace,
        defaults={
            "image_max_mb": image,
            "pdf_max_mb": pdf,
            "markdown_max_mb": markdown,
            "office_max_mb": office,
        },
    )[0]


@pytest.mark.django_db
@override_settings(FILE_SIZE_LIMIT=5 * 1024 * 1024)
def test_issue_attachment_uses_workspace_office_limit(session_client, attachment_context):
    """工作项办公附件不再被全局 5MB 元数据截断。"""
    configure_limits(attachment_context[0], office=50)
    payload = {"name": "行政材料.pptx", "type": PPTX_TYPE, "size": 6 * MEGABYTE}

    with patch("plane.app.views.issue.attachment.S3Storage") as storage:
        storage.return_value.generate_presigned_post.return_value = {"url": "https://storage.test", "fields": {}}
        response = session_client.post(attachments_url(attachment_context), payload, format="json")

    assert response.status_code == 200, response.data
    asset = FileAsset.objects.get(id=response.data["asset_id"])
    assert asset.size == 6 * MEGABYTE
    assert asset.attributes["size"] == 6 * MEGABYTE
    storage.return_value.generate_presigned_post.assert_called_once_with(
        object_name=asset.asset.name,
        file_type=PPTX_TYPE,
        file_size=50 * MEGABYTE,
    )


@pytest.mark.django_db
@pytest.mark.parametrize(
    ("file_name", "content_type", "category", "limit_mb"),
    [
        ("现场照片.png", "image/png", "image", 20),
        ("说明.md", "text/markdown", "markdown", 5),
    ],
)
def test_issue_attachment_rejects_category_limit_exceeded(
    session_client, attachment_context, file_name, content_type, category, limit_mb
):
    """工作项附件按分类额度拒绝超限文件。"""
    configure_limits(attachment_context[0])
    payload = {"name": file_name, "type": content_type, "size": (limit_mb + 1) * MEGABYTE}

    response = session_client.post(attachments_url(attachment_context), payload, format="json")

    assert response.status_code == 400, response.data
    assert response.data["error_code"] == "issue_attachment_size_exceeded"
    assert response.data["category"] == category
    assert response.data["limit_mb"] == limit_mb
    assert response.data["limit_bytes"] == limit_mb * MEGABYTE
    assert FileAsset.objects.filter(entity_type="ISSUE_ATTACHMENT").count() == 0


@pytest.mark.django_db
def test_issue_attachment_rejects_invalid_size_without_asset(session_client, attachment_context):
    """无效大小不产生半上传资产。"""
    configure_limits(attachment_context[0])
    payload = {"name": "行政材料.pptx", "type": PPTX_TYPE, "size": "invalid"}

    response = session_client.post(attachments_url(attachment_context), payload, format="json")

    assert response.status_code == 400, response.data
    assert response.data["error"] == "Invalid file size."
    assert FileAsset.objects.filter(entity_type="ISSUE_ATTACHMENT").count() == 0


@pytest.mark.django_db
def test_project_member_can_delete_issue_attachment(attachment_context):
    """项目成员可以删除当前工作项附件。"""
    workspace, project, issue, _owner = attachment_context
    member = User.objects.create_user(
        email="attachment-member@plane.so",
        username="attachment_member",
        password="attachment-password",
    )
    WorkspaceMember.objects.create(workspace=workspace, member=member, role=15, is_active=True)
    ProjectMember.objects.create(workspace=workspace, project=project, member=member, role=15, is_active=True)
    asset = FileAsset.objects.create(
        attributes={"name": "行政材料.pptx", "type": PPTX_TYPE, "size": 1024},
        asset="issue-attachments/member-file.pptx",
        size=1024,
        workspace=workspace,
        project=project,
        issue=issue,
        created_by=member,
        entity_type=FileAsset.EntityTypeContext.ISSUE_ATTACHMENT,
    )
    client = APIClient()
    client.force_authenticate(user=member)

    with patch("plane.app.views.issue.attachment.issue_activity.delay"):
        response = client.delete(f"{attachments_url(attachment_context)}{asset.id}/")

    assert response.status_code == 204, response.data
    asset.refresh_from_db()
    assert asset.is_deleted is True
    assert asset.deleted_at is not None
