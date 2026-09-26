# 4.13.0 Research Workspace 缺陷修复、架构收敛与总览增强 PRD

| 项目     | 内容                                                                         |
| -------- | ---------------------------------------------------------------------------- |
| 文档状态 | 历史版本已实施并验收；当前实现状态以 `4.15.1` 代码、Phase 1.5 计划和证据为准 |
| 文档版本 | v1.0                                                                         |
| 日期     | 2026-09-24                                                                   |
| 目标版本 | `4.13.0`                                                                     |
| 基线版本 | `4.12.0`                                                                     |
| 定位     | 4.12.0 验收后复核偏离的修复与向下兼容的体验增强                              |

## 1. 文档定位

本 PRD 落实对 [`research-workspace-ui-ux-4.12-prd.md`](./research-workspace-ui-ux-4.12-prd.md)、[`research-intelligent-platform-prd.md`](./research-intelligent-platform-prd.md) 与 [`research-intelligent-platform-phase-1-plan.md`](./research-intelligent-platform-phase-1-plan.md) 的对齐复核结论。复核发现的偏离登记在 4.12 验收报告附录 A；本文定义修复方案、产品增强与验收口径。

## 2. 目标与非目标

### 2.1 目标

1. **口径统一**：总览顶栏、首页摘要卡与研究链详情使用同一“当前课题 / 当前节点”推导出口。
2. **状态语义正确**：归档阶段不再伪装成未来阶段；`RESEARCH` 节点按最近前后语义阶段映射。
3. **Agent panel 可恢复**：侧栏提供就地重连；装配摘要折叠可达；390px 视口不溢出。
4. **稳定格式**：科研工作台日期时间统一经 locale 感知的格式化出口。
5. **总览下一步**：当前节点待人工 / 需修订 / 失败时，主操作直达该节点。

### 2.2 非目标

- 不改动后端 API、数据模型、权限、状态流转与业务排序。
- 不重构 4.12 视觉基线与信息架构。
- 不新增业务功能或新页面。

## 3. 实施内容

### 3.1 统一选择器出口（F1）

新增 `research-selection.ts`，导出 `RESEARCH_NODE_STATUS_PRIORITY`、`pickCurrentNode(nodes)`、`pickCurrentChain(chains)`：

- `pickCurrentChain` 按 `updated_at` 降序取最新可见课题。
- `pickCurrentNode` 按待人工 > 需修订 > 失败 > 进行中 > 草稿 > 完成 > 归档，再按更新时间取当前节点。
- 科研总览顶栏、`ResearchHomeSummaryCard`、`ResearchChainDetail`、Workflow `preferredNode` 全部切换到该出口。

### 3.2 Workflow 映射精修（F2、F3）

- `stepKind` 新增 `archived`：muted 样式 + 70% 透明度，无指示符，与未来态区分。
- `RESEARCH` 节点双向就近映射：优先向前找最近可映射邻居，链头节点向后找最近后继；仍无法判断才保持未映射。
- 映射循环用 `Map<nodeId, index>` 替换 `indexOf`，消除 O(n²)。
- Workflow Rail 去掉重复横向滚动容器；共享节点标记写入按钮可见文本；未开始阶段 `title` 说明“该阶段尚未产生实际节点”。

### 3.3 Agent 组件拆分与 panel 修复（F4、F5）

- `research-agent-plugin.tsx`（875 行单文件）拆分为：
  - `use-research-agent-session.ts`：会话状态机、事件合并、发送 / 停止 / 重连 / 审批 / 产物逻辑。
  - `research-agent-utils.ts`：事件标签、工具状态、风险等级等纯函数。
  - `research-agent-header.tsx` / `research-agent-conversation.tsx` / `research-agent-runtime.tsx`：共享 UI 区块。
  - `research-agent-page-layout.tsx` 与 `research-agent-panel-layout.tsx`：双布局消费同一 hook。
- panel 布局新增重连按钮；装配三栏（可用 / 需确认 / 不可用）放入运行详情折叠区顶部。
- 侧栏宽度 `w-[400px]` 改为 `w-[min(400px,100vw)]`。
- 遮罩 `bg-black/20` 保留（对齐 Plane 原生 `bg-black/50` 惯例），在 UX 指南明确例外口径。

### 3.4 日期格式化出口（F6）

新增 `research-format.ts`：`formatResearchDateTime`、`formatResearchDate`、`formatResearchTime`。所有调用传入 `useTranslation().currentLocale`；科研目录内约 30 处裸 `toLocale*` 调用全部替换。

### 3.5 总览产品增强（F7）

- 待办聚合逻辑抽取为 `research-todo-source.ts` 共享模块：`ResearchTodoIndex` 与 `ResearchHomeSummaryCard` 使用同一收集、去重与排序口径；摘要卡传入已加载课题避免重复请求。
- 摘要卡待办计数改为聚合结果长度，不再由当前节点状态推导。
- 当前节点为 `WAITING_HUMAN` / `NEEDS_REVISION` / `FAILED` 时，主按钮变为“处理当前节点”，深链 `chains/{chainId}?node={nodeId}`；否则保持“打开当前课题”。

## 4. 测试与验收

| 检查项                 | 结果口径                                                                                                        |
| ---------------------- | --------------------------------------------------------------------------------------------------------------- |
| Workflow 映射单测      | 空链、共享选题/评估、双分析、准备节点、未映射、归档状态、链头 RESEARCH 双向映射全部通过                         |
| Workflow Rail 渲染单测 | 归档样式与未来态区分；共享节点文本可读；未开始阶段 title 说明                                                   |
| 选择器单测             | 当前课题按更新时间、当前节点按状态优先级；顺序无关确定性                                                        |
| Agent 单测             | page 重连 / 停止 / 审批 / 产物保持；panel 重连可达、运行详情折叠区含装配与 Trace                                |
| 侧栏宽度               | `w-[min(400px,100vw)]`，390px 视口不溢出                                                                        |
| 回归                   | `pnpm --filter web test:components` 全绿；`check:types`、`check:lint`（0 errors）、`check:format`、`build` 通过 |
| 业务行为               | API、权限、状态流转、排序零变更；无新增平行组件                                                                 |

## 5. 文档同步

- Phase 1 实施计划 §11 清单勾选并注明由 4.12.0 验收覆盖。
- 4.12 验收报告新增附录 A（已知偏离与验收口径修正）。
- UX 指南升至 v1.4：新增 selection / format 语义出口与遮罩例外口径。

## 6. 变更记录

| 版本 | 日期       | 变更                                                    |
| ---- | ---------- | ------------------------------------------------------- |
| v1.0 | 2026-09-24 | 初版：修复 F1–F8、拆分 Agent 组件、统一选择器与日期出口 |
