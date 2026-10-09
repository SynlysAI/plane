# Synlora × ScienceDiscovery 协同实施计划

| 项目     | 内容                                                                                              |
| -------- | ------------------------------------------------------------------------------------------------- |
| 计划版本 | v1.0                                                                                              |
| 编写日期 | 2026-10-09                                                                                        |
| 计划状态 | 待评审                                                                                            |
| 目标     | 在不上传个人原始科研数据的前提下，实现 Synlora 云端智能体与 ScienceDiscovery 本地智能体的可控协同 |
| 适用系统 | Plane、Synlora、ScienceDiscovery，以及后续接入的 Spec Agent、Poly Agent、SpecLabOS                |
| 依赖     | 组织/项目 ACL、统一身份、Agent Context、Job、Trace、Artifact 契约                                 |

## 1. 背景与问题

Synlora 已具备云端 Agent Runtime、插件目录、工具级审批、异步 Job、用户沙箱和科研上下文能力。ScienceDiscovery 适合作为个人本地科研执行环境：项目与会话、文献接入、代码沙箱、Subagent、Artifact 和完整溯源均在本机完成。

两者直接互相开放文件或执行权限会产生三类风险：

1. 云端智能体可能越权读取个人本地数据。
2. 本地智能体可能在缺少组织上下文时调用共享资源。
3. 任务、审批、产物和溯源记录分散，无法解释“谁以什么授权做了什么”。

本计划采用“云端控制面 + 本地执行面”模型：Synlora 管理身份、组织、任务和协同；ScienceDiscovery 管理个人数据、本地工具执行和本地溯源；Plane 提供组织、项目成员和研究上下文。

## 2. 目标与非目标

### 2.1 目标

- 建立本地 Agent Instance 注册、设备信任和吊销机制。
- 统一用户、租户、组织、项目、Agent、工具、数据和产物的 ACL 判定。
- 支持云端规划、本地执行；本地规划、云端调用；以及跨 Agent DAG 协同。
- 让原始谱图、实验数据、API Key 默认留在本地。
- 用短时能力令牌限制每次委派的主体、资源、动作、工具和有效期。
- 对数据导出、设备操作、付费 API 和删除等高风险动作实行双侧审批。
- 支持断线重连、离线本地执行、事件补发、幂等和撤权。
- 形成可回放的跨端 Trace、Artifact 和审计链。

### 2.2 非目标

- 不重写 ScienceDiscovery 的 Agent Loop、Runner、Project/Session 或本地溯源核心。
- 不让 Synlora 直接挂载或扫描个人本地工作区。
- 不将 MCP 作为认证或 ACL 的替代品。
- 不在首期实现任意云端代码下发、全量数据同步或自动设备实验。
- 不合并 Plane、Synlora 和 ScienceDiscovery 的用户数据库。
- 不在本计划内统一所有模型供应商和计费策略。

## 3. 总体架构

```text
用户 / 浏览器
      │
      ▼
Plane + Synlora 云端控制面
身份、租户、项目 ACL、任务 DAG、审批、共享知识、审计
      │  本地 Bridge 主动建立 HTTPS/SSE 或 WebSocket 出站连接
      ▼
ScienceDiscovery Agent Bridge
设备密钥、令牌验证、任务队列、策略执行、断线重连
      │
      ▼
ScienceDiscovery 本地执行面
Project / Session / Runner / MCP / Subagent / Artifact / Provenance
```

### 3.1 责任边界

| 领域 | 云端控制面                                   | 本地执行面                                 |
| ---- | -------------------------------------------- | ------------------------------------------ |
| 身份 | 用户、租户、组织、项目成员和角色             | 缓存身份与授权结果，验证本地设备身份       |
| 任务 | 创建任务、编排 DAG、分派 Agent、取消和重试   | 接受任务、映射本地 Session、执行和上报状态 |
| 数据 | 保存元数据、授权、摘要和引用                 | 保存原始文件、密钥、私有模型和详细执行结果 |
| 工具 | 能力目录、策略、配额和审批规则               | 本地白名单、工具管线、沙箱和最终拒绝       |
| 产物 | Artifact 索引、共享、导出审批和跨 Agent 引用 | 生成文件、内容哈希、来源事件和本地权限     |
| 审计 | 跨系统 Trace、授权、审批和协同记录           | 文件访问、工具调用、Runner 和会话事件      |

