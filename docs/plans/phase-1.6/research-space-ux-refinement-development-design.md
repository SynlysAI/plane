# Phase 1.6 主轴二：科研空间 UX 精炼开发设计

| 项目     | 内容                                                                                                                                |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| 文档版本 | v1.5                                                                                                                                |
| 状态     | 设计复核修订版；增加 Tower 式统一待办入口、范围切换和业务状态映射                                                                   |
| 日期     | 2026-10-10                                                                                                                          |
| 代码基线 | Plane `develop` / `4.24.0`                                                                                                          |
| 上游 PRD | [`research-intelligent-platform-phase-1.6-prd.md`](../../product/research-intelligent-platform-phase-1.6-prd.md)                    |
| 关联设计 | [逻辑厘清设计](research-space-boundary-development-design.md)、[代码精炼设计](research-space-code-refinement-development-design.md) |
| 视觉规范 | [Research Workspace UX 指南](../../product/research-workspace-ux-guide.md) 与 Academic Editorial UI                                 |

## 1. 设计结论

Phase 1.6 的 UX 是**现有 Plane UX 的事实收敛**，不是重画一套界面：

- 将科研总览并入首页，取消独立“科研总览”导航；首页采用项目概览 / 待办动态两列。
- 将左侧收敛为一列 250px Projects 侧栏，一级导航为首页、管理、审批中心、科研项目、行政项目五项。
- 将“科研项目”与“行政项目”分为两个无歧义通道：前者展示 Research Chain，后者复用普通 Plane Project 能力。
- 不改变 13 段 Workflow、课题详情四个 Tab、审批中心四个队列和旧路由兼容。
- 不新建独立角色页面；角色看板是首页和科研项目容器内的数据视图。
- 不重构编辑器；继续使用 `ReportBody` / `DocumentEditor` 和现有 Page 权威对象。
- 页面减法优先于新增组件；所有新增视觉必须能回退到现有 Propel / Research 语义组件。

## 2. 当前 UX 事实

### 2.1 信息架构

`packages/constants/src/research.ts` 中 IA v2 最多四个入口：

| 当前实现入口           | 当前路由                          | 说明                            |
| ---------------------- | --------------------------------- | ------------------------------- |
| 科研总览               | `/{workspace}/research`           | 跨课题工作台和待办索引          |
| 项目与课题（当前实现） | `/{workspace}/research/chains`    | 课题 / 项目 / 报告三个保存视图  |
| 审批中心               | `/{workspace}/research/approvals` | 阶段评审、报告审核、Agent、办公 |
| 科研管理               | `/{workspace}/research/settings`  | 组织、系统、模板、身份、配置等  |

关闭 `research_ia_v2` 时，旧一级导航和旧路由必须完整保留。`research-ia-v2-redirect` 负责旧路径到 IA v2 容器的兼容跳转。

以上是当前代码事实，不是 Phase 1.6 目标 IA。目标 IA 在 §3 和 §12 中定义；后续实现必须保留旧路由兼容与 IA v2 回退能力。

### 2.2 当前科研项目容器实现

`ResearchChainWorkbench` 当前只有三个可见视图：

1. 课题：`ResearchChainBoard`
2. 项目：`ResearchProjectList`
3. 报告：`ResearchReportList`

`outcomes` 是兼容 query，仍渲染报告组件中的报告 / 成果双视图。创建科研项目的主按钮只在课题或项目视图显示。

### 2.3 课题详情

`ResearchChainDetail` 当前固定：

- 上下文条：课题标题、状态、可见性、负责人、Project identifier、组织、更新时间、当前节点。
- `ResearchChainWorkflowRail`：固定 13 阶段。
- 四个 Tab：概览、节点、课题资料、成员。
- 节点 Tab：阶段节点、快照、Trace、生命周期操作、创建节点表单。
- 课题资料 Tab：知识上传、实验、成果、外部引用。
- 成员 Tab：课题 owner 和显式协作者。

### 2.4 待办事实

`collectResearchTodos` 当前聚合：

- 退回报告。
- 待我阶段评审。
- 待我办公审批。
- Agent 审批。
- RAG 上传失败 / 处理中 / 降级。
- RAGPortal 集成降级的人工提醒。

排序已按严重级别、截止时间和更新时间处理，但没有逾期倒计时，也没有节点任务和论文评审来源。

### 2.5 报告事实

`ReportBody` 已提供：

- Page 正文编辑。
- 图片直传和校验。
- Markdown 导入。
- 未保存状态保护。
- 保存失败保留本地内容。
- 提交后只读正式快照。

报告详情已有提交、退回、接受和历史记录，但没有服务端已读回执展示。

## 3. 页面级设计

### 3.1 首页两列工作台

首页复用现有 Workspace Home 路由，但界面固定为两列：

1. Header 显示首页、当前角色、刷新时间和统计周期。
2. 左列为项目概览：上方是科研项目，下方是行政项目。
3. 右列为待办动态：跨组件待办、最近动态、报告提交汇总。
4. 科研项目与行政项目概览不得混合成一个列表或同一组卡片。
5. 无科研身份或科研模块关闭时，科研项目概览显示中性空态，不影响行政项目概览。

**减法规则：**

- 不再渲染独立科研总览页面。
- 不渲染业务 / 管理快捷卡矩阵。
- 不渲染快捷入口、我的工作、草稿、便签等通用首页模块。
- 不重复显示科研项目、报告、审批的多个入口卡。
- `ResearchPiAggregateBoard` 的聚合指标并入科研项目概览，仅对具备 `dashboard` capability 的角色显示。

**旧入口兼容：**

