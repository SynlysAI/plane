"""One-shot AI4MS Plane feedback migration service.

The service intentionally treats AI4MS MongoDB as a read-only source. Plane is
the only system mutated by ``--execute`` so failed runs can always be retried
after correcting the source or deployment configuration.
"""

import logging
import hashlib
import json
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from io import BytesIO
from uuid import UUID

from django.db import connection, DatabaseError, IntegrityError, transaction

from plane.db.models import (
    FileAsset,
    OrgUnit,
    ResearchAuditEvent,
    ResearchFeedback,
    ResearchFeedbackScreenshot,
    User,
    Workspace,
)
from plane.research.services.feedback import SCREENSHOT_EXTENSIONS, SCREENSHOT_LIMIT, _valid_image_header
from plane.research.utils.audit import ResearchAuditAction, ResearchResourceType, record_audit_event
from plane.settings.storage import S3Storage
from plane.utils.path_validator import sanitize_filename

LOGGER = logging.getLogger(__name__)
ALLOWED_FEEDBACK_TYPES = {"bug", "ux", "idea", "other"}
ALLOWED_STATUSES = {"open", "in_progress", "done", "closed"}
SCREENSHOT_SUFFIXES = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/webp": ".webp",
}


class MigrationValidationError(Exception):
    """Raised when a migration request contains invalid source data."""


class MigrationExecutionError(Exception):
    """Raised when a validated feedback record cannot be imported atomically."""


@dataclass(frozen=True)
class MigrationIssue:
    """A single source-record validation failure without feedback content."""

    feedback_id: str
    message: str


@dataclass(frozen=True)
class PreparedScreenshot:
    """A validated GridFS screenshot prepared for Plane S3 upload."""

    legacy_id: str
    content_type: str
    size: int
    safe_name: str
    digest: str


@dataclass(frozen=True)
class PreparedHistory:
    """A status-history entry with its original Plane actor and timestamp."""

    actor: User
    actor_name: str
    from_status: str
    to_status: str
    comment: str
    created_at: datetime


@dataclass
class PreparedFeedback:
    """A fully validated AI4MS feedback record ready for idempotent import."""

    legacy_feedback_id: str
    source_record: dict
    user: User
    org_unit: OrgUnit | None
    content: str
    feedback_type: str
    status: str
    path: str
    browser: str
    module: str
    username: str
    idempotency_key: str
    payload_hash: str
    created_at: datetime
    updated_at: datetime
    screenshots: list[PreparedScreenshot]
    history: list[PreparedHistory]
    already_imported: bool


class Ai4MSFeedbackSource:
    """Read-only MongoDB/GridFS adapter for the 4.21 feedback BFF data."""

    def __init__(self, mongo_uri: str, database_name: str):
        """Connect to AI4MS MongoDB and its feedback screenshot bucket.

        Args:
            mongo_uri: MongoDB connection URI supplied by the operator.
            database_name: Database that contains the 4.21 feedback data.
        """
        from gridfs import GridFS
        from pymongo import MongoClient

        self._client = MongoClient(mongo_uri, serverSelectionTimeoutMS=5000)
        self._database = self._client[database_name]
        self._bucket = GridFS(self._database, collection="feedback_screenshots")

    def close(self):
        """Close the MongoDB connection."""
        self._client.close()

    def records(self) -> list[dict]:
        """Return all legacy Plane feedback records in creation order."""
        from pymongo.errors import PyMongoError

        try:
            return list(self._database.feedbacks.find({"platform": "plane"}).sort("created_at", 1))
        except PyMongoError as error:
            raise MigrationValidationError(f"AI4MS MongoDB 读取失败：{error}") from error

    def read_screenshot(self, screenshot_id: str) -> bytes:
        """Read one screenshot from GridFS without mutating the source.

        Args:
            screenshot_id: Legacy GridFS object ID as a string.

        Returns:
            The complete screenshot content.

        Raises:
            MigrationValidationError: The ID or underlying GridFS object is unavailable.
        """
        from bson.errors import InvalidId
        from bson.objectid import ObjectId
        from gridfs.errors import NoFile

        try:
            stream = self._bucket.get(ObjectId(screenshot_id))
            content = stream.read()
        except (InvalidId, NoFile, TypeError, ValueError) as error:
            raise MigrationValidationError(f"GridFS 截图不存在：{error}") from error
        if not content:
            raise MigrationValidationError("GridFS 截图为空文件。")
        return content


