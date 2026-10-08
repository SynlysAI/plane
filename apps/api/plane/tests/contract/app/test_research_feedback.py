"""Plane 本地反馈持久化、权限、截图与审计契约。"""

import hashlib
import json
from unittest import mock
from io import BytesIO
from uuid import uuid4

from botocore.exceptions import BotoCoreError
from django.db import IntegrityError
from django.db.models import Sum
from django.utils import timezone
import pytest
from django.core.files.uploadedfile import SimpleUploadedFile

from plane.db.models import (
    FileAsset,
    ResearchAuditEvent,
    ResearchFeedback,
    ResearchFeedbackScreenshot,
)
from plane.tests.research_fixtures import make_instance_admin
from plane.tests.contract.app.test_research_browse import (  # noqa: F401
    client_for,
    create_project,
    env as browse_environment,
)

pytestmark = pytest.mark.contract

PNG_BYTES = b"\x89PNG\r\n\x1a\nplane-local-feedback"
JPEG_BYTES = b"\xff\xd8\xffplane-local-feedback"


@pytest.fixture
def env(browse_environment):  # noqa: F811 - pytest requires a local fixture name.
    """Reuse the two-organisation and multi-role browse environment."""
    return browse_environment


@pytest.fixture
def storage():
    """Mock only Plane's S3 boundary while retaining database behavior."""
    instance = mock.Mock()
    instance.upload_file.return_value = True
    instance.aws_storage_bucket_name = "plane-test"
    instance.server_s3_client.get_object.return_value = {
        "Body": BytesIO(PNG_BYTES),
        "ContentType": "image/png",
    }
    with mock.patch("plane.research.services.feedback.S3Storage", return_value=instance):
        yield instance


def feedback_url(env, suffix=""):
    """Return the workspace feedback API route.

    Args:
        env: Multi-role research test environment.
        suffix: Feedback detail suffix appended to the collection URL.

    Returns:
        The feedback API URL used by a test.
    """
    return f"{env['base']}feedback/{suffix}"


def image(name="shot.png", content=PNG_BYTES, content_type="image/png"):
    """Create an uploaded screenshot part with a valid header.

    Args:
        name: Uploaded file name.
        content: File body used by the test.
        content_type: Declared multipart MIME type.

    Returns:
        A Django uploaded file suitable for multipart requests.
    """
    return SimpleUploadedFile(name, content, content_type=content_type)


def submission(**overrides):
    """Return a valid feedback submission payload.

    Args:
        overrides: Fields overridden by a specific test case.

    Returns:
        A valid feedback form payload.
    """
    payload = {
        "content": "Upload fails on a weekly report",
        "feedback_type": "bug",
        "path": "https://plane.test/lab/research?token=secret#private",
        "browser": "Plane test browser",
        "module": "research",
        "idempotency_key": uuid4().hex,
    }
    payload.update(overrides)
    return payload


@pytest.mark.django_db
def test_submission_persists_plane_records_and_strips_url_secrets(env, storage):
    submission_payload = submission(page_body="PAGE BODY MUST NOT BE CAPTURED", workspace_id="spoofed")
    response = client_for(env["student"]).post(
        feedback_url(env),
        {
            **submission_payload,
            "screenshots": [image(), image("shot.jpg", JPEG_BYTES, "image/jpeg")],
        },
        format="multipart",
    )

    assert response.status_code == 200, response.json()
    record = ResearchFeedback.objects.get(pk=response.json()["data"]["feedback_id"])
    assert record.workspace == env["workspace"]
    assert record.created_by == env["student"]
    assert record.org_unit == env["group_a"]
    assert record.path == "/lab/research"
    submission_payload["path"] = "/lab/research"
    submission_payload = {
        key: submission_payload[key]
        for key in ("content", "feedback_type", "path", "browser", "module", "idempotency_key")
    }
    expected_hash = hashlib.sha256(
        json.dumps(submission_payload, sort_keys=True).encode()
        + hashlib.sha256(PNG_BYTES).digest()
        + hashlib.sha256(JPEG_BYTES).digest()
    ).hexdigest()
    assert record.payload_hash == expected_hash
    assert "page_body" not in response.json()["data"]
    assert ResearchFeedbackScreenshot.objects.filter(feedback=record).count() == 2
    assets = FileAsset.objects.filter(entity_type=FileAsset.EntityTypeContext.FEEDBACK_SCREENSHOT)
    assert set(assets.values_list("entity_identifier", flat=True)) == {str(record.id)}
    assert storage.upload_file.call_count == 2
    assert ResearchAuditEvent.objects.filter(
        action="feedback.create", resource_id=record.id, actor=env["student"]
    ).exists()


