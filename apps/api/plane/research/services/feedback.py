"""Plane-native feedback persistence, authorization, audit and screenshot service."""

import hashlib
import json
import logging
import uuid
from datetime import datetime, timedelta
from contextlib import contextmanager
from urllib.parse import urlsplit

from botocore.exceptions import BotoCoreError, ClientError
from django.db import DatabaseError, IntegrityError, transaction
from django.db.models import Sum
from django.db.models import Prefetch
from django.core.cache import cache
from django.utils import timezone
from rest_framework import status

from plane.db.models import (
    FileAsset,
    OrgUnitMember,
    ResearchAuditEvent,
    ResearchFeedback,
    ResearchFeedbackScreenshot,
)
from plane.research.utils.acl import active_org_units_for, managing_org_units_for
from plane.research.utils.audit import ResearchAuditAction, ResearchResourceType, record_audit_event
from plane.research.utils.errors import ResearchErrorCode, ResearchAPIException
from plane.research.utils.org import is_workspace_admin
from plane.research.utils.roles import is_instance_admin, is_main_pi
from plane.settings.storage import S3Storage
from plane.utils.path_validator import sanitize_filename

LOGGER = logging.getLogger(__name__)
SCREENSHOT_LIMIT = 10 * 1024 * 1024
SUBMISSION_HOUR_LIMIT = 5
SCREENSHOT_STORAGE_QUOTA = 100 * 1024 * 1024
SUBMIT_LOCK_TTL_SECONDS = 60
SCREENSHOT_EXTENSIONS = {
    "image/png": {".png"},
    "image/jpeg": {".jpg", ".jpeg"},
    "image/webp": {".webp"},
}


def _invalid(message, error_code=ResearchErrorCode.FEEDBACK_INVALID):
    """Create a controlled validation error for the feedback API.

    Args:
        message: User-facing error message.
        error_code: Stable error code returned to clients.

    Returns:
        A research API exception carrying an HTTP 422 status.
    """
    return ResearchAPIException(error_code, message, status.HTTP_422_UNPROCESSABLE_ENTITY)


def _storage_unavailable():
    """Create the controlled error used when Plane storage cannot serve a request."""
    return ResearchAPIException(
        ResearchErrorCode.FEEDBACK_STORAGE_UNAVAILABLE,
        "反馈存储暂不可用，请稍后重试。",
        status.HTTP_503_SERVICE_UNAVAILABLE,
    )


def _rate_limited():
    """Create the stable error used after the hourly feedback submission limit."""
    return ResearchAPIException(
        ResearchErrorCode.FEEDBACK_RATE_LIMITED,
        "反馈提交次数已达每小时上限，请稍后再试。",
        status.HTTP_429_TOO_MANY_REQUESTS,
    )


def _storage_quota_exceeded():
    """Create the stable error used when active screenshots exceed a user quota."""
    return ResearchAPIException(
        ResearchErrorCode.FEEDBACK_STORAGE_QUOTA_EXCEEDED,
        "反馈截图存储超过 100 MB 上限，请联系管理员处理历史反馈。",
        status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
    )


def _busy():
    """Create the stable conflict used when the same user already has a submission in flight."""
    return ResearchAPIException(
        ResearchErrorCode.FEEDBACK_BUSY,
        "上一条反馈仍在提交中，请稍后重试。",
        status.HTTP_409_CONFLICT,
    )


def _conflict(message="同一重试标识已用于不同反馈。"):
    """Create the stable conflict error for payload-changing retries."""
    return ResearchAPIException(
        ResearchErrorCode.FEEDBACK_IDEMPOTENCY_CONFLICT,
        message,
        status.HTTP_409_CONFLICT,
    )


def submit_lock_key(workspace_id, user_id):
    """Build the cache key serializing feedback submissions for one user.

    Args:
        workspace_id: Workspace UUID.
        user_id: Submitting user UUID.

    Returns:
        The per-user feedback submission lock key.
    """
    return f"research_feedback:submit:{workspace_id}:{user_id}"


