# 科研智能体平台 Phase 0 实施计划：契约、基础设施与安全前置

> **当前数据说明（2026-09-26）**：本文的“课题 A/B”、学生、导师和 seed 命令均为契约或自动化测试占位，不代表当前 `public` π-Lab Excel 数据。当前人工测试必须使用 Phase 1.5 分角色计划动态解析身份并创建 mock 课题。

> 文中“课题 A/B”“学生/导师”等为契约场景占位符，不是当前 `public` 数据；人工测试必须使用 Phase 1.5 分角色计划动态解析的 π-Lab 身份和 mock 课题。

| 项目     | 内容                                                                                            |
| -------- | ----------------------------------------------------------------------------------------------- |
| 计划版本 | v1.4                                                                                            |
| 上游 PRD | [`research-intelligent-platform-prd.md`](./research-intelligent-platform-prd.md) §2、§6–§9、§11 |
| 计划状态 | 已实施；当前代码版本 `4.16.0`，自动化验证通过，历史计划不替代当前契约和运行证据                 |
| 目标     | 冻结跨仓契约，建立可灰度、可回滚、可观测的开发基础                                              |
| 不在范围 | 用户可用的完整研究链、自动实验、社会用户开放                                                    |

## 1. 阶段目标与出口

Phase 0 不向普通用户开放完整功能，只交付后续开发必须依赖的契约、骨架和安全门槛。阶段完成后，Plane、RAGPortal、Synlora 和专业系统可以在不猜测字段和权限的情况下并行开发。

出口条件：

-研究链、Trace、ExternalReference、AccountLink 和 Job 的 schema 均有版本号、示例和错误码。

- Plane 现有 RAGPortal 适配器与实际 `/api/kb/list`、`/api/uploads`、上传详情接口通过 contract fixture，并能检查内网 WeKnora 服务健康状态。
- 未绑定账号、跨课题访问和撤权后的短期 token 均无法读取受保护资源。
- Chain/Agent/Trace 开关默认关闭，迁移可回滚，普通 Plane P0/P1 回归通过。
- 基础监控可以区分请求、Agent run、外部调用、降级和安全拒绝。

## 2. 技术方案

### 2.1 契约包与版本

建立跨仓契约目录，建议放在 Plane `docs/contracts/research-intelligent-platform/`，并在各服务中生成类型或校验器。每个契约包含 JSON Schema、示例、错误码、兼容策略和变更记录。

首批契约：

| 契约                    | 关键字段                                                                                          |
| ----------------------- | ------------------------------------------------------------------------------------------------- |
| `research-chain.v1`     | `chain_id`、`project_id`、`chain_kind`、`visibility`、`owner_id`、`status`                        |
| `research-node.v1`      | `node_id`、`chain_id`、`node_type`、`parent_node_id`、`loop_iteration`、`status`                  |
| `research-event.v1`     | `event_id`、`node_id`、`actor`、`source_system`、`request_id`、`trace_id`、`refs`、`content_hash` |
| `research-snapshot.v1`  | `snapshot_id`、`node_id`、`source_versions`、`summary`、`created_by`、`immutable`                 |
| `agent-context.v1`      | `schema_version`、`context_id`、`scope`、`resources[]`、`generated_at`、`context_hash`            |
| `agent-trace.v1`        | `run_id`、`session_id`、`node_id`、`events[]`、`tool_calls[]`、`decisions[]`                      |
| `account-link.v1`       | `canonical_identity`、`provider`、`external_subject`、`local_user_id`、`status`、`verified_at`    |
| `integration-result.v1` | `source_system`、`request_id`、`items`、`degraded`、`degraded_reason`、`synced_at`                |
| `job-status.v1`         | `job_id`、`run_id`、`status`、`attempt`、`started_at`、`finished_at`、`error_code`                |

规则：新增字段默认可选；枚举只追加；删除或重命名必须发布新 schema；消费者必须忽略未知字段；所有回调以 `request_id` 或 `event_id` 幂等。

### 2.2 Plane 数据和 API 骨架

在现有 `ResearchProjectProfile` 上设计 `chain_kind`、`chain_visibility` 和协作者关系，优先使用可空字段和独立关联表，避免破坏历史培养项目唯一性。

