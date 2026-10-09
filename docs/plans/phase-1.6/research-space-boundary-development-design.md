# Phase 1.6 主轴一：课题与项目管理逻辑厘清开发设计

| 项目     | 内容                                                                                                                                    |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| 文档版本 | v1.1                                                                                                                                    |
| 状态     | 设计复核修订版；补齐科研/行政双通道指派边界、初始目标闭环和偏差提醒后续合同                                                             |
| 日期     | 2026-10-09                                                                                                                              |
| 代码基线 | Plane `develop` / `4.23.2`                                                                                                              |
| 上游 PRD | [`research-intelligent-platform-phase-1.6-prd.md`](../../product/research-intelligent-platform-phase-1.6-prd.md)                        |
| 关联设计 | [UX 精炼设计](research-space-ux-refinement-development-design.md)、[代码精炼设计](research-space-code-refinement-development-design.md) |

## 1. 设计结论

Phase 1.6 不拆除 `ResearchChain` 与 `Project` 的现有关系，不改变 13 段科研链节点结构、组织继承和科研 ACL。本主轴通过三类**加法对象**补齐产品语义：

1. `ResearchChainNodeTask`：课题节点下的可指派任务，不改变节点生命周期。
2. `PeriodicReportReadReceipt`：周报正式版本的 append-only 已读回执。
3. `ResearchPaperReview` / `ResearchPaperReviewVersion`：论文修改版本与评审闭环；评论继续用 Chain Event 表达，不新建评论表。

任务、回执和论文评审都不自动迁移历史数据，也不自动转换 Project / Issue。既有 `ResearchChainNode.assignee` 继续表示节点主责任人；新增任务可以有多条，各自有责任人和截止时间。

## 2. 当前代码事实

| 领域     | 当前事实                                                                                                         | 设计含义                                        |
| -------- | ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| 课题载体 | `ResearchChain.project` 是 `OneToOneField(Project)`；`ResearchProjectProfile.chain_kind` 标识培养 / 研究链课题。 | 只做语义分流，不拆除技术关系。                  |
| 节点模型 | `ResearchChainNode` 只有 `node_type`、`parent_node`、`loop_iteration`、`status`、单值 `assignee`，没有截止时间。 | 需要子任务对象，不给节点本体加职责字段。        |
| 节点状态 | `chain_state.TRANSITIONS` 固定 `DRAFT/ACTIVE/WAITING_HUMAN/NEEDS_REVISION/COMPLETED/FAILED/ARCHIVED`。           | 任务状态独立，不隐式推进节点状态。              |
| 过程证据 | `ResearchChainEvent` append-only，已有 `COMMUNICATION`、`HUMAN_DECISION`、`APPROVAL`、`DATA_CHANGE` 等事件。     | 评论与决策继续写 Chain Event。                  |
| 权限     | `check_access`、`visible_profile_queryset`、`_chain_writer`、`_review_only_actor` 是当前判权入口。               | 新对象必须投影为现有 ACL 资源，不新增旁路。     |
| 组织     | `OrgUnit.path` 支持祖先和子树查询；`org_unit_ancestry` 返回上级节点。                                            | 可指派范围 = 当前组织 + 祖先 + 显式课题协作者。 |
| 周报     | `PeriodicReport` 有 `DRAFT/SUBMITTED/NEEDS_REVISION/ACCEPTED` 和 `ReportReviewLog`，但没有已读回执。             | 增加 append-only read receipt。                 |
| 论文成果 | `ResearchOutcome` 及附件只在 DRAFT 状态可上传；`Outcome` 是成果登记，不适合承载多轮修改评审。                    | 论文评审需要独立版本对象。                      |
| 行政审批 | `ApprovalRequest` 复用 Plane `Issue`，类型为 `TASK/PURCHASE/CUSTOM`。                                            | 行政事务继续留在 Project / Issue / Approval。   |

关键代码入口：

- 模型：`apps/api/plane/db/models/research/{chain,report,outcome,approval,stage}.py`
- 判权：`apps/api/plane/research/utils/acl.py`
- Chain API：`apps/api/plane/research/views/chain_foundation.py`
- 报告 API：`apps/api/plane/research/views/reports.py`
- 事件字典：`apps/api/plane/research/services/chain_state.py`

## 3. 通道归属规则

| 事项                 | 归属对象                                                                | 禁止行为                               |
| -------------------- | ----------------------------------------------------------------------- | -------------------------------------- |
| 文献调研、实验记录   | 课题节点 + 对应权威对象（Literature / Experiment / External Reference） | 不建行政 Project                       |
| 预开题、开题、中期   | Stage Material + 课题节点任务                                           | 不复制到行政审批                       |
| 周报 / 月报          | `PeriodicReport` + 课题关联 + 已读回执                                  | 不用 Issue 评论代替正式审核日志        |
| 论文修改评审         | `ResearchPaperReview*` + `PAPER_WRITING` 节点                           | 不把 Outcome 附件当作评审版本          |
| 采购、报销、行政任务 | Plane `Project / Issue / ApprovalRequest`                               | 不生成课题节点，不写入科研 Chain Event |
| 混合事项             | 拆成科研任务和行政任务两条记录，并互相保留链接                          | 不做自动双向复制                       |

前端只提供“通道选择”和文案提示；服务端不强制把历史 Project 改成行政项目。

## 4. 数据设计

### 4.1 `ResearchChainNodeTask`

节点任务是 Chain Node 的子对象，不改变节点类型、主链映射和状态机。