@pytest.mark.django_db
def test_idempotent_retry_returns_the_same_record_and_conflicts_on_changed_payload(env, storage):
    client = client_for(env["student"])
    payload = submission()
    first = client.post(feedback_url(env), payload, format="multipart")
    second = client.post(feedback_url(env), payload, format="multipart")
    changed = client.post(
        feedback_url(env),
        submission(**{"idempotency_key": payload["idempotency_key"], "content": "Changed description"}),
        format="multipart",
    )

    assert first.status_code == second.status_code == 200
    assert first.json()["data"]["feedback_id"] == second.json()["data"]["feedback_id"]
    assert ResearchFeedback.objects.count() == 1
    assert changed.status_code == 409
    assert changed.json()["error_code"] == "research_feedback_idempotency_conflict"


@pytest.mark.django_db
def test_screenshot_count_format_size_and_header_are_rejected_before_storage(env, storage):
    client = client_for(env["student"])
    too_many = client.post(
        feedback_url(env),
        {**submission(), "screenshots": [image(f"{index}.png") for index in range(4)]},
        format="multipart",
    )
    empty = client.post(
        feedback_url(env), {**submission(), "screenshots": [image("empty.png", b"")]}, format="multipart"
    )
    too_large = client.post(
        feedback_url(env),
        {**submission(), "screenshots": [image("large.png", b"x" * (10 * 1024 * 1024 + 1))]},
        format="multipart",
    )
    wrong_mime = client.post(
        feedback_url(env),
        {**submission(), "screenshots": [image("shot.gif", b"GIF89a", "image/gif")]},
        format="multipart",
    )
    wrong_header = client.post(
        feedback_url(env),
        {**submission(), "screenshots": [image("shot.webp", PNG_BYTES, "image/webp")]},
        format="multipart",
    )

    assert [item.status_code for item in (too_many, empty, too_large, wrong_mime, wrong_header)] == [
        422,
        422,
        413,
        422,
        422,
    ]
    assert ResearchFeedback.objects.count() == 0
    assert storage.upload_file.call_count == 0


@pytest.mark.django_db
def test_lists_and_status_use_own_org_and_workspace_scopes(env, storage):
    student_client = client_for(env["student"])
    colleague_client = client_for(env["colleague"])
    own = student_client.post(feedback_url(env), submission(content="Student graphite feedback"), format="multipart")
    other = colleague_client.post(
        feedback_url(env), submission(content="Colleague silicon feedback"), format="multipart"
    )
    own_id = own.json()["data"]["feedback_id"]
    other_id = other.json()["data"]["feedback_id"]

    assert [item["feedback_id"] for item in student_client.get(feedback_url(env)).json()["data"]["results"]] == [own_id]
    assert client_for(env["advisor"]).get(feedback_url(env), {"scope": "manage"}).status_code == 403
    pi_results = client_for(env["pi"]).get(feedback_url(env), {"scope": "manage"}).json()["data"]["results"]
    assert {item["feedback_id"] for item in pi_results} == {own_id, other_id}
    admin_results = client_for(env["admin"]).get(feedback_url(env), {"scope": "manage"}).json()["data"]["results"]
    assert {item["feedback_id"] for item in admin_results} == {own_id, other_id}
    assert (
        student_client.patch(
            feedback_url(env, f"{own_id}/status/"), {"status": "done", "comment": "x"}, format="json"
        ).status_code
        == 403
    )


