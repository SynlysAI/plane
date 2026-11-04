"""Agent Dock background reconciliation tasks."""

from celery import shared_task

from plane.db.models import ResearchAgentSession
from plane.research.services.agent_dock_sessions import sync_agent_dock_events
from plane.research.services.agent_runtime import resolve_synlora_runtime


@shared_task
def reconcile_agent_dock_runs() -> dict:
    """Pull terminal Synlora events for active runs whose browser may be offline.

    Returns:
        A count summary for monitoring and Celery logs.
    """
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
        .order_by("updated_at")[:100]
    )
    processed = 0
    for session in sessions:
        runtime = resolve_synlora_runtime(session.workspace, user=session.user)
        if runtime is None:
            continue
        sync_agent_dock_events(workspace=session.workspace, session=session, runtime=runtime)
        processed += 1
    return {"processed": processed}
