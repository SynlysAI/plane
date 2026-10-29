# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Report notifications built on the existing notification pipeline.

No new delivery channel is introduced: rows land in the shared
``Notification`` table with ``entity_name = research_report`` so the existing
notification centre and email fan-out keep working (P0-RPT-12, P0-APR-06).
"""

from django.utils import timezone
from bs4 import BeautifulSoup
from uuid import UUID

from plane.db.models import Notification
from plane.research.utils.acl import build_actor_context, check_access, direct_advisor_ids, org_unit_scope_ids
from plane.research.utils.reports import report_resource

RESEARCH_REPORT_ENTITY = "research_report"
RESEARCH_APPROVAL_ENTITY = "research_approval"


def _notify(report, receivers, *, actor, title, message, mentioned_ids=None):
    """Create report notifications while preserving mention classification.

    Args:
        report: Report owning the notification.
        receivers: ACL-filtered users allowed to see the update.
        actor: User who triggered the report event.
        title: Short notification title.
        message: JSON payload used by in-app and email rendering.
        mentioned_ids: String user IDs explicitly mentioned by a comment.

    Returns:
        The created notification rows.
    """
    created = []
    mentions = mentioned_ids or set()
    for receiver in receivers:
        if receiver is None or receiver == actor:
            continue
        sender = "research:mentioned" if str(receiver.id) in mentions else "research"
        created.append(
            Notification(
                workspace_id=report.workspace_id,
                project_id=report.project_id,
                data={
                    "report_id": str(report.id),
                    "action": message.get("action"),
                    "period_key": report.period_key,
                    "report_type": report.report_type,
                    "status": report.status,
                },
                entity_identifier=report.id,
                entity_name=RESEARCH_REPORT_ENTITY,
                title=title,
                message=message,
                message_html=f"<p>{title}</p>",
                message_stripped=title,
                sender=sender,
                triggered_by=actor,
                receiver=receiver,
            )
        )
    if created:
        Notification.objects.bulk_create(created, batch_size=100)
    return created


def report_reviewer_ids(report):
    """Direct advisors plus the managing roles of the report's node."""
    from plane.db.models import OrgUnitMember, User

    receiver_ids = set(direct_advisor_ids(report.owner_id, report.workspace_id, report.org_unit_id))
    scope = org_unit_scope_ids(report.org_unit_id, report.workspace_id)
    if scope:
        receiver_ids |= set(
            OrgUnitMember.objects.filter(
                workspace_id=report.workspace_id,
                org_unit_id__in=scope,
                org_role__in=("PI", "OWNER", "UNIT_ADMIN"),
                deleted_at__isnull=True,
            ).values_list("user_id", flat=True)
        )
    receiver_ids.discard(report.owner_id)
    return list(User.objects.filter(id__in=receiver_ids, is_active=True))


def notify_report_submitted(report, actor, route=None):
    """Notify the routed reviewer and optional carbon-copy readers."""
    if route is None:
        return _notify(
            report,
            report_reviewer_ids(report),
            actor=actor,
            title=f"{report.period_key} 报告已提交",
            message={
                "action": "submitted",
                "period_key": report.period_key,
                "owner": str(report.owner_id),
                "submitted_at": timezone.now().isoformat(),
            },
        )

    from plane.research.services.approval_routes import route_users

    reviewers, cc_users = route_users(route)
    return [
        *_notify(
            report,
            reviewers,
            actor=actor,
            title=f"{report.period_key} 报告已提交",
            message={
                "action": "submitted",
                "period_key": report.period_key,
                "owner": str(report.owner_id),
                "submitted_at": timezone.now().isoformat(),
            },
        ),
        *_notify(
            report,
            cc_users,
            actor=actor,
            title=f"{report.period_key} 报告提交抄送",
            message={
                "action": "submitted.cc",
                "period_key": report.period_key,
                "owner": str(report.owner_id),
                "submitted_at": timezone.now().isoformat(),
            },
        ),
    ]


def notify_report_withdrawn(report, actor, comment="", route=None):
    """Notify reviewers that an author withdrew the current submission.

    Args:
        report: Report returned to draft for another editing round.
        actor: Report owner who withdrew the submission.
        comment: Optional reason supplied by the author.

    Returns:
        Created notification rows for the report's reviewer audience.
    """
    from plane.research.services.approval_routes import route_users

    reviewers, cc_users = route_users(route) if route is not None else ([], [])
    if route is None:
        reviewers = report_reviewer_ids(report)
    return [
        *_notify(
            report,
            reviewers,
            actor=actor,
            title=f"{report.period_key} 报告已撤回",
            message={
                "action": "withdrawn",
                "period_key": report.period_key,
                "owner": str(report.owner_id),
                "comment": comment[:500],
                "withdrawn_at": timezone.now().isoformat(),
            },
        ),
        *_notify(
            report,
            cc_users,
            actor=actor,
            title=f"{report.period_key} 报告撤回抄送",
            message={
                "action": "withdrawn.cc",
                "period_key": report.period_key,
                "owner": str(report.owner_id),
                "comment": comment[:500],
                "withdrawn_at": timezone.now().isoformat(),
            },
        ),
    ]


