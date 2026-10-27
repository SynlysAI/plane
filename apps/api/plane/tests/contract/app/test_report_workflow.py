"""Shared workflow and REST rollback regressions against a real database."""

from unittest.mock import patch

import pytest
from django.db import IntegrityError, transaction

from plane.db.models import (
    FileAsset,
    Notification,
    Page,
    PeriodicReport,
    PeriodicReportSnapshot,
    ResearchAuditEvent,
    ReportAttachment,
    ReportReviewLog,
    ReportTemplate,
)
from plane.research.services import report_workflow as workflow
from plane.tests.contract.app.test_research_reports import env as report_env, research_module_on  # noqa: F401

pytestmark = [pytest.mark.contract, pytest.mark.django_db]


@pytest.fixture
def env(report_env):  # noqa: F811
    return report_env


def body(text):
    return {
        "description_json": {
            "type": "doc",
            "content": [{"type": "paragraph", "content": [{"type": "text", "text": text}]}],
        },
        "description_html": f"<p>{text}</p>",
    }


def create(env):
    return workflow.create_report_draft(
        workspace=env["workspace"], actor=env["student"], payload={"period_key": "2026-W43"}
    )


def submit(env, report, payload=None):
    return workflow.submit_report(
        workspace=env["workspace"], actor=env["student"], report_id=report.pk, payload=payload or {}
    )


def assert_rolled_back(env, report, original_body, counts):
    report.refresh_from_db()
    report.page.refresh_from_db()
    assert report.status == "DRAFT"
    assert report.submitted_at is None
    assert report.page.description_html == original_body
    assert not PeriodicReportSnapshot.objects.filter(report=report).exists()
    assert not ReportReviewLog.objects.filter(report=report).exists()
    assert ResearchAuditEvent.objects.count() == counts[0]
    assert Notification.objects.count() == counts[1]


def test_shared_create_save_submit_and_returned_resubmit_keep_official_versions(env):
    report = create(env)
    workflow.save_report_body(workspace=env["workspace"], actor=env["student"], report_id=report.pk, payload=body("v1"))
    assert not report.official_snapshots.exists()
    assert not Notification.objects.filter(entity_identifier=report.pk).exists()
    submitted = submit(env, report)
    assert submitted.status == "SUBMITTED"
    first = PeriodicReportSnapshot.objects.get(report=report, version_no=1)
    assert first.description_html == "<p>v1</p>"
    assert first.description_stripped == "v1"
    assert first.description_json == body("v1")["description_json"]
    response = env["advisor_client"].post(f"{env['url']}{report.pk}/return/", {"comment": "Add results"}, format="json")
    assert response.status_code == 200
    submit(env, report, body("v2"))
    first.refresh_from_db()
    assert first.description_html == "<p>v1</p>"
    second = PeriodicReportSnapshot.objects.get(report=report, version_no=2)
    assert second.description_html == "<p>v2</p>"
    assert ReportReviewLog.objects.filter(report=report, action="SUBMIT").count() == 2
    assert Notification.objects.filter(entity_identifier=report.pk, message__action="submitted").count() == 2


def test_snapshot_validation_failure_rolls_back_final_body_and_all_effects_via_rest(env):
    report = create(env)
    original_body = report.page.description_html
    counts = (ResearchAuditEvent.objects.count(), Notification.objects.count())
    # Fail after serializer.save(), reproducing the former partial commit path.
    with patch("plane.research.utils.report_images.image_manifest", side_effect=ValueError("image removed")):
        response = env["student_client"].post(f"{env['url']}{report.pk}/submit/", body("must roll back"), format="json")
    assert response.status_code == 422
    assert response.json() == {"error_code": "file_type_not_allowed", "message": "image removed"}
    assert_rolled_back(env, report, original_body, counts)


@pytest.mark.parametrize(
    "payload,error_field",
    [
        ({"description_html": ["invalid field type"]}, "description_html"),
        ({"description_binary": "not valid collaborative data"}, "description_binary"),
        (
            {
                "description_json": {
                    "type": "doc",
                    "content": [{"type": "image", "attrs": {"src": "not-a-report-image"}}],
                }
            },
            "non_field_errors",
        ),
    ],
)
def test_submit_keeps_serializer_error_shape_and_never_saves_invalid_body(env, payload, error_field):
    report = create(env)
    original_body = report.page.description_html
    counts = (ResearchAuditEvent.objects.count(), Notification.objects.count())
    response = env["student_client"].post(f"{env['url']}{report.pk}/submit/", payload, format="json")
    assert response.status_code == 400
    assert set(response.json()) == {error_field}
    assert_rolled_back(env, report, original_body, counts)


@pytest.mark.parametrize("failure", ["review_log", "audit", "notification"])
def test_late_failure_rolls_back_snapshot_status_body_audit_and_notification(env, failure):
    report = create(env)
    original_body = report.page.description_html
    counts = (ResearchAuditEvent.objects.count(), Notification.objects.count())
    # Each target writes its real row(s) before failing; rollback must undo them.
    targets = {
        "review_log": (workflow.ReportReviewLog.objects, "create"),
        "audit": (workflow, "record_audit_event"),
        "notification": (workflow, "notify_report_submitted"),
    }
    target, name = targets[failure]
    real_call = getattr(target, name)

    def fail_after_write(*args, **kwargs):
        real_call(*args, **kwargs)
        raise RuntimeError("injected late failure")

    with patch.object(target, name, side_effect=fail_after_write):
        with pytest.raises(RuntimeError, match="injected late failure"):
            submit(env, report, body("must roll back"))
    assert_rolled_back(env, report, original_body, counts)