@contextmanager
def _submission_lock(workspace, user):
    """Serialize feedback submissions for one workspace user.

    Args:
        workspace: Workspace resolved from the URL.
        user: Authenticated feedback submitter.

    Yields:
        Nothing while the caller owns the submission lock.

    Raises:
        ResearchAPIException: When another submission is active or cache is unavailable.
    """
    key = submit_lock_key(workspace.id, user.id)
    owner = uuid.uuid4().hex
    try:
        acquired = cache.add(key, owner, SUBMIT_LOCK_TTL_SECONDS)
    except Exception as error:
        LOGGER.warning(
            "Feedback cache lock unavailable workspace_id=%s error_type=%s",
            workspace.id,
            type(error).__name__,
        )
        raise _storage_unavailable() from None
    if not acquired:
        raise _busy()
    try:
        yield
    finally:
        try:
            current_owner = cache.get(key)
            if current_owner == owner:
                cache.delete(key)
        except Exception as error:
            LOGGER.warning(
                "Feedback cache lock release failed workspace_id=%s error_type=%s",
                workspace.id,
                type(error).__name__,
            )


def _extension(name):
    """Return the lowercase extension of an uploaded file name.

    Args:
        name: Uploaded file name supplied by the multipart request.

    Returns:
        A lowercase extension including the leading dot, or an empty string.
    """
    return "." + str(name or "").rsplit(".", 1)[-1].lower() if "." in str(name or "") else ""


def _valid_image_header(header, content_type):
    """Match the restricted screenshot MIME type with its actual file header.

    Args:
        header: First bytes read from the uploaded file.
        content_type: Normalized MIME type declared by the multipart part.

    Returns:
        Whether the header belongs to the declared PNG/JPEG/WebP format.
    """
    if content_type == "image/png":
        return header.startswith(b"\x89PNG\r\n\x1a\n")
    if content_type == "image/jpeg":
        return header.startswith(b"\xff\xd8\xff")
    if content_type == "image/webp":
        return header.startswith(b"RIFF") and header[8:12] == b"WEBP"
    return False


def _validated_screenshots(files):
    """Validate restricted screenshot uploads and calculate content hashes.

    Args:
        files: Django uploaded files from the ``screenshots`` multipart field.

    Returns:
        A list of file, type, size, digest and safe-name descriptors.
    """
    if len(files) > 3:
        raise _invalid("每条反馈最多三张截图。")
    screenshots = []
    for file in files:
        size = int(getattr(file, "size", 0) or 0)
        content_type = str(getattr(file, "content_type", "") or "").split(";", 1)[0].strip().lower()
        name = str(getattr(file, "name", "") or "")
        if not 0 < size <= SCREENSHOT_LIMIT:
            raise _invalid("每张截图须为非空文件且不超过 10 MB。")
        if content_type not in SCREENSHOT_EXTENSIONS or _extension(name) not in SCREENSHOT_EXTENSIONS[content_type]:
            raise _invalid("截图必须为 PNG、JPEG 或 WebP。")
        try:
            file.seek(0)
            header = file.read(512)
            file.seek(0)
            if not _valid_image_header(header, content_type):
                raise _invalid("截图文件头与声明格式不一致。")
            digest = hashlib.sha256()
            for chunk in file.chunks():
                digest.update(chunk)
            file.seek(0)
        except (OSError, ValueError):
            raise _invalid("截图读取失败，请重新选择文件。") from None
        screenshots.append(
            {
                "file": file,
                "content_type": content_type,
                "size": size,
                "digest": digest.hexdigest(),
                "safe_name": sanitize_filename(name) or "screenshot",
            }
        )
    return screenshots


