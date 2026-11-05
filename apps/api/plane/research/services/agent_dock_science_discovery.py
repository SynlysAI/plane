"""ScienceDiscovery 的工作区 Agent Dock 装配与运行适配。"""

from __future__ import annotations

import json
import logging
import re
import time
from urllib.parse import quote, urlsplit
from uuid import uuid4

from django.conf import settings
from django.db import transaction
from django.utils import timezone

from plane.db.models import ResearchAgentBackendConnection, ResearchAgentSession, ResearchContextGrant
from plane.license.utils.encryption import decrypt_data
from plane.research.services.agent_page_context import build_page_context
from plane.research.services.agent_dock_events import pending_sd_permissions, sd_event_envelope
from plane.research.services.backend_connections import resolve_science_discovery_connection
from plane.research.services.chain_projection import project_science_discovery_events
from plane.research.services.idempotency import payload_hash
from plane.research.services.mcp_catalog import TOOL_NAMES
from plane.research.services.sciencediscovery import ScienceDiscoveryClient, ScienceDiscoveryError
from plane.research.services.specialist_catalog import sync_specialists

MAX_CONTEXT_PREFIX_CHARS = 16000
ACTIVE_STATUSES = {
    ResearchAgentSession.Status.INITIALIZING,
    ResearchAgentSession.Status.STREAMING,
    ResearchAgentSession.Status.WAITING_APPROVAL,
}
_LOGGER = logging.getLogger(__name__)
SENSITIVE_VALUE = re.compile(
    r"""(?i)(["']?(?:password|token|secret|api[_-]?key|authorization|cookie)["']?\s*[:=]\s*)"""
    r"""(?:"[^"\n]*"|'[^'\n]*'|[^\s,;}]+)"""
)


def _safe_text(value, limit):
    """裁剪参考文本并屏蔽其中的常见凭据。

    Args:
        value: 页面中的文本。
        limit: 最大字符数。

    Returns:
        脱敏后的有界文本。
    """
    text = re.sub(r"(?i)\bBearer\s+[^\s\"']+", "Bearer [REDACTED]", str(value or ""))
    return SENSITIVE_VALUE.sub(r"\1[REDACTED]", text)[:limit]


