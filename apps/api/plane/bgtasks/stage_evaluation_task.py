"""Background reconciliation for research-chain stage evaluations."""

import logging

from celery import shared_task

from plane.db.models import ResearchChainStageEvaluation
from plane.research.services.stage_evaluations import refresh_stage_evaluation

_LOGGER = logging.getLogger(__name__)


@shared_task
def reconcile_stage_evaluations() -> dict:
    """Pull terminal Agent events for active stage-three evaluations."""
    evaluations = ResearchChainStageEvaluation.objects.select_related(
        "stage__workspace",
        "stage__chain",
        "agent_session",
    ).filter(status=ResearchChainStageEvaluation.Status.RUNNING)[:100]
    processed = failed = 0
    for evaluation in evaluations:
        try:
            refreshed = refresh_stage_evaluation(evaluation)
            failed += int(refreshed.status == ResearchChainStageEvaluation.Status.FAILED)
            processed += 1
        except Exception:
            failed += 1
            _LOGGER.exception("Stage evaluation reconciliation failed id=%s", evaluation.pk)
    return {"processed": processed, "failed": failed}