def _submission_payload(request):
    """Read and normalize feedback fields supplied by an authenticated member.

    Args:
        request: DRF request carrying multipart form data.

    Returns:
        Normalized fields accepted by the persistence layer.
    """
    data = request.data

    def text(key, default=""):
        return str(data.get(key) or default).strip()

    content = text("content")
    feedback_type = text("feedback_type", "bug").lower()
    path = text("path", "/")
    browser = text("browser")
    module = text("module", "plane")
    idempotency_key = text("idempotency_key")
    if not content or len(content) > 5000:
        raise _invalid("反馈内容不能为空且不超过 5000 字。")
    if feedback_type not in {"bug", "ux", "idea", "other"}:
        raise _invalid("反馈分类无效。")
    path = urlsplit(path).path or "/"
    if len(path) > 2048 or len(browser) > 500 or len(module) > 100:
        raise _invalid("路径、浏览器或模块信息超过长度限制。")
    if not 16 <= len(idempotency_key) <= 128:
        raise _invalid("幂等标识长度必须在 16–128 字符之间。")
    return {
        "content": content,
        "feedback_type": feedback_type,
        "path": path,
        "browser": browser,
        "module": module,
        "idempotency_key": idempotency_key,
    }


def _primary_org_unit(user, workspace):
    """Resolve the submitter's effective primary organisation snapshot.

    Args:
        user: Feedback submitter.
        workspace: Workspace resolved from the URL.

    Returns:
        The active primary organisation ID, or ``None`` when unavailable.
    """
    return (
        OrgUnitMember.objects.filter(
            workspace=workspace,
            user=user,
            is_primary=True,
            deleted_at__isnull=True,
            org_unit_id__in=active_org_units_for(user, workspace.id),
        )
        .values_list("org_unit_id", flat=True)
        .first()
    )


def _feedback_queryset(user, workspace):
    """Return the caller's own feedback queryset.

    Args:
        user: Authenticated Plane user.
        workspace: Workspace resolved from the URL.

    Returns:
        A queryset containing only feedback created by the caller.
    """
    return (
        ResearchFeedback.objects.filter(workspace=workspace, created_by=user)
        .filter(deleted_at__isnull=True)
        .select_related("workspace", "org_unit", "created_by")
        .prefetch_related(
            Prefetch(
                "screenshots",
                queryset=ResearchFeedbackScreenshot.objects.filter(
                    deleted_at__isnull=True,
                    asset__is_deleted=False,
                    asset__deleted_at__isnull=True,
                ).select_related("asset"),
            )
        )
    )


def _management_queryset(user, workspace):
    """Resolve the management queryset from Plane roles and organisation scope.

    Args:
        user: Authenticated Plane user.
        workspace: Workspace resolved from the URL.

    Returns:
        An authorized queryset, or ``None`` when the caller cannot manage feedback.
    """
    queryset = ResearchFeedback.objects.filter(workspace=workspace, deleted_at__isnull=True)
    if is_instance_admin(user):
        return queryset
    if is_main_pi(user, workspace):
        return queryset.filter(org_unit_id__in=managing_org_units_for(user, workspace.id))
    if is_workspace_admin(user, workspace.id):
        return queryset
    return None


def visible_feedback_queryset(user, workspace, *, manage=False):
    """Return the feedback queryset allowed for this caller.

    Args:
        user: Authenticated Plane user.
        workspace: Workspace resolved from the URL.
        manage: Whether management scope was explicitly requested.

    Returns:
        Own-scope or management-scope queryset; management denial returns ``None``.
    """
    return _management_queryset(user, workspace) if manage else _feedback_queryset(user, workspace)


