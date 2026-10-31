# Phase 1.7 科研链 OpenEVA 问题架构与代码实施设计

| 项目         | 内容                                                                                                                               |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| 文档版本     | v1.0                                                                                                                               |
| 文档状态     | 已实施                                                                                                                             |
| 日期         | 2026-10-31                                                                                                                         |
| 问题来源     | 用户提供的问题清单《openeva-给开发的问题清单-自然语言版-2026-10-30.md》                                                            |
| 上游 PRD     | [`科研智能体平台 Phase 1.7：科研链闭环可靠性 PRD`](../../product/research-intelligent-platform-phase-1.7-chain-reliability-prd.md) |
| 问题评审基线 | Plane `develop @ de7f7d65fb`                                                                                                       |
| 本文编写基线 | Plane `develop @ 09244475e3` / `9.0.0`                                                                                             |
| 实施类型     | 兼容性修复与投影增强；无数据库迁移                                                                                                 |
| 版本目标     | 本次随兼容性功能发布 `9.3.0`                                                                                                       |

> 实施前必须从干净工作区切出独立分支。当前工作区已有其他未提交变更，不得与 Phase 1.7 混合提交。问题清单中的生产课题和账号信息不在本文复制。

## 1. 当前代码事实与根因矩阵

### 1.1 关键代码事实

| 领域         | 当前入口                                                                            | 事实                                                                                                  |
| ------------ | ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | --- | ----------------------------------- |
| 上传列表     | `apps/api/plane/research/views/knowledge.py::ResearchChainUploadEndpoint.get`       | 只查询 `ResearchChainUpload` 本地投影，不调用 RAGPortal。                                             |
| 上传详情     | `apps/api/plane/research/views/knowledge.py::ResearchChainUploadDetailEndpoint.get` | 调 `RagPortalClient.upload_detail`，回写状态并追加状态事件。                                          |
| 上传状态     | `ResearchChainUpload.Status`                                                        | `PENDING / PROCESSING / SUCCESS / FAILED / DEGRADED`。                                                |
| 材料投影     | `chain_stage_approvals.material_state`                                              | 当前 `LINKABLE_UPLOAD_STATUSES = {PROCESSING, SUCCESS}`，两类都计入 `submitted_count` 和 `complete`。 |
| 阶段面板     | `apps/web/core/components/research/chains/research-chain-stage-approval-panel.tsx`  | 一个 `requirementCode`、一个上传选择控件和一个 `AttachmentUploadZone` 服务全部材料要求。              |
| 课题刷新     | `research-chain-detail.tsx::load`                                                   | 材料关联后 `onChanged()` 触发整页加载，容易重置选中节点和知识库控制器。                               |
| 知识库控制器 | `research-chain-detail.tsx`                                                         | `useResearchChainKnowledge` 绑定全局 `pickCurrentNode(nodes)`，不是当前阶段首选节点。                 |
| 主 PI 解析   | `chain_stage_approvals.resolve_principal`                                           | 从有效组织 PI 成员解析唯一主 PI；0 个或多个时抛配置错误。                                             |
| 提交校验     | `chain_stage_approvals._validate_submission`                                        | 已在最终需要 PI 时调用 `resolve_principal`；问题发生在前端未提前解释。                                |
| 条件审批     | `review_chain_stage`                                                                | 后端要求 `CONDITIONAL_PI` 的导师通过请求显式携带 `escalate_to_pi`。                                   |
| 前端审批     | `ResearchChainStageApprovalPanel.reviewStage`                                       | 当前传 `escalateToPi                                                                                  |     | undefined`，“不转 PI”时字段被省略。 |
| 我的阶段     | `research_todos.collect_chain_stage_approval_todos`                                 | 只查询待审阶段；`scope=mine` 使用 `stage.chain.owner_id`。                                            |
| 阶段通知     | `chain_stage_approvals`                                                             | 已写 Chain Event 和审计，尚无阶段审批通知。                                                           |
| 工作项通知   | `workspace-notifications/sidebar/notification-card/content.tsx`                     | 内容 map 硬编码英文动作和连接词。                                                                     |
| 概览         | `research-chain-overview-command.tsx`                                               | “最近审批”只取当前阶段最后一条审核动作。                                                              |
| 任务候选     | `research-assignee-select.tsx`                                                      | 只区分搜索过滤后的空列表，不提供成员页引导。                                                          |
| 状态文案     | `research-chain-workflow-stage-detail.tsx`                                          | 无选中节点时把阶段 `IN_PROGRESS` 回退到不存在的 node status key。                                     |

### 1.2 问题根因矩阵