- 旧 `/{workspace}/research` 总览入口重定向到 `/{workspace}/`。
- 关闭 IA v2 时保留旧导航和旧路由，不允许回退链路破裂。

**新增数据展示：**

- 待办条目显示责任对象、来源、截止日期、倒计时和下一步动作。
- 周报待办区分“待阅读”和“待审阅”。
- 任务待办来自 `ResearchChainNodeTask`。
- 论文评审待办来自 `ResearchPaperReview`。

### 3.2 科研项目容器

科研项目页只保留两个视图：

| 视图     | 目标路由 / query   | UX 调整                                               |
| -------- | ------------------ | ----------------------------------------------------- |
| 科研项目 | `/research/chains` | Research Chain 列表，增加当前节点 / 下一步 / 截止时间 |
| 报告     | `?view=reports`    | 保留报告 / 成果双视图，报告列表增加已读和待审阅状态   |

科研项目表格的新增列只来自后端聚合字段，不允许前端逐课题再请求全部节点造成 N+1。原 `?view=projects` 不再出现在科研项目页；行政 Project 由 §3.3 承载。

### 3.3 课题详情

**不改骨架：**

- 保留上下文条、Workflow Rail、四个 Tab、URL 回放参数 `tab/stage/node`。
- 保留现有节点生命周期按钮和 capability 拒绝原因。
- 保留 Agent 入口，但不新增一级导航。

**节点 Tab 增加“节点任务”区：**

- 位置：`ResearchChainWorkflowStageDetail` 的节点列表之后、快照与 Trace 之前。
- 展示：标题、责任人、状态、截止时间、下一步。
- 权限：仅 Chain writer / manager 显示创建和指派；reviewer 显示退回 / 完成；普通读者只读。
- 空态：“当前节点暂无任务”。

**课题资料 Tab：**

- 继续作为课题资料的聚合视图，不把行政 Project 事项混入。
- 论文修改评审入口放在课题资料或 `PAPER_WRITING` 节点详情中，不新增一级入口。

**成员 Tab：**

- 现有成员表保留。
- 新增指派候选人不等于自动加入成员；候选人接口由主轴一设计定义。

### 3.4 审批中心

保留四个 Tab 和权威组件：

| Tab        | 权威组件                             | 调整                       |
| ---------- | ------------------------------------ | -------------------------- |
| 阶段评审   | `ReviewInbox`                        | 只补队列摘要，不改评审表单 |
| 报告审核   | `ResearchReportList(variant=review)` | 增加“待阅读 / 待审阅”区分  |
| Agent 审批 | `ResearchAgentApprovalQueue`         | 保留现有队列               |
| 办公审批   | `ResearchApprovalList`               | 明确文案为行政 / 办公通道  |

禁止在审批中心再做一套嵌套侧栏或重复筛选器。每个 Tab 继续使用自身权威对象的能力和 ACL。

### 3.5 行政项目容器

行政项目页复用普通 Plane Project / Issue / View / Analytics / Archive 能力，只收敛入口和文案，不新建平行数据模型：

- 二级 Tab：项目 / 视图 / 分析 / 归档。
- 项目 Tab 只列不带科研主线语义的行政 Project。
- 视图、分析、归档继续使用现有普通 Plane 组件和路由。
- 创建入口文案为“创建行政项目”，不使用科研链字段。
- 行政 Project 不出现在科研项目列表的“当前节点”聚合中。
- 行政审批继续跳转审批中心 `office` Tab。

旧侧栏中的项目 / 视图 / 分析 / 归档四个独立入口不再显示；这些能力全部由行政项目页二级 Tab 承载。

## 4. 角色化看板

角色不作为新权限事实源，只从 `research.identity.research_level`、role context 和对象 capability 派生。

| 角色            | 首页 Primary                                       | 科研项目重点                       | 审批中心默认 Tab |
| --------------- | -------------------------------------------------- | ---------------------------------- | ---------------- |
| 学生            | 我的节点任务、待提交材料、待修改报告、论文修改待办 | 当前课题、当前节点、下一步         | 无默认评审队列   |
| 直接导师        | 待阅读周报、待评审材料、学生进展摘要               | 指导学生的课题和阻塞节点           | `report_review`  |
| 课题组主 PI     | 阻塞任务、评审进度、成员负载、逾期事项             | 课题组课题分布和成员负载           | `stage_review`   |
| Workspace Admin | 配置待处理、组织 / 成员异常、行政项目与审计        | 行政项目和配置，不默认显示科研评审 | `office`         |

实现要求：

- 不请求全工作区成员详情来判断角色；使用现有 identity。
- 无权限对象不得以“保密”卡片形式出现在角色看板。
- 角色切换仅存在于静态原型，生产界面不提供人工切换角色控件。

## 5. To-Do 与倒计时

### 5.1 类型扩展

在 `TResearchTodo` 上增加派生字段：

```ts
type TResearchTodoUrgency = "OVERDUE" | "DUE_TODAY" | "DUE_SOON" | "NORMAL";
```

规则：

- `OVERDUE`：`dueAt < now`。
- `DUE_TODAY`：今天内截止。
- `DUE_SOON`：72 小时内截止。
- `NORMAL`：其他或无截止时间。

倒计时文案：

- 逾期：`逾期 x 小时 / x 天`
- 今天：`今天 HH:mm`
- 72 小时内：`剩 x 小时 / x 天`
- 无截止：不显示倒计时。

### 5.2 视觉规则

- `OVERDUE` 使用 danger 文本和边框，不加背景渐变或发光。
- `DUE_TODAY` 可使用 danger 文本，不加新颜色。
- `DUE_SOON` 使用 secondary 文本。
- 每个视图最多一个主按钮；待办行的“处理”为链接，不抢占页面主操作。
- 状态层级先靠排版和间距，红色只作为紧急语义。