def _parse_uuid(value, label: str) -> UUID:
    """Parse a required UUID from the legacy Plane principal snapshot.

    Args:
        value: Raw UUID value stored in MongoDB.
        label: Field name used in the validation error.

    Returns:
        The parsed UUID.
    """
    try:
        return UUID(str(value))
    except (TypeError, ValueError) as error:
        raise MigrationValidationError(f"{label} 不是有效 UUID。") from error


def _aware_datetime(value, label: str) -> datetime:
    """Normalize a legacy Mongo datetime to an aware UTC datetime.

    Args:
        value: Raw datetime value.
        label: Field name used in the validation error.

    Returns:
        The timezone-aware datetime.
    """
    if not isinstance(value, datetime):
        raise MigrationValidationError(f"{label} 不是有效时间。")
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def _validated_screenshot(source: Ai4MSFeedbackSource, item, legacy_feedback_id: str) -> PreparedScreenshot:
    """Validate one legacy GridFS screenshot descriptor and its bytes.

    Args:
        source: Read-only AI4MS source adapter.
        item: Screenshot metadata from the feedback record.
        legacy_feedback_id: Parent legacy feedback ID for diagnostics.

    Returns:
        The prepared screenshot.
    """
    if not isinstance(item, dict):
        raise MigrationValidationError("截图元数据格式无效。")
    screenshot_id = str(item.get("id") or "")
    content_type = str(item.get("content_type") or "").split(";", 1)[0].strip().lower()
    if content_type not in SCREENSHOT_EXTENSIONS:
        raise MigrationValidationError("截图 MIME 必须为 PNG、JPEG 或 WebP。")
    try:
        content = source.read_screenshot(screenshot_id)
    except MigrationValidationError:
        raise
    except Exception as error:
        raise MigrationValidationError(f"GridFS 截图读取失败：{error}") from error
    if not 0 < len(content) <= SCREENSHOT_LIMIT:
        raise MigrationValidationError("截图须为非空文件且不超过 10 MB。")
    if not _valid_image_header(content[:512], content_type):
        raise MigrationValidationError("截图文件头与声明格式不一致。")
    declared_size = item.get("size")
    try:
        declared_size_value = None if declared_size is None else int(declared_size)
    except (TypeError, ValueError) as error:
        raise MigrationValidationError("截图元数据大小无效。") from error
    actual_size = len(content)
    if declared_size_value is not None and declared_size_value != actual_size:
        raise MigrationValidationError("截图元数据大小与实际文件不一致。")
    safe_name = sanitize_filename(f"screenshot-{legacy_feedback_id}{SCREENSHOT_SUFFIXES[content_type]}")
    digest = hashlib.sha256(content).hexdigest()
    return PreparedScreenshot(
        legacy_id=screenshot_id,
        content_type=content_type,
        size=actual_size,
        safe_name=safe_name or f"screenshot-{legacy_feedback_id}{SCREENSHOT_SUFFIXES[content_type]}",
        digest=digest,
    )


def _validated_history(item, workspace: Workspace) -> PreparedHistory:
    """Validate one legacy status-history entry and resolve its actor.

    Args:
        item: History entry stored in MongoDB.
        workspace: Target Plane workspace.

    Returns:
        The prepared history entry.
    """
    if not isinstance(item, dict):
        raise MigrationValidationError("状态历史格式无效。")
    from_status = str(item.get("from_status") or "")
    to_status = str(item.get("to_status") or "")
    comment = str(item.get("comment") or "").strip()
    actor_name = str(item.get("actor_name") or "").strip()
    if from_status not in ALLOWED_STATUSES or to_status not in ALLOWED_STATUSES:
        raise MigrationValidationError("状态历史包含无效状态。")
    if not comment or len(comment) > 2000:
        raise MigrationValidationError("状态历史说明不能为空且不超过 2000 字。")
    if not actor_name or len(actor_name) > 100:
        raise MigrationValidationError("状态历史操作者姓名无效。")
    actor_id = _parse_uuid(item.get("actor"), "状态历史操作者")
    actor = User.objects.filter(pk=actor_id).first()
    if actor is None:
        raise MigrationValidationError("状态历史操作者不存在。")
    return PreparedHistory(
        actor=actor,
        actor_name=actor_name,
        from_status=from_status,
        to_status=to_status,
        comment=comment,
        created_at=_aware_datetime(item.get("created_at"), "状态历史时间"),
    )


