# Research Workspace 4.12.0 Phase 0 基线冻结

| 项目     | 内容                              |
| -------- | --------------------------------- |
| 日期     | 2026-09-24                        |
| 基线分支 | `develop`                         |
| 基线提交 | `27f26c5d0`（统一研究链产品术语） |
| 状态     | 已冻结                            |

## 1. 截图与数据基线

截图保存在本地 `.run/screens/4.12-baseline/`，覆盖：

- 科研总览：浅色 / 深色 × 1440 / 1920。
- 研究链列表：空态与有数据态、浅色 / 深色 × 1440 / 1920。
- 研究链详情：13 节点验证课题、浅色 / 深色 × 1440 / 1920。
- Agent Side Panel：打开态、浅色 / 深色 × 1440 / 1920。

本地验证课题通过既有业务 API 创建，节点覆盖：

- 4 个已完成阶段。
- 1 个进行中研究方案。
- 1 个等待人工确认的开题节点。
- 1 个失败实验节点。
- 1 个进行中的实验后分析节点。
- 5 个草稿未来阶段。
- 1 个 `RESEARCH` 类型节点参与映射边界验证。

该数据只用于前端视觉与展示层推导验证，不作为业务功能新增。

## 2. P1 回归清单

Phase 0 执行以下组件测试：

| 测试域       | 文件                                        |
| ------------ | ------------------------------------------- |
| Agent 审批   | `research-agent-approval-queue.test.tsx`    |
| Agent 插件   | `research-agent-plugin.test.tsx`            |
| Agent 侧边栏 | `research-agent-side-panel.test.tsx`        |
| 研究链详情   | `research-chain-detail.test.tsx`            |
| 知识面板     | `research-chain-knowledge-panel.test.tsx`   |
| 科研导航     | `research-chain-navigation.test.tsx`        |
| 路由注册     | `research-chain-route-registration.test.ts` |
| 首页摘要     | `research-home-summary-card.test.tsx`       |
| IA v2 容器   | `research-ia-v2-containers.test.tsx`        |
| IA v2 跳转   | `research-ia-v2-redirect.test.tsx`          |
| 成员选择     | `research-person-select.test.tsx`           |
| 语义组件     | `research-semantic-components.test.tsx`     |
| 待办索引     | `research-todo-index.test.tsx`              |

结果：13 个测试文件、37 个用例全部通过。

## 3. 三核心页信息分级

### 3.1 科研总览

| 层级       | 当前内容                              | Phase 2 目标                              |
| ---------- | ------------------------------------- | ----------------------------------------- |
| Primary    | 科研摘要、当前研究链 / 当前节点       | 唯一强层级，明确当前课题、卡点与下一步    |
| Secondary  | 跨组件待办、课题摘要                  | 待处理与异常保持可见，减少边框噪音        |
| Supporting | 科研概况、组织筛选、PI 聚合、低频导航 | 紧凑分组与弱化 Surface，不与 Primary 竞争 |

当前问题：

- 多个区块仍以相近 Surface 与边框并列。
- 页面标题、区块标题与统计数字的梯度不够稳定。
- 当前空态 / 有数据态下第一层对象切换时缺少固定节奏。

### 3.2 研究链详情

| 层级       | 当前内容                                     | Phase 2 目标                          |
| ---------- | -------------------------------------------- | ------------------------------------- |
| Primary    | 课题 Header、真实当前节点、Current Node 操作 | 当前工作区唯一强层级                  |
| Secondary  | Workflow Rail、节点详情、六段证据分组        | Workflow 成为完整流程地图，详情结构化 |
| Supporting | 报告、成员、外部引用、回放                   | 折叠或次级 Surface，降低边框密度      |

当前问题：

- Workflow Rail 按实际节点逐个渲染，空链时主链缩短，不满足固定 13 阶段骨架。
- `TOPIC_EVALUATION` 尚未同时映射“选题 / 评估”的共享关联。
- 两个 `ANALYSIS` 节点仅靠标题与顺序区分，视觉流程关系不足。
- 当前真实节点、临时选中节点与未来节点的层级差异不够明确。

### 3.3 Agent Side Panel

| 层级       | 当前内容                             | Phase 2 目标         |
| ---------- | ------------------------------------ | -------------------- |
| Primary    | 当前上下文摘要、会话结果、固定输入   | 轻量插件形态         |
| Secondary  | 待审批、关键错误、关键结果           | 默认可见、低饱和状态 |
| Supporting | Tool Call、Trace、Runtime、Artifacts | 保持折叠，展开后可读 |

当前问题：

- Panel Header 操作过多，装配信息与上下文层级竞争。
- 运行详情已折叠，但 Header 的元信息与操作未形成清晰分组。
- 空态 / 降级态仍显示过多低价值字段。

## 4. 固定 13 阶段映射用例

| 用例          | 输入特征                                       | 预期                                                                                                          |
| ------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| 空 Chain      | 无节点                                         | 13 阶段全部“未开始”，不隐藏主链                                                                               |
| 只有当前节点  | 单个 `ACTIVE` 节点                             | 仅对应阶段当前，其余未开始                                                                                    |
| 重复分析节点  | 预实验后 `ANALYSIS` 与实验 / 迭代后 `ANALYSIS` | 两个分析阶段分别映射，不合并                                                                                  |
| 共享选题评估  | 一个 `TOPIC_EVALUATION`                        | DRAFT / ACTIVE 映射“选题”；WAITING_HUMAN / NEEDS_REVISION / FAILED / COMPLETED 时状态落在“评估”，“选题”已完成 |
| PLAN 关联开题 | `OPENING` 与前置 `PLAN`                        | 开题为主阶段，PLAN 显示为准备关联                                                                             |
| 等待人工      | `WAITING_HUMAN` 或 `NEEDS_REVISION`            | 低饱和 warning，文字明确，优先级高于普通进行中                                                                |
| 失败          | `FAILED`                                       | 低饱和 danger，文字明确，可缩略图识别                                                                         |
| 归档          | `ARCHIVED`                                     | muted / archived 语义，不伪造成未来阶段                                                                       |
| 未映射节点    | `RESEARCH` 或无法判断前后语义                  | 进入未映射列表，不伪造主链状态                                                                                |

## 5. 冻结结论

- 本轮确认无需修改 API、权限、状态流转、排序、业务对象和数据模型。
- 4.12.0 只做展示层推导、信息分组、排版、Surface 与状态精修。
- 若后续发现必须修改业务逻辑，停止实施并回到需求评审。