@pytest.mark.django_db
def test_main_pi_with_workspace_admin_seat_remains_organization_scoped(env, storage):
    from plane.db.models import WorkspaceMember

    WorkspaceMember.objects.filter(workspace=env["workspace"], member=env["pi"]).update(role=20)
    student_feedback = (
        client_for(env["student"]).post(feedback_url(env), submission(), format="multipart").json()["data"]
    )
    unassigned = ResearchFeedback.objects.create(
        workspace=env["workspace"],
        username="Unassigned",
        feedback_type="other",
        content="No primary organization",
        created_by=env["admin"],
        idempotency_key=uuid4().hex,
        payload_hash=uuid4().hex,
    )
    results = client_for(env["pi"]).get(feedback_url(env), {"scope": "manage"}).json()["data"]["results"]
    assert {item["feedback_id"] for item in results} == {student_feedback["feedback_id"]}

    make_instance_admin(env["advisor"])
    administrator_results = (
        client_for(env["advisor"]).get(feedback_url(env), {"scope": "manage"}).json()["data"]["results"]
    )
    assert {item["feedback_id"] for item in administrator_results} == {
        student_feedback["feedback_id"],
        str(unassigned.id),
    }


@pytest.mark.django_db
def test_status_update_is_audited_and_returned_as_history(env, storage):
    feedback = client_for(env["student"]).post(feedback_url(env), submission(), format="multipart").json()["data"]
    response = client_for(env["pi"]).patch(
        feedback_url(env, f"{feedback['feedback_id']}/status/"),
        {"status": "in_progress", "comment": "Reproduced and assigned"},
        format="json",
    )

    assert response.status_code == 200, response.json()
    assert response.json()["data"]["status"] == "in_progress"
    event = ResearchAuditEvent.objects.get(
        action="feedback.status.update", resource_id=feedback["feedback_id"], actor=env["pi"]
    )
    assert event.metadata["from_status"] == "open"
    assert event.metadata["to_status"] == "in_progress"
    assert event.metadata["comment"] == "Reproduced and assigned"
    listed = client_for(env["student"]).get(feedback_url(env)).json()["data"]["results"][0]
    assert listed["history"][0]["actor_name"] == env["pi"].display_name
    empty = client_for(env["pi"]).patch(
        feedback_url(env, f"{feedback['feedback_id']}/status/"), {"status": "done", "comment": " "}, format="json"
    )
    assert empty.status_code == 422


@pytest.mark.django_db
def test_screenshot_stream_uses_feedback_acl_and_no_store_headers(env, storage):
    feedback = (
        client_for(env["student"])
        .post(feedback_url(env), {**submission(), "screenshots": [image()]}, format="multipart")
        .json()["data"]
    )
    screenshot_id = feedback["screenshots"][0]["id"]
    suffix = f"{feedback['feedback_id']}/screenshots/{screenshot_id}/"

    own = client_for(env["student"]).get(feedback_url(env, suffix))
    outsider = client_for(env["colleague"]).get(feedback_url(env, suffix))
    manager = client_for(env["pi"]).get(feedback_url(env, suffix), {"scope": "manage"})

    assert own.status_code == manager.status_code == 200
    assert b"".join(own.streaming_content) == PNG_BYTES
    assert own["Cache-Control"] == "private, no-store"
    assert own["X-Content-Type-Options"] == "nosniff"
    assert outsider.status_code == 404


@pytest.mark.django_db
def test_generic_asset_boundary_fails_closed_for_feedback_screenshots(env, storage):
    feedback = (
        client_for(env["student"])
        .post(feedback_url(env), {**submission(), "screenshots": [image()]}, format="multipart")
        .json()["data"]
    )
    asset = FileAsset.objects.get(entity_identifier=feedback["feedback_id"])

    from plane.app.views.asset.base import _research_asset_allowed
    from plane.app.views.asset.v2 import can_download_research_asset, can_mutate_research_asset

    assert not can_download_research_asset(env["student"], asset)
    assert not can_download_research_asset(env["pi"], asset)
    assert not can_download_research_asset(env["admin"], asset)
    assert not can_download_research_asset(env["colleague"], asset)
    assert not can_mutate_research_asset(env["student"], asset)
    assert not can_mutate_research_asset(env["admin"], asset)
    assert not _research_asset_allowed(env["student"], asset)
    assert not _research_asset_allowed(env["admin"], asset, mutate=True)

    generic_url = f"/api/assets/v2/workspaces/{env['workspace'].slug}/download/{asset.id}/"
    assert client_for(env["student"]).get(generic_url).status_code == 403
    assert client_for(env["pi"]).get(generic_url).status_code == 403
    assert client_for(env["admin"]).get(generic_url).status_code == 403
    mutation_url = f"/api/assets/v2/workspaces/{env['workspace'].slug}/{asset.id}/"
    assert client_for(env["student"]).delete(mutation_url).status_code in (403, 404)
    restore_url = f"/api/assets/v2/workspaces/{env['workspace'].slug}/restore/{asset.id}/"
    assert client_for(env["admin"]).post(restore_url).status_code in (403, 404)
    asset.refresh_from_db()
    assert not asset.is_deleted


