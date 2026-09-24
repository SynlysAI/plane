# Research Intelligent Platform Phase 1 验收与灰度手册

## 1. 交付范围

Phase 1 已交付以下闭环：

- 学生可创建多个 `RESEARCH_CHAIN` 课题，并分别使用 `WORKSPACE` 与 `PRIVATE` 可见性。
- Chain 具备节点状态机、循环、append-only 事件、不可变快照、时间线回放和 Markdown 导出。
- RAGPortal BFF 支持知识库列表、作用域上传、sha256 校验、状态刷新、引用确认和降级人工路径。
- Synlora 支持 `plane-delegated-auth.v1`、`capability-manifest.v1`、`agent-context.v2`、每轮复验和 `allowed_tools` 防御性交集。
- Plane 自动装配 persona、插件、工具和授权资源，并将 Synlora 事件投影为 Agent run event 与 Chain event。
- 研究计划/分析类 AI 产物必须经过人工确认；确认后生成六类 typed snapshot 之一。
- 实验、失败原因、外部资产、修订和版本锁定复用既有 Experiment 服务。
- 开启 `research_ia_v2` 后，科研导航收敛为科研总览、研究链、审批中心、科研管理；旧列表路由显式兼容，关闭开关完整回退旧界面。
- Plane 首页提供权限安全的科研摘要卡；科研总览提供跨组件待办、课题摘要、提交汇总与管理统计。-研究链课题页提供固定上下文条、七类 Tab、主链可视化、循环编号、成员管理和六段式节点详情。
- Agent 工作台提供 Context 条、结构化工具卡、审批/产物抽屉与 Trace 筛选；审批中心接入真实 Agent 等待会话队列。

## 2. 自动化验收

### Plane API / contract

```bash
cd plane/apps/api
docker exec plane-api-tests-live pytest -q \
  plane/tests/contract/app/test_research_phase1_e2e.py \
  plane/tests/contract/app/test_research_chain_mvp.py \
  plane/tests/contract/app/test_research_chain_knowledge.py \
  plane/tests/contract/app/test_research_agent_orchestrator.py \
  plane/tests/contract/app/test_research_agent_plugin.py \
  plane/tests/contract/app/test_research_context_tokens.py \
  plane/tests/contract/app/test_research_experiments.py \
  plane/tests/contract/app/test_research_stages.py \
  plane/tests/contract/app/test_research_settings.py
```

覆盖：

- 双课题公开/隔离 ACL、Guest 负例、归档只读和幂等重放。
- RAGPortal 上传、状态、引用、降级和跨课题引用拒绝。
- Synlora delegated token、capability manifest、v2 Context、工具交集、事件投影和撤权。
- AI 草稿、人工确认、六类快照、失败实验和导出 hash/顺序。

### Plane web

```bash
cd plane
pnpm --filter @plane/types build
pnpm --filter @plane/constants build
pnpm --filter web run check:types
pnpm --filter web run build
cd apps/web
pnpm exec vitest run --config vitest.config.ts \
  tests/components/research-agent-plugin.test.tsx \
  tests/components/research-chain-detail.test.tsx \
  tests/components/research-agent-approval-queue.test.tsx \
  tests/components/research-home-summary-card.test.tsx \
  tests/components/research-todo-index.test.tsx \
  tests/components/research-chain-knowledge-panel.test.tsx \
  tests/components/research-chain-navigation.test.tsx \
  tests/components/research-chain-route-registration.test.ts \
  tests/components/research-ia-v2-redirect.test.ts
```

### RAGPortal

```bash
cd RAGPortal/backend
AUTH_SECRET=test-secret \
AI4MS_BASE_URL=http://ai4ms.test \
AI4MS_PORTAL_URL=http://ai4ms.test \
WEKNORA_BASE_URL=http://weknora.test \
WEKNORA_API_KEY=test-key \
.venv/bin/pytest -q
```

### Synlora

```bash
cd Synlora/apps/web/backend
AUTH_SECRET=test-secret .venv/bin/pytest -q \
  tests/test_research_context.py \
  tests/test_research_agent_contracts.py \
  tests/test_runtime_assembly.py \
  tests/test_session_runtime.py
```

完整 Synlora 后端套件在本环境执行结果为 605 passed / 186 skipped；Docker 专属沙箱提示词断言在 SDK/daemon 不可用时跳过，环境可用时仍执行。

2026-09-24 任务 1.9 本地验证：

