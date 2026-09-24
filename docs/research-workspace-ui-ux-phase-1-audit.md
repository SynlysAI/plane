# Research Workspace UI/UX 重构 Phase 1 审计报告

| 项目     | 内容                                       |
| -------- | ------------------------------------------ |
| 文档状态 | 已冻结                                     |
| 日期     | 2026-09-24                                 |
| 上游文档 | `research-workspace-ui-ux-refactor-prd.md` |
| 适用分支 | develop                                    |

## 1. 审计范围与方法

本报告是 PRD 第 13 章 Phase 1 的交付物，只做呈现层审计，不改变业务行为。审计对象为 `apps/web` 科研模块全部路由与组件、`packages/propel` 设计系统、`packages/tailwind-config` 语义 token，以及 `apps/web/core/components` 中的既有成熟模式。

## 2. 设计系统资产清单

### 2.1 语义 token（可直接复用）

token 由 `@makeplane/propel/styles` 提供，经 `@plane/tailwind-config` 转成 Tailwind 工具类，自带浅色 / 深色 / 高对比三套主题：

- 表面：`bg-canvas`、`bg-surface-1`、`bg-surface-2`、`bg-layer-1`、`bg-layer-transparent-hover`、`bg-layer-transparent-active`
- 文本：`text-primary`、`text-secondary`、`text-tertiary`、`text-placeholder`、`text-on-color`
- 边框：`border-subtle`、`border-strong`
- 品牌与状态：`bg-accent-primary`、`bg-accent-subtle-hover`、`text-accent-primary`、`bg-warning-subtle`、`text-warning-primary`、`bg-success-subtle-1`、`text-success-primary`、`bg-danger-subtle`、`text-danger-primary`

结论：科研模块不需要新增颜色 token，也不修改全局主题实际色值。

### 2.2 可复用基础组件（@plane/propel）

- 按钮：`Button`（primary / secondary / ghost…）、`IconButton`
- 标签：`Badge`（neutral / brand / warning / success / danger × sm / base / lg）
- Tabs：`TabNavigationList` + `TabNavigationItem`（active 动效与 hover 已内建）
- 表格：`Table`、`TableHeader`、`TableBody`、`TableRow`、`TableHead`、`TableCell`
- 空态：`EmptyStateDetailed`、`EmptyStateCompact`（标题 + 说明 + 行动 + 低装饰 asset）
- 加载：`Skeleton`、`Spinners`
- 其他：`Avatar` / `AvatarGroup`、`Tooltip`、`Dialog`、`Popover`、`Menu`、`Switch`、`Toolbar`、`Input`、`Combobox`

### 2.3 web 侧成熟模式

- 侧边栏：`core/components/sidebar`（`SidebarNavItem`、`AppSidebarItem`）
- 面包屑：`core/components/breadcrumbs`（`BreadcrumbProject` 等）
- 筛选：`core/components/rich-filters`
- 空态：`core/components/empty-state`
- 遗留组件：`@plane/ui`（`Spinner` 等）

## 3. 复用映射表（冻结版）

| 需求        | 采用方案                                      | 科研现状（需收敛）                                                                                   |
| ----------- | --------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| 主 / 次按钮 | propel `Button` / `IconButton`                | `ResearchListState`、`ResearchStatusPanel` 等处仍有手写链接按钮                                      |
| 页面标签页  | `TabNavigationList` + `TabNavigationItem`     | `research-chain-workbench`、`research-approval-center`、`research-management-tabs` 等 5 处手写 nav   |
| 状态标签    | propel `Badge` + 科研状态字典                 | 6 处本地 `STATUS_TONES` 色值映射；Chain 详情手写 status/visibility span                              |
| 空态        | `EmptyStateDetailed` / `Compact` + 泛化配置   | `ResearchListState` 仅支持 projects / reports；多处 `<p>暂无数据</p>`                                |
| 加载        | `Skeleton`（结构化）/ `Spinner`（整页）       | 手写 `animate-pulse bg-surface-2` 灰块（chain-board、detail、todo-index、home-summary、agent-queue） |
| 表格        | propel `Table` 系列                           | 18+ 处手写原生 `<table>`，表头 / 行 hover / 密度各自定义                                             |
| 面包屑      | `core/components/breadcrumbs`                 | 详情页普遍缺失面包屑                                                                                 |
| 筛选        | `rich-filters` 评估；不适配处用统一 FilterBar | 报告列表手写 select/input/checkbox + 本地 chips                                                      |
| 侧边栏项    | `SidebarNavItem` / `AppSidebarItem` 视觉规范  | `research-sidebar-items` 自绘 Link，但已接近原生分组行为                                             |
| 提示        | propel `Tooltip`                              | 大量依赖纯文本或 title                                                                               |
| 成员展示    | `Avatar` / `AvatarGroup`                      | 手写圆形首字母 / userId 输入                                                                         |
| 浮层        | `Dialog` / `Popover` / `Menu`                 | 部分自绘 fixed 层                                                                                    |