| 字段            | 类型 / 值                                                               | 说明                        |
| --------------- | ----------------------------------------------------------------------- | --------------------------- |
| `workspace`     | FK `Workspace`，`PROTECT`                                               | 租户边界                    |
| `chain`         | FK `ResearchChain`，`PROTECT`，`related_name="node_tasks"`              | 冗余持有，便于待办聚合      |
| `node`          | FK `ResearchChainNode`，`PROTECT`，`related_name="tasks"`               | 必须属于当前 chain          |
| `title`         | CharField 500                                                           | 任务标题                    |
| `instruction`   | TextField blank                                                         | 提交要求，不存正式正文      |
| `status`        | `DRAFT/ASSIGNED/SUBMITTED/NEEDS_REVISION/COMPLETED/CANCELLED`           | 独立任务状态                |
| `assignee`      | FK `User`，`SET_NULL`，nullable                                         | 任务责任人                  |
| `assigned_by`   | FK `User`，`SET_NULL`，nullable                                         | 指派人                      |
| `due_at`        | DateTimeField nullable                                                  | 截止时间                    |
| `submitted_at`  | DateTimeField nullable                                                  | 最近提交时间                |
| `completed_at`  | DateTimeField nullable                                                  | 完成时间                    |
| `resource_type` | `NONE/REPORT/STAGE_MATERIAL/OUTCOME/PAPER_REVIEW/SNAPSHOT/EXTERNAL_REF` | 提交物权威对象类型          |
| `resource_id`   | UUIDField nullable                                                      | 权威对象 ID，服务端校验归属 |
| `request_id`    | CharField 128 unique                                                    | 写入幂等键                  |
| `payload_hash`  | CharField 64                                                            | 幂等负载哈希                |
| `metadata`      | JSON default dict                                                       | 展示性补充，不作为判权依据  |

约束与索引：

- 唯一：`request_id`。
- 索引：`(workspace, status, due_at)`、`(chain, status)`、`(node, status)`、`(assignee, status, due_at)`。
- 校验：`resource_type != NONE` 时 `resource_id` 必填；`resource_type == NONE` 时必须为空。
- 软删除沿用 `BaseModel`；CANCELLED 不物理删除。

状态机：

```text
DRAFT --assign--> ASSIGNED
ASSIGNED --submit--> SUBMITTED
SUBMITTED --return--> NEEDS_REVISION
NEEDS_REVISION --submit--> SUBMITTED
SUBMITTED --complete--> COMPLETED
DRAFT/ASSIGNED/NEEDS_REVISION --cancel--> CANCELLED
```

规则：

- 任务提交不自动把节点改为 `WAITING_HUMAN`；节点生命周期仍由现有 transition API 显式触发。
- 任务完成不自动完成节点。
- 节点归档后任务只读；Chain `ARCHIVED/COMPLETED` 时拒绝任务写入。
- 每次状态变化写一条 Chain Event，并同步 `ResearchAuditEvent`。

### 4.2 `PeriodicReportReadReceipt`

| 字段               | 类型 / 值                      | 说明                         |
| ------------------ | ------------------------------ | ---------------------------- |
| `report`           | FK `PeriodicReport`，`PROTECT` | 报告归属                     |
| `reader`           | FK `User`，`PROTECT`           | 阅读者                       |
| `snapshot_version` | PositiveIntegerField           | 读取的正式版本号             |
| `read_at`          | DateTimeField auto_now_add     | 服务端时间                   |
| `source`           | `DETAIL_VIEW`                  | 预留来源，不用客户端时间覆盖 |

约束：

- 唯一：`(report, reader, snapshot_version)`。
- Append-only：禁止 update/delete。
- 只对 `submitted_at != null` 的报告创建回执。
- 阅读者必须具备该报告 `view` 或 `review` 权限；作者浏览不生成导师已读回执。

### 4.3 `ResearchPaperReview`

论文评审挂在既有 `PAPER_WRITING` 节点上，不自动创建节点，不改变 13 段 Workflow。

| 字段                 | 类型 / 值                                                 | 说明              |
| -------------------- | --------------------------------------------------------- | ----------------- |
| `workspace`          | FK `Workspace`，`PROTECT`                                 | 租户边界          |
| `chain`              | FK `ResearchChain`，`PROTECT`                             | 课题归属          |
| `node`               | FK `ResearchChainNode`，`PROTECT`，必须是 `PAPER_WRITING` | 过程上下文        |
| `outcome`            | FK `ResearchOutcome`，`SET_NULL`，nullable                | 可选关联成果登记  |
| `owner`              | FK `User`，`CASCADE`                                      | 论文作者 / 提交人 |
| `status`             | `OPEN/WAITING_REVIEW/NEEDS_REVISION/ACCEPTED/WITHDRAWN`   | 评审状态          |
| `current_version_no` | PositiveIntegerField default 0                            | 当前最新版本      |
| `final_reviewer`     | FK `User`，`SET_NULL`，nullable                           | 配置化最终确认人  |
| `due_at`             | DateTimeField nullable                                    | 评审截止时间      |
| `request_id`         | CharField 128 unique                                      | 创建幂等键        |
| `payload_hash`       | CharField 64                                              | 幂等负载哈希      |

### 4.4 `ResearchPaperReviewVersion`

| 字段             | 类型 / 值                           | 说明                |
| ---------------- | ----------------------------------- | ------------------- |
| `review`         | FK `ResearchPaperReview`，`PROTECT` | 评审归属            |
| `version_no`     | PositiveIntegerField                | 从 1 递增           |
| `asset`          | FK `FileAsset`，`PROTECT`           | PDF / Markdown 文件 |
| `file_name`      | CharField 255                       | 展示名              |
| `content_type`   | CharField 128                       | 文件类型            |
| `file_size`      | PositiveBigIntegerField             | 文件大小            |
| `change_summary` | TextField                           | 本轮修改说明，必填  |
| `status`         | `SUBMITTED/SUPERSEDED/ACCEPTED`     | 版本状态            |
| `submitted_by`   | FK `User`，`SET_NULL`               | 提交人              |
| `submitted_at`   | DateTimeField                       | 服务端提交时间      |
| `content_hash`   | CharField 64                        | 文件哈希            |
| `request_id`     | CharField 128 unique                | 提交幂等键          |

评论不建新表：作者、导师和最终确认人均写 `COMMUNICATION` Chain Event，`refs` 固定包含 `{kind: "paper_review", id, version_no}`。退回、接受和撤回写 `HUMAN_DECISION` / `PAPER_REVIEW_*` 事件。

## 5. 事件与 Agent 契约

在 `chain_state.py` 追加事件类型，不删除既有事件：

