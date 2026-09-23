# 科研智能体平台 Phase 3 实施计划：治理、规模化与开放

| 项目     | 内容                                                                                                                                                                                                                                                                                                       |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 计划版本 | v1.3                                                                                                                                                                                                                                                                                                       |
| 上游 PRD | [`research-intelligent-platform-prd.md`](./research-intelligent-platform-prd.md) §6、§8–§12                                                                                                                                                                                                                |
| 前置计划 | [`research-intelligent-platform-phase-0-plan.md`](./research-intelligent-platform-phase-0-plan.md)、[`research-intelligent-platform-phase-1-plan.md`](./research-intelligent-platform-phase-1-plan.md)、[`research-intelligent-platform-phase-2-plan.md`](./research-intelligent-platform-phase-2-plan.md) |
| 计划状态 | 待评审                                                                                                                                                                                                                                                                                                     |
| 目标     | 建立生产级科研治理、可复现、规模化、灾备和社会用户开放前置能力                                                                                                                                                                                                                                             |
| 不在范围 | 未通过安全、容量和合规门禁的公网开放                                                                                                                                                                                                                                                                       |

## 1. 阶段目标与出口

Phase 3 的重点是把前两期的过程记录和专业能力变成可治理、可审计、可扩展的平台。社会用户开放只是出口条件，不是默认发布动作。

出口条件：

- 伦理、数据安全、知识产权和可复现性规则可以在课题和节点级执行。
- Chain、Agent、外部调用、权限、任务和数据资产可以审计、脱敏导出和按策略保留/删除。
- ScienceDiscovery 可以作为隔离的本地/可信 Worker 接入，不能越权访问其他课题。
- Synlora 和外部适配器具备队列、限流、水平扩展、缓存隔离、备份和灾备能力。
- 约 500 名成员/100 名并发目标通过容量和故障演练；社会用户开放前置门禁全部通过。

## 2. 技术方案

### 2.1 科研治理模型

新增或扩展治理元数据，不复制正文：

- `ethics_classification`：是否需要伦理审查、审查状态和有效期。
- `data_classification`：公开、内部、敏感、受限和个人数据等级。
- `ip_policy`：成果归属、共享限制、外部发布审批。
- `reproducibility_status`：输入、代码、环境、seed、artifact 和执行日志完整性。
- `retention_policy`：事件、快照、Trace、外部引用和文件的保留期限。

治理规则由 Workspace Admin 配置，课题组主 PI/导师执行审批；规则命中时 Agent 工具和外部导出必须进入 `BLOCKED_APPROVAL`。

治理策略统一作用于 Plane capability broker。每次自动装配、工具放行、阻断和审批都必须记录 `policy_id`、`policy_version`、命中规则、输入摘要和决策时间；策略发布、回滚和撤回本身进入审计。

### 2.2 审计、证据和可复现链

统一审计包含：

- 用户/服务身份、课题、节点、动作、工具和来源系统。
- 输入/输出引用、版本、hash、Prompt Manifest、模型和工具版本。
- Validator、Human Decision、Approval、拒绝原因和撤权记录。
- 外部调用 request ID、状态、延迟、降级原因和补偿状态。

借鉴 ScienceDiscovery 的 CAS/Artifact、Prompt Manifest、Claim/Evidence/Provenance 和 Execution Run 概念，但权威数据仍归各系统。Plane 保存关联和审计投影，专业系统保存原始产物。

审计导出必须：

1. 根据调用者 ACL 过滤。
2. 脱敏 token、密钥、个人信息和受限正文。
3. 生成导出 manifest、范围、时间、操作者和 hash。
4. 支持审计包校验和撤销下载链接。

### 2.3 ScienceDiscovery Worker

ScienceDiscovery 当前为单用户/可信本地产品，Phase 3 只通过受治理 Worker 接入：

- Worker 与 Plane/Synlora 建立 mTLS 或短期用户/课题 token。
- 每个任务绑定 Workspace、课题、节点、run 和资源配额。
- Python/R/Shell 继续在 Bubblewrap/Seatbelt 或隔离容器中执行。
- MCP 工具采用来源白名单、输入校验、限流、队列超时和审计。
- 结果以 Artifact、Claim、Evidence、Provenance 和运行事件引用回写。
- Worker 不读取未授权课题、不共享本地缓存、不持有长期平台密钥。