### 5.3 来源新增

| 来源           | 生成条件                                  | 目标路径                            |
| -------------- | ----------------------------------------- | ----------------------------------- |
| 节点任务       | 我是 assignee 且未完成                    | 课题详情 `tab=nodes&node={id}`      |
| 任务评审       | 我具备 review capability 且任务 SUBMITTED | 课题详情 `tab=nodes&node={id}`      |
| 周报待阅读     | 导师可见 SUBMITTED 周报且无回执           | 报告详情                            |
| 论文版本待评审 | Review WAITING_REVIEW 且我可评审          | 论文评审详情 / `PAPER_WRITING` 节点 |
| 论文修改       | Review NEEDS_REVISION 且我是 owner        | 论文评审详情                        |

### 5.4 统一待办入口

首页“待办与动态”和审批中心的待处理队列消费同一 `research-todo.v2` 投影。原型和后续实现都提供三个范围：`我可处理`、`我发起`、`全部可见`。每行固定展示：来源、标题/上下文、发起人、当前负责人、业务状态、统一处理状态、下一步、截止时间和“打开上下文”动作。

交互遵循 Tower 式任务处理节奏：先明确当前负责人，再打开业务对象处理；不在待办列表内复制正文编辑器或领域表单。对周报，待阅读是一个动作，接受/退回是另一个动作；对任务和论文，重新提交后原待办关闭并生成新的处理待办，使用稳定 `todo.id` 关联历史。

统一列表行的动作来源于服务端 `capabilities`：

| 统一动作 | 领域动作                                                        |
| -------- | --------------------------------------------------------------- |
| 查看     | 各对象 detail API                                               |
| 阅读     | 报告 read receipt                                               |
| 提交     | 节点任务 submit / 论文版本 submit / 报告 submit                 |
| 评审     | StageReview / PaperReview / Report review                       |
| 退回     | task return / report return / paper return / approval reject    |
| 完成     | task complete / report accept / paper accept / approval approve |

列表只负责导航和刷新。成功后重新拉取投影；冲突时保留原行并显示“状态已变化，请刷新”，不在前端自行推进状态。

### 5.5 分类导航交互

生产侧栏复用现有 `ResearchSidebarItems` 和 Plane `SidebarNavItem`，在科研项目与行政项目入口下渲染独立 `ResearchProjectTree`。树节点包含入口、分类、子分类、项目和“未分类”区域；每个入口与分类节点使用独立 Disclosure 状态，状态保存于当前用户浏览器的导航偏好键。

科研项目分类树消费 `RESEARCH` scope：组织组别来自真实 `ResearchProjectProfile.org_unit`/组织 API，自定义分类来自导航 API；行政项目树只消费 `ADMINISTRATIVE` scope。树只渲染 API 返回的有权项目，项目链接继续指向现有科研 Chain 或普通 Project 详情。

分类菜单按 capability 显示新建子分类、重命名、排序、移动和删除。删除动作必须打开迁移目标确认；无目标时展示服务端 `navigation_category_not_empty`，不隐藏项目。侧栏容器设置最大高度和内部滚动，长名称截断，展开按钮与项目链接可键盘访问。

## 6. 编辑器与通知

### 6.1 编辑器

保留 `ReportBody` 和 `DocumentEditor`，只做状态与文案收敛：

- 工具栏固定显示：保存状态、上传状态、Markdown 导入、插入图片。
- 本地未保存时不跳转，继续使用现有路由拦截能力。
- Markdown 导入前显示结构保留说明；失败时保留原正文。
- 正式版本只读时显示版本号，不提供编辑按钮。

### 6.2 通知

使用现有 `Notification` 管线，不新建通知渠道：

- 任务指派通知 assignee。
- 任务提交通知具备 review capability 的对象负责人。
- 周报提交通知导师；导师已读不自动通知作者，状态可在详情查看。
- 论文版本提交通知导师和 final reviewer。
- 退回通知作者；最终确认通知作者和课题 owner。

通知目标必须直达上下文，不允许只落到列表首页。

### 6.3 两套指派下拉的交互合同

科研节点任务和行政项目负责人必须使用不同的数据源与分组文案：

| 场景                            | 数据源                                        | 下拉分组             | 不允许                               |
| ------------------------------- | --------------------------------------------- | -------------------- | ------------------------------------ |
| 科研节点任务                    | `GET .../chains/{chain_id}/assignable-users/` | 组织范围、显式协作者 | 全工作区搜索、把候选人自动加入课题   |
| 行政项目负责人 / Issue assignee | 当前 Project 有效 `ProjectMember`             | 项目成员             | 使用科研组织树候选、把审批人当负责人 |

两个组件都必须支持 loading、空结果、服务端拒绝和保存中状态；搜索只能过滤已经返回的候选集合。科研下拉显示组织和科研身份，行政下拉显示项目角色。用户切换候选人后，页面应保留“候选范围来自……”的辅助说明；选择本身不改变成员关系。

## 7. 组件设计

新增组件尽量少：

| 组件                       | 位置             | 职责                                       |
| -------------------------- | ---------------- | ------------------------------------------ |
| `ResearchTodoUrgency`      | research/common  | 纯展示倒计时和紧急状态                     |
| `ResearchChainTaskPanel`   | research/chains  | 节点任务列表、创建、指派、提交、退回、完成 |
| `ResearchPaperReviewPanel` | research/chains  | 论文版本、修改说明、评论串和最终确认       |
| `ResearchReportReadState`  | research/reports | 已读回执和待阅读状态                       |
| `ResearchAssigneeSelect`   | research/common  | 消费 assignable-users API，不提供全库搜索  |
| `ResearchTodoEnvelopeList` | research/common  | 统一待办范围、来源、负责人、状态和动作入口 |

