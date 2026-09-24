# Research Workspace 产品级 UI/UX 重构 PRD

| 项目     | 内容                                                                                                                                                                                                                                           |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 文档状态 | 已实施（验收见 [`research-workspace-ui-ux-acceptance-report.md`](./research-workspace-ui-ux-acceptance-report.md)）                                                                                                                            |
| 文档版本 | v1.3                                                                                                                                                                                                                                           |
| 日期     | 2026-09-24                                                                                                                                                                                                                                     |
| 适用版本 | `web 4.9.0` 及后续 develop 分支                                                                                                                                                                                                                |
| 适用范围 | Plane web 端科研工作空间全部界面的视觉层级、组件构成与交互细节                                                                                                                                                                                 |
| 历史文档 | [`research-workspace-v3.md`](./research-workspace-v3.md)、[`research-intelligent-platform-prd.md`](./research-intelligent-platform-prd.md)、[`research-intelligent-platform-phase-1-plan.md`](./research-intelligent-platform-phase-1-plan.md) |

本文是 Research Workspace 产品级 UI/UX 重构的产品需求文档。它不改变已实现的信息架构、业务规则与权限模型，只定义呈现层如何从"功能可用的二次开发界面"收敛为"看起来像 Plane 原生功能的成熟科研工作空间"。

## 1. 文档定位与结论摘要

### 1.1 一句话目标

把科研模块做成一个克制、清晰、高信息密度、适合科研人员连续使用数小时的 Research Workspace，而不是一个更漂亮的 AI Dashboard。

### 1.2 核心结论：复用 Plane，不另起炉灶

本仓库已经存在一套成熟的设计系统：

- **语义 token**：`@makeplane/propel` 通过 `@plane/tailwind-config` 提供 `bg-canvas` / `bg-surface-1` / `bg-surface-2` / `text-primary` / `text-secondary` / `text-tertiary` / `border-subtle` / `bg-accent-primary` 等完整语义层，并自带浅色、深色、高对比主题。
- **基础组件**：`@plane/propel` 已有 `Button`、`Badge`、`TabNavigationList` / `TabNavigationItem`、`Table` 系列、`Tooltip`、`Avatar`、`Dialog`、`Popover`、`EmptyStateDetailed` / `EmptyStateCompact`、`Skeleton`、`Switch`、`Toolbar` 等。
- **web 侧成熟模式**：`core/components/sidebar`（`SidebarNavItem`、`AppSidebarItem`）、`core/components/breadcrumbs`、`core/components/rich-filters`、`core/components/empty-state`、`core/components/ui`。
- **科研侧共享壳**：`ResearchPageShell`、`ResearchStatusPanel`、`ResearchListState`、`ResearchGuard`、`ResearchManagementTabs`。

因此本次重构的**第一原则**是：

> 任何视觉需求先检查 Plane 是否已有成熟解法；有则复用或轻量扩展，没有才允许新增，且新增组件必须遵循 propel 的 token、命名、props 与 Storybook 约定，使科研功能看起来是 Plane 的自然延伸，而不是后来外挂的独立产品。

### 1.3 主要问题的根因判断

经过对 `apps/web` 科研相关代码的审计，当前界面"不像成熟产品"的根因不是缺少设计系统，而是：

1. 科研页面大量直接拼 Tailwind 视觉类，绕过了已有的语义组件。
2. 同一交互（Tabs、状态、空态、筛选、表格行）在不同页面各自实现，形成多套局部风格。
3. 层级主要靠边框、卡片和背景色表达，而不是排版、间距与信息分组。
4. 页面主次未定义：标题、操作、元数据、KPI、卡片网格视觉权重接近。

所以解法是**收敛到既有 Design System 并补齐科研语义组件**，不是新建一套 "Research Design System"。

### 1.4 四条执行原则

本次重构全程遵守以下四条原则；当后续章节出现理解歧义时，以这四条为准：

1. **不改变全局 Plane 主题，除非有充分证据**：默认不修改 Plane 全局主题 token 的实际色值，先改"怎么用"，再考虑"是什么颜色"；
2. **不改变业务排序与数据语义**：列表顺序、队列优先级、状态语义一律保持不变，只通过视觉层级突出重点；
3. **信息密度 ≠ 信息堆叠**：首屏只展示当前任务所需的最小充分信息，次级信息渐进展开；
4. **统一的是 Design System，不是所有页面结构**：组件、token、状态语义统一，但科研对象详情和 Agent Run / Trace 详情允许采用不同页面结构。

## 2. 范围与约束

### 2.1 改造范围

允许修改：

- UI hierarchy 与页面构成；
- Layout、CSS、Tailwind 类；
- Component composition（组件组合方式）；
- Typography、Spacing、Alignment；
- Color token 的使用方式（全局主题映射默认不修改，见 6.1）；
- Border、Radius、Shadow、State；
- Empty / Loading / Error / Permission 状态呈现；
- 交互反馈细节（hover、selected、disabled、overflow、tooltip、keyboard）。

如现有组件结构明显导致碎片化，允许做**不破坏业务行为**的适度重构，例如把重复的手写 Tabs 换成 `TabNavigationList`。

### 2.2 禁改项

以下内容一律不修改：

- API 契约与请求参数；
- 数据模型与迁移；
- 路由路径与跳转语义；
- 权限判断、`canSee` / `sections` / ACL 逻辑；
- 后端业务逻辑；
- 已有功能语义（状态流转、审批动作、报告版本规则等）；
- 列表与队列的数据排序、业务优先级规则（仅允许通过视觉层级突出，不允许改变排序语义）；
- Plane 全局主题 token 的实际色值（除非审计证明存在全局一致性问题，并按 6.1 单独评审）；
- IA v1 / IA v2 双信息架构的开关行为。