如果未来部署为云端多租户服务，必须另立架构评审，不能直接暴露当前 loopback/单 bearer token 形态。

### 2.4 Synlora 规模化

- Agent run 使用持久队列和可恢复状态，而非单进程内存状态。
- SSE 通过事件游标和断点续传支持多实例。
- session、project、file 和 context cache 按 Workspace/课题隔离。
- 配置用户、课题、Workspace 级并发、token、工具调用、RAG 查询和存储配额。
- 外部调用设置超时、熔断、重试、限流和死信队列。
- Trace/事件冷热分层，保留可配置的原始事件期和长期摘要。
- 多实例、队列和缓存必须保留 delegated identity、`agent-context.v2`、capability scope、session 归属和 event cursor；节点迁移或重启后不能丢失、重放或串用授权。

### 2.5 社会用户和租户开放前置

社会用户开放必须先完成：

- 租户、Workspace、课题和文件的物理/逻辑隔离。
- OIDC/AccountLink、邀请、禁用、删除、导出和数据主体请求。
- 计费/配额、滥用防护、速率限制和异常检测。
- 隐私政策、数据处理协议、内容安全和外部模型数据边界。
- 客户级密钥、日志保留、备份恢复、RPO/RTO 和安全事件响应。

### 2.6 Plane 通用 Agent 插件的治理 UI

Phase 3 将治理能力直接呈现在 Plane 插件中，避免用户在 Agent、实验系统和审计后台之间失去上下文：

- 顶部 scope banner：当前 Workspace、课题、节点、数据等级、伦理状态和 Context 有效期。
- 工具授权提示：当前用户可用工具、需要导师/PI 审批的工具、剩余额度和阻断原因。
- 策略提示：显示当前 capability policy 版本、命中规则和最近生效时间。
- 风险确认抽屉：显示数据外发、实验执行、外部发布或高成本计算的影响、审批人和有效期。
- 审计入口：从消息、工具卡、Job 和产物直接打开对应 Trace Event、Approval、IntegrationCallLog 和 Chain Snapshot。
- 用量面板：按用户/课题/Workspace 显示 Agent run、RAG 查询、工具调用、实验任务、存储和配额。
- 管理员配置：工具白名单、模型路由、数据外发策略、保留期、审计级别和插件入口开关。

治理 UI 只展示后端策略结果；不能通过前端修改策略、扩大 scope 或绕过审批。策略服务不可用时，高风险按钮隐藏并显示阻断原因，人工低风险记录仍可继续。

### 2.7 写作/评审 Agent 与项目治理闭环

Phase 3 才开放写作 Agent、评审 Agent 和项目层治理能力：

- 写作 Agent 只能基于调用者可见且已确认的快照、引用、实验结果和成果元数据生成论文大纲、段落草稿、引用清单和一致性检查；草稿必须进入 Page/材料版本流，不能直接发布或替代作者署名。
- 评审 Agent 只能生成材料完整性、证据覆盖、可复现缺失项和风险提示；不能自动给出通过/拒绝的正式评审结论，最终决定仍由导师、课题组主 PI 或授权评审人提交。
- 里程碑、预算、风险和协作作为课题级对象关联 Chain Node；每项保存负责人、计划/实际日期、状态、风险等级、缓解措施、预算科目和审批引用。
- 结题/转化节点必须校验成果、论文、数据可复现状态、IP/伦理审批和外部发布策略；未满足治理 gate 时只能进入 `BLOCKED_APPROVAL`。

写作/评审 Agent 的所有建议、引用范围、模型/工具版本、人工修改和最终采纳状态必须进入 Trace 和 Chain Event，供后续审计与复现。

## 3. 开发任务

### 任务 3.1：治理元数据和规则引擎

- 增加伦理、数据分级、IP、可复现和 retention 字段/关联表。
- 实现规则配置、命中、审批、过期和撤回。
- 将治理 gate 接入 Plane capability broker、Agent 自动装配、Synlora 工具执行、外部导出、实验和社会用户操作。
- 为策略命中、阻断、豁免和回滚保存 `policy_id/policy_version` 和审计引用。
- 增加里程碑、预算、风险、协作、结题和转化对象的策略字段与审批关联。

