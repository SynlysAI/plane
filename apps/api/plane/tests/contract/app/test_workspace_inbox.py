# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Contract tests for the unified workspace inbox projection."""

from datetime import date, datetime, timedelta, timezone as datetime_timezone
from uuid import uuid4

import pytest
from rest_framework import status

from plane.db.models import (
    Notification,
    Page,
    PeriodicReport,
    PeriodicReportComment,
    PeriodicReportCommentThread,
    User,
)
from plane.app.services.inbox import generate_inbox_todo_reminders, todo_payload_hash
from plane.research.utils.notifications import notify_report_comment


def inbox_url(workspace, path=""):
    """Build the unified inbox API URL.

    Args:
        workspace: Workspace whose inbox is requested.
        path: Optional endpoint path appended to the inbox root.

    Returns:
        Absolute API path used by the web client.
    """
    return f"/api/workspaces/{workspace.slug}/users/inbox/{path}"


def make_todo(object_id, **overrides):
    """Create a minimal research todo envelope for projection tests.

    Args:
        object_id: Business object identifier projected by the collector.
        **overrides: Fields overridden by an individual test.

    Returns:
        A ``research-todo.v2`` envelope.
    """
    payload = {
        "schema_version": "research-todo.v2",
        "id": f"CHAIN_TASK:{object_id}",
        "source": "CHAIN_TASK",
        "object_id": str(object_id),
        "project_id": None,
        "title": "提交技术路线说明",
        "context": {"chain": "AI4MS"},
        "requester": None,
        "assignees": [],
        "business_status": "ASSIGNED",
        "handling_status": "IN_PROGRESS",
        "next_action": "SUBMIT",
        "due_at": None,
        "urgency": "NORMAL",
        "href": "/research/tasks/1/",
        "capabilities": {},
        "trace_ref": "test:chain-task",
        "updated_at": "2026-10-26T02:00:00+00:00",
    }
    payload.update(overrides)
    return payload


def create_research_notification(workspace, receiver, actor):
    """Create one valid research report notification.

    Args:
        workspace: Workspace receiving the notification.
        receiver: User who should see the notification.
        actor: User who triggered the notification.

    Returns:
        The created notification row.
    """
    page = Page.objects.create(
        workspace=workspace,
        name="2026-W43 inbox report",
        owned_by=receiver,
        created_by=actor,
    )
    report = PeriodicReport.objects.create(
        workspace=workspace,
        owner=receiver,
        page=page,
        report_type=PeriodicReport.ReportType.WEEKLY,
        period_key=f"2026-{uuid4().hex[:8]}",
        period_start=date(2026, 10, 19),
        period_end=date(2026, 10, 25),
        status=PeriodicReport.Status.SUBMITTED,
        created_by=actor,
    )
    return Notification.objects.create(
        workspace=workspace,
        receiver=receiver,
        entity_identifier=report.id,
        entity_name="research_report",
        title="周报等待审阅",
        message={"action": "review_requested"},
        message_stripped="周报等待审阅",
        sender="research",
        triggered_by=actor,
        data={"action": "review_requested", "route": "/research/reports/1/"},
    )