### 2.3 兼容性要求

1. **主题**：继续使用语义 token，保证浅色、深色、高对比主题可用；禁止在组件里写死只适配浅色的 hex 值。
2. **信息架构**：IA v2 开启与关闭两种形态都必须完成视觉验收；旧入口重定向行为保持不变。
3. **国际化**：所有新增文案进入 `@plane/i18n` 既有 research 命名空间，禁止硬编码中英文。
4. **可访问性**：键盘可达、焦点可见、`aria-current` / `aria-busy` / `role` 语义保留或补齐。
5. **分辨率**：1440px 与 1920px 下保持良好信息密度；1280px 不出现横向溢出破坏操作。

## 3. 现状审计

以下结论来自当前代码检查，作为需求依据与验收基线。

### 3.1 App Shell 与导航

**现状**：

- `research-sidebar-items.tsx` 用纯文本 `Link` 渲染导航项，而 Plane 原生侧边栏使用 `SidebarNavItem` / `AppSidebarItem` 的图标 + 状态体系。
- 科研分组与 Plane 其他分组的行为（折叠、存储、hover）基本一致，但视觉细节（圆角、active 背景、图标）未对齐。

**问题**：

- 科研导航看起来像外挂区块，不像 Plane 原生导航；
- 没有 icon 层，层级只靠缩进与文字；
- active 态与 Plane 原生项的视觉强度不一致。

### 3.2 Page Header

**现状**：`research-page-shell.tsx` 的头部是 `px-5 py-3` 中的一行 `text-14` 标题 + `text-12` 描述，右侧直接放 `actions`。

**问题**：

- 页面标题层级不足（14px），无法承载页面主入口的视觉重量；
- 无面包屑，详情页与列表页的上下文关系断裂；
- 标题、说明、筛选器、主操作经常挤在同一行，主次不清；
- 不同页面各自在 `actions` 里拼 select、button、时间戳，风格不一致。

### 3.3 Tabs

**现状**：

- `research-chain-workbench.tsx`、`research-approval-center.tsx`、`research-management-tabs.tsx` 各自手写 `nav + Link + rounded-md + bg-surface-2` 的标签栏；
- propel 已提供 `TabNavigationList` / `TabNavigationItem`。

**问题**：

- 同一交互存在至少三套实现；
- active 反馈、间距、滚动行为不一致；
- 违反"Plane 已有成熟方案则复用"的原则。

### 3.4 状态与 Badge

**现状**：

- Chain 详情把 status / visibility 渲染为手写 `span + border + bg-surface-2`；
- 报告列表使用本地 `STATUS_TONES` 色值映射；
- propel `Badge` 与其 variant 体系未被科研模块统一采用。

**问题**：

- 状态语义、颜色、形状、尺寸没有统一字典；
- 同一状态在不同页面可能颜色不同；
- 颜色饱和度与边框策略不一致，部分状态看起来像装饰而不是信息。

### 3.5 Empty / Loading / Error / Permission

**现状**：

- `ResearchListState` 只支持 `projects` / `reports` 两类资源文案，其他列表直接写 `<p>暂无数据</p>`；
- Chain 详情错误态是 `p + button`，权限态是另一段 `p`；
- `ResearchStatusPanel` 是独立居中卡片，与列表态组件不构成同一状态系统；
- propel 已有 `EmptyStateDetailed` / `EmptyStateCompact` / `Skeleton`，但科研模块基本未使用。

**问题**：

- 空态缺少"标题 + 原因说明 + 下一步行动"的产品化结构；
- loading 有的用居中 Spinner、有的用两行灰块，差异明显；
- 错误与无权限的表达强度、位置、操作不一致。

### 3.6 卡片碎片化与边框密度

**现状**：

- 科研总览在 IA v1 下渲染 4 列业务卡片 + 3 列设置卡片网格；
- Chain 详情、Agent 面板、知识面板大量使用 `rounded-lg border bg-surface-1` 容器；
- 卡片内再嵌卡片、列表外再包边框的情况较多。

**问题**：

- 信息被切成大量等权重小方块，主次消失；
- 边框承担了本应由间距和排版承担的分组职责；
- 视觉上接近通用 SaaS 模板与 AI Coding 产物。

### 3.7 列表与表格

**现状**：

- 报告列表手写原生 `table`（`text-12`、`py-2`、`min-w-[720px]`），表头样式本地定义；
- 多数实体列表用卡片或简单 `ul`，列对齐与行 hover 不一致；
- propel / `@plane/ui` 已有 Table 体系未被采用。

**问题**：

- 科研数据没有形成成熟 B2B 软件的结构化阅读体验；
- 标题、状态、Owner、日期、操作没有稳定的列位；
- 行级操作与溢出策略不统一。

### 3.8 筛选

**现状**：

- 报告列表手写 select / input / checkbox，再用 `filterSummary` 渲染 chips；
- Plane 已有 `rich-filters` 体系用于工作项等成熟列表。

**问题**：

- 筛选操作区像表单堆叠，不像视图控制；
- 激活筛选的表达、清除路径、键盘操作不统一。

### 3.9 首页与科研总览

**现状**：

- `ResearchHomeSummaryCard` 是 `rounded-xl` 大卡片；
- 总览页混合 TodoIndex、Chain 区块、PI 汇总板、卡片网格，纵向节奏未分层；
- 周期筛选是原生 `select`，刷新时间是纯文本。

**问题**：

- 页面更像功能入口集合而不是"当前工作台"；
- 当前工作、待处理事项、最近活动之间的优先级不明确；
- KPI 与入口卡片权重接近，缺乏 Primary / Secondary / Supporting 定义。

### 3.10 Token 使用

**现状**：科研组件已经普遍使用 `bg-surface-1`、`text-primary` 等语义类，这是好的基础；但具体组合（边框、圆角、字号、间距）散落在各页面，没有形成页面级规范。

