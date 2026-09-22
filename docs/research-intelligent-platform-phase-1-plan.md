# 科研智能体平台 Phase 1 实施计划：Research Chain + RAGPortal + Synlora MVP

| 项目     | 内容                                                                                               |
| -------- | -------------------------------------------------------------------------------------------------- |
| 计划版本 | v1.3                                                                                               |
| 上游 PRD | [`research-intelligent-platform-prd.md`](./research-intelligent-platform-prd.md) §4–§10            |
| 前置计划 | [`research-intelligent-platform-phase-0-plan.md`](./research-intelligent-platform-phase-0-plan.md) |
| 计划状态 | 待评审                                                                                             |
| 目标     | 交付一个学生可创建多个课题并完成调研、AI 讨论、计划、实验记录、分析和沉淀的最小闭环                |
| 不在范围 | 自动设备执行、专业 Tool Call 生产化、完整治理和社会用户开放                                        |

## 1. 阶段目标与出口

Phase 1 首次向内部试点用户开放 Research Chain。平台必须能把课题、文献、对话、研究计划、实验记录、分析结果和 Trace 组织在同一条可回放链路中。

出口条件：

- 一个学生可以创建两个 `RESEARCH_CHAIN` 课题，并分别设置公开和隔离可见性。
- 课题 ACL 在页面、API、Context、RAG、文件、Trace 和导出路径一致。
- 用户完成“调研 → AI 讨论/选题 → 研究计划 → 实验记录 → 分析 → 快照/导出”。
- RAGPortal 上传和 Synlora 检索可用；任一外部服务不可用时人工记录仍可继续。
- 事件可按顺序回放，循环重试不会覆盖或复制正式快照。

## 2. 技术方案

### 2.1 课题与 Chain 模型

复用普通 Plane Project 和 ProjectMember，在 `ResearchProjectProfile` 上实现 `RESEARCH_CHAIN` 类型，并关联 `ResearchChain`。创建课题时：

1. 校验 Workspace 科研模块和 Chain 开关。
2. 创建普通 Project、负责人和成员关系。
3. 创建 `ResearchProjectProfile(chain_kind=RESEARCH_CHAIN)`。
4. 创建 Chain、默认节点模板和 `PRIVATE` 可见性。
5. 写入审计和初始化事件。

课题成员变更必须同步对象 ACL，但不改变普通 Plane Project 的原权限语义。课题归档时 Chain 只读，历史事件和快照保留；恢复时重新校验 Workspace、用户和组织权限。

### 2.2 节点、快照和循环

首期提供节点类型：`RESEARCH`、`LITERATURE_REVIEW`、`TOPIC_EVALUATION`、`PRE_EXPERIMENT`、`PLAN`、`OPENING`、`EXPERIMENT`、`ANALYSIS`、`ITERATION`、`SUMMARY`。同时预留 `PAPER_WRITING`、`COMPLETION`、`TRANSFER` 节点类型；预留类型在首期可创建和查看，但写作、结题和转化动作由后续阶段开关控制。节点状态：`DRAFT`、`ACTIVE`、`WAITING_HUMAN`、`NEEDS_REVISION`、`COMPLETED`、`FAILED`、`ARCHIVED`。

节点通过 `parent_node_id` 和 `loop_iteration` 表示回溯与循环；不要求首期实现任意图编辑。正式 Snapshot 保存引用对象的 ID、版本、标题、摘要、hash 和来源链接，正文和原始数据仍由权威系统保存。

事件写入采用事务或可靠 outbox：业务对象提交成功后追加 event；event 已存在时按 `event_id`/`request_id` 返回原结果。快照采用唯一 `(node_id, version)`，禁止覆盖。

### 2.3 首页、课题页和统一门户

在现有科研首页增量增加：

- Research Chain 卡片：当前节点、最近活动、阻塞和降级状态。
- 科研待办：待导师确认、待人工验证、待补实验记录、外部任务失败。
- Agent 分析入口：带当前课题、节点和 Context ID。
- 科研组件入口：RAGPortal、Synlora，以及后续专业系统占位。