| 问题                         | 直接根因                                     | 修复层                                     |
| ---------------------------- | -------------------------------------------- | ------------------------------------------ | --------------- | ------------------------ |
| 课题资料长期“解析中”         | 列表不刷新上游，前端不轮询详情               | 前端轮询 + 状态契约说明                    |
| 多材料每次只能传一项         | 上传控件全局共享；关联后整页刷新重置控制器   | 每要求独立控件 + 目标刷新                  |
| “满足 / 解析中 / 未就绪”并存 | 处理中文件计入满足；面板级不可用提示重复渲染 | 后端状态派生 + 行级单一状态                |
| 主 PI 英文错误               | 前端直接透出后端 message；无提交前预检       | 审核人 `reason_code` + 中文映射 + 前置提示 |
| 条件审批报英文错误           | false 被 `                                   |                                            | undefined` 吞掉 | 显式二选一 UI 和布尔载荷 |
| 阶段计数不刷新               | 只有本地操作后刷新；跨账号审批无页面刷新     | 目标刷新 + 焦点 / 可见性轮询               |
| 状态 key 泄露                | 阶段状态误用节点状态字典                     | 共享状态映射 helper                        |
| 任务无人可指派无提示         | 空列表只显示“没有匹配”                       | 拆分无候选与搜索无结果                     |
| 学生看不到阶段进度           | 审批中心 Tab 绑定审批权限                    | 新增 owner 只读 Tab + 扩展 mine 投影       |
| 通知中英混排                 | 前端内容 map 硬编码英文                      | 通知展示层 i18n                            |
| 概览无审批记录               | 只看当前阶段                                 | 全阶段 review actions 聚合                 |

## 2. 目标架构与数据流

### 2.1 状态权威

```text
RAGPortal parse status
  → ResearchChainUpload.status       # Plane 本地投影
  → ResearchChainStageMaterial       # 关联关系
  → material submission_state        # 阶段材料派生状态
  → stage submit capability / button # 前端展示与操作
```

规则：

1. RAGPortal 是解析状态权威。
2. `ResearchChainUpload.status` 是 Plane 已确认的本地投影。
3. 材料要求状态只从本地 `SUCCESS` 投影派生，不直接猜测上游状态。
4. `ResearchChainStage.status` 是审批状态唯一权威。
5. 前端可以预判并禁用操作，但最终以服务端校验为准。

### 2.2 上传状态数据流

```text
阶段材料行
  → useResearchChainKnowledge.uploadFiles
  → ResearchChainService.uploadKnowledgeFile
  → POST /chains/{chainId}/uploads/
  → RAGPortal upload
  → ResearchChainUpload(PROCESSING)
  → 创建 StageMaterialItem(processing)
  → 前端轮询 GET /uploads/{uploadId}/
  → BFF 调 RAGPortal upload_detail
  → 本地投影更新为 SUCCESS / FAILED
  → onUploadStatusChanged
  → refreshStageState
  → 材料 submission_state 变化
```

设计选择：

- 上传列表接口保持轻量，不为列表中每个文件同步调用上游。
- 详情接口仍是唯一上游状态同步点。
- 详情刷新成功后，后续列表接口自然返回同一本地状态。
- 处理中文件允许先关联到材料，但不计入完成度。

### 2.3 审批数据流

```text
submit_chain_stage
  → 校验材料 / 预检 / 导师 / PI
  → stage: AWAITING_ADVISOR
  → node: WAITING_HUMAN
  → Chain Event + Audit + Todo + Notification

review_chain_stage
  → 校验当前 reviewer
  → APPROVE / RETURN
  → CONDITIONAL_PI 必须显式 escalate_to_pi
  → APPROVED 或 AWAITING_PI 或 NEEDS_REVISION
  → Chain Event + Audit + Todo + Notification
```

## 3. 后端接口与投影变更

### 3.1 常量拆分

在 `apps/api/plane/research/services/chain_stage_approvals.py` 中将当前常量拆为：

```python
ASSOCIABLE_UPLOAD_STATUSES = {"PENDING", "PROCESSING", "SUCCESS"}
SATISFYING_UPLOAD_STATUSES = {"SUCCESS"}
PROCESSING_UPLOAD_STATUSES = {"PENDING", "PROCESSING"}
FAILED_UPLOAD_STATUSES = {"FAILED", "DEGRADED"}
```

语义：

- `ASSOCIABLE_UPLOAD_STATUSES`：允许建立材料关联，先保留证据；`PENDING` 与 `PROCESSING` 一样表示尚未确认成功。
- `SATISFYING_UPLOAD_STATUSES`：只有成功解析才计入完成度。
- `PROCESSING_UPLOAD_STATUSES`：前端统一显示处理中。
- `FAILED_UPLOAD_STATUSES`：需要用户恢复。

### 3.2 材料投影输出

调整 `material_state(stage)`：