def _history_entries(feedback_ids):
    """Bulk-read status audit events for a page of feedback records.

    Args:
        feedback_ids: Feedback IDs included in the current response.

    Returns:
        A mapping from feedback ID to ordered history entries.
    """
    entries = {str(feedback_id): [] for feedback_id in feedback_ids}
    events = ResearchAuditEvent.objects.filter(
        resource_type=ResearchResourceType.RESEARCH_FEEDBACK,
        resource_id__in=feedback_ids,
        action=ResearchAuditAction.FEEDBACK_STATUS_UPDATE,
    ).order_by("created_at", "id")
    for event in events:
        metadata = event.metadata or {}
        entries.setdefault(str(event.resource_id), []).append(
            {
                "actor_name": metadata.get("actor_name", ""),
                "from_status": metadata.get("from_status", ""),
                "to_status": metadata.get("to_status", ""),
                "comment": metadata.get("comment", ""),
                "created_at": event.created_at,
            }
        )
    return entries


def serialize_feedback(feedback, *, history=None):
    """Convert a feedback model and its registrations to the API contract.

    Args:
        feedback: Feedback record with prefetched screenshots and assets.
        history: Optional preloaded status history.

    Returns:
        The JSON-facing feedback record.
    """
    screenshots = [
        {
            "id": str(item.id),
            "content_type": item.asset.attributes.get("type", ""),
            "size": int(item.asset.size or 0),
        }
        for item in feedback.screenshots.all()
    ]
    return {
        "feedback_id": str(feedback.id),
        "content": feedback.content,
        "feedback_type": feedback.feedback_type,
        "status": feedback.status,
        "username": feedback.username,
        "path": feedback.path,
        "browser": feedback.browser,
        "module": feedback.module,
        "screenshots": screenshots,
        "history": history if history is not None else [],
        "created_at": feedback.created_at,
        "updated_at": feedback.updated_at,
    }


def _existing_feedback(workspace, user, idempotency_key):
    """Find an active feedback record for an idempotency retry.

    Args:
        workspace: Workspace resolved from the URL.
        user: Authenticated submitter.
        idempotency_key: Client-supplied retry identity.

    Returns:
        The matching feedback record, or ``None``.
    """
    return (
        ResearchFeedback.objects.filter(
            workspace=workspace,
            created_by=user,
            idempotency_key=idempotency_key,
            deleted_at__isnull=True,
        )
        .select_related("workspace", "org_unit", "created_by")
        .prefetch_related("screenshots__asset")
        .first()
    )


def _cleanup_objects(storage, object_names, workspace_id):
    """Best-effort cleanup for objects orphaned by a failed registration.

    Args:
        storage: Plane S3 storage instance used for the submission.
        object_names: S3 object keys uploaded by the current request.
        workspace_id: Workspace ID used only for sanitized operations logging.
    """
    if object_names:
        try:
            storage.delete_files(object_names)
        except Exception as error:
            LOGGER.warning(
                "Feedback S3 cleanup failed workspace_id=%s object_keys=%s error_type=%s",
                workspace_id,
                object_names,
                type(error).__name__,
            )


def _reject_submission_abuse(user, workspace, screenshots):
    """Apply the per-user hourly count and active screenshot storage quota.

    Args:
        user: Authenticated submitter.
        workspace: Workspace resolved from the URL.
        screenshots: Validated screenshot descriptors for this request.

    Raises:
        ResearchAPIException: When the hourly or storage boundary is exceeded.
    """
    recent_count = ResearchFeedback.objects.filter(
        workspace=workspace,
        created_by=user,
        deleted_at__isnull=True,
        created_at__gte=timezone.now() - timedelta(hours=1),
    ).count()
    if recent_count >= SUBMISSION_HOUR_LIMIT:
        raise _rate_limited()

    active_asset_ids = ResearchFeedbackScreenshot.objects.filter(
            feedback__workspace=workspace,
            feedback__created_by_id=user.id,
            feedback__deleted_at__isnull=True,
            deleted_at__isnull=True,
    ).values_list("asset_id", flat=True)
    active_size = (
        FileAsset.objects.filter(
            id__in=active_asset_ids,
            is_deleted=False,
            deleted_at__isnull=True,
        ).aggregate(total=Sum("size"))["total"]
        or 0
    )
    incoming_size = sum(item["size"] for item in screenshots)
    if active_size + incoming_size > SCREENSHOT_STORAGE_QUOTA:
        raise _storage_quota_exceeded()