现有导航和功能必须全部保留：Plane 的首页、草稿、我的工作、便签、工作区项目、More、添加项目，以及科研总览、报告、科研项目、办公审批、系统管理、平台配置、审计记录和系统集成。Research Chain 作为科研分组新增一级入口，不替换科研总览或科研项目。

职责区分：

- 科研总览：跨课题聚合、待办、统计和最近活动。
- Research Chain：课题过程节点、快照、事件、Agent 和回放。
- 科研项目：科研项目创建、列表、成员和项目级资源。
- 报告：周报/月报、提交、退回和正式版本。
- 管理入口：保持管理员能力和现有 URL，不因 Research Chain 开放而扩大权限。

入口通过 ResearchGuard、Workspace 开关和课题 ACL 过滤。外部页面首期使用同源反向代理/BFF 跳转；页面回到 Plane 后，通过 `chain_id` 和 `node_id` 恢复上下文。

欢迎页科研区域采用固定信息顺序：当前 Research Chain → 需要本人处理的待办 → 最近研究快照 → Agent 分析入口 → 科研组件入口。待办默认按阻断级别、截止时间、更新时间排序；同一来源对象只显示一条当前待办，历史状态进入时间线。用户完成 Plane 本地待办时直接更新状态；外部待办先调用来源系统，回调未确认前显示“同步中”，不得提前标记完成。

组件入口卡最少显示名称、能力摘要、可用/降级状态、当前课题是否已授权、最近一次运行/同步时间和进入动作。入口没有权限时展示申请/联系路径，不展示无权限对象的标题、计数或运行结果。

### 2.3.1 Plane 通用 Agent 插件 MVP UI

插件以同源路由或侧边工作台嵌入 Plane：

```text
欢迎页/课题页
  ├─ 课题摘要与当前节点
  ├─ Agent 对话工作区
  │   ├─ 上下文摘要（课题、节点、知识库、文件）
  │   ├─ 消息流和 reasoning 摘要
  │   ├─ 工具调用卡（状态、输入摘要、输出引用）
  │   └─ 人工确认/修改操作
  ├─ 产物抽屉（计划草稿、引用、分析结果、文件）
  └─ Trace 时间线（事件、验证、决策、保存状态）
```

交互规则：

- 桌面端默认右侧 420–520px 工作台；需要查看完整 Trace 时切换双栏页面。
- 移动/窄屏端使用上下堆叠布局，先显示消息，再显示工具和 Trace。
- 当前课题和节点显示在顶部固定栏，切换前提示未保存草稿；切换后重建 session scope。
- 流式消息显示连接状态、停止生成、重连和最后事件序号；刷新后按 `after_seq` 补齐。
- 工具卡分为“自动执行”“需要确认”“已拒绝”“失败可重试”；危险工具默认折叠输入详情。
- “保存到 Research Chain”必须选择目标类型：研究计划草稿、文献引用、分析摘要、节点事件或反思日志。
- 保存成功返回版本和快照 ID；保存失败保留本地草稿但不伪造 Chain Event。
- 无权限、课题归档、Context 过期、RAG 降级和 Synlora 不可用时提供刷新授权、人工记录、打开来源系统或稍后重试等替代路径。

插件不提供独立账号、项目或知识库管理；所有入口、Session、产物和写操作均通过 Plane BFF。

### 2.4 RAGPortal 调研闭环

课题内上传流程：

1. Plane 后端生成带课题/节点范围的上传授权。
2. RAGPortal 校验用户 token、课题 metadata 和上传权限。
3. RAGPortal 调用内网已部署的 WeKnora 服务上传，返回 `knowledge_id`、`kb_id`、状态和 task ID。
4. Plane 写入 `ExternalReference` 和 Chain Event，不保存文件正文。
5. 前端轮询或刷新上传状态，显示解析中、完成、失败或降级。

检索流程由 Synlora `knowledge.search` 执行，知识库范围只能来自 Plane 授权的课题 KB 集合；WeKnora 的服务调用和索引维护由 RAGPortal/既有 Agent 能力负责。引用结果写入 Literature/ExternalReference 和 Snapshot；检索失败时保留查询摘要、错误码和人工记录入口。

