#!/usr/bin/env python3
"""ScienceDiscovery P0 全链路冒烟脚本（方案 §13 P0）。

对真实 SD 实例执行：模型检查 → 建 project/session → 发 run → 轮询事件到终态
→ 用真实事件流验证 Plane 侧事件映射表。无模型 key 时 run 会失败，但事件
流仍能验证映射表（run.failed → DEGRADED）。

用法：
    SD_BASE_URL=http://127.0.0.1:5300 SD_TOKEN=xxx \
    apps/api/.venv/bin/python scripts/sd_p0_smoke.py

可选环境变量：SD_MODEL_ID（会话钉住模型）、POLL_TIMEOUT（秒，默认 300）。
"""

from __future__ import annotations

import os
import sys
import time
import uuid

import httpx

# 与 apps/api/plane/research/services/chain_projection.py 保持同步的映射表
# （P0 的目的就是拿真实事件流核对这张表）。
EXPECTED_AGENT_TYPE_MAP = {
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
TERMINAL_TYPES = {"run.completed", "run.failed", "run.cancelled"}


def main() -> int:
    """执行 P0 冒烟并输出验证结论。"""
    base_url = os.environ.get("SD_BASE_URL", "").rstrip("/")
    token = os.environ.get("SD_TOKEN", "")
    model_id = os.environ.get("SD_MODEL_ID", "")
    poll_timeout = int(os.environ.get("POLL_TIMEOUT", "300"))
    if not base_url or not token:
        print("缺少 SD_BASE_URL / SD_TOKEN 环境变量")
        return 2

    headers = {"Authorization": f"Bearer {token}"}
    client = httpx.Client(base_url=base_url, headers=headers, timeout=30)
    passed = True

    def step(name: str, ok: bool, detail: str = "") -> None:
        nonlocal passed
        passed = passed and ok
        print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""))

    # 1. 模型 profile 检查（§2.3：无模型的 SD 发消息会 400/失败）。
    models_resp = client.get("/api/models")
    models = []
    if models_resp.status_code == 200:
        payload = models_resp.json()
        models = payload.get("models") if isinstance(payload, dict) else payload
    step(
        "GET /api/models（token 与服务可达）",
        models_resp.status_code == 200,
        f"{len(models or [])} 个模型档案",
    )
    if not models:
        print("!! SD 未配置模型档案：run 将以 run.failed 终态收场（仍可验证映射表）")

    # 2. 建 project / session。
    marker = uuid.uuid4().hex[:8]
    project = client.post("/api/projects", json={"name": f"plane-p0-smoke-{marker}"})
    step("POST /api/projects", project.status_code == 201)
    if project.status_code != 201:
        return 1
    project_id = project.json().get("id")

    session_body = {"title": f"P0 smoke {marker}"}
    if model_id:
        session_body["modelId"] = model_id
    session = client.post(f"/api/projects/{project_id}/sessions", json=session_body)
    step("POST /api/projects/{pid}/sessions", session.status_code == 201)
    if session.status_code != 201:
        return 1
    session_id = session.json().get("id")

    # 3. 发 run：验证 201 立即返回（异步排队契约）。
    started = time.monotonic()
    run = client.post(f"/api/sessions/{session_id}/runs", json={"content": "P0 冒烟：请回复 OK 两个字母即可。"})
    elapsed = time.monotonic() - started
    step("POST /runs 立即返回 runId（异步契约）", run.status_code == 201 and elapsed < 10, f"{elapsed:.1f}s")
    if run.status_code != 201:
        print(run.text[:300])
        return 1
    run_id = run.json().get("id")

    # 4. 轮询事件到终态。
    after = 0
    observed: dict[str, int] = {}
    terminal = None
    deadline = time.monotonic() + poll_timeout
    while time.monotonic() < deadline:
        page = client.get(f"/api/sessions/{session_id}/runs/{run_id}/events", params={"after": after})
        if page.status_code != 200:
            step("GET events 轮询", False, f"HTTP {page.status_code}")
            return 1
        items = page.json()
        for item in items:
            event_type = str((item.get("event") or {}).get("type") or "")
            if event_type:
                observed[event_type] = observed.get(event_type, 0) + 1
            if event_type in TERMINAL_TYPES:
                terminal = event_type
        if items:
            after = items[-1].get("sequence", after)
        if terminal:
            break
        time.sleep(2)
    step(f"轮询到终态（{poll_timeout}s 内）", terminal is not None, f"终态={terminal} 事件类型={len(observed)}")
    if terminal is None:
        return 1

    # 5. 映射表验证：真实事件类型 × Plane 映射。
    unmapped = sorted(set(observed) - set(EXPECTED_AGENT_TYPE_MAP))
    step("事件映射表覆盖", not unmapped, f"未覆盖类型: {unmapped or '无'}")
    print("\n=== 观测到的事件类型 → Plane 映射 ===")
    for event_type, count in sorted(observed.items()):
        mapping = EXPECTED_AGENT_TYPE_MAP.get(event_type, "(未映射 → 默认 AI_ACTION)")
        print(f"  {event_type:<32} ×{count:<3} → {mapping}")
    verdict = "PASS — P0 验证通过" if passed and not unmapped else "REVIEW — 存在需处理的项"
    print(f"\n结论: {verdict}")
    return 0 if passed and not unmapped else 1


if __name__ == "__main__":
    sys.exit(main())
