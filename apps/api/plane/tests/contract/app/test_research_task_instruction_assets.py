"""Research task description image and attachment contracts."""

from io import BytesIO
from unittest.mock import patch
from uuid import UUID, uuid4

import pytest
from django.utils import timezone

from plane.db.models import (
    FileAsset,
    ResearchAuditEvent,
    ResearchChainNodeTask,
    ResearchChainNodeTaskAttachment,
    WorkspaceResearchSetting,
)
from plane.research.services.chain_context import ResearchReadService
from plane.tests.contract.app.test_research_chain_tasks import _client, _create, _url
from plane.tests.research_fixtures import make_research_boundary_fixture

pytestmark = [pytest.mark.contract, pytest.mark.django_db]


@pytest.fixture
def env(settings):
    settings.RESEARCH_MODULE_ENABLED = True
    fixture = make_research_boundary_fixture()
    fixture.update(
        {
            "student_client": _client(fixture["student"]),
            "advisor_client": _client(fixture["advisor"]),
        }
    )
    return fixture


def configure_limits(workspace, *, image=1, pdf=1):
    """Configure the research upload categories used by this module."""
    return WorkspaceResearchSetting.objects.update_or_create(
        workspace=workspace,
        defaults={"image_max_mb": image, "pdf_max_mb": pdf},
    )[0]


def prepare_image(env, task, file_name="figure.png"):
    """Create and confirm one task-description image."""
    base = f"{_url(env, task['id'])}instruction-images/"
    with patch("plane.research.views.task_instruction_assets.S3Storage") as storage:
        storage.return_value.generate_presigned_post.return_value = {
            "url": "https://storage.test",
            "fields": {},
        }
        prepared = env["student_client"].post(
            base,
            {"file_name": file_name, "content_type": "image/png", "size": 128},
            format="json",
        )
        assert prepared.status_code == 200, prepared.data
        asset_id = prepared.data["asset_id"]

        body = b"\x89PNG\r\n\x1a\n" + b"0" * 120
        storage.return_value.get_object_metadata.return_value = {
            "ContentType": "image/png",
            "ContentLength": len(body),
        }
        storage.return_value.server_s3_client.get_object.return_value = {"Body": BytesIO(body)}
        confirmed = env["student_client"].post(f"{base}{asset_id}/", {}, format="json")
    assert confirmed.status_code == 201, confirmed.data
    return base, asset_id


def make_instruction_attachment(env, task_id, *, confirmed=True):
    """Create one task-description asset and optionally its persisted relation."""
    asset = FileAsset(
        workspace=env["workspace"],
        created_by=env["student"],
        entity_type=FileAsset.EntityTypeContext.RESEARCH_TASK_INSTRUCTION_ATTACHMENT,
        entity_identifier=str(task_id),
        is_uploaded=confirmed,
        size=128,
        asset=f"{env['workspace'].id}/{uuid4()}.pdf",
        attributes={"name": "过程说明.pdf", "type": "application/pdf", "size": 128},
    )
    asset.save(disable_auto_set_user=True)
    if confirmed:
        ResearchChainNodeTaskAttachment.objects.create(
            task=ResearchChainNodeTask.objects.get(pk=task_id),
            asset=asset,
            file_name="过程说明.pdf",
            file_size=128,
            content_type="application/pdf",
            uploaded_by=env["student"],
            created_by=env["student"],
        )
    return asset


def test_instruction_is_sanitized_and_only_accepts_task_scoped_images(env):
    task = _create(env)
    configure_limits(env["workspace"])
    base, asset_id = prepare_image(env, task)

    unsafe = env["student_client"].patch(
        _url(env, task["id"]),
        {"instruction": '<p>补充说明</p><script>alert("x")</script>'},
        format="json",
    )
    assert unsafe.status_code == 200, unsafe.data
    assert "<script>" not in unsafe.data["data"]["instruction"]
    assert "补充说明" in unsafe.data["data"]["instruction"]

    external = env["student_client"].patch(
        _url(env, task["id"]),
        {"instruction": '<p><img src="https://example.com/external.png"></p>'},
        format="json",
    )
    assert external.status_code == 422

    source = f"{base}{asset_id}/"
    saved = env["student_client"].patch(
        _url(env, task["id"]),
        {"instruction": f'<p>实验图</p><image-component src="{source}"></image-component>'},
        format="json",
    )
    assert saved.status_code == 200, saved.data
    assert source in saved.data["data"]["instruction"]
    assert saved.data["data"]["instruction_attachments"] == []

    with patch("plane.research.views.task_instruction_assets.S3Storage") as storage:
        storage.return_value.generate_presigned_url.return_value = "https://signed.test/image.png"
        readable = env["advisor_client"].get(source)
    assert readable.status_code == 302
    assert readable.url == "https://signed.test/image.png"