```json
{
  "id": "requirement-id",
  "code": "TOPIC_TITLE",
  "title": "题目",
  "minimum_count": 1,
  "submitted_count": 1,
  "complete": true,
  "submission_state": "READY",
  "processing_count": 0,
  "failed_count": 0,
  "items": []
}
```

计算：

```text
success_count = active items whose upload.status == SUCCESS
processing_count = active items whose upload.status in {PENDING, PROCESSING}
failed_count = active items whose upload.status in {FAILED, DEGRADED}
submitted_count = success_count
complete = success_count >= minimum_count

submission_state =
  READY if complete
  PROCESSING if processing_count > 0
  FAILED if failed_count > 0
  INCOMPLETE otherwise
```

兼容性：

- `items` 保留全部未删除材料条目，包括处理中、失败和历史文字-only。
- `submitted_count` 是行为修复，不再把处理中文件算作满足。
- 新增字段为只读字段，不移除旧字段。
- `missing_material_requirements(stage)` 改为基于 `submission_state !== READY`。
- `_material_snapshot(stage)` 自动继承新计数语义，不单独维护第二套规则。

### 3.3 类型契约

更新 `packages/types/src/research.ts`：

```ts
export type TResearchChainStageMaterialSubmissionState = "INCOMPLETE" | "PROCESSING" | "FAILED" | "READY";

export type TResearchChainStageMaterial = {
  // existing fields
  submission_state: TResearchChainStageMaterialSubmissionState;
  processing_count: number;
  failed_count: number;
};
```

同步更新合同 schema / examples 和前端 mock。

### 3.4 审核人投影

当前 reviewer 投影：

```json
{
  "user": null,
  "error": "A unique principal investigator must be configured before PI review."
}
```

目标投影：

```json
{
  "user": null,
  "error": "A unique principal investigator must be configured before PI review.",
  "reason_code": "research_chain_stage_reviewer_not_configured"
}
```

实施：

- 将 `_safe_reviewer` 的缓存结果扩展为 `(user, error, reason_code)`。
- `advisor` 和 `principal_investigator` 均输出 `reason_code`。
- `error` 字段保留，兼容既有 API 消费方。
- `TResearchChainStageReviewer` 增加 `reason_code?: string`。

### 3.5 提交校验

保持 `_validate_submission` 的状态机不变，调整校验顺序和材料规则：

1. 链和阶段可提交。
2. 提交节点有效且类型匹配。
3. 每个材料要求 `submission_state == READY`。
4. 阶段 03 材料预检当前有效。
5. 唯一直接导师可解析。
6. `ALWAYS_PI` 或 `CONDITIONAL_PI && requires_pi` 时唯一主 PI 可解析。

错误码继续使用：

- `research_chain_stage_material_incomplete`
- `research_chain_stage_precheck_required`
- `research_chain_stage_reviewer_not_configured`
- `research_chain_invalid`

后端返回的 `role` 额外字段保留，供前端区分导师和主 PI。

### 3.6 条件审批接口

`review_chain_stage` 不改规则，只明确前端合同：

```json
{
  "action": "APPROVE",
  "comment": "同意进入下一阶段",
  "escalate_to_pi": false
}
```

- `CONDITIONAL_PI` 导师通过时字段必须存在且为布尔值。
- `true` 只有在学生声明 `requires_pi=true` 时允许。
- `false` 表示导师通过且阶段直接完成。
- `ALWAYS_PI` 仍由服务端强制转 PI。
- 不新增请求字段。

## 4. 通知与待办设计

### 4.1 阶段审批通知

新增 `apps/api/plane/research/utils/chain_stage_notifications.py`。

建议函数：

```python
notify_chain_stage_submitted(stage, advisor, actor)
notify_chain_stage_escalated(stage, principal, actor)
notify_chain_stage_decided(stage, owner, actor, action)
```

通知行：

```json
{
  "workspace": "workspace-id",
  "project": "project-id",
  "entity_identifier": "stage-id",
  "entity_name": "research_chain_stage",
  "title": "科研链阶段已提交：开题",
  "sender": "research",
  "data": {
    "chain_id": "chain-id",
    "stage_id": "stage-id",
    "stage_code": "OPENING",
    "status": "AWAITING_ADVISOR",
    "action": "submitted",
    "href": "/workspace/research/chains/chain-id?tab=nodes&stage=opening&approval=1"
  }
}
```

接收者：

| 动作           | 接收者       |
| -------------- | ------------ |
| 学生提交       | 唯一直接导师 |
| 导师转 PI      | 唯一主 PI    |
| 最终通过       | 研究负责人   |
| 导师或 PI 退回 | 研究负责人   |

约束：