### 2.5 Synlora 课题 Agent

Plane 创建 Agent session 时提交：

```json
{
  "workspace_id": "...",
  "research_project_id": "...",
  "chain_node_id": "...",
  "context_schema_version": "agent-context.v1",
  "context_id": "...",
  "visibility_scope": "PRIVATE"
}
```

Synlora 每次运行前重新读取 Context；工具调用不得超出 session scope。Plane 消费运行事件，映射为 `AI_ACTION`、`TOOL_CALL`、`INTERMEDIATE_ARTIFACT`、`VALIDATION`、`HUMAN_DECISION` 和 `OUTPUT` 事件。

首期工具范围：知识检索、文件引用、文本分析、研究计划草稿和结构化结果保存。工具审批由 Synlora 提供，Plane 记录审批结果和人工决策引用。

AI 接入应用逻辑：

1. 用户在当前节点打开插件，Plane 生成 Context ID 和允许的知识库集合。
2. 用户输入问题后，Synlora 先读取课题元数据，再根据助手策略调用 `knowledge.search` 或文件工具。
3. 检索结果必须携带来源、版本、命中知识库和权限范围；没有来源的结论标记为“待验证”。
4. AI 生成研究计划、选题建议或分析摘要时，结果先进入草稿区，不自动写入正式材料。
5. 用户/导师确认后，插件调用 BFF 保存结构化产物并追加 Chain Event/Snapshot。
6. 验证失败或用户拒绝时，保留事件和原因，节点进入 `NEEDS_REVISION` 或继续人工记录。

首期上下文优先级：当前节点输入和已确认快照 > 当前课题引用 > 课题成员授权资料 > Workspace 公共知识。不得把其他课题、未授权组织资料或模型历史会话自动加入上下文。

### 2.6 研究计划、实验记录和分析

- 研究计划复用 Page/Stage Material，并关联节点和版本。
- AI 只生成草稿；人工确认后才成为正式版本。
- 实验记录复用现有 `ExperimentRecord`，首期支持手动记录和外部资产引用。
- 关键字段在提交后锁定；修改生成 amendment/version，不覆盖原记录。
- 分析结果可保存 Markdown/结构化摘要、指标、引用和结论。
- 失败实验保留 `FAILED` 状态，并要求填写失败原因或后续行动。

### 2.7 研究快照、导师 HITL 和跨组件待办

首期快照卡片固定为：

| 快照         | 触发条件                        | 保存内容                                     |
| ------------ | ------------------------------- | -------------------------------------------- |
| 文献调研快照 | 文献/检索结果确认               | query 摘要、来源、知识库、引用版本和人工备注 |
| 实验执行快照 | 手动实验提交或 Phase 2 外部回执 | 目标、参数、状态、责任人和运行引用           |
| 实验数据快照 | 资产/文件关联完成               | asset ID、文件 hash、来源、版本和权限        |
| 分析结果快照 | 分析结果人工确认                | 方法、输入引用、指标、结论和工具版本         |
| 论文调研快照 | 论文资料整理完成                | 文献引用、主题、版本和后续写作任务           |
| 其他过程快照 | 研究笔记/交流/审批确认          | 事件范围、摘要、操作者和决策                 |

阶段节点与快照不要求首期强制线性推进：预实验、实验、分析和迭代允许重复；开题、论文写作、结题和转化先作为可见的后续节点占位，避免后续扩展时重新迁移 Chain 图结构。

WeKnora 已部署并由 RAGPortal 作为入库入口使用；Plane 不新增图谱 ingestion adapter，只记录 RAGPortal 返回的知识库/条目/解析状态和引用关系。

导师 Human-in-the-Loop 流程：AI 草稿 → 学生提交 → 导师/课题组主 PI 收到待办 → 预览输入/引用/修改 diff → 接受、退回或要求补充 → 追加 `HUMAN_DECISION` 和 `APPROVAL` 事件。导师审批不直接覆盖 AI 输出，退回必须填写原因。

跨组件待办由 Plane 聚合 adapter 返回的待办引用；每条待办包含 `source_system`、`source_id`、`chain_id`、`node_id`、`assignee_id`、`due_at`、`status`、`deep_link` 和 `degraded`。待办完成必须回写来源系统或记录明确的本地完成依据。