### 3.2 单一编排原则

Synlora 只编排跨系统的顶层任务 DAG；ScienceDiscovery 继续编排本地 Session 内的 Step、工具调用和本地 Subagent。一个任务只能有一个顶层编排者，避免云端和本地重复重试或相互覆盖状态。

## 4. 统一身份、ACL 与信任

### 4.1 资源层级

```text
Tenant
 └── Organization
      └── Project
           ├── Session
           ├── Dataset
           ├── Artifact
           ├── Agent Instance
           ├── Tool / MCP
           └── Run / Job
```

### 4.2 权限动作

统一动作枚举：`discover`、`read`、`write`、`invoke`、`export`、`share`、`approve`、`admin`、`audit`。

角色建议：`owner`、`manager`、`contributor`、`reviewer`、`viewer`、`operator`、`auditor`。

最终授权必须满足：

```text
云端授权
∩ 本地用户权限
∩ 项目 ACL
∩ Agent 能力白名单
∩ 工具策略
∩ 数据分级策略
```

默认拒绝，显式拒绝优先于允许。客户端按钮隐藏不是安全边界，所有判定必须在服务端和本地 Bridge 重复执行。

### 4.3 Agent Instance 信任

每个本地安装注册为独立的 `agent_instance`，至少包含：`tenant_id`、`subject_id`、`device_id`、`agent_instance_id`、公钥、能力声明、策略版本、最后在线时间和状态。

本地 Bridge 使用设备密钥建立出站连接。云端保存公钥或 JWKS；设备吊销后，云端不再投递新任务，本地 Bridge 拒绝新令牌。

### 4.4 短时能力令牌

每次委派签发短时、不可扩权的能力令牌，建议采用签名 JWT 或同等可验证格式：

```json
{
  "task_id": "task_123",
  "tenant_id": "tenant_1",
  "project_id": "project_456",
  "subject_id": "user_789",
  "agent_instance_id": "local_abc",
  "allowed_actions": ["read", "invoke", "write"],
  "allowed_artifact_ids": ["local://project_456/nmr/sample_01"],
  "allowed_tools": ["file.read", "python.run", "artifact.write"],
  "policy_version": "policy-17",
  "nonce": "unique-request-nonce",
  "expires_at": "2026-10-09T18:00:00Z"
}
```

本地 Bridge 必须验证签名、受众、项目、设备、过期时间、撤销状态、nonce 和能力交集。子 Agent 委派只能生成权限更小、有效期更短的子令牌。

## 5. 数据分级与隐私边界

| 级别 | 示例                                         | 默认策略                 |
| ---- | -------------------------------------------- | ------------------------ |
| L0   | Agent 名称、在线状态、任务状态               | 可上云                   |
| L1   | 脱敏统计、结果摘要、指标                     | 通过策略检查后上云       |
| L2   | 项目级实验结果、结构化数据、报告草稿         | 默认只传引用，导出需审批 |
| L3   | 原始谱图、未公开数据、个人密钥、私有模型凭据 | 默认永不出本地           |

Artifact 使用内容寻址：保存 SHA-256、类型、大小、来源和权限，正文默认留在本地。用户批准后才允许一次性上传；上传前执行文件类型、大小、DLP 和脱敏检查。

所有云端返回的产物回写本地前，必须验证来源、签名、哈希和当前项目 ACL。云端不得通过提示词要求本地 Agent 绕过 Bridge 或工具管线。

## 6. 协同模式与任务协议

### 6.1 四种协同模式