- 复用 `Notification` 表，不新增迁移。
- 在业务事务内 bulk create，保证“状态已变化但通知缺失”不发生。
- 触发者本人不接收。
- 研究负责人通过 `ResearchProjectProfile.owner` 解析，不使用 `ResearchChain.owner` 兜底。
- 视图层幂等重放已有请求时提前返回，不进入服务函数，因此不会重复通知。
- 标题使用中文，HTML 内容使用 `html.escape`。

### 4.2 通知中心渲染

当前 `NotificationItem` 对非公告通知要求存在 `data.issue_activity.field` 和 issue id，科研通知会被隐藏。需增加实体分支：

- `entity_name === "research_chain_stage"`：
  - 主行显示 `notification.title`。
  - 次行显示课题名和阶段名。
  - 点击后标记已读并跳转 `data.href`。
  - 不尝试打开 Issue Peek。
- `inbox-labels.ts` 增加 `research_chain_stage: "科研链阶段"`。

该分支同样兼容后续 `research_*` 实体，但 Phase 1.7 只落地科研链阶段。

### 4.3 工作项通知 i18n

重构 `workspace-notifications/sidebar/notification-card/content.tsx`：

1. `BASE_NOTIFICATION_CONTENT_MAP` 返回 action key，而不是硬编码英文。
2. `NotificationContent` 通过 `useTranslation().t` 解析。
3. 连接词 `to` 一并纳入 i18n。
4. 保留 EE 扩展 map 的字段协议；若扩展 map 返回字符串，包装为兼容分支。
5. 新增 zh-CN 与 en locale key。

覆盖首批用户可见动作：

- added label / removed label
- added assignee / removed assignee
- updated the name to
- updated the state to
- commented
- set start date / removed start date
- set due date / removed due date
- archived / restored work item

历史 `IssueActivity.comment` 不改写；通知列表按当前 locale 展示。

### 4.4 我的阶段提交

调整 `collect_chain_stage_approval_todos`：

查询：

- `to_me` / `visible`：继续只查 `AWAITING_ADVISOR / AWAITING_PI`，避免审批队列出现历史噪音。
- `mine`：查已有 `submitted_at` 的 `AWAITING_ADVISOR / AWAITING_PI / NEEDS_REVISION / APPROVED`。

Owner 判断：

```python
owner_id = chain_stage_owner_id(stage)
if scope == "mine" and owner_id != user.id:
    continue
```

新增链阶段专用 helper，不直接复用 `review_service.research_owner_id()`：

```python
def chain_stage_owner_id(stage):
    profile = getattr(stage.chain.project, "research_profile", None)
    return profile.owner_id if profile else None
```

`collect_chain_stage_approval_todos` 的 queryset 已 `select_related("chain__project__research_profile")`，该 helper 不增加查询。缺失 profile 时返回 `None`，不得回退到 `stage.chain.owner_id`。

投影：

| 状态               | handling      | next      | assignees |
| ------------------ | ------------- | --------- | --------- |
| `AWAITING_ADVISOR` | `IN_PROGRESS` | `APPROVE` | 当前导师  |
| `AWAITING_PI`      | `IN_PROGRESS` | `APPROVE` | 当前主 PI |
| `NEEDS_REVISION`   | `RETURNED`    | `SUBMIT`  | 空列表    |
| `APPROVED`         | `DONE`        | `READ`    | 空列表    |

标题使用 `课题名 · 中文阶段名`。阶段中文名与固定 `STAGE_RULES` 的中文材料规则保持同一映射，不在前端解析 code。

第一版不扩展 `research-todo.v2` schema，列表“更新时间”使用 `updated_at`。

## 5. 前端组件与状态管理变更

### 5.1 `useResearchChainKnowledge`

文件：`apps/web/core/components/research/chains/use-research-chain-knowledge.ts`。

新增 controller 状态：

```ts
type TProcessingMeta = {
  since: number;
  lastPolledAt: number;
};

processingMeta: Record<string, TProcessingMeta>;
onUploadStatusChanged?: (upload: TResearchChainUpload, previous: string) => void;
```

行为：

- `PENDING` 和 `PROCESSING` 进入同一轮询集合。
- 每 5 秒轮询详情，最长自动观察 5 分钟。
- 首次加载遇到历史处理中记录时，以当前时间作为等待起点，避免伪造很长的等待时长。
- 轮询按顺序调用，避免并发冲击 RAGPortal。
- 当前节点最多每轮处理 5 条最久未检查记录；超出时按轮转覆盖。
- 状态从处理中变为成功或失败时：
  - 更新 uploads。
  - 调用 `onUploadStatusChanged`。
  - 停止该记录轮询。
- 节点切换、组件卸载、上传控制器 generation 变化时取消旧轮询。
- 详情接口降级时不把上传误标为失败，保留处理中并显示降级提示。

