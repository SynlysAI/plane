"""AI4MS 4.21 反馈数据预检与幂等迁移契约。"""

from datetime import datetime, timezone
import hashlib
import json
from unittest import mock
from uuid import uuid4

import pytest
from django.core.management import call_command
from django.core.management.base import CommandError
from django.db import IntegrityError
from django.db import connection

from plane.db.models import FileAsset, ResearchAuditEvent, ResearchFeedback, ResearchFeedbackScreenshot
from plane.research.services.feedback_migration import (
    MigrationExecutionError,
    import_prepared_feedback,
    prepare_feedback_migration,
)
from plane.tests.contract.app.test_research_browse import env as browse_environment  # noqa: F401

pytestmark = pytest.mark.contract

PNG_BYTES = b"\x89PNG\r\n\x1a\nlegacy-feedback-screenshot"
CREATED_AT = datetime(2026, 10, 8, 8, 0, 0, tzinfo=timezone.utc)
UPDATED_AT = datetime(2026, 10, 8, 9, 0, 0, tzinfo=timezone.utc)
HISTORY_AT = datetime(2026, 10, 8, 8, 30, 0, tzinfo=timezone.utc)


@pytest.fixture
def env(browse_environment):  # noqa: F811 - pytest requires a local fixture name.
    """Reuse the multi-role research browse environment."""
    return browse_environment


class FakeSource:
    """提供与 Mongo/GridFS 相同的只读记录接口。"""

    def __init__(self, records):
        self.records_data = records
        self.screenshots = {"legacy-shot": PNG_BYTES}

    def records(self):
        return self.records_data

    def close(self):
        """保持与命令使用的 Mongo source 相同的接口。"""

    def read_screenshot(self, screenshot_id):
        if screenshot_id not in {"legacy-shot", "broken-shot"}:
            raise RuntimeError("screenshot not found")
        return self.screenshots[screenshot_id]


def legacy_payload_hash(record):
    """Recreate the payload hash used by the short-lived AI4MS 1.1 BFF."""
    payload = {
        key: record[key]
        for key in ("content", "feedback_type", "path", "browser", "module", "idempotency_key")
    }
    screenshot_digests = b"".join(
        hashlib.sha256(FakeSource({}).screenshots.get(item["id"], b"missing")).digest()
        for item in record["screenshots"]
    )
    return hashlib.sha256(json.dumps(payload, sort_keys=True).encode() + screenshot_digests).hexdigest()


def legacy_record(env, **overrides):
    """构造一条真实 4.21 BFF 形态的 Plane 反馈记录。"""
    payload = {
        "platform": "plane",
        "feedback_id": f"fb_{uuid4().hex}",
        "workspace_id": str(env["workspace"].id),
        "user_id": str(env["student"].id),
        "username": "Student Alpha",
        "org_unit_id": str(env["group_a"].id),
        "content": "Legacy weekly upload feedback",
        "feedback_type": "bug",
        "status": "in_progress",
        "path": "/lab/research",
        "browser": "Legacy browser",
        "module": "research",
        "idempotency_key": uuid4().hex,
        "payload_hash": None,
        "created_at": CREATED_AT,
        "updated_at": UPDATED_AT,
        "history": [
            {
                "actor": str(env["pi"].id),
                "actor_name": "Main PI",
                "from_status": "open",
                "to_status": "in_progress",
                "comment": "Reproduced",
                "created_at": HISTORY_AT,
            }
        ],
        "screenshots": [{"id": "legacy-shot", "content_type": "image/png", "size": len(PNG_BYTES)}],
    }
    payload.update(overrides)
    if payload["payload_hash"] is None:
        payload["payload_hash"] = legacy_payload_hash(payload)
    return payload


@pytest.mark.django_db
def test_dry_run_validates_counts_and_writes_nothing(env):
    record = legacy_record(env)
    summary, prepared = prepare_feedback_migration(FakeSource([record]), env["workspace"])

    assert summary["source_records"] == 1
    assert summary["source_screenshots"] == 1
    assert summary["source_history"] == 1
    assert summary["valid_records"] == 1
    assert summary["records_to_import"] == 1
    assert summary["failed_records"] == 0
    assert len(prepared) == 1
    assert not ResearchFeedback.objects.exists()
    assert not FileAsset.objects.exists()


@pytest.mark.django_db
def test_dry_run_recomputes_legacy_payload_hash_without_retaining_screenshot_bytes(env):
    record = legacy_record(env, payload_hash="b" * 64)
    summary, prepared = prepare_feedback_migration(FakeSource([record]), env["workspace"])

    assert summary["failed_records"] == 1
    assert summary["issues"][0]["message"] == "旧反馈幂等负载哈希与源数据不一致。"
    assert prepared == []

    valid = legacy_record(env)
    _, valid_prepared = prepare_feedback_migration(FakeSource([valid]), env["workspace"])
    assert valid_prepared[0].screenshots[0].digest == hashlib.sha256(PNG_BYTES).hexdigest()
    assert not hasattr(valid_prepared[0].screenshots[0], "content")


