"""Agent Dock background reconciliation tasks."""

import logging

from celery import shared_task
from django.core.cache import cache
from django.db.models import Q
from django.utils import timezone

from plane.db.models import ResearchAgentSession
from plane.research.services.agent_dock_sessions import sync_agent_dock_events
from plane.research.services.agent_runtime import resolve_synlora_runtime

_LOGGER = logging.getLogger(__name__)


@shared_task
def reconcile_agent_dock_runs() -> dict:
    """补拉浏览器离线期间两种 Dock 后端的运行事件。

    Returns:
        A count summary for monitoring and Celery logs.
    """
    stale_before = timezone.now() - timezone.timedelta(hours=24)
    pending_submission = Q(
        provider="SCIENCE_DISCOVERY", assembly__sd_submission__phase__in=["pending", "cancel_pending"],
    )
    sessions = (
        ResearchAgentSession.objects.select_related("workspace", "user")
        .filter(deleted_at__isnull=True)
        .filter(
            Q(status__in=["STREAMING", "WAITING_APPROVAL"])
            | pending_submission
        )
        .filter(
            Q(provider="SYNLORA", synlora_session_id__gt="")
            | Q(provider="SCIENCE_DISCOVERY", sd_session_id__gt="", assembly__persona="plane-agent-dock")
        )
    )
    stale = sessions.filter(updated_at__lt=stale_before).exclude(pending_submission).count()
    skipped = stale
    processed = succeeded = failed = 0
    candidates = sessions.filter(Q(updated_at__gte=stale_before) | pending_submission).order_by("updated_at")[:100]
    for session in candidates:
        lock_key = f"agent-dock-reconcile:{session.id}"
        if not cache.add(lock_key, "1", timeout=60):
            skipped += 1
            continue
        processed += 1
        try:
            runtime = (
                resolve_synlora_runtime(session.workspace, user=session.user)
                if session.provider == "SYNLORA" else None
            )
            if session.provider == "SYNLORA" and runtime is None:
                skipped += 1
                continue
            sync_agent_dock_events(
                workspace=session.workspace, session=session, runtime=runtime, raise_sync_errors=True,
            )
            succeeded += 1
        except Exception as exc:
            failed += 1
            # 轮转失败候选，避免结果未明的少数会话长期占满每批配额。
            ResearchAgentSession.objects.filter(pk=session.pk, run_id=session.run_id).update(updated_at=timezone.now())
            _LOGGER.warning(
                "Agent Dock reconciliation failed session=%s error_type=%s", session.pk, type(exc).__name__,
            )
    return {
        "processed": processed,
        "succeeded": succeeded,
        "failed": failed,
        "skipped": skipped,
        "stale": stale,
    }
