# 科研智能体平台 Phase 2 实施计划：实验运行与垂类科研能力

| 项目     | 内容                                                                                                                                                                                                   |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 计划版本 | v1.3                                                                                                                                                                                                   |
| 上游 PRD | [`research-intelligent-platform-prd.md`](./research-intelligent-platform-prd.md) §6–§10                                                                                                                |
| 前置计划 | [`research-intelligent-platform-phase-0-plan.md`](./research-intelligent-platform-phase-0-plan.md)、[`research-intelligent-platform-phase-1-plan.md`](./research-intelligent-platform-phase-1-plan.md) |
| 计划状态 | 待评审                                                                                                                                                                                                 |
| 目标     | 将 SpecLabOS、PolyAgent 和 SpecAgent 作为受控实验/分析能力接入 Research Chain                                                                                                                          |
| 不在范围 | 未经契约确认的谱种、HPC 全量接入、ScienceDiscovery 公网多租户化                                                                                                                                        |

## 1. 阶段目标与出口

Phase 2 不改变 Plane 是科研主数据和权限权威的原则。专业系统负责执行、算法和原始数据；Plane 保存任务引用、状态、回执、版本和审计。

出口条件：

- 至少一种 SpecLabOS 实验能力可以从课题节点受控发起、跟踪、取消和回执。
- 至少一种 PolyAgent 或 SpecAgent 分析能力可以受控调用并写回结果快照。
- `job_id`、`run_id`、`trace_id`、`artifact_id` 在跨系统链路中可关联。
- 设备/算法失败、超时、重试、取消和重复回调不会破坏 Research Chain。
- 工具白名单、人工确认、资源配额和调用审计生效。

## 2. 技术方案

### 2.1 统一运行任务模型

Plane 侧增加外部任务引用或扩展现有外部引用，不复制专业系统内部 Job 表。统一状态：

```text
QUEUED → RUNNING → COMPLETED
                 ↘ FAILED
                 ↘ CANCELLED
                 ↘ BLOCKED_APPROVAL
```

任务字段：

- `job_id`：平台任务 ID。
- `run_id`：专业系统运行 ID。
- `chain_id` / `node_id`：Research Chain 归属。
- `source_system` / `operation`：来源和能力。
- `input_digest` / `manifest_version`：输入和契约版本。
- `artifact_refs`：结果文件、DataAsset 或报告引用。
- `attempt`、`request_id`、`status`、`error_code`、`started_at`、`finished_at`。

统一回调按 `job_id + event_id` 幂等；状态只能按允许的状态图推进，迟到事件写入审计但不得倒退正式状态。

### 2.2 SpecLabOS Experiment Runtime

Plane/PolyAgent 通过 SpecLabOS `ExternalExperimentDispatch` 发起实验：

1. 课题节点提交实验目标、参数、条件和设备/模板引用。
2. PolyAgent 或 Plane 生成版本化 dispatch manifest 和 preview digest。
3. 人工确认后调用 SpecLabOS dispatch API。
4. 读取 SmartAccess run 状态和不可变 RunEvent。
5. SpecLabOS 将 DataAsset、文件 hash、设备和运行日志作为资产引用。
6. Plane 写入 Chain Event/Snapshot，原始文件继续留在 MinIO/Mongo 权威系统。

权限边界：Plane 校验课题、节点、工具和设备权限；SpecLabOS 再校验用户/service token 和设备权限；两侧任一拒绝都不能创建运行。

### 2.3 PolyAgent ResearchEngine

复用 PolyAgent 的 ProblemSpec、ResearchRun、StageRun、GateReview、AlgorithmRun 和 traceability：

- Plane 节点映射到 PolyAgent 的 ProblemSpec 或 ResearchStageKey。
- 计划/实验/分析阶段映射到 ResearchRun/StageRun。
- GateDecision 映射到 Plane Validator/Human Decision。
- Experiment Dispatch manifest 保存参数映射、preview digest、selection/provenance、external receipt 或 dispatch error。
- PolyAgent 原始 Trace 是执行事实源，Plane 保存引用和 ACL 过滤后的投影。