**问题**：

- token 正确不等于层级正确；
- 页面偏白、留白随机、密度不稳定的问题来自组合层，而不是 token 层。

## 4. 设计目标与非目标

### 4.1 产品目标

1. **原生感**：科研功能在 Shell、导航、按钮、Tabs、状态、空态、表格上与 Plane 其他模块视觉同源。
2. **主次清晰**：每个页面能明确回答"用户此刻最该看什么、下一步做什么"。
3. **高信息密度且安静**：提高单屏有效信息量，同时降低边框、色块与阴影带来的噪音。
4. **长时间使用舒适**：微暖中性背景、低饱和状态色、克制 hover，适合连续数小时工作。
5. **一致性**：同一对象、状态、操作在列表、详情、审批、Trace 中呈现一致。
6. **工程可持续**：收敛重复实现，让后续科研页面默认长在正确的组件上。

### 4.2 非目标

1. 不新增业务对象、字段、KPI 或统计口径；
2. 不引入新的 UI 库或 CSS 框架；
3. 不做营销化视觉、插画体系、AI 徽章或动效展示；
4. 不复制 Twenty、Kaneo、Outline、Huly、AppFlowy 的页面，只借鉴其信息结构经验；
5. 不推翻 IA v2 的信息架构收敛方向；
6. 不为了统一而牺牲已验证的可访问性与权限负例行为。

## 5. 设计原则：Plane 原生优先

### 5.1 复用决策顺序

实现任何界面时按以下顺序决策，禁止跳级：

```text
1. @plane/propel 基础组件 / 语义 token
2. @plane/ui 遗留组件（如 Header、Breadcrumbs、Table）
3. apps/web/core 既有模式（sidebar、rich-filters、empty-state、ui）
4. research 现有共享组件（ResearchPageShell、ResearchListState、ResearchStatusPanel）
5. 新增 research 语义组件（仅在真实缺口时）
```

新增组件必须满足：

- 命名与 props 风格与 propel 一致；
- 只消费语义 token，不硬编码 hex；
- 在对应包的 Storybook 补充可视化用例；
- 有明确注释说明为什么现有组件无法满足；
- 只有存在稳定的共享语义时才抽象为共享组件；单页特有结构优先保留局部组件，避免为了复用而抽象。

共享组件的抽象门槛：

1. 语义明确：组件名表达交互语义，而不是视觉样式；
2. API 稳定：props 不随单个页面需求频繁变化；
3. 两个以上场景确实存在相同交互，而不是"看起来可以复用"。

换句话说：**不追求组件数量，追求语义复用**。

### 5.2 复用矩阵

| 需求        | 优先复用                                                                    | 禁止做法                                     |
| ----------- | --------------------------------------------------------------------------- | -------------------------------------------- |
| 主 / 次按钮 | `@plane/propel` `Button`                                                    | 手写 `rounded-md bg-accent-primary` 链接按钮 |
| 页面标签页  | `TabNavigationList` + `TabNavigationItem`                                   | 每个页面手写 `nav + bg-surface-2`            |
| 状态标签    | `Badge` + 统一状态字典                                                      | 各页面自定义 `span + border + 色值`          |
| 空态        | `EmptyStateDetailed` / `EmptyStateCompact`，经 `ResearchListState` 泛化封装 | `<p>暂无数据</p>`                            |
| 加载        | `Skeleton`（结构化）或 `Spinner`（整页）                                    | 随机灰色块                                   |
| 表格        | propel `Table` 系列或 `@plane/ui` `Table`                                   | 手写无状态样式的原生 table                   |
| 面包屑      | `core/components/breadcrumbs`                                               | 手写箭头文本                                 |
| 筛选        | `rich-filters`；确不适用时用统一 FilterBar                                  | select/input/checkbox 表单堆叠               |
| 侧边栏项    | `SidebarNavItem` / `AppSidebarItem` 的视觉与交互规范                        | 独立风格的文字链接                           |
| 提示        | propel `Tooltip`                                                            | 纯 `title` 属性或悬浮文本                    |
| 成员展示    | `Avatar` / `AvatarGroup`                                                    | 手写圆形首字母                               |
| 浮层        | `Dialog` / `Popover` / `Menu`                                               | 自绘 fixed 层                                |

### 5.3 "原生延伸"判据

一个科研界面是否合格，用以下五问检查：

1. 把文案换成 Plane 原生模块的文案后，是否看不出风格断裂？
2. 是否复用了与 Plane 相同的按钮、Tabs、状态、空态与表格基因？
3. 是否遵守同一 token 语义与主题能力？
4. 键盘与焦点行为是否与 Plane 一致？
5. 是否没有只有科研模块才出现的装饰性视觉语言？

任何一问为否，均视为"外挂感"未消除。

### 5.4 统一 Design System，不统一页面结构

统一的是 token、组件、状态语义与交互细节；不是把所有页面套进同一个布局。

至少区分两类页面结构：

1. **科研对象详情**（课题、Chain、报告、实验等）：Header → Tabs → Main Content → Supporting Info → Activity；
2. **Agent Run / Trace 详情**：Run Header → Context → Timeline → Tool Calls → Intermediate Results → Trace → Artifacts → Input / Output。

把 Agent Run 强行套进对象详情的 Tabs 结构，或把报告详情套进 Trace 的时间线结构，都属于"统一过头"。

## 6. 视觉语言与 Token 方案

### 6.1 颜色：复用 Plane 语义 token，默认不修改全局主题

本次重构的目标不是"把 Plane 变成某套暖灰 + 深青色"，而是**让科研模块遵循 Plane 原有 Design System，通过页面构成、信息层级、间距、密度和组件使用方式变高级**。