def test_instruction_image_delete_and_restore(env):
    task = _create(env)
    configure_limits(env["workspace"])
    base, asset_id = prepare_image(env, task)
    source = f"{base}{asset_id}/"

    assert env["student_client"].delete(source).status_code == 204
    assert ResearchAuditEvent.objects.filter(action="task.instruction.attachment.delete").exists()
    with patch("plane.research.views.task_instruction_assets.S3Storage") as storage:
        storage.return_value.generate_presigned_url.return_value = "https://signed.test/image.png"
        assert env["student_client"].get(source).status_code == 404
    restored = env["student_client"].post(source, {"restore": True}, format="json")
    assert restored.status_code == 200, restored.data
    with patch("plane.research.views.task_instruction_assets.S3Storage") as storage:
        storage.return_value.generate_presigned_url.return_value = "https://signed.test/image.png"
        assert env["student_client"].get(source).status_code == 302


def test_agent_context_receives_plain_text_instruction(env):
    task = _create(env)
    record = ResearchChainNodeTask.objects.get(pk=task["id"])
    record.instruction = '<p>补充 <strong>样本量</strong></p><script>alert("x")</script>'
    record.save(update_fields=["instruction", "updated_at"])

    reader = ResearchReadService(workspace=env["workspace"], user=env["student"])
    node = reader.node(env["paper_node"].id)
    listed = reader.list_research_node_tasks(node.id)
    content, _version = reader._content(node, "task", record, None)
    assert listed["data"][0]["instruction"] == "补充 样本量"
    assert content["instruction"] == "补充 样本量"


def test_instruction_attachment_roundtrip_and_delete(env):
    task = _create(env)
    configure_limits(env["workspace"])
    base = f"{_url(env, task['id'])}instruction-attachments/"
    with patch("plane.research.views.task_instruction_assets.S3Storage") as storage:
        storage.return_value.generate_presigned_post.return_value = {
            "url": "https://storage.test",
            "fields": {},
        }
        prepared = env["student_client"].post(
            f"{base}presign/",
            {"file_name": "过程说明.pdf", "content_type": "application/pdf", "size": 128},
            format="json",
        )
        assert prepared.status_code == 200, prepared.data
        asset_id = prepared.data["asset_id"]

        body = b"%PDF-1.4\n" + b"0" * 120
        storage.return_value.get_object_metadata.return_value = {
            "ContentType": "application/pdf",
            "ContentLength": len(body),
        }
        storage.return_value.server_s3_client.get_object.return_value = {"Body": BytesIO(body)}
        confirmed = env["student_client"].post(f"{base}{asset_id}/confirm/", {}, format="json")

    assert confirmed.status_code == 201, confirmed.data
    attachment = ResearchChainNodeTaskAttachment.objects.get(asset_id=asset_id)
    assert attachment.task_id == UUID(task["id"])
    assert attachment.file_name == "过程说明.pdf"

    detail = env["student_client"].get(_url(env, task["id"]))
    projected = detail.data["data"]["instruction_attachments"]
    assert len(projected) == 1
    assert projected[0]["id"] == asset_id
    assert projected[0]["name"] == "过程说明.pdf"
    assert projected[0]["type"] == "application/pdf"
    assert projected[0]["size"] == len(body)
    assert projected[0]["download_url"] == f"{base}{asset_id}/download/"

    with patch("plane.research.views.task_instruction_assets.S3Storage") as storage:
        storage.return_value.generate_presigned_url.return_value = "https://signed.test/file.pdf"
        downloaded = env["advisor_client"].get(f"{base}{asset_id}/download/")
    assert downloaded.status_code == 302
    assert downloaded.url == "https://signed.test/file.pdf"

    assert env["student_client"].delete(f"{base}{asset_id}/").status_code == 204
    assert env["student_client"].get(_url(env, task["id"])).data["data"]["instruction_attachments"] == []
    assert env["student_client"].get(f"{base}{asset_id}/download/").status_code == 404
    assert ResearchAuditEvent.objects.filter(action="task.instruction.attachment.add").exists()
    assert ResearchAuditEvent.objects.filter(action="task.instruction.attachment.delete").exists()