def create_feedback(request, user, workspace):
    """Validate, upload and atomically register a Plane feedback submission.

    Args:
        request: DRF multipart request.
        user: Authenticated submitter.
        workspace: Workspace resolved from the URL.

    Returns:
        The created or unchanged idempotent feedback record.
    """
    payload = _submission_payload(request)
    screenshots = _validated_screenshots(request.FILES.getlist("screenshots"))
    # Keep the 4.21 BFF JSON representation so migrated records stay retry-compatible.
    digest = hashlib.sha256(
        json.dumps(payload, sort_keys=True).encode() + b"".join(bytes.fromhex(item["digest"]) for item in screenshots)
    ).hexdigest()
    existing = _existing_feedback(workspace, user, payload["idempotency_key"])
    if existing is not None:
        if existing.payload_hash != digest:
            raise _conflict()
        return serialize_feedback(existing, history=[])

    with _submission_lock(workspace, user):
        _reject_submission_abuse(user, workspace, screenshots)
        storage = S3Storage(request=request)
        feedback_id = uuid.uuid4()
        object_names = []
        cleanup = True
        try:
            for item in screenshots:
                object_name = (
                    f"{workspace.id}/research/feedback/{feedback_id}/screenshots/"
                    f"{uuid.uuid4().hex}-{item['safe_name']}"
                )
                try:
                    uploaded = storage.upload_file(item["file"], object_name, item["content_type"])
                except ResearchAPIException:
                    raise
                except Exception:
                    raise _storage_unavailable() from None
                if not uploaded:
                    raise _storage_unavailable()
                object_names.append(object_name)

            with transaction.atomic():
                feedback = ResearchFeedback(
                    id=feedback_id,
                    workspace=workspace,
                    org_unit_id=_primary_org_unit(user, workspace),
                    username=(user.display_name or user.first_name or str(user.id))[:100],
                    payload_hash=digest,
                    **payload,
                )
                feedback.save(created_by_id=user.id)
                for position, item in enumerate(screenshots, start=1):
                    asset = FileAsset.objects.create(
                        workspace=workspace,
                        user=user,
                        created_by=user,
                        attributes={
                            "name": item["safe_name"],
                            "type": item["content_type"],
                            "size": item["size"],
                            "sha256": item["digest"],
                        },
                        asset=object_names[position - 1],
                        size=item["size"],
                        entity_type=FileAsset.EntityTypeContext.FEEDBACK_SCREENSHOT,
                        entity_identifier=str(feedback.id),
                        is_uploaded=True,
                        storage_metadata={
                            "ContentType": item["content_type"],
                            "ContentLength": item["size"],
                            "SHA256": item["digest"],
                        },
                    )
                    ResearchFeedbackScreenshot.objects.create(
                        feedback=feedback,
                        asset=asset,
                        position=position,
                        created_by=user,
                    )
                record_audit_event(
                    workspace=workspace,
                    action=ResearchAuditAction.FEEDBACK_CREATE,
                    resource_type=ResearchResourceType.RESEARCH_FEEDBACK,
                    resource_id=feedback.id,
                    org_unit=feedback.org_unit,
                    actor=user,
                    request=request,
                    metadata={
                        "feedback_type": feedback.feedback_type,
                        "screenshot_count": len(screenshots),
                    },
                )
            cleanup = False
            return serialize_feedback(feedback, history=[])
        except IntegrityError:
            existing = _existing_feedback(workspace, user, payload["idempotency_key"])
            if existing is not None and existing.payload_hash == digest:
                return serialize_feedback(existing, history=[])
            if existing is None:
                raise _storage_unavailable() from None
            raise _conflict() from None
        except DatabaseError:
            raise _storage_unavailable() from None
        finally:
            if cleanup:
                _cleanup_objects(storage, object_names, workspace.id)


