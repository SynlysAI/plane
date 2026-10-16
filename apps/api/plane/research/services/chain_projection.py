"""Project stable runtime events into Agent and Chain append-only facts."""

from django.db import transaction
from django.utils import timezone

from plane.db.models import ResearchAgentRunEvent, ResearchAgentSession, ResearchChainEvent
from plane.research.services.idempotency import payload_hash

# ScienceDiscovery -> Plane 事件映射（§7 对照表）。agent/chain 两层仅在 run.cancelled 有差异：
# Agent 侧展示为 DEGRADED（回答被中止），Chain 侧留痕为 HUMAN_DECISION（用户主动取消）。
SCIENCE_DISCOVERY_AGENT_EVENT_TYPE_MAP = {
    "run.started": "AI_ACTION",
    "run.queued": "AI_ACTION",
    "run.status": "AI_ACTION",
    "run.history.truncated": "AI_ACTION",
    "assistant.delta": "OUTPUT",
    "assistant.snapshot": "OUTPUT",
    "assistant.thinking.delta": "AI_ACTION",
    "assistant.thinking.snapshot": "AI_ACTION",
    "assistant.response.started": "AI_ACTION",
    "assistant.response.settled": "AI_ACTION",
    "agent.phase": "AI_ACTION",
    "tool.started": "TOOL_CALL",
    "tool.output": "TOOL_CALL",
    "tool.completed": "TOOL_CALL",
    "permission.required": "APPROVAL",
    "permission.resolved": "HUMAN_DECISION",
    "plan.updated": "AI_ACTION",
    "workspace.changed": "DATA_CHANGE",
    "artifact.upserted": "INTERMEDIATE_ARTIFACT",
    "model.usage": "AI_ACTION",
    "subagent.updated": "AI_ACTION",
    "subagent.step": "AI_ACTION",
    "subagent.usage": "AI_ACTION",
    "run.completed": "OUTPUT",
    "run.failed": "DEGRADED",
    "run.cancelled": "DEGRADED",
}
SCIENCE_DISCOVERY_CHAIN_EVENT_TYPE_MAP = {
    **SCIENCE_DISCOVERY_AGENT_EVENT_TYPE_MAP,
    "run.cancelled": "HUMAN_DECISION",
}

# SD run 终态 -> Plane 会话状态（§6.1 状态收敛）。
SCIENCE_DISCOVERY_TERMINAL_SESSION_STATUS = {
    "run.completed": ("READY", ""),
    "run.failed": ("DEGRADED", "science_discovery_run_failed"),
    "run.cancelled": ("READY", "science_discovery_run_cancelled"),
}



def _science_discovery_payload(remote_type, event):
    """Translate one SD ``RunStreamEvent`` body into the frontend payload shape.

    Args:
        remote_type: The SD event ``type`` discriminator.
        event: The SD event object without its ``type`` field.

    Returns:
        A dict whose ``content``/``reasoning`` keys the Agent UI already reads.
    """
    payload = {key: value for key, value in event.items() if key != "type"}
    if remote_type == "assistant.delta":
        payload.setdefault("content", payload.pop("delta", ""))
    elif remote_type == "assistant.snapshot":
        payload.setdefault("content", payload.pop("content", ""))
    elif remote_type == "assistant.thinking.delta":
        payload.setdefault("reasoning", payload.pop("delta", ""))
    elif remote_type == "assistant.thinking.snapshot":
        payload.setdefault("reasoning", payload.pop("content", ""))
    elif remote_type == "run.completed":
        message = payload.get("message") if isinstance(payload.get("message"), dict) else {}
        payload.setdefault("content", str(message.get("content") or ""))
    elif remote_type == "run.failed":
        payload.setdefault("content", str(payload.get("error") or "ScienceDiscovery run failed."))
    elif remote_type == "run.cancelled":
        payload.setdefault("content", "Run cancelled by the user.")
    elif remote_type == "permission.required":
        request = payload.get("request") if isinstance(payload.get("request"), dict) else {}
        payload["requires_approval"] = True
        payload.setdefault("summary", str(request.get("summary") or "ScienceDiscovery approval required."))
    return payload