@pytest.mark.django_db
def test_generic_asset_creation_cannot_mint_feedback_screenshots(env, storage):
    feedback = (
        client_for(env["student"])
        .post(feedback_url(env), {**submission(), "screenshots": [image()]}, format="multipart")
        .json()["data"]
    )
    asset = FileAsset.objects.get(entity_identifier=feedback["feedback_id"])
    payload = {
        "name": "intruder.png",
        "type": "image/png",
        "size": 4,
        "entity_type": FileAsset.EntityTypeContext.FEEDBACK_SCREENSHOT,
        "entity_identifier": feedback["feedback_id"],
    }
    project = create_project(env, env["student"], "Feedback asset boundary", env["group_a"])
    workspace_url = f"/api/assets/v2/workspaces/{env['workspace'].slug}/"
    project_url = f"/api/assets/v2/workspaces/{env['workspace'].slug}/projects/{project.id}/"
    source_asset = FileAsset.objects.create(
        workspace=env["workspace"],
        user=env["student"],
        created_by=env["student"],
        attributes={"name": "source.png", "type": "image/png", "size": len(PNG_BYTES)},
        asset=f"{env['workspace'].id}/research/feedback/source.png",
        size=len(PNG_BYTES),
        entity_type=FileAsset.EntityTypeContext.ISSUE_ATTACHMENT,
        is_uploaded=True,
    )
    duplicate_url = f"/api/assets/v2/workspaces/{env['workspace'].slug}/duplicate-assets/{source_asset.id}/"
    legacy_url = f"/api/workspaces/{env['workspace'].slug}/file-assets/"

    workspace_response = client_for(env["student"]).post(workspace_url, payload, format="json")
    project_response = client_for(env["student"]).post(project_url, payload, format="json")
    duplicate_response = client_for(env["student"]).post(
        duplicate_url,
        {
            "entity_type": FileAsset.EntityTypeContext.FEEDBACK_SCREENSHOT,
            "entity_id": feedback["feedback_id"],
        },
        format="json",
    )
    legacy_response = client_for(env["student"]).post(
        legacy_url,
        {
            **payload,
            "asset": f"{env['workspace'].id}/feedback-boundary.png",
            "attributes": {"name": "feedback-boundary.png", "type": "image/png", "size": 4},
        },
        format="json",
    )

    assert (
        workspace_response.status_code
        == project_response.status_code
        == duplicate_response.status_code
        == legacy_response.status_code
        == 400
    )
    assert FileAsset.objects.filter(entity_type=FileAsset.EntityTypeContext.FEEDBACK_SCREENSHOT).count() == 1
    assert FileAsset.objects.filter(pk=asset.pk).exists()
    storage.upload_file.assert_called_once()


@pytest.mark.django_db
def test_storage_failure_does_not_create_a_partial_feedback(env, storage):
    storage.upload_file.side_effect = [True, False]
    response = client_for(env["student"]).post(
        feedback_url(env), {**submission(), "screenshots": [image(), image("second.png")]}, format="multipart"
    )

    assert response.status_code == 503
    assert response.json()["error_code"] == "research_feedback_storage_unavailable"
    assert ResearchFeedback.objects.count() == 0
    assert ResearchFeedbackScreenshot.objects.count() == 0
    storage.delete_files.assert_called_once()