## 3. 开发任务

### 任务 1.1：平行课题和课题 ACL

- 实现 `RESEARCH_CHAIN` 创建、列表、详情、归档、恢复和成员管理。
- 增加 `chain_visibility` 和协作者授权。
- 修改查询、搜索、Context、文件、外部引用和导出统一走课题 ACL。
- 保留 `LEGACY_TRAINING` 的历史唯一性。

依赖：Phase 0 任务 0.2。验收：同一用户创建两个课题成功，未授权用户无法通过列表、详情、搜索或直链访问。

### 任务 1.2：Chain 节点、循环、快照和事件

- 实现节点创建、启动、暂停、完成、失败、回溯和重新提交。
- 实现父子节点、loop iteration、引用快照和 append-only event。
- 增加时间线、Chain Markdown 导出和来源降级标记。

依赖：1.1、Phase 0 契约。验收：循环节点可回放，重复请求幂等，正式快照不能覆盖。

### 任务 1.3：Plane 首页和课题门户

- 增加 Research Chain 卡片、科研待办、Agent 分析和组件入口。
- 实现课题上下文保持、空态、错误态、降级态和加载态。
- 通过同源代理/BFF 打开 RAGPortal 和 Synlora。
- 实现通用 Agent 插件壳、课题/节点 scope provider、消息流、工具卡、产物抽屉和 Trace 面板。
- 实现 loading/empty/forbidden/degraded/streaming/saving/error 状态和课题切换清理。
- 在科研侧栏新增 Research Chain 一级入口，同时保留所有现有 Plane/科研入口和“添加项目”流程。
- 更新科研总览：增加 Research Chain 摘要卡和跳转，不在总览复制完整 Chain 时间线。

依赖：1.1、Phase 0 任务 0.6。验收：不同角色看到不同入口；关闭开关不影响原首页。

### 任务 1.4：RAGPortal 上传与引用

- 实现课题/节点绑定上传、知识库列表、状态刷新和失败重试。
- 写入 ExternalReference、LiteratureEntry 或 Stage Material 引用。
- 实现 LINK_ONLY/HIDDEN 降级和撤权传播。

依赖：Phase 0 任务 0.3、1.1。验收：PDF/Markdown 等允许文件可上传，上传状态可追踪，跨课题不能引用。

### 任务 1.5：Synlora session 和 Trace

- 创建带课题 metadata 的 session。
- 注入 Context ID 和授权 KB 集合。
- 消费 SSE/事件并映射为 Chain Event。
- 展示工具调用、摘要、中间产物、验证和人工决策。
- 支持插件中的停止生成、断线重连、事件游标、审批弹窗和结果保存回 Chain。

依赖：Phase 0 任务 0.4、1.2。验收：跨课题 Context 不串；断线重连和重复事件不会产生重复事实。

### 任务 1.6：研究计划、实验和分析

- 研究计划草稿生成、人工编辑、导师确认和版本差异。
- 手动实验记录、失败记录、附件/外部资产引用和提交锁定。
- 分析结果保存、指标、结论和 Chain Snapshot。
- 在插件产物抽屉提供“预览 → 编辑 → 选择保存类型 → 人工确认 → 写入版本/快照”的完整流程。
- 实现六类研究快照卡片、导师/PI 待办、修改 diff、退回原因和跨组件待办聚合。

依赖：1.2、1.5。验收：AI 草稿不能直接成为正式计划；实验修改生成新版本；失败实验可检索和回放。

### 任务 1.7：E2E、灰度和用户支持

- 准备学生、导师、PI、管理员、Guest、未绑定账号测试夹具。
- 执行完整闭环、权限负例、降级、审计回放和导出测试。
- 在单一内部 Workspace 灰度，提供操作说明和问题回滚流程。

依赖：1.1–1.6。验收：E2E 和 P0/P1 回归通过，灰度期间错误率和外部降级可观测。

## 4. 测试与验收

### 4.1 后端和契约测试