def project_science_discovery_events(session, remote_events, *, source_system="SCIENCE_DISCOVERY"):
    """Deduplicate SD events by cursor and append local immutable facts.

    Args:
        session: The visible Plane Agent session pinned to the SD provider.
        remote_events: SD events in ``[{sequence, event: {type, ...}}]`` shape.

    Returns:
        Newly created or existing local Agent run events in cursor order.
    """
    projected = []
    with transaction.atomic():
        locked_session = ResearchAgentSession.objects.select_for_update().get(pk=session.pk)
        for remote in remote_events:
            remote_seq = int(remote.get("sequence") or 0)
            event = remote.get("event") if isinstance(remote.get("event"), dict) else {}
            remote_type = str(event.get("type") or "")
            remote_key = locked_session.sd_session_id or locked_session.synlora_session_id or str(locked_session.id)
            request_id = f"run:{remote_key}:{remote_seq}"
            local = ResearchAgentRunEvent.objects.filter(request_id=request_id).first()
            if local is None:
                next_seq = (
                    ResearchAgentRunEvent.objects.filter(run_id=locked_session.run_id)
                    .order_by("-seq")
                    .values_list("seq", flat=True)
                    .first()
                    or 0
                ) + 1
                agent_type = SCIENCE_DISCOVERY_AGENT_EVENT_TYPE_MAP.get(remote_type, "AI_ACTION")
                local = ResearchAgentRunEvent.objects.create(
                    session=locked_session,
                    run_id=locked_session.run_id,
                    seq=next_seq,
                    event_type=agent_type,
                    payload={
                        **_science_discovery_payload(remote_type, event),
                        "remote_seq": remote_seq,
                        "remote_type": remote_type,
                    },
                    request_id=request_id,
                )
                chain_type = SCIENCE_DISCOVERY_CHAIN_EVENT_TYPE_MAP.get(remote_type, "AI_ACTION")
                chain_request_id = f"chain:{request_id}"
                ResearchChainEvent.objects.create(
                    chain=locked_session.chain_node.chain,
                    node=locked_session.chain_node,
                    event_id=payload_hash({"request_id": chain_request_id}),
                    request_id=chain_request_id,
                    actor=locked_session.user,
                    actor_type="USER",
                    source_system=source_system,
                    event_type=chain_type,
                    occurred_at=timezone.now(),
                    refs=[{"kind": "agent_event", "id": str(local.id), "seq": remote_seq}],
                    summary=remote_type or chain_type,
                    content_hash=payload_hash(remote),
                )
            projected.append(local)
            terminal = SCIENCE_DISCOVERY_TERMINAL_SESSION_STATUS.get(remote_type)
            if terminal is not None and locked_session.status not in (
                ResearchAgentSession.Status.CLOSED,
            ):
                locked_session.status = terminal[0]
                locked_session.last_error = terminal[1]
                locked_session.save(update_fields=["status", "last_error", "updated_at"])
            elif remote_type == "permission.resolved" and locked_session.status not in (
                ResearchAgentSession.Status.CLOSED,
                ResearchAgentSession.Status.READY,
                ResearchAgentSession.Status.DEGRADED,
                ResearchAgentSession.Status.ERROR,
            ):
                # 审批已有结论：run 继续执行，回到 STREAMING 由轮询推进到终态。
                locked_session.status = ResearchAgentSession.Status.STREAMING
                locked_session.last_error = ""
                locked_session.save(update_fields=["status", "last_error", "updated_at"])
        # 审批等待是唯一非终态的暂停点：置为 WAITING_APPROVAL 以驱动前端审批交互。
        if projected and str(projected[-1].payload.get("remote_type") or "") == "permission.required":
            locked_session.status = ResearchAgentSession.Status.WAITING_APPROVAL
            locked_session.last_error = ""
            locked_session.save(update_fields=["status", "last_error", "updated_at"])
    return projected
