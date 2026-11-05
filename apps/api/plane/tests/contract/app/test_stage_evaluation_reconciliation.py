"""Stage evaluation Celery reconciliation contracts."""

import pytest

from plane.bgtasks.stage_evaluation_task import reconcile_stage_evaluations

pytestmark = pytest.mark.contract


def test_stage_evaluation_task_is_registered():
    """The beat task must be importable by the Celery worker."""
    from plane.celery import app

    assert "plane.bgtasks.stage_evaluation_task.reconcile_stage_evaluations" in app.tasks


@pytest.mark.django_db
def test_stage_evaluation_reconciliation_handles_empty_queue():
    """An empty active queue is a successful no-op."""
    assert reconcile_stage_evaluations() == {"processed": 0, "failed": 0}