新增模型设计稿：

- `ResearchChain`：一对一关联 `ResearchProjectProfile`，保存状态和可见性。
- `ResearchChainNode`：节点类型、父节点、循环编号、责任人和状态。
- `ResearchChainEvent`：追加式事件，按 `chain_id + occurred_at + event_id` 建索引。
- `ResearchChainSnapshot`：不可变引用快照，保存 source object ID/version/hash。
- `ResearchReflectionLog`：迭代总结、失败原因和后续行动。
- `AccountLink`：独立于现有 `IdentityMapping`，支持 pending/active/revoked/unlinked。

路由骨架统一挂 `/api/research/workspaces/{slug}/`，先实现鉴权、开关和错误 envelope，再添加空实现 endpoint。写操作统一要求 `request_id`、`schema_version` 和调用者身份。

### 2.3 外部系统适配器

复用 `ExternalSystemConnection`、credential reference、timeout、cache 和 degraded mode。每个 adapter 只负责：

1. 认证和请求签名。
2. 超时、重试和 request ID 传递。
3. 上游响应归一化为 `integration-result.v1`。
4. 权限过滤和降级状态。
5. 写入 `IntegrationCallLog`，不保存敏感请求/响应正文。

WeKnora 已部署在内网 `http://10.26.15.93:8000/`，不在本项目中开发。RAGPortal 是唯一入库入口，负责调用 WeKnora。RAGPortal 首期适配路径固定为：

```text
GET  /api/kb/list
POST /api/uploads
GET  /api/uploads/{id}
```

Plane 不直连 WeKnora API Key；资料入库由 RAGPortal 后端调用 WeKnora，Agent 检索使用 Synlora/RAGPortal 已有受控能力。Phase 0 只做 RAGPortal 入库、WeKnora 健康状态和检索错误的契约确认，不做 WeKnora 开发。

### 2.4 Agent Context 与短期授权

Plane Context API 继续只读、元数据优先、按 ACL 过滤。新增 exchange token 流程：

1. Plane 根据当前用户、Workspace、课题和节点签发短期 `context_id` 或 exchange token。
2. Synlora 使用该 token 调用 Context API。
3. Context API 每次读取重新计算用户和课题 ACL，并写入 `context.read` 审计。
4. token 不携带可扩大的权限，不含长期服务密钥，撤权后服务端立即拒绝。

Synlora session metadata 预留 `workspace_id`、`research_project_id`、`chain_node_id`、`context_schema_version`、`context_hash` 和 `visibility_scope`。

### 2.5 身份与 AccountLink

保留 OIDC `IdentityMapping` 的 subject/email/employee_id 冲突拒绝行为，不自动合并已存在账户。新增绑定流程：二次验证 → 冲突检查 → 管理员或用户确认 → 写入 AccountLink 和审计 → 签发受限关联状态。

解绑、禁用和撤权必须更新 AccountLink 状态并使跨系统授权失效；不删除任一原生账号和历史数据。

### 2.6 开关、日志和观测

新增开关建议：

```text
research_chain_enabled
research_agent_enabled
research_trace_enabled
research_account_link_enabled
research_external_rag_enabled
```

开关层级：部署级 → Workspace 级 → 课题级（如需要）。默认关闭；每次变更写审计。

统一指标：API latency/error、ACL deny、context reads、agent runs、external calls、degraded count、event append failure、callback duplicate、queue wait、storage bytes。日志脱敏，不记录 token、密钥和正文。

### 2.7 Plane 通用 Agent 插件基础设计

Phase 0 必须把“插件”定义成 Plane 内的正式业务模块，而不是一个外部链接。插件由 Plane Web UI、Plane BFF 和 Synlora Agent Runtime 三部分组成：

```text
Plane route/component
  → Plane Agent BFF（ACL、短期 token、幂等、审计）
    → Synlora session/run API
      → Synlora tools/knowledge/plugins
    ← SSE/events/trace
  ← Chain Event/Snapshot projection
```

插件 manifest 采用版本化结构：

