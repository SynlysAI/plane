# Synlora AI 助手运维手册

Plane 工作区全局 AI 助手（右下角悬浮球 / 顶栏图标 / `Cmd+J`）由 Synlora（Yuxi）Run API 驱动，本页描述部署配置、凭证管理、知识库接入与故障排查。

## 架构

```
浏览器 ──会话 Cookie──▶ Plane Django BFF ──Bearer 存储凭证──▶ Synlora (Yuxi)
                        /api/workspaces/<slug>/assistant/*        /api/agent/runs 等
```

- 凭证永不离开后端：浏览器只与 Plane BFF 通信，yxkey 注入在服务端。
- 运行事件为 SSE 字节级透传（`Content-Encoding: identity` 绕过 GZip 中间件），浏览器逐帧收到增量。
- 断开面板不取消上游运行（Synlora 侧最长 30 分钟），重开后续传不丢内容；只有显式点"停止"才会 cancel。

## 配置步骤

### 1. Synlora 侧

1. 在 Synlora 创建或选择助手，记下其 slug（如 `agent-202610140622`）。
2. 生成 API Key（`POST /api/user/apikey/`，明文只显示一次，`yxkey_` 开头）。
3. （可选，检索知识库）挂 RAGPortal MCP：

```bash
curl -X POST $SYNLORA/api/system/mcp-servers/ -H "Authorization: Bearer <管理员JWT>" \
  -H 'Content-Type: application/json' -d '{
    "slug": "ragportal",
    "transport": {"type": "streamable_http",
                  "url": "https://<ragportal-host>/api/mcp",
                  "headers": {"Authorization": "Bearer <RAGPortalToken>"}}
  }'
# 再到助手配置里把 mcps 指向 ragportal
```

RAGPortal Token 在其门户"API Token"页创建，须绑定允许检索的知识库并勾选 `documents:search`。

### 2. Plane 侧

管理员进入工作区 → 科研设置 → **系统集成**：

| 字段     | 说明                                                                                           |
| -------- | ---------------------------------------------------------------------------------------------- |
| 系统     | 选 Synlora                                                                                     |
| 服务地址 | 从 plane-api 容器可达的 Synlora 基地址（env `SYNLORA_BASE_URL` 为预填默认）                    |
| 凭证模式 | **公共凭证**：直接粘贴 yxkey（加密存储，留空保持不变）；**个人凭证**：等待按用户注入的后续功能 |
| 启用     | 勾选后助手入口对工作区成员可见                                                                 |

### 3. 环境变量（apps/api）

| 变量                                  | 默认                 | 说明                                     |
| ------------------------------------- | -------------------- | ---------------------------------------- |
| `SYNLORA_BASE_URL`                    | 空                   | 连接行未填地址时的回落值                 |
| `SYNLORA_AGENT_SLUG`                  | `agent-202610140622` | 服务端注入的助手 slug，客户端不可选      |
| `SYNLORA_TIMEOUT_SECONDS`             | `5`                  | 控制调用超时                             |
| `SYNLORA_STREAM_READ_TIMEOUT_SECONDS` | `90`                 | SSE 读超时（Synlora 心跳 15s，90s 足够） |

凭证不再经环境变量引用（旧的 `credential_ref` / `*_AUTH_SECRET` 机制已移除）。

## BFF 端点（维护者参考）

均挂 `GET/POST /api/workspaces/<slug>/assistant/`：

| 路径                    | 方法 | 语义                                                                |
| ----------------------- | ---- | ------------------------------------------------------------------- |
| `status/`               | GET  | `{enabled, ready, credential_mode}`；`enabled=false` 时前端隐藏入口 |
| `session/`              | POST | 建 Synlora 线程，返回 `thread_id`                                   |
| `chat/`                 | POST | `{query, thread_id}` → `{run_id, queued, …}`，agent_slug 服务端注入 |
| `runs/<run_id>/events/` | GET  | SSE 透传，支持 `Last-Event-ID` 续传                                 |
| `runs/<run_id>/result/` | GET  | 终态与最终答案                                                      |
| `runs/<run_id>/cancel/` | POST | 显式取消                                                            |
| `history/?thread_id=`   | GET  | 线程历史消息                                                        |

## 故障排查

- **入口不出现**：`curl .../assistant/status/` 看 `enabled`；未配置连接 / 公共凭证为空 / 未启用都会置 false。
- **状态表 Synlora 降级**：健康探测路径为 `/api/system/ready`（旧 `/api/health` 已下线）。
- **回答不流式（一次性出现）**：检查反向代理对该路由的缓冲——nginx 需 `proxy_buffering off`（响应已带 `X-Accel-Buffering: no`），并确认中间层未剥离 `Content-Encoding: identity`。
- **对话中断可重试**：前端断线会用 `Last-Event-ID` 自动重连一次；Synlora 会重放运行事件。
- **切换凭证模式**：改为个人凭证后公共 token 立即停用（共享层不再注入凭证），按用户注入功能合入前该连接视为未配置。

## 数据库迁移

- `0172` 删除旧 agent 插件两张表（ResearchAgentSession / ResearchAgentRunEvent）
- `0173` 移除 `research_agent_enabled` 工作区开关
- `0174` 集成连接凭证直存（新增 `credential` / `credential_mode`，删除 `credential_ref`）