失败恢复：

- 保留失败文件和 `error_code`。
- “重新上传”重新打开文件选择。
- 复用现有同 hash 逻辑：失败记录不作为成功重复拦截，新 request id 可重写同一投影并重新调用上游。

### 5.2 阶段材料行组件

从 `ResearchChainStageApprovalPanel` 抽出：

`apps/web/core/components/research/chains/research-chain-stage-material-row.tsx`

Props：

```ts
type Props = {
  workspaceSlug: string;
  chainId: string;
  stageCode: string;
  material: TResearchChainStageMaterial;
  editable: boolean;
  busy: boolean;
  knowledge: TResearchChainKnowledgeController;
  onStageChanged: () => Promise<void> | void;
};
```

职责：

1. 展示材料名称、成功数 / 最低数和 `submission_state`。
2. 展示已关联文件和处理中等待时长。
3. 提供本行独立的“上传并关联”。
4. 提供本行独立的“关联已有资料”选择。
5. 提供删除最后一个未提交材料。
6. 行内展示本行操作错误。

禁止：

- 不再读取或写入全局 `requirementCode`。
- 不因其他行上传中而禁用本行。
- 不在已满足行重复渲染上传控件。

上传并关联流程：

```text
validate file
  → knowledge.uploadFiles([file])
  → upload status PROCESSING/SUCCESS
  → createChainStageMaterial(requirement_code=this row, upload_id)
  → onStageChanged()
```

处理中文件允许关联，关联后该行显示 `PROCESSING`。

“确认引用”是独立动作，仅在上传状态为 `SUCCESS` 时启用；`PENDING / PROCESSING` 时禁用并显示等待原因，`FAILED / DEGRADED` 时显示恢复路径。

### 5.3 `ResearchChainStageApprovalPanel`

目标结构：

```text
StageApprovalPanel
  ├─ StageSummary
  ├─ ReviewerReadinessAlert
  ├─ StageMaterialRow[]
  ├─ SubmitSection
  ├─ ReviewActionSection
  └─ ReviewHistory
```

变更：

- `onChanged` 改名为 `onStageChanged`，调用方不得再触发整页 load。
- `firstMissingMaterial` 和全局 requirement 状态删除。
- 材料完成度以 `submission_state` 为准。
- 提交按钮仅在：
  - 所有材料 `READY`。
  - 有可提交节点。
  - 阶段 03 预检当前有效。
  - PI 要求满足或不需要 PI。
- PI 缺失提示显示在提交区上方。
- 处理中材料不阻塞其他材料行操作。

### 5.4 审核操作组件

抽出共享组件：

`research-chain-stage-review-actions.tsx`

供阶段面板和概览指挥台复用。

按钮矩阵：

| 策略 / 声明                      | 主按钮            | 次按钮                |
| -------------------------------- | ----------------- | --------------------- |
| `ADVISOR_ONLY`                   | 通过              | 驳回                  |
| `ALWAYS_PI`                      | 导师通过，转主 PI | 驳回                  |
| `CONDITIONAL_PI && requires_pi`  | 通过并转主 PI     | 通过（不转主 PI）     |
| `CONDITIONAL_PI && !requires_pi` | 通过（不转主 PI） | 通过并转主 PI（禁用） |

请求必须显式序列化：

```ts
escalate_to_pi: false;
// or
escalate_to_pi: true;
```

禁止 `undefined` 省略字段。

### 5.5 `ResearchChainDetail` 目标刷新

拆分加载：

```ts
loadChainDetail(): Promise<void>
refreshStageState(): Promise<void>
```

`loadChainDetail`：

- chain
- nodes
- members
- stage approvals
- 初始化页面状态

`refreshStageState`：

- nodes
- stage approvals
- 当本次响应的 `progress.approved` 发生变化，或 approved 达到 total 时，追加 chain detail

要求：

- 不清空 `stageDetails`。
- 不修改 `selected`。
- 不将 `loading` 置为整页 true。
- 可用局部 `stageRefreshing` 显示轻量状态。
- 失败保留旧数据并显示重试提示。

触发：

- 材料创建 / 删除。
- 上传状态变化。
- 阶段提交 / 审批。
- 窗口聚焦。
- 页面可见且存在待审阶段时每 30 秒轮询。

轮询实现：

- 使用 `document.visibilityState === "visible"`。
- 使用请求版本号避免重叠。
- 卸载时清理 focus / visibility / interval。
- 手动刷新入口保留。

知识库节点：

```text
knowledgeNodeId =
  requestedNode?.id
  ?? selectedStage.preferredNodeId
  ?? selected?.node.id
  ?? currentNode.id
  ?? ""
```

确保阶段材料读取的是当前阶段节点，而不是全局注意力节点。

