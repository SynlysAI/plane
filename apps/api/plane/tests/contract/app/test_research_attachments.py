# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

import io
import json
from unittest import mock
from zipfile import ZIP_STORED, ZipFile

import pytest
from rest_framework.test import APIClient

from plane.db.models import (
    FileAsset,
    MentorBinding,
    OrgUnit,
    OrgUnitMember,
    Page,
    PeriodicReport,
    PeriodicReportSnapshot,
    ProjectMember,
    ReportAttachment,
    ResearchAuditEvent,
)
from plane.settings.storage import S3Storage
from plane.tests.research_fixtures import add_workspace_member, enable_research, make_user, make_workspace

pytestmark = pytest.mark.contract

MB = 1024 * 1024
S3_STORAGE_PATH = "plane.app.views.asset.v2.S3Storage"


@pytest.fixture(autouse=True)
def research_module_on(settings):
    settings.RESEARCH_MODULE_ENABLED = True


def client_for(user):
    client = APIClient()
    client.force_authenticate(user=user)
    return client


def create_unit(workspace, name, parent=None, unit_type=OrgUnit.UnitType.GROUP):
    unit = OrgUnit.objects.create(
        workspace=workspace,
        name=name,
        parent=parent,
        unit_type=unit_type,
        depth=(parent.depth + 1) if parent else 0,
        path="",
    )
    unit.path = (parent.path if parent else "/") + str(unit.id).replace("-", "") + "/"
    unit.save(update_fields=["path"])
    return unit


def office_document(extension, padding_size=0):
    """生成具有对应主文档与内容类型的最小 OOXML 容器。

    Args:
        extension: 带点号的 OOXML 扩展名。
        padding_size: 用于大小校验的额外容器条目长度。

    Returns:
        可供真实对象存储上传的 ZIP 字节内容。
    """
    main_path, main_type = {
        ".docx": ("word/document.xml", "wordprocessingml.document.main+xml"),
        ".xlsx": ("xl/workbook.xml", "spreadsheetml.sheet.main+xml"),
        ".pptx": ("ppt/presentation.xml", "presentationml.presentation.main+xml"),
    }[extension]
    buffer = io.BytesIO()
    with ZipFile(buffer, "w", compression=ZIP_STORED) as container:
        container.writestr(
            "[Content_Types].xml",
            '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
            f'<Override PartName="/{main_path}" '
            f'ContentType="application/vnd.openxmlformats-officedocument.{main_type}"/>'
            "</Types>",
        )
        container.writestr(main_path, "<document/>")
        container.writestr("fixture-padding.txt", b" " * padding_size)
    return buffer.getvalue()


def attachment_content(name, size):
    """按文件扩展名生成指定大小的合法附件测试内容。

    Args:
        name: 附件文件名。
        size: 存储对象目标大小。

    Returns:
        带文件特征的附件字节内容。
    """
    extension = "." + name.rsplit(".", 1)[-1].lower()
    if extension in {".docx", ".xlsx", ".pptx"}:
        base = office_document(extension)
        return office_document(extension, max(0, size - len(base)))
    header = b"%PDF-1.7\n" if extension == ".pdf" else b"fixture,data\n"
    return header[:size] + b" " * max(0, size - len(header))


def store_object(asset, content, content_type):
    """将附件字节写入隔离测试栈中的实际 S3 对象。

    Args:
        asset: 关联文件资产。
        content: 实际上传的字节内容。
        content_type: 存储对象的实际 MIME。
    """
    storage = S3Storage()
    storage.server_s3_client.put_object(
        Bucket=storage.aws_storage_bucket_name,
        Key=asset.asset.name,
        Body=content,
        ContentType=content_type,
    )


def make_asset(workspace, user, name, content_type, size):
    """创建声明元数据并上传对应的真实附件对象。

    Args:
        workspace: 附件所属工作区。
        user: 上传者。
        name: 文件名。
        content_type: 声明及实际 MIME。
        size: 声明及实际对象大小。

    Returns:
        已上传的 FileAsset。
    """
    asset = FileAsset.objects.create(
        attributes={"name": name, "type": content_type, "size": size},
        asset=f"{workspace.slug}/{name}",
        size=size,
        workspace=workspace,
        user=user,
        created_by=user,
        entity_type=FileAsset.EntityTypeContext.REPORT_ATTACHMENT,
        is_uploaded=True,
    )
    store_object(asset, attachment_content(name, size), content_type)
    return asset


