"""工作项附件删除权限契约。"""

from unittest.mock import patch
from uuid import uuid4

import pytest
from rest_framework.test import APIClient

from plane.db.models import (
    FileAsset,
    Issue,
    Project,
    ProjectMember,
    State,
    User,
    WorkspaceMember,
)


@pytest.fixture
def attachment_context(workspace):
    """创建私有项目、工作项与两名普通成员，附件由成员 B 上传。"""
    project = Project.objects.create(workspace=workspace, name="行政材料", identifier="ADM", network=0)
    state = State.objects.create(workspace=workspace, project=project, name="进行中", group="started")
    issue = Issue.objects.create(workspace=workspace, project=project, state=state, name="材料收集")
    member_a = User.objects.create(email=f"{uuid4()}@example.com", username=uuid4().hex)
    member_b = User.objects.create(email=f"{uuid4()}@example.com", username=uuid4().hex)
    for member in (member_a, member_b):
        WorkspaceMember.objects.create(workspace=workspace, member=member, role=15)
        ProjectMember.objects.create(workspace=workspace, project=project, member=member, role=15)
    asset = FileAsset.objects.create(
        workspace=workspace,
        project=project,
        issue=issue,
        created_by=member_b,
        entity_type=FileAsset.EntityTypeContext.ISSUE_ATTACHMENT,
        is_uploaded=True,
        size=128,
        asset=f"{workspace.id}/{uuid4()}.pdf",
        attributes={"name": "材料.pdf", "type": "application/pdf", "size": 128},
    )
    return workspace, project, issue, asset, member_a


def client_for(user):
    """返回以指定用户身份认证的客户端。

    Args:
        user: 需要模拟登录的用户。

    Returns:
        已认证的 API 客户端。
    """
    client = APIClient()
    client.force_authenticate(user=user)
    return client


def v1_url(context, asset_id):
    """返回 v1 附件详情地址。"""
    workspace, project, issue, _, _ = context
    return f"/api/workspaces/{workspace.slug}/projects/{project.id}/issues/{issue.id}/issue-attachments/{asset_id}/"


def v2_url(context, asset_id):
    """返回 v2 附件详情地址。"""
    workspace, project, issue, _, _ = context
    return f"/api/assets/v2/workspaces/{workspace.slug}/projects/{project.id}/issues/{issue.id}/attachments/{asset_id}/"


@pytest.mark.django_db
def test_project_member_can_delete_attachment_uploaded_by_others(attachment_context):
    """普通项目成员进入编辑模式后可删除他人上传的附件（v2）。"""
    context = attachment_context
    _, _, _, asset, member_a = context
    client = client_for(member_a)
    with (
        patch("plane.app.views.issue.attachment.issue_activity.delay"),
    ):
        assert client.delete(v2_url(context, asset.id)).status_code == 204
    asset.refresh_from_db()
    assert asset.is_deleted


@pytest.mark.django_db
def test_v1_project_member_can_delete_attachment_uploaded_by_others(attachment_context):
    """v1 附件删除同样允许普通项目成员操作。"""
    context = attachment_context
    _, _, _, asset, member_a = context
    client = client_for(member_a)
    with (
        patch("plane.app.views.issue.attachment.issue_activity.delay"),
        patch("plane.db.mixins.soft_delete_related_objects.delay"),
        patch("django.db.models.fields.files.FieldFile.delete"),
    ):
        assert client.delete(v1_url(context, asset.id)).status_code == 204
    assert not FileAsset.objects.filter(pk=asset.id).exists()


@pytest.mark.django_db
def test_non_project_member_cannot_delete_attachment(attachment_context):
    """工作区成员未加入私有项目时不可删除附件。"""
    context = attachment_context
    workspace, _, _, asset, _ = context
    outsider = User.objects.create(email=f"{uuid4()}@example.com", username=uuid4().hex)
    WorkspaceMember.objects.create(workspace=workspace, member=outsider, role=15)
    with patch("plane.app.views.issue.attachment.issue_activity.delay"):
        response = client_for(outsider).delete(v2_url(context, asset.id))
    assert response.status_code == 403