依赖：Phase 2 任务 2.5。验收：受限课题的高风险工具和导出在未审批时 fail-closed。

### 任务 3.2：审计导出和生命周期

- 实现 Chain/Agent/Integration/Permission/Data Asset 审计查询。
- 生成脱敏导出包、manifest、hash 和短期下载链接。
- 实现 retention 到期归档/删除预览、审批和执行记录。
- 保留法律/审计需要的最小不可变元数据。

依赖：3.1、Phase 1/2 事件和引用。验收：不同角色只能导出授权范围，导出包可校验且不含 secrets。

### 任务 3.3：可复现与证据链

- 记录 Prompt Manifest、模型/工具版本、代码 commit、环境、seed、输入/输出 artifact。
- 建立 Claim/Evidence/Provenance 关联和缺失项检查。
- 对研究快照提供“可复现状态”和修复提示。

### 任务 3.3a：写作/评审 Agent 与项目治理

- 实现基于已确认快照和 ACL 过滤引用的写作 Agent context、草稿产物和人工采纳流。
- 实现评审 Agent 的完整性/证据/可复现检查，输出建议但不自动改变正式评审状态。
- 实现里程碑、预算、风险、协作、结题和转化的课题级模型、待办和治理 gate。
- 将写作/评审 Agent Trace、人工修改、采纳/拒绝和审批关联到 Chain。

依赖：3.1–3.3。验收：Agent 无法读取未确认/未授权材料，不能自动发布论文或通过评审；结题/转化缺少治理材料时被阻断。

依赖：3.1、Phase 2 任务 2.1。验收：同一快照可重建输入、版本和证据引用，缺失项明确标记。

### 任务 3.4：ScienceDiscovery Worker

- 定义 Worker 注册、心跳、能力、队列和短期 token。
- 实现课题 scope、沙箱资源、MCP 白名单、artifact 回传和审计。
- 支持 Worker 离线、任务取消、超时和恢复。

依赖：3.1、Phase 2 统一 Job。验收：Worker 只能访问授权课题，越权/逃逸/超额全部被拒绝并告警。

### 任务 3.5：Synlora 多实例和队列化

- 迁移 run/session/event 到持久队列和可恢复状态。
- 实现 SSE 游标、多实例粘性/无粘性兼容、死信和补偿。
- 增加用户/课题/Workspace 配额、熔断、限流和缓存隔离。
- 保留 delegated identity、capability scope 和 Synlora event cursor 的跨实例语义。
- 同步扩展 Plane 通用 Agent 插件的 scope banner、工具授权、风险确认、配额、审计跳转和策略阻断提示。

依赖：Phase 2 任务 2.1、3.1。验收：实例重启、网络抖动和队列峰值下事件不丢失、不串租户。

### 任务 3.6：容量、备份和灾备

- 进行 500 成员/100 并发、Agent Run、SSE、RAG 查询、上传和回放压测。
- 建立 PostgreSQL/Mongo/MinIO/Redis/队列备份、恢复和跨故障域演练。
- 明确 RPO/RTO、容量阈值、扩容和降级策略。

依赖：3.2–3.5。验收：达到目标 p95、错误率、恢复时间和数据完整性指标。

### 任务 3.7：社会用户开放门禁

- 完成租户隔离、注册/邀请、AccountLink、删除/导出和配额。
- 完成隐私、滥用、内容安全、密钥轮换和安全事件流程。
- 组织外部安全测试和数据保护评审。

依赖：3.1–3.6。验收：所有开放前置门禁通过，未通过时只能保持内部模式。

## 4. 测试与验收

### 4.1 治理和权限

- 伦理未批准时禁止受限实验/发布。
- 敏感数据只能在授权课题、工具和 Worker 中流转。
- IP 限制阻止未经批准的外部导出。
- 解绑、禁用和删除后，Context、Trace、文件、Worker 和缓存立即失效。
- 禁用插件、撤回工具授权、更新 capability policy 或撤销 Context 后，下一轮 Agent run 立即 fail closed。