| 模式               | 适用场景                                    | 数据边界                            |
| ------------------ | ------------------------------------------- | ----------------------------------- |
| 本地独立           | 敏感实验、离线研究                          | 仅上报状态、摘要和审计哈希          |
| 云端规划、本地执行 | 云端拆解任务，本地分析文件                  | 原始数据留本地，返回引用和摘要      |
| 本地规划、云端调用 | 使用共享知识、云端模型或高算力              | 仅提交用户授权的脱敏输入或 Artifact |
| 跨 Agent DAG       | Spec Agent、Poly Agent、Reviewer 等联合任务 | 每个节点单独校验 ACL 和能力令牌     |

### 6.2 TaskIntent

云端下发结构化任务意图，不下发任意代码：

```json
{
  "schema_version": "task-intent.v1",
  "task_id": "task_123",
  "project_id": "project_456",
  "intent": "分析本地核磁数据并生成报告",
  "required_capabilities": ["file.read", "python.run", "artifact.write"],
  "input_artifacts": [{ "artifact_id": "local://project_456/nmr/sample_01" }],
  "output_policy": {
    "allow_upload": false,
    "allow_summary": true,
    "allow_export": "user_approval"
  },
  "budget": { "max_steps": 20, "max_cost": 5 },
  "deadline": "2026-10-09T18:00:00Z"
}
```

### 6.3 TaskResult

```json
{
  "schema_version": "task-result.v1",
  "task_id": "task_123",
  "status": "SUCCEEDED",
  "result_refs": ["local://project_456/output/report.pdf"],
  "summary": "已完成核磁峰识别和候选结构分析",
  "provenance": {
    "event_log_hash": "sha256:...",
    "runner": "sciencediscovery-local",
    "policy_version": "policy-17"
  }
}
```

## 7. 接口与事件边界

首期接口使用 `/api/v1`，所有请求带 `request_id`、`trace_id`、`schema_version` 和 `idempotency_key`。错误统一为：

```json
{
  "error": {
    "code": "FORBIDDEN",
    "message": "当前 Agent 无权访问该项目",
    "details": { "resource": "project_456" }
  }
}
```

建议接口：

| 接口                                            | 用途                         |
| ----------------------------------------------- | ---------------------------- |
| `POST /api/v1/agent-instances/register`         | 注册本地 Agent Instance      |
| `POST /api/v1/agent-instances/{id}/rotate-key`  | 轮换设备密钥                 |
| `POST /api/v1/agent-instances/{id}/revoke`      | 吊销设备或安装               |
| `GET /api/v1/agent-instances/{id}/capabilities` | 获取有效能力交集             |
| `POST /api/v1/tasks`                            | 创建跨端任务                 |
| `POST /api/v1/tasks/{id}/dispatch`              | 签发令牌并投递任务           |
| `POST /api/v1/tasks/{id}/cancel`                | 取消任务                     |
| `POST /api/v1/tasks/{id}/events`                | 接收本地事件，按事件 ID 幂等 |
| `GET /api/v1/tasks/{id}`                        | 查询任务状态和结果引用       |
| `POST /api/v1/artifacts/{id}/export-request`    | 请求数据导出审批             |
| `POST /api/v1/approvals/{id}/decision`          | 提交审批决定                 |

本地 Bridge 对 ScienceDiscovery 的调用优先使用其现有 REST API 或受控 MCP Adapter；不让云端直接调用本地 API。

事件至少包含：`event_id`、`task_id`、`seq`、`source_system`、`actor`、`occurred_at`、`trace_id`、`policy_version`、`content_hash` 和 `refs`。详细文件路径、Prompt 和密钥不得写入云端审计日志。

## 8. 审批、撤销与离线策略

### 8.1 必须审批的动作

- 原始数据上传云端；
- 访问其他成员或其他项目资源；
- 外部付费 API；
- 删除或覆盖实验数据；
- 启动设备或实验流程；
- 网络访问和新增 MCP；
- 修改共享知识库；
- 代表用户发布报告或提交结论。