```json
{
  "plugin_id": "research-agent",
  "manifest_version": "agent-plugin.v1",
  "entrypoints": ["workspace_home", "research_chain", "chain_node"],
  "required_scopes": ["context.read", "agent.session.create"],
  "capabilities": ["chat", "knowledge.search", "artifact.save"],
  "ui": { "desktop": "side_panel", "mobile": "stacked_panel" },
  "feature_flag": "research_agent_enabled"
}
```

Phase 0 冻结以下 BFF 接口：

```text
POST /api/research/workspaces/{slug}/agent/sessions
GET  /api/research/workspaces/{slug}/agent/sessions/{session_id}
POST /api/research/workspaces/{slug}/agent/sessions/{session_id}/messages
GET  /api/research/workspaces/{slug}/agent/runs/{run_id}/events?after_seq=
POST /api/research/workspaces/{slug}/agent/runs/{run_id}/approvals
POST /api/research/workspaces/{slug}/agent/artifacts
POST /api/research/workspaces/{slug}/agent/chain-events
```

BFF 强制注入 `workspace_id`、`research_project_id`、`chain_node_id`、`context_id` 和 `visibility_scope`，前端不得自行传入可扩大范围的 scope。每个请求都写 `request_id` 和审计事件。

插件 UI 状态字典必须固定为：`initializing`、`loading_context`、`ready`、`streaming`、`waiting_approval`、`saving`、`degraded`、`forbidden`、`expired`、`error` 和 `closed`。切换课题或节点时，先关闭旧 session，再创建新 session；禁止旧 SSE 事件更新新课题界面。

安全约束：同源路由或反向代理优先；CSP 禁止未知 iframe；短期 token 不进入 URL、localStorage 或前端日志；工具审批必须由后端确认后才允许执行。

导航基础约束：新增 `research_chain` capability 和 Workspace 子开关，ResearchSidebarItems、科研总览卡片和页面守卫读取同一能力结果；不得删除、移动或改变现有 `overview`、`reports`、`projects`、`approvals`、`system`、`platform`、`audit`、`integrations` 入口。普通 Plane 的首页、草稿、我的工作、便签、项目、More 和添加项目流程继续使用原有路由。

### 2.7.1 Phase 1 Agent 编排契约增量

本节只补充后续契约边界，不重写 Phase 0 已完成实施记录：

- `agent-plugin.v1` 继续作为 Plane BFF/UI 的 manifest、入口、状态字典和幂等基线。
- Phase 1 新增 `agent-context.v2`，在原 Context metadata 上加入授权知识库、文件、插件、工具、capability policy 和有效期；raw token 仍只在服务端请求头中流转。
- Phase 1 新增 `plane-delegated-auth.v1`，Plane BFF 以服务身份换取绑定用户的短效 Synlora token；token 不返回浏览器，也不使用共享用户账号。
- Phase 1 新增 `capability-manifest.v1`，Plane 只同步 Synlora 插件、专家、工具、配置健康、风险和 schema digest 的只读投影，不复制运行时注册表。
- Phase 1 新增 `research-correlation.v1`，垂类系统仅保存用于审计和回执的 Plane/Synlora 关联 ID，不以此替代自身鉴权。
- Phase 0 的 fail-closed Agent message BFF 是过渡实现；目标态为 Plane BFF 换取 delegated identity、自动装配 Synlora session、每轮复验 Context，并消费 Synlora event cursor 完成 Chain projection。

### 2.8 研究事件、快照和待办 taxonomy

Phase 0 固定跨系统事件和快照字典，避免 Plane、Synlora、RAGPortal 和专业系统为同一事实产生不同名称：

| 类别     | 首批类型                                                                                                                          |
| -------- | --------------------------------------------------------------------------------------------------------------------------------- |
| 过程事件 | `RESEARCH_NOTE`、`COMMUNICATION`、`AI_ACTION`、`TOOL_CALL`、`VALIDATION`、`HUMAN_DECISION`、`APPROVAL`、`DATA_CHANGE`、`DEGRADED` |
| 快照类型 | `LITERATURE_REVIEW`、`EXPERIMENT_EXECUTION`、`EXPERIMENT_DATA`、`ANALYSIS_RESULT`、`PAPER_REVIEW`、`GENERAL_RESEARCH`             |
| 待办来源 | `RAGPORTAL`、`SYNLORA`、`PLANE`、`SPECLABOS`、`POLY_AGENT`、`SPEC_AGENT`                                                          |
| 待办状态 | `OPEN`、`IN_PROGRESS`、`BLOCKED`、`DONE`、`CANCELLED`、`DEGRADED`                                                                 |