@pytest.fixture
def env(db):
    admin = make_user(first_name="Admin")
    workspace = make_workspace(admin)
    enable_research(workspace)
    student = make_user(first_name="Student")
    advisor = make_user(first_name="Advisor")
    colleague = make_user(first_name="Colleague")
    outsider = make_user(first_name="Outsider")
    for user in (student, advisor, colleague, outsider):
        add_workspace_member(workspace, user)

    root = create_unit(workspace, "Root", None, OrgUnit.UnitType.ROOT)
    group = create_unit(workspace, "Group", root, OrgUnit.UnitType.GROUP)
    OrgUnitMember.objects.create(
        workspace=workspace,
        org_unit=group,
        user=student,
        org_role=OrgUnitMember.OrgRole.OWNER,
        is_primary=True,
    )
    OrgUnitMember.objects.create(
        workspace=workspace,
        org_unit=group,
        user=colleague,
        org_role=OrgUnitMember.OrgRole.REVIEWER,
    )
    MentorBinding.objects.create(
        workspace=workspace,
        org_unit=group,
        mentee=student,
        mentor=advisor,
        is_primary_advisor=True,
    )

    student_client = client_for(student)
    project_response = student_client.post(
        f"/api/research/workspaces/{workspace.slug}/projects/",
        {"org_unit": str(group.id), "research_type": "MASTER"},
        format="json",
    )
    assert project_response.status_code == 201, project_response.json()
    report_response = student_client.post(
        f"/api/research/workspaces/{workspace.slug}/reports/",
        {"report_type": "WEEKLY", "period_key": "2026-W38", "visibility": "PRIVATE"},
        format="json",
    )
    assert report_response.status_code == 201, report_response.json()
    report = report_response.json()

    return {
        "admin": admin,
        "student": student,
        "advisor": advisor,
        "colleague": colleague,
        "outsider": outsider,
        "workspace": workspace,
        "report": report,
        "student_client": student_client,
        "advisor_client": client_for(advisor),
        "colleague_client": client_for(colleague),
        "outsider_client": client_for(outsider),
        "admin_client": client_for(admin),
        "attachments_url": (f"/api/research/workspaces/{workspace.slug}/reports/{report['id']}/attachments/"),
    }


@pytest.fixture(autouse=True)
def remove_test_objects(env):
    """每项测试结束后仅清理其随机工作区前缀下的对象。"""
    yield
    storage = S3Storage()
    for prefix in (f"{env['workspace'].slug}/", f"{env['workspace'].id}/research/"):
        response = storage.server_s3_client.list_objects_v2(
            Bucket=storage.aws_storage_bucket_name,
            Prefix=prefix,
        )
        objects = [{"Key": item["Key"]} for item in response.get("Contents", [])]
        if objects:
            storage.server_s3_client.delete_objects(
                Bucket=storage.aws_storage_bucket_name,
                Delete={"Objects": objects},
            )


def register_attachment_for_generic_download(env, *, project_bound):
    asset = make_asset(env["workspace"], env["student"], "generic-download.pdf", "application/pdf", MB)
    project_id = env["report"]["page_project"]
    if project_bound:
        asset.project_id = project_id
        asset.save(update_fields=["project"])
        for user in (env["admin"], env["advisor"], env["colleague"]):
            ProjectMember.objects.get_or_create(
                project_id=project_id,
                member=user,
                defaults={"role": 15},
            )

    response = env["student_client"].post(
        env["attachments_url"],
        {"asset_id": str(asset.id)},
        format="json",
    )
    assert response.status_code == 201
    return asset, project_id


def generic_download_url(env, asset, project_id, *, project_bound):
    if project_bound:
        return f"/api/assets/v2/workspaces/{env['workspace'].slug}/projects/{project_id}/download/{asset.id}/"
    return f"/api/assets/v2/workspaces/{env['workspace'].slug}/download/{asset.id}/"