因此颜色策略固定为：

```text
本次重构默认不修改 Plane 全局主题 token 的实际色值。

优先复用现有 bg-canvas / bg-surface / text / border / accent
语义 token，并通过正确的层级组合改善科研页面观感。

只有经验证 Plane 当前主题本身存在全局一致性问题，
才考虑调整主题映射；若调整，必须同时验证原生模块。
```

语义角色与 token 的对应关系：

| 语义角色 | 使用 token                                                          |
| -------- | ------------------------------------------------------------------- |
| 页面背景 | `bg-canvas`                                                         |
| 主要表面 | `bg-surface-1`                                                      |
| 弱化表面 | `bg-surface-2` / `bg-layer-1`（按语义选择，不按视觉随意挑选）       |
| 边框     | `border-subtle`（`strong` 仅用于真正强调）                          |
| 主文本   | `text-primary`                                                      |
| 次要文本 | `text-secondary`                                                    |
| 弱化文本 | `text-tertiary`                                                     |
| 强调     | `bg-accent-primary` / `text-accent-primary`（取当前主题值，不改写） |

实施要求：

1. 先改"怎么用"，再考虑"是什么颜色"：层级问题优先通过表面选择、间距、分组和排版解决；
2. 新增科研代码禁止硬编码 hex；存量硬编码色值随对应页面重构逐步收敛，不要求一次性清零；
3. 状态色低饱和，只表达状态，不做装饰；
4. 强调色稀疏使用：主操作、链接、当前选中、关键数据；不允许用多种亮色区分卡片；
5. 任何全局主题 token 调整必须单独评审，并附带 Plane 原生模块的前后对比截图。

### 6.2 Typography：遵循 Plane type scale，只定义层级关系

Typography 优先遵循 Plane / Propel 现有 type scale。本次只定义层级关系，**不强制建立新的字号体系**；若现有字号无法满足页面主次，再在现有 scale 范围内调整。

层级关系（不指定固定 px）：

| 层级关系      | 语义                               |
| ------------- | ---------------------------------- |
| Page Title    | 页面主识别，明显强于区块标题       |
| Section Title | 区块分组，弱于页面标题、强于正文   |
| Metric        | 少量关键数字，可独立成级但必须克制 |
| Body          | 正文、表单、表格主内容             |
| Secondary     | 元数据、说明、表格次要列           |

规则：

1. 科研页面与 Plane 原生页面使用同一 type scale，避免出现"科研区域字号明显外挂"；
2. 层级优先来自字号、字重、间距、对齐，最后才是颜色；
3. 不用 uppercase + tracking 做大量区块标题（仅保留极少量分组标签）；
4. 长标题必须 `truncate` 或多行 clamp，并保证 tooltip 可见完整值。

### 6.3 Spacing

| 关系             | 间距                                                 |
| ---------------- | ---------------------------------------------------- |
| 主要语义区块之间 | 24–32px                                              |
| 相关条目之间     | 12–16px                                              |
| 标签与数值之间   | 6–8px                                                |
| 页面左右安全区   | 与 Plane Shell 一致（当前 20px 基线，随 Shell 统一） |

禁止无语义的大空白；不允许用 padding 解决层级问题。

### 6.4 Radius

- 小控件（按钮、输入框、tag 容器）：6–8px；
- 主要容器：10–12px；
- pill 只用于状态标签与筛选 chip，不允许大面积药丸容器；
- 科研页面现有 `rounded-xl` 大卡片需收敛为区块或 10–12px 容器。

### 6.5 Border 与 Shadow

1. 默认减少 Border：能用 spacing + typography 分组就不用边框；
2. 禁止 Card 嵌 Card 再嵌 Card；同语义信息合并为一个表面，用分隔线或留白组织；
3. 默认无阴影；
4. 仅 Dropdown、Popover、Dialog、Command 菜单允许极轻微阴影。

**Card 不是禁止项**：当一个区域具有独立任务、独立状态或独立操作边界时，允许使用 Surface / Card 形成明确的视觉分组。本次目标是减少"无语义 Card"，而不是消灭所有 Card；同样不允许把 Card 全部移除后退化成大面积白底 + 横线 + 巨量空白。

## 7. 布局与页面结构规范

### 7.1 App Shell

要求：

- 科研导航复用 Plane 侧边栏的项视觉、图标尺寸、active/hover/disabled 状态；
- 图标统一使用 propel icons 的线性图标族，16–18px，统一线宽；
- 分组标题明确、紧凑、低对比；
- active 态使用微弱背景 + 较强文字，不允许彩色大块或发光；
- 折叠、持久化、键盘行为与 Plane 原生分组一致。

### 7.2 Page Header

统一结构：

```text
Breadcrumbs（详情页必须有）
↓
Page Title（取 Plane type scale 的页面主标题档位）+ 关键状态
↓
一句简短说明（可选，不超过一行）
↓
主操作（右侧；一个视图内主按钮通常只有一个）
```

规则：

1. 筛选器不挤进标题行，放在标题区下方的视图控制区；
2. metadata（Owner、更新时间、范围）进入元信息行或属性区，不与主操作混排；
3. 刷新、导出等次级操作使用图标按钮 + tooltip；
4. `ResearchPageShell` 是唯一页面壳入口，扩展它而不是绕开它新建平行壳。

**Header 密度分级**：Page Header 允许三种密度等级，按页面任务复杂度选择，不要求所有页面填满相同结构：

1. **Title-only**：标题 + 主操作，适合任务明确的简单列表；
2. **Title + Metadata**：标题 + 一行元数据 + 主操作，适合审批中心、报告列表、实验记录等；
3. **Title + Description**：标题 + 一句说明 + 主操作，适合总览、Research Chain 等需要交代上下文的页面。