### 4.2 可复现与审计

- 任意正式快照可以追溯到输入、Prompt/模型、工具、代码、环境、seed、artifact、验证和人工决策。
- 审计导出可同时关联 Plane Chain Event、Synlora Trace、垂类 run/artifact、AccountLink、capability policy 版本和审批记录。
- 审计导出按权限脱敏，能验证 hash，不能恢复 secrets。
- retention 执行有预览、批准、执行和不可变审计记录。
- 写作/评审 Agent 的输入快照、建议、引用、人工修改和采纳状态完整可回放；正式评审决定只由授权人写入。

### 4.3 Worker 和安全

- Worker 沙箱无法访问未授权目录、网络和课题。
- MCP 工具输入校验、来源白名单、限流和队列超时有效。
- 恶意文档、Prompt Injection、工具逃逸、缓存穿透和 token 重放均被拦截或告警。

### 4.4 容量和灾备

- 500 成员/100 并发下 Plane 核心 API p95 小于 2 秒，外部 Agent/RAG/实验延迟分别统计。
- Agent Run、SSE、RAG、上传和 Chain 回放达到预设吞吐，错误率和队列等待可观测。
- 模拟数据库、对象存储、队列、Agent 实例和 Worker 故障，按 RPO/RTO 恢复。
- 恢复后事件、快照、引用和权限不丢失、不重复、不越权。

### 4.5 开放门禁

只有以下条件全部通过，才允许社会用户灰度：

1. 租户隔离和权限渗透测试通过。
2. 数据导出、删除、保留和审计满足内部政策。
3. 配额、限流、计费/成本统计和滥用防护可运行。
4. 安全事件、备份恢复和客服/运维流程经过演练。
5. 业务负责人、平台管理员和安全/合规责任人完成签署。

插件治理验收还必须确认：

- 任意高风险操作都能在插件中看到阻断原因、审批要求和策略版本。
- 工具、模型、RAG、实验和存储用量与后端配额一致，刷新和多标签页不会重复计量。
- 从插件消息、工具卡、Job 和产物可以跳转到最小权限的审计详情。
- 管理员关闭工具或插件后，已有页面立即进入只读/阻断状态，不能继续提交新 run。
- 解绑 Synlora AccountLink、撤销 Context、禁用插件或撤回 capability 后，delegated token 和已有 session 均不能继续发起下一轮 run。

项目治理验收还必须确认：里程碑、预算、风险和协作待办按课题 ACL 隔离；结题/转化节点只有在成果、可复现、IP 和伦理 gate 都满足或经审批豁免时才能完成。

## 5. 发布、回滚与风险

- 治理策略先以观察模式上线，再逐步切换为阻断模式。
- Worker 和社会用户能力采用独立 flag，未通过门禁时保持关闭。
- 多实例迁移前保留旧事件读取兼容层；队列切换失败可回到只读/人工记录模式。
- 灾备演练不直接操作生产原始数据，使用脱敏副本和恢复演练环境。
- 风险：治理规则过严阻塞科研。处理：每条阻断提供原因、审批入口和人工替代流程。
- 风险：社会用户带来成本和滥用压力。处理：先邀请制、配额和小流量灰度，不直接公开注册。

## 6. 详细治理和运行设计

### 6.1 治理字段与规则命中

治理配置建议按 Workspace → 组织节点 → 课题 → 节点继承，子级只能收紧不能放宽：

| 配置                     | 示例值                                                      | 命中动作                             |
| ------------------------ | ----------------------------------------------------------- | ------------------------------------ |
| `data_classification`    | `PUBLIC` / `INTERNAL` / `SENSITIVE` / `RESTRICTED`          | 限制检索、下载、Agent 工具和外部导出 |
| `ethics_status`          | `NOT_REQUIRED` / `PENDING` / `APPROVED` / `EXPIRED`         | 未批准时阻断受限实验和发布           |
| `ip_policy`              | `INTERNAL_ONLY` / `REVIEW_REQUIRED` / `PUBLICATION_ALLOWED` | 控制成果导出和社会用户可见性         |
| `reproducibility_status` | `INCOMPLETE` / `PARTIAL` / `VERIFIED`                       | 控制结题、发布和快照归档             |
| `retention_policy`       | 事件/文件/Trace 的期限与归档策略                            | 到期预览、审批、归档或删除           |

