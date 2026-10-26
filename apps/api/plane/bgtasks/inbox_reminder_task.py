# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Scheduled reminder generation for the unified workspace inbox."""

import logging

from celery import shared_task

from plane.app.services.inbox import generate_inbox_todo_reminders
from plane.db.models import WorkspaceMember

logger = logging.getLogger("plane.api")


@shared_task
def generate_workspace_inbox_reminders():
    """Reopen due todo inbox items for every active workspace member.

    Returns:
        A summary containing processed membership and applied reminder counts.
    """
    processed = 0
    applied = 0
    memberships = (
        WorkspaceMember.objects.filter(
            is_active=True,
            deleted_at__isnull=True,
            member__is_active=True,
        )
        .exclude(member__is_bot=True)
        .select_related("workspace", "member")
    )
    for membership in memberships.iterator(chunk_size=200):
        processed += 1
        try:
            applied += generate_inbox_todo_reminders(membership.workspace, membership.member)
        except Exception as error:
            logger.exception(
                "Unified inbox reminder generation failed",
                extra={
                    "event": "unified_inbox_reminder_failed",
                    "workspace_id": str(membership.workspace_id),
                    "user_id": str(membership.member_id),
                    "exception_type": type(error).__name__,
                },
            )
    return {"processed_members": processed, "applied_reminders": applied}