不得在 Plane 重建算法运行时、垂类工具注册表或高分子数据目录。

### 2.4 SpecAgent Synlora 插件

首期仅接入已验证的 NMR 三件套：

- `spec.nmr.forward`
- `spec.nmr.reverse`
- `spec.nmr.search`

插件配置由 Synlora 加密保存，优先使用按用户代签的 AI4MS token。工具调用需要 scope、输入校验、超时、错误归一化和用户确认；Plane 写入工具输入摘要、输出摘要、候选引用、用户确认和结果快照。

IR/Raman/GPC/LCMS 以及异步 Job Registry 需要独立服务契约、版本和容量验证，不能因 NMR 插件可用而默认纳入。

### 2.5 工具治理与资源控制

- Plane 提供课题/节点/角色级 capability scope。
- Synlora/PolyAgent 提供工具白名单、审批和执行沙箱。
- SpecLabOS 提供设备锁、节点心跳、运行超时和设备级权限。
- 每个任务记录调用者、审批者、服务身份、工具版本、输入摘要、输出引用和耗时。
- 失败重试使用指数退避和最大次数；不可重试的权限/参数错误直接失败。
- 实验和分析任务加入每用户、每课题和 Workspace 配额，防止单个课题耗尽资源。

### 2.6 组件入口和跨系统待办

Phase 2 的 Plane Agent 插件和欢迎页统一显示专业组件入口：

- SpecLabOS 实验运行、设备/模板和数据资产。
- PolyAgent ResearchEngine、算法运行和 Gate。
- SpecAgent NMR 工具和后续垂类能力。

入口卡片显示来源系统、健康状态、所需权限、最近运行和深链；不可用时显示 `DEGRADED`，不隐藏已存在的历史结果。专业系统产生的待办通过统一 `source_system/source_id/assignee/deep_link/status` 结构聚合到 Plane，完成动作后回写来源系统或追加本地确认事件。

### 2.7 WeKnora 服务状态与自动 ELN 沉淀

WeKnora 已部署在内网 `http://10.26.15.93:8000/`，不在本项目中开发。RAGPortal 是唯一入库入口：Plane 只调用 RAGPortal 的上传、状态和引用接口，RAGPortal 负责调用 WeKnora、解析资料并返回知识库/条目/任务状态。

Phase 2 只做平台侧能力：

- 将 RAGPortal 返回的 `knowledge_id`、`kb_id`、解析状态、版本和 hash 关联到 Research Chain。
- 在 Plane/Agent UI 显示 RAGPortal/WeKnora 健康状态、解析中、完成、失败和重试入口。
- 不新增 WeKnora 数据库写入、图谱 ingestion adapter 或底层索引管理。
- 如果 RAGPortal 扩展图谱/关系配置，Plane 只透传受控参数并保存外部任务状态。

自动 ELN 规则：SpecLabOS/PolyAgent 运行回执必须映射为 Experiment Record 的只读外部段，包括运行 ID、设备/算法、输入摘要、参数版本、DataAsset、结果 hash、状态和时间。用户可以补充科研解释、结论和失败原因，但不能覆盖权威运行字段；修订通过 amendment 产生新版本。

### 2.6 Plane 通用 Agent 插件的工具协作面板

Phase 2 将 Phase 1 的通用 Agent 插件扩展为专业能力工作台：

- 实验工具卡：设备/模板、参数摘要、preview digest、风险等级、审批人和 dispatch 状态。
- 分析工具卡：算法/谱学工具、输入资产、版本、预计耗时、输出类型和引用来源。
- Job 面板：queued/running/blocked/completed/failed/cancelled、RunEvent、队列等待、重试和取消。
- 结果确认：预览 Markdown/结构化结果/图表元数据，选择“保存为分析结果”“关联实验”“退回重试”或“仅保留外部引用”。
- Trace 面板：工具调用、审批、运行回执、DataAsset、错误和 Chain Snapshot 关联。

