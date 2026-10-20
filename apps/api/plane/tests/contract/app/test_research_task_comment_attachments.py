# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Research task comment image and file attachment contracts."""

from io import BytesIO
from unittest.mock import patch
from uuid import uuid4

import pytest

from plane.db.models import FileAsset, WorkspaceResearchSetting
from plane.tests.contract.app.test_research_chain_tasks import _client, _create, _url
from plane.tests.research_fixtures import make_research_boundary_fixture

pytestmark = [pytest.mark.contract, pytest.mark.django_db]

MEGABYTE = 1024 * 1024


@pytest.fixture
def env(settings):
    settings.RESEARCH_MODULE_ENABLED = True
    fixture = make_research_boundary_fixture()
    fixture.update(
        {
            "student_client": _client(fixture["student"]),
            "member_client": _client(fixture["group_member"]),
            "advisor_client": _client(fixture["advisor"]),
        }
    )
    return fixture


def task_base(env, task_id):
    """Return the API base for one research task."""
    return _url(env, task_id)


def configure_limits(workspace, *, image=1, office=2):
    """Configure only the quota categories exercised by this module."""
    return WorkspaceResearchSetting.objects.update_or_create(
        workspace=workspace,
        defaults={"image_max_mb": image, "office_max_mb": office},
    )[0]


def make_task_asset(env, task_id, *, entity_type, uploaded=True, creator=None, **overrides):
    """Create a research task comment asset without routing through storage."""
    data = dict(
        workspace=env["workspace"],
        created_by=creator or env["student"],
        entity_type=entity_type,
        entity_identifier=str(task_id),
        is_uploaded=uploaded,
        size=128,
        asset=f"{env['workspace'].id}/{uuid4()}.bin",
        attributes={"name": "process.bin", "type": "application/octet-stream", "size": 128},
    )
    data.update(overrides)
    asset = FileAsset(**data)
    asset.save(disable_auto_set_user=True)
    return asset


def presign_response(env, task, file_name="installer.deb", content_type="application/x-deb", size=128):
    """Request a comment file upload slot."""
    return env["student_client"].post(
        f"{task_base(env, task['id'])}comment-attachments/presign/",
        {"file_name": file_name, "content_type": content_type, "size": size},
        format="json",
    )


def test_file_presign_accepts_any_type_and_uses_workspace_quota(env):
    task = _create(env)
    configure_limits(env["workspace"], office=2)
    with patch("plane.research.views.task_comment_assets.S3Storage") as storage:
        storage.return_value.generate_presigned_post.return_value = {"url": "https://storage.test", "fields": {}}
        response = presign_response(env, task, size=2 * MEGABYTE)
        asset_id = response.data["asset_id"]
        storage.return_value.get_object_metadata.return_value = {
            "ContentType": "application/x-deb",
            "ContentLength": 2 * MEGABYTE,
        }
        confirmed = env["student_client"].post(
            f"{task_base(env, task['id'])}comment-attachments/{asset_id}/confirm/",
            {},
            format="json",
        )

    assert response.status_code == 200, response.data
    assert confirmed.status_code == 200, confirmed.data
    assert confirmed.data == {
        "asset_id": asset_id,
        "name": "installer.deb",
        "type": "application/x-deb",
        "size": 2 * MEGABYTE,
    }
    asset = FileAsset.objects.get(pk=response.data["asset_id"])
    assert asset.is_uploaded is True
    assert asset.size == 2 * MEGABYTE
    assert asset.entity_type == FileAsset.EntityTypeContext.RESEARCH_TASK_COMMENT_ATTACHMENT
    assert asset.entity_identifier == str(task["id"])
    assert asset.workspace == env["workspace"]
    assert asset.created_by == env["student"]
    assert response.data["upload_data"] == {"url": "https://storage.test", "fields": {}}
    assert (
        env["student_client"]
        .post(
            f"{task_base(env, task['id'])}comment-attachments/presign/",
            {"file_name": "large.bin", "content_type": "application/octet-stream", "size": 2 * MEGABYTE + 1},
            format="json",
        )
        .status_code
        == 400
    )


def test_attachment_comment_roundtrip_edit_and_security(env):
    task = _create(env)
    other_task = _create(env)
    first = make_task_asset(
        env,
        task["id"],
        entity_type=FileAsset.EntityTypeContext.RESEARCH_TASK_COMMENT_ATTACHMENT,
        attributes={"name": "过程汇报.pptx", "type": "application/vnd...presentationml.presentation", "size": 128},
    )
    second = make_task_asset(
        env,
        task["id"],
        entity_type=FileAsset.EntityTypeContext.RESEARCH_TASK_COMMENT_ATTACHMENT,
        attributes={"name": "dataset.csv", "type": "text/csv", "size": 64},
    )
    wrong_task = make_task_asset(
        env,
        other_task["id"],
        entity_type=FileAsset.EntityTypeContext.RESEARCH_TASK_COMMENT_ATTACHMENT,
    )
    foreign = make_task_asset(
        env,
        task["id"],
        entity_type=FileAsset.EntityTypeContext.RESEARCH_TASK_COMMENT_ATTACHMENT,
        creator=env["advisor"],
    )

    base = f"{task_base(env, task['id'])}comments/"
    payload = {"comment_html": "<p></p>", "request_id": uuid4().hex, "attachment_ids": [str(first.id), str(second.id)]}
    created = env["student_client"].post(base, payload, format="json")
    assert created.status_code == 201, created.data
    assert {(item["id"], item["name"]) for item in created.data["file_attachments"]} == {
        (str(first.id), "过程汇报.pptx"),
        (str(second.id), "dataset.csv"),
    }

    detail = base + f"{created.data['id']}/"
    omitted = env["student_client"].patch(detail, {"comment_html": "<p>已补充</p>"}, format="json")
    assert omitted.status_code == 200, omitted.data
    assert len(omitted.data["file_attachments"]) == 2
    cleared = env["student_client"].patch(
        detail, {"comment_html": "<p>已补充</p>", "attachment_ids": []}, format="json"
    )
    assert cleared.status_code == 200, cleared.data
    assert cleared.data["file_attachments"] == []
    first.refresh_from_db()
    second.refresh_from_db()
    assert first.is_deleted and first.deleted_at
    assert second.is_deleted and second.deleted_at

    invalid_payloads = [
        {"comment_html": "<p></p>", "request_id": uuid4().hex, "attachment_ids": [str(wrong_task.id)]},
        {"comment_html": "<p></p>", "request_id": uuid4().hex, "attachment_ids": [str(foreign.id)]},
        {"comment_html": "<p></p>", "request_id": uuid4().hex, "attachment_ids": [str(first.id), str(first.id)]},
        {
            "comment_html": "<p></p>",
            "request_id": uuid4().hex,
            "attachment_ids": [str(uuid4()) for _ in range(11)],
        },
    ]
    for payload in invalid_payloads:
        assert env["student_client"].post(base, payload, format="json").status_code == 400


