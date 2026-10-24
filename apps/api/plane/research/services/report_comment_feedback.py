"""Construction and authorization of explicit report-comment HITL feedback."""

import hashlib
from datetime import datetime

from django.utils import timezone

from plane.research.utils.report_comment_anchors import canonical_json


FEEDBACK_SCHEMA_VERSION = "research.report.feedback.v1"


def build_feedback_payload(
    *,
    report,
    thread,
    comment,
    snapshot,
    submitted_by,
    submitted_at: datetime,
    agent_session=None,
) -> tuple[dict, str]:
    """Build the immutable context exposed to the existing Agent plugin.

    Args:
        report: Report owning the discussion.
        thread: Anchored comment thread.
        comment: Explicitly submitted human comment.
        snapshot: Immutable formal report snapshot.
        submitted_by: User who pressed the explicit feedback action.
        submitted_at: Timestamp stored with the feedback record.
        agent_session: Optional existing Agent session linked to this report.

    Returns:
        A ``(payload, sha256_hash)`` tuple for persistence.
    """
    payload = {
        "schema_version": FEEDBACK_SCHEMA_VERSION,
        "feedback_type": comment.feedback_type,
        "source": "REPORT_COMMENT_UI",
        "report": {
            "id": str(report.id),
            "workspace_id": str(report.workspace_id),
            "workspace_slug": report.workspace.slug,
            "project_id": str(report.project_id) if report.project_id else None,
            "period_key": report.period_key,
            "report_type": report.report_type,
            "status": report.status,
            "snapshot_version": snapshot.version_no,
            "content_hash": thread.content_hash,
            "source_url": f"/{report.workspace.slug}/research/reports/{report.id}/",
        },
        "quote": {
            "text": thread.quoted_text,
            "anchor": thread.anchor,
        },
        "thread": {
            "id": str(thread.id),
            "status": thread.status,
            "created_at": thread.created_at.isoformat(),
        },
        "comment": {
            "id": str(comment.id),
            "html": comment.comment_html,
            "text": comment.comment_stripped,
            "actor_id": str(comment.actor_id),
            "created_at": comment.created_at.isoformat(),
            "edited_at": comment.edited_at.isoformat() if comment.edited_at else None,
        },
        "submitted_by": {
            "id": str(submitted_by.id),
            "display_name": submitted_by.display_name or submitted_by.username,
        },
        "submitted_at": submitted_at.isoformat(),
        "agent_session": (
            {
                "id": str(agent_session.session_id),
                "run_id": str(agent_session.run_id),
                "provider": agent_session.provider,
            }
            if agent_session is not None
            else None
        ),
    }
    serialized = canonical_json(payload)
    return payload, hashlib.sha256(serialized.encode("utf-8")).hexdigest()


def session_allows_report(session, report, snapshot_version: int) -> bool:
    """Check whether an Agent session was granted this exact report version.

    Args:
        session: Existing ResearchAgentSession.
        report: Report referenced by the feedback.
        snapshot_version: Formal snapshot version stored on the thread.

    Returns:
        True only when workspace and pinned report/version both match.
    """
    if session is None or session.workspace_id != report.workspace_id:
        return False
    context_grant = session.context_grant
    if context_grant.revoked_at is not None or context_grant.expires_at <= timezone.now():
        return False
    return any(
        str(item.get("report_id")) == str(report.id) and int(item.get("version_no") or 0) == snapshot_version
        for item in session.context_grant.allowed_reports
    )