必须复用：

- `ResearchPageShell`
- `ResearchDataSurface`
- `ResearchListState`
- `ResearchStatusBadge`
- `ResearchTabLink`
- `ResearchChainWorkflowRail`
- `ResearchChainWorkflowStageDetail`
- `BrowseFilters` / `useResearchBrowseQuery`

禁止为了 Phase 1.6 新增彩色卡片、统计卡矩阵、装饰图标、AI badge 或第二套表格样式。

## 8. 状态与无障碍

每个新增区域必须覆盖：

| 状态      | 表现                                              |
| --------- | ------------------------------------------------- |
| loading   | Skeleton 或现有加载文案，禁止长时间空白           |
| empty     | 说明当前范围没有任务 / 评审，不给用户制造权限误解 |
| forbidden | 中性权限说明，不泄露无权限对象标题和数量          |
| degraded  | Agent / RAG 不可用时保留人工路径                  |
| saving    | 按钮 pending，重复提交禁用                        |
| conflict  | 状态已变化时提供刷新，不覆盖他人结果              |
| error     | 中文说明和重试，不显示原始 error key              |

无底线要求：

- Tab 使用现有 `ResearchTabLink` / ARIA 语义。
- 状态变化区域使用 `aria-live="polite"`。
- 操作按钮在请求中保留 disabled / loading。
- 1440px、1280px、390px 不出现页面级横向滚动；表格允许内部滚动。
- 键盘焦点可见，Escape 关闭抽屉 / 对话框，焦点返回触发器。
- 色彩不是唯一信息载体，紧急状态同时有文字“逾期 / 今天截止”。

## 9. HTML 原型映射

静态原型必须按本设计和主轴一设计更新：

1. 外框使用顶部导航 + 单列 Projects 侧栏；不渲染 App rail。
2. 首页显示项目概览 / 待办动态两列，不显示通用首页 Widget。
3. 科研项目页显示科研项目 / 报告两个视图，不显示行政 Project。
4. 行政项目页显示项目 / 视图 / 分析 / 归档四个视图，不显示 Research Chain。
5. 课题详情显示 13 段 Workflow 和四个 Tab。
6. 节点任务区显示 `DRAFT/ASSIGNED/SUBMITTED/NEEDS_REVISION/COMPLETED/CANCELLED`。
7. 周报区显示“待阅读”和“待审阅”分离，以及服务端已读回执。
8. 论文区显示版本、修改说明、评论、退回和最终确认。
9. 原型继续标注“非功能实现”，不伪造真实系统成功状态。

## 10. 实现切片

### U0：设计基线测试

- 更新首页、导航、科研项目、行政项目和待办组件测试的期望文案。
- 固定目标 IA、旧路由兼容和 IA v2 回退断言。
- 固定单列侧栏、父级可点项目和二级项目树的导航断言。

### U1：首页两列工作台

- 把科研总览组件并入 Workspace Home。
- 旧 `/research` 入口兼容重定向到首页。
- 移除业务 / 管理快捷卡矩阵。
- 移除快捷入口、我的工作、草稿、便签等通用首页模块。
- 增加待办紧急程度纯函数测试。

### U2：待办升级

- `collectResearchTodos` 接入主轴一新来源。
- 增加 `ResearchTodoUrgency`。
- 更新首页摘要卡和总览待办索引。

### U3：课题列表摘要

- 消费 `open_task_count/next_due_at/current_node`。
- 科研项目页收敛为科研项目 / 报告两个视图。
- 增加列和窄屏元信息，不做前端 N+1 请求。

### U4：课题详情任务面板

- 接入任务 API 和候选人 API。
- 保持 URL `tab/stage/node` 回放。
- 覆盖角色和权限状态。

### U5：周报已读与报告审核

- 报告详情自动上报服务端已读。
- 列表和审批中心展示待阅读 / 待审阅。

### U6：论文评审面板

- 接入版本上传和评审动作。
- 评论串读取 Chain Event。
- 不改变 Outcome 登记流程。

### U7：行政通道文案

- 新增行政项目容器，承载项目 / 视图 / 分析 / 归档。
- 侧栏移除项目 / 视图 / 分析 / 归档独立入口。
- 行政审批链接直达 office Tab。

### U8：行政项目容器

- 复用普通 Plane Project、View、Analytics、Archive 路由与组件。
- 项目列表过滤掉科研主线语义对象，避免双列表重复。
- 不新建行政数据模型或平行权限系统。

## 11. 验收

- 左侧只有一列 Projects 侧栏，一级导航只有首页、管理、审批中心、科研项目、行政项目五个入口；关闭 IA v2 后旧路由完整。
- “首页”在左侧只出现一次且只有一个可点击入口。
- 首页两列能分别回答“项目处于什么状态”和“我现在要处理什么、何时截止、去哪里处理”。
- 科研项目页只出现 Research Chain 和报告；行政项目页只出现行政 Project 和普通 Plane 能力。
- 课题详情不改变 13 段 Workflow 和四个 Tab，任务区只挂在节点详情内。
- 学生、导师、主 PI、管理员看到的操作均由 capability 和 ACL 控制。
- 待办排序、倒计时和紧急颜色符合规则。
- 周报已读与审阅结论分离。
- 论文修改评审能回放版本、评论和最终确认。
- 1440px / 1280px / 390px 和键盘路径可用。
- 静态原型与上述信息架构一致，且不出现未实现功能伪装。