### 7.3 详情页结构：Object / Context / Action

所有核心科研对象页面必须先回答四个问题：

```text
我现在看的是谁？
它属于什么？
它现在是什么状态？
我能对它做什么？
```

因此统一采用以下信息模型：

```text
Identity（对象是谁）
→ Context（属于哪个课题 / 项目 / Chain）
→ State（当前状态）
→ Primary Action（下一步能做什么）
→ Content（当前核心内容）
→ Supporting Information（关联属性、成员、引用）
→ History / Activity（过程与 Trace）
```

**该模型是信息组织方式，不是首屏展示清单**：不要求所有字段同时首屏展示。首屏只呈现当前任务所需的最小充分信息，其余信息根据上下文通过 metadata、tabs、drawer、details 或 secondary panel 渐进呈现。

#### 7.3.1 科研对象详情

适用于：课题 / 项目、Research Chain、节点、阶段、报告、实验记录、外部引用。

```text
Object Header
  Identity + Context + State + 关键 metadata
  Primary Actions（最多一个主按钮 + 少量次级操作）
↓
Tabs（TabNavigationList）
↓
Main Content
↓
Supporting Information（属性、成员、引用）
↓
Activity（活动、历史）
```

#### 7.3.2 Agent Run / Trace 详情

Agent Run 是过程记录，不是普通业务对象，不强行套用对象详情的 Tabs 结构：

```text
Run Header（任务、状态、发起人、耗时、关联节点）
↓
Context（输入、上下文、关联对象）
↓
Timeline（运行过程）
  Tool Calls
  Intermediate Results
  Validation
  Human Decision
↓
Trace
↓
Artifacts
↓
Input / Output
```

要求：

1. 标题很大时，真正重要的状态、Owner、时间、当前节点不能被埋进弱化文本；
2. 属性展示采用 Object 属性思路：标签左、值右、成组、可扫读；
3. 操作按钮必须有明确层级：主操作、次操作、危险操作、只读操作；
4. 详情页中的列表仍使用统一 List/Table 行，不切换成另一套卡片风格；
5. 统一 Design System ≠ 统一页面结构：两类详情使用不同结构，但使用同一套 token、组件与状态语义。

### 7.4 List / Table 规范

科研数据默认使用结构化行，而不是逐条卡片：

```text
标题（主识别，左对齐，链接）        日期（右对齐或固定列）
状态                                Owner
摘要 / 次要属性                     Action
```

规则：

1. 使用横向分隔线，不逐行圆角卡片；
2. 列对齐：文本左对齐、时间与数字右对齐或固定宽度；
3. 行高紧凑（约 40–48px），元数据 12–13px；
4. 行 hover 微弱（`bg-surface-2` 或等价 token），selected 更强一级；
5. 行内操作右对齐，hover 或 `MoreHorizontal` 菜单承载低频操作；
6. 长文本 truncate + tooltip，列表不出现换行撑高；
7. 空态、加载态、错误态占用同一表格区域，避免布局跳动。

### 7.5 首页与科研总览节奏

信息优先级固定为：

```text
当前工作
↓
科研状态
↓
待处理事项
↓
最近活动
↓
进入 Research Chain
```

要求：

1. 首屏呈现"我此刻要处理什么"，而不是入口卡片网格；
2. 保持现有数据顺序与业务排序规则不变，仅通过视觉权重、状态、操作入口和分组方式突出高优先级事项，并给出直达操作；
3. KPI 只保留决策必需项，合并为单一区块 + 竖向分隔线，不做彩色指标卡阵列；
4. 最近活动用紧凑时间线行，可扫读；
5. Research Chain 入口是明确的下一步行动，而不是多个等权重按钮之一。

**信息密度 ≠ 信息堆叠**：

```text
首屏只展示当前任务所需的最小充分信息。

次级信息通过以下方式渐进展开：
- Tabs
- Disclosure
- Details
- Drawer
- Secondary panel
- Activity
```

避免因为追求"高密度"导致首屏信息拥挤。

### 7.6 视觉优先级决策表

每个页面在动手前先完成 Primary / Secondary / Supporting 分层，再落到视觉：

| 层级       | 允许数量                        | 内容                               |
| ---------- | ------------------------------- | ---------------------------------- |
| Primary    | 1 个主要内容对象 + 1 个主要行动 | 当前对象、当前任务、下一步操作     |
| Secondary  | 2–4 个辅助信息组                | 状态、关键属性、待办、主要关联对象 |
| Supporting | 其余                            | 元数据、历史、引用、低频操作       |

规则：

1. 视觉权重依次递减：Primary > Secondary > Supporting；
2. 一个页面不得出现多个视觉权重相同的 Primary；
3. 层级通过排版、间距、对齐和表面选择表达，而不是依靠颜色数量；
4. 若无法判断谁是 Primary，说明页面主次未定义，先回到信息架构，不做视觉修饰。

## 8. 组件需求

### 8.1 ResearchPageShell 升级

在现有 `ResearchPageShell` 上扩展（不新建并行组件）：

- 支持 `breadcrumbs` 插槽；
- 支持 Page Title 层级（取 Plane type scale 的页面主标题档位）；
- 支持 `metadata` 插槽（与 actions 分离）；
- 保留现有 identity 解析、权限判断与 loading/denied 分支；
- `actions` 内部统一使用 propel `Button` / `IconButton`。

### 8.2 统一状态系统

新增一个科研状态字典 + 展示组件（基于 propel `Badge`）：

- 覆盖：草稿、待提交、审核中、进行中、待确认、已完成、已暂停、已归档、失败、异常；
- 每个状态定义：语义 key、中英文案 key、低饱和 token、是否可操作、图标（可选）；
- 同一状态在列表、详情、审批、Agent、Trace 中必须同形、同色、同语义；
- 状态颜色只用于表达状态，禁止扩展为分类装饰色。