交互约束：

1. 任何可能启动实验、消耗计算资源或访问敏感资产的操作都先显示参数摘要和权限范围。
2. 点击确认后按钮进入 pending，直到收到上游 accepted/failed；禁止重复点击产生多个 job。
3. 运行失败提供错误分类、重试原因和人工记录替代入口；不可重试错误不显示无限重试。
4. 取消操作显示“请求取消”和“已取消/取消失败”两个状态，不能把请求发送成功当作运行已停止。
5. 插件不直接渲染未经 ACL 过滤的原始 DataAsset；只显示摘要、hash 和权威系统链接。

## 3. 开发任务

### 任务 2.1：统一 Job/Run/Artifact 映射

- 建立 `job-status.v1`、回调和状态机校验。
- 扩展 Chain Node/ExternalReference 关联 job、run、artifact 和 manifest。
- 实现幂等回调、迟到事件、取消和重试策略。

依赖：Phase 1 任务 1.2、Phase 0 契约。验收：重复、乱序和迟到回调不破坏状态或产生重复快照。

### 任务 2.2：SpecLabOS Dispatch 适配

- 实现模板/参数预览、preview digest 校验和人工确认。
- 调用 External Experiment Dispatch。
- 订阅/轮询 SmartAccess Run 和 RunEvent。
- 关联 DataAsset、MinIO 文件 hash、设备和实验日志。

依赖：2.1、SpecLabOS API contract。验收：模拟设备和真实受控设备均能完成创建、运行、失败、取消和回执。

### 任务 2.3：PolyAgent ResearchEngine 适配

- 建立 ProblemSpec/ResearchRun/StageRun/Gate 与 Chain Node 的映射。
- 接入 Tool Catalog、审批和 traceability。
- 保存 experiment-dispatch manifest、参数绑定和 external receipt。

依赖：2.1、PolyAgent contract。验收：算法或阶段 Gate 通过/拒绝/重试可在 Plane 节点回放。

### 任务 2.4：SpecAgent NMR 插件生产化

- 固化插件 manifest、版本、base_url、token reference 和健康检查。
- 实现 forward/reverse/search 输入校验、超时和错误分类。
- 将输出候选和人工选择写入 Chain Snapshot。

依赖：2.1、独立 SpecAgent 上游契约。验收：正常、参数错误、上游 401、超时和服务不可用均有可解释结果。

### 任务 2.5：工具治理、配额和审批

- 增加课题/角色 capability scope 和工具白名单。
- 实现高风险实验/计算的强制确认。
- 增加用户、课题、Workspace 级并发/额度限制。
- 建立资源使用统计和超额拒绝事件。

### 任务 2.5a：RAGPortal/WeKnora 状态和自动 ELN 适配

- 与 RAGPortal 维护方冻结上传、知识库、解析状态、引用和错误回执契约。
- 配置 WeKnora 内网健康检查和 RAGPortal 侧重试/降级状态展示。
- 将 SpecLabOS/PolyAgent 回执映射为 Experiment Record 外部段、DataAsset 引用和 `DATA_CHANGE` 事件。
- 复用 ExperimentAmendment 处理人工解释修订，禁止覆盖原始运行字段。

依赖：2.1–2.3、RAGPortal 正式接口。验收：RAGPortal/WeKnora 不可用时 ELN 仍可保存；重复上传/引用不产生重复外部关系；无权课题 metadata 不会出站。

依赖：2.2–2.4。验收：无权限、超额、未确认和沙箱失败均 fail-closed。

### 任务 2.6：前端运行面板和数据快照

- 在 Chain 节点显示 Job 状态、RunEvent、工具调用、审批和 DataAsset。
- 支持取消、重试、查看失败原因和打开权威系统链接。
- 显示来源系统、版本、hash、降级和最后同步时间。
- 在 Plane 通用 Agent 插件中实现实验/分析工具卡、preview/confirm、Job 状态、RunEvent、结果确认、重试/取消和 Chain 保存。
- 增加专业组件入口卡、健康状态、最近运行和跨组件待办聚合。