## 12. 产品界面合同附录

本节是静态原型和后续前端实现的界面级合同。若 §9 与本节冲突，以本节为准：原型不再是概念介绍页，而是复刻 Plane 信息架构的产品界面。

### 12.1 真实应用外框

当前代码事实：

- `WorkspaceContentWrapper` 渲染 `TopNavigationRoot` 与可选 App rail。
- `(projects)/layout.tsx` 渲染 `ProjectAppSidebar + ExtendedProjectSidebar + main`。
- `ProjectAppSidebar` 默认 250px。
- `main` 是 `rounded-lg border border-subtle bg-surface-1`。
- `ResearchPageShell` 的 Header 是 22px 标题 + 13px 描述 + 12px 元信息。

Phase 1.6 目标外框隐藏 App rail，仅保留 `TopNavigationRoot + 250px Projects sidebar + main`。本轮只改变静态原型的信息架构合同，不修改真实应用代码。

目标界面外框：

```text
┌──────────────────────────────────────────────────────────────┐
│ Top navigation · 40px                                        │
├──────────────┬───────────────────────────────────────────────┤
│ Project      │ Main surface                                  │
│ sidebar      │ ┌──────────────────────────────────────────┐ │
│ 250px        │ │ Research header 96–106px                │ │
│              │ ├──────────────────────────────────────────┤ │
│              │ │ Secondary tabs 40px                      │ │
│              │ ├──────────────────────────────────────────┤ │
│              │ │ Scroll content                           │ │
│              │ │                                          │ │
│              │ └──────────────────────────────────────────┘ │
└──────────────┴───────────────────────────────────────────────┘
```

Phase 1.6 目标侧栏：

```text
Projects
搜索
首页
管理
审批中心
科研项目
  分子界面稳定性研究
  催化剂界面失活机理研究
行政项目
  设备采购协作
  报销与用章流程
```

首页、管理、审批中心、科研项目、行政项目为一级入口；科研项目与行政项目下的具体项目为二级入口。父级“科研项目 / 行政项目”本身可点击进入对应工作台，二级项目仅在下方缩进显示，不形成第二列。视图、分析、归档不再作为侧栏独立入口，由行政项目页二级 Tab 承载。

侧栏交互规则：

- `管理` 进入 `/{workspace}/research/settings`，页面标题显示“管理”。
- `科研项目` 父级进入科研项目页，默认激活“科研项目”Tab。
- `行政项目` 父级进入行政项目页，默认激活“项目”Tab。
- 二级科研项目进入科研项目详情，标题与面包屑随点击项目变化。
- 二级行政项目复用行政项目页“项目”Tab，本轮不新增行政详情页。
- 科研项目详情和报告详情高亮“科研项目”父级；行政项目页高亮“行政项目”父级和被点击的二级项目。

### 12.2 页面一：首页

路由：`/{workspace}/`

```text
Workspace Home
├─ Header
│  ├─ 首页
│  ├─ 日期 / 当前角色 / 刷新时间 / 统计周期
│  └─ 操作：刷新
└─ Two-column grid
   ├─ 项目概览列
   │  ├─ 科研项目概览
   │  │  ├─ 当前科研项目 / 当前节点 / 下一步
   │  │  ├─ 阻塞、待评审、本周到期聚合
   │  │  └─ 全部科研项目 / 打开当前项目
   │  └─ 行政项目概览
   │     ├─ 当前行政项目 / 当前环节 / 下一步
   │     ├─ 进行中、待审批、逾期聚合
   │     └─ 全部行政项目 / 打开当前项目
   └─ 待办动态列
      ├─ 跨组件待办
      │  ├─ 责任对象、来源、截止时间、倒计时、处理入口
      │  └─ 逾期 / 今天截止使用克制红色
      ├─ 最近动态：科研与行政项目活动
      └─ 报告提交汇总：应提交 / 已提交 / 待阅读 / 待审阅
```

数据来源：

- `ResearchTodoIndex / collectResearchTodos`
- `ResearchChainService.getChains`
- `ResearchReportService.getSummary`
- `ResearchPiAggregateBoard`
- 行政项目列表聚合接口

减法：

- 不渲染 `BUSINESS_CARDS`。
- 不渲染 `SETTINGS_CARDS`。
- 不渲染 quick links、my work、drafts、stickies 等 Home widgets。
- 不再提供独立科研总览页面。
- 无科研身份或模块关闭时，不渲染科研区块。

空态：

- 无待办：`当前权限范围内暂无待处理事项。`
- 无科研项目：`暂可见科研项目；创建科研项目前请先确认组织归属。`
- 汇总失败：`报告汇总暂不可用，可刷新或直接进入报告视图。`

### 12.3 页面二：科研项目

路由：`/{workspace}/research/chains`

```text
ResearchPageShell
├─ Header
│  ├─ 科研项目
│  └─ 描述：Research Chain 承载科研主线、节点任务、报告与评审
└─ Workbench
   ├─ Tabs：科研项目 / 报告
   ├─ Filter toolbar
   │  ├─ 范围
   │  ├─ 责任人
   │  ├─ 关键词
   │  ├─ 日期
   │  ├─ 状态 / 类型 / 课题组
   │  └─ 刷新
   └─ Table
      ├─ 科研项目
      ├─ 负责人
      ├─ 课题组
      ├─ 当前节点
      ├─ 下一步
      ├─ 截止时间
      ├─ 状态
      ├─ 更新时间
      └─ 操作
```

行规范：

