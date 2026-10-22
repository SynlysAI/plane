"""附件预览状态、缓存与文件范围读取契约。"""

import io
import json
import zipfile
from unittest.mock import patch

import pytest
from django.test import TestCase, override_settings
from pypdf import PdfWriter

from plane.db.models import AssetPreview, FileAsset, Issue, Project, ProjectMember, State, User, WorkspaceMember
from plane.preview.access import preview_url, report_preview_url
from plane.preview.service import get_preview, source_metadata
from plane.preview.views import byte_range


@pytest.fixture
def preview_asset(workspace, create_user):
    """创建一个带有效项目成员关系的已上传 PDF 附件。"""
    project = Project.objects.create(workspace=workspace, name="预览项目", identifier="PREVIEW", network=0)
    ProjectMember.objects.create(workspace=workspace, project=project, member=create_user, role=20)
    state = State.objects.create(workspace=workspace, project=project, name="进行中", group="started")
    issue = Issue.objects.create(workspace=workspace, project=project, state=state, name="预览文件")
    return FileAsset.objects.create(
        workspace=workspace,
        project=project,
        issue=issue,
        created_by=create_user,
        entity_type=FileAsset.EntityTypeContext.ISSUE_ATTACHMENT,
        is_uploaded=True,
        asset="preview.pdf",
        size=9,
        attributes={"name": "预览.pdf", "type": "application/pdf", "size": 9},
    )


@pytest.mark.parametrize(
    ("header", "size", "expected"),
    [(None, 10, None), ("bytes=1-4", 10, (1, 4)), ("bytes=5-", 10, (5, 9)), ("bytes=-3", 10, (7, 9))],
)
def test_preview_byte_range(header, size, expected):
    """PDF 内容接口支持安全的单段范围请求。"""
    assert byte_range(header, size) == expected


@pytest.mark.parametrize("header", ["bytes=10-11", "bytes=4-2", "bytes=1-2,4-5", "items=1-2"])
def test_preview_rejects_invalid_byte_range(header):
    """无效或多段范围不进入对象存储读取。"""
    with pytest.raises(ValueError):
        byte_range(header, 10)


@pytest.mark.django_db
def test_preview_reuses_one_record_and_enqueues_once(preview_asset):
    """相同对象版本并发请求共享一个转换记录。"""
    metadata = {"ContentLength": 9, "ETag": "etag"}
    with (
        patch("plane.preview.service.S3Storage") as storage_class,
        patch("plane.bgtasks.asset_preview_task.build_asset_preview.delay") as delay,
        TestCase.captureOnCommitCallbacks(execute=True),
    ):
        storage_class.return_value.get_object_metadata.return_value = metadata
        first = get_preview(preview_asset, create=True)
        second = get_preview(preview_asset, create=True)
    assert first.id == second.id
    assert AssetPreview.objects.count() == 1
    delay.assert_called_once()


class FakeBody:
    """提供可关闭的有界对象存储读取流。"""

    def __init__(self, content):
        self.content = content
        self.closed = False

    def read(self, size=-1):
        """读取指定字节数；测试内容总是单次读完。"""
        del size
        return self.content

    def close(self):
        """标记流已关闭。"""
        self.closed = True


class FakeConverterResponse:
    """模拟 Gotenberg 的单文件 PDF 响应。"""

    def __init__(self, content):
        self.content = content

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_value, traceback):
        return False

    def raise_for_status(self):
        """测试响应始终成功。"""

    def iter_content(self, size):
        """按调用方期望的分块大小输出 PDF。"""
        del size
        yield self.content


def make_storage(metadata, content):
    """构造可复用的 S3 Storage 替身。"""
    from unittest.mock import Mock

    storage = Mock()
    storage.get_object_metadata.return_value = metadata
    storage.aws_storage_bucket_name = "uploads"
    storage.server_s3_client.get_object.return_value = {"Body": FakeBody(content)}
    return storage


def test_preview_url_omits_unsupported_active_content(preview_asset):
    """SVG 等主动内容格式仅保留下载入口。"""
    preview_asset.attributes["name"] = "结构图.svg"
    assert preview_url(preview_asset) is None
    assert report_preview_url(type("Attachment", (), {"file_name": "结构图.svg"})()) is None
    preview_asset.attributes["name"] = "记录.txt"
    assert preview_url(preview_asset) == (
        f"/api/assets/v2/workspaces/{preview_asset.workspace.slug}/previews/assets/{preview_asset.id}/"
    )