def _existing_matches(existing: ResearchFeedback, prepared: PreparedFeedback) -> bool:
    """Check whether a legacy feedback ID already has a complete Plane import.

    Args:
        existing: Existing Plane feedback carrying the same legacy ID.
        prepared: Fully validated source record.

    Returns:
        Whether the existing import is complete and may be skipped.
    """
    screenshots = list(
        existing.screenshots.filter(
            deleted_at__isnull=True,
            asset__is_deleted=False,
            asset__deleted_at__isnull=True,
        )
        .select_related("asset")
        .order_by("position", "created_at")
    )
    history_events = list(
        ResearchAuditEvent.objects.filter(
        workspace_id=existing.workspace_id,
        resource_type=ResearchResourceType.RESEARCH_FEEDBACK,
        resource_id=existing.id,
        action=ResearchAuditAction.FEEDBACK_STATUS_UPDATE,
    ).order_by("created_at", "id")
    )
    import_exists = ResearchAuditEvent.objects.filter(
        workspace_id=existing.workspace_id,
        resource_type=ResearchResourceType.RESEARCH_FEEDBACK,
        resource_id=existing.id,
        action=ResearchAuditAction.FEEDBACK_IMPORT,
        metadata__legacy_feedback_id=prepared.legacy_feedback_id,
    ).exists()
    return bool(
        import_exists
        and existing.created_by_id == prepared.user.id
        and existing.content == prepared.content
        and existing.feedback_type == prepared.feedback_type
        and existing.status == prepared.status
        and existing.idempotency_key == prepared.idempotency_key
        and existing.payload_hash == prepared.payload_hash
        and (existing.org_unit_id == prepared.org_unit.id if prepared.org_unit else existing.org_unit_id is None)
        and existing.created_at == prepared.created_at
        and existing.updated_at == prepared.updated_at
        and len(screenshots) == len(prepared.screenshots)
        and all(
            screenshot.asset.attributes.get("sha256") == item.digest
            and screenshot.asset.attributes.get("name") == item.safe_name
            and screenshot.asset.attributes.get("type") == item.content_type
            and screenshot.asset.size == item.size
            for screenshot, item in zip(screenshots, prepared.screenshots, strict=True)
        )
        and len(history_events) == len(prepared.history)
        and all(
            event.metadata.get("actor_name") == history.actor_name
            and event.metadata.get("from_status") == history.from_status
            and event.metadata.get("to_status") == history.to_status
            and event.metadata.get("comment") == history.comment
            and event.actor_id == history.actor.id
            and event.created_at == history.created_at
            for event, history in zip(history_events, prepared.history, strict=True)
        )
    )


