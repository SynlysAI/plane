# Plane × Synlora Agent Dock 运维手册

Plane 工作区 AI 助手与科研链智能体统一由 Synlora v1 Sessions 驱动。浏览器只访问 Plane BFF；Plane 负责身份、业务对象 ACL、Context Token 签发与审计，Synlora 负责 Agent Runtime、工具、插件、MCP、审批和事件持久化。

## 目标架构

```text
浏览器
  → Plane Agent Dock BFF
    → 服务端路由解析 / ACL / agent-context.v3 签发
    → Synlora delegated-token
    → Synlora /api/v1/sessions/*
  ← durable events / context envelope / artifact references
```

- `agent-context.v3` 支持 Workspace、Project、Research Chain、Node 四类目标；旧 `agent-context.v2` 自动映射为 Node。
- Context Token 只在 Plane 服务端加密保存，用于 Synlora 建会话与每轮复验，绝不返回浏览器或写入普通日志。
- Synlora run 在后台执行；关闭 Dock、切换路由或断开 SSE 不取消任务，只有显式“停止”才调用 cancel。
- `POST /api/v1/sessions/{sid}/runs` 提交后台 run；`GET /api/v1/sessions/{sid}/events?after_seq=` 回放 durable events。

## 配置

1. Synlora 配置：
   - `AUTH_SECRET`
   - `PLANE_BASE_URL`
   - `PLANE_API_TOKEN`
   - `PLANE_SERVICE_TOKEN`（与 Plane `SYNLORA_SERVICE_TOKEN` 一致）
2. Plane 配置：
   - `SYNLORA_BASE_URL`
   - `SYNLORA_SERVICE_TOKEN`
   - `SYNLORA_TIMEOUT_SECONDS`
   - `SYNLORA_STREAM_READ_TIMEOUT_SECONDS`
3. Plane 工作区 → 科研设置 → 系统集成，启用 Synlora 连接。连接地址仍由 Plane 服务端使用；浏览器不接收任何 Synlora 凭证。
4. 部署顺序：先升级 Synlora，确认 delegated-token、v1 Sessions 与非流式 run 端点可用；再部署 Plane 并执行迁移。

## Agent Dock BFF

统一入口挂在 `/api/workspaces/<slug>/agent-dock/`：

| 路径                              | 方法     | 语义                                          |
| --------------------------------- | -------- | --------------------------------------------- |
| `context/resolve/`                | POST     | 服务端解析 route、执行 ACL、返回脱敏 Envelope |
| `context/<context_id>/`           | GET      | 查询 Envelope 状态与能力摘要                  |
| `sessions/`                       | GET/POST | 按用户列出 / 创建 target-bound Synlora 会话   |
| `sessions/<session_id>/`          | GET      | 恢复会话状态                                  |
| `sessions/<session_id>/messages/` | POST     | 每轮携带 v3 Context 启动后台 run              |
| `runs/<run_id>/events/`           | GET      | 拉取并投影本地 append-only 事件               |
| `runs/<run_id>/cancel/`           | POST     | 用户显式取消                                  |

旧 `/assistant/*` 兼容接口继续存在；新前端统一走 `agent-dock`。科研链旧 `/research/.../agent/*` 保留，ScienceDiscovery Provider 不受影响。

## 运行与事件

- Plane 本地 `ResearchAgentRunEvent` 是 BFF 稳定投影，按 `(session_id, remote_seq)` 幂等去重。
- Synlora durable 事件保留原始 `tool/call`、`tool/result`、`ask/user`、`turn/end` 等类型语义，再投影到 Plane 既有事件字典。
- 每轮消息写入 `CONTEXT_ASSEMBLED` 快照事件，包含 target、context version 与 manifest hash，不包含摘要正文、token 或文件内容。
- UI 不展示 Chain of Thought；`assistant/reasoning` 和 transient reasoning delta 不进入 Plane 投影。
- 工具参数展示前递归遮蔽 password/token/secret/api_key/authorization/cookie 等字段，并限制预览大小。

## 故障排查

- **助手入口不出现**：检查 Plane 集成连接启用状态与 `SYNLORA_BASE_URL`。
- **status ready=false**：确认 Plane 可访问 Synlora `/api/system/ready`，且 `SYNLORA_SERVICE_TOKEN` 与 Synlora `PLANE_SERVICE_TOKEN` 一致。
- **会话创建 403/502**：查看 delegated-token 交换、Context Token 过期与 Synlora session 权限。
- **消息 401**：Context Token 过期或撤权；重新 resolve context 并创建新会话。
- **事件缺口**：调用 `GET /agent-dock/runs/<run_id>/events/?after_seq=<latest_seq>`；Synlora durable events 会补齐，瞬态 delta 不落盘。
- **反向代理**：SSE 路由需关闭缓冲，保留 `X-Accel-Buffering: no` 与 `Content-Encoding: identity`。

## 数据库迁移

- `0217`：`ResearchAgentSession.context_token_encrypted`
- `0218`：Context Grant / Agent Session 四级 target、manifest、latest_seq
- `0219`：`ResearchContextGrant.context_token_encrypted`

迁移后旧 Node 会话默认 `target_type=RESEARCH_CHAIN_NODE`，无需数据回填。