- Plane API：`test_research_chain_mvp.py` 7 passed；`test_research_agent_plugin.py` 19 passed。
- Plane Web：6 个相关组件测试文件 15 passed；`pnpm --filter web run check:types` 通过；变更文件 oxlint 0 warnings。
- 浏览器验收：科研总览在 1920×1080、1440×900、1280×800、390×844 均无横向溢出；首页摘要卡、跨组件待办、课题摘要和范围统计可见。
- 可访问性断言覆盖首页 loading/empty/forbidden、Chain Tab `aria-current`、主链节点 `aria-pressed`、Agent 抽屉 `role=dialog` 与 `aria-modal`、消息流 `aria-live`、Trace 筛选可访问名称。
- 既有 Plane 侧栏 hydration warning 仍存在，来源与任务 1.9 改动无关，未阻断客户端渲染。

## 3. 灰度步骤

1. **准备外部服务**
   - RAGPortal 配置 WeKnora、AI4MS 认证和上传限制。
   - Synlora 配置 `AUTH_SECRET`、`PLANE_SERVICE_TOKEN`、`PLANE_BASE_URL`、`PLANE_API_TOKEN`。
   - Plane 配置 `SYNLORA_BASE_URL`、`SYNLORA_SERVICE_TOKEN` 和 Context TTL。
2. **迁移与开关**
   - 保持 `research_chain_enabled=false`、`research_agent_enabled=false`、`research_external_rag_enabled=false`。
   - 执行 Plane migrations 0146–0156；所有变更均为 additive。
   - 验证 RAGPortal `/api/health` 与 Synlora `/api/health`。
   - IA v2 默认开启；灰度前先确认 Chain 闭环可用，回退时由工作区管理员关闭 `research_ia_v2`。
3. **内部试点**
   - 仅给试点 Workspace 打开 `research_account_link_enabled`、`research_external_rag_enabled`、`research_chain_enabled`、`research_agent_enabled`。
   - 为学生绑定 ACTIVE Synlora AccountLink。
   - 按验收脚本执行一次双课题闭环。
4. **观察项**
   - `integration.call` 的 success/degraded 比例和 latency。
   - Synlora event cursor 是否单调、是否有重复 `(run_id, seq)`。
   - Context 过期、AccountLink 解绑和 RAGPortal 降级计数。
   - Chain event 增长速率与导出大小。

### 3.1 IA v2 手工验收

1. 关闭 `research_ia_v2`，确认旧科研平铺侧栏、旧列表页面、普通 Plane 首页/草稿/我的工作/便签/项目入口不变。
2. 开启 `research_ia_v2`，确认科研侧栏最多显示四个入口；学生不可见科研管理，导师/PI 按评审能力显示审批中心，管理员可见科研管理。
3. 逐项验证旧路由兼容：项目、报告、提交汇总、待我评审、审计、集成跳转后 query/hash 不丢失；报告详情、项目详情、课题详情、节点详情不改址。
4. 在 1920/1440/1280/390px 宽度检查侧栏、审批中心 Tab、科研管理 Tab、科研总览和 Chain 保存视图不溢出。
5. 构造无权限与 RAGPortal `not_configured` 状态，确认页面显示中文原因和人工路径，不显示原始 key/code。

2026-09-24 本地开发栈实测：迁移 0156 后，管理员在平台配置页开启开关，侧栏收敛为四个入口；项目、提交汇总、待我评审、审计、集成旧路由均重定向到目标路由，query/hash 保留；关闭开关后旧平铺侧栏和旧项目路由完整恢复。浏览器中仍存在 Plane 侧栏嵌套 button 的既有 hydration 警告，与本轮 IA 改动无关。

## 4. 回滚与支持

- 关闭 Workspace 的 `research_agent_enabled` 会停止新 Agent session 和写操作；既有事件、快照和导出保持只读。
- 关闭 `research_external_rag_enabled` 或将 RAGPortal 连接切到 `LINK_ONLY`，人工实验和 Chain 记录继续可用。
- Synlora 持续失败时关闭 `research_agent_enabled`，不要删除 AccountLink；解绑会立即撤销 Context 并使旧 session fail closed。
- 代码回滚前先关闭写入开关。0152–0155 均为 additive，可先回滚代码再择期回收新表。
- 用户报告“不能看到课题”时，先核对 Workspace 成员、科研身份、课题 visibility 和 ProjectMember，再检查 nav capability。
- 用户报告“Agent 不能继续”时，按顺序检查 Context 过期、AccountLink 状态、Synlora health 和 capability manifest。

## 5. 上线证据包

每次灰度保留：

- E2E 测试输出和提交号。
- 双课题权限负例报告。
- RAGPortal/Synlora 降级演练日志。
- 一次 Markdown 导出文件及其 `X-Research-Chain-SHA256`。
- Synlora event cursor 重连去重日志。
