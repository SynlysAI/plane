# 科研工作台 UI/UX 重构发布说明

| 项目     | 内容                                                                                     |
| -------- | ---------------------------------------------------------------------------------------- |
| 版本区间 | `4.9.1 → 4.10.0`                                                                         |
| 日期     | 2026-09-24                                                                               |
| 类型     | 向下兼容的界面与组件重构，无业务行为变更                                                 |
| 上游文档 | [`research-workspace-ui-ux-refactor-prd.md`](./research-workspace-ui-ux-refactor-prd.md) |

## 1. 发布范围

1. **共享壳**：`ResearchPageShell` 新增面包屑与元信息插槽，标题升级页面主档位；科研侧边栏复用 `SidebarNavItem`；设置导航切换 `TabNavigationList`。
2. **黄金页面**：科研总览、Research Chain 详情、审批中心按 PRD 9.1–9.5 重排信息层级。
3. **科研语义组件**：新增 `ResearchStatusBadge`（统一状态字典）、`ResearchTabLink`（统一路由标签）、泛化 `ResearchListState`（六类状态 × compact/detailed）。
4. **核心与扩散页面**：Chain 列表 / Workbench、Agent Run、报告、项目、文献、成果、实验、外部引用、组织 / 身份 / 邀请码 / 导入 / 模板 / 审计 / 集成 / 代码 / 附件全部迁移 propel `Table` 与统一组件；科研模块手写原生 `<table>` 与本地 `STATUS_TONES` 清零。
5. **设计系统约束**：仅消费语义 token，新增代码无硬编码色值，无 Anti-AI-UI 元素。

## 2. 环境变量与开关

- **新增环境变量**：无。
- **新增开关**：无；`RESEARCH_MODULE_ENABLED`、`research_ia_v2` 等既有开关语义与层级不变。
- **数据库迁移**：无。

## 3. 验证结果

| 检查项                          | 结果                               |
| ------------------------------- | ---------------------------------- |
| Web 组件测试（17 文件）         | 59/59 通过                         |
| Web TypeScript `check:types`    | 通过                               |
| OxLint（research 目录 89 文件） | 0 警告                             |
| 路由 / 排序 / 权限回归          | 未修改请求参数、排序字段与权限分支 |

逐项验收见 [`research-workspace-ui-ux-acceptance-report.md`](./research-workspace-ui-ux-acceptance-report.md)。

## 4. 回滚策略

本次重构按九个阶段独立提交，可整体 revert 到 `4.9.1`，也可按阶段单独 revert（见验收报告 §1 阶段执行记录）。无数据迁移，回滚不涉及数据库操作。

## 5. 已知限制

1. 视觉回归截图基线需前端 dev server 可用后按 Phase 1 冻结矩阵采集归档；
2. `i18n sync-check` 中非中英语言的历史缺失 key 与本次发布无关，维持既有口径；
3. 报告列表筛选保留统一 FilterBar 形态，`rich-filters` 全量接入待数据结构适配后评估。