```text
TASK_CREATED
TASK_ASSIGNED
TASK_SUBMITTED
TASK_RETURNED
TASK_COMPLETED
TASK_CANCELLED

PAPER_REVIEW_OPENED
PAPER_VERSION_SUBMITTED
PAPER_REVIEW_COMMENTED
PAPER_REVIEW_RETURNED
PAPER_REVIEW_ACCEPTED
PAPER_REVIEW_WITHDRAWN
```

Agent 契约：

- Plane 只调用 Synlora Agent；具体模型由 Synlora 配置。
- 预开题 AI 结果只能进入 `ResearchAnalysisResult(status=DRAFT)` 或 Agent 草稿，不得直接修改 Stage Material、任务状态或论文版本。
- Agent 交互摘要写 `AI_ACTION`，人工确认写 `HUMAN_DECISION`。
- AI 不可获得行政 Project / Issue 权限。

## 6. 可指派用户与权限

### 6.1 候选人解析

新增内部服务 `assignable_chain_users(workspace, chain)`：

1. 读取 `chain.project.research_profile.org_unit`。
2. 使用 `org_unit_ancestry(profile.org_unit_id, workspace.id)` 取上级节点，候选组织 = 当前节点 + 祖先。
3. 查询这些节点的有效 `OrgUnitMember`，并要求对应用户有活跃 Workspace Member 席位、非 Guest。
4. 并入当前课题显式协作者（活跃 `ProjectMember`）。
5. 去重后返回 `user_id/display_name/org_unit_name/org_role/is_primary/scope`。

`scope` 只有：

- `ORG_SCOPE`：当前组织或上级组织成员。
- `COLLABORATOR`：显式课题协作者。

### 6.3 行政项目指派边界

行政 Project 不复用 `assignable_chain_users`。行政项目负责人和 Issue assignee 的候选人必须来自当前 Project 的有效 `ProjectMember`，过滤 `is_active=true`、`deleted_at IS NULL`，并保留 Plane 现有项目角色。普通 Workspace 成员、科研组织祖先成员、跨组织人员和 Workspace Admin 均不会因为身份本身自动进入候选集合；跨组织人员必须先通过既有 ProjectMember 管理流程加入项目。

行政审批人继续由 `ApprovalRequest` 当前 flow step 解析。负责人下拉只改变 Project/Issue 的协作责任人，不改变审批步骤、审批范围或 Chain ACL。行政项目的候选响应至少包含 `user_id/display_name/project_role/is_active`，前端按“项目成员”分组，只能在响应集合内搜索。

两套候选接口都必须服务端校验最终 ID；客户端伪造未返回的 ID 统一返回权限错误，不得通过直接写入 Issue 或任务绕过范围判断。

不提供全工作区自由搜索；无组织课题只能看到显式协作者。

### 6.2 动作矩阵

| 动作               | 判定                                                                      |
| ------------------ | ------------------------------------------------------------------------- |
| 查看任务 / 评审    | 能查看 Chain，且任务未被权限过滤                                          |
| 创建 / 指派 / 改期 | `_chain_writer` 或 `_chain_manager`；assignee 必须在候选人列表中          |
| 任务提交           | 当前用户是 assignee，且任务状态为 `ASSIGNED/NEEDS_REVISION`               |
| 任务退回 / 完成    | `check_access(..., "review"/"return")` 通过，或 `_review_only_actor` 为真 |
| 周报已读           | 通过报告 ACL，且报告已有正式快照                                          |
| 论文版本提交       | Review owner 或 Chain writer，节点为 `PAPER_WRITING`，Chain 活跃          |
| 论文退回 / 接受    | 有效直接导师、主 PI、管理链、显式 final_reviewer，且不是作者              |
| 撤回评审           | Review owner 或 Chain manager，`ACCEPTED` 前允许                          |

Workspace Admin 只获得管理和审计入口，不因技术身份自动获得上述科研评审动作。

## 7. API 设计

所有新 API 挂在现有 `/api/research/` 命名空间，使用现有成功 / 错误 envelope，并受 `research_chain_enabled` 和现有 nav capability 约束。

### 7.1 节点任务

| 方法与路径                                                                                     | 说明                                      |
| ---------------------------------------------------------------------------------------------- | ----------------------------------------- |
| `GET /research/workspaces/{slug}/chains/{chain_id}/nodes/{node_id}/tasks/`                     | 任务列表，支持 status/assignee/due_before |
| `POST /research/workspaces/{slug}/chains/{chain_id}/nodes/{node_id}/tasks/`                    | 创建任务，需 `request_id`                 |
| `PATCH /research/workspaces/{slug}/chains/{chain_id}/nodes/{node_id}/tasks/{task_id}/`         | 未提交前改标题、说明、指派人、截止时间    |
| `POST /research/workspaces/{slug}/chains/{chain_id}/nodes/{node_id}/tasks/{task_id}/submit/`   | 责任人提交                                |
| `POST /research/workspaces/{slug}/chains/{chain_id}/nodes/{node_id}/tasks/{task_id}/return/`   | 评审人退回，reason 必填                   |
| `POST /research/workspaces/{slug}/chains/{chain_id}/nodes/{node_id}/tasks/{task_id}/complete/` | 评审人完成，comment 可选                  |
| `POST /research/workspaces/{slug}/chains/{chain_id}/nodes/{node_id}/tasks/{task_id}/cancel/`   | 管理者取消，reason 必填                   |
| `GET /research/workspaces/{slug}/chains/{chain_id}/assignable-users/`                          | 指派候选人                                |

创建请求：

```json
{
  "title": "补充论文第 3 节对照说明",
  "instruction": "说明实验组与对照组的差异",
  "assignee_id": "uuid",
  "due_at": "2026-10-15T12:00:00+08:00",
  "resource_type": "NONE",
  "resource_id": null,
  "request_id": "uuid-or-stable-id"
}
```

### 7.2 周报已读

| 方法与路径                                                           | 说明                               |
| -------------------------------------------------------------------- | ---------------------------------- |
| `POST /research/workspaces/{slug}/reports/{report_id}/read/`         | 对最新正式快照写已读回执，幂等     |
| `GET /research/workspaces/{slug}/reports/{report_id}/read-receipts/` | 作者、导师、主 PI 和管理员可看汇总 |

