"""报告正文图片权限、跨报告引用及正式资源保留契约。"""

from unittest import mock
from uuid import uuid4

import pytest
from django.utils import timezone

from plane.db.models import FileAsset, PeriodicReport, PeriodicReportSnapshot
from plane.research.services.report_context import selected_report_content
from plane.research.utils.report_images import can_read_report_image
from plane.tests.contract.app.test_research_attachments import env as attachment_env, research_module_on  # noqa: F401
from plane.tests.research_fixtures import make_workspace


@pytest.fixture
def env(attachment_env):  # noqa: F811
    """复用实际报告及 S3 夹具。"""
    return attachment_env


pytestmark = pytest.mark.contract


def make_image(env, *, uploaded=True):
    """创建报告专属图片夹具。"""
    return FileAsset.objects.create(
        workspace=env["workspace"],
        user=env["student"],
        created_by=env["student"],
        asset=f"{env['workspace'].id}/report-test.png",
        size=32,
        attributes={"name": "test.png", "type": "image/png"},
        entity_type=FileAsset.EntityTypeContext.REPORT_IMAGE,
        entity_identifier=env["report"]["id"],
        is_uploaded=uploaded,
    )


def body_url(env):
    """返回当前报告正文 URL。"""
    return env["attachments_url"].removesuffix("attachments/")


@pytest.mark.django_db
@pytest.mark.parametrize("node_type,tag", [("image", "img"), ("imageComponent", "image-component")])
@pytest.mark.parametrize("invalid", ["incomplete", "foreign_report", "foreign_workspace", "removed", "wrong_type"])
def test_body_rejects_incomplete_and_foreign_image(env, node_type, tag, invalid):
    """新旧格式都不能绕过资源归属、类型或上传状态校验。"""
    asset = make_image(env, uploaded=invalid != "incomplete")
    if invalid == "foreign_report":
        asset.entity_identifier = str(uuid4())
    elif invalid == "foreign_workspace":
        asset.workspace = make_workspace(env["admin"])
    elif invalid == "removed":
        asset.is_deleted = True
    elif invalid == "wrong_type":
        asset.entity_type = FileAsset.EntityTypeContext.REPORT_ATTACHMENT
    asset.save()
    response = env["student_client"].patch(
        body_url(env),
        {
            "description_json": {"type": "doc", "content": [{"type": node_type, "attrs": {"src": str(asset.id)}}]},
            "description_html": f'<{tag} src="{asset.id}"></{tag}>',
        },
        format="json",
    )
    assert response.status_code == 422
    assert PeriodicReport.objects.get(pk=env["report"]["id"]).page.description_html == "<p></p>"


@pytest.mark.django_db
@pytest.mark.parametrize("node_type,tag", [("image", "img"), ("imageComponent", "image-component")])
@pytest.mark.parametrize("source", ["json", "html", "both"])
def test_submitted_editor_images_are_frozen_and_readable(env, node_type, tag, source):
    """保存并提交实际编辑器格式后，导师可以读取去重后的正式图片。"""
    asset = make_image(env)
    url = f"{body_url(env)}images/{asset.id}/"
    payload = {
        "description_json": {"type": "doc", "content": [{"type": node_type, "attrs": {"src": url}}] * 2},
        "description_html": f'<{tag} src="{url}"></{tag}>' * 2,
    }
    if source == "json":
        payload["description_html"] = "<p>正文</p>"
    elif source == "html":
        payload["description_json"] = {}
    saved = env["student_client"].patch(body_url(env), payload, format="json")
    assert saved.status_code == 200, saved.json()
    submitted = env["student_client"].post(f"{body_url(env)}submit/", {}, format="json")
    assert submitted.status_code == 200, submitted.json()
    snapshot = PeriodicReportSnapshot.objects.get(report_id=env["report"]["id"])
    assert [item["asset_id"] for item in snapshot.image_manifest] == [str(asset.id)]
    with mock.patch("plane.research.views.report_images.S3Storage") as storage:
        storage.return_value.generate_presigned_url.return_value = "https://storage.invalid/test.png"
        response = env["advisor_client"].get(url)
    assert response.status_code == 302
    assert response["Location"] == "https://storage.invalid/test.png"