事件必须区分“发生事实”和“当前投影状态”；待办可以重建，事件和快照不能由前端覆盖。`COMMUNICATION` 只保存参与者、时间、主题摘要和消息引用，不默认复制聊天正文。

## 3. 开发任务

### 任务 0.1：契约和状态字典

- 输出上述 9 个 schema 的 JSON Schema、示例和错误码。
- 固定节点类型、状态、事件类型、降级枚举和版本兼容规则。
- 建立契约变更评审清单和消费者兼容测试。

依赖：无。完成标志：所有契约示例可被校验器接受，未知字段兼容测试通过。

### 任务 0.2：Plane 数据迁移与 API 骨架

- 新增可回滚迁移和索引。
- 增加 `chain_kind`、可见性、Chain/Node/Event/Snapshot/Reflection/AccountLink 模型草图。
- 实现 `/api/research/.../chains`、`/nodes`、`/events`、`/snapshots` 的鉴权、开关、幂等和错误 envelope。
- 保持现有培养项目唯一性和普通科研 API 向下兼容。

依赖：0.1。完成标志：迁移 up/down、权限拒绝和重复 request_id 测试通过。

### 任务 0.3：RAGPortal Adapter 对齐

- 用真实接口替换错误的 knowledge entries 路径。
- 实现上传 metadata、状态轮询、知识库列表、超时、重试和 LINK_ONLY/HIDDEN 降级。
- 增加 request_id、调用日志和响应归一化。

依赖：0.1。完成标志：fixture contract test 覆盖成功、401、404、429、超时和重复上传。

### 任务 0.4：Context Adapter 与短期 token

- Plane 签发短期 exchange token/context ID。
- Synlora 增加 Research Context Adapter 和 session metadata。
- 校验 Workspace、课题、节点、可见性和 context hash。
- 写入读取、拒绝、撤权和过期审计。

依赖：0.2、0.1。完成标志：跨课题和撤权负例均返回拒绝；token 不可换取更大范围。

### 任务 0.5：AccountLink

- 新增绑定、确认、解绑、撤销和冲突查询接口。
- 不改写 IdentityMapping；支持管理员批准和二次验证。
- 传播禁用、解绑和权限撤回到跨系统访问检查。

依赖：0.2、0.1。完成标志：邮箱冲突、多 subject、重复绑定、解绑和已存在账户测试通过。

### 任务 0.6：同源门户骨架与 Feature Flag

- 规划研究链、Agent、RAGPortal 和组件入口路由。
- 增加首页卡片、科研待办和权限空态的接口占位。
- 完成反向代理、CORS/CSP、短期 token 传递和禁止跨站 iframe 的安全配置。
- 输出 `agent-plugin.v1` manifest、入口路由、BFF API、UI 状态和事件映射契约。
- 建立 Agent 插件壳组件、课题/节点 scope provider、session 生命周期和 SSE 取消接口。
- 增加 `research_chain` 导航 key、Workspace 子开关、侧栏入口、页面守卫和科研总览跳转卡；为所有既有 Plane/科研入口补回归测试。

依赖：0.2、0.4。完成标志：开关关闭时原 Plane 无变化，打开时只对授权测试账号显示入口。

### 任务 0.7：测试与运维基线

- 建立 contract、migration、ACL、idempotency、degraded、security 和 smoke 测试套件。
- 建立日志脱敏、指标、告警和外部健康检查。
- 定义备份、恢复、迁移失败和开关回滚 runbook。
- 增加插件 manifest、scope 切换、旧 SSE 隔离、BFF ACL、审批 fail-closed 和 token 泄露检查。
- 固定事件、快照、待办 taxonomy 和来源系统枚举，增加未知类型兼容测试和重复投影测试。

依赖：0.2–0.6。完成标志：测试门禁可在 CI/本地复现，回滚演练有记录。

## 4. 测试与验收