`POST` 响应返回 `has_read/read_at/snapshot_version`，重复读取返回已有记录。

### 7.3 论文修改评审

| 方法与路径                                                                                 | 说明                                             |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------ |
| `POST /research/workspaces/{slug}/chains/{chain_id}/nodes/{node_id}/paper-reviews/`        | 打开评审，可指定 outcome、final_reviewer、due_at |
| `GET /research/workspaces/{slug}/chains/{chain_id}/nodes/{node_id}/paper-reviews/`         | 当前节点评审列表                                 |
| `GET /research/workspaces/{slug}/paper-reviews/{review_id}/`                               | 评审详情和版本列表                               |
| `POST /research/workspaces/{slug}/paper-reviews/{review_id}/versions/`                     | 提交新版本                                       |
| `GET /research/workspaces/{slug}/paper-reviews/{review_id}/versions/{version_no}/`         | 版本详情                                         |
| `POST /research/workspaces/{slug}/paper-reviews/{review_id}/versions/{version_no}/return/` | 退回，comment 必填                               |
| `POST /research/workspaces/{slug}/paper-reviews/{review_id}/versions/{version_no}/accept/` | 最终确认                                         |
| `POST /research/workspaces/{slug}/paper-reviews/{review_id}/withdraw/`                     | 作者撤回                                         |

文件上传复用 S3 presign 模式，实体类型固定 `RESEARCH_PAPER_REVIEW_VERSION`；只允许 `.pdf/.md/.markdown`。

## 8. 实现切片

### L0：契约与夹具

- 在 `packages/types/src/research.ts` 增加任务、已读、论文评审类型。
- 在 contract fixture 中固定角色、组织、候选人、报告快照和 `PAPER_WRITING` 节点。
- 先写失败测试，不改业务行为。

### L1：模型与迁移

- 新增三组模型和可回滚迁移。
- 注册 `db.models.research.__init__`。
- 验证索引、唯一约束和 append-only 保护。

### L2：候选人范围

- 实现 `assignable_chain_users`。
- 新增 assignable-users API。
- 覆盖本组、上级、下级拒绝、跨组织显式协作者、Guest 拒绝。

### L3：节点任务服务与 API

- 新增 task service、serializer、views、urls。
- 所有状态变化写 Chain Event 和审计。
- 前端暂不消费，API 先通过契约测试。

### L4：周报已读

- 新增 read receipt API。
- 报告详情加载正式版本后自动发一次 `POST /read/`。
- 列表和详情返回 `has_read/read_count/latest_read_at`。

### L5：论文评审

- 新增评审和版本 API。
- 接入 S3 presign、文件类型和大小限制。
- 评论与决策写 Chain Event。

### L6：待办与总览聚合

- Chain serializer 增加 `open_task_count/next_due_at/current_node`。
- `collectResearchTodos` 增加任务和论文评审来源。
- 周报待办区分“待阅读”和“待审阅”。

## 9. 测试与验收

后端契约测试至少覆盖：

1. 学生创建课题任务并指派给本组或上级有效用户。
2. 下级组织用户、无关用户和 Guest 不出现在候选人列表。
3. 跨组织协作者显式加入课题后可被指派。
4. assignee 提交任务，导师退回，学生再提交，导师完成。
5. 任务状态变化不隐式改变节点状态。
6. 导师打开已提交周报产生一条已读回执，重复打开幂等。
7. 作者浏览不伪造导师已读。
8. 论文版本 1 提交、退回、版本 2 提交、最终确认，Chain Event 顺序完整。
9. 非 `PAPER_WRITING` 节点拒绝创建论文评审。
10. Workspace Admin 不能仅凭管理员身份评审。
11. 行政 ApprovalRequest 不产生 Chain Event。
12. 关闭 `research_chain_enabled` 后新 API 返回禁用口径。

前端测试至少覆盖：

- 任务面板的角色按钮与无权限态。
- 周报已读标签和待办状态。
- 论文版本列表、退回意见和最终确认状态。
- 通道选择文案不把行政项目写成课题。

## 10. 回滚与兼容

- 迁移必须提供反向操作：删新增表和索引，不改旧表。
- 新 API 版本分别为 `research-node-task.v1`、`report-read-receipt.v1`、`paper-review.v1`。
- 不回填历史任务、已读或论文版本。
- 不改变既有 `research-chain.v1`、报告 API、Outcome API 和 Approval API 的字段。
- 功能统一受现有 `research_chain_enabled` 控制，不新增平行总开关。

## 11. 工程落地附录：主轴一实现蓝图

本节是 §4–§8 的执行级补充。实现时不得用本节替代权限测试；每个服务函数仍必须通过 contract test 验证。

### 11.1 文件与注册清单