@pytest.mark.contract
@pytest.mark.django_db
class TestUnifiedWorkspaceInbox:
    """Verify notification and todo projections share one inbox contract."""

    def test_research_notifications_enter_legacy_notification_inbox(self, session_client, workspace, create_user):
        """Research notifications are listed and counted by notification APIs."""
        notification = create_research_notification(
            workspace,
            create_user,
            create_user,
        )

        list_response = session_client.get(f"/api/workspaces/{workspace.slug}/users/notifications/")
        unread_response = session_client.get(f"/api/workspaces/{workspace.slug}/users/notifications/unread/")

        assert list_response.status_code == status.HTTP_200_OK
        assert unread_response.status_code == status.HTTP_200_OK
        assert str(notification.id) in {item["id"] for item in list_response.json()}
        assert unread_response.json() == {
            "total_unread_notifications_count": 1,
            "mention_unread_notifications_count": 0,
        }

    def test_inbox_projects_notifications_and_todos(self, session_client, workspace, create_user, monkeypatch):
        """The unified API returns both events and current actionable todos."""
        todo = make_todo("22222222-2222-2222-2222-222222222222")
        notification = create_research_notification(
            workspace,
            create_user,
            create_user,
        )
        monkeypatch.setattr(
            "plane.app.services.inbox.collect_inbox_todos",
            lambda workspace, user: ([todo], []),
        )

        response = session_client.get(inbox_url(workspace))
        payload = response.json()

        assert response.status_code == status.HTTP_200_OK
        assert payload["schema_version"] == "inbox.v1"
        assert {item["kind"] for item in payload["results"]} == {"notification", "todo"}
        assert payload["unread_counts"]["total_unread_count"] == 2
        assert payload["unread_counts"]["todo_unread_count"] == 1
        assert notification.title in {item["title"] for item in payload["results"]}

    def test_unread_items_sort_before_read_items(self, session_client, workspace, create_user, monkeypatch):
        """Unread inbox items lead the list regardless of read-item timestamps."""
        monkeypatch.setattr(
            "plane.app.services.inbox.collect_inbox_todos",
            lambda workspace, user: ([], []),
        )
        read_notification = create_research_notification(workspace, create_user, create_user)
        unread_notification = create_research_notification(workspace, create_user, create_user)
        read_notification.read_at = datetime(2026, 10, 25, tzinfo=datetime_timezone.utc)
        read_notification.updated_at = datetime(2026, 10, 26, 5, tzinfo=datetime_timezone.utc)
        unread_notification.updated_at = datetime(2026, 10, 26, 4, tzinfo=datetime_timezone.utc)
        read_notification.save(update_fields=["read_at", "updated_at"])
        unread_notification.save(update_fields=["updated_at"])

        response = session_client.get(inbox_url(workspace))

        assert response.status_code == status.HTTP_200_OK
        assert response.json()["results"][0]["id"] == f"notification:{unread_notification.id}"

    def test_todo_supersedes_old_event_until_business_todo_closes(
        self, session_client, workspace, create_user, monkeypatch
    ):
        """A current todo hides its old event and keeps it read after closing."""
        notification = create_research_notification(workspace, create_user, create_user)
        todo = make_todo(str(notification.entity_identifier), source="REPORT")
        monkeypatch.setattr(
            "plane.app.services.inbox.collect_inbox_todos",
            lambda workspace, user: ([todo], []),
        )

        suppressed_response = session_client.get(inbox_url(workspace))
        monkeypatch.setattr(
            "plane.app.services.inbox.collect_inbox_todos",
            lambda workspace, user: ([], []),
        )
        closed_response = session_client.get(inbox_url(workspace))
        notification.refresh_from_db()

        assert suppressed_response.status_code == status.HTTP_200_OK
        assert suppressed_response.json()["results"] == [suppressed_response.json()["results"][0]]
        assert suppressed_response.json()["results"][0]["kind"] == "todo"
        assert notification.read_at is not None
        assert closed_response.status_code == status.HTTP_200_OK
        assert closed_response.json()["unread_counts"]["total_unread_count"] == 0
        assert closed_response.json()["results"][0]["id"] == f"notification:{notification.id}"

    def test_mention_notification_is_not_superseded_by_todo(self, session_client, workspace, create_user, monkeypatch):
        """Mentions remain visible even when the same object has a current todo."""
        notification = create_research_notification(workspace, create_user, create_user)
        notification.sender = "research:mentioned"
        notification.save(update_fields=["sender"])
        todo = make_todo(str(notification.entity_identifier), source="REPORT")
        monkeypatch.setattr(
            "plane.app.services.inbox.collect_inbox_todos",
            lambda workspace, user: ([todo], []),
        )

        response = session_client.get(inbox_url(workspace), {"tab": "mentions"})

        assert response.status_code == status.HTTP_200_OK
        assert response.json()["unread_counts"]["mention_unread_count"] == 1
        assert f"notification:{notification.id}" in {item["id"] for item in response.json()["results"]}

    def test_reading_todo_does_not_complete_business_todo(self, session_client, workspace, create_user, monkeypatch):
        """A read marker only updates inbox state and never the domain envelope."""
        todo = make_todo("44444444-4444-4444-4444-444444444444")
        monkeypatch.setattr(
            "plane.app.services.inbox.collect_inbox_todos",
            lambda workspace, user: ([todo], []),
        )

        response = session_client.post(
            inbox_url(workspace, "items/todo:CHAIN_TASK:44444444-4444-4444-4444-444444444444/read/")
        )

        assert response.status_code == status.HTTP_200_OK
        assert response.json()["unread_counts"]["total_unread_count"] == 0
        assert todo["business_status"] == "ASSIGNED"
        assert todo["next_action"] == "SUBMIT"

    def test_changed_todo_becomes_unread_again(self, session_client, workspace, create_user, monkeypatch):
        """A changed business fingerprint reopens the inbox item for attention."""
        from plane.db.models import InboxTodoState

        object_id = "55555555-5555-5555-5555-555555555555"
        InboxTodoState.objects.create(
            workspace=workspace,
            receiver=create_user,
            source="CHAIN_TASK",
            object_id=object_id,
            dedupe_key=f"todo:CHAIN_TASK:{object_id}",
            payload_hash="old-fingerprint",
            read_at=datetime(2026, 10, 25, tzinfo=datetime_timezone.utc),
        )
        todo = make_todo(object_id, business_status="NEEDS_REVISION")
        monkeypatch.setattr(
            "plane.app.services.inbox.collect_inbox_todos",
            lambda workspace, user: ([todo], []),
        )

        response = session_client.get(inbox_url(workspace))
        item = next(item for item in response.json()["results"] if item["kind"] == "todo")

        assert response.status_code == status.HTTP_200_OK
        assert item["read_at"] is None
        assert item["business_status"] == "NEEDS_REVISION"

    def test_unchanged_business_fields_keep_todo_read(self, session_client, workspace, create_user, monkeypatch):
        """An unrelated domain timestamp does not reopen an already-read todo."""
        from plane.db.models import InboxTodoState

        object_id = "55555555-5555-5555-5555-555555555556"
        todo = make_todo(object_id)
        InboxTodoState.objects.create(
            workspace=workspace,
            receiver=create_user,
            source="CHAIN_TASK",
            object_id=object_id,
            dedupe_key=f"todo:CHAIN_TASK:{object_id}",
            payload_hash=todo_payload_hash(todo),
            read_at=datetime(2026, 10, 25, tzinfo=datetime_timezone.utc),
        )
        todo["updated_at"] = "2026-10-26T06:00:00+00:00"
        monkeypatch.setattr(
            "plane.app.services.inbox.collect_inbox_todos",
            lambda workspace, user: ([todo], []),
        )

        response = session_client.get(inbox_url(workspace))

        assert response.status_code == status.HTTP_200_OK
        assert response.json()["results"][0]["read_at"] is not None

    def test_legacy_fingerprint_upgrade_preserves_read_state(self, session_client, workspace, create_user, monkeypatch):
        """Existing SHA-256 fingerprints upgrade once without reopening read todos."""
        from plane.db.models import InboxTodoState

        object_id = "55555555-5555-5555-5555-555555555557"
        todo = make_todo(object_id, updated_at="2026-10-26T06:00:00+00:00")
        state = InboxTodoState.objects.create(
            workspace=workspace,
            receiver=create_user,
            source="CHAIN_TASK",
            object_id=object_id,
            dedupe_key=f"todo:CHAIN_TASK:{object_id}",
            payload_hash="a" * 64,
            read_at=datetime(2026, 10, 25, tzinfo=datetime_timezone.utc),
        )
        monkeypatch.setattr(
            "plane.app.services.inbox.collect_inbox_todos",
            lambda workspace, user: ([todo], []),
        )

        response = session_client.get(inbox_url(workspace))
        state.refresh_from_db()

        assert response.status_code == status.HTTP_200_OK
        assert response.json()["results"][0]["read_at"] is not None
        assert state.payload_hash == todo_payload_hash(todo)

    def test_mark_all_read_clears_badge_without_completing_todos(
        self, session_client, workspace, create_user, monkeypatch
    ):
        """Bulk read affects only notification and inbox state fields."""
        todo = make_todo("66666666-6666-6666-6666-666666666666")
        create_research_notification(
            workspace,
            create_user,
            create_user,
        )
        monkeypatch.setattr(
            "plane.app.services.inbox.collect_inbox_todos",
            lambda workspace, user: ([todo], []),
        )
        session_client.get(inbox_url(workspace))

        response = session_client.post(inbox_url(workspace, "mark-all-read/"))

        assert response.status_code == status.HTTP_200_OK
        assert response.json()["unread_counts"]["total_unread_count"] == 0
        assert todo["business_status"] == "ASSIGNED"
        assert todo["next_action"] == "SUBMIT"

    def test_expired_snooze_returns_to_active_bucket_and_bulk_read(
        self, session_client, workspace, create_user, monkeypatch
    ):
        """An expired snooze is active again instead of remaining hidden."""
        from django.utils import timezone

        from plane.db.models import InboxTodoState

        object_id = "66666666-6666-6666-6666-666666666667"
        todo = make_todo(object_id)
        InboxTodoState.objects.create(
            workspace=workspace,
            receiver=create_user,
            source="CHAIN_TASK",
            object_id=object_id,
            dedupe_key=f"todo:CHAIN_TASK:{object_id}",
            payload_hash=todo_payload_hash(todo),
            snoozed_till=timezone.now() - timedelta(hours=1),
        )
        monkeypatch.setattr(
            "plane.app.services.inbox.collect_inbox_todos",
            lambda workspace, user: ([todo], []),
        )

        active_response = session_client.get(inbox_url(workspace))
        snoozed_response = session_client.get(inbox_url(workspace), {"snoozed": "true"})
        bulk_response = session_client.post(inbox_url(workspace, "mark-all-read/"))

        assert active_response.status_code == status.HTTP_200_OK
        assert active_response.json()["unread_counts"]["total_unread_count"] == 1
        assert snoozed_response.json()["total_count"] == 0
        assert bulk_response.status_code == status.HTTP_200_OK
        assert bulk_response.json()["unread_counts"]["total_unread_count"] == 0

    @pytest.mark.parametrize("snoozed_till", [None, "2020-01-01T00:00:00+00:00"])
    def test_snooze_requires_future_timestamp(self, session_client, workspace, create_user, monkeypatch, snoozed_till):
        """Missing or historical snooze values are rejected."""
        object_id = "77777777-7777-7777-7777-777777777777"
        monkeypatch.setattr(
            "plane.app.services.inbox.collect_inbox_todos",
            lambda workspace, user: ([make_todo(object_id)], []),
        )
        session_client.get(inbox_url(workspace))

        response = session_client.post(
            inbox_url(workspace, f"items/todo:CHAIN_TASK:{object_id}/snooze/"),
            data={"snoozed_till": snoozed_till} if snoozed_till else {},
            format="json",
        )

        assert response.status_code == status.HTTP_400_BAD_REQUEST

    def test_due_todo_reminder_is_idempotent_and_respects_snooze(self, workspace, create_user, monkeypatch):
        """A due reminder reopens one item once and honors active snooze state."""
        from plane.db.models import InboxTodoState

        object_id = "88888888-8888-8888-8888-888888888888"
        now = datetime(2026, 10, 26, 4, tzinfo=datetime_timezone.utc)
        todo = make_todo(
            object_id,
            due_at="2026-10-26T12:00:00+00:00",
            urgency="DUE_TODAY",
        )
        monkeypatch.setattr(
            "plane.app.services.inbox.collect_inbox_todos",
            lambda workspace, user: ([todo], []),
        )
        state = InboxTodoState.objects.create(
            workspace=workspace,
            receiver=create_user,
            source="CHAIN_TASK",
            object_id=object_id,
            dedupe_key=f"todo:CHAIN_TASK:{object_id}",
            payload_hash=todo_payload_hash(todo),
            read_at=now,
        )

        first_count = generate_inbox_todo_reminders(workspace, create_user, now=now)
        state.refresh_from_db()
        first_key = state.last_reminder_key
        second_count = generate_inbox_todo_reminders(workspace, create_user, now=now)

        assert first_count == 1
        assert state.read_at is None
        assert first_key == f"todo:CHAIN_TASK:{object_id}:reminder:due_today:2026-10-26"
        assert second_count == 0

        state.read_at = now
        state.snoozed_till = now + timedelta(days=1)
        state.save(update_fields=["read_at", "snoozed_till", "updated_at"])
        third_count = generate_inbox_todo_reminders(workspace, create_user, now=now)

        assert third_count == 0

    def test_notification_fallback_reports_todo_degradation(self, session_client, workspace, create_user, monkeypatch):
        """Notifications remain available when todo collection fails."""
        create_research_notification(workspace, create_user, create_user)

        def collect(_workspace, _user):
            """Raise a collector failure for degradation handling."""
            raise RuntimeError("collector unavailable")

        monkeypatch.setattr("plane.app.services.inbox.collect_inbox_todos", collect)
        response = session_client.get(inbox_url(workspace))

        assert response.status_code == status.HTTP_200_OK
        assert response.json()["degraded_sources"] == ["RESEARCH_TODOS"]
        assert response.json()["results"][0]["kind"] == "notification"

    def test_report_comment_mention_is_categorized_as_mention(
        self, session_client, workspace, create_user, monkeypatch
    ):
        """A user mentioned in a report comment appears in the mentions tab."""
        monkeypatch.setattr(
            "plane.app.services.inbox.collect_inbox_todos",
            lambda workspace, user: ([], []),
        )
        actor = User.objects.create(
            email="report-comment-actor@plane.so",
            username="report_comment_actor",
            first_name="Comment",
            last_name="Actor",
        )
        page = Page.objects.create(
            workspace=workspace,
            name="2026-W44 mention report",
            owned_by=create_user,
            created_by=actor,
        )
        report = PeriodicReport.objects.create(
            workspace=workspace,
            owner=create_user,
            page=page,
            report_type=PeriodicReport.ReportType.WEEKLY,
            period_key="2026-W44",
            period_start=date(2026, 10, 26),
            period_end=date(2026, 11, 1),
            status=PeriodicReport.Status.SUBMITTED,
            created_by=actor,
        )
        thread = PeriodicReportCommentThread.objects.create(
            report=report,
            snapshot_version=1,
            content_hash="mention-test",
            created_by=create_user,
        )
        comment = PeriodicReportComment.objects.create(
            thread=thread,
            actor=actor,
            comment_html=(
                f'<mention-component entity_name="user_mention" entity_identifier="{create_user.id}">'
                "</mention-component>"
            ),
            comment_stripped="@Test User",
            request_id="inbox-mention-test",
        )

        notify_report_comment(report, thread, comment, actor, action="created")
        response = session_client.get(inbox_url(workspace), {"tab": "mentions"})
        payload = response.json()

        assert response.status_code == status.HTTP_200_OK
        assert payload["unread_counts"]["mention_unread_count"] == 1
        assert payload["results"][0]["category"] == "mention"