def _pagination(params):
    """Normalize list pagination without allowing unbounded page sizes.

    Args:
        params: Query parameters supplied by the caller.

    Returns:
        A ``(page, page_size)`` tuple with safe bounds.
    """
    try:
        page = max(1, int(params.get("page", "1")))
        page_size = max(1, min(100, int(params.get("page_size", "20"))))
    except (TypeError, ValueError):
        raise _invalid("分页参数无效。") from None
    return page, page_size


def list_feedback(request, user, workspace):
    """List own or managed feedback with server-side filters.

    Args:
        request: DRF list request.
        user: Authenticated caller.
        workspace: Workspace resolved from the URL.

    Returns:
        The paginated API payload.
    """
    manage = request.GET.get("scope") == "manage"
    queryset = visible_feedback_queryset(user, workspace, manage=manage)
    if queryset is None:
        raise ResearchAPIException(
            ResearchErrorCode.PERMISSION_DENIED,
            "没有反馈管理权限。",
            status.HTTP_403_FORBIDDEN,
        )
    queryset = queryset.select_related("workspace", "org_unit", "created_by").prefetch_related("screenshots__asset")
    params = request.GET
    for field, allowed in (
        ("feedback_type", {"bug", "ux", "idea", "other"}),
        ("status", {"open", "in_progress", "done", "closed"}),
    ):
        if params.get(field) and params[field] not in allowed:
            raise _invalid("筛选值无效。")
        queryset = queryset.filter(**({field: params[field]} if params.get(field) else {}))
    if params.get("module"):
        queryset = queryset.filter(module=params.get("module", "")[:100])
    if params.get("q"):
        queryset = queryset.filter(content__icontains=params.get("q", "")[:200])

    dates = {}
    try:
        for key, lookup in (("date_from", "gte"), ("date_to", "lt")):
            if params.get(key):
                value = datetime.strptime(params[key], "%Y-%m-%d")
                if key == "date_to":
                    value += timedelta(days=1)
                dates[lookup] = timezone.make_aware(value, timezone.get_current_timezone())
    except ValueError:
        raise _invalid("日期筛选格式无效。") from None
    if dates:
        if "gte" in dates and "lt" in dates and dates["gte"] >= dates["lt"]:
            raise _invalid("开始日期不能晚于结束日期。")
        queryset = queryset.filter(**{f"created_at__{lookup}": value for lookup, value in dates.items()})

    page, page_size = _pagination(params)
    queryset = queryset.order_by("-created_at", "id")
    count = queryset.count()
    results = list(queryset[(page - 1) * page_size : page * page_size])
    histories = _history_entries([item.id for item in results])
    return {
        "results": [serialize_feedback(item, history=histories.get(str(item.id), [])) for item in results],
        "count": count,
        "page": page,
        "page_size": page_size,
    }