- 科研项目名 13px medium。
- 当前节点显示节点中文名和状态 badge。
- 下一步最多 24 个字符，超出省略。
- 截止时间显示日期；逾期或今天截止时附倒计时。
- 行 hover 使用 `bg-surface-2`。
- 行点击进入课题详情；操作按钮阻止行点击冒泡。
- 行政 Project 不得出现在该页。

报告视图：

- 列：报告名称、提交人、课题组、状态、已读状态、审核状态、提交时间、操作。
- 已读与审核分离。
- 空态：`暂无报告。`

科研项目空态：`暂无科研项目。`

### 12.4 页面三：行政项目

路由：

- 项目：`/{workspace}/projects`
- 视图：`/{workspace}/workspace-views/all-issues/`
- 分析：`/{workspace}/analytics/`
- 归档：`/{workspace}/projects/archives/`

```text
Workspace container
├─ Header
│  ├─ 行政项目
│  ├─ 描述：采购、报销、设备协作、办公审批与普通 Plane 协作
│  └─ 主操作：创建行政项目
└─ Tabs
   ├─ 项目
   │  ├─ 行政项目 / 类型 / 负责人 / 当前环节 / 截止 / 状态 / 更新时间 / 操作
   │  └─ 不显示 Research Chain
   ├─ 视图
   │  ├─ 视图名称 / 适用范围 / 创建人 / 更新时间 / 操作
   │  └─ 复用现有 workspace views
   ├─ 分析
   │  ├─ 时间范围与项目筛选
   │  ├─ 待处理、完成、成员参与、逾期摘要
   │  └─ 复用现有 analytics
   └─ 归档
      ├─ 已归档项目 / 事项 / 归档时间 / 负责人 / 恢复操作
      └─ 复用现有 archives
```

实现要求：

- 不新建行政项目数据模型。
- 不把行政 Project 显示为科研链节点。
- 科研主线关联的内部权威 Project 不在行政列表重复展示。
- 侧栏项目 / 视图 / 分析 / 归档四个独立入口移除，但旧路由继续可访问。

### 12.5 页面四：科研项目详情

路由：`/{workspace}/research/chains/{chainId}?tab=nodes&stage={stage}&node={nodeId}`

```text
ResearchPageShell
├─ Breadcrumb：科研项目 / 分子界面稳定性研究
├─ Object header
│  ├─ 科研项目名
│  ├─ 状态 / 可见性 badge
│  ├─ 负责人 · Project identifier · 课题组 · 更新时间
│  └─ 操作：打开 Agent / 归档或恢复
├─ 当前节点条
│  ├─ 当前节点名
│  ├─ 状态
│  ├─ 责任人
│  └─ 下一步
├─ Workflow rail：13 阶段
└─ Tabs：概览 / 节点 / 课题资料 / 成员
```

节点 Tab：

```text
├─ Stage node list
├─ Selected node detail
│  ├─ 输入 / AI 动作 / 中间产物 / 验证 / 人类决策 / 输出
│  ├─ Snapshots
│  ├─ Trace timeline
│  └─ Lifecycle action bar
├─ Node task panel
│  ├─ 任务表
│  ├─ 创建 / 指派
│  └─ 提交 / 退回 / 完成 / 取消
└─ Paper review panel（仅 PAPER_WRITING）
   ├─ 版本列表
   ├─ 修改说明
   ├─ 评论串
   ├─ 上传新版本
   └─ 退回 / 最终确认
```

Workflow 状态：

- completed：中性背景 + check。
- current：accent 边框 + `aria-current="step"`。
- attention：warning 文案，不新增强色卡片。
- upcoming / not started：弱化文字。
- 点击 rail 只切换查看态，不改变业务当前节点。

节点任务表列：

| 列     | 展示                                                          |
| ------ | ------------------------------------------------------------- |
| 任务   | 标题 + 指派人                                                 |
| 状态   | `DRAFT/ASSIGNED/SUBMITTED/NEEDS_REVISION/COMPLETED/CANCELLED` |
| 责任人 | 显示名                                                        |
| 截止   | 日期 + urgency                                                |
| 下一步 | 动作按钮或只读说明                                            |

生命周期操作必须保留现有 reason 规则：

- `FAIL/RETURN` 必填原因。
- 按钮 pending 时禁用重复提交。
- capability 拒绝原因显示在操作条下方，不弹额外 toast。

### 12.6 页面五：周报详情

路由：`/{workspace}/research/reports/{reportId}`

```text
ResearchPageShell
├─ Breadcrumb：科研项目 / 报告 / 第 41 周周报
├─ Object header
│  ├─ 第 41 周周报
│  ├─ 状态：SUBMITTED
│  ├─ 已读状态：导师已读 · 待审阅
│  ├─ 作者 / 组织 / 周期 / 正式版本
│  └─ 操作：接受 / 退回 / 打开正式版本
├─ Report body
│  ├─ 编辑器
│  ├─ 保存状态
│  ├─ Markdown 导入
│  ├─ 插入图片
│  └─ 只读正式版本提示
├─ 附件
├─ 可见性
└─ History（默认折叠）
```

已读状态规则：

| 状态                | 文案                | 语义                  |
| ------------------- | ------------------- | --------------------- |
| waiting_read        | `待导师阅读`        | 已提交且无导师回执    |
| read_pending_review | `导师已读 · 待审阅` | 有回执但未接受 / 退回 |
| reviewed            | `已审阅`            | 已接受或退回          |

作者可见：

- 导师已读汇总，不显示无关读者。
- 已读时间精确到分钟。

导师进入详情：

- 正式版本加载成功后自动 `POST /read/`。
- 请求失败不打断阅读。
- 刷新后不重复生成记录。