def _prepare_record(
    source: Ai4MSFeedbackSource,
    workspace: Workspace,
    record: dict,
    seen_legacy_ids: set[str],
    seen_idempotency_keys: set[tuple[str, str]],
) -> PreparedFeedback | None:
    """Validate one Mongo record and resolve all Plane relationships.

    Args:
        source: Read-only AI4MS source adapter.
        workspace: Target Plane workspace.
        record: Raw legacy feedback document.
        seen_legacy_ids: Legacy IDs already seen in this source batch.
        seen_idempotency_keys: User/idempotency pairs already seen in this batch.

    Returns:
        The prepared feedback, or ``None`` when validation fails.

    Raises:
        MigrationValidationError: The source record requires correction before import.
    """
    legacy_feedback_id = str(record.get("feedback_id") or "")
    if not legacy_feedback_id or len(legacy_feedback_id) > 64:
        raise MigrationValidationError("旧反馈 ID 无效。")
    if legacy_feedback_id in seen_legacy_ids:
        raise MigrationValidationError("旧反馈 ID 在源数据中重复。")

    if str(record.get("workspace_id") or "") != str(workspace.id):
        raise MigrationValidationError("workspace_id 与目标 Plane 工作区不一致。")
    user = User.objects.filter(pk=_parse_uuid(record.get("user_id"), "user_id")).first()
    if user is None:
        raise MigrationValidationError("提交用户不存在。")

    raw_org_unit = record.get("org_unit_id")
    org_unit = None
    if raw_org_unit is not None:
        org_unit = OrgUnit.objects.filter(
            pk=_parse_uuid(raw_org_unit, "org_unit_id"),
            workspace=workspace,
        ).first()
        if org_unit is None:
            raise MigrationValidationError("组织单元不存在或不属于目标工作区。")

    content = str(record.get("content") or "").strip()
    feedback_type = str(record.get("feedback_type") or "")
    status = str(record.get("status") or "")
    path = str(record.get("path") or "/")
    browser = str(record.get("browser") or "")
    module = str(record.get("module") or "plane")
    username = str(record.get("username") or "")
    idempotency_key = str(record.get("idempotency_key") or "")
    payload_hash = str(record.get("payload_hash") or "")
    if not content or len(content) > 5000:
        raise MigrationValidationError("反馈内容不能为空且不超过 5000 字。")
    if feedback_type not in ALLOWED_FEEDBACK_TYPES or status not in ALLOWED_STATUSES:
        raise MigrationValidationError("反馈分类或状态无效。")
    if len(path) > 2048 or len(browser) > 500 or len(module) > 100:
        raise MigrationValidationError("路径、浏览器或模块信息超过长度限制。")
    if not username or len(username) > 100:
        raise MigrationValidationError("提交人快照无效。")
    if not 16 <= len(idempotency_key) <= 128:
        raise MigrationValidationError("幂等标识长度无效。")
    if len(payload_hash) != 64 or any(char not in "0123456789abcdef" for char in payload_hash):
        raise MigrationValidationError("幂等负载哈希无效。")

    raw_screenshots = record.get("screenshots")
    raw_history = record.get("history")
    if not isinstance(raw_screenshots, list) or len(raw_screenshots) > 3:
        raise MigrationValidationError("截图元数据格式或数量无效。")
    if not isinstance(raw_history, list):
        raise MigrationValidationError("状态历史格式无效。")
    screenshots = [_validated_screenshot(source, item, legacy_feedback_id) for item in raw_screenshots]
    history = [_validated_history(item, workspace) for item in raw_history]
    hash_payload = {
        "content": content,
        "feedback_type": feedback_type,
        "path": path,
        "browser": browser,
        "module": module,
        "idempotency_key": idempotency_key,
    }
    computed_payload_hash = hashlib.sha256(
        json.dumps(hash_payload, sort_keys=True).encode()
        + b"".join(bytes.fromhex(item.digest) for item in screenshots)
    ).hexdigest()
    if payload_hash != computed_payload_hash:
        raise MigrationValidationError("旧反馈幂等负载哈希与源数据不一致。")

    idempotency_identity = (str(user.id), idempotency_key)
    if idempotency_identity in seen_idempotency_keys:
        raise MigrationValidationError("同用户幂等标识在源数据中重复。")
    seen_legacy_ids.add(legacy_feedback_id)
    seen_idempotency_keys.add(idempotency_identity)
    prepared = PreparedFeedback(
        legacy_feedback_id=legacy_feedback_id,
        source_record=record,
        user=user,
        org_unit=org_unit,
        content=content,
        feedback_type=feedback_type,
        status=status,
        path=path,
        browser=browser,
        module=module,
        username=username,
        idempotency_key=idempotency_key,
        payload_hash=computed_payload_hash,
        created_at=_aware_datetime(record.get("created_at"), "created_at"),
        updated_at=_aware_datetime(record.get("updated_at"), "updated_at"),
        screenshots=screenshots,
        history=history,
        already_imported=False,
    )

    existing = ResearchFeedback.objects.filter(workspace=workspace, legacy_feedback_id=legacy_feedback_id).first()
    if existing is not None:
        if not _existing_matches(existing=existing, prepared=prepared):
            raise MigrationValidationError("同旧反馈 ID 已存在但导入内容不完整，需人工核对。")
        prepared.already_imported = True
        return prepared

    duplicate = ResearchFeedback.objects.filter(
        workspace=workspace,
        created_by=user,
        idempotency_key=idempotency_key,
    ).first()
    if duplicate is not None:
        raise MigrationValidationError("同用户幂等标识已存在于 Plane。")
    return prepared