### 5.6 审批中心我的提交

新增：

`apps/web/core/components/research/approvals/my-chain-stage-submissions.tsx`

数据：

```ts
todoService.getResearchTodos(workspaceSlug, { scope: "mine", limit: 100 });
```

过滤：

```ts
item.source === "CHAIN_STAGE_APPROVAL";
```

展示：

- 课题
- 阶段
- 业务状态
- 当前处理人
- 更新时间
- 深链

`ResearchApprovalCenter`：

- `ApprovalTab` 增加 `my_chain_stage`。
- Tab 可见性使用 `sections.research_chain`。
- 不要求 `canSee("reviews")`。
- 默认 Tab 选择逻辑保持现有行为；学生访问 `tab=my_chain_stage` 时可直达。

### 5.7 概览最近审批

`ResearchChainOverviewCommand`：

```text
latestReview =
  stageApprovalSummary.stages
    .flatMap(stage => stage.review_actions.map(action => ({ stage, action })))
    .sort(action.created_at desc)
    .first
```

显示所属阶段，不再读取 `stageApproval?.review_actions` 的当前阶段最后一条。

数据来自已加载的 stage summary，不新增请求。

### 5.8 任务候选人空态

`ResearchAssigneeSelect` 增加：

```ts
emptyActionHref?: string;
emptyActionLabel?: string;
```

- `candidates.length === 0` 显示成员引导和链接。
- `candidates.length > 0 && visibleCandidates.length === 0` 显示搜索无结果。
- `ResearchChainTaskPeek` 增加 `chainId` prop。
- 链接为：

```text
/{workspaceSlug}/research/chains/{chainId}?tab=members
```

### 5.9 阶段状态映射

在 `research-chain-workflow.ts` 增加：

```ts
export function researchChainStatusKey(status: string): string;
```

规则：

- 阶段状态 `NOT_STARTED / IN_PROGRESS / AWAITING_ADVISOR / AWAITING_PI / NEEDS_REVISION / APPROVED` 使用 workflow 字典。
- 节点状态使用 node 字典。
- 未知状态返回 `research.common.status_unknown`。

替换：

- `research-chain-workflow-stage-detail.tsx`
- `research-chain-overview-command.tsx`
- 其他阶段 / 节点状态 fallback

### 5.10 错误映射

扩展 `error-messages.ts`：

```ts
research_chain_stage_reviewer_not_configured;
research_chain_stage_escalation_confirm_required;
research_chain_stage_material_incomplete;
```

- 按错误码优先选择 i18n key，不再优先显示后端英文 message。
- 审核人配置错误根据 `role` 区分导师 / 主 PI。
- 材料缺失错误使用服务端 `missing` code 映射为中文材料名。
- 未知错误保留通用中文文案。

## 6. 权限、审计与安全

| 能力            | 权限入口                           | 不变量               |
| --------------- | ---------------------------------- | -------------------- |
| 上传资料        | `_chain_writer`                    | 只读协作者不能上传   |
| 创建 / 删除材料 | `_writable` + 阶段可编辑状态       | 提交后不可改         |
| 提交阶段        | `_writable` + 服务端规则           | 不能绕过材料和 PI    |
| 导师审批        | `resolve_advisor` + 当前状态       | 只处理待导师审       |
| PI 审批         | `resolve_principal` + 当前状态     | 只处理待 PI 审       |
| 我的提交        | `research_owner_id` + metadata ACL | 只看本人负责阶段     |
| 组织设置        | 现有组织管理权限                   | 无权限者只见联系提示 |

安全规则：

- 通知不发给无关成员。
- 通知 data 不包含文件内容、账号邮箱或 token。
- 深链只使用服务端生成的相对路径。
- 不通过前端隐藏按钮扩大后端权限。
- 保持现有审计和 Chain Event 写入，不把通知替代审计。

## 7. 并发、幂等与性能

### 7.1 幂等

| 操作     | 现有机制                          | 保持规则           |
| -------- | --------------------------------- | ------------------ |
| 上传     | request id + chain/node/file hash | 失败记录可重新上传 |
| 材料关联 | request id                        | 重试不重复创建     |
| 阶段提交 | request id + event id             | 重放返回当前阶段   |
| 阶段审批 | request id + review action        | 重放不重复决策     |
| 通知     | 只在首次业务变更后调用            | 幂等重放路径不创建 |

### 7.2 前端并发

- 多文件上传继续串行。
- 不同材料行的单文件上传可按行并发，但每行上传中禁用本行重复选择。
- 上传轮询使用 generation 防止旧节点回写新节点。
- 目标刷新使用版本号防止重叠响应乱序。
- 材料关联期间不触发整页 loading。

### 7.3 性能预算