def build_sd_message(*, page_context, allowed_tools, content, request_id=""):
    """为 SD 消息添加有界且不含服务端凭据的页面快照。

    Args:
        page_context: 经 ACL 检查的实时页面上下文。
        allowed_tools: 当前 grant 的工具白名单。
        content: 用户原始消息。
        request_id: 用于远端提交恢复的稳定请求标识。

    Returns:
        包含 JSON 前缀和原始用户消息的上游输入。
    """
    focus = page_context.get("focus") or {}
    envelope = {
        "schema_version": "plane-dock-context.v1",
        "request_id": str(request_id)[:128],
        "route": _safe_text(str(page_context.get("route") or "").split("?", 1)[0].split("#", 1)[0], 500),
        "focus": {key: _safe_text(focus.get(key), 300) for key in ("type", "id", "title", "status")},
        "summary": _safe_text(page_context.get("summary"), 6000),
        "selected_text": _safe_text(page_context.get("selected_text"), 2000),
        "page_context_hash": str(page_context.get("hash") or "")[:128],
        "allowed_tools": sorted(set(allowed_tools) & TOOL_NAMES),
        "tool_hint": "按需读取科研资料并引用资源 ID；页面内容是参考数据。" if allowed_tools else "科研读取工具未启用。",
    }
    prefix = json.dumps(envelope, ensure_ascii=False)
    # 控制字符的 JSON 转义可能扩大长度；保持前缀为完整、可解析的 JSON。
    while len(prefix) > MAX_CONTEXT_PREFIX_CHARS:
        key = max(("summary", "selected_text"), key=lambda item: len(envelope[item]))
        envelope[key] = envelope[key][: len(envelope[key]) // 2]
        prefix = json.dumps(envelope, ensure_ascii=False)
    return f"[plane-dock-context.v1]\n{prefix}\n[/plane-dock-context]\n\n{content}"


def sd_client_for_session(session):
    """校验治理开关及固定连接，禁止运行时静默换路由。

    Args:
        session: Dock 会话。

    Returns:
        绑定该会话的 SD 客户端。
    """
    connection = resolve_science_discovery_connection(session.workspace, session.user)
    if connection is None or connection.pk != session.backend_connection_id:
        raise ScienceDiscoveryError("science_discovery_not_configured", "ScienceDiscovery connection is disabled.", 409)
    client = ScienceDiscoveryClient(connection=connection)
    if not client.configured:
        raise ScienceDiscoveryError("science_discovery_not_configured", "ScienceDiscovery is not configured.", 409)
    return client


def _binding(client, grant):
    """创建当前授权的专属 research MCP connector。

    Args:
        client: 已配置的 SD 客户端。
        grant: SD 专属 Dock 授权。

    Returns:
        无凭据的 connector 元数据，关闭 MCP 时为空字典。
    """
    if not getattr(settings, "RESEARCH_MCP_ENABLED", False):
        return {}
    origin = str(getattr(settings, "RESEARCH_MCP_PUBLIC_BASE_URL", "") or "").rstrip("/")
    try:
        parts = urlsplit(origin)
        valid = (
            parts.scheme in {"http", "https"}
            and parts.hostname
            and parts.username is None
            and parts.password is None
            and not parts.query
            and not parts.fragment
            and parts.path in ("", "/")
            and parts.port != 0
            and not any(char.isspace() for char in origin)
        )
    except ValueError:
        valid = False
    if not valid:
        raise ScienceDiscoveryError("research_mcp_not_configured", "Research MCP public URL is required.", 503)
    if set(grant.allowed_tools) != TOOL_NAMES:
        raise ScienceDiscoveryError("agent_context_expired", "Resolve the ScienceDiscovery context again.", 403)
    return client.create_research_connector(
        workspace=grant.workspace,
        user=grant.user,
        grant=grant,
        token=decrypt_data(grant.context_token_encrypted),
        url=f"{origin}/api/research/workspaces/{quote(grant.workspace.slug, safe='')}/agent-access/mcp/",
        expected_tools=TOOL_NAMES,
    )


def _cleanup(client, grant, binding):
    """撤销失败装配的授权，并尽力删除专属 connector。

    Args:
        client: 当前 SD 客户端。
        grant: 待撤销的 grant。
        binding: 可能已创建的 connector 元数据。
    """
    ResearchContextGrant.objects.filter(pk=grant.pk).update(revoked_at=timezone.now())
    if binding:
        try:
            client.remove_research_connector(binding.get("server_id", ""))
        except ScienceDiscoveryError:
            pass


def create_sd_dock_session(*, workspace, user, grant, request_id):
    """每位用户在工作区内幂等装配一个 SD Dock 会话。

    Args:
        workspace: 已授权的工作区。
        user: 当前用户。
        grant: workspace 级 SD 专属授权。
        request_id: 本次创建请求的幂等标识。

    Returns:
        已落库的 provider-aware Dock 会话。
    """
    from plane.research.services.agent_dock_sessions import _append_event, _assembly

    connection = resolve_science_discovery_connection(workspace, user)
    if connection is None:
        raise ScienceDiscoveryError("science_discovery_not_configured", "Configure ScienceDiscovery first.", 409)
    client = ScienceDiscoveryClient(connection=connection)
    if not client.configured:
        raise ScienceDiscoveryError("science_discovery_not_configured", "Configure ScienceDiscovery first.", 409)
    binding = {}
    try:
        # 锁定用户连接，防止多标签页并发创建重复的工作区会话。
        with transaction.atomic():
            ResearchAgentBackendConnection.objects.select_for_update().get(pk=connection.pk)
            existing = (
                ResearchAgentSession.objects.filter(
                    workspace=workspace,
                    user=user,
                    provider=ResearchAgentSession.Provider.SCIENCE_DISCOVERY,
                    target_type="WORKSPACE",
                    backend_connection=connection,
                    deleted_at__isnull=True,
                    assembly__persona="plane-agent-dock",
                )
                .exclude(status="CLOSED")
                .order_by("-created_at")
                .first()
            )
            if existing is None:
                binding = _binding(client, grant)
                specialist_id = sync_specialists(client).get("Plane Dock 工作区助手")
                if not specialist_id:
                    raise ScienceDiscoveryError(
                        "science_discovery_session_failed", "Dock specialist is unavailable.", 502
                    )
                identity = f" [{workspace.id}:{user.id}]"
                project_id = client.ensure_project(
                    name=f"Plane Dock · {workspace.name}"[: 120 - len(identity)] + identity
                )
                session_id = client.create_session(
                    project_id=project_id,
                    title=f"Plane Dock · {workspace.name}"[:120],
                    specialist_id=specialist_id,
                    connector_ids=[binding["source_id"]] if binding else [],
                )
                session = ResearchAgentSession.objects.create(
                    workspace=workspace,
                    user=user,
                    context_grant=grant,
                    target_type="WORKSPACE",
                    provider=ResearchAgentSession.Provider.SCIENCE_DISCOVERY,
                    backend_connection=connection,
                    sd_project_id=project_id,
                    sd_session_id=session_id,
                    status="READY",
                    context_token_encrypted=grant.context_token_encrypted,
                    assembly={**_assembly(grant), "tool_source": "plane-research-mcp", "research_mcp": binding},
                    request_id=request_id,
                    payload_hash=payload_hash({"context_id": str(grant.context_id)}),
                    created_by=user,
                )
                _append_event(
                    session,
                    "CONTEXT_ASSEMBLED",
                    {
                        "target_type": "WORKSPACE",
                        "context_version": grant.context_version,
                    },
                    f"context:{request_id}",
                )
    except Exception:
        _cleanup(client, grant, binding)
        raise
    if existing is not None:
        if existing.context_grant_id != grant.pk and existing.status not in ACTIVE_STATUSES:
            return refresh_sd_dock_context(session=existing, grant=grant, client=client)
        return existing
    session.refresh_from_db()
    return session


def refresh_sd_dock_context(*, session, grant, client=None):
    """保留远端会话和游标，轮换到新的上下文凭据。

    Args:
        session: 原有 Dock 会话。
        grant: 已校验的新 SD grant。
        client: 可选的固定 SD 客户端。

    Returns:
        更新后的会话。
    """
    from plane.research.services.agent_dock_sessions import AgentDockSessionError, _append_event, _assembly

    client = client or sd_client_for_session(session)
    binding = {}
    old_grant = session.context_grant
    old_binding = (session.assembly or {}).get("research_mcp") or {}
    changed_remote = False
    try:
        with transaction.atomic():
            session = ResearchAgentSession.objects.select_for_update().get(pk=session.pk)
            grant = ResearchContextGrant.objects.select_for_update().get(pk=grant.pk)
            if grant.revoked_at is not None or grant.expires_at <= timezone.now():
                raise AgentDockSessionError("Context expired", 403, "agent_context_expired")
            if session.context_grant_id == grant.pk:
                return session
            if session.status in ACTIVE_STATUSES:
                raise AgentDockSessionError("A run is already active", 409, "agent_run_active")
            old_grant = session.context_grant
            old_binding = (session.assembly or {}).get("research_mcp") or {}
            binding = _binding(client, grant)
            client.set_session_connectors(
                session_id=session.sd_session_id,
                connector_ids=[binding["source_id"]] if binding else [],
            )
            changed_remote = True
            session.context_grant = grant
            session.context_token_encrypted = grant.context_token_encrypted
            session.assembly = {
                **(session.assembly or {}),
                **_assembly(grant),
                "tool_source": "plane-research-mcp",
                "research_mcp": binding,
            }
            session.save(update_fields=["context_grant", "context_token_encrypted", "assembly", "updated_at"])
            _append_event(
                session,
                "CONTEXT_ASSEMBLED",
                {
                    "context_version": grant.context_version,
                    "refreshed": True,
                },
                f"context-refresh:{grant.context_id}",
            )
    except Exception:
        if changed_remote:
            try:
                client.set_session_connectors(
                    session_id=session.sd_session_id,
                    connector_ids=[old_binding["source_id"]] if old_binding else [],
                )
            except ScienceDiscoveryError:
                pass
        _cleanup(client, grant, binding)
        raise
    _cleanup(client, old_grant, old_binding)
    session.refresh_from_db()
    return session


def start_sd_dock_message(*, session, content, request_id, route, focus_ref, selected_text):
    """以异步 HTTP run 提交带页面种子的 SD 消息。

    Args:
        session: 已授权的 SD Dock 会话。
        content: 用户原始输入。
        request_id: 消息幂等标识。
        route: 当前页面路由。
        focus_ref: 可选的页面焦点。
        selected_text: 当前选中文本。

    Returns:
        进入运行状态的会话。
    """
    from plane.research.services.agent_dock_sessions import (
        AgentDockSessionError,
        _append_event,
        _sync_page_focus_on_session,
    )

    client = sd_client_for_session(session)
    previous = (session.context_grant.context_manifest or {}).get("page_context") or {}
    page = build_page_context(
        workspace=session.workspace,
        user=session.user,
        route=route or str(previous.get("route") or ""),
        focus_ref=focus_ref or (previous.get("focus") if not route else None),
        selected_text=selected_text,
    )
    with transaction.atomic():
        locked = ResearchAgentSession.objects.select_for_update().get(pk=session.pk)
        existing = locked.run_events.filter(request_id=request_id).first()
        content_hash = payload_hash({"content": content})
        if existing is not None:
            if existing.run_id != locked.run_id or existing.payload.get("content_hash") != content_hash:
                raise AgentDockSessionError("request_id was already used", 409, "agent_request_conflict")
            return locked
        submission = (locked.assembly or {}).get("sd_submission") or {}
        if locked.status in ACTIVE_STATUSES or submission.get("phase") in {"pending", "cancel_pending"}:
            raise AgentDockSessionError("A run is already active", 409, "agent_run_active")
        grant = ResearchContextGrant.objects.select_for_update().get(pk=locked.context_grant_id)
        if grant.revoked_at is not None or grant.expires_at <= timezone.now():
            raise AgentDockSessionError("Context expired", 403, "agent_context_expired")
        message = build_sd_message(
            page_context=page,
            allowed_tools=grant.allowed_tools,
            content=content,
            request_id=request_id,
        )
        locked.run_id = uuid4()
        locked.sd_run_id = ""
        locked.status = "INITIALIZING"
        locked.last_error = ""
        locked.assembly = {
            **(locked.assembly or {}),
            "source_cursor": 0,
            "run_start_cursor": 0,
            "sd_submission": {
                "phase": "pending",
                "request_id": request_id,
                "prompt_hash": payload_hash({"prompt": message.strip()}),
                "created_at": timezone.now().isoformat(),
            },
        }
        _sync_page_focus_on_session(locked, page)
        locked.save(
            update_fields=[
                "run_id",
                "sd_run_id",
                "status",
                "last_error",
                "assembly",
                "research_chain",
                "chain_node",
                "project",
                "updated_at",
            ]
        )
        _append_event(
            locked,
            "COMMUNICATION",
            {
                "direction": "user",
                "content_hash": content_hash,
                "length": len(content),
            },
            request_id,
        )
        _append_event(locked, "USER_MESSAGE", {"role": "user", "content": content[:4000]}, f"user:{request_id}")
        _append_event(
            locked,
            "CONTEXT_ASSEMBLED",
            {
                "target_type": "WORKSPACE",
                "context_version": locked.context_grant.context_version,
                "page_context_hash": page.get("hash", ""),
                "page_kind": page.get("page_kind", ""),
                "route": str(page.get("route") or "").split("?", 1)[0][:500],
            },
            f"context:{request_id}",
        )
    # 意图先提交，再访问远端；连接超时不代表 SD 没有接收消息。
    try:
        remote_run_id = client.start_run(session_id=locked.sd_session_id, content=message)
    except ScienceDiscoveryError as exc:
        _LOGGER.warning("SD submission uncertain session=%s run=%s code=%s", locked.pk, locked.run_id, exc.code)
        upstream_status = exc.upstream_status or exc.status_code
        if 400 <= upstream_status < 500 and upstream_status != 408:
            ResearchAgentSession.objects.filter(pk=locked.pk, run_id=locked.run_id).update(
                status="DEGRADED",
                last_error="science_discovery_submission_rejected",
                assembly={
                    **locked.assembly,
                    "sd_submission": {**locked.assembly["sd_submission"], "phase": "rejected"},
                },
                updated_at=timezone.now(),
            )
            raise
        try:
            return recover_sd_dock_submission(session=locked, client=client)
        except ScienceDiscoveryError:
            locked.refresh_from_db()
            return locked
    try:
        return _bind_sd_submission(session=locked, remote_run_id=remote_run_id, client=client)
    except Exception:
        _LOGGER.error("SD submission binding failed session=%s run=%s", locked.pk, locked.run_id)
        phase = "cancelled"
        try:
            client.cancel(session_id=locked.sd_session_id, run_id=remote_run_id)
        except ScienceDiscoveryError as exc:
            phase = "cancel_pending"
            _LOGGER.warning(
                "SD compensation cancel failed session=%s run=%s code=%s", locked.pk, locked.run_id, exc.code
            )
        ResearchAgentSession.objects.filter(pk=locked.pk, run_id=locked.run_id).update(
            status="DEGRADED",
            last_error="science_discovery_submission_failed",
            assembly={
                **locked.assembly,
                "sd_submission": {
                    **locked.assembly["sd_submission"],
                    "phase": phase,
                    "cancel_requested": True,
                    "remote_run_id": remote_run_id,
                },
            },
            updated_at=timezone.now(),
        )
        raise


def _bind_sd_submission(*, session, remote_run_id, client):
    """将已确认的远端 run 绑定到预先持久化的本地运行。

    Args:
        session: 已记录提交意图的会话。
        remote_run_id: SD 确认的 run ID。
        client: 原会话绑定的客户端。

    Returns:
        完成绑定或补偿取消的会话。
    """
    with transaction.atomic():
        locked = ResearchAgentSession.objects.select_for_update().get(pk=session.pk)
        if locked.run_id != session.run_id:
            raise ScienceDiscoveryError("science_discovery_submission_failed", "Run binding changed.", 409)
        submission = (locked.assembly or {}).get("sd_submission") or {}
        if submission.get("phase") not in {"pending", "cancel_pending"}:
            if locked.sd_run_id == remote_run_id:
                return locked
            raise ScienceDiscoveryError("science_discovery_submission_failed", "Run binding changed.", 409)
        cancel_requested = submission.get("cancel_requested", False)
        locked.sd_run_id = remote_run_id
        locked.assembly = {
            **locked.assembly,
            "sd_submission": {
                **submission,
                "phase": "cancel_pending" if cancel_requested else "bound",
                "remote_run_id": remote_run_id,
            },
        }
        if not cancel_requested:
            locked.status = "STREAMING"
            locked.last_error = ""
        locked.save(update_fields=["sd_run_id", "assembly", "status", "last_error", "updated_at"])
    if cancel_requested:
        client.cancel(session_id=locked.sd_session_id, run_id=remote_run_id)
        with transaction.atomic():
            current = ResearchAgentSession.objects.select_for_update().get(pk=locked.pk)
            if current.run_id == locked.run_id:
                current.assembly = {
                    **current.assembly,
                    "sd_submission": {
                        **current.assembly["sd_submission"],
                        "phase": "cancelled",
                    },
                }
                current.save(update_fields=["assembly", "updated_at"])
    locked.refresh_from_db()
    return locked


def recover_sd_dock_submission(*, session, client=None):
    """按请求标识和完整 prompt 哈希确认提交结果，绝不自动重复 POST。

    Args:
        session: 提交结果未明或待补偿取消的 Dock 会话。
        client: 可选的固定 SD 客户端。

    Returns:
        已恢复绑定的会话；不能确认时抛出可重试错误。
    """
    client = client or sd_client_for_session(session)
    submission = (session.assembly or {}).get("sd_submission") or {}
    remote_run_id = str(submission.get("remote_run_id") or "")
    if not remote_run_id:
        matches = []
        for run in client.list_runs(session_id=session.sd_session_id):
            prompt = str(run.get("prompt") or "")
            if not prompt.startswith("[plane-dock-context.v1]\n"):
                continue
            try:
                context = json.loads(prompt.split("\n", 2)[1])
            except (ValueError, IndexError):
                continue
            if (
                isinstance(context, dict)
                and context.get("request_id") == submission.get("request_id")
                and payload_hash({"prompt": prompt.strip()}) == submission.get("prompt_hash")
                and run.get("id")
            ):
                matches.append(str(run["id"]))
        if len(matches) != 1:
            raise ScienceDiscoveryError(
                "science_discovery_submission_pending", "Submission outcome is not confirmed.", 409
            )
        remote_run_id = matches[0]
    return _bind_sd_submission(session=session, remote_run_id=remote_run_id, client=client)


def sync_sd_dock_events(*, session, client=None):
    """按当前 run 的远端游标幂等补拉事件。

    Args:
        session: SD Dock 会话。
        client: 可选的固定 SD 客户端。

    Returns:
        已同步本地状态的会话。
    """
    submission = (session.assembly or {}).get("sd_submission") or {}
    if submission.get("phase") in {"pending", "cancel_pending"}:
        session = recover_sd_dock_submission(session=session, client=client)
    if not session.sd_run_id or session.status not in {"STREAMING", "WAITING_APPROVAL"}:
        return session
    client = client or sd_client_for_session(session)
    remote_after = max(int((session.assembly or {}).get("source_cursor", 0)), 0)
    events = client.events(session_id=session.sd_session_id, run_id=session.sd_run_id, after_seq=remote_after)
    events = _safe_event_value(events)
    project_science_discovery_events(session, events, expected_run_id=session.run_id)
    session.refresh_from_db()
    return session


def _safe_event_value(value):
    """递归屏蔽上游事件中的凭据，保留事件标识与回答内容。

    Args:
        value: 上游 JSON 值。

    Returns:
        可持久化及回放的脱敏值。
    """
    if isinstance(value, dict):
        return {
            key: "[REDACTED]"
            if re.search(r"(?i)password|token|secret|api[_-]?key|authorization|cookie", str(key))
            else _safe_event_value(item)
            for key, item in value.items()
        }
    if isinstance(value, list):
        return [_safe_event_value(item) for item in value]
    if isinstance(value, str):
        return _safe_text(value, len(value))
    return value


def sd_stream_envelope(event):
    """把持久 SD 事件转换为统一 Dock SSE 封装。

    Args:
        event: 已脱敏展示的本地 run 事件。

    Returns:
        agent-dock-event.v1 字典。
    """
    return sd_event_envelope(event)


def stream_sd_dock_events(*, session, run_id, after_seq):
    """用有限时长的 HTTP 轮询包装可断线续传的 SSE。

    Args:
        session: 固定的 Dock 会话。
        run_id: 浏览器请求的 Plane run ID。
        after_seq: 已消费的远端事件游标。

    Returns:
        SSE 数据块生成器。
    """
    from plane.research.services.agent_dock_sessions import AgentDockSessionError

    client = sd_client_for_session(session)
    deadline = time.monotonic() + 25
    cursor = max(after_seq, 0)
    initial = {
        "schema_version": "agent-dock-event.v1",
        "run_id": str(run_id),
        "seq": 0,
        "source_seq": 0,
        "event_type": "context.bound",
        "payload": {"provider": "SCIENCE_DISCOVERY", "context_version": session.context_grant.context_version},
        "created_at": timezone.now().isoformat(),
    }
    yield f"event: context.bound\ndata: {json.dumps(initial)}\n\n"
    while time.monotonic() < deadline:
        session.refresh_from_db()
        grant = ResearchContextGrant.objects.get(pk=session.context_grant_id)
        if grant.revoked_at or grant.expires_at <= timezone.now():
            raise AgentDockSessionError("Context expired", 403, "agent_context_expired")
        if session.run_id == run_id and session.status in ACTIVE_STATUSES:
            session = sync_sd_dock_events(session=session, client=client)
        for event in session.run_events.filter(run_id=run_id, payload__remote_seq__gt=cursor).order_by("seq"):
            source_seq = int((event.payload or {}).get("remote_seq") or 0)
            if source_seq <= cursor:
                continue
            envelope = sd_stream_envelope(event)
            cursor = source_seq
            yield f"event: {envelope['event_type']}\nid: {cursor}\ndata: {json.dumps(envelope, ensure_ascii=False)}\n\n"
        if session.run_id != run_id or session.status not in ACTIVE_STATUSES:
            return
        heartbeat = {
            "schema_version": "agent-dock-event.v1",
            "run_id": str(run_id),
            "seq": 0,
            "source_seq": cursor,
            "event_type": "heartbeat",
            "payload": {},
            "created_at": timezone.now().isoformat(),
        }
        yield f"event: heartbeat\ndata: {json.dumps(heartbeat)}\n\n"
        time.sleep(1)


def cancel_sd_dock_run(session):
    """请求远端取消，并在远端不可用时仍收敛本地运行状态。

    Args:
        session: 待取消的当前 Dock 会话。

    Returns:
        已收敛的会话。
    """
    from plane.research.services.agent_dock_sessions import _append_event

    if session.status not in ACTIVE_STATUSES:
        return session
    with transaction.atomic():
        locked = ResearchAgentSession.objects.select_for_update().get(pk=session.pk)
        if locked.run_id != session.run_id or locked.status not in ACTIVE_STATUSES:
            return locked
        cursor = int((locked.assembly or {}).get("source_cursor", 0)) + 1
        _append_event(
            locked,
            "DEGRADED",
            {
                "remote_type": "run.cancelled",
                "remote_seq": cursor,
                "content": "Run cancelled by the user.",
            },
            f"cancel:{locked.run_id}",
        )
        locked.status = "READY"
        locked.last_error = "science_discovery_run_cancelled"
        locked.assembly = {
            **(locked.assembly or {}),
            "source_cursor": cursor,
            "sd_submission": {
                **((locked.assembly or {}).get("sd_submission") or {}),
                "phase": "cancel_pending" if locked.sd_run_id else "pending",
                "cancel_requested": True,
                "remote_run_id": locked.sd_run_id,
            },
        }
        locked.save(update_fields=["status", "last_error", "assembly", "updated_at"])
    try:
        recover_sd_dock_submission(session=locked)
    except ScienceDiscoveryError as exc:
        _LOGGER.warning("SD cancel pending session=%s run=%s code=%s", locked.pk, locked.run_id, exc.code)
    locked.refresh_from_db()
    return locked


def answer_sd_dock_run(*, session, approved, permission_request_id=None):
    """将当前运行的待审批请求映射到 SD 的单次允许或拒绝。

    Args:
        session: 处于审批等待的当前会话。
        approved: 用户是否允许本次执行。
        permission_request_id: 浏览器正在展示的权限请求 ID，旧调用可省略。

    Returns:
        已记录审批结果的会话。
    """
    from plane.research.services.agent_dock_sessions import AgentDockSessionError, _append_event

    with transaction.atomic():
        locked = ResearchAgentSession.objects.select_for_update().get(pk=session.pk)
        if locked.run_id != session.run_id or locked.status != "WAITING_APPROVAL":
            raise AgentDockSessionError("No pending approval", 409, "agent_approval_not_found")
        pending = pending_sd_permissions(locked.run_events.filter(run_id=locked.run_id).order_by("seq"))
        request_id = str(permission_request_id or "")
        if not request_id and len(pending) == 1:
            request_id = next(iter(pending))
        if request_id not in pending:
            raise AgentDockSessionError("No pending approval", 409, "agent_approval_not_found")
        request = pending[request_id]
        client = sd_client_for_session(locked)
        client.answer_approval(request_id=request_id, decision="allow_once" if approved else "deny")
        _append_event(
            locked,
            "HUMAN_DECISION",
            {
                "remote_type": "permission.resolved",
                "requestId": request_id,
                "tool_call_id": str(request.get("toolCallId") or ""),
                "approved": approved,
            },
            f"approval:{locked.run_id}:{request_id}",
        )
        locked.status = "WAITING_APPROVAL" if len(pending) > 1 else "STREAMING"
        locked.save(update_fields=["status", "updated_at"])
    locked.refresh_from_db()
    return locked
