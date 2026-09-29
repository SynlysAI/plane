# 科研智能平台 Phase 0 运维与回滚手册

## 状态

- 版本：v1.0
- 更新日期：2026-09-22
- 适用迁移：`db.0146` ~ `db.0151`
- 默认状态：`research_chain`、`research_agent`、`research_trace`、`research_account_link`、`research_external_rag` 全部关闭

## 1. 发布前检查

1. 备份生产数据库和对象存储，确认备份可恢复。
2. 确认 `SECRET_KEY`、RAGPortal credential ref、Synlora 配置只存在于后端 secret manager。
3. 确认 Workspace `research_*` 开关全部为 false。
4. 执行迁移前运行：

```bash
cd plane
docker compose -f docker-compose-test.yml run --rm api-tests \
  sh -c "python manage.py makemigrations db --check --dry-run && pytest -q \
    plane/tests/unit/research/test_research_contract_fixtures.py \
    plane/tests/unit/research/test_chain_foundation.py \
    plane/tests/contract/app/test_research_agent_plugin.py \
    plane/tests/contract/app/test_research_context_tokens.py \
    plane/tests/contract/app/test_research_account_links.py \
    plane/tests/contract/app/test_research_observability.py"
```

前端门禁：

```bash
pnpm --filter web check:types
pnpm --filter web check:lint
pnpm --filter web exec vitest run --config vitest.config.ts \
  tests/components/research-chain-navigation.test.tsx
pnpm --filter web build
```

## 2. 迁移与回滚

### 2.1 迁移

```bash
python manage.py migrate db 0151 --noinput
```

### 2.2 回滚 Phase 0 数据结构

以下命令只回滚 Phase 0 新增模型和字段，不回滚 0145 及之前的科研数据：

```bash
python manage.py migrate db 0145 --noinput
```

如需继续前滚：

```bash
python manage.py migrate db 0151 --noinput
```

### 2.3 已执行演练记录

日期：2026-09-22

1. 独立数据库从零应用至 `0151_research_agent_plugin`：通过。
2. 回滚至 `0145_user_import_review_and_account_source`：通过，0146–0151 依序卸载。
3. 再次应用至 `0151_research_agent_plugin`：通过。

回滚说明：

- `ResearchChainEvent`、`ResearchChainSnapshot`、`ResearchReflectionLog`、`ResearchAgentRunEvent` 是 append-only 事实表，回滚会删除 Phase 0 结构；生产回滚前必须先完成第 3 节备份。
- `ResearchContextGrant` 回滚会移除短期授权状态；所有未撤销 token 随之失效。
- `AccountLink` 回滚会移除外部账号绑定和验证码哈希，不影响原 `IdentityMapping`。

## 3. 备份与恢复

1. 迁移前创建数据库快照，保留至少 7 天。
2. 备份对象存储中的研究附件和快照引用文件。
3. 恢复演练必须包含：数据库时间点恢复、对象存储版本恢复、`manage.py migrate --check`、RAGPortal health probe、一条受保护 Context API 读取。
4. 恢复后检查 `research_context_grants.revoked_at` 与 `research_agent_sessions.status`，确保已关闭会话不会重新可用。

## 4. 开关回滚

优先顺序：先关 Workspace 子开关，再必要时回滚数据结构。

```http
PATCH /api/research/workspaces/{slug}/settings/
{
  "research_chain_enabled": false,
  "research_agent_enabled": false,
  "research_trace_enabled": false,
  "research_account_link_enabled": false,
  "research_external_rag_enabled": false
}
```

验证：

1. 侧栏不显示“研究链”。
2. `GET /api/research/workspaces/{slug}/chains/` 返回 403/404。
3. `POST /api/research/workspaces/{slug}/agent/sessions/` 返回 403。
4. 普通 Plane 首页、项目、Page、附件和既有科研入口回归通过。

## 5. 外部系统降级

主动探测：

```http
POST /api/research/workspaces/{slug}/integrations/health/probe/
{"system": "RAGPORTAL"}
```

处理：

1. RAGPortal 401/403：检查 credential ref 和外部账号绑定，不重试敏感写操作。
2. RAGPortal 404：检查 base URL 与路由版本。
3. RAGPortal 429/5xx/timeout：按 `LINK_ONLY` 或 `HIDDEN` 降级，手动研究记录继续可用。
4. 降级原因会写入 `IntegrationCallLog.error_code`，观测 API 汇总 `external_degraded_total`。

## 6. 安全事件处理

### 6.1 短期 token 泄露

1. 调用 `POST /api/research/workspaces/{slug}/context/revoke-token/`，body 为 `context_id`。
2. 若关联 Agent session，调用 session close；BFF 会撤销同一 Context Grant。
3. 撤销外部 AccountLink 时，系统会同步撤销该用户全部未撤销 Context Grant。
4. 检查 `security.denied` 审计，确认旧 token 请求开始返回 401/403。

禁止将 exchange token 写入 URL、localStorage、前端日志或错误消息。

### 6.2 跨课题/跨 Workspace 访问

1. 查询 `action=security.denied`，按 `metadata.reason` 分类。
2. `research_capability_denied` 表示导航能力拒绝。
3. `workspace_membership_missing`、`private_workspace`、`api_token_workspace_mismatch` 表示 Workspace 边界拒绝。
4. 出现异常批量拒绝时先冻结相关账号，再检查组织关系和 AccountLink。

## 7. 观测与告警

管理员读取：

```http
GET /api/research/workspaces/{slug}/observability/
```

核心指标：

- `api_requests_total`：研究侧审计请求数。
- `agent_runs_total` / `agent_errors_total`：Agent 会话与错误。
- `external_calls_total` / `external_degraded_total`：外部调用与降级。
- `security_denials_total` / `security_denials_24h`：安全拒绝。
- `context_reads_total`：上下文读取。
- `chain_events_total`：链路事实追加。

告警：

- `external_degraded=true`：15 分钟内持续则通知值班。
- `security_denial_spike=true`：检查爆破、错误授权配置或组织关系批量变更。
- `agent_error_rate=true`：检查 Synlora 配置与 BFF 审计。

日志策略：`RequestLoggerMiddleware` 只记录方法、路径、状态、耗时、IP、UA 和用户 ID；不记录请求/响应正文。`authorization`、`cookie`、`x-api-key`、`x-research-context-token` 必须保持脱敏。

## 8. 发布验收证据

- 契约：9 个 Phase 0 schema + `agent-plugin.v1` 示例校验通过。
- RAGPortal：真实 KB/upload/upload-detail fixture 通过。
- Context：跨课题、跨 Workspace、hash 不匹配、过期与撤权负例通过。
- AccountLink：多 subject、邮箱冲突、验证过期、撤销传播通过。
- Agent：manifest、session、事件隔离、审批拒绝、token 不泄露通过。
- 迁移：独立库前滚/回滚/再前滚通过。
- 后端：`plane/tests/unit/research` + `plane/tests/contract/app/test_research*.py`，749 passed / 0 failed（2026-09-22）。
- 前端组件：7 个文件、30 个用例全部通过（2026-09-22）。
- 前端：导航开关回归、类型检查、lint、生产构建通过。
- 迁移漂移：`makemigrations db --check --dry-run` 显示无未生成迁移。