审批同时写入 Synlora 审批日志、ScienceDiscovery 事件日志和 Artifact 溯源记录。

### 8.2 断线与撤销

- 本地 Outbox 保存未上传事件，云端 Inbox 按 `event_id` 去重。
- 任务以 `task_id` 幂等；事件以递增 `seq` 补发。
- 普通本地任务允许断线继续；高风险操作必须在线。
- 用户、项目、Agent 或设备撤权后，云端停止新任务，本地拒绝新授权；正在运行的低风险任务按策略完成或取消。
- 设备密钥泄露时立即吊销 Agent Instance 并轮换密钥。

## 9. 分阶段实施任务

### Phase 0：契约与安全基线

#### 任务 0.1：冻结跨端契约

**目标：** 定义 `agent-instance.v1`、`task-intent.v1`、`task-result.v1`、`artifact-ref.v1`、`delegation-token.v1` 和 `agent-event.v1`。

**验收：**

- [ ] 每个契约都有 JSON Schema、示例、错误码和兼容规则。
- [ ] 新增字段默认可选，删除/重命名发布新版本，消费者忽略未知字段。
- [ ] 所有回调支持 `request_id` 或 `event_id` 幂等。

**依赖：** 无。
**范围：** 中。

#### 任务 0.2：完成威胁建模与数据分级

**验收：**

- [ ] 明确云端、Bridge、本地 Runner、MCP 和用户浏览器的信任边界。
- [ ] L0-L3 数据分级落入导出策略和日志脱敏规则。
- [ ] 高风险动作清单和默认拒绝策略经过产品、安全和运维评审。

**依赖：** 任务 0.1。
**范围：** 中。

### Checkpoint 0

- [ ] 契约样例可被 Plane、Synlora 和本地 Bridge 共同解析。
- [ ] 能用同一份策略说明一次“允许”和一次“拒绝”的完整链路。
- [ ] 未开始开放真实文件上传和设备执行。

### Phase 1：Agent 注册与最小信任链

#### 任务 1.1：实现 Agent Instance 注册

**验收：**

- [ ] 本地 Bridge 可注册设备公钥、能力声明、版本和在线状态。
- [ ] 注册请求具备一次性挑战或等价设备持有证明。
- [ ] 重复注册不会产生不可追踪的重复实例。

**依赖：** Phase 0。
**范围：** 中。

#### 任务 1.2：实现短时能力令牌

**验收：**

- [ ] 令牌绑定用户、租户、项目、Agent Instance、工具、动作、策略版本和过期时间。
- [ ] Bridge 能拒绝过期、错误受众、错误项目、错误设备、重复 nonce 和已吊销令牌。
- [ ] 子任务令牌只能缩小权限和缩短有效期。

**依赖：** 任务 1.1。
**范围：** 中。

#### 任务 1.3：打通 Plane 项目上下文

**验收：**

- [ ] 任务创建必须带项目和当前成员上下文。
- [ ] Plane 的项目成员变更能使新令牌权限立即收敛。
- [ ] 跨组织、非成员和归档项目访问均返回结构化 `FORBIDDEN`。

**依赖：** 任务 1.2。
**范围：** 中。

### Checkpoint 1

- [ ] 一个本地 Agent 可上线、离线、重连和吊销。
- [ ] 用户只能看到自己有权限的本地 Agent 和项目。
- [ ] 没有原始文件上传时，端到端 Trace 可回放。

### Phase 2：单任务云本协同

#### 任务 2.1：实现 TaskIntent 投递与本地 Session 映射

**验收：**

- [ ] Synlora 可以创建结构化任务并投递到指定本地 Agent。
- [ ] Bridge 将任务映射为 ScienceDiscovery Project/Session/Run，不修改其核心 Loop。
- [ ] 不支持任意代码字段；任务只能引用能力和 Artifact。

**依赖：** Phase 1。
**范围：** 大，拆分实现与测试两个子任务。

#### 任务 2.2：实现 TaskResult、取消和重试

**验收：**

