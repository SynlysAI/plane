# Research Workspace UX 设计指南

| 项目     | 内容                                                              |
| -------- | ----------------------------------------------------------------- |
| 文档状态 | 当前有效                                                          |
| 文档版本 | v1.2                                                              |
| 日期     | 2026-09-24                                                        |
| 适用版本 | `4.11.0` 起                                                       |
| 定位     | 科研工作台 UI/UX 系列文档的**唯一入口与权威规范**；冲突以本文为准 |

本文整合 4.10.0 视觉重构与 4.11.0 信息架构精炼两轮成果，沉淀为可持续执行的 UX 规范。两轮 PRD、审计、验收与发布说明原文收录于 [`research-workspace-ui-ux-archive.md`](./research-workspace-ui-ux-archive.md)，见 §8 文档地图。

## 1. 产品三定位

```text
科研总览       = 工作台（现在做什么）
研究链 = 流程地图 + 当前工作区（走到哪里、卡在哪里）
Agent          = 侧边能力（就地出现，不是第二个系统）
```

其余页面（审批、报告、实验、引用、设置）向这三个定位收敛，不新造局部风格。

## 2. 信息分级方法

任何页面动手前，先输出信息分级表，再改 UI：

| 级别       | 允许数量            | 默认     | 内容                         |
| ---------- | ------------------- | -------- | ---------------------------- |
| Primary    | 1 个对象 + 1 个行动 | 始终展示 | 当前上下文、当前位置、下一步 |
| Secondary  | 2–4 组              | 紧凑展示 | 状态、关键统计、关联信息     |
| Supporting | 其余                | 可折叠   | 范围、历史、低频操作         |

规则：Primary 不折叠；Secondary 不抢视觉；Supporting 用 Disclosure / Details / Drawer 渐进披露。目标是 **Progressive Disclosure，不是 Progressive Hiding**。

三份已冻结的分级表见[过程档案](./research-workspace-ui-ux-archive.md)第 6 部分 §2。

## 3. 设计原则

1. **Plane 原生优先**：需求 → propel 组件 → web core 模式 → 科研语义组件 → 才允许新增；
2. **克制减法**：少一个 Card、少一段重复、少一层嵌套优先于加东西；
3. **Anti-AI-UI**：禁止渐变、发光、玻璃拟态、粒子、AI badge、彩色 Dashboard、巨型图标；
4. **颜色只表达状态**：低饱和 accent / warning / danger / success；灰度下信息结构仍成立；
5. **不改业务**：呈现层改动不得触碰 API、权限、状态流转、排序与业务对象。

## 4. 语义组件清单（唯一出口）

| 需求        | 组件 / 方案                                         | 位置                                               |
| ----------- | --------------------------------------------------- | -------------------------------------------------- |
| 状态标签    | `ResearchStatusBadge`（统一状态字典）               | `research/common/research-status-badge.tsx`        |
| 路由标签页  | `ResearchTabLink`（保留 `aria-current`）            | `research/common/research-tab-link.tsx`            |
| 列表空态    | `ResearchListState`（六类状态 × compact/detailed）  | `research/common/research-list-state.tsx`          |
| 页面壳      | `ResearchPageShell`（面包屑 / 元信息 / 权限分支）   | `research/common/research-page-shell.tsx`          |
| 状态面板    | `ResearchStatusPanel`                               | `research/common/research-status-panel.tsx`        |
| 工作流导轨  | `ResearchChainWorkflowRail`（全节点流程 + 当前态）  | `research/chains/research-chain-workflow-rail.tsx` |
| Agent 面板  | `ResearchAgentSidePanel`（400px 抽屉 + 上下文继承） | `research/agent/research-agent-side-panel.tsx`     |
| 表格        | propel `Table` 系列（禁手写原生 table）             | `@plane/propel/table`                              |
| 按钮 / 加载 | propel `Button` / `getButtonStyling` / `Skeleton`   | `@plane/propel/*`                                  |

新实现不得绕过以上出口另写平行实现。

## 5. 页面模式

### 5.1 科研总览

节奏固定：当前科研 → 跨组件待办 → 科研概况（单行统计）→ 折叠 Supporting（筛选 / 组织范围 / 近期成果 / 导航）。KPI 一律单行数字 + 标签 + 细分隔线，不做卡片阵列。

### 5.2 研究链

Header（对象 + 当前节点）→ **Workflow Rail（常驻，全节点）** → Tabs → 当前节点详情（六段结构）→ Supporting。Rail 状态语义：已完成 muted + check、当前 accent、待人工 warning、未来 neutral；点击节点仅查看摘要，不跳出 Chain。

### 5.3 Agent

默认从 Chain 详情右侧抽屉打开（360–440px），自动继承课题 / 节点上下文；默认只展示上下文摘要、对话流、固定输入与待审批操作；Tool / Trace / 装配详情折叠在"运行详情"。完整工作台保留在独立路由。

### 5.4 列表与设置

结构化 propel Table 行（标题链接 / 状态徽标 / Owner / 日期右对齐 / 操作右对齐），统一筛选 chips 与空态；设置页沿用 Plane settings 布局语言。

## 6. 交互与可访问性基线

- 主操作唯一，次级操作图标按钮 + tooltip；
- 长文本 truncate + title；表格不横向破坏；
- `aria-current` / `aria-busy` / `role=status|alert` / Escape 关闭浮层；
- 1440 / 1920 可用，深浅色主题继承 propel，无硬编码色。

## 7. 新增页面 Checklist

1. 填写信息分级表（页面内容 / 级别 / 默认 / 原因）；
2. 从 §4 选择组件出口，禁止新增平行实现；
3. 通过灰度 + 缩略图自检（标题、状态、Primary 仍可辨）；
4. 补充 / 更新组件测试；
5. 在本文 §5 登记页面模式（如有新模式）。

## 8. 文档地图

| 文档                                                                                               | 角色                       | 何时查阅                           |
| -------------------------------------------------------------------------------------------------- | -------------------------- | ---------------------------------- |
| 本文                                                                                               | 权威规范与入口             | 日常开发、评审                     |
| [`research-workspace-ui-ux-archive.md`](./research-workspace-ui-ux-archive.md)                     | 过程档案（六合一）         | 查分级表、审计映射、验收、开关回滚 |
| [`research-intelligent-platform-ux-prototype.md`](./research-intelligent-platform-ux-prototype.md) | 智能平台 UX 原型（确认稿） | 涉及 Chain / Agent 新交互时        |

档案内部索引：第 1 部分 4.10.0 重构 PRD；第 2 部分 Phase 1 设计系统审计；第 3 部分 Phase 2 信息架构审计；第 4 部分 4.10.0 验收报告；第 5 部分 4.10.0 发布说明；第 6 部分 4.11.0 信息精炼 PRD。

## 9. 变更记录

| 版本 | 日期       | 变更                                                                                              |
| ---- | ---------- | ------------------------------------------------------------------------------------------------- |
| v1.0 | 2026-09-24 | 整合两轮 UI/UX 成果：三定位、分级方法、组件出口、页面模式与文档地图                               |
| v1.1 | 2026-09-24 | 六份过程文档合并为 `research-workspace-ui-ux-archive.md`，系列收敛为「指南 + 档案」两份，命名统一 |
| v1.2 | 2026-09-24 | 将 Research Chain 的中文产品名称统一为“研究链”，同步产品定位与页面模式                            |