@pytest.mark.django_db
def test_database_registration_failure_cleans_uploaded_objects(env, storage):
    with mock.patch.object(
        ResearchFeedbackScreenshot.objects, "create", side_effect=IntegrityError("registration failed")
    ):
        response = client_for(env["student"]).post(
            feedback_url(env), {**submission(), "screenshots": [image()]}, format="multipart"
        )

    assert response.status_code == 503
    assert response.json()["error_code"] == "research_feedback_storage_unavailable"
    assert ResearchFeedback.objects.count() == 0
    assert ResearchFeedbackScreenshot.objects.count() == 0
    storage.delete_files.assert_called_once()


@pytest.mark.django_db
def test_list_filters_and_pagination_are_applied_server_side(env, storage):
    client = client_for(env["student"])
    for index in range(3):
        client.post(
            feedback_url(env), submission(content=f"graphite issue {index}", feedback_type="bug"), format="multipart"
        )
    client.post(feedback_url(env), submission(content="silicon idea", feedback_type="idea"), format="multipart")

    payload = client.get(
        feedback_url(env),
        {"q": "graphite", "feedback_type": "bug", "page": 1, "page_size": 2},
    ).json()["data"]
    assert payload["count"] == 3
    assert len(payload["results"]) == 2
    assert all("graphite" in item["content"] for item in payload["results"])

    oversized = client.get(feedback_url(env), {"page_size": "1000"}).json()["data"]
    assert oversized["page_size"] == 100


@pytest.mark.django_db
def test_submission_rate_limit_ignores_idempotent_retries(env, storage):
    client = client_for(env["student"])
    first = submission()

    for index in range(5):
        payload = first if index == 0 else submission()
        assert client.post(feedback_url(env), payload, format="multipart").status_code == 200

    retry = client.post(feedback_url(env), first, format="multipart")
    assert retry.status_code == 200
    assert ResearchFeedback.objects.filter(created_by=env["student"], deleted_at__isnull=True).count() == 5

    limited = client.post(feedback_url(env), submission(), format="multipart")
    assert limited.status_code == 429
    assert limited.json()["error_code"] == "research_feedback_rate_limited"
    assert ResearchFeedback.objects.filter(created_by=env["student"], deleted_at__isnull=True).count() == 5


@pytest.mark.django_db
def test_submission_enforces_active_screenshot_storage_quota(env, storage):
    from plane.research.services.feedback import SCREENSHOT_STORAGE_QUOTA

    feedback = ResearchFeedback.objects.create(
        workspace=env["workspace"],
        username="Student Alpha",
        feedback_type="bug",
        content="Existing feedback",
        idempotency_key=uuid4().hex,
        payload_hash="a" * 64,
    )
    feedback.save(created_by_id=env["student"].id)
    asset = FileAsset.objects.create(
        workspace=env["workspace"],
        user=env["student"],
        created_by=env["student"],
        attributes={"name": "existing.png", "type": "image/png", "size": SCREENSHOT_STORAGE_QUOTA},
        asset=f"{env['workspace'].id}/research/feedback/existing.png",
        size=SCREENSHOT_STORAGE_QUOTA,
        entity_type=FileAsset.EntityTypeContext.FEEDBACK_SCREENSHOT,
        entity_identifier=str(feedback.id),
        is_uploaded=True,
    )
    ResearchFeedbackScreenshot.objects.create(feedback=feedback, asset=asset, position=1, created_by=env["student"])
    shot = ResearchFeedbackScreenshot.objects.get()
    assert shot.feedback == feedback
    assert shot.asset == asset
    assert shot.deleted_at is None
    assert not asset.is_deleted
    assert asset.deleted_at is None
    asset.refresh_from_db()
    assert asset.size == SCREENSHOT_STORAGE_QUOTA
    active_size = (
        FileAsset.objects.filter(
            id__in=ResearchFeedbackScreenshot.objects.filter(
                feedback__workspace=env["workspace"],
                feedback__created_by_id=env["student"].id,
                feedback__deleted_at__isnull=True,
                deleted_at__isnull=True,
            ).values("asset_id"),
            is_deleted=False,
            deleted_at__isnull=True,
        ).aggregate(total=Sum("size"))["total"]
        or 0
    )
    assert active_size == SCREENSHOT_STORAGE_QUOTA

    response = client_for(env["student"]).post(
        feedback_url(env), {**submission(), "screenshots": [image()]}, format="multipart"
    )

    assert response.status_code == 413
    assert response.json()["error_code"] == "research_feedback_storage_quota_exceeded"
    assert ResearchFeedback.objects.filter(created_by=env["student"], deleted_at__isnull=True).count() == 1
    storage.upload_file.assert_not_called()


