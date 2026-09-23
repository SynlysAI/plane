"""Project stable Synlora events into Agent and Chain append-only facts."""

from django.db import transaction
from django.utils import timezone

from plane.db.models import ResearchAgentRunEvent, ResearchAgentSession, ResearchChainEvent
from plane.research.services.idempotency import payload_hash

EVENT_TYPE_MAP = {
    "turn/start": "AI_ACTION",
    "user/message": "COMMUNICATION",
    "assistant/message": "OUTPUT",
    "assistant/reasoning": "AI_ACTION",
    "tool/call": "TOOL_CALL",
    "tool/result": "TOOL_CALL",
    "ask/user": "HUMAN_DECISION",
    "file/send": "INTERMEDIATE_ARTIFACT",
    "turn/end": "OUTPUT",
    "turn/aborted": "DEGRADED",
    "session/compaction": "AI_ACTION",
    "error": "DEGRADED",
}


def project_synlora_events(session, remote_events):
    """Deduplicate by remote cursor and append local immutable facts.

    Args:
        session: The visible Plane Agent session.
        remote_events: Synlora events in ``[{seq, type, payload, ts}]`` shape.

    Returns:
        Newly created or existing local Agent run events in cursor order.
    """
    projected = []
    with transaction.atomic():
        locked_session = ResearchAgentSession.objects.select_for_update().get(pk=session.pk)
        for remote in remote_events:
            remote_seq = int(remote.get("seq") or 0)
            request_id = f"synlora:{locked_session.synlora_session_id}:{remote_seq}"
            local = ResearchAgentRunEvent.objects.filter(request_id=request_id).first()
            if local is None:
                next_seq = (
                    ResearchAgentRunEvent.objects.filter(run_id=locked_session.run_id)
                    .order_by("-seq")
                    .values_list("seq", flat=True)
                    .first()
                    or 0
                ) + 1
                remote_payload = remote.get("payload") if isinstance(remote.get("payload"), dict) else {}
                local = ResearchAgentRunEvent.objects.create(
                    session=locked_session,
                    run_id=locked_session.run_id,
                    seq=next_seq,
                    event_type=str(remote.get("type") or "AI_ACTION"),
                    payload={
                        **remote_payload,
                        "remote_seq": remote_seq,
                        "remote_type": remote.get("type"),
                    },
                    request_id=request_id,
                )
                chain_type = EVENT_TYPE_MAP.get(str(remote.get("type")), "AI_ACTION")
                chain_request_id = f"chain:{request_id}"
                ResearchChainEvent.objects.create(
                    chain=locked_session.chain_node.chain,
                    node=locked_session.chain_node,
                    event_id=payload_hash({"request_id": chain_request_id}),
                    request_id=chain_request_id,
                    actor=locked_session.user,
                    actor_type="USER",
                    source_system="SYNLORA",
                    event_type=chain_type,
                    occurred_at=timezone.now(),
                    refs=[{"kind": "agent_event", "id": str(local.id), "seq": remote_seq}],
                    summary=str(remote.get("type") or chain_type),
                    content_hash=payload_hash(remote),
                )
            projected.append(local)
    return projected