### 12.7 页面六：审批中心

路由：`/{workspace}/research/approvals?tab=stage_review|report_review|agent_approval|office`

```text
ResearchPageShell
├─ Header：审批中心
└─ Tabs
   ├─ 阶段评审
   ├─ 报告审核
   ├─ Agent 审批
   └─ 办公审批
```

统一队列列：

| 列       | 展示                                |
| -------- | ----------------------------------- |
| 标题     | 材料 / 报告 / Agent / 行政事项名    |
| 类型     | 阶段评审、报告审核、Agent、办公审批 |
| 提交人   | 显示名                              |
| 当前环节 | 节点 / 报告状态 / 审批步骤          |
| 截止     | 日期 + urgency                      |
| 状态     | 待阅读、待审阅、待确认、待审批      |
| 操作     | 打开上下文                          |

报告审核额外规则：

- `waiting_read` 排在 `read_pending_review` 之前。
- 已读但未审阅的行显示“已读 · 待审阅”。
- 点击行直达报告详情，不打开抽象审批页。

办公审批：

- 队列组件继续使用 `ResearchApprovalList`。
- 文案固定为“行政 / 办公审批”。
- 不显示科研节点状态。

### 12.8 页面七：管理

路由：`/{workspace}/research/settings/{tab}`

```text
ResearchPageShell
├─ Header：管理（原科研管理）
└─ Management tabs
   ├─ 组织与人员
   ├─ 系统
   ├─ 模板
   ├─ 身份映射
   ├─ 平台配置
   └─ 审计记录
```

Phase 1.6 只调整层级和文案：

- 组织与人员：组织树摘要、成员表、组织角色、主归属、有效期、编辑操作。
- 系统：科研模块开关、功能状态、邀请码、成员导入。
- 模板：报告模板、节点模板、适用范围、版本、状态。
- 身份映射：用户、科研身份、组织、导师 / PI 关系、同步状态。
- 平台配置：Agent 配置入口、通知配置、存储配置、集成状态、上传限制。
- 审计记录：时间、操作者、对象、动作、结果、Trace ID，默认倒序。
- 不新增管理一级入口。
- 表格密度与科研项目 / 报告列表一致。

### 12.9 组件级 Props 合同

#### `WorkspaceResearchOverviewSection`

```ts
type Props = {
  workspaceSlug: string;
  period: "30" | "90" | "all";
  loading: boolean;
  error: boolean;
  onRetry: () => void;
};
```

渲染规则：

- 无科研身份或模块关闭时返回 `null`，不渲染空科研区块。
- 项目概览列固定为上科研项目、下行政项目。
- 待办动态列固定为跨组件待办、最近动态、报告提交汇总。
- 当前上下文卡片随 identity / capability 派生，不做角色硬编码。
- 汇总失败只影响汇总卡片，不阻断另一列。
- 不渲染快捷入口、我的工作、草稿、便签等通用首页模块。

#### `AdministrativeProjectTabs`

```ts
type Props = {
  workspaceSlug: string;
  activeTab: "projects" | "views" | "analytics" | "archives";
};
```

渲染规则：

- 项目 Tab 复用普通 Project 列表能力，并排除科研主线语义对象，避免双列表重复。
- 视图、分析、归档 Tab 只做普通 Plane 能力的容器包装，不复制数据逻辑。
- 侧栏不再注册项目 / 视图 / 分析 / 归档独立入口。
- 旧深链继续可访问，Tab 状态写入 URL。

#### `ResearchChainTaskPanel`

```ts
type Props = {
  workspaceSlug: string;
  chainId: string;
  node: TResearchChainNode;
  tasks: TResearchChainTask[];
  loading: boolean;
  error: boolean;
  canCreate: boolean;
  onCreate: (payload: TResearchChainTaskCreatePayload) => Promise<void>;
  onAction: (taskId: string, action: "submit" | "return" | "complete" | "cancel") => Promise<void>;
  onRetry: () => void;
};
```

渲染规则：

- `loading && tasks.length === 0`：3 行 skeleton。
- `error`：错误区 + 重试。
- 无任务：`当前节点暂无任务`。
- 有任务但加载更多失败：保留旧数据 + 顶部错误提示。
- 操作按钮由 capability 控制，不根据角色硬编码。

#### `ResearchPaperReviewPanel`

```ts
type Props = {
  workspaceSlug: string;
  chainId: string;
  node: TResearchChainNode;
  review: TResearchPaperReview | null;
  versions: TResearchPaperReviewVersion[];
  events: TResearchChainEvent[];
  loading: boolean;
  error: boolean;
  onUpload: (payload: TResearchPaperVersionCreatePayload) => Promise<void>;
  onReturn: (versionNo: number, comment: string) => Promise<void>;
  onAccept: (versionNo: number, comment: string) => Promise<void>;
  onRetry: () => void;
};
```

渲染规则：

- 无 review：显示 `论文写作节点可开启修改评审` 和一个主按钮。
- 版本列表按 `version_no` 倒序。
- 当前版本置顶，历史版本弱化。
- 评论串读取 `COMMUNICATION` 事件。
- 退回原因和最终确认从 `HUMAN_DECISION / PAPER_REVIEW_*` 事件读取。

#### `ResearchReportReadState`

```ts
type Props = {
  status: "waiting_read" | "read_pending_review" | "reviewed";
  readAt: string | null;
  snapshotVersion: number | null;
};
```

- 不用图标堆叠。
- 状态 + 时间 + 版本号放在同一元信息行。
- 无权限时不渲染，不显示“保密”。

#### `ResearchTodoUrgency`

```ts
type Props = {
  dueAt: string | null;
  now?: string;
};
```