规则评估返回结构化结果：

```json
{
  "allowed": false,
  "decision": "BLOCKED_APPROVAL",
  "policy_ids": ["policy_..."],
  "reasons": ["课题伦理状态为 PENDING"],
  "required_approvals": ["直接导师", "课题组主 PI"],
  "expires_at": null
}
```

规则引擎必须是 fail-closed；策略服务不可用时，高风险动作阻断，低风险只读和人工记录可降级继续。

### 6.2 审计包和数据生命周期

审计导出分三层：

1. **索引层**：事件 ID、操作者、时间、课题、节点、动作、来源、状态和 hash。
2. **引用层**：外部对象 ID、版本、链接、artifact 和 source system。
3. **内容层**：仅在调用者具备正文权限且策略允许时，提供脱敏副本或受控下载链接。

导出流程：权限预检 → 生成范围 manifest → 异步打包 → 脱敏扫描 → 计算 hash → 短期链接 → 下载审计。导出包不得包含 token、API Key、密码、内部网络地址或其他课题内容。

生命周期动作：到期预览 → 负责人/管理员审批 → 软删除或归档 → 保留不可变最小审计元数据 → 到期物理删除。删除前必须验证没有未完成的法律/伦理保留要求。

### 6.3 可复现证据模型

每个可复现快照关联：

- Research Chain snapshot 和事件范围。
- Prompt Manifest、模型 provider/model/version 和参数摘要。
- Tool/Skill/Plugin 版本及配置 hash。
- 代码仓库 commit、运行环境、依赖锁文件和随机 seed。
- 输入/输出 artifact、文件 hash、DataAsset 和外部引用版本。
- Validator、Gate、人工决策和审批记录。

缺失项检查返回 `MISSING_INPUT`、`MISSING_ENVIRONMENT`、`MISSING_CODE`、`MISSING_ARTIFACT` 或 `MISSING_APPROVAL`，不以模糊的“不可复现”替代。

### 6.4 Worker 安全边界

ScienceDiscovery Worker 注册信息：`worker_id`、能力、版本、区域、sandbox profile、heartbeat、最大资源和状态。任务 token 必须限定 Workspace、课题、节点、run 和过期时间。

Worker 执行约束：

- 文件系统只挂载当前任务工作区，默认只读外部资源。
- 网络出口按 MCP/source allowlist 控制，默认拒绝。
- CPU、内存、PID、磁盘、执行时长和并发均有硬上限。
- 每次工具调用记录 source、queue wait、attempts、结果和错误。
- 任务结束清理临时目录和凭证，禁止跨任务缓存。

### 6.5 Synlora 多实例运行面

推荐组件：API gateway → run queue → Agent workers → event store → SSE relay。事件 store 是回放事实源，SSE relay 只负责实时分发。

最低要求：

- `run_id + seq` 全局唯一，事件游标可从任意实例恢复。
- worker 租约、心跳、超时回收和死信队列。
- session/project/file/context cache 以 Workspace 和课题 scope 分区。
- 用户/课题/Workspace 配额在入队前检查，不能只在 worker 内限制。
- 外部 provider 具备熔断、退避、限流、错误预算和降级模型。

### 6.6 容量和灾备目标

Phase 3 必须通过压测建立而不是猜测以下指标：

| 指标               | 初始目标                                             |
| ------------------ | ---------------------------------------------------- |
| Plane 核心 API p95 | < 2 秒（不含外部长任务）                             |
| 同时在线成员       | 100                                                  |
| Agent SSE 并发     | 由压测确定，至少覆盖 100 个连接                      |
| RAG 查询并发       | 由 RAGPortal/Synlora 与内网 WeKnora 服务联调基线确定 |
| 事件写入成功率     | ≥ 99.9%                                              |
| RPO                | 先定义内部目标，灾备演练验证                         |
| RTO                | 先定义内部目标，故障演练验证                         |

备份对象包括 PostgreSQL、MongoDB、MinIO、Redis/队列、事件 store 和密钥引用元数据；恢复时先恢复权限和事件，再恢复异步投影，避免出现“显示已完成但事实未恢复”。