### 8.3 空态系统

基于 propel `EmptyStateDetailed` / `EmptyStateCompact` 泛化 `ResearchListState`：

1. `resource` 从枚举文案改为通用配置（标题 key、说明 key、主行动、次行动）；
2. 空态结构固定为：标题 → 原因说明 → 下一步行动；
3. 区分四类：首次为空、筛选无结果、权限不可见、模块未启用；
4. 不新增插画体系；如使用现有 asset，必须低装饰、与 Plane 一致；
5. 列表内嵌空态使用 compact，整页空态使用 detailed。

### 8.4 Tabs

- 全部替换为 `TabNavigationList` + `TabNavigationItem`；
- 保留 URL query 同步与 `aria-current`；
- 标签过多时横向滚动，不允许换行破坏 header；
- tabs 下沿使用一条 subtle 分隔线，不额外加背景块。

### 8.5 筛选与视图控制

- 优先评估接入 `rich-filters`；
- 若某列表数据结构暂不支持，则提供一个统一的 FilterBar 组合（搜索 + 周期 + 状态 + Owner），不允许各页面自拼表单；
- 激活筛选以 chip 表达，并提供一键清除；
- 筛选区与内容区之间保持稳定高度，切换时不跳动。

### 8.6 Loading / Error / Permission

1. 整页首次加载：居中 `Spinner` 或结构化 `Skeleton`；
2. 列表刷新：保留旧内容 + 顶部细进度或行级 skeleton，不整页闪白；
3. 错误：统一错误面板，标题 + 说明 + 重试 + 返回；
4. 无权限：明确"为什么看不到 + 应该找谁 / 返回哪里"，不暴露敏感范围；
5. 以上状态全部复用 `ResearchStatusPanel` / `ResearchListState` 的统一出口。

## 9. 重点页面需求

本章的结构要求按对象类型理解，不要求所有页面使用同一布局；统一的是 token、组件、状态与交互语义（见 5.4）。

### 9.1 首页与科研总览

**目标**：从入口卡片集合变成科研人员的工作台。

**改动**：

- `ResearchHomeSummaryCard` 收敛为"当前工作"区块，突出当前 Chain、当前节点、待人工处理项；
- 总览页按 7.5 的信息节奏重排；
- 周期切换使用统一控件，刷新时间放入 metadata；
- 业务入口卡片合并为分组列表或紧凑导航，不再使用大卡片网格。

**验收**：首屏能回答"我现在该做什么"；无彩色 KPI 卡阵列；进入 Research Chain 的路径不超过一次点击。

### 9.2 Research Chain 列表

**目标**：体现研究对象与研究过程，而不是普通后台列表。

**改动**：

- 列表行展示：课题、当前节点、节点状态、Owner、更新时间、下一步操作；
- 视图切换（chains / projects / reports）使用 `TabNavigationList`；
- 空态说明"开始一次研究任务后会发生什么"；
- 筛选与视图控制进入 header 下方控制区。

**验收**：不打开详情也能判断每条链路处于哪个研究阶段、是否等待人工决策。

### 9.3 Research Chain 详情

**目标**：成为科研过程的主工作台，体现"研究对象 → 节点 → Agent 行为 → 中间产物 → 验证 → 人类决策 → 输出"。

**改动**：

- Object Header 呈现：课题、Chain 状态、可见性、Owner、当前节点、更新时间；
- 当前节点与待人工决策项是页面 Primary，不允许被弱化成一行小字；
- 节点详情区分 Input、AI Action、Intermediate Product、Validation、Human Decision、Output、Trace 的信息层级；
- Trace / Activity 使用紧凑时间线，不做成卡片流；
- 成员管理从手写 userId 输入收敛为人员选择组件（复用现有 `PersonSelect` 能力）与标准表格；
- tabs、状态、空态、错误态全部使用统一组件。

**验收**：研究者能在详情页一眼看出"当前卡在哪、为什么卡、谁需要做什么"。

### 9.4 Agent 工作台与运行状态

**目标**：像受控的科研工具调用记录，而不是 AI 演示界面。

**结构**：按 7.3.2 的 Agent Run / Trace 详情组织，不套用科研对象详情的 Tabs 结构。

**改动**：

- Run Header 呈现：任务、状态、发起人、开始 / 结束时间、耗时、关联节点；
- 工具调用、中间产物、Trace 使用统一时间线行 + 状态标记；
- 运行中、等待确认、失败、完成状态接入统一状态系统；
- 空态提供"开始一次研究任务"的明确行动；
- 禁止 AI glow、渐变、粒子、AI badge。

**验收**：灰度截图下仍能清楚区分运行阶段与状态。

### 9.5 审批中心

**目标**：让待办处理高效、可扫读。

**改动**：

- 四个队列（阶段评审、报告评审、Agent 审批、办公室事务）使用 `TabNavigationList`；
- 每行展示：对象、类型、提交人、提交时间、等待时长、状态、主操作；
- 不改变队列排序规则，仅通过视觉层级突出等待时间、状态异常、需要人工处理的事项；
- 批量或高频操作右对齐，危险操作二次确认复用 `AlertModal`。

**验收**：审批人不需要进入详情即可判断优先级和动作。

### 9.6 课题 / 项目与阶段

**目标**：成熟 Object Detail。

**改动**：

- 项目头部展示课题状态、负责人、阶段进度、时间范围；
- 阶段列表用时间线 / 阶段条呈现，材料、检查单、历史进入 tab；
- 属性区采用统一"标签—值"排版；
- 材料详情保持阅读优先，操作放头部与右侧辅助区。

### 9.7 报告与成果

**改动**：