依赖：2.1–2.5。验收：刷新/断线后状态一致，用户无法访问无权资产。

### 任务 2.7：故障演练与发布

- 演练设备离线、节点失联、服务 5xx、消息重复、回执迟到和 MinIO 不可用。
- 形成重试、人工接管、回滚和数据补偿 runbook。
- 受控 Workspace 灰度，不自动开放全部工具。

依赖：2.1–2.6。验收：故障恢复后 Chain 可继续，原始权威数据不被 Plane 覆盖。

## 4. 测试与验收

### 4.1 Contract 和状态机

- SpecLabOS Dispatch、Run、RunEvent、DataAsset。
- PolyAgent ProblemSpec、ResearchRun、Stage/Gate、Trace。
- SpecAgent NMR 输入输出和错误分类。
- job 状态合法迁移、幂等、乱序、迟到和取消。

### 4.2 权限与安全

- 学生只能调用其课题授权工具和设备。
- 导师/PI 可审批但不能绕过设备权限。
- Guest/未绑定账号无法调用、查看结果或下载 DataAsset。
- token、API Key、原始数据和敏感参数不进入前端日志或 Chain Event。
- 工具输入、文件和外部 URL 经过大小、类型、白名单和沙箱限制。
- RAGPortal 入库状态、ELN 自动回执和 DataAsset 引用均执行课题 ACL；出站 metadata 不含未授权正文或其他课题内容。

### 4.3 端到端场景

1. 课题节点生成实验 manifest，预览 digest 与正式调用一致。
2. SpecLabOS 返回 queued/running/completed，RunEvent 和 DataAsset 出现在 Chain。
3. 设备离线导致 failed，用户可查看原因、重试或人工记录替代结果。
4. PolyAgent Gate 拒绝后节点进入 NEEDS_REVISION，不生成完成快照。
5. SpecAgent NMR search 返回候选，用户确认候选后生成分析快照。
6. 重复 callback、SSE 断线和任务取消不会重复扣除配额或生成重复事实。
7. 从 Agent 插件发起高风险实验，确认前不创建上游 run；确认后重复点击只生成一个 job；取消请求和最终运行状态分别展示。
8. SpecLabOS/PolyAgent/SpecAgent 任一服务不可用时，入口和历史快照可见，新的高风险操作被阻断并进入 degraded 待办。
9. SpecLabOS 运行完成后自动生成 ELN 外部段和数据快照；用户补充结论后生成 amendment，不覆盖设备运行字段；RAGPortal/WeKnora 解析延迟时主流程不中断。

### 4.4 性能与容量

- 统计任务排队时间、运行时间、回调延迟、失败率和重试次数。
- 在目标规模下压测 Agent/Job 并发、回调峰值、DataAsset 元数据写入和 Chain 回放。
- 明确设备/算法服务独立 SLA；Plane 只保证提交、状态投影和降级体验。

## 5. 发布、回滚与风险

- 各专业能力以独立 capability flag 灰度，默认只启用模拟或低风险工具。
- 外部服务异常时关闭对应 capability，保留已有引用和手动记录。
- 回滚 Plane adapter 不删除专业系统已产生的运行和资产；恢复后通过 request/run ID 补偿同步。
- 风险：专业系统接口和版本不同步。处理：固定 contract fixture、schema version 和兼容窗口。
- 风险：自动实验产生不可逆副作用。处理：强制人工确认、设备权限二次校验、幂等键和取消窗口。

## 6. 详细接口、数据和状态设计

### 6.1 平台 Job 记录

建议新增或扩展 `ResearchExternalJob`，只保存平台关联和状态：