def update_feedback_status(request, user, workspace, feedback_id):
    """Update a managed feedback status and append its audit history atomically.

    Args:
        request: DRF patch request.
        user: Authenticated manager.
        workspace: Workspace resolved from the URL.
        feedback_id: UUID of the feedback record.

    Returns:
        The updated feedback record.
    """
    queryset = _management_queryset(user, workspace)
    if queryset is None:
        raise ResearchAPIException(
            ResearchErrorCode.PERMISSION_DENIED,
            "没有反馈管理权限。",
            status.HTTP_403_FORBIDDEN,
        )
    new_status = str(request.data.get("status") or "")
    comment = str(request.data.get("comment") or "").strip()
    if new_status not in {"open", "in_progress", "done", "closed"}:
        raise _invalid("反馈状态无效。")
    if not comment or len(comment) > 2000:
        raise _invalid("处置说明不能为空且不超过 2000 字。")

    with transaction.atomic():
        feedback = queryset.select_for_update().filter(pk=feedback_id).first()
        if feedback is None:
            raise ResearchAPIException(
                ResearchErrorCode.FEEDBACK_NOT_FOUND,
                "反馈不存在。",
                status.HTTP_404_NOT_FOUND,
            )
        from_status = feedback.status
        feedback.status = new_status
        feedback.updated_by = user
        feedback.save(update_fields=["status", "updated_at", "updated_by"])
        record_audit_event(
            workspace=workspace,
            action=ResearchAuditAction.FEEDBACK_STATUS_UPDATE,
            resource_type=ResearchResourceType.RESEARCH_FEEDBACK,
            resource_id=feedback.id,
            org_unit=feedback.org_unit,
            actor=user,
            request=request,
            metadata={
                "actor_name": (user.display_name or user.first_name or str(user.id))[:100],
                "from_status": from_status,
                "to_status": new_status,
                "comment": comment,
            },
        )
    feedback = (
        ResearchFeedback.objects.filter(workspace=workspace, pk=feedback.id)
        .select_related("workspace", "org_unit", "created_by")
        .prefetch_related("screenshots__asset")
        .first()
    )
    if feedback is None:
        raise ResearchAPIException(
            ResearchErrorCode.FEEDBACK_NOT_FOUND,
            "反馈不存在。",
            status.HTTP_404_NOT_FOUND,
        )
    history = _history_entries([feedback.id]).get(str(feedback.id), [])
    return serialize_feedback(feedback, history=history)


def _authorized_screenshot(user, workspace, feedback_id, screenshot_id, *, manage):
    """Resolve a screenshot only through the same feedback visibility rule.

    Args:
        user: Authenticated caller.
        workspace: Workspace resolved from the URL.
        feedback_id: UUID of the parent feedback record.
        screenshot_id: UUID of the screenshot registration.
        manage: Whether management scope was requested.

    Returns:
        The authorized screenshot registration.
    """
    queryset = visible_feedback_queryset(user, workspace, manage=manage)
    if queryset is None:
        raise ResearchAPIException(
            ResearchErrorCode.PERMISSION_DENIED,
            "没有反馈管理权限。",
            status.HTTP_403_FORBIDDEN,
        )
    feedback = queryset.filter(pk=feedback_id).first()
    if feedback is None:
        raise ResearchAPIException(
            ResearchErrorCode.FEEDBACK_NOT_FOUND,
            "截图不存在。",
            status.HTTP_404_NOT_FOUND,
        )
    screenshot = (
        feedback.screenshots.filter(
            pk=screenshot_id,
            deleted_at__isnull=True,
            asset__is_deleted=False,
            asset__deleted_at__isnull=True,
        )
        .select_related("asset")
        .first()
    )
    if screenshot is None:
        raise ResearchAPIException(
            ResearchErrorCode.FEEDBACK_NOT_FOUND,
            "截图不存在。",
            status.HTTP_404_NOT_FOUND,
        )
    return screenshot


def open_feedback_screenshot(request, user, workspace, feedback_id, screenshot_id):
    """Open an authorized screenshot stream from Plane storage.

    Args:
        request: DRF request used to construct workspace storage.
        user: Authenticated caller.
        workspace: Workspace resolved from the URL.
        feedback_id: UUID of the feedback record.
        screenshot_id: UUID of the screenshot registration.

    Returns:
        A ``(body, content_type)`` pair suitable for a streaming response.
    """
    screenshot = _authorized_screenshot(
        user,
        workspace,
        feedback_id,
        screenshot_id,
        manage=request.GET.get("scope") == "manage",
    )
    asset = screenshot.asset
    try:
        storage = S3Storage(request=request)
        response = storage.server_s3_client.get_object(
            Bucket=storage.aws_storage_bucket_name,
            Key=asset.asset.name,
        )
    except (ClientError, BotoCoreError):
        raise _storage_unavailable() from None
    content_type = str(response.get("ContentType") or asset.attributes.get("type") or "").split(";", 1)[0]
    if content_type not in SCREENSHOT_EXTENSIONS:
        raise _storage_unavailable()
    return response["Body"], content_type