- [ ] 本地任务状态可查询、取消、重试且状态迁移合法。
- [ ] 重复投递同一 `task_id` 不重复执行。
- [ ] 断开 SSE/WebSocket 后任务继续按策略执行，重连可补齐事件。

**依赖：** 任务 2.1。
**范围：** 中。

#### 任务 2.3：接入本地审计与溯源

**验收：**

- [ ] 工具调用、文件访问、Runner 结果和审批均带 `trace_id`。
- [ ] 云端只接收脱敏事件、摘要、哈希和引用。
- [ ] 原始 Prompt、密钥和完整敏感路径不会写入云端日志。

**依赖：** 任务 2.1。
**范围：** 中。

### Checkpoint 2

- [ ] 完成“云端规划 → 本地分析 → 返回摘要和本地 Artifact 引用”的演示闭环。
- [ ] 断网、超时、取消、令牌过期和越权均有可验证结果。
- [ ] 低风险任务与高风险任务的审批行为不同且可解释。

### Phase 3：Artifact、导出审批与跨 Agent DAG

#### 任务 3.1：实现 Artifact 引用和内容寻址

**验收：**

- [ ] Artifact 引用包含项目、所有者、类型、大小、哈希、来源和可见性。
- [ ] 云端索引不保存未授权的原始内容。
- [ ] 内容哈希不匹配时，回写和下载均失败关闭。

**依赖：** Phase 2。
**范围：** 中。

#### 任务 3.2：实现导出审批和脱敏上传

**验收：**

- [ ] L2/L3 数据导出必须产生审批记录。
- [ ] 上传使用一次性、短时效凭据，并限制目标 Artifact 和项目。
- [ ] 用户撤销或审批过期后无法继续上传。

**依赖：** 任务 3.1。
**范围：** 大，拆分策略检查、上传和回滚测试。

#### 任务 3.3：实现跨 Agent DAG

**验收：**

- [ ] Synlora 可编排本地 ScienceDiscovery、Spec Agent、Poly Agent 和 Reviewer 节点。
- [ ] 每个节点单独校验项目 ACL、能力令牌和数据出口策略。
- [ ] 任一节点失败不会伪造整体成功，支持暂停、人工介入和补偿。

**依赖：** 任务 3.1、3.2。
**范围：** 大，拆分 DAG 状态机与专业插件适配。

### Checkpoint 3

- [ ] 完成“本地数据分析 → 谱图解析 → 材料预测 → 证据审阅 → 报告引用”的联合任务。
- [ ] 所有节点能从 Trace 追溯到原始本地事件和最终 Artifact。
- [ ] 原始敏感数据仍可全程留在本地。

### Phase 4：生产化治理

#### 任务 4.1：配额、成本和速率限制

- [ ] 按租户、项目、用户和 Agent 统计步骤、Token、外部调用和存储。
- [ ] 达到预算后任务暂停或进入审批，不静默超额。
- [ ] 云端和本地配额冲突时采用更严格者。

#### 任务 4.2：运营监控与安全响应

- [ ] 监控 Agent 在线率、任务延迟、失败率、拒绝率和事件积压。
- [ ] 支持设备吊销、密钥轮换、任务批量取消和审计导出。
- [ ] 安全日志不可被普通项目成员修改或删除。

#### 任务 4.3：灰度发布与回滚

- [ ] 通过租户、组织和 Agent Instance 灰度启用。
- [ ] 任何跨端写操作均有功能开关和紧急关闭开关。
- [ ] 回滚后本地任务、事件和 Artifact 不丢失，可恢复到只读模式。

## 10. 测试与验收矩阵