@pytest.mark.django_db
@pytest.mark.parametrize("partial_manifest", [False, True])
def test_legacy_snapshot_images_are_readable_without_rewriting_history(env, partial_manifest):
    """历史空清单或部分清单按正式正文补全，且隔离后续草稿新增图片。"""
    asset = make_image(env)
    other = make_image(env)
    draft_asset = make_image(env)
    report = PeriodicReport.objects.get(pk=env["report"]["id"])
    report.status = PeriodicReport.Status.NEEDS_REVISION
    report.submitted_at = timezone.now()
    report.save(update_fields=["status", "submitted_at", "updated_at"])
    sources = [f"{body_url(env)}images/{image.id}/" for image in (asset, other)]
    frozen_manifest = [{"asset_id": str(asset.id), "file_name": "frozen.png"}] if partial_manifest else []
    snapshot = PeriodicReportSnapshot.objects.create(
        report=report,
        version_no=1,
        snapshot_status=PeriodicReport.Status.SUBMITTED,
        description_json={"type": "doc", "content": [{"type": "imageComponent", "attrs": {"src": sources[0]}}]},
        description_html=f'<image-component src="{sources[1]}"></image-component>',
        image_manifest=frozen_manifest,
        submitted_by=env["student"],
    )
    report.page.description_json = {}
    report.page.description_html = f'<image-component src="{body_url(env)}images/{draft_asset.id}/"></image-component>'
    report.page.save(update_fields=["description_json", "description_html", "updated_at"])
    asset.is_deleted = True
    asset.save(update_fields=["is_deleted", "updated_at"])
    with mock.patch("plane.research.views.report_images.S3Storage") as storage:
        storage.return_value.generate_presigned_url.return_value = "https://storage.invalid/test.png"
        assert all(env["advisor_client"].get(url).status_code == 302 for url in sources)
        assert env["advisor_client"].get(f"{body_url(env)}images/{draft_asset.id}/").status_code == 404
        assert env["outsider_client"].get(sources[0]).status_code == 404
    contents = selected_report_content(
        workspace=env["workspace"],
        actor=env["advisor"],
        project_id=report.project_id,
        selections=[{"report_id": str(report.id), "version_no": 1}],
    )
    assert {image["asset_id"] for image in contents[0]["images"]} == {str(asset.id), str(other.id)}
    snapshot.refresh_from_db()
    assert snapshot.image_manifest == frozen_manifest
    assert snapshot.description_html == f'<image-component src="{sources[1]}"></image-component>'
    report.page.refresh_from_db()
    assert str(draft_asset.id) in report.page.description_html


@pytest.mark.django_db
def test_image_snapshot_survives_draft_removal_and_generic_delete_is_denied(env):
    from plane.app.views.asset.v2 import can_download_research_asset, can_mutate_research_asset

    asset = make_image(env)
    url = f"{body_url(env)}images/{asset.id}/"
    saved = env["student_client"].patch(
        body_url(env),
        {
            "description_json": {},
            "description_html": f'<p>正文</p><img src="{url}">',
        },
        format="json",
    )
    assert saved.status_code == 200, saved.json()
    submitted = env["student_client"].post(f"{body_url(env)}submit/", {}, format="json")
    assert submitted.status_code == 200, submitted.json()
    report = PeriodicReport.objects.get(pk=env["report"]["id"])
    assert report.official_snapshots.first().image_manifest[0]["asset_id"] == str(asset.id)
    assert not can_mutate_research_asset(env["student"], asset)
    assert not can_download_research_asset(env["outsider"], asset)
    denied = env["student_client"].delete(url)
    assert denied.status_code == 409
    returned = env["advisor_client"].post(f"{body_url(env)}return/", {"comment": "补充正文"}, format="json")
    assert returned.status_code == 200, returned.json()
    assert env["student_client"].delete(url).status_code == 204
    asset.refresh_from_db()
    assert asset.is_deleted
    assert can_read_report_image(env["advisor"], asset)
    assert can_download_research_asset(env["advisor"], asset)
    assert not can_mutate_research_asset(env["student"], asset)
    with mock.patch("plane.research.views.report_images.S3Storage") as storage:
        storage.return_value.generate_presigned_url.return_value = "https://storage.invalid/test.png"
        assert env["advisor_client"].get(url).status_code == 302
    assert report.official_snapshots.first().image_manifest[0]["asset_id"] == str(asset.id)


@pytest.mark.django_db
def test_report_image_only_accepts_supported_bitmap_formats(env):
    url = f"{body_url(env)}images/"
    for name, content_type in [("image.svg", "image/svg+xml"), ("image.bmp", "image/bmp"), ("image.png", "image/jpeg")]:
        response = env["student_client"].post(
            url,
            {
                "file_name": name,
                "content_type": content_type,
                "size": 32,
            },
            format="json",
        )
        assert response.status_code == 422


@pytest.mark.django_db
def test_report_image_endpoint_hides_private_draft(env):
    asset = make_image(env)
    url = f"{body_url(env)}images/{asset.id}/"
    assert env["outsider_client"].get(url).status_code == 404
    assert env["outsider_client"].delete(url).status_code in (403, 404)