| 类型     | 文件                                                                | 新增 / 修改 | 内容                                                |
| -------- | ------------------------------------------------------------------- | ----------- | --------------------------------------------------- |
| 模型     | `apps/api/plane/db/models/research/task.py`                         | 新增        | `ResearchChainNodeTask`                             |
| 模型     | `apps/api/plane/db/models/research/paper_review.py`                 | 新增        | `ResearchPaperReview`、`ResearchPaperReviewVersion` |
| 模型     | `apps/api/plane/db/models/research/report.py`                       | 修改        | 追加 `PeriodicReportReadReceipt`                    |
| 模型注册 | `apps/api/plane/db/models/research/__init__.py`                     | 修改        | 导入新模型并加入 `__all__`                          |
| 模型注册 | `apps/api/plane/db/models/__init__.py`                              | 修改        | 从 research 包导入新模型                            |
| 迁移     | `apps/api/plane/db/migrations/0166_research_space_collaboration.py` | 新增        | 建表、索引、约束和反向迁移                          |
| 服务     | `apps/api/plane/research/services/chain_tasks.py`                   | 新增        | 任务与候选人服务                                    |
| 服务     | `apps/api/plane/research/services/report_read_receipt.py`           | 新增        | 周报已读服务                                        |
| 服务     | `apps/api/plane/research/services/paper_review.py`                  | 新增        | 论文评审服务                                        |
| 序列化   | `apps/api/plane/research/serializers/collaboration.py`              | 新增        | 三组 serializer                                     |
| 视图     | `apps/api/plane/research/views/chain_tasks.py`                      | 新增        | 任务 API                                            |
| 视图     | `apps/api/plane/research/views/report_read.py`                      | 新增        | 已读 API                                            |
| 视图     | `apps/api/plane/research/views/paper_reviews.py`                    | 新增        | 论文评审 API                                        |
| 错误码   | `apps/api/plane/research/utils/errors.py`                           | 修改        | 新增协作错误码                                      |
| 事件字典 | `apps/api/plane/research/services/chain_state.py`                   | 修改        | 追加协作事件类型                                    |
| 审计字典 | `apps/api/plane/research/utils/audit.py`                            | 修改        | 追加协作 action / resource type                     |
| 通知     | `apps/api/plane/research/utils/collaboration_notifications.py`      | 新增        | 任务与论文评审通知                                  |
| 路由     | `apps/api/plane/research/urls.py`                                   | 修改        | 注册协作 endpoint                                   |
| 前端常量 | `packages/constants/src/research.ts`                                | 修改        | 新增 endpoint builder                               |
| 前端类型 | `packages/types/src/research.ts`                                    | 修改        | 新增类型                                            |
| 前端服务 | `apps/web/core/services/research/collaboration.service.ts`          | 新增        | API 调用封装                                        |

注册顺序：

1. 先定义模型并注册，生成迁移前运行 `makemigrations db --check` 确认无漂移。
2. 再导入 service / serializer / view。
3. 最后注册 URL 与前端 endpoint，避免出现路由指向未导出类的中间状态。

### 11.2 数据库执行细节

#### `ResearchChainNodeTask`

- 继承 `BaseModel`，保留软删除字段；业务取消使用 `CANCELLED`，不依赖删除。
- `workspace`、`chain`、`node` 均使用 `PROTECT`，避免误删课题时丢失任务证据。
- `assignee`、`assigned_by` 使用 `SET_NULL`，保留历史责任轨迹。
- `resource_type` / `resource_id` 只做弱引用，服务层校验对象存在且归属当前课题。
- 索引：
  - `rsch_task_ws_status_idx(workspace, status)`
  - `rsch_task_chain_status_idx(chain, status)`
  - `rsch_task_node_status_idx(node, status)`
  - `rsch_task_assignee_due_idx(assignee, status, due_at)`
- Check 约束：
  - `resource_type = 'NONE' AND resource_id IS NULL`
  - `resource_type <> 'NONE' AND resource_id IS NOT NULL`
  - `due_at IS NULL OR submitted_at IS NULL OR due_at >= submitted_at` 不强制；业务允许补交超期任务，逾期只影响 UI urgency。
- `request_id` 全局唯一，复用 `payload_hash` 幂等策略。

#### `PeriodicReportReadReceipt`

- 继承 `AppendOnlyModel`，不用 `BaseModel`。
- `report`、`reader` 使用 `PROTECT`。
- 字段：
  - `snapshot_version`
  - `read_at`
  - `source`
- 唯一约束：`(report, reader, snapshot_version)`。
- 索引：`(report, snapshot_version, read_at)`。
- `save()` 只允许新增，`delete()` 永久拒绝。
- 不写 Chain Event，避免高频浏览制造过程噪音；已读事实以本表为唯一权威。

#### `ResearchPaperReview`

- 继承 `BaseModel`。
- `workspace/chain/node/outcome` 使用 `PROTECT`；`outcome` nullable。
- `owner`、`final_reviewer` 使用 `SET_NULL`，但服务层在创建时必须保存 ID 快照到 `metadata`，避免人员变动后无法解释历史。
- 索引：
  - `rsch_paper_review_chain_idx(chain, status)`
  - `rsch_paper_review_node_idx(node, status)`
  - `rsch_paper_review_owner_idx(owner, status)`
- 一个节点允许多个论文评审，但同一 `outcome` 在同一节点下最多一个未撤回评审；用服务查询约束，不建数据库唯一键，避免历史数据迁移争议。

#### `ResearchPaperReviewVersion`

- 继承 `AppendOnlyModel`。
- `review/asset/submitted_by` 使用 `PROTECT`。
- 唯一约束：`(review, version_no)`。
- 索引：`(review, status, submitted_at)`。
- `content_hash` 定义为服务端 `payload_hash`：
  - 输入包含 `review_id`、`asset_id`、`file_name`、`file_size`、`change_summary`、`request_id`。
  - 它是提交负载完整性哈希，不承诺完整文件内容哈希。
- 文件完整性要求：
  - presign 前客户端必须计算 `sha256` 并写入 `attributes["sha256"]`。
  - 注册版本时服务端记录该值。
  - Phase 1.6 不做服务端全文重算；后续如引入 S3 校验任务，再异步验证。

#### 迁移 `0166_research_space_collaboration.py`

正向依赖：

1. `migrations.SeparateDatabaseAndState` 不需要；新表直接 `CreateModel`。
2. 先建 `ResearchChainNodeTask`。
3. 建 `PeriodicReportReadReceipt`。
4. 建 `ResearchPaperReview`，再建 `ResearchPaperReviewVersion`。
5. 最后添加索引和约束，便于失败时定位。

反向操作：

- 按子表到父表顺序删除：
  1. `ResearchPaperReviewVersion`
  2. `ResearchPaperReview`
  3. `PeriodicReportReadReceipt`
  4. `ResearchChainNodeTask`
- 不修改既有表。
- 不删除 `FileAsset`；文件资产仍由通用资产生命周期管理。

### 11.3 服务函数契约

所有协作服务遵循同一顺序：

```text
解析对象 → 检查 workspace/module/switch → 检查 ACL → 幂等重放
→ 锁定父对象 → 校验状态和归属 → 写业务对象 → 写 Chain Event
→ 写审计 → 发通知 → 返回 serializer data
```

#### `chain_tasks.py`

```python
def list_assignable_users(workspace, chain, actor) -> list[dict]
```