def prepare_feedback_migration(
    source: Ai4MSFeedbackSource, workspace: Workspace
) -> tuple[dict, list[PreparedFeedback]]:
    """Validate every legacy record without writing Plane data.

    Args:
        source: Read-only AI4MS source adapter.
        workspace: Target Plane workspace.

    Returns:
        A ``(summary, prepared_records)`` pair. The summary includes failures.
    """
    records = source.records()
    prepared_records: list[PreparedFeedback] = []
    issues: list[MigrationIssue] = []
    seen_legacy_ids: set[str] = set()
    seen_idempotency_keys: set[tuple[str, str]] = set()

    for record in records:
        legacy_id = str(record.get("feedback_id") or "")
        try:
            prepared = _prepare_record(source, workspace, record, seen_legacy_ids, seen_idempotency_keys)
        except MigrationValidationError as error:
            issues.append(MigrationIssue(feedback_id=legacy_id, message=str(error)))
            continue
        if prepared is not None:
            prepared_records.append(prepared)

    summary = {
        "mode": "dry-run",
        "workspace_slug": workspace.slug,
        "source_records": len(records),
        "source_screenshots": sum(len(record.get("screenshots") or []) for record in records),
        "source_history": sum(len(record.get("history") or []) for record in records),
        "valid_records": len(prepared_records),
        "already_imported": sum(item.already_imported for item in prepared_records),
        "records_to_import": sum(not item.already_imported for item in prepared_records),
        "failed_records": len(issues),
        "issues": [{"feedback_id": item.feedback_id, "message": item.message} for item in issues],
    }
    return summary, prepared_records


def _set_audit_created_at(event: ResearchAuditEvent, created_at: datetime):
    """Preserve a legacy status timestamp after inserting an append-only event.

    Args:
        event: Newly inserted audit event.
        created_at: Original timestamp from AI4MS.
    """
    with connection.cursor() as cursor:
        cursor.execute(
            "UPDATE research_audit_events SET created_at = %s WHERE id = %s",
            [created_at, event.id],
        )


def _cleanup_objects(storage: S3Storage, object_names: list[str]):
    """Best-effort cleanup of objects uploaded for a failed feedback import.

    Args:
        storage: Plane S3 storage used by the failed import.
        object_names: Object keys uploaded by the current record.
    """
    if not object_names:
        return
    try:
        deleted = storage.delete_files(object_names)
        if not deleted:
            LOGGER.warning("反馈迁移失败对象清理未确认：%s", object_names)
    except Exception:
        LOGGER.warning("反馈迁移失败对象清理异常：%s", object_names, exc_info=True)


def _upload_screenshots(
    storage: S3Storage, workspace: Workspace, feedback_id, screenshots, source: Ai4MSFeedbackSource
) -> list[str]:
    """Upload prepared screenshots to Plane S3 in their legacy order.

    Args:
        storage: Plane S3 storage.
        workspace: Target Plane workspace.
        feedback_id: New Plane feedback UUID.
        screenshots: Prepared screenshot descriptors.
        source: Read-only legacy source used to reload bytes at execute time.

    Returns:
        Uploaded S3 object keys.
    """
    object_names: list[str] = []
    for position, item in enumerate(screenshots, start=1):
        try:
            content = source.read_screenshot(item.legacy_id)
        except Exception as error:
            raise MigrationExecutionError(f"截图执行前重新读取失败：{error}") from error
        if (
            len(content) != item.size
            or hashlib.sha256(content).hexdigest() != item.digest
            or not _valid_image_header(content[:512], item.content_type)
        ):
            raise MigrationExecutionError("截图在预检后发生变化，需重新执行 dry-run。")
        object_name = (
            f"{workspace.id}/research/feedback/{feedback_id}/screenshots/"
            f"{uuid.uuid4().hex}-{sanitize_filename(item.safe_name) or position}"
        )
        try:
            uploaded = storage.upload_file(BytesIO(content), object_name, item.content_type)
        except Exception as error:
            raise MigrationExecutionError(f"截图上传 Plane S3 失败：{error}") from error
        if not uploaded:
            raise MigrationExecutionError("截图上传 Plane S3 失败。")
        object_names.append(object_name)
    return object_names