@pytest.mark.django_db
class TestReportAttachments:
    def test_pdf_can_be_registered(self, env):
        asset = make_asset(env["workspace"], env["student"], "paper.pdf", "application/pdf", 2 * MB)
        response = env["student_client"].post(env["attachments_url"], {"asset_id": str(asset.id)}, format="json")
        assert response.status_code == 201
        payload = response.json()
        assert payload["kind"] == "PDF"
        assert ReportAttachment.objects.filter(report_id=env["report"]["id"]).count() == 1
        assert ResearchAuditEvent.objects.filter(action="report.attachment.add").exists()

    @pytest.mark.parametrize(
        ("file_name", "content_type"),
        [
            ("notes.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"),
            ("table.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"),
            ("slides.pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation"),
            ("data.csv", "text/csv"),
        ],
    )
    def test_common_office_files_can_be_registered(self, env, file_name, content_type):
        asset = make_asset(env["workspace"], env["student"], file_name, content_type, 2 * MB)
        response = env["student_client"].post(env["attachments_url"], {"asset_id": str(asset.id)}, format="json")
        assert response.status_code == 201
        assert response.json()["kind"] == "OFFICE"

    def test_unsupported_type_is_rejected_and_audited(self, env):
        asset = make_asset(env["workspace"], env["student"], "payload.sh", "application/x-sh", 1024)
        response = env["student_client"].post(env["attachments_url"], {"asset_id": str(asset.id)}, format="json")
        assert response.status_code == 422
        assert response.json()["error_code"] == "file_type_not_allowed"
        assert ResearchAuditEvent.objects.filter(action="report.attachment.denied").exists()

    def test_oversized_pdf_is_rejected(self, env):
        asset = make_asset(env["workspace"], env["student"], "big.pdf", "application/pdf", 101 * MB)
        response = env["student_client"].post(env["attachments_url"], {"asset_id": str(asset.id)}, format="json")
        assert response.status_code == 422
        assert response.json()["error_code"] == "file_size_exceeded"

    def test_workspace_limit_overrides_the_default(self, env):
        env["admin_client"].patch(
            f"/api/research/workspaces/{env['workspace'].slug}/settings/",
            {"pdf_max_mb": 200},
            format="json",
        )
        asset = make_asset(env["workspace"], env["student"], "big.pdf", "application/pdf", 150 * MB)
        response = env["student_client"].post(env["attachments_url"], {"asset_id": str(asset.id)}, format="json")
        assert response.status_code == 201

    def test_duplicate_registration_is_rejected(self, env):
        asset = make_asset(env["workspace"], env["student"], "paper.pdf", "application/pdf", MB)
        payload = {"asset_id": str(asset.id)}
        assert env["student_client"].post(env["attachments_url"], payload, format="json").status_code == 201
        duplicate = env["student_client"].post(env["attachments_url"], payload, format="json")
        assert duplicate.status_code in (400, 403, 422)

    def test_submitted_report_rejects_new_attachments(self, env):
        env["student_client"].post(
            f"/api/research/workspaces/{env['workspace'].slug}/reports/{env['report']['id']}/submit/",
            {},
            format="json",
        )
        asset = make_asset(env["workspace"], env["student"], "paper.pdf", "application/pdf", MB)
        response = env["student_client"].post(env["attachments_url"], {"asset_id": str(asset.id)}, format="json")
        assert response.status_code == 409

    def test_attachment_list_is_acl_filtered(self, env):
        asset = make_asset(env["workspace"], env["student"], "paper.pdf", "application/pdf", MB)
        env["student_client"].post(env["attachments_url"], {"asset_id": str(asset.id)}, format="json")

        owner_list = env["student_client"].get(env["attachments_url"]).json()
        assert owner_list["count"] == 1
        # a private report is invisible to an unrelated member
        assert env["outsider_client"].get(env["attachments_url"]).status_code == 404

    def test_download_rechecks_the_acl(self, env, monkeypatch):
        asset = make_asset(env["workspace"], env["student"], "paper.pdf", "application/pdf", MB)
        attachment = (
            env["student_client"].post(env["attachments_url"], {"asset_id": str(asset.id)}, format="json").json()
        )
        download_url = f"{env['attachments_url']}{attachment['id']}/"

        allowed = env["student_client"].get(download_url)
        assert allowed.status_code == 302

        denied = env["outsider_client"].get(download_url)
        assert denied.status_code in (403, 404)
        assert ResearchAuditEvent.objects.filter(action="report.attachment.denied").exists()

    @pytest.mark.parametrize("project_bound", [False, True], ids=["workspace", "project"])
    def test_generic_download_rechecks_draft_acl_before_signing(self, env, project_bound):
        asset, project_id = register_attachment_for_generic_download(
            env,
            project_bound=project_bound,
        )
        download_url = generic_download_url(
            env,
            asset,
            project_id,
            project_bound=project_bound,
        )

        with mock.patch(S3_STORAGE_PATH) as mock_storage:
            mock_storage.return_value.generate_presigned_url.return_value = "https://signed.example/research-download"
            assert env["student_client"].get(download_url).status_code == 302
            assert env["admin_client"].get(download_url).status_code == 403
            assert env["colleague_client"].get(download_url).status_code == 403

        mock_storage.return_value.generate_presigned_url.assert_called_once()

    @pytest.mark.parametrize("project_bound", [False, True], ids=["workspace", "project"])
    def test_generic_download_allows_advisor_for_formal_report_only(self, env, project_bound):
        asset, project_id = register_attachment_for_generic_download(
            env,
            project_bound=project_bound,
        )
        report = PeriodicReport.objects.get(pk=env["report"]["id"])
        report.visibility = "DIRECT_ADVISOR"
        report.save(update_fields=["visibility"])
        submitted = env["student_client"].post(
            f"/api/research/workspaces/{env['workspace'].slug}/reports/{report.id}/submit/",
            {},
            format="json",
        )
        assert submitted.status_code == 200

        download_url = generic_download_url(
            env,
            asset,
            project_id,
            project_bound=project_bound,
        )
        with mock.patch(S3_STORAGE_PATH) as mock_storage:
            mock_storage.return_value.generate_presigned_url.return_value = "https://signed.example/research-download"
            assert env["advisor_client"].get(download_url).status_code == 302
            assert env["admin_client"].get(download_url).status_code == 403
            assert env["colleague_client"].get(download_url).status_code == 403

        mock_storage.return_value.generate_presigned_url.assert_called_once()

    def test_delete_is_soft(self, env):
        asset = make_asset(env["workspace"], env["student"], "paper.pdf", "application/pdf", MB)
        attachment = (
            env["student_client"].post(env["attachments_url"], {"asset_id": str(asset.id)}, format="json").json()
        )
        response = env["student_client"].delete(f"{env['attachments_url']}{attachment['id']}/")
        assert response.status_code == 204
        assert ReportAttachment.objects.filter(pk=attachment["id"]).count() == 0
        assert ReportAttachment.all_objects.filter(pk=attachment["id"]).exists()

    def test_returned_report_keeps_the_submitted_attachment_set_private_from_revision(self, env):
        first_asset = make_asset(env["workspace"], env["student"], "v1.pdf", "application/pdf", MB)
        first = (
            env["student_client"].post(env["attachments_url"], {"asset_id": str(first_asset.id)}, format="json").json()
        )
        env["student_client"].patch(
            f"/api/research/workspaces/{env['workspace'].slug}/reports/{env['report']['id']}/access/",
            {"visibility": "DIRECT_ADVISOR"},
            format="json",
        )
        env["student_client"].post(
            f"/api/research/workspaces/{env['workspace'].slug}/reports/{env['report']['id']}/submit/",
            {},
            format="json",
        )
        env["advisor_client"].post(
            f"/api/research/workspaces/{env['workspace'].slug}/reports/{env['report']['id']}/return/",
            {"comment": "revise"},
            format="json",
        )
        env["student_client"].delete(
            f"{env['attachments_url']}{first['id']}/",
            format="json",
        )
        second_asset = make_asset(env["workspace"], env["student"], "revision.pdf", "application/pdf", MB)
        env["student_client"].post(env["attachments_url"], {"asset_id": str(second_asset.id)}, format="json")

        advisor_list = env["advisor_client"].get(env["attachments_url"])

        assert advisor_list.status_code == 200
        assert [item["file_name"] for item in advisor_list.json()["results"]] == ["v1.pdf"]

    def test_global_upload_limit_is_unchanged(self, env, settings):
        assert settings.FILE_SIZE_LIMIT == settings.FILE_SIZE_LIMIT
        env["admin_client"].patch(
            f"/api/research/workspaces/{env['workspace'].slug}/settings/",
            {"image_max_mb": 5, "pdf_max_mb": 10},
            format="json",
        )

    def test_presign_creates_a_pending_asset_and_register_completes_it(self, env):
        presign = env["student_client"].post(
            f"{env['attachments_url']}presign/",
            {"file_name": "paper.pdf", "content_type": "application/pdf", "size": 2 * MB},
            format="json",
        )
        assert presign.status_code == 200
        payload = presign.json()
        assert payload["upload_data"]["url"]
        assert FileAsset.objects.get(pk=payload["asset_id"]).is_uploaded is False
        store_object(
            FileAsset.objects.get(pk=payload["asset_id"]),
            attachment_content("paper.pdf", 2 * MB),
            "application/pdf",
        )

        registered = env["student_client"].post(
            env["attachments_url"], {"asset_id": payload["asset_id"]}, format="json"
        )
        assert registered.status_code == 201
        assert FileAsset.objects.get(pk=payload["asset_id"]).is_uploaded is True

    def test_presign_rejects_disallowed_types_and_sizes(self, env, monkeypatch):
        monkeypatch.setattr(
            "plane.settings.storage.S3Storage.generate_presigned_post",
            lambda self, object_name, file_type, file_size, expiration=None: {"url": "x", "fields": {}},
        )
        rejected_type = env["student_client"].post(
            f"{env['attachments_url']}presign/",
            {"file_name": "payload.exe", "content_type": "application/octet-stream", "size": 1024},
            format="json",
        )
        assert rejected_type.status_code == 422
        assert rejected_type.json()["error_code"] == "file_type_not_allowed"

        rejected_size = env["student_client"].post(
            f"{env['attachments_url']}presign/",
            {"file_name": "big.pdf", "content_type": "application/pdf", "size": 101 * MB},
            format="json",
        )
        assert rejected_size.status_code == 422
        assert rejected_size.json()["error_code"] == "file_size_exceeded"