- 权限：actor 必须能查看 Chain，且是 `_chain_manager` 或 `_chain_writer`。
- 组织范围：
  - `profile.org_unit`
  - `org_unit_ancestry(profile.org_unit_id, workspace.id)`
- 成员条件：
  - `WorkspaceMember.is_active=True`
  - workspace role in `(15, 20)`
  - `OrgUnitMember` 当前有效。
- 显式协作者：
  - 活跃 `ProjectMember`，即使不属于上述组织。
- 返回字段：
  - `user_id`
  - `display_name`
  - `org_unit_id`
  - `org_unit_name`
  - `org_role`
  - `is_primary`
  - `scope: ORG_SCOPE | COLLABORATOR`
- 排序：`ORG_SCOPE` 先于 `COLLABORATOR`，组内 primary、角色、显示名排序。
- 不返回 email、手机号或头像以外的账号敏感字段。

```python
def create_task(*, workspace, chain, node, actor, payload) -> ResearchChainNodeTask
```

- 校验：
  - Chain ACTIVE。
  - actor 是 `_chain_manager` 或 `_chain_writer`。
  - node 属于 chain。
  - assignee 在候选列表中。
  - `resource_type/resource_id` 成对校验。
- 幂等：先按 `request_id` 查找；负载不同返回 conflict。
- 事件：`TASK_CREATED`。
- 审计：`task.create`。
- 通知：assignee 不是 actor 时通知 assignee。

```python
def update_task(*, task, actor, payload) -> ResearchChainNodeTask
```

- 仅 `DRAFT/ASSIGNED/NEEDS_REVISION` 可更新。
- 可更新字段：`title/instruction/assignee/due_at/resource_type/resource_id`。
- assignee 变化必须重新通过候选校验。
- 状态不变。
- 事件：`TASK_ASSIGNED`（仅在 assignee 变化时）。
- 审计：`task.update`；metadata 记录字段名，不记录完整旧正文。

```python
def submit_task(*, task, actor, request_id) -> ResearchChainNodeTask
```

- actor 必须是 assignee。
- 允许 `ASSIGNED → SUBMITTED`、`NEEDS_REVISION → SUBMITTED`。
- 事件：`TASK_SUBMITTED`。
- 审计：`task.submit`。
- 通知：具备 review capability 的导师 / 主 PI / 管理链。

```python
def return_task(*, task, actor, reason, request_id) -> ResearchChainNodeTask
```

- reason 必填。
- 仅 `SUBMITTED → NEEDS_REVISION`。
- 事件：`TASK_RETURNED`。
- 审计：`task.return`。
- 通知 assignee。

```python
def complete_task(*, task, actor, comment, request_id) -> ResearchChainNodeTask
```

- 仅 `SUBMITTED → COMPLETED`。
- comment 可选。
- 事件：`TASK_COMPLETED`。
- 审计：`task.complete`。
- 不改变 `ResearchChainNode.status`。

```python
def cancel_task(*, task, actor, reason, request_id) -> ResearchChainNodeTask
```

- reason 必填。
- 允许 `DRAFT/ASSIGNED/NEEDS_REVISION → CANCELLED`。
- `SUBMITTED` 任务必须先退回，避免评审中突然消失。
- 事件：`TASK_CANCELLED`。
- 审计：`task.cancel`。

#### `report_read_receipt.py`

```python
def record_report_read(*, workspace, report, actor, snapshot_version=None) -> PeriodicReportReadReceipt
```

- 默认使用最新 `PeriodicReportSnapshot`。
- 前置：
  - report 已提交。
  - 指定版本存在。
  - actor 不是 author。
  - actor 具备 report `view` 或 `review` 权限。
- 幂等：
  - 已存在 `(report, reader, snapshot_version)` 时直接返回既有记录。
- 不写 Chain Event、不写审计、不发通知。
- 异常：
  - 无权限：`report_read_denied`
  - 无正式版本：`report_read_denied`

```python
def visible_read_receipts(*, workspace, report, actor) -> list[dict]
```

- author、直接导师、主 PI、管理链和 Workspace Admin 可见汇总。
- 普通读者只返回自己的回执。
- 返回字段：
  - `reader`
  - `reader_detail`
  - `snapshot_version`
  - `read_at`
  - `source`

#### `paper_review.py`

```python
def create_paper_review(*, workspace, chain, node, actor, payload) -> ResearchPaperReview
```

- node.node_type 必须是 `PAPER_WRITING`。
- chain 必须 ACTIVE。
- outcome 若存在，必须归属 chain.project。
- final_reviewer 必须来自任务候选人范围。
- 状态初始 `OPEN`。
- 事件：`PAPER_REVIEW_OPENED`。
- 审计：`paper.review.create`。

```python
def submit_paper_version(*, review, actor, payload) -> ResearchPaperReviewVersion
```

- actor 是 review owner 或 chain writer。
- review 状态必须为 `OPEN/NEEDS_REVISION`。
- 必须先完成 S3 presign 并注册 `FileAsset`。
- 文件扩展名只允许 `.pdf/.md/.markdown`。
- PDF 使用 `pdf_max_mb`，Markdown 使用 `markdown_max_mb`。
- `change_summary` 必填。
- 版本号在事务内 `select_for_update` 后递增。
- 旧版本标记 `SUPERSEDED` 是对 append-only 表的禁止操作；因此版本状态不做行更新，`status` 由当前 review 状态和最新版本推导，数据库仅保存提交时状态 `SUBMITTED`。
- 事件：`PAPER_VERSION_SUBMITTED`。
- 审计：`paper.version.submit`。
- 通知导师和 final reviewer。

```python
def return_paper_version(*, review, version, actor, comment, request_id)
```

- comment 必填。
- actor 必须具备 review 权限且不是 author。
- review `WAITING_REVIEW → NEEDS_REVISION`。
- 事件：`PAPER_REVIEW_RETURNED`。
- 审计：`paper.review.return`。
- 通知 owner。

```python
def accept_paper_version(*, review, version, actor, comment, request_id)
```