返回：

```ts
{
  urgency: "OVERDUE" | "DUE_TODAY" | "DUE_SOON" | "NORMAL";
  label: string;
}
```

#### `ResearchAssigneeSelect`

```ts
type Props = {
  workspaceSlug: string;
  chainId: string;
  value: string | null;
  onChange: (userId: string | null) => void;
  disabled?: boolean;
};
```

- 数据源：assignable-users。
- 搜索仅过滤已返回候选，不请求全工作区。
- 空结果显示：`当前课题无可指派用户`。
- 分组显示 `组织范围` 与 `显式协作者`。

行政项目使用独立的 `AdministrativeAssigneeSelect` 合同：

```ts
type Props = {
  workspaceSlug: string;
  projectId: string;
  value: string | null;
  onChange: (userId: string | null) => void;
  disabled?: boolean;
};
```

数据源是当前 Project 有效成员列表，不调用科研 `assignable-users`。无候选人时显示“当前行政项目暂无可指派成员”，服务端拒绝时保留原选择并提供刷新动作。

### 12.10 i18n key 清单

新增 zh-CN key：

```text
research.tasks.title
research.tasks.description
research.tasks.empty
research.tasks.create
research.tasks.assignee
research.tasks.due_at
research.tasks.next_action
research.tasks.status.draft
research.tasks.status.assigned
research.tasks.status.submitted
research.tasks.status.needs_revision
research.tasks.status.completed
research.tasks.status.cancelled
research.tasks.action.submit
research.tasks.action.return
research.tasks.action.complete
research.tasks.action.cancel
research.tasks.assignee_scope
research.tasks.explicit_collaborator

research.reports.read.waiting
research.reports.read.pending_review
research.reports.read.reviewed
research.reports.read.at
research.reports.read.version

research.paper_review.title
research.paper_review.empty
research.paper_review.version
research.paper_review.change_summary
research.paper_review.upload
research.paper_review.return
research.paper_review.accept
research.paper_review.withdraw
research.paper_review.final_reviewer
research.paper_review.history

research.assignment.scope_research
research.assignment.scope_administrative
research.assignment.empty_research
research.assignment.empty_administrative
research.assignment.permission_denied
research.assignment.saving

research.editor.markdown_import_help
research.editor.unsaved_changes
research.editor.readonly_version
research.drift_detection.draft_only

research.todo.urgency.overdue
research.todo.urgency.today
research.todo.urgency.soon
research.todo.urgency.normal
research.todo.scope.to_me
research.todo.scope.mine
research.todo.scope.visible
research.todo.requester
research.todo.assignees
research.todo.business_status
research.todo.handling_status
research.todo.next_action
research.todo.source.chain_task
research.todo.source.paper_review
research.todo.source.stage_review
research.todo.source.agent_approval
research.todo.source.office_approval
research.todo.action.read
research.todo.action.submit
research.todo.action.review
research.todo.action.return
research.todo.action.complete
research.todo.conflict

workspace.nav.research_projects
workspace.nav.administrative_projects
workspace.nav.approval_center
workspace.nav.management
workspace.home.research_overview
workspace.home.current_context
workspace.home.report_summary
workspace.home.recent_activity
administrative.projects.title
administrative.projects.description
administrative.projects.create
administrative.projects.empty
administrative.views.title
administrative.analytics.title
administrative.archives.title
```

文案规则：

- “课题”只指 Research Chain 主线。
- “科研项目”在产品展示中指 Research Chain 主线；其关联的带 `ResearchProjectProfile` Project 仅是内部权威关系，不在行政项目列表重复展示。
- 行政事务统一叫“行政项目”或“办公审批”。
- 不使用“智能”“AI 加持”“自动完成”类营销词。

### 12.11 响应式合同

| 宽度  | 外框                    | 内容                                             |
| ----- | ----------------------- | ------------------------------------------------ |
| ≥1440 | 250px sidebar           | 首页两列，课题 / 管理页双栏信息密度              |
| 1280  | 250px sidebar           | 首页两列，课题表格完整，Trace 双栏               |
| 1024  | 250px sidebar           | 首页保持两列，课题表格内部滚动，节点详情纵向堆叠 |
| 768   | 保留窄侧栏或抽屉        | 首页回落单列，二级 Tab 横向滚动                  |
| 390   | 顶栏菜单按钮 + 侧栏抽屉 | 单列，表格内部横向滚动，Workflow 可横向滚动      |

禁止：

- `document.documentElement.scrollWidth > clientWidth`。
- 表格撑破页面。
- 侧栏压缩到不可读。
- 用缩放Transform 冒充响应式。

### 12.12 状态与可访问性验收

每个新增面板必须有以下状态测试：

| 状态      | DOM                                  |
| --------- | ------------------------------------ |
| loading   | `role="status"` + `aria-busy="true"` |
| empty     | 明确说明当前范围                     |
| forbidden | 中性权限说明，不泄露对象标题         |
| degraded  | 保留人工路径                         |
| saving    | 按钮 disabled + loading 文案         |
| conflict  | 提供刷新                             |
| error     | `role="alert"` + 中文恢复路径        |

键盘路径：

1. 侧栏 → 页面 Tab → 面板操作。
2. 表格行 Enter 打开课题。
3. 任务操作按钮可 Tab 到达。
4. Escape 关闭创建对话框并返回触发按钮。
5. Workflow rail 节点可用 Enter 选择查看态。

焦点：

- 全局使用可见 focus ring。
- 当前页面 / Tab 使用 `aria-current`。
- 异步状态更新区使用 `aria-live="polite"`。
- 颜色不是唯一信息载体。