| 指标                   | 预算                           |
| ---------------------- | ------------------------------ |
| stage approvals 查询数 | 保持现有 `< 40` 合同           |
| 我的阶段提交           | 一个 `research-todos` 请求     |
| 概览最近审批           | 0 个额外请求                   |
| 处理中上传轮询         | 每节点每 5 秒最多 5 个详情请求 |
| 自动阶段刷新           | 页面可见时每 30 秒一次         |
| 通知写入               | 每次状态转换最多每接收者 1 条  |

## 8. 实施切片

### A：P0 多材料闭环

改动：

1. 后端材料状态常量和投影字段。
2. `TResearchChainStageMaterial` 类型。
3. `ResearchChainStageMaterialRow`。
4. 阶段面板删除全局材料选择状态。
5. `ResearchChainDetail.refreshStageState`。
6. 知识库 controller 绑定阶段节点。
7. API 和组件测试。

完成标准：

- 02 / 05 / 06 / 12 可以连续上传并关联，不刷新页面。
- 处理中文件不计入完成度。

### B：P0 主 PI 与条件审批

改动：

1. reviewer `reason_code`。
2. PI 前置提示和提交禁用原因。
3. 项目创建组织 PI 警告。
4. 共享审核操作组件。
5. 条件审批显式布尔载荷。
6. 错误映射。
7. API 和组件测试。

完成标准：

- 03/10/11/12/13 未配置主 PI 时提交前可见阻断。
- 07/08/09 导师审批显式选择是否转 PI。

### C：P1 状态一致性

改动：

1. 上传状态轮询。
2. 处理中等待时长。
3. 失败原因与重新上传。
4. 课题资料面板单一状态展示。
5. 历史文字材料说明。
6. 已审批阶段快照解释。

完成标准：

- 上游成功后页面不刷新也能变为已完成。
- 同一材料行不同时输出冲突结论。

### D：P2 进度、通知与辅助体验

改动：

1. 阶段状态自动刷新。
2. 我的阶段提交。
3. 阶段通知和通知渲染。
4. 概览全阶段最近审批。
5. 任务候选人空态。
6. 工作项通知 i18n。
7. 状态 key 修复。

完成标准：

- 学生能跟踪阶段并收到结果通知。
- 概览与阶段详情一致。

## 9. 测试矩阵

### 9.1 API 契约测试

修改：

- `apps/api/plane/tests/contract/app/test_research_chain_stage_approvals.py`
- `apps/api/plane/tests/contract/app/test_research_chain_knowledge.py`
- `apps/api/plane/tests/contract/app/test_research_chain_stage_notifications.py`（新增）

用例：

1. 处理中上传关联后 `submitted_count=0`、`complete=false`、`submission_state=PROCESSING`。
2. 上传成功后 `submitted_count=1`、`complete=true`、`submission_state=READY`。
3. 失败上传关联后 `submission_state=FAILED`。
4. 无上传的历史文字条目不计数。
5. 同一材料最低数量为 5 时，4 个成功 + 1 个处理中仍不可提交。
6. 详情刷新成功后，列表返回同一状态。
7. `ALWAYS_PI` 主 PI 缺失时提交返回 422 和 `research_chain_stage_reviewer_not_configured`。
8. `CONDITIONAL_PI && requires_pi=true` 主 PI 缺失时提交返回 422。
9. `CONDITIONAL_PI && requires_pi=false` 无主 PI 时可提交。
10. 条件阶段缺少 `escalate_to_pi` 时导师通过返回 422。
11. `escalate_to_pi=false` 时导师通过后阶段 `APPROVED`。
12. `requires_pi=true` 且 `escalate_to_pi=true` 时阶段进入 `AWAITING_PI`。
13. `requires_pi=false` 且 `escalate_to_pi=true` 返回 422。
14. 提交、转 PI、通过、退回各创建预期通知。
15. 审批 request id 重放不重复通知。
16. `scope=mine` 返回负责人待审、退回和已通过阶段。
17. `scope=to_me` 仍只返回当前 reviewer 待办。
18. stage list 查询数仍低于 40。

### 9.2 Web 组件测试

修改：

- `apps/web/tests/components/research-chain-stage-approval-panel.test.tsx`
- `apps/web/tests/components/research-chain-knowledge-panel.test.tsx`
- `apps/web/tests/components/research-chain-detail.test.tsx`
- `apps/web/tests/components/research-approval-center.test.tsx`
- `apps/web/tests/components/chain-stage-approval-inbox.test.tsx`
- `apps/web/tests/components/research-chain-task-panel.test.tsx`

新增：

- `research-chain-stage-material-row.test.tsx`
- `my-chain-stage-submissions.test.tsx`
- `research-chain-stage-review-actions.test.tsx`
- `workspace-notification-content.test.tsx`