@pytest.mark.django_db
def test_execute_imports_preserves_history_and_is_idempotent(env):
    record = legacy_record(env)
    source = FakeSource([record])
    _, prepared = prepare_feedback_migration(source, env["workspace"])
    storage = mock.Mock()
    storage.upload_file.return_value = True

    with mock.patch("plane.research.services.feedback_migration.S3Storage", return_value=storage):
        feedback_id = import_prepared_feedback(prepared[0], env["workspace"], source)

    feedback = ResearchFeedback.objects.get(pk=feedback_id)
    assert feedback.legacy_feedback_id == record["feedback_id"]
    assert feedback.created_by == env["student"]
    assert feedback.org_unit == env["group_a"]
    assert feedback.status == "in_progress"
    assert feedback.created_at == CREATED_AT
    assert feedback.updated_at == UPDATED_AT
    assert feedback.updated_by == env["pi"]
    assert feedback.screenshots.count() == 1
    assert feedback.screenshots.get().created_at == CREATED_AT
    assert FileAsset.objects.get(entity_identifier=feedback_id).size == len(PNG_BYTES)
    assert (
        FileAsset.objects.get(entity_identifier=feedback_id).attributes["sha256"]
        == hashlib.sha256(PNG_BYTES).hexdigest()
    )
    assert (
        ResearchAuditEvent.objects.filter(action="feedback.status.update", resource_id=feedback.id, actor=env["pi"])
        .get()
        .created_at
        == HISTORY_AT
    )
    assert ResearchAuditEvent.objects.filter(
        action="feedback.import",
        resource_id=feedback.id,
        metadata__legacy_feedback_id=record["feedback_id"],
    ).exists()

    summary, rerun_prepared = prepare_feedback_migration(FakeSource([record]), env["workspace"])
    assert summary["already_imported"] == 1
    assert summary["records_to_import"] == 0
    assert rerun_prepared[0].already_imported


@pytest.mark.django_db
def test_execute_revalidates_screenshot_bytes_after_dry_run(env):
    source = FakeSource([legacy_record(env)])
    _, prepared = prepare_feedback_migration(source, env["workspace"])
    source.screenshots["legacy-shot"] = b"\x89PNG\r\n\x1a\nchanged-after-dry-run"
    storage = mock.Mock()
    storage.upload_file.return_value = True

    with (
        mock.patch("plane.research.services.feedback_migration.S3Storage", return_value=storage),
        pytest.raises(MigrationExecutionError, match="预检后发生变化"),
    ):
        import_prepared_feedback(prepared[0], env["workspace"], source)

    storage.upload_file.assert_not_called()
    assert not ResearchFeedback.objects.exists()
    assert not FileAsset.objects.exists()


@pytest.mark.django_db
def test_idempotent_rerun_requires_complete_history_and_screenshot_hash(env):
    record = legacy_record(env)
    source = FakeSource([record])
    _, prepared = prepare_feedback_migration(source, env["workspace"])
    storage = mock.Mock()
    storage.upload_file.return_value = True
    with mock.patch("plane.research.services.feedback_migration.S3Storage", return_value=storage):
        feedback_id = import_prepared_feedback(prepared[0], env["workspace"], source)

    event_id = ResearchAuditEvent.objects.filter(
        action="feedback.status.update",
        resource_id=feedback_id,
    ).values_list("id", flat=True).first()
    with connection.cursor() as cursor:
        cursor.execute(
            "UPDATE research_audit_events SET metadata = '{}'::jsonb WHERE id = %s",
            [event_id],
        )
    summary, rerun = prepare_feedback_migration(FakeSource([record]), env["workspace"])

    assert summary["failed_records"] == 1
    assert summary["issues"][0]["message"] == "同旧反馈 ID 已存在但导入内容不完整，需人工核对。"
    assert rerun == []


@pytest.mark.django_db
def test_command_dry_run_failure_is_nonzero_and_does_not_import(env):
    record = legacy_record(env, screenshots=[{"id": "missing", "content_type": "image/png", "size": 1}])

    with (
        mock.patch(
            "plane.db.management.commands.import_research_feedback_from_ai4ms.Ai4MSFeedbackSource",
            return_value=FakeSource([record]),
        ),
        pytest.raises(CommandError, match="1 条记录需要修正"),
    ):
        call_command(
            "import_research_feedback_from_ai4ms",
            mongo_uri="mongodb://source.invalid",
            mongo_database="ai4ms",
            workspace_slug=env["workspace"].slug,
        )

    assert not ResearchFeedback.objects.exists()


@pytest.mark.django_db
def test_database_failure_cleans_uploaded_objects_and_leaves_no_partial_record(env):
    _, prepared = prepare_feedback_migration(FakeSource([legacy_record(env)]), env["workspace"])
    storage = mock.Mock()
    storage.upload_file.return_value = True

    with (
        mock.patch("plane.research.services.feedback_migration.S3Storage", return_value=storage),
        mock.patch.object(
            ResearchFeedbackScreenshot.objects,
            "create",
            side_effect=IntegrityError("registration failed"),
        ),
        pytest.raises(MigrationExecutionError, match="数据库登记失败"),
    ):
        import_prepared_feedback(prepared[0], env["workspace"], FakeSource([legacy_record(env)]))

    storage.delete_files.assert_called_once()
    assert storage.delete_files.call_args.args[0][0].endswith(".png")
    assert not ResearchFeedback.objects.exists()
    assert not ResearchFeedbackScreenshot.objects.exists()
    assert not FileAsset.objects.filter(entity_type=FileAsset.EntityTypeContext.FEEDBACK_SCREENSHOT).exists()