## 4. 组件缺口清单

Phase 5 仅允许从 Golden Pages 的真实重复模式中提炼以下科研语义组件：

1. **科研状态字典 + Badge 展示组件**：覆盖草稿 / 待提交 / 审核中 / 进行中 / 待确认 / 已完成 / 已暂停 / 已归档 / 失败 / 异常，映射到 propel Badge variant；
2. **泛化空态配置**：`ResearchListState` 的 resource 从枚举文案升级为通用配置（标题 / 说明 / 主行动 / 次行动），区分首空、筛选无结果、权限不可见、模块未启用；
3. **统一 Tabs 链接组件**：`TabNavigationList/Item` 的路由包装，保留 URL query 同步与 `aria-current`；
4. **统一 Table 行组件**：基于 propel Table 的科研列表行规范（标题链接 / 状态 / Owner / 日期 / 右对齐操作）；
5. **统一 FilterBar**（仅在 rich-filters 不适配的报告等列表使用）：搜索 + 周期 + 状态 + Owner + chip + 一键清除。

不属于缺口、禁止新建：独立配色系统、插画体系、AI 装饰元素、平行页面壳。

## 5. 截图基线矩阵

当前执行环境前端 dev server 未运行，截图按以下矩阵在 Phase 9（或环境可用时）采集并归档到 `docs/screenshots/research-ui-ux/<phase>/`，命名规则 `page-ia-light-1440.png`：

| 页面       | 路由                                              | IA v1 | IA v2 | 浅色 | 深色 | 1440 | 1920 |
| ---------- | ------------------------------------------------- | ----- | ----- | ---- | ---- | ---- | ---- |
| 科研总览   | `/research`                                       | ✅    | ✅    | ✅   | ✅   | ✅   | ✅   |
| Chain 列表 | `/research/chains`                                | ✅    | ✅    | ✅   | ✅   | ✅   | ✅   |
| Chain 详情 | `/research/chains/[chainId]`                      | ✅    | ✅    | ✅   | ✅   | ✅   | ✅   |
| Agent 运行 | `/research/chains/[chainId]/nodes/[nodeId]/agent` | ✅    | ✅    | ✅   | ✅   | ✅   | ✅   |
| 审批中心   | `/research/approvals`                             | ✅    | ✅    | ✅   | ✅   | ✅   | ✅   |
| 项目与阶段 | `/research/projects`、`/[projectId]/stages`       | ✅    | ✅    | ✅   | ✅   | ✅   | ✅   |
| 报告与详情 | `/research/reports`、`/[reportId]`                | ✅    | ✅    | ✅   | ✅   | ✅   | ✅   |
| 实验记录   | `/research/projects/[id]/experiments`             | ✅    | ✅    | ✅   | ✅   | ✅   | ✅   |
| 外部引用   | `/research/projects/[id]/literature`              | ✅    | ✅    | ✅   | ✅   | ✅   | ✅   |
| 科研设置   | `/research/settings/*`                            | ✅    | ✅    | ✅   | ✅   | ✅   | ✅   |

采集要求：登录态使用 `docs/research-test-accounts.md` 中的测试账号；IA v2 通过 identity 的 `research_ia_v2` 开关控制；深浅色切换走 Plane 原生主题切换。

## 6. 业务行为回归用例清单（冻结）

以下行为在任何 Phase 都不得改变，作为每次 commit 的回归门槛：

1. **路由**：科研全部 28 个 `page.tsx` 路由可达性与参数解析不变；
2. **权限**：`ResearchPageShell` 的 identity 解析、`navKey` capability 校验、`adminOnly`、`allowDisabled` 分支与负例文案不变；
3. **IA 开关**：`research_ia_v2` 开/关时导航项过滤与 redirect 行为不变；
4. **排序**：审批四队列、报告列表、Chain 列表、实验 / 文献 / 成果列表的服务端排序参数不变；
5. **筛选**：报告列表周期 / 状态 / Owner / 可见性筛选请求参数不变；
6. **操作**：审批通过 / 驳回、报告提交 / 审核、阶段推进、成员变更等 API 调用与确认流程不变；
7. **可访问性**：现有 `aria-current`、`role=status/alert`、`aria-busy`、键盘可达路径不减少；
8. **主题**：浅色 / 深色 / 高对比下无硬编码 hex 导致的可读性回退。

## 7. Phase 1 结论

Plane 既有设计系统能力完整，科研模块的主要问题是"绕过组件直接拼视觉类"。复用映射表与缺口清单已冻结，后续阶段按 PRD 顺序执行：先升级共享壳，再打样三个 Golden Pages，随后才允许提炼语义组件并扩散到其余页面。