### 4.1 自动化测试

- Schema：合法、缺字段、未知字段、枚举扩展和版本兼容。
- 数据库：迁移升级/回滚、唯一约束、索引和历史数据不变。
- 权限：学生、导师、PI、管理员、Guest、未绑定账号跨课题读写矩阵。
- 幂等：同一 request_id、event_id、上传 hash 和回调重复提交只产生一个事实。
- 集成：RAGPortal 认证、超时、429、5xx、状态轮询和降级。
- 安全：短期 token 过期、撤权、CSP、CORS、密钥不出前端和日志脱敏。
- 插件：manifest 校验、入口可见性、课题切换、session 关闭、SSE 取消、无权限和外部降级状态。

### 4.2 手工验收

1. 开关关闭时，原有 Plane 导航、项目、Page、附件和科研模块行为不变。
2. 开关逐级打开时，未授权用户看不到入口，直接访问 API 返回 403/404。
3. 一个学生可以创建两个 `RESEARCH_CHAIN`，历史 `LEGACY_TRAINING` 约束仍生效。
4. RAGPortal 不可用时，课题可继续创建记录并显示降级原因。
5. 账号解绑后，已有短期 token 不能访问另一系统课题内容。
6. 插件从课题 A 切换到课题 B 后，A 的流式消息、工具结果和缓存不能出现在 B 中。
7. 关闭 `research_agent_enabled` 后，插件入口、BFF 写接口和 Synlora session 创建均被拒绝。

## 5. 发布、回滚与风险

- 先在测试 Workspace 执行迁移和契约测试，再灰度一个内部 Workspace。
- 任何迁移失败先停止发布，不自动删除历史科研数据。
- 通过开关关闭新功能；数据库只回滚新增结构，不回滚既有 P0/P1 数据。
- 风险：RAGPortal 或内网 WeKnora 服务可用性波动。处理：固定 RAGPortal OpenAPI fixture、健康检查和 LINK_ONLY/HIDDEN 降级，联调未通过不得进入 Phase 1。
- 风险：Synlora 当前单用户模型不足以支持共享课题。处理：先完成 Context Adapter 和 tenant mapping，禁止仅透传 project_id。

## 6. 详细数据设计

### 6.1 研究链基础字段

Phase 0 只建立迁移和 API 骨架，字段允许为空，避免一次性改变既有培养项目。建议字段如下：

| 对象                     | 字段                            | 约束与说明                                                  |
| ------------------------ | ------------------------------- | ----------------------------------------------------------- |
| `ResearchProjectProfile` | `chain_kind`                    | `LEGACY_TRAINING` / `RESEARCH_CHAIN`；历史记录默认前者      |
| `ResearchProjectProfile` | `chain_visibility`              | `PRIVATE` / `MEMBERS` / `ORG` / `WORKSPACE`；默认 `PRIVATE` |
| `ResearchChain`          | `project_id`                    | 唯一，必须指向科研 Project                                  |
| `ResearchChain`          | `status`                        | `ACTIVE` / `ARCHIVED` / `COMPLETED`                         |
| `ResearchChain`          | `owner_id`                      | 必须是 ProjectMember 且未被禁用                             |
| `ResearchChainNode`      | `node_type`                     | 由阶段字典约束，未知类型拒绝写入                            |
| `ResearchChainNode`      | `parent_node_id`                | 只能指向同一 Chain；禁止自引用和循环父链                    |
| `ResearchChainNode`      | `loop_iteration`                | 非负整数；同一父节点下按递增序列生成                        |
| `ResearchChainNode`      | `status`                        | 由状态机校验，不允许客户端任意跳转                          |
| `ResearchChainEvent`     | `event_id` / `request_id`       | 分别用于事件幂等和请求幂等，均建立唯一索引                  |
| `ResearchChainEvent`     | `payload_ref`                   | 只保存对象引用、摘要和 hash，不保存密钥/原始正文            |
| `ResearchChainSnapshot`  | `node_id` / `version`           | 联合唯一；快照生成后只读                                    |
| `AccountLink`            | `provider` / `external_subject` | 同一 provider+subject 只能绑定一个 canonical identity       |