def test_outer_operation_failure_rolls_back_new_report_page_and_submission(env):
    page_count = Page.objects.count()
    audit_count = ResearchAuditEvent.objects.count()
    notification_count = Notification.objects.count()
    with pytest.raises(RuntimeError, match="operation result failed"):
        with transaction.atomic():
            report = create(env)
            submit(env, report, body("new report"))
            raise RuntimeError("operation result failed")
    assert not PeriodicReport.objects.filter(workspace=env["workspace"], period_key="2026-W43").exists()
    assert Page.objects.count() == page_count
    assert ResearchAuditEvent.objects.count() == audit_count
    assert Notification.objects.count() == notification_count


def test_unique_conflict_after_page_creation_leaves_no_orphan_page(env):
    count = Page.objects.count()
    audit_count = ResearchAuditEvent.objects.count()
    with patch.object(PeriodicReport.objects, "create", side_effect=IntegrityError("concurrent winner")):
        with pytest.raises(workflow.ReportWorkflowError) as error:
            create(env)
    assert error.value.status_code == 409
    assert error.value.data["error_code"] == "report_period_conflict"
    assert Page.objects.count() == count
    assert ResearchAuditEvent.objects.count() == audit_count


def test_template_and_body_patch_roll_back_together_on_invalid_body(env):
    report = create(env)
    old_json, old_template = report.page.description_json, report.template_id
    template = ReportTemplate.objects.create(
        workspace=env["workspace"],
        name="Replacement",
        report_type="WEEKLY",
        content_json=body("replacement")["description_json"],
        created_by=env["admin"],
    )
    response = env["student_client"].patch(
        f"{env['url']}{report.pk}/",
        {"template": str(template.pk), "description_binary": "not valid collaborative data"},
        format="json",
    )
    assert response.status_code == 400
    assert "description_binary" in response.json()
    report.refresh_from_db()
    assert report.template_id == old_template
    assert report.page.description_json == old_json


@pytest.mark.parametrize("action", ["save", "submit"])
def test_shared_workflow_does_not_allow_another_member_to_write(env, action):
    report = create(env)
    function = workflow.save_report_body if action == "save" else workflow.submit_report
    with pytest.raises(workflow.ReportWorkflowError) as error:
        function(workspace=env["workspace"], actor=env["colleague"], report_id=report.pk, payload=body("denied"))
    assert error.value.status_code == 404
    report.refresh_from_db()
    assert report.status == "DRAFT"
    assert report.page.description_html == "<p></p>"


def test_submit_replacement_clears_stale_collaborative_binary(env):
    report = create(env)
    Page.objects.filter(pk=report.page_id).update(description_binary=b"old yjs state")
    submit(env, report, body("replacement"))
    report.page.refresh_from_db()
    snapshot = PeriodicReportSnapshot.objects.get(report=report)
    assert report.page.description_binary is None
    assert snapshot.description_binary is None
    assert report.page.description_json == snapshot.description_json == body("replacement")["description_json"]
    assert report.page.description_stripped == snapshot.description_stripped == "replacement"


@pytest.mark.parametrize("node_type,tag", [("image", "img"), ("imageComponent", "image-component")])
def test_submit_freezes_existing_images_and_attachments_with_authorized_readback(env, node_type, tag):
    report = create(env)
    image = FileAsset.objects.create(
        workspace=env["workspace"],
        user=env["student"],
        created_by=env["student"],
        asset=f"{env['workspace'].id}/test.png",
        size=32,
        attributes={"name": "test.png", "type": "image/png"},
        entity_type=FileAsset.EntityTypeContext.REPORT_IMAGE,
        entity_identifier=str(report.pk),
        is_uploaded=True,
    )
    asset = FileAsset.objects.create(
        workspace=env["workspace"],
        user=env["student"],
        asset=f"{env['workspace'].id}/test.pdf",
        entity_type=FileAsset.EntityTypeContext.REPORT_ATTACHMENT,
        entity_identifier=str(report.pk),
        is_uploaded=True,
    )
    attachment = ReportAttachment.objects.create(
        report=report,
        asset=asset,
        kind="PDF",
        file_name="test.pdf",
        file_size=32,
        content_type="application/pdf",
        uploaded_by=env["student"],
    )
    image_url = f"{env['url']}{report.pk}/images/{image.pk}/"
    payload = body("evidence")
    payload["description_json"]["content"].append({"type": node_type, "attrs": {"src": image_url}})
    payload["description_html"] += f'<{tag} src="{image_url}"></{tag}>'
    submit(env, report, payload)
    snapshot = PeriodicReportSnapshot.objects.get(report=report)
    assert [entry["asset_id"] for entry in snapshot.image_manifest] == [str(image.pk)]
    assert [entry["attachment_id"] for entry in snapshot.attachment_manifest] == [str(attachment.pk)]
    attachment.refresh_from_db()
    assert attachment.official_version_no == snapshot.version_no == 1
    with patch("plane.research.views.report_images.S3Storage") as storage:
        storage.return_value.generate_presigned_url.return_value = "https://storage.invalid/test.png"
        response = env["advisor_client"].get(image_url)
    assert response.status_code == 302


@pytest.mark.parametrize("state", ["SUBMITTED", "ACCEPTED"])
def test_shared_workflow_rejects_terminal_report_without_overwriting_body(env, state):
    report = create(env)
    submit(env, report, body("official"))
    if state == "ACCEPTED":
        response = env["advisor_client"].post(f"{env['url']}{report.pk}/accept/", {}, format="json")
        assert response.status_code == 200
    with pytest.raises(workflow.ReportWorkflowError) as error:
        submit(env, report, body("overwrite"))
    assert error.value.status_code == 409
    assert PeriodicReportSnapshot.objects.filter(report=report).count() == 1
    assert Page.objects.get(pk=report.page_id).description_html == "<p>official</p>"