@pytest.mark.django_db
class TestStoredAttachmentValidation:
    @pytest.mark.parametrize("uploaded", [False, True], ids=["pending", "marked-uploaded"])
    @pytest.mark.parametrize(
        ("scenario", "error_code"),
        [
            ("empty", "file_size_exceeded"),
            ("oversized", "file_size_exceeded"),
            ("mime-mismatch", "file_type_not_allowed"),
            ("fake-pdf", "file_type_not_allowed"),
            ("fake-office-signature", "file_type_not_allowed"),
            ("zip-without-office-document", "file_type_not_allowed"),
            ("office-document-type-mismatch", "file_type_not_allowed"),
        ],
    )
    def test_registration_rejects_invalid_stored_object(self, env, uploaded, scenario, error_code):
        """声明合法且对象存在时，登记仍须依据实际对象内容拒绝伪造与超限。"""
        office_mime = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        file_name = "forged.docx" if "office" in scenario else "forged.pdf"
        declared_mime = office_mime if file_name.endswith(".docx") else "application/pdf"
        asset = make_asset(env["workspace"], env["student"], file_name, declared_mime, 1024)
        asset.is_uploaded = uploaded
        asset.save(update_fields=["is_uploaded"])

        actual_mime = declared_mime
        if scenario == "empty":
            content = b""
        elif scenario == "oversized":
            env["admin_client"].patch(
                f"/api/research/workspaces/{env['workspace'].slug}/settings/",
                {"pdf_max_mb": 1},
                format="json",
            )
            content = attachment_content(file_name, MB + 1)
        elif scenario == "mime-mismatch":
            content = attachment_content(file_name, 1024)
            actual_mime = "application/x-executable"
        elif scenario == "fake-pdf":
            content = b"\x7fELF\x02\x01\x01 executable payload"
        elif scenario == "fake-office-signature":
            content = b"PK\x03\x04 not a ZIP container"
        elif scenario == "zip-without-office-document":
            buffer = io.BytesIO()
            with ZipFile(buffer, "w") as container:
                container.writestr("payload.txt", "ordinary ZIP renamed as DOCX")
            content = buffer.getvalue()
        else:
            content = office_document(".xlsx")
        store_object(asset, content, actual_mime)

        response = env["student_client"].post(env["attachments_url"], {"asset_id": str(asset.id)}, format="json")

        assert response.status_code == 422, response.json()
        assert response.json()["error_code"] == error_code
        assert not ReportAttachment.objects.filter(asset=asset).exists()
        assert ResearchAuditEvent.objects.filter(action="report.attachment.denied").exists()

    @pytest.mark.parametrize("uploaded", [False, True], ids=["pending", "marked-uploaded"])
    def test_registration_requires_the_stored_object_even_when_marked_uploaded(self, env, uploaded):
        """上传完成标记不能替代实际对象存在性检查。"""
        asset = make_asset(env["workspace"], env["student"], "missing.pdf", "application/pdf", 1024)
        asset.is_uploaded = uploaded
        asset.save(update_fields=["is_uploaded"])
        storage = S3Storage()
        storage.server_s3_client.delete_object(
            Bucket=storage.aws_storage_bucket_name,
            Key=asset.asset.name,
        )

        response = env["student_client"].post(env["attachments_url"], {"asset_id": str(asset.id)}, format="json")

        assert response.status_code == 409, response.json()
        assert response.json()["error_code"] == "report_attachment_not_found"
        assert not ReportAttachment.objects.filter(asset=asset).exists()

    def test_registration_records_the_actual_object_size(self, env):
        """附件清单应展示存储对象实际大小，而非较小的声明大小。"""
        asset = make_asset(env["workspace"], env["student"], "actual.pdf", "application/pdf", 1024)
        content = attachment_content("actual.pdf", 2048)
        store_object(asset, content, "application/pdf")

        response = env["student_client"].post(env["attachments_url"], {"asset_id": str(asset.id)}, format="json")

        assert response.status_code == 201, response.json()
        assert response.json()["file_size"] == len(content)