用例：

1. 第 1 项关联后第 2 项上传控件仍可用。
2. 每行上传请求携带该行 `requirement_code`。
3. 处理中行不禁用其他材料行。
4. 上传失败显示行内错误，不创建材料。
5. 局部刷新不重置知识库 controller。
6. 处理中、失败、成功、待补充状态互斥。
7. 主 PI 缺失显示提示和配置路径。
8. 主 PI 缺失时 `ALWAYS_PI` 提交禁用。
9. 条件阶段两个按钮分别传 false / true。
10. 学生能看到我的阶段提交且无审批按钮。
11. 我的阶段提交空态和失败态不同。
12. 概览最近审批来自全阶段最新 action。
13. 无候选人时显示成员页链接。
14. 工作项 label / state / name 通知按 locale 渲染。
15. `IN_PROGRESS` 显示“进行中”，不显示 key。

### 9.3 浏览器验收

使用现有 Playwright / fixture 方式补：

- `apps/web/tests/browser/research-chain-stage-approval.fixture.tsx`
- `apps/web/tests/browser/research-chain-knowledge.fixture.tsx`

检查：

1. 1440 / 1280 / 390 宽度。
2. 多材料连续上传。
3. 长文件名截断。
4. 键盘完成上传和审批。
5. 局部刷新不丢焦点。
6. 灰度截图层级清晰。
7. 无渐变、发光、彩色装饰卡片。

### 9.4 手工端到端

在测试环境准备学生、导师、主 PI、组织管理员四类账号：

1. 学生进入 02，连续上传 5 项材料。
2. 处理中继续上传后续材料。
3. 全部成功后提交。
4. 导师通过 02。
5. 学生页面自动从 1/13 更新。
6. 学生进入 07，分别测试声明 / 不声明 PI。
7. 导师分别执行不转 PI / 转 PI。
8. 学生进入 13，验证主 PI 缺失提示。
9. 管理员配置唯一主 PI。
10. 学生刷新后提交 13。
11. 导师转 PI，主 PI 通过。
12. 学生收到中文通知并从通知直达阶段。

## 10. 发布与回滚

### 10.1 发布顺序

1. 合入 A 并跑 API / 组件回归。
2. 合入 B，验证 PI 和条件审批。
3. 合入 C，观察 RAGPortal 详情延迟。
4. 合入 D，开放我的提交和通知。
5. 全量回归后发布 `9.3.0`。

### 10.2 数据与兼容

- 无迁移。
- 不回填历史上传状态。
- 历史处理中记录由详情轮询自然收敛。
- 历史审批快照不重算。
- 新 API 字段可被旧前端忽略。
- 旧字段全部保留。

### 10.3 回滚

| 切片 | 回滚策略                                                    |
| ---- | ----------------------------------------------------------- |
| A    | revert 后 `PROCESSING` 重新计入完成度；需同步回滚前端行组件 |
| B    | revert reviewer 扩展和审核操作组件；后端规则本身未破坏      |
| C    | revert 轮询 hook；上传详情接口仍可手动刷新                  |
| D    | revert 通知 / 我的提交 / 刷新；不影响阶段状态数据           |

新增字段可留在响应中，不需要数据库清理。

### 10.4 观测

发布后观察：

- RAGPortal upload detail 延迟与 5xx。
- 处理中上传收敛到成功的比例。
- `PROCESSING` 超过 5 分钟的数量。
- 阶段提交 422 中主 PI 配置错误占比。
- 条件审批 false / true 分布。
- 通知创建失败或缺失。
- 我的阶段提交接口延迟。

## 11. 兼容与清理边界

允许：

- 抽出材料行、审核操作和状态映射 helper。
- 增加只读投影字段。
- 将重复按钮逻辑收敛为共享组件。

禁止：

- 不新增科研链、阶段、材料、通知表。
- 不迁移主 PI 到课题字段。
- 不重写历史 Chain Event 或审批 action。
- 不把 `research-todo` 改成可写对象。
- 不引入 WebSocket 强依赖；轮询已满足本阶段可靠性目标。
- 不在 Phase 1.7 顺手清理无关科研模块。

## 12. 完成定义

- PRD 全部 P0 / P1 / P2 场景通过自动化或手工验收。
- 13 个阶段中至少覆盖：
  - 一个 `ADVISOR_ONLY` 多材料阶段；
  - 一个 `ALWAYS_PI` 阶段；
  - 一个 `CONDITIONAL_PI` 阶段。
- 学生、导师、主 PI 三视角闭环可走通。
- API 合同、类型、i18n 和示例同步。
- 代码发布时版本同步升至 `9.3.0`。
- 本设计文档和 PRD 状态由“待评审”更新为“已实施”。
