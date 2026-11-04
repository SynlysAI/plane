"""Agent Dock background event reconciliation tests."""

import pytest
from django.core.cache import cache
from plane.db.models import ResearchAgentSession
from plane.bgtasks.agent_dock_task import reconcile_agent_dock_runs

pytestmark = pytest.mark.django_db


def test_reconcile_active_synlora_runs_after_sse_disconnect(sd_session, monkeypatch):
    """Celery 补拉 durable events，使浏览器断开后的 run 收敛到终态。"""
    sd_session.provider = ResearchAgentSession.Provider.SYNLORA
    sd_session.synlora_session_id = "synlora-session-1"
    sd_session.synlora_run_id = "synlora-run-1"
    sd_session.status = ResearchAgentSession.Status.STREAMING
    sd_session.save(update_fields=["provider", "synlora_session_id", "synlora_run_id", "status"])

    class FakeRuntime:
        def pull_events(self, *, session_id, after_seq=-1):
            assert session_id == "synlora-session-1"
            return (
                [
                    {
                        "sequence": 1,
                        "event": {"type": "run.started", "remote_run_id": "synlora-run-1"},
                    },
                    {
                        "sequence": 2,
                        "event": {"type": "run.completed", "remote_run_id": "synlora-run-1"},
                    },
                ],
                2,
                "completed",
            )

    from plane.bgtasks import agent_dock_task

    monkeypatch.setattr(agent_dock_task, "resolve_synlora_runtime", lambda *_args, **_kwargs: FakeRuntime())

    result = reconcile_agent_dock_runs()

    assert result == {"processed": 1, "succeeded": 1, "failed": 0, "skipped": 0, "stale": 0}
    sd_session.refresh_from_db()
    assert sd_session.status == ResearchAgentSession.Status.READY
    assert sd_session.run_events.filter(event_type="OUTPUT").exists()


def test_reconciliation_task_is_registered_with_celery():
    """Django app ready 阶段必须注册 Agent Dock 周期任务。"""
    from django.apps import apps
    from plane.celery import app

    apps.get_app_config("bgtasks").ready()

    assert "plane.bgtasks.agent_dock_task.reconcile_agent_dock_runs" in app.tasks


def test_reconciliation_isolates_failure_and_cache_lock(sd_session, monkeypatch):
    """单 session 异常不阻断任务；cache lock 防止重复处理。"""
    sd_session.provider = ResearchAgentSession.Provider.SYNLORA
    sd_session.synlora_session_id = "synlora-session-failure"
    sd_session.status = ResearchAgentSession.Status.STREAMING
    sd_session.save(update_fields=["provider", "synlora_session_id", "status"])
    calls = []

    def failing_sync(**_kwargs):
        calls.append(True)
        raise RuntimeError("synlora transient failure")

    from plane.bgtasks import agent_dock_task

    monkeypatch.setattr(agent_dock_task, "resolve_synlora_runtime", lambda *_args, **_kwargs: object())
    monkeypatch.setattr(agent_dock_task, "sync_agent_dock_events", failing_sync)

    first = reconcile_agent_dock_runs()
    second = reconcile_agent_dock_runs()

    assert first == {"processed": 1, "succeeded": 0, "failed": 1, "skipped": 0, "stale": 0}
    assert second["skipped"] == 1
    assert len(calls) == 1