@pytest.mark.django_db
class TestMarkdownImport:
    def _import_url(self, env):
        return f"/api/research/workspaces/{env['workspace'].slug}/reports/{env['report']['id']}/import-markdown/"

    def test_import_writes_the_page_body(self, env):
        response = env["student_client"].post(
            self._import_url(env),
            {"content": "# Title\n\n- item\n\n```\ncode\n```", "file_name": "weekly.md"},
            format="json",
        )
        assert response.status_code == 200
        page = Page.objects.get(pk=env["report"]["page"])
        assert "<h1>Title</h1>" in page.description_html
        assert "<li>item</li>" in page.description_html
        assert ResearchAuditEvent.objects.filter(action="report.import.markdown").exists()

    @pytest.mark.parametrize("project_bound", [False, True], ids=["standalone", "project"])
    def test_import_replaces_the_content_rendered_by_report_detail_and_official_snapshot(self, env, project_bound):
        """详情与正式快照优先使用 JSON 时也应呈现导入正文及远程图片。"""
        report = PeriodicReport.objects.get(pk=env["report"]["id"])
        if not project_bound:
            report.project = None
            report.save(update_fields=["project"])
            report.page.project_pages.all().delete()
        report.page.description_json = {
            "type": "doc",
            "content": [{"type": "paragraph", "content": [{"type": "text", "text": "旧正文不应再显示"}]}],
        }
        report.page.description_html = "<p>旧正文不应再显示</p>"
        report.page.save()
        detail_url = f"/api/research/workspaces/{env['workspace'].slug}/reports/{report.id}/"

        response = env["student_client"].post(
            self._import_url(env),
            {"content": "# 导入后的正文\n\n![remote](https://example.com/imported.png)"},
            format="json",
        )

        assert response.status_code == 200
        detail = env["student_client"].get(detail_url)
        assert detail.status_code == 200
        draft = detail.json()["draft_content"]
        rendered_content = (
            json.dumps(draft["description_json"], ensure_ascii=False)
            if draft["description_json"]
            else draft["description_html"]
        )
        assert "导入后的正文" in rendered_content
        assert "https://example.com/imported.png" in rendered_content
        assert "旧正文不应再显示" not in rendered_content

        access = env["student_client"].patch(f"{detail_url}access/", {"visibility": "DIRECT_ADVISOR"}, format="json")
        assert access.status_code == 200
        assert env["student_client"].post(f"{detail_url}submit/", {}, format="json").status_code == 200
        official = env["advisor_client"].get(detail_url).json()["official_content"]
        rendered_official = (
            json.dumps(official["description_json"], ensure_ascii=False)
            if official["description_json"]
            else official["description_html"]
        )
        assert "导入后的正文" in rendered_official
        assert "旧正文不应再显示" not in rendered_official

    @pytest.mark.parametrize("project_bound", [False, True], ids=["standalone", "project"])
    def test_import_does_not_rehydrate_the_previous_editor_binary(self, env, project_bound):
        """导入后读取及冻结正文不得继续返回旧的编辑器二进制状态。"""
        report = PeriodicReport.objects.get(pk=env["report"]["id"])
        project_id = env["report"]["page_project"]
        if not project_bound:
            report.project = None
            report.save(update_fields=["project"])
            report.page.project_pages.all().delete()
        old_binary = b"previous-editor-document-state"
        report.page.description_binary = old_binary
        report.page.description_html = "<p>Old body</p>"
        report.page.save()

        response = env["student_client"].post(self._import_url(env), {"content": "# Imported body"}, format="json")

        assert response.status_code == 200
        if project_bound:
            binary_url = (
                f"/api/workspaces/{env['workspace'].slug}/projects/{project_id}/pages/{report.page_id}/description/"
            )
            binary_response = env["student_client"].get(binary_url)
            assert binary_response.status_code == 200
            assert b"".join(binary_response.streaming_content) != old_binary

        detail_url = f"/api/research/workspaces/{env['workspace'].slug}/reports/{report.id}/"
        submitted = env["student_client"].post(f"{detail_url}submit/", {}, format="json")
        assert submitted.status_code == 200
        snapshot = PeriodicReportSnapshot.objects.get(report=report, version_no=1)
        assert snapshot.description_html == "<h1>Imported body</h1>"
        assert snapshot.description_binary is None or bytes(snapshot.description_binary) != old_binary

    def test_local_images_are_reported_back(self, env):
        response = env["student_client"].post(
            self._import_url(env),
            {"content": "![local](./img.png)\n\n![remote](https://example.com/a.png)"},
            format="json",
        )
        assert response.status_code == 200
        assert response.json()["local_images"] == ["./img.png"]
        assert "https://example.com/a.png" in response.json()["content_html"]

    def test_oversized_markdown_is_rejected(self, env):
        response = env["student_client"].post(
            self._import_url(env),
            {"content": "x" * (6 * MB), "file_name": "big.md"},
            format="json",
        )
        # the body size guard rejects the payload before the view runs
        assert response.status_code == 413
        page = Page.objects.get(pk=env["report"]["page"])
        assert "<p></p>" in page.description_html

    def test_import_into_a_submitted_report_is_rejected(self, env):
        env["student_client"].post(
            f"/api/research/workspaces/{env['workspace'].slug}/reports/{env['report']['id']}/submit/",
            {},
            format="json",
        )
        response = env["student_client"].post(
            self._import_url(env), {"content": "# late", "file_name": "late.md"}, format="json"
        )
        assert response.status_code == 409

    def test_unrelated_member_cannot_import(self, env):
        response = env["outsider_client"].post(self._import_url(env), {"content": "# hack"}, format="json")
        assert response.status_code == 404