- actor 必须是 final reviewer，或具备直接导师 / 主 PI / 管理链评审权。
- review `WAITING_REVIEW → ACCEPTED`。
- version 的响应态为 `ACCEPTED`，由 serializer 根据 review 派生。
- 事件：`PAPER_REVIEW_ACCEPTED`。
- 审计：`paper.review.accept`。
- 通知 owner、chain owner 和 final reviewer。
- 不自动修改 `ResearchOutcome`。

```python
def withdraw_paper_review(*, review, actor, reason, request_id)
```

- reason 必填。
- 仅 `ACCEPTED` 前允许。
- review → `WITHDRAWN`。
- 事件：`PAPER_REVIEW_WITHDRAWN`。
- 审计：`paper.review.withdraw`。

### 11.4 Serializer 契约

新增 `serializers/collaboration.py`：

| Serializer                             | 只读字段                                                                                                                                                                  | 可写字段                                                         |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `ResearchChainNodeTaskSerializer`      | id、workspace、chain、node、status、submitted_at、completed_at、request_id、created_at、updated_at、assignee_detail、assigned_by_detail、capabilities                     | title、instruction、assignee、due_at、resource_type、resource_id |
| `ResearchAssignableUserSerializer`     | user_id、display_name、org_unit_id、org_unit_name、org_role、is_primary、scope                                                                                            | 无                                                               |
| `PeriodicReportReadReceiptSerializer`  | id、report、reader、reader_detail、snapshot_version、read_at、source                                                                                                      | 无                                                               |
| `ResearchPaperReviewSerializer`        | id、workspace、chain、node、outcome、owner、owner_detail、status、current_version_no、final_reviewer、final_reviewer_detail、due_at、created_at、updated_at、capabilities | outcome、final_reviewer、due_at                                  |
| `ResearchPaperReviewVersionSerializer` | id、review、version_no、asset、asset_detail、file_name、content_type、file_size、change_summary、status、submitted_by、submitted_by_detail、submitted_at、content_hash    | asset、file_name、content_type、file_size、change_summary        |
| `ResearchPaperReviewPresignSerializer` | asset_id、upload_data、file_name、size、content_type                                                                                                                      | file_name、content_type、size、sha256                            |

Capabilities 复用 `TResearchActionCapabilities` 形状，任务动作：

- `view`
- `edit`
- `assign`
- `submit`
- `return`
- `complete`
- `cancel`

论文评审动作：

- `view`
- `submit`
- `return`
- `accept`
- `withdraw`

### 11.5 URL 与前端 endpoint

后端 URL 追加在 chain 路由附近，命名统一 `research-chain-*` / `research-paper-*`：

| Endpoint key                | Django path                                                                     |
| --------------------------- | ------------------------------------------------------------------------------- |
| `chainAssignableUsers`      | `research/workspaces/<slug>/chains/<chain_id>/assignable-users/`                |
| `chainNodeTasks`            | `research/workspaces/<slug>/chains/<chain_id>/nodes/<node_id>/tasks/`           |
| `chainNodeTask`             | `research/workspaces/<slug>/chains/<chain_id>/nodes/<node_id>/tasks/<task_id>/` |
| `chainNodeTaskSubmit`       | `.../tasks/<task_id>/submit/`                                                   |
| `chainNodeTaskReturn`       | `.../tasks/<task_id>/return/`                                                   |
| `chainNodeTaskComplete`     | `.../tasks/<task_id>/complete/`                                                 |
| `chainNodeTaskCancel`       | `.../tasks/<task_id>/cancel/`                                                   |
| `reportRead`                | `research/workspaces/<slug>/reports/<report_id>/read/`                          |
| `reportReadReceipts`        | `research/workspaces/<slug>/reports/<report_id>/read-receipts/`                 |
| `paperReviews`              | `research/workspaces/<slug>/chains/<chain_id>/nodes/<node_id>/paper-reviews/`   |
| `paperReview`               | `research/workspaces/<slug>/paper-reviews/<review_id>/`                         |
| `paperReviewVersions`       | `research/workspaces/<slug>/paper-reviews/<review_id>/versions/`                |
| `paperReviewVersionPresign` | `research/workspaces/<slug>/paper-reviews/<review_id>/versions/presign/`        |
| `paperReviewVersionReturn`  | `.../versions/<version_no>/return/`                                             |
| `paperReviewVersionAccept`  | `.../versions/<version_no>/accept/`                                             |
| `paperReviewWithdraw`       | `research/workspaces/<slug>/paper-reviews/<review_id>/withdraw/`                |

前端 endpoint builder 加到 `researchEndpoints`，服务方法放到 `collaboration.service.ts`，全部沿用现有 API error envelope。

### 11.6 事件、审计与通知

#### Chain Event refs 标准

任务事件：

```json
[
  { "kind": "chain", "id": "chain-id" },
  { "kind": "node", "id": "node-id" },
  { "kind": "task", "id": "task-id", "status": "SUBMITTED" }
]
```

论文事件：

```json
[
  { "kind": "chain", "id": "chain-id" },
  { "kind": "node", "id": "node-id" },
  { "kind": "paper_review", "id": "review-id" },
  { "kind": "paper_version", "id": "version-id", "version_no": 2 }
]
```

#### 审计 action

| Action                  | Resource type              |
| ----------------------- | -------------------------- |
| `task.create`           | `research_chain_node_task` |
| `task.update`           | `research_chain_node_task` |
| `task.submit`           | `research_chain_node_task` |
| `task.return`           | `research_chain_node_task` |
| `task.complete`         | `research_chain_node_task` |
| `task.cancel`           | `research_chain_node_task` |
| `paper.review.create`   | `paper_review`             |
| `paper.version.submit`  | `paper_review_version`     |
| `paper.review.return`   | `paper_review`             |
| `paper.review.accept`   | `paper_review`             |
| `paper.review.withdraw` | `paper_review`             |

#### 通知 entity

- `research_chain_task`
- `research_paper_review`

通知 data 必须带 `chain_id/node_id/task_id或review_id` 和可跳转 route，不复制正文。

### 11.7 TypeScript 类型

新增类型：