- 课题创建、可见性、成员、归档、恢复和 ACL。
- Chain 节点状态、循环、事件顺序、快照不可变和幂等。
- RAGPortal 上传、状态、引用、撤权、超时和降级。
- Synlora session metadata、Context scope、tool approval、SSE 断线和事件重复。
- Page/报告/实验/文件与 Chain 引用的版本一致性。

### 4.2 前端验收

- 首页、课题页和时间线在加载、空、错误、降级和无权限状态下可理解。
- 课题切换后所有卡片、对话和入口刷新到正确 scope。
- 节点循环、回溯、重新提交和快照详情可操作。
- AI 草稿、人工修改、导师确认和审计信息可见。
- 六类快照可以创建、筛选、查看引用和回放，导师退回会生成可见原因和待办状态。
- `COMMUNICATION`、`APPROVAL`、`DATA_CHANGE` 和 `DEGRADED` 事件可以在时间线中区分显示。
- 插件入口、侧边工作台、上下文摘要、消息流、工具卡、审批、产物抽屉和 Trace 时间线在桌面/窄屏布局均可用。
- 课题切换、Session 关闭、SSE 断线重连、停止生成和保存失败恢复符合状态字典。
- 首页、草稿、我的工作、便签、工作区项目、More、添加项目及全部现有科研入口继续可见且功能不回归；Research Chain 按 capability 单独显隐。

### 4.3 端到端场景

1. 学生创建课题 A（Workspace 可见）和课题 B（PRIVATE）。
2. 在 A 上传文献、检索、讨论选题并生成计划。
3. 在 B 创建实验记录和失败分析。
4. 使用导师账号确认 A 的计划；使用 Guest 和未绑定账号尝试访问 A/B，全部拒绝。
5. 停止 RAGPortal 或 Synlora，仍能新增人工实验记录并看到 degraded 状态。
6. 导出 Chain Markdown，核对引用、版本、hash 和事件顺序。
7. 从课题 A 切换到课题 B，验证旧 session、SSE、工具结果和缓存不会进入 B；关闭插件 flag 后入口和 BFF 写操作均被拒绝。
8. AI 生成计划后由导师退回并再次确认，验证 diff、退回原因、待办和 Chain Event 顺序完整。

## 5. 发布、回滚与风险

- 先启用内部测试账号，再扩展到一个 Workspace，最后按 Workspace 灰度。
- 关闭 Chain/Agent/RAG 子开关可停止新入口；已有事件、快照和引用保持只读。
- RAGPortal 或 Synlora 出现持续错误时，切换 LINK_ONLY/HIDDEN 并保留人工记录。
- 数据迁移只新增结构；回滚代码前先关闭写入开关，确保历史事件和快照可读取。
- 风险：Agent 事件量快速增长。处理：事件摘要、分页回放、冷热存储和保留策略在上线前确定。

## 6. 详细数据与接口设计

### 6.1 Chain 创建与课题权限

创建请求：

```json
{
  "project_name": "课题 A",
  "identifier": "RC-A",
  "chain_kind": "RESEARCH_CHAIN",
  "visibility": "PRIVATE",
  "collaborator_ids": [],
  "primary_advisor_id": "user_..."
}
```

后端必须校验：调用者有 Workspace 科研创建能力；所有协作者属于 Workspace；导师绑定有效；`identifier` 在 Workspace 内唯一；`PRIVATE` 不得自动扩大到组织或全员。

课题权限返回 capability map：

```json
{
  "can_view": true,
  "can_edit": true,
  "can_manage_members": false,
  "can_submit_for_review": true,
  "can_approve": false,
  "can_export": false,
  "can_start_agent": true
}
```

前端只使用 capability map 展示按钮；后端每次操作再次计算 ACL。

### 6.2 节点状态机和事件

允许的状态迁移：

```text
DRAFT → ACTIVE → WAITING_HUMAN → COMPLETED
   │       │             └──────→ NEEDS_REVISION
   │       └────────────────────→ FAILED
   └────────────────────────────→ ARCHIVED
NEEDS_REVISION → ACTIVE
FAILED → ACTIVE | ARCHIVED
```