迁移顺序：先增加可空字段和新表 → 回填历史项目为 `LEGACY_TRAINING` → 加入非破坏性索引 → 通过数据预检后再增加必要约束。不得在同一迁移中删除旧字段或改变既有唯一约束。

### 6.2 API 骨架契约

所有接口统一响应 envelope：

```json
{
  "success": true,
  "data": {},
  "error": null,
  "request_id": "req_...",
  "schema_version": "research-chain.v1"
}
```

错误码至少包括：`RESEARCH_DISABLED`、`CHAIN_NOT_FOUND`、`CHAIN_ACCESS_DENIED`、`INVALID_TRANSITION`、`IDEMPOTENCY_CONFLICT`、`ACCOUNT_LINK_CONFLICT`、`UPSTREAM_TIMEOUT` 和 `UPSTREAM_DEGRADED`。

首批接口契约：

| 方法   | 路径                                           | 要点                                                        |
| ------ | ---------------------------------------------- | ----------------------------------------------------------- |
| `POST` | `/api/research/workspaces/{slug}/chains/`      | 创建 Chain，要求 `project_name`、`chain_kind`、`visibility` |
| `GET`  | `/api/research/workspaces/{slug}/chains/`      | 只返回调用者可见课题，支持 owner/status/visibility 过滤     |
| `GET`  | `/api/research/workspaces/{slug}/chains/{id}/` | 返回课题元数据和权限能力，不返回未授权引用                  |
| `POST` | `/chains/{id}/nodes/`                          | 创建节点，要求 `node_type`、`title`、可选 `parent_node_id`  |
| `POST` | `/nodes/{id}/events/`                          | 追加事件，要求 `event_type`、`request_id`、refs/summary     |
| `GET`  | `/nodes/{id}/events/`                          | 游标分页，按 `occurred_at,event_id` 稳定排序                |
| `POST` | `/nodes/{id}/snapshots/`                       | 从授权引用生成不可变快照                                    |
| `POST` | `/account-links/`                              | 创建 pending 绑定，不直接激活                               |
| `POST` | `/account-links/{id}/confirm/`                 | 完成二次验证和激活                                          |

### 6.3 幂等和事务边界

- 创建 Chain、Node、Snapshot 和 AccountLink 时，`request_id` 必须在事务中落库。
- 重复请求若 payload hash 相同，返回首次结果；hash 不同返回 `IDEMPOTENCY_CONFLICT`。
- 业务写入和 Chain Event 使用同一数据库事务；外部调用只写 outbox，不能在数据库事务内阻塞等待。
- outbox 消费失败进入重试队列，超过上限写入 dead-letter 并触发告警。

## 7. 代码落点与实施顺序

### 7.1 Plane

建议落点：

```text
apps/api/plane/db/models/research/chain.py
apps/api/plane/db/models/research/account_link.py
apps/api/plane/db/migrations/01xx_research_chain_foundation.py
apps/api/plane/research/views/chain.py
apps/api/plane/research/views/account_links.py
apps/api/plane/research/serializers/chain.py
apps/api/plane/research/permissions/chain.py
apps/api/plane/research/services/idempotency.py
apps/api/plane/research/services/outbox.py
apps/api/plane/tests/unit/research/test_chain_foundation.py
apps/api/plane/tests/contract/app/test_research_chain_contract.py
```

实施顺序：模型/迁移 → serializer/错误 envelope → 权限 → service/idempotency → views → contract tests。前端不得先于 API 契约冻结实现真实写操作。

### 7.2 RAGPortal 与 Synlora

RAGPortal：在 `RAGPortal/backend` 增加 contract fixture 和课题 metadata 校验；不把 WeKnora Key 暴露给浏览器。

Synlora：在 `Synlora/apps/web/backend/app` 增加 Research Context Adapter、session metadata 校验和事件回写 client；在 `packages/synlys-harness` 增加 context scope 作为 ToolContext 的只读字段。

### 7.3 前端骨架

Plane 前端沿用 `apps/web/core/components/research`、`core/services/research`、`core/store/research` 和现有 ResearchGuard；Phase 0 只新增路由、开关、权限空态和 mock service，不实现完整 Chain 编辑器。

## 8. 测试命令与验收证据

