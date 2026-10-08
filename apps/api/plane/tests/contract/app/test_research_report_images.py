"""报告正文图片权限、跨报告引用及正式资源保留契约。"""

from unittest import mock

import pytest

from plane.db.models import FileAsset, PeriodicReport
from plane.research.utils.report_images import can_read_report_image
from plane.tests.contract.app.test_research_attachments import env as attachment_env, research_module_on  # noqa: F401


@pytest.fixture
def env(attachment_env):
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
@pytest.mark.parametrize("uploaded,foreign", [(False, False), (True, True)])
def test_body_rejects_incomplete_and_foreign_image(env, uploaded, foreign):
    asset = make_image(env, uploaded=uploaded)
    if foreign:
        asset.entity_identifier = "00000000-0000-0000-0000-000000000001"
        asset.save()
    response = env["student_client"].patch(
        body_url(env),
        {
            "description_json": {"type": "doc", "content": [{"type": "image", "attrs": {"src": str(asset.id)}}]},
            "description_html": f'<img src="{asset.id}">',
        },
        format="json",
    )
    assert response.status_code == 422
    assert PeriodicReport.objects.get(pk=env["report"]["id"]).page.description_html == "<p></p>"


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