def notify_report_returned(report, actor, comment="", route=None):
    from plane.db.models import User
    from plane.research.services.approval_routes import route_users

    owner = User.objects.filter(pk=report.owner_id, is_active=True).first()
    _reviewers, cc_users = route_users(route)
    return [
        *_notify(
            report,
            [owner] if owner else [],
            actor=actor,
            title=f"{report.period_key} 报告被退回",
            message={
                "action": "returned",
                "period_key": report.period_key,
                "comment": comment[:500],
                "reviewer": str(actor.id),
            },
        ),
        *_notify(
            report,
            cc_users,
            actor=actor,
            title=f"{report.period_key} 报告退回抄送",
            message={
                "action": "returned.cc",
                "period_key": report.period_key,
                "comment": comment[:500],
                "reviewer": str(actor.id),
            },
        ),
    ]


def notify_report_accepted(report, actor, route=None):
    from plane.db.models import User
    from plane.research.services.approval_routes import route_users

    owner = User.objects.filter(pk=report.owner_id, is_active=True).first()
    _reviewers, cc_users = route_users(route)
    return [
        *_notify(
            report,
            [owner] if owner else [],
            actor=actor,
            title=f"{report.period_key} 报告已验收",
            message={"action": "accepted", "period_key": report.period_key, "reviewer": str(actor.id)},
        ),
        *_notify(
            report,
            cc_users,
            actor=actor,
            title=f"{report.period_key} 报告验收抄送",
            message={"action": "accepted.cc", "period_key": report.period_key, "reviewer": str(actor.id)},
        ),
    ]


def mentioned_user_ids(comment_html) -> set:
    """Extract valid user mentions from sanitized report-comment HTML.

    Args:
        comment_html: Sanitized rich-text HTML submitted by a workspace member.

    Returns:
        A set of user IDs explicitly mentioned with ``entity_name=user_mention``.
    """
    identifiers = set()
    for node in BeautifulSoup(comment_html or "", "html.parser").find_all("mention-component"):
        if node.get("entity_name") != "user_mention":
            continue
        value = node.get("entity_identifier")
        try:
            identifiers.add(str(UUID(str(value))))
        except (ValueError, TypeError):
            continue
    return identifiers


def notify_report_comment(report, thread, comment, actor, *, action="created"):
    """Notify only report-visible participants and users mentioned in a comment.

    Args:
        report: The report owning the comment thread.
        thread: The persisted comment thread.
        comment: The newly created or updated comment.
        actor: The authenticated comment actor.
        action: One of ``created``, ``updated``, ``resolved``, or ``reopened``.

    Returns:
        The notifications created by the existing shared notification pipeline.
    """
    from plane.db.models import User

    receiver_ids = {report.owner_id, thread.created_by_id}
    receiver_ids.update(thread.comments.exclude(actor_id=actor.id).values_list("actor_id", flat=True))
    if action in {"created", "updated"}:
        receiver_ids.update(mentioned_user_ids(comment.comment_html))
    receiver_ids.discard(actor.id)
    users = User.objects.filter(id__in=receiver_ids, is_active=True)
    receivers = []
    for user in users:
        context = build_actor_context(user, report.workspace_id)
        if check_access(user, "view", report_resource(report), context=context):
            receivers.append(user)
    action_labels = {
        "created": "新批注",
        "updated": "批注更新",
        "resolved": "批注已解决",
        "reopened": "批注重新开放",
    }
    mentioned_ids = mentioned_user_ids(comment.comment_html) if action in {"created", "updated"} else set()
    return _notify(
        report,
        receivers,
        actor=actor,
        title=f"{report.period_key} 报告有{action_labels.get(action, '批注更新')}",
        message={
            "action": f"comment.{action}",
            "report_id": str(report.id),
            "thread_id": str(thread.id),
            "comment_id": str(comment.id),
            "snapshot_version": thread.snapshot_version,
            "quoted_text": thread.quoted_text[:500],
        },
        mentioned_ids=mentioned_ids,
    )