| 类别 | 必测场景                           | 通过标准                       |
| ---- | ---------------------------------- | ------------------------------ |
| 身份 | 注册、重连、密钥轮换、设备吊销     | 旧令牌失效，新令牌可验证       |
| ACL  | 非成员、跨组织、项目归档、显式拒绝 | 服务端与本地均拒绝，错误码一致 |
| 工具 | 未授权工具、沙箱逃逸、网络访问     | Bridge/Runner 阻断并记录审计   |
| 数据 | L0-L3 上传、脱敏、哈希篡改         | 默认策略和审批符合分级         |
| 任务 | 重复投递、取消、超时、重试         | 幂等、状态合法、无伪成功       |
| 网络 | 断网、长连接断开、事件积压         | 本地安全继续，恢复后顺序补发   |
| 审计 | 工具调用、审批、Artifact、回写     | 可由 `trace_id` 回放完整链路   |
| 兼容 | 旧契约字段、未知字段、版本升级     | 向后兼容，破坏性变更有新版本   |

## 11. 风险与缓解

| 风险                      | 影响               | 缓解                                                     |
| ------------------------- | ------------------ | -------------------------------------------------------- |
| 云端策略与本地策略漂移    | 越权或任务误拒绝   | 策略版本绑定令牌；本地始终采用更严格结果                 |
| Bridge 被本地恶意程序控制 | 任务和数据泄露     | 设备密钥隔离、最小权限、沙箱、可吊销实例和异常心跳       |
| 长连接断开导致重复执行    | 数据污染、费用增加 | `task_id`/`event_id` 幂等、Outbox/Inbox 和状态机         |
| 原始数据误上传            | 合规和知识产权风险 | L3 默认拒绝、DLP、审批、一次性上传、审计                 |
| Agent 无限循环或费用失控  | 资源耗尽           | max steps、超时、并发、成本预算和人工暂停                |
| 跨 Agent 结果不可解释     | 错误决策           | Artifact 哈希、来源引用、Prompt/工具版本和 Reviewer 节点 |
| 引入新插件绕过 ACL        | 安全边界失效       | 插件能力声明、注册表白名单、工具管线统一鉴权             |

## 12. 发布门槛与回滚

### 发布门槛

- [ ] Phase 0 契约和威胁模型完成评审。
- [ ] Phase 1 注册、令牌、ACL 和吊销自动化测试通过。
- [ ] Phase 2 单任务闭环通过断网、越权、重复投递和取消测试。
- [ ] Phase 3 导出审批和 Artifact 哈希校验通过安全验收。
- [ ] 灰度租户、监控、告警和回滚开关已配置。

### 回滚策略

1. 关闭云端新任务投递和所有跨端写操作。
2. 保留本地任务只读查询；低风险任务按运维决定完成或取消。
3. 保留本地事件、Artifact 和 Outbox，不删除用户数据。
4. 恢复到上一版契约和策略后，先验证设备吊销和令牌失效，再重新开放灰度。

## 13. 待确认决策

- [ ] Plane、Synlora 是否共用统一租户 ID，还是由 Plane 作为组织主数据源。
- [ ] Agent Instance 设备密钥采用 Ed25519、mTLS，还是已有平台密钥体系。
- [ ] 首期本地 Bridge 通过 ScienceDiscovery REST API 还是本地 MCP Adapter 接入。
- [ ] L1 摘要是否允许默认上云，哪些字段必须脱敏。
- [ ] 跨 Agent DAG 的首个示范链路选择 NMR、IR、材料预测还是文献综述。
- [ ] 设备操作和付费模型调用的审批人、超时和紧急停止规则。

## 14. 相关资料

- [ScienceDiscovery 中文 README](https://github.com/openJiuwen-ai/sciencediscovery/blob/main/README_zh.md)
- [Plane 跨系统契约](../../contracts/research-intelligent-platform/README.md)
- [Agent Context v2](../../contracts/research-intelligent-platform/schemas/agent-context.v2.json)
- [Job Status v1](../../contracts/research-intelligent-platform/schemas/job-status.v1.json)
- [Agent Trace v1](../../contracts/research-intelligent-platform/schemas/agent-trace.v1.json)
- Synlora 项目说明：`Synlora/README.md`
- ScienceDiscovery 能力：本地工作区、沙箱、Subagent、Artifact 和溯源