def test_attachment_idempotency_compares_html_and_assets(env):
    task = _create(env)
    asset = make_task_asset(
        env,
        task["id"],
        entity_type=FileAsset.EntityTypeContext.RESEARCH_TASK_COMMENT_ATTACHMENT,
    )
    base = f"{task_base(env, task['id'])}comments/"
    request_id = uuid4().hex
    payload = {"comment_html": "<p>补充文件</p>", "request_id": request_id, "attachment_ids": [str(asset.id)]}
    first = env["student_client"].post(base, payload, format="json")
    retry = env["student_client"].post(base, payload, format="json")
    assert first.status_code == 201
    assert retry.status_code == 200
    assert retry.data["id"] == first.data["id"]

    changed = env["student_client"].post(base, {**payload, "attachment_ids": []}, format="json")
    assert changed.status_code == 409


def test_inline_image_uses_task_scoped_asset_and_rejects_external_source(env):
    task = _create(env)
    configure_limits(env["workspace"], image=1)
    base = f"{task_base(env, task['id'])}comment-images/"
    with patch("plane.research.views.task_comment_assets.S3Storage") as storage:
        storage.return_value.generate_presigned_post.return_value = {"url": "https://storage.test", "fields": {}}
        prepared = env["student_client"].post(
            base,
            {"file_name": "figure.png", "content_type": "image/png", "size": 128},
            format="json",
        )
        assert prepared.status_code == 200, prepared.data
        asset_id = prepared.data["asset_id"]

        storage.return_value.get_object_metadata.return_value = {"ContentType": "image/png", "ContentLength": 128}
        image_body = b"\x89PNG\r\n\x1a\n" + b"0" * 120
        storage.return_value.server_s3_client.get_object.return_value = {"Body": BytesIO(image_body)}
        confirmed = env["student_client"].post(f"{base}{asset_id}/", {}, format="json")
    assert confirmed.status_code == 201, confirmed.data
    assert confirmed.data["asset_id"] == asset_id
    image_url = f"{base}{asset_id}/"

    deleted = env["student_client"].delete(image_url)
    assert deleted.status_code == 204
    restored = env["student_client"].post(image_url, {"restore": True}, format="json")
    assert restored.status_code == 200, restored.data

    comments = f"{task_base(env, task['id'])}comments/"
    external = env["student_client"].post(
        comments,
        {
            "comment_html": '<p><img src="https://example.com/a.png"></p>',
            "request_id": uuid4().hex,
        },
        format="json",
    )
    assert external.status_code == 400
    valid = env["student_client"].post(
        comments,
        {"comment_html": f'<p><img src="{image_url}"></p>', "request_id": uuid4().hex},
        format="json",
    )
    assert valid.status_code == 201, valid.data
    assert image_url in valid.data["comment_html"]

    with patch("plane.research.views.task_comment_assets.S3Storage") as storage:
        storage.return_value.generate_presigned_url.return_value = "https://signed.test/image.png"
        response = env["student_client"].get(image_url)
    assert response.status_code == 302
    assert response.url == "https://signed.test/image.png"


def test_inactive_chain_is_read_only_and_comment_delete_soft_deletes_assets(env):
    task = _create(env)
    configure_limits(env["workspace"])
    asset = make_task_asset(
        env,
        task["id"],
        entity_type=FileAsset.EntityTypeContext.RESEARCH_TASK_COMMENT_ATTACHMENT,
    )
    base = f"{task_base(env, task['id'])}comments/"
    created = env["student_client"].post(
        base,
        {"comment_html": "<p></p>", "request_id": uuid4().hex, "attachment_ids": [str(asset.id)]},
        format="json",
    )
    assert created.status_code == 201, created.data

    env["chain"].status = "ARCHIVED"
    env["chain"].save(update_fields=["status"])
    assert (
        env["student_client"]
        .post(
            f"{task_base(env, task['id'])}comment-attachments/presign/",
            {"file_name": "x.bin", "content_type": "application/octet-stream", "size": 1},
            format="json",
        )
        .status_code
        == 409
    )
    assert env["student_client"].delete(f"{base}{created.data['id']}/").status_code == 409

    env["chain"].status = "ACTIVE"
    env["chain"].save(update_fields=["status"])
    assert env["student_client"].delete(f"{base}{created.data['id']}/").status_code == 204
    asset.refresh_from_db()
    assert asset.is_deleted and asset.deleted_at
    assert (
        env["student_client"].get(f"{task_base(env, task['id'])}comment-attachments/{asset.id}/download/").status_code
        == 404
    )