## 7. 代码落点与实施顺序

### 7.1 Plane

```text
apps/api/plane/db/models/research/governance.py
apps/api/plane/db/models/research/audit_export.py
apps/api/plane/db/models/research/reproducibility.py
apps/api/plane/db/migrations/01xx_research_governance.py
apps/api/plane/research/services/policy_engine.py
apps/api/plane/research/services/audit_export.py
apps/api/plane/research/services/reproducibility.py
apps/api/plane/research/views/governance.py
apps/api/plane/research/views/audit_export.py
apps/api/plane/tests/contract/app/test_research_governance.py
apps/api/plane/tests/contract/app/test_research_audit_export.py
```

### 7.2 Synlora/ScienceDiscovery

- Synlora：队列、event store、SSE relay、quota middleware、cache namespace 和 worker lease。
- ScienceDiscovery：Worker gateway、任务 token、MCP allowlist、artifact/provenance callback 和 sandbox profile。
- 两端均不得直接读取 Plane 数据库；只能使用 Context/Job/Artifact contract。

### 7.3 运维和安全

```text
deployments/monitoring/                     # 指标、告警和 dashboard
deployments/backup/                         # 备份/恢复脚本和校验
docs/runbooks/research-platform/            # 发布、回滚、灾备、事件响应
security/contract-fixtures/                 # Prompt injection、恶意文件、越权 fixture
```

## 8. 测试命令与验收证据

```bash
cd plane
docker compose -f docker-compose-test.yml run --rm api-tests pytest -q \
  apps/api/plane/tests/contract/app/test_research_governance.py \
  apps/api/plane/tests/contract/app/test_research_audit_export.py
pnpm check:types
pnpm check:lint
pnpm build
```

另外必须执行：

- 多实例 Agent run、SSE 断线、worker 重启和死信恢复压测。
- 恶意文件、Prompt Injection、MCP 越权、缓存穿透和 token 重放测试。
- 脱敏导出、删除/恢复、备份校验和跨故障域恢复演练。
- 500 成员/100 并发容量压测和错误预算评审。

验收包包括性能报告、渗透测试报告、审计导出样例、恢复演练记录、RPO/RTO 结果、策略命中矩阵和开放门禁签署。

## 9. 任务拆分与开放门禁

| 顺序 | 任务                    | 依赖                 | 通过条件                             |
| ---- | ----------------------- | -------------------- | ------------------------------------ |
| 1    | 治理字段/策略引擎       | Phase 2              | 高风险动作可阻断、低风险可降级       |
| 2    | 审计导出/生命周期       | 1、Phase 1/2 事件    | 脱敏、hash、保留/删除可回放          |
| 3    | 可复现/证据链           | 1、Phase 2 artifacts | 缺失项可解释、快照可重建             |
| 4    | ScienceDiscovery Worker | 1、统一 Job          | scope、沙箱、MCP、资源限制通过       |
| 5    | Synlora 多实例/队列     | 1、Phase 2 Job       | 重启/峰值/断线不丢事件               |
| 6    | 容量/灾备               | 2–5                  | 目标 p95、RPO/RTO 和恢复验证通过     |
| 7    | 社会用户门禁            | 全部                 | 租户、隐私、配额、安全和责任签署完成 |

任一开放门禁失败，平台保持内部邀请制；治理策略可回退到观察模式，但不能关闭审计或权限判定。

## 10. 通用 Agent 插件 Phase 3 完成清单

- [ ] scope banner、数据等级、伦理状态和 Context 有效期可见。
- [ ] 工具授权、审批、配额、阻断原因和策略版本可解释。
- [ ] 策略命中记录包含 `policy_id/policy_version`，并能回放发布、变更和撤回链路。
- [ ] 高风险操作确认抽屉和管理员策略配置完成。
- [ ] 消息/工具/Job/产物到 Trace、Approval、IntegrationCallLog 和 Snapshot 的审计跳转可用。
- [ ] 禁用工具、撤权、解绑和租户隔离在插件中即时生效。
- [ ] Synlora 多实例恢复后，delegated identity、capability scope 和 event cursor 不丢失、不重放、不串用。