def import_prepared_feedback(
    prepared: PreparedFeedback, workspace: Workspace, source: Ai4MSFeedbackSource
) -> str:
    """Atomically import one prepared feedback record into Plane.

    Args:
        prepared: Fully validated source record.
        workspace: Target Plane workspace.
        source: Read-only legacy source used to revalidate screenshot bytes.

    Returns:
        The new Plane feedback UUID.

    Raises:
        MigrationExecutionError: S3 or database registration failed; Plane remains free of partial data.
    """
    if prepared.already_imported:
        raise MigrationExecutionError("已完整导入的记录不能重复写入。")

    storage = S3Storage()
    feedback_id = uuid.uuid4()
    object_names: list[str] = []
    cleanup = True
    try:
        object_names = _upload_screenshots(
            storage, workspace, feedback_id, prepared.screenshots, source
        )
        with transaction.atomic():
            feedback = ResearchFeedback(
                id=feedback_id,
                workspace=workspace,
                org_unit=prepared.org_unit,
                legacy_feedback_id=prepared.legacy_feedback_id,
                username=prepared.username,
                feedback_type=prepared.feedback_type,
                content=prepared.content,
                path=prepared.path,
                browser=prepared.browser,
                module=prepared.module,
                status=prepared.status,
                idempotency_key=prepared.idempotency_key,
                payload_hash=prepared.payload_hash,
            )
            feedback.save(created_by_id=prepared.user.id)

            asset_ids = []
            for position, item in enumerate(prepared.screenshots, start=1):
                asset = FileAsset.objects.create(
                    workspace=workspace,
                user=prepared.user,
                created_by=prepared.user,
                attributes={
                    "name": item.safe_name,
                    "type": item.content_type,
                    "size": item.size,
                    "sha256": item.digest,
                },
                    asset=object_names[position - 1],
                    size=item.size,
                    entity_type=FileAsset.EntityTypeContext.FEEDBACK_SCREENSHOT,
                    entity_identifier=str(feedback.id),
                    is_uploaded=True,
                    storage_metadata={
                        "ContentType": item.content_type,
                        "ContentLength": item.size,
                        "SHA256": item.digest,
                    },
                )
                asset_ids.append(asset.id)
                ResearchFeedbackScreenshot.objects.create(
                    feedback=feedback,
                    asset=asset,
                    position=position,
                    created_by=prepared.user,
                )

            for history in prepared.history:
                event = record_audit_event(
                    workspace=workspace,
                    action=ResearchAuditAction.FEEDBACK_STATUS_UPDATE,
                    resource_type=ResearchResourceType.RESEARCH_FEEDBACK,
                    resource_id=feedback.id,
                    org_unit=feedback.org_unit,
                    actor=history.actor,
                    metadata={
                        "actor_name": history.actor_name,
                        "from_status": history.from_status,
                        "to_status": history.to_status,
                        "comment": history.comment,
                    },
                )
                _set_audit_created_at(event, history.created_at)

            record_audit_event(
                workspace=workspace,
                action=ResearchAuditAction.FEEDBACK_IMPORT,
                resource_type=ResearchResourceType.RESEARCH_FEEDBACK,
                resource_id=feedback.id,
                org_unit=feedback.org_unit,
                metadata={
                    "source": "ai4ms_feedback_4_21",
                    "legacy_feedback_id": prepared.legacy_feedback_id,
                    "screenshot_count": len(prepared.screenshots),
                    "result": "imported",
                },
            )

            last_actor_id = prepared.history[-1].actor.id if prepared.history else None
            ResearchFeedback.objects.filter(pk=feedback.id).update(
                created_at=prepared.created_at,
                updated_at=prepared.updated_at,
                updated_by_id=last_actor_id,
            )
            FileAsset.objects.filter(id__in=asset_ids).update(
                created_at=prepared.created_at,
                updated_at=prepared.updated_at,
            )
            ResearchFeedbackScreenshot.objects.filter(feedback=feedback).update(created_at=prepared.created_at)
        cleanup = False
        return str(feedback.id)
    except (IntegrityError, DatabaseError) as error:
        raise MigrationExecutionError(f"反馈数据库登记失败：{error}") from error
    finally:
        if cleanup:
            _cleanup_objects(storage, object_names)
