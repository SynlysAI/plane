"""Agent Dock background event reconciliation tests."""

import pytest
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

    assert result == {"processed": 1}
    sd_session.refresh_from_db()
    assert sd_session.status == ResearchAgentSession.Status.READY
    assert sd_session.run_events.filter(event_type="OUTPUT").exists()
