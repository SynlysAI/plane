"""Dock 的 SD 事件归一化与待审批集合。"""

import json


def pending_sd_permissions(events):
    """按持久事件顺序还原尚未处理的 SD 审批。

    Args:
        events: 按本地 seq 升序排列的当前 run 事件。

    Returns:
        以 permission request ID 为键的待审批请求。
    """
    pending = {}
    for event in events:
        payload = event.payload or {}
        remote_type = str(payload.get("remote_type") or "")
        request = payload.get("request") if isinstance(payload.get("request"), dict) else {}
        request_id = str(request.get("id") or payload.get("permission_request_id") or payload.get("requestId") or "")
        if remote_type == "permission.required" and request_id:
            pending[request_id] = request
        elif remote_type == "permission.resolved":
            pending.pop(request_id, None)
        elif remote_type in {"run.completed", "run.failed", "run.cancelled"}:
            pending.clear()
    return pending


def sd_event_envelope(event):
    """统一 SD 实时与历史事件，保留审批身份和无 trace 的工具输出。

    Args:
        event: 已脱敏的本地事件。

    Returns:
        agent-dock-event.v1 标准封装。
    """
    payload = dict(event.payload or {})
    remote_type = str(payload.get("remote_type") or "")
    event_type = {
        "assistant.delta": "output.delta",
        "assistant.snapshot": "output.delta",
        "permission.required": "approval.required",
        "permission.resolved": "approval.resolved",
        "assistant.thinking.delta": "run.progress",
        "assistant.thinking.snapshot": "run.progress",
        "agent.phase": "run.progress",
    }.get(remote_type, remote_type or {"USER_MESSAGE": "user.message"}.get(event.event_type, "run.progress"))
    if remote_type == "assistant.snapshot":
        payload["final"] = True
    if remote_type.startswith("assistant.thinking"):
        payload = {"phase": "thinking"}
    if remote_type.startswith("permission."):
        request = payload.get("request") if isinstance(payload.get("request"), dict) else {}
        payload.update(
            permission_request_id=str(request.get("id") or payload.get("requestId") or ""),
            tool_call_id=str(request.get("toolCallId") or payload.get("tool_call_id") or ""),
            tool=str(request.get("action") or payload.get("tool") or ""),
            summary=str(request.get("summary") or payload.get("summary") or ""),
            resource=str(request.get("resource") or ""),
            args_preview=str(request.get("resource") or payload.get("args_preview") or ""),
        )
    if remote_type.startswith("tool."):
        trace = payload.get("trace") if isinstance(payload.get("trace"), dict) else {}
        chunk = payload.get("chunk")
        payload.update(
            tool_call_id=str(trace.get("id") or payload.get("toolCallId") or ""),
            result=trace.get("summary", trace.get("output", chunk if chunk is not None else "")),
            status=trace.get("status", "running" if remote_type == "tool.output" else ""),
        )
        if trace.get("name"):
            payload["name"] = str(trace["name"])
        if "args" in trace or "input" in trace:
            payload["arguments"] = trace.get("args", trace.get("input"))
        if isinstance(payload["result"], (dict, list)):
            payload["result"] = json.dumps(payload["result"], ensure_ascii=False)
    return {
        "schema_version": "agent-dock-event.v1",
        "run_id": str(event.run_id),
        "seq": event.seq,
        "source_seq": int((event.payload or {}).get("remote_seq") or 0),
        "event_type": event_type,
        "raw_event_type": remote_type,
        "payload": payload,
        "request_id": event.request_id,
        "created_at": event.created_at.isoformat(),
    }


def serialize_dock_events(events, provider):
    """为 Dock JSON 回放补充标准事件名，同时兼容既有持久事件字段。

    Args:
        events: 待序列化的本地事件。
        provider: 固定的会话后端。

    Returns:
        可直接用于统一回放的 JSON 事件列表。
    """
    from plane.research.serializers import ResearchAgentRunEventSerializer

    if provider != "SCIENCE_DISCOVERY":
        return ResearchAgentRunEventSerializer(events, many=True).data
    result = []
    for event in events:
        envelope = sd_event_envelope(event)
        result.append({**envelope, "normalized_event_type": envelope["event_type"], "event_type": event.event_type})
    return result