```ts
export type TResearchChainTaskStatus =
  | "DRAFT"
  | "ASSIGNED"
  | "SUBMITTED"
  | "NEEDS_REVISION"
  | "COMPLETED"
  | "CANCELLED";

export type TResearchChainTaskResourceType =
  | "NONE"
  | "REPORT"
  | "STAGE_MATERIAL"
  | "OUTCOME"
  | "PAPER_REVIEW"
  | "SNAPSHOT"
  | "EXTERNAL_REF";

export type TResearchChainTask = {
  schema_version: "research-node-task.v1";
  id: string;
  workspace: string;
  chain: string;
  node: string;
  title: string;
  instruction: string;
  status: TResearchChainTaskStatus;
  assignee: string | null;
  assignee_detail?: TResearchUserLite | null;
  assigned_by: string | null;
  assigned_by_detail?: TResearchUserLite | null;
  due_at: string | null;
  submitted_at: string | null;
  completed_at: string | null;
  resource_type: TResearchChainTaskResourceType;
  resource_id: string | null;
  capabilities?: TResearchActionCapabilities;
  created_at: string;
  updated_at: string;
};

export type TResearchPaperReviewStatus = "OPEN" | "WAITING_REVIEW" | "NEEDS_REVISION" | "ACCEPTED" | "WITHDRAWN";

export type TResearchPaperReview = {
  schema_version: "paper-review.v1";
  id: string;
  workspace: string;
  chain: string;
  node: string;
  outcome: string | null;
  owner: string;
  owner_detail?: TResearchUserLite;
  status: TResearchPaperReviewStatus;
  current_version_no: number;
  final_reviewer: string | null;
  final_reviewer_detail?: TResearchUserLite | null;
  due_at: string | null;
  capabilities?: TResearchActionCapabilities;
  created_at: string;
  updated_at: string;
};
```

Read receipt、assignable user、version 和 presign 类型按 §11.4 字段补齐。

### 11.8 测试夹具与用例文件

新增测试文件：

- `apps/api/plane/tests/contract/app/test_research_chain_tasks.py`
- `apps/api/plane/tests/contract/app/test_research_report_read_receipts.py`
- `apps/api/plane/tests/contract/app/test_research_paper_reviews.py`

组织树夹具：

```text
Root
└─ Institute
   ├─ Direction A
   │  ├─ Group A1（学生 owner、导师 advisor、组内成员）
   │  └─ Child Group A1-1（下级成员，不可指派）
   └─ Direction B
      └─ Group B1（跨组织成员，只有显式加入后才可指派）
```

固定对象：

- workspace public
- `ResearchProjectProfile(chain_kind=RESEARCH_CHAIN, org_unit=Group A1)`
- `ResearchChain`
- `PAPER_WRITING` node
- 第 41 周 `PeriodicReport` + v3 snapshot
- author / advisor / principal / ancestor / descendant / cross-org / admin / guest 用户

必须断言：

| 用户              | 候选列表                | 任务动作          | 论文评审                    | 周报已读                 |
| ----------------- | ----------------------- | ----------------- | --------------------------- | ------------------------ |
| author / student  | 可见自己                | submit            | submit / withdraw           | 不生成已读               |
| direct advisor    | ORG_SCOPE 或导师关系    | return / complete | return / accept             | 生成已读                 |
| principal         | ORG_SCOPE               | return / complete | accept                      | 生成已读                 |
| ancestor manager  | ORG_SCOPE               | return / complete | 可评审                      | 生成已读                 |
| descendant member | 不在候选                | 不可操作          | 不可评审                    | 不生成已读               |
| cross-org         | 显式协作后 COLLABORATOR | 被指派后 submit   | 不可评审除非 final reviewer | 不生成已读               |
| Workspace Admin   | 不在候选                | 不自动评审        | 不自动评审                  | 可看汇总，不生成导师已读 |
| Guest             | 不出现                  | 拒绝              | 拒绝                        | 拒绝                     |

测试必须验证：

- 每个写接口的 `request_id` 重放幂等。
- payload 变化返回 `IDEMPOTENCY_CONFLICT`。
- 事务锁保证版本号连续。
- append-only 表 update/delete 抛 `TypeError`。
- Chain Event / audit / notification 数量和顺序。
- 关闭 `research_chain_enabled` 后返回禁用。
- 行政 `ApprovalRequest` 不生成 Chain Event。
- 行政 Project 负责人下拉只返回有效 `ProjectMember`；组织祖先成员未加入项目时不可指派；跨组织成员加入项目后才出现；Workspace Admin 未加入项目时不可指派。
- 科研 `assignable-users` 与行政项目成员接口返回集合不同，前端不会以一个全局成员接口替代二者。

### 11.9 服务端待办聚合 API

为消除 `collectResearchTodos` 对最多 12 个课题、每课题 20 个节点逐请求查询上传状态的扇出，新增统一只读接口：

```http
GET /api/research/workspaces/{slug}/research-todos/?limit=50
```

响应 schema：`research-todo-summary.v1`

```json
{
  "results": [
    {
      "id": "upload:uuid",
      "source": "upload",
      "kind": "blocking",
      "title": "filename.pdf",
      "context": "课题 A / 论文写作",
      "due_at": null,
      "updated_at": "2026-10-09T12:00:00+08:00",
      "target": {
        "type": "chain_node",
        "chain_id": "uuid",
        "node_id": "uuid"
      }
    }
  ],
  "count": 12,
  "degraded_sources": ["RAGPORTAL"]
}
```

服务端来源：

- 非 SUCCESS 的 `ResearchChainUpload`
- `ResearchChainNodeTask`
- 待我阶段评审
- 待我报告审阅 / 待阅读
- 待我 Agent 审批
- 待我办公审批
- 集成降级提醒

要求：

- 每个来源先走原对象 ACL，再投影为待办。
- `target` 只传 ID 和类型，前端负责映射路由。
- `limit` 默认 50，最大 100。
- 接口可聚合，不在 SQL 中拼接用户可见标题以外的正文。
- 该接口只读，不产生 Chain Event 或审计。

前端替换规则：

- `collectResearchTodos` 优先调用该接口。
- 单个来源失败时不阻断其他来源。
- 课题详情内仍可请求上传列表；总览和首页不得逐节点扇出。