建议门禁命令：

```bash
cd plane
pnpm check:format
pnpm check:lint
pnpm check:types
docker compose -f docker-compose-test.yml run --rm api-tests pytest -q \
  apps/api/plane/tests/unit/research/test_chain_foundation.py \
  apps/api/plane/tests/contract/app/test_research_chain_contract.py
```

跨仓 contract test 使用固定 fixture，不依赖真实生产服务；真实联调另在受控环境执行。验收证据至少包括：迁移前后数据库结构、contract test 报告、权限矩阵结果、开关截图、脱敏日志样例、回滚演练记录和健康检查响应。

## 9. 阶段任务拆分与并行关系

| 任务组                  | 可并行 | 依赖                                    | 交付物                           |
| ----------------------- | ------ | --------------------------------------- | -------------------------------- |
| 契约/fixture            | 否     | 无                                      | schema、示例、错误码、模拟服务   |
| Plane 模型/迁移         | 否     | 契约                                    | migration、model、预检脚本       |
| RAGPortal adapter       | 是     | integration-result schema               | client、fixture、降级测试        |
| Synlora Context Adapter | 是     | agent-context schema、Plane Context API | adapter、scope 校验、事件 client |
| AccountLink             | 是     | identity/account-link schema            | API、审计、冲突测试              |
| 门户骨架/开关           | 是     | API 错误 envelope、权限契约             | route、guard、feature flag       |
| 观测与回滚              | 是     | 全部接口确定                            | metrics、alerts、runbook         |

Phase 0 不允许进入 Phase 1 的条件：契约尚未冻结、RAGPortal fixture 未通过、Context scope 可被绕过、迁移不可回滚或普通科研回归失败。

## 10. Phase 0 插件交付清单

- [x] `agent-plugin.v1` manifest、scope 和状态字典评审通过。
- [x] Plane Agent BFF 的请求/响应、错误码、幂等和审计契约通过 contract test。
- [x] 插件入口在 Workspace 首页、研究链和 Node 详情的路由方案确定。
- [x] session 创建、恢复、关闭、SSE 取消和课题切换行为有自动化测试。
- [x] CSP、token 存储、工具审批和日志脱敏通过安全检查。

## 11. 实施记录

### 11.1 仓库与分支

| 仓库      | 分支        | 交付                                                                                   |
| --------- | ----------- | -------------------------------------------------------------------------------------- |
| Plane     | `develop`   | 契约包、Chain 模型/API、短期 Context、AccountLink、Agent BFF、门户开关、观测与 runbook |
| RAGPortal | `develop`   | `/api/uploads` 课题 metadata 校验、持久化、历史库补列与 contract fixture               |
| Synlora   | `bff_plane` | Plane Context Adapter、科研会话 metadata、事件回写 client、ToolContext 只读 scope      |

### 11.2 验证证据

- Plane：`python manage.py makemigrations db --check --dry-run` 无漂移；科研 unit + contract 套件 749 passed / 0 failed。
- Plane 迁移：独立数据库完成 0145 → 0151 → 0145 → 0151 前滚 / 回滚 / 再前滚演练。
- Plane 前端：类型检查、lint（仅存量 warning）、7 个组件测试文件 30 个用例、生产构建通过。
- RAGPortal：后端 30 passed / 0 failed；前端 lint 与生产构建通过。
- Synlora：harness 139 passed / 7 skipped；web backend 457 passed / 118 skipped（未配置 Mongo 的参数化用例按项目 fixture 跳过）；前端 lint 与生产构建通过。

### 11.3 运行边界

- 所有 Phase 0 Workspace 子开关默认关闭；部署级 `RESEARCH_MODULE_ENABLED` 仍是最外层 kill switch。
- Agent 消息在 Synlora runtime 未配置时 fail closed，返回 `AGENT_UPSTREAM_NOT_CONFIGURED`，不阻塞人工研究记录。
- 短期 Context token 只在 Plane 后端签发/撤销，Synlora 仅在服务端请求头中转，不写数据库、URL、前端存储或日志。
- RAGPortal 仍是不向浏览器暴露 WeKnora API Key 的唯一入库入口；Plane 只保存引用与状态。