@pytest.mark.django_db
def test_submission_lock_fails_closed_when_cache_is_unavailable(env, storage):
    with mock.patch("plane.research.services.feedback.cache.add", side_effect=Exception("cache unavailable")):
        response = client_for(env["student"]).post(feedback_url(env), submission(), format="multipart")

    assert response.status_code == 503
    assert response.json()["error_code"] == "research_feedback_storage_unavailable"
    assert not ResearchFeedback.objects.exists()
    storage.upload_file.assert_not_called()


@pytest.mark.django_db
def test_concurrent_submission_lock_returns_busy(env, storage):
    from django.core.cache import cache
    from plane.research.services.feedback import SUBMIT_LOCK_TTL_SECONDS, submit_lock_key

    key = submit_lock_key(env["workspace"].id, env["student"].id)
    cache.set(key, "another-owner", SUBMIT_LOCK_TTL_SECONDS)
    response = client_for(env["student"]).post(feedback_url(env), submission(), format="multipart")

    assert response.status_code == 409
    assert response.json()["error_code"] == "research_feedback_busy"
    assert not ResearchFeedback.objects.exists()
    storage.upload_file.assert_not_called()
    cache.delete(key)


@pytest.mark.django_db
def test_cleanup_failure_keeps_controlled_storage_error(env, storage, caplog):
    storage.delete_files.side_effect = Exception("delete unavailable")
    with mock.patch.object(ResearchFeedbackScreenshot.objects, "create", side_effect=IntegrityError("failed")):
        with caplog.at_level("WARNING", logger="plane.research.services.feedback"):
            response = client_for(env["student"]).post(
                feedback_url(env), {**submission(), "screenshots": [image()]}, format="multipart"
            )

    assert response.status_code == 503
    assert response.json()["error_code"] == "research_feedback_storage_unavailable"
    assert not ResearchFeedback.objects.exists()
    warning = next(record for record in caplog.records if record.name == "plane.research.services.feedback")
    assert "feedback" in warning.getMessage()
    assert str(env["workspace"].id) in warning.getMessage()


@pytest.mark.django_db
def test_soft_deleted_feedback_and_screenshots_do_not_reappear(env, storage):
    client = client_for(env["student"])
    key = uuid4().hex
    created = client.post(
        feedback_url(env),
        {**submission(idempotency_key=key), "screenshots": [image()]},
        format="multipart",
    ).json()["data"]

    ResearchFeedback.objects.filter(pk=created["feedback_id"]).update(deleted_at=timezone.now())
    retried = client.post(
        feedback_url(env),
        {**submission(idempotency_key=key), "screenshots": [image()]},
        format="multipart",
    )
    assert retried.status_code == 200
    assert retried.json()["data"]["feedback_id"] != created["feedback_id"]

    active_id = retried.json()["data"]["feedback_id"]
    ResearchFeedbackScreenshot.objects.filter(feedback_id=active_id).update(deleted_at=timezone.now())
    listed = client.get(feedback_url(env)).json()["data"]["results"]
    assert [item["feedback_id"] for item in listed] == [active_id]
    assert listed[0]["screenshots"] == []


@pytest.mark.django_db
def test_screenshot_stream_maps_boto_client_errors_to_storage_unavailable(env, storage):
    feedback = client_for(env["student"]).post(
        feedback_url(env), {**submission(), "screenshots": [image()]}, format="multipart"
    ).json()["data"]

    def raise_boto_core_error(*args, **kwargs):
        raise BotoCoreError()

    storage.server_s3_client.get_object.side_effect = raise_boto_core_error
    screenshot_id = feedback["screenshots"][0]["id"]
    response = client_for(env["student"]).get(
        feedback_url(env, f"{feedback['feedback_id']}/screenshots/{screenshot_id}/")
    )

    assert response.status_code == 503
    assert response.json()["error_code"] == "research_feedback_storage_unavailable"