| 字段                                        | 说明                                      |
| ------------------------------------------- | ----------------------------------------- |
| `job_id`                                    | Plane 生成的全局任务 ID                   |
| `chain_id` / `node_id`                      | Research Chain 归属                       |
| `source_system`                             | `SPECLABOS` / `POLY_AGENT` / `SPEC_AGENT` |
| `operation`                                 | 能力或 API 操作名                         |
| `run_id` / `external_id`                    | 上游运行和任务 ID                         |
| `manifest_version` / `input_digest`         | 输入契约与摘要                            |
| `status`                                    | 统一 Job 状态                             |
| `attempt` / `max_attempts`                  | 重试控制                                  |
| `artifact_refs`                             | DataAsset、文件、报告或结果引用           |
| `last_event_id`                             | 上游最后消费的事件                        |
| `error_code` / `error_summary`              | 脱敏错误信息                              |
| `created_at` / `started_at` / `finished_at` | 时间字段                                  |

唯一约束建议为 `source_system + external_id` 和 `job_id + event_id`；上游 ID 不存在时使用 Plane request id 和 manifest digest 防止重复提交。

### 6.2 SpecLabOS 调用契约

Plane/PolyAgent 发起前先生成：

```json
{
  "source_system": "poly_agent",
  "source_run_id": "run_...",
  "experiment_name": "实验批次",
  "object": { "type": "polymer", "reference": "..." },
  "conditions": { "parameters": {}, "metadata": {} },
  "optimization_context": {},
  "extra_metadata": {
    "research_project_id": "...",
    "chain_node_id": "...",
    "manifest_version": "experiment-dispatch.v1",
    "preview_digest": "sha256:..."
  }
}
```

正式 dispatch 前必须重新计算 digest，防止预览和执行之间参数漂移。成功返回需保存 `dispatch_id`、`status=received`、`received_at`；失败保存脱敏 `dispatch_error`。

运行状态通过 SmartAccess/SpecLabOS 查询或事件同步：`queued`、`accepted`、`running`、`step_started`、`completed`、`failed`、`finished`、`cancelled`。迟到或重复事件只写审计，不倒退已完成状态。

### 6.3 PolyAgent 映射

| Plane 概念               | PolyAgent 概念                         | 映射要求                            |
| ------------------------ | -------------------------------------- | ----------------------------------- |
| Chain                    | ProblemSpec/ResearchRun                | 保存外部 ID、版本和 source URL      |
| Experiment/Analysis Node | ResearchStageRun/AlgorithmRun          | 保存 stage key、输入快照和执行状态  |
| Validator                | GateReview/GateDecision                | 保存通过/拒绝、actor、reason 和时间 |
| Artifact                 | algorithm artifact/Data Catalog object | 只引用外部资产和 hash               |
| Agent Trace              | assistant traceability                 | 保存 trace ID 和事件游标            |

PolyAgent 的原始运行和审计是执行事实源；Plane 只能保存投影和权限过滤后的可见信息。

### 6.4 SpecAgent NMR 契约

Synlora 插件调用：

```text
POST {base_url}/api/v1/nmrserver/forward
POST {base_url}/api/v1/nmrserver/reverse
POST {base_url}/api/v1/nmrserver/search
```

统一结果为 `code/message/data.items`，Plane 不保存完整敏感输入，保存输入摘要、输出候选摘要、工具版本、用户确认和结果 hash。错误分类：`timeout`、`connection_error`、`unauthorized`、`http_error`、`upstream_error`。

### 6.5 状态和回调处理

回调处理顺序：验签/鉴权 → 校验 schema version → 校验 job scope → 去重 → 校验状态迁移 → 写 Job 状态 → 写 Chain Event → 更新 Snapshot projection → 返回 ack。

任何一步失败：

- 鉴权/权限/Schema 错误：不重试，写拒绝审计。
- 网络/5xx/队列错误：指数退避，进入重试队列。
- 业务失败：标记 `FAILED`，不自动重试，允许用户显式重试。
- 重复事件：返回原 ack，不重复扣配额、不重复写快照。

## 7. 代码落点和实施顺序