禁止客户端直接把 `DRAFT` 改成 `COMPLETED`；必须通过 service 运行验证和权限检查。节点事件类型至少包括：`NODE_CREATED`、`NODE_STARTED`、`AI_ACTION`、`TOOL_CALL`、`ARTIFACT_CREATED`、`VALIDATION_PASSED`、`VALIDATION_FAILED`、`HUMAN_DECISION`、`NODE_COMPLETED`、`NODE_FAILED`、`NODE_RETRIED` 和 `NODE_ARCHIVED`。

事件请求示例：

```json
{
  "event_type": "HUMAN_DECISION",
  "request_id": "req_...",
  "source_system": "plane",
  "actor": { "type": "user", "id": "user_..." },
  "summary": "确认研究计划草稿",
  "decision": "ACCEPT",
  "input_refs": [{ "kind": "plan", "id": "...", "version": 2 }],
  "output_refs": [],
  "content_hash": "sha256:..."
}
```

### 6.3 Snapshot 和 Timeline

Snapshot 只允许引用调用者可见对象。生成时重新执行 ACL，不信任前端传入的对象列表。返回：

```json
{
  "snapshot_id": "snap_...",
  "version": 3,
  "node_id": "node_...",
  "resources": [{ "kind": "literature", "id": "...", "version": 1, "source": "ragportal", "hash": "sha256:..." }],
  "event_range": { "first": "evt_...", "last": "evt_..." },
  "immutable": true
}
```

Timeline 接口支持 `chain=thinking|development|all`、`stage`、`source_system` 和游标分页；正文引用默认返回标题、摘要、来源、版本和链接，调用者无权时返回降级/隐藏状态而不是泄露资源存在性。

### 6.4 RAGPortal 接口与课题绑定

Plane BFF 建议接口：

```text
GET  /api/research/workspaces/{slug}/chains/{chain_id}/knowledge-bases
POST /api/research/workspaces/{slug}/chains/{chain_id}/uploads
GET  /api/research/workspaces/{slug}/chains/{chain_id}/uploads/{upload_id}
POST /api/research/workspaces/{slug}/chains/{chain_id}/references
```

上传由 Plane 接收并转发，表单 metadata 至少包含 `chain_id`、`node_id`、`filename`、`content_type`、`size` 和 `sha256`。服务端执行文件类型、大小、恶意内容扫描和课题 ACL；RAGPortal 返回的 `knowledge_id/kb_id/task_id` 写入外部引用。

同一 `sha256 + chain_id + node_id` 默认幂等；不同文件内容不得复用旧 upload ID。引用动作记录引用者、检索 query 摘要、知识库范围和 source version。

### 6.5 Synlora Session/Trace 接口

Plane 到 Synlora 的创建请求扩展为：

```json
{
  "assistant_id": "research-general",
  "title": "课题 A 调研",
  "research_context": {
    "workspace_id": "...",
    "research_project_id": "...",
    "chain_node_id": "...",
    "context_id": "ctx_...",
    "allowed_knowledge_base_ids": ["kb_..."],
    "context_hash": "sha256:..."
  }
}
```

事件消费采用 `after_seq` 游标；每个事件先按 `run_id + seq` 去重，再投影成 Plane Chain Event。reasoning 只保存可解释摘要或模型明确返回的说明，不保存隐藏思维链。工具结果大对象存原系统或文件工作区，Plane 保存引用和 hash。

### 6.6 研究计划、实验记录和分析结果

研究计划状态：`DRAFT`、`PENDING_HUMAN_REVIEW`、`ACCEPTED`、`REJECTED`、`SUPERSEDED`。只有 `ACCEPTED` 版本可作为后续实验节点的正式输入。

实验记录首期字段：目标、假设、方法、参数、环境、输入资产引用、输出资产引用、结果、指标、结论、失败原因、状态和责任人。提交后关键字段锁定，修改必须创建 amendment 和新 version。

分析结果至少包含：分析方法、输入引用、输出摘要、指标、置信/质量说明、结论、操作者、工具/模型版本和关联节点。

## 7. 代码落点与接口实现顺序

### 7.1 Plane 后端

