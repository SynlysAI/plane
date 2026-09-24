# Research Workspace UI/UX 重构 Phase 2 信息架构审计

| 项目     | 内容                                       |
| -------- | ------------------------------------------ |
| 文档状态 | 已冻结                                     |
| 日期     | 2026-09-24                                 |
| 上游文档 | `research-workspace-ui-ux-refactor-prd.md` |

## 1. 核心对象层级映射

每个对象按 PRD 7.3 的 Object / Context / Action 模型登记。该模型是信息组织方式，不要求所有字段同时首屏展示。

| 对象           | Identity                  | Context                       | State                                   | Primary Action          |
| -------------- | ------------------------- | ----------------------------- | --------------------------------------- | ----------------------- |
| 科研项目       | 课题名、类型              | 组织单元、Owner、时间范围     | ACTIVE/COMPLETED/ARCHIVED               | 打开阶段 / 归档         |
| 阶段           | 阶段类型、所属课题        | 项目、进入 / 提交 / 通过时间  | NOT_STARTED…PASSED                      | 提交评审 / 处理退回     |
| 阶段材料       | 材料类型、版本号          | 阶段、Owner、可见性           | DRAFT/SUBMITTED/ACCEPTED/REJECTED       | 编辑 / 提交 / 审核      |
| Research Chain | Chain ID、课题名          | 项目、可见性、成员            | ACTIVE/COMPLETED/ARCHIVED               | 打开当前节点            |
| Chain 节点     | 节点标题、node_type       | Chain、父节点、assignee       | DRAFT…FAILED/ARCHIVED                   | 人工决策（通过 / 退回） |
| Agent Run      | 任务名、request/trace id  | Chain 节点、发起人、耗时      | 运行中 / 等待确认 / 失败 / 完成         | 查看产物 / 重试 / 确认  |
| 周期报告       | 周期、类型（周 / 月）     | 项目、组织单元、Owner、可见性 | DRAFT/SUBMITTED/NEEDS_REVISION/ACCEPTED | 编辑 / 提交 / 审核      |
| 审批请求       | 关联事项、审批流          | 组织单元、提交人、当前步骤    | PENDING/APPROVED/…                      | 通过 / 驳回             |
| 实验记录       | 实验标题                  | 项目、负责人、日期            | 状态字段                                | 查看 / 修订             |
| 文献条目       | 标题、来源                | 项目、收录时间                | 状态字段                                | 补充标注 / 关联         |
| 研究成果       | 标题、成果类型            | 项目、作者、venue             | DRAFT…PUBLISHED                         | 登记链接 / 打开原文     |
| 外部引用       | 标题、external_type       | 来源系统、关联对象            | ACTIVE/UNAVAILABLE/…                    | 打开原文 / 重新同步     |
| 代码仓库       | repository_slug、provider | 项目、可见性                  | ACTIVE/ARCHIVED/SYNC_FAILED             | 查看产物 / 同步         |
| 集成连接       | display_name、system      | 认证方式、超时配置            | UNKNOWN/OK/DEGRADED/DOWN                | 配置 / 诊断             |

## 2. 页面优先级归类

### P0 Golden Pages（Phase 4）

1. 科研总览 `/research`：当前工作 → 待处理 → 最近活动 → 入口；
2. Research Chain 详情 `/research/chains/[chainId]`：对象详情 + 过程工作台；
3. 审批中心 `/research/approvals`：四队列 + 行级决策。

### P1 核心页面（Phase 6）

Chain 列表、Agent Run / Trace 详情、首页信息节奏。

### P2 扩散页面（Phase 7）

项目与阶段 / 材料、报告与成果、实验记录、文献 / 外部引用、代码、科研管理与设置。

## 3. 重复造轮子实现清单（重构标记）

| 类别         | 位置（`apps/web/core/components/research/`）                                                                                                                                                                                                                                                                                                                                      | 收敛方向                            |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| 手写 Tabs    | `chains/research-chain-workbench.tsx`、`approvals/research-approval-center.tsx`、`navigation/research-management-tabs.tsx`、`chains/research-chain-detail.tsx`、`chains/research-chain-graph.tsx`                                                                                                                                                                                 | `TabNavigationList/Item` + 路由包装 |
| 状态色值     | `reports/report-list.tsx`、`experiments/experiment-list.tsx`、`literature/literature-list.tsx`、`outcomes/outcome-list.tsx`、`stages/stage-material-list.tsx`、`stages/stage-timeline.tsx`                                                                                                                                                                                        | 统一状态字典 + propel `Badge`       |
| 手写表格     | `chains/research-chain-board.tsx`、`chains/research-chain-detail.tsx`、`projects/research-project-list.tsx`、`outcomes/outcome-list.tsx`、`settings/*`（6 处）、`literature/literature-list.tsx`、`experiments/experiment-list.tsx`、`audit/audit-event-table.tsx`、`code/code-repository-list.tsx`、`approvals/approval-list.tsx`、`reports/*`（3 处）、`integrations/*`（2 处） | propel `Table` 系列                 |
| 手写 loading | `chains/research-chain-board.tsx`、`chains/research-chain-detail.tsx`、`approvals/research-agent-approval-queue.tsx`、`common/research-todo-index.tsx`、`common/research-home-summary-card.tsx`                                                                                                                                                                                   | `Skeleton` / `Spinner`              |
| 简陋空态     | 各列表散落 `<p>暂无数据</p>`；`ResearchListState` 仅 projects/reports 文案                                                                                                                                                                                                                                                                                                        | 泛化空态配置                        |
| 手写按钮     | `common/research-list-state.tsx`、`common/research-status-panel.tsx` 内 Link + bg-accent-primary                                                                                                                                                                                                                                                                                  | propel `Button`                     |

## 4. Phase 2 结论

对象层级与页面优先级已冻结。Golden Pages 的共同模式（Object Header、状态 Badge、结构化表格行、统一空态）将在 Phase 3 的共享壳中先具备基础能力，Phase 4 打样验证后才进入 Phase 5 的语义组件提炼。