- 报告列表迁移到统一 Table 行：周期、类型、Owner、组织、状态、可见性、更新时间、操作；
- 报告详情区分正式版本与草稿状态，版本信息进入 metadata；
- 成果列表同样使用结构化行，不使用成果卡片阵列。

### 9.8 实验记录

**改动**：

- 列表行展示：实验、项目、状态、负责人、日期、关键产物；
- 详情采用 Object Detail 结构，实验内容阅读优先；
- 关联 Chain、报告、外部引用放入 Supporting Information。

### 9.9 外部引用

**改动**：

- 引用列表统一为行式结构：标题、来源系统、类型、关联对象、更新时间、打开操作；
- 引用选择器复用统一搜索 / 下拉组件；
- 健康状态接入统一状态系统。

### 9.10 科研管理与设置

**改动**：

- 设置导航沿用 Plane settings 的布局语言；
- 表格类页面（组织、身份映射、审计、导入审核）统一 Table 样式与空态；
- 表单使用统一输入组件与说明排版，避免每个设置页一套布局。

## 10. Anti-AI-UI 硬规则

以下元素一律禁止新增，存量发现即删除：

- AI Glow、Neon、渐变背景 / 渐变按钮 / 渐变文字；
- Glassmorphism、大面积 blur、科技网格背景；
- 装饰性粒子、浮动气泡、抽象斑点；
- 巨型 icon、hero 区块、AI badge、"Powered by AI" 标签；
- 彩色卡片阵列、多彩指标卡；
- 复杂入场动画与纯装饰动效。

视觉问题必须按以下顺序解决：

```text
排版 → 留白 → 对齐 → 信息分组 → 背景层次 → 字体层级 → 分隔线 → 颜色
```

## 11. 交互细节与可访问性

每个页面交付前必须检查：

1. Hover、Active、Selected、Disabled、Loading、Empty、Error、Permission 状态齐全；
2. 长文本 truncate + tooltip，表格不横向破坏；
3. 操作按钮有 tooltip 或可见文本标签；
4. 键盘可完成主要操作，焦点环可见且不依赖颜色；
5. `aria-current`、`aria-busy`、`role="status"`、`role="alert"` 语义正确；
6. 次级操作不与主操作争夺视觉权重；
7. 过渡动效使用 Plane 既有 motion / transition token；若无对应定义，再采用短时、低幅度过渡，禁止夸张动画；
8. 颜色对比满足可访问性要求，信息在灰度下仍可区分。

## 12. 响应式与信息密度

1. **1920px**：主内容保持可扫读列宽，列表不无限拉伸；详情页主 / 辅栏比例稳定；
2. **1440px**：单屏可见行数不少于当前基线，筛选与操作不换行堆叠；
3. **1280px**：允许横向滚动，但操作列不丢失；
4. 移动端保持可用但不作为本次重点，不得因重构退化。

## 13. 实施计划

严格按以下顺序执行，不允许跳到页面美化：

```text
1. Plane 原生设计系统审计
        ↓
2. 信息架构 / 对象层级审计
        ↓
3. App Shell + 基础 Page Shell
        ↓
4. Golden Pages
        ↓
5. 从 Golden Pages 提炼新增语义组件
        ↓
6. 核心页面
        ↓
7. 扩散到其他页面
        ↓
8. 视觉回归 + 业务回归
```

### Phase 1 — Plane 原生设计系统审计

- 建立页面截图基线（IA v1 / IA v2、浅色 / 深色、1440 / 1920）；
- 梳理 Plane / Propel 现有 type scale、语义 token、组件清单与原生页面参照；
- 输出组件缺口清单与复用映射表；
- 冻结业务行为回归用例清单。

### Phase 2 — 信息架构与对象层级审计

- 将第 3 节审计问题按页面归类，确认优先级；
- 为每个核心对象建立 Identity / Context / State / Primary Action 映射；
- 标记"重复造轮子"的实现点（手写 Tabs、Badge、空态、表格）。

### Phase 3 — App Shell + 基础 Page Shell

Golden Pages 依赖 Sidebar、Page Header、Breadcrumb、Button、Tabs、Status、Surface 与 Spacing 基线，因此基础壳先行：

- 升级**已有共享壳**：`ResearchPageShell`、科研侧边栏、Topbar、Page Header、Breadcrumb；
- 保证与 Plane 原生导航视觉同源；
- 仅建立 Golden Pages 打样所需的基础能力，不提前铺开全部页面。

### Phase 4 — Golden Pages 打样

先完成三个"黄金页面"，建立可验收的质量基准：

1. **科研总览**：解决 Page Header、KPI、当前工作、List、Filter、Section；
2. **Research Chain 详情**：解决 Object Header、Tabs、Status、Node、Activity、Trace、Empty、Permission；
3. **审批中心**：解决 Queue、Filter、Table、Status、Action、Priority、Empty。

**质量门禁：这三个页面确认前，不允许扩散到其他科研页面。**

### Phase 5 — 新增科研语义组件收敛

- 仅从已确认 Golden Pages 的**实际重复模式**中提炼新增科研语义组件，而不是预先抽象；
- `ResearchPageShell` 等已有共享壳已在 Phase 3 升级，不混入本阶段；
- 建立状态字典、空态配置、统一 Tabs / Table / Filter 组合；
- 补 Storybook 用例。

### Phase 6 — 核心页面

- 首页：按 7.5 重排信息节奏，收敛入口卡片与 KPI；
- Research Chain 列表与节点；
- Agent / Trace：按 7.3.2 的过程记录结构执行。

### Phase 7 — 扩散到其他页面

- 课题 / 项目与阶段、报告与成果、实验记录、外部引用、科研管理与设置；
- 只复用 Golden Pages 已验证的模式，不新造局部风格。

### Phase 8 — 全局状态与 primitives 复查

