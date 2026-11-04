"""Agent Dock background reconciliation tasks."""

import logging

from celery import shared_task
from django.core.cache import cache
from django.utils import timezone

from plane.db.models import ResearchAgentSession
from plane.research.services.agent_dock_sessions import sync_agent_dock_events
from plane.research.services.agent_runtime import resolve_synlora_runtime

_LOGGER = logging.getLogger(__name__)


@shared_task
def reconcile_agent_dock_runs() -> dict:
    """Pull terminal Synlora events for active runs whose browser may be offline.

    Returns:
        A count summary for monitoring and Celery logs.
    """
    stale_before = timezone.now() - timezone.timedelta(hours=24)
    sessions = (
        ResearchAgentSession.objects.select_related("workspace", "user")
        .filter(
            provider=ResearchAgentSession.Provider.SYNLORA,
            status__in=[
                ResearchAgentSession.Status.STREAMING,
                ResearchAgentSession.Status.WAITING_APPROVAL,
            ],
            deleted_at__isnull=True,
            synlora_session_id__gt="",
        )
        .order_by("-updated_at")[:100]
    )
    processed = succeeded = failed = skipped = stale = 0
    for session in sessions:
        lock_key = f"agent-dock-reconcile:{session.id}"
        if not cache.add(lock_key, "1", timeout=15):
            skipped += 1
            continue
        processed += 1
        if session.updated_at < stale_before:
            stale += 1
            skipped += 1
            continue
        try:
            runtime = resolve_synlora_runtime(session.workspace, user=session.user)
            if runtime is None:
                skipped += 1
                continue
            sync_agent_dock_events(workspace=session.workspace, session=session, runtime=runtime)
            succeeded += 1
        except Exception:
            failed += 1
            _LOGGER.exception("Agent Dock reconciliation failed session=%s", session.pk)
    return {
        "processed": processed,
        "succeeded": succeeded,
        "failed": failed,
        "skipped": skipped,
        "stale": stale,
    }