def test_instruction_attachment_presign_rejects_the_fifty_first_file(env):
    """任务描述附件预签名阶段即执行 50 个数量上限。"""
    task = _create(env)
    configure_limits(env["workspace"])
    for _ in range(50):
        make_instruction_attachment(env, task["id"])

    response = env["student_client"].post(
        f"{_url(env, task['id'])}instruction-attachments/presign/",
        {"file_name": "第五十一份.pdf", "content_type": "application/pdf", "size": 128},
        format="json",
    )

    assert response.status_code == 400, response.data
    assert response.data["error_code"] == "attachment_count_exceeded"
    assert response.data["limit"] == 50


def test_instruction_attachment_confirm_enforces_limit_and_delete_restores_quota(env):
    """确认阶段并发复核数量，删除后额度立即可复用。"""
    task = _create(env)
    configure_limits(env["workspace"])
    attachments = [make_instruction_attachment(env, task["id"]) for _ in range(49)]
    boundary = make_instruction_attachment(env, task["id"], confirmed=False)
    base = f"{_url(env, task['id'])}instruction-attachments/"

    def confirm(asset):
        with patch("plane.research.views.task_instruction_assets.S3Storage") as storage:
            body = b"%PDF-1.4\n" + b"0" * 120
            storage.return_value.get_object_metadata.return_value = {
                "ContentType": "application/pdf",
                "ContentLength": len(body),
            }
            storage.return_value.server_s3_client.get_object.return_value = {"Body": BytesIO(body)}
            return env["student_client"].post(f"{base}{asset.id}/confirm/", {}, format="json")

    boundary_response = confirm(boundary)
    assert boundary_response.status_code == 201, boundary_response.data

    overflow = make_instruction_attachment(env, task["id"], confirmed=False)
    overflow_response = confirm(overflow)
    assert overflow_response.status_code == 400, overflow_response.data
    assert overflow_response.data["error_code"] == "attachment_count_exceeded"
    assert overflow_response.data["limit"] == 50

    now = timezone.now()
    first_relation = ResearchChainNodeTaskAttachment.objects.get(task_id=task["id"], asset=attachments[0])
    first_relation.deleted_at = now
    first_relation.save(update_fields=["deleted_at", "updated_at"])
    attachments[0].is_deleted = True
    attachments[0].deleted_at = now
    attachments[0].save(update_fields=["is_deleted", "deleted_at", "updated_at"])

    retry_response = confirm(overflow)
    assert retry_response.status_code == 201, retry_response.data


def test_instruction_assets_reject_wrong_task_writer_and_readonly_task(env):
    task = _create(env)
    other = _create(env)
    configure_limits(env["workspace"])
    base = f"{_url(env, task['id'])}instruction-images/"
    other_base = f"{_url(env, other['id'])}instruction-images/"
    with patch("plane.research.views.task_instruction_assets.S3Storage") as storage:
        storage.return_value.generate_presigned_post.return_value = {
            "url": "https://storage.test",
            "fields": {},
        }
        prepared = env["student_client"].post(
            base,
            {"file_name": "figure.png", "content_type": "image/png", "size": 128},
            format="json",
        )
    assert prepared.status_code == 200
    asset_id = prepared.data["asset_id"]
    assert env["student_client"].post(f"{other_base}{asset_id}/", {}, format="json").status_code == 404
    assert (
        env["advisor_client"]
        .post(
            base,
            {"file_name": "figure.png", "content_type": "image/png", "size": 128},
            format="json",
        )
        .status_code
        == 403
    )

    assert FileAsset.objects.get(pk=asset_id).entity_identifier == task["id"]
    task_obj = ResearchChainNodeTask.objects.get(pk=task["id"])
    task_obj.status = "COMPLETED"
    task_obj.save(update_fields=["status"])
    readonly = env["student_client"].post(
        base,
        {"file_name": "another.png", "content_type": "image/png", "size": 128},
        format="json",
    )
    assert readonly.status_code == 409