### 7.1 Plane

```text
apps/api/plane/db/models/research/external_job.py
apps/api/plane/db/migrations/01xx_research_external_jobs.py
apps/api/plane/research/services/job_state_machine.py
apps/api/plane/research/services/speclabos.py
apps/api/plane/research/services/polyagent.py
apps/api/plane/research/services/job_callbacks.py
apps/api/plane/research/views/jobs.py
apps/api/plane/research/serializers/jobs.py
apps/api/plane/tests/contract/app/test_research_external_jobs.py
apps/api/plane/tests/unit/research/test_job_state_machine.py
```

### 7.2 Synlora 与专业服务

- Synlora：`apps/web/backend/catalog/plugins/spec_agent/`、插件工具测试、能力策略和 trace hook。
- PolyAgent：新增 Plane adapter/client 和 contract fixture，不复制其 ResearchEngine 实现。
- SpecLabOS：新增 external dispatch/run/data asset contract fixture；真实设备测试使用 `runtime.sim_mode` 或隔离节点。

### 7.3 前端

```text
apps/web/core/components/research/jobs/
apps/web/core/components/research/chain/ExternalRunPanel.tsx
apps/web/core/services/research/jobs.service.ts
apps/web/core/store/research/jobs.store.ts
```

前端显示来源系统、job/run 状态、最近事件、审批、重试/取消按钮和权威系统链接；永远不显示服务密钥和未经 ACL 过滤的原始数据。

## 8. 测试命令与验收证据

```bash
cd plane
docker compose -f docker-compose-test.yml run --rm api-tests pytest -q \
  apps/api/plane/tests/unit/research/test_job_state_machine.py \
  apps/api/plane/tests/contract/app/test_research_external_jobs.py
pnpm check:types
pnpm build
```

专业仓库分别运行：

- SpecLabOS 的 FastAPI/API、dispatcher、RunEvent、DataAsset 和模拟设备测试。
- PolyAgent 的 experiment dispatch、ResearchEngine、Gate、traceability 和 worker 测试。
- Synlora 的插件、工具策略、超时、代签 token 和 trace 测试。

验收证据包括：manifest digest 对比、job 状态回放、重复/乱序回调报告、权限矩阵、失败恢复记录、配额统计和 DataAsset hash。

## 9. 任务拆分与联调顺序

| 顺序 | 任务              | 依赖                 | 通过条件                              |
| ---- | ----------------- | -------------------- | ------------------------------------- |
| 1    | Job schema/状态机 | Phase 0 契约         | 状态迁移和幂等测试通过                |
| 2    | SpecLabOS adapter | 1、SpecLabOS fixture | dispatch/run/event/data contract 通过 |
| 3    | PolyAgent adapter | 1、PolyAgent fixture | ResearchRun/Gate/Trace 可回放         |
| 4    | SpecAgent 插件    | 1、上游 NMR contract | 三个接口正常和错误场景通过            |
| 5    | Tool scope/配额   | 2–4                  | 未授权/超额 fail-closed               |
| 6    | Job 前端和通知    | 1–5                  | 状态刷新、取消、重试和降级可用        |
| 7    | 故障演练/灰度     | 全部                 | runbook 和补偿流程通过                |

未完成真实服务契约或安全评审时，只能使用模拟运行，不得开放真实设备或高成本算法。

## 10. 通用 Agent 插件 Phase 2 完成清单

- [ ] 工具目录按研究课题和角色过滤，并显示 capability scope。
- [ ] 实验/分析工具卡展示参数、版本、风险、审批和来源。
- [ ] preview digest 与正式 dispatch 一致，重复确认不重复创建 job。
- [ ] Job 面板支持状态、RunEvent、重试、取消、失败原因和权威系统链接。
- [ ] 结果确认可保存为分析结果、实验关联、Artifact 引用或退回修改。
- [ ] 插件 Trace 与 `job_id`、`run_id`、`artifact_id`、Chain Snapshot 完整关联。