```text
apps/api/plane/db/models/research/chain.py
apps/api/plane/db/models/research/chain_event.py
apps/api/plane/db/migrations/01xx_research_chain_mvp.py
apps/api/plane/research/views/chain.py
apps/api/plane/research/views/chain_events.py
apps/api/plane/research/views/knowledge.py
apps/api/plane/research/views/agent.py
apps/api/plane/research/serializers/chain.py
apps/api/plane/research/services/chain_projection.py
apps/api/plane/research/services/ragportal.py
apps/api/plane/research/services/synlora.py
apps/api/plane/tests/contract/app/test_research_chain_mvp.py
apps/api/plane/tests/contract/app/test_research_chain_permissions.py
```

实现顺序：课题/ACL → 节点/状态机 → Event/Snapshot → RAGPortal BFF → Synlora Trace → 计划/实验/分析 → 导出。

### 7.2 Plane 前端

```text
apps/web/core/components/research/chain/
apps/web/core/components/research/chain-timeline/
apps/web/core/components/research/agent-panel/
apps/web/core/services/research/chain.service.ts
apps/web/core/services/research/agent.service.ts
apps/web/core/store/research/chain.store.ts
apps/web/app/(all)/[workspaceSlug]/(projects)/research/chains/
```

前端状态必须区分 `loading`、`empty`、`degraded`、`forbidden`、`error` 和 `ready`；Trace 流式事件采用游标合并，不能按到达时间覆盖已存在事件。

### 7.3 跨仓开发顺序

1. Plane 先发布课题和 Context contract。
2. RAGPortal 接入课题 metadata 和 upload fixture。
3. Synlora 接入 research_context 和 event cursor。
4. Plane 消费事件并实现 Chain projection。
5. 最后开放首页入口和 Workspace 灰度开关。

## 8. 测试命令与验收证据

```bash
cd plane
docker compose -f docker-compose-test.yml run --rm api-tests pytest -q \
  apps/api/plane/tests/contract/app/test_research_chain_mvp.py \
  apps/api/plane/tests/contract/app/test_research_chain_permissions.py \
  apps/api/plane/tests/contract/app/test_research_context.py
pnpm check:types
pnpm check:lint
pnpm build
```

RAGPortal 和 Synlora 分别执行各仓库的后端单测、contract fixture、前端构建和 SSE/工具测试。验收包必须包含：两个课题 E2E 录屏或日志、权限负例报告、事件回放结果、RAG 降级结果、Trace 游标重连结果和导出文件 hash。

## 9. 任务拆分与完成门禁

| 任务            | 前置          | 交付                        | 门禁                 |
| --------------- | ------------- | --------------------------- | -------------------- |
| 平行课题/ACL    | Phase 0 0.2   | API、迁移、权限测试         | 双课题和撤权通过     |
| Chain 状态/事件 | 平行课题      | service、snapshot、timeline | 状态机和幂等通过     |
| 门户骨架        | Phase 0 0.6   | 首页卡片、路由、空态        | 原功能无回归         |
| RAGPortal BFF   | Phase 0 0.3   | 上传/状态/引用              | fixture 和降级通过   |
| Synlora Trace   | Phase 0 0.4   | session、SSE、projection    | 跨课题和断线重连通过 |
| 计划/实验/分析  | Chain + Agent | Page、Experiment、analysis  | 版本/失败记录通过    |
| E2E 灰度        | 全部          | 测试夹具、runbook           | P0/P1 回归和闭环通过 |

任一门禁失败时，只允许保留人工记录模式，不开放对应 Agent/RAG 写操作。

## 10. 插件 MVP 完成清单

- [ ] Plane 首页、Chain 页面和 Node 详情具备一致的 Agent 入口。
- [ ] 桌面侧边工作台和窄屏上下布局通过视觉验收。
- [ ] 当前课题/节点/Context 摘要可见且不可手工扩大 scope。
- [ ] 对话流、停止、重连、工具卡、审批、产物保存和 Trace 回放可用。
- [ ] 研究计划/文献引用/分析摘要保存均经过人工确认并生成 Chain Event。
- [ ] 外部降级、无权限、Context 过期和保存失败都有替代路径。