- Empty、Status、List、Table、Detail、Modal、Filter、Action 全局一致性检查；
- 清理残留手写实现。

### Phase 9 — Product-level Visual Review

- 按第 14 节验收清单逐页截图评审；
- 缩略图检查、灰度检查、深色主题、权限负例、键盘路径全部回归；
- 输出视觉回归截图与业务回归报告。

## 14. 验收标准

### 14.1 功能回归

- 路由、API 请求、权限判断与重构前一致；
- 列表与队列排序规则与重构前一致；
- IA v1 / IA v2 行为一致；
- 既有组件测试全部通过；
- 深色与高对比主题无 token 失效。

### 14.2 产品级视觉检查

逐页确认：

1. 是否还有明显 AI SaaS 模板感？
2. 是否还有过多 Card / Border / Shadow？
3. 页面主次是否清晰？
4. 标题、状态、操作层级是否明确？
5. Research Chain 是否体现科研过程？
6. Detail Page 是否像成熟产品？
7. Empty State 是否像正式产品？
8. List / Table 是否结构化、精致、可扫读？
9. Status 是否全局统一？
10. Sidebar 是否安静？
11. 页面之间是否使用同一设计语言？
12. 是否适合长时间科研工作？
13. 1440px / 1920px 信息密度是否良好？
14. 科研功能是否像 Plane 原生延伸？

### 14.3 缩略图验收（Thumbnail Test）

将页面缩至 25%–35% 后检查：

- 页面标题是否仍然突出；
- 当前状态是否容易找到；
- Primary Action 是否突出；
- 内容分组是否清楚。

高级 Workspace 的视觉层级在缩小后通常依然成立；不成立则说明层级依赖局部细节而非信息结构。

### 14.4 灰度验收

将页面转为灰度后：

- 层级依然清晰；
- 状态依然可区分；
- 主要操作依然可识别；
- 不依赖颜色才能理解的信息结构。

任何一项不达标，继续做减法，不通过增加装饰解决。

### 14.5 视觉回归截图

- 关键页面保存重构前 / 后截图：浅色 / 深色、1440 / 1920、IA v1 / IA v2；
- Golden Pages 与核心页面必须逐一对比，扩散页面按模块抽样对比；
- 截图与结论归档，作为后续回归基线。

## 15. 风险与回滚

| 风险                               | 缓解                                                     |
| ---------------------------------- | -------------------------------------------------------- |
| 修改主题 token 影响 Plane 原生页面 | 默认不修改全局主题；确需调整时单独评审并对比原生模块截图 |
| 组件替换改变交互行为               | 保留 props 与路由语义；补充组件测试；分页面灰度替换      |
| IA v1 / IA v2 双态遗漏             | 两态都纳入截图与回归矩阵                                 |
| 深色主题下新样式失效               | 禁止硬编码色值；每阶段跑深色截图                         |
| 重构范围扩散到业务                 | 以第 2.2 节禁改项为合并门槛                              |

回滚策略：按 Phase 提交独立 commit，任一阶段出现视觉或行为回归，可单独 revert，不影响业务数据。

## 16. 成功度量

1. 科研模块**新实现**不再新增重复的 Tabs / Badge / Empty / Table 模式；
2. **新增**科研组件不得新增硬编码颜色；现存历史代码按模块逐步收敛，不要求一次性归零；
3. 核心页面视觉模式重复率下降；
4. 主要对象在列表 / 详情 / 审批 / Trace 中保持统一表达；
5. 主要列表页首屏有效信息行数不低于基线，且首屏信息不因堆叠而拥挤；
6. 关键页面视觉回归通过；
7. 业务行为、排序规则与权限回归通过。

## 17. 待确认事项

1. Phase 1 审计若发现 Plane 当前主题本身存在全局一致性问题，是否允许调整全局主题映射（默认不改，调整需单独评审并同步验收原生模块）；
2. `rich-filters` 接入范围是否覆盖报告、实验记录、外部引用三个列表，或首期先落地报告列表；
3. 审批中心是否需要在本次补充键盘批量处理（仅呈现层可实现，不改变 API）；
4. Storybook 用例补在 `@plane/propel` 还是 web 本地组件层，建议：通用组件进 propel，科研语义组件进 web 并复用现有测试体系。

## 18. 变更记录

| 版本 | 日期       | 变更                                                                                                                                                                                                                                                                                                             |
| ---- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| v1.0 | 2026-09-24 | 初版：完成现状审计、复用原则、视觉规范、组件需求、页面需求与实施计划。                                                                                                                                                                                                                                           |
| v1.1 | 2026-09-24 | 收敛执行口径：默认不修改全局主题 token；Typography 遵循 Plane type scale；不改变业务排序；新增 Object / Context / Action 模型与两类详情结构；引入 Golden Pages 门禁；组件抽象改为语义稳定优先；补充信息密度原则、缩略图验收与视觉回归截图；成功度量改为"不新增重复实现 / 新代码不硬编码"。                       |
| v1.2 | 2026-09-24 | 执行前防跑偏：App Shell 与基础 Page Shell 前置到 Golden Pages 之前；已有共享壳升级与新增语义组件提炼分离；Page Header 增加三种密度等级；Object / Context / Action 明确不要求全量首屏展示；新增视觉优先级决策表（每页最多一个 Primary）；动效遵循 Plane motion token；明确 Card 不是禁止项，禁止的是无语义 Card。 |

| v1.3 | 2026-09-24 | 实施完成：Phase 1–9 按第 13 章顺序分阶段提交；交付设计系统 / 信息架构审计、共享壳升级、三大黄金页面、`ResearchStatusBadge` / `ResearchTabLink` / 泛化 `ResearchListState` 语义组件、核心与扩散页面及全局复查；随 `4.10.0` 发布。 |