@pytest.mark.django_db
@override_settings(ATTACHMENT_PREVIEW_ENABLED=True)
def test_issue_preview_rejects_removed_asset(session_client, preview_asset):
    """资产移除后旧预览 URL 不再可读。"""
    preview_asset.is_deleted = True
    preview_asset.save(update_fields=["is_deleted"])
    response = session_client.post(
        f"/api/assets/v2/workspaces/{preview_asset.workspace.slug}/previews/assets/{preview_asset.id}/"
    )
    assert response.status_code == 404


@pytest.mark.django_db
@override_settings(ATTACHMENT_PREVIEW_ENABLED=True)
def test_issue_preview_content_requires_project_permission(api_client, preview_asset):
    """已有预览记录不能替代工作项附件的项目级读取授权。"""
    outsider = User.objects.create(
        email="preview-outsider@plane.so",
        username="preview_outsider",
        first_name="Preview",
        last_name="Outsider",
    )
    WorkspaceMember.objects.create(workspace=preview_asset.workspace, member=outsider, role=15, is_active=True)
    api_client.force_authenticate(user=outsider)
    response = api_client.get(
        f"/api/assets/v2/workspaces/{preview_asset.workspace.slug}/previews/assets/{preview_asset.id}/content/"
    )
    assert response.status_code == 403


@pytest.mark.django_db
def test_preview_task_builds_read_only_table(preview_asset):
    """CSV 附件不经过转换器，直接生成前端使用的分页 JSON。"""
    content = "指标,数值\n样本数,12\n".encode()
    preview_asset.attributes = {"name": "数据.csv", "type": "text/csv", "size": len(content)}
    preview_asset.save(update_fields=["attributes"])
    metadata = {"ContentLength": len(content), "ETag": "csv-etag"}
    with patch("plane.bgtasks.asset_preview_task.S3Storage") as storage_class:
        storage_class.return_value = make_storage(metadata, content)
        fingerprint, _ = source_metadata(storage_class.return_value, preview_asset)
        preview = AssetPreview.objects.create(
            asset=preview_asset,
            fingerprint=fingerprint,
            converter_version="test",
            kind="table",
            status="pending",
        )
        from plane.bgtasks.asset_preview_task import build_asset_preview

        build_asset_preview(str(preview.id), str(preview.attempt))
    preview.refresh_from_db()
    assert preview.status == "ready"
    assert preview.content_type == "application/json"
    assert json.loads(storage_class.return_value.server_s3_client.put_object.call_args.kwargs["Body"]) == {
        "rows": [["指标", "数值"], ["样本数", "12"]]
    }


@pytest.mark.django_db
def test_preview_task_converts_office_document_to_pdf(preview_asset):
    """DOCX 经 Gotenberg 转成 PDF，并复核源版本后登记私有产物。"""
    office = io.BytesIO()
    with zipfile.ZipFile(office, "w") as container:
        container.writestr("[Content_Types].xml", "wordprocessingml.document.main+xml")
        container.writestr("word/document.xml", "<w:document />")
    content = office.getvalue()
    metadata = {"ContentLength": len(content), "ETag": "docx-etag"}
    writer = PdfWriter()
    writer.add_blank_page(width=420, height=180)
    converted = io.BytesIO()
    writer.write(converted)
    converted_bytes = converted.getvalue()

    preview_asset.attributes = {"name": "中文汇报.docx", "type": "application/octet-stream", "size": len(content)}
    preview_asset.save(update_fields=["attributes"])
    with (
        patch("plane.bgtasks.asset_preview_task.S3Storage") as storage_class,
        patch("plane.bgtasks.asset_preview_task.requests.post") as convert,
    ):
        storage_class.return_value = make_storage(metadata, content)
        fingerprint, _ = source_metadata(storage_class.return_value, preview_asset)
        preview = AssetPreview.objects.create(
            asset=preview_asset,
            fingerprint=fingerprint,
            converter_version="test",
            kind="pdf",
            status="pending",
        )
        convert.return_value = FakeConverterResponse(converted_bytes)
        from plane.bgtasks.asset_preview_task import build_asset_preview

        build_asset_preview(str(preview.id), str(preview.attempt))
        request_args, request_kwargs = convert.call_args
    preview.refresh_from_db()
    assert preview.status == "ready"
    assert preview.content_type == "application/pdf"
    assert request_args[0].endswith("/forms/libreoffice/convert")
    assert request_kwargs["files"]["files"][0] == "document.docx"
    assert storage_class.return_value.server_s3_client.put_object.call_args.kwargs["Body"] == converted_bytes
