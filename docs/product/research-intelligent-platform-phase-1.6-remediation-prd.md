# 科研智能体平台 Phase 1.6 修复 PRD：统一待办、降级隔离与指派边界

| 项目     | 内容                                                                                 |
| -------- | ------------------------------------------------------------------------------------ |
| 文档版本 | v1.1                                                                                 |
| 文档状态 | 已交付；实现、测试与浏览器验证完成                                                   |
| 日期     | 2026-10-11                                                                           |
| 代码基线 | Plane `develop` / `4.26.0`                                                           |
| 上游 PRD | [Phase 1.6 科研空间重构 PRD](research-intelligent-platform-phase-1.6-prd.md)         |
| 审查依据 | `26959ab7c6ed8dddbb395ac9f1b1b6a487defae5..48543cbdbc74ec2b17b372466e8d7fefb72552f1` |
| 适用团队 | 产品、UX、Web、API、测试、发布与科研运营                                             |

## 1. 文档目的

本文件定义 Phase 1.6 发布复核中发现的问题及其修复方案。修复目标是让产品承诺、真实应用、服务端投影、静态原型和验收证据使用同一套规则。

本文件解决四项问题：

1. 首页和审批中心没有真正共享 `research-todo.v2`，且生产界面缺少“我可处理 / 我发起 / 全部可见”范围切换。
2. 统一待办聚合只隔离 Agent 来源异常，其他来源异常会使整个接口失败，违反单源降级承诺。
3. 实施复核版设计文档仍保留 `research-todo-summary.v1`、上传待办和 `target` 旧契约，和当前 `research-todo.v2` 实现冲突。
4. HTML 原型的角色切换没有同步指派候选人和可操作提示，无法准确表达科研与行政两套指派边界。

修复完成前，Phase 1.6 只能标记为“核心领域能力已实现，统一待办与原型边界待修复”，不得标记为完整交付。

## 2. 审查结论与用户影响

### 2.1 P1：统一待办未形成统一入口

产品合同要求首页和审批中心都消费同一份 `research-todo.v2` 投影，并使用相同的 `todo.id`、状态映射、负责人和动作能力。当前 `ResearchTodoEnvelopeList` 只在首页使用，审批中心仍分别加载阶段评审、报告审核、Agent 审批和办公审批旧队列。

影响：

- 用户在首页看到的事项可能和审批中心重复、缺失或状态不一致。
- “我发起”和“全部可见”不能在生产界面使用，只存在于 API 和静态原型。
- 统一待办无法成为研究者每天的单一工作入口。
- 后续通知、统计和审计无法引用唯一的待办身份。

### 2.2 P1：聚合接口不能按来源降级

服务端 `collect_research_todos` 当前只有 Agent collector 被单独捕获。报告、节点任务、论文评审、阶段评审或办公审批任一 collector 抛出异常时，接口整体失败。

影响：

- 某一领域故障会隐藏其他领域的待办。
- 截止时间紧迫的事项可能因无关来源故障而不可见。
- 前端只能显示“科研待办暂时不可用”，无法告诉用户哪些来源降级。
- 运营无法根据 `degraded_sources` 判断真实故障范围。

### 2.3 P1：文档契约与代码契约分裂

旧设计蓝图仍使用 `research-todo-summary.v1`，示例包含 `upload:*`、`kind` 和 `target`，而当前代码返回 `research-todo.v2`，来源固定为六类领域对象，路由字段为 `href`，不包含上传来源。

影响：

- API 集成者可能按错误字段开发。
- 测试人员无法判断应该验证 v1 还是 v2。
- 发布文档声称“已实施”，但实施细节仍引用已废弃方案。
- 设计、代码和验收无法形成可追溯链路。

### 2.4 P2：原型没有表达角色化指派边界

原型的科研候选人和行政候选人写死在 HTML 中，角色切换只改变首页指标和待办示例，不改变表单候选集合、禁用状态或提示文案。

影响：

- 用户可能误认为所有角色都可以指派科研任务和行政负责人。
- 无法验证下级组织、Guest、未加入项目的管理员是否被排除。
- 原型无法作为真实应用的权限边界验收依据。

## 3. 产品目标

### 3.1 目标

| 目标                           | 可验证结果                                                                                     |
| ------------------------------ | ---------------------------------------------------------------------------------------------- |
| 统一待办成为唯一跨领域处理入口 | 首页与审批中心调用同一 `ResearchTodoEnvelopeList`，相同事项的 `id`、状态和动作一致             |
| 范围语义可用                   | 两个入口均支持 `to_me`、`mine`、`visible`，且由服务端 ACL 和 capability 决定结果               |
| 单源故障不阻断其他来源         | 任一 collector 异常只加入 `degraded_sources`，其他来源照常返回；只有聚合基础故障才返回整体错误 |
| 契约唯一且可追溯               | 所有当前设计、类型、测试和原型只引用 `research-todo.v2`；旧 v1 仅在历史变更记录中保留          |
| 原型准确表达指派边界           | 四类角色切换后，候选人、按钮、禁用态和说明同步变化；科研与行政候选来源始终分离                 |
| 保持领域权威边界               | 待办仍为只读投影；动作继续调用任务、报告、评审和审批领域 API，不新增统一业务状态机             |

### 3.2 非目标

- 不新建跨领域的统一任务表。
- 不把审批人改造成普通负责人。
- 不改变 `ResearchChain`、`Project`、`PeriodicReport`、`ResearchPaperReview`、`ApprovalRequest` 的领域状态机。
- 不迁移历史任务、报告、审批、事件或附件。
- 不将上传状态重新加入统一待办，除非后续单独扩展 v2 schema、来源枚举和测试矩阵。
- 不实现 Markdown 编辑器改造或偏差检测模型。
- 不删除旧审批组件和旧路由；它们保留为领域详情和 IA v1 回退能力。
- 不修改与本修复无关的 Plane 通用项目、Issue、Page、Cycle 和 Module 行为。

## 4. 核心产品规则

### 4.1 统一待办信封

统一待办由服务端生成，前端只展示和导航。每条记录使用以下字段：

| 字段              | 必填 | 规则                                                                                        |
| ----------------- | ---- | ------------------------------------------------------------------------------------------- |
| `schema_version`  | 是   | 固定为 `research-todo.v2`                                                                   |
| `id`              | 是   | `{source}:{object_id}`；同一领域对象只能出现一条                                            |
| `source`          | 是   | `CHAIN_TASK`、`REPORT`、`PAPER_REVIEW`、`STAGE_REVIEW`、`AGENT_APPROVAL`、`OFFICE_APPROVAL` |
| `object_id`       | 是   | 原领域对象 ID，不复制正文                                                                   |
| `title`           | 是   | 经过原对象 ACL 的短标题                                                                     |
| `context`         | 是   | 课题、节点、周期或审批流上下文                                                              |
| `requester`       | 是   | 发起人或提交人投影；未知时为 `null`，不得伪造当前负责人                                     |
| `assignees`       | 是   | 当前处理人集合，可为空                                                                      |
| `business_status` | 是   | 原对象状态，禁止由前端重算                                                                  |
| `handling_status` | 是   | `TODO`、`IN_PROGRESS`、`RETURNED`、`DONE`、`BLOCKED`                                        |
| `next_action`     | 是   | 服务端为当前用户计算的下一步动作                                                            |
| `due_at`          | 否   | 领域截止时间                                                                                |
| `urgency`         | 是   | `OVERDUE`、`DUE_TODAY`、`DUE_SOON`、`NORMAL`                                                |
| `href`            | 是   | 进入领域上下文的深链                                                                        |
| `capabilities`    | 是   | 服务端动作能力集合，前端不得用角色名推断                                                    |
| `trace_ref`       | 否   | 领域审计或 Trace 引用；不得在列表中展开敏感值                                               |
| `updated_at`      | 是   | 原对象更新时间                                                                              |

### 4.2 三种范围

| 范围      | 产品含义           | 服务端规则                                                                   |
| --------- | ------------------ | ---------------------------------------------------------------------------- |
| `to_me`   | 我现在能处理的事项 | 仅返回当前用户至少拥有一个允许执行的 capability 的记录                       |
| `mine`    | 我发起或提交的事项 | 返回当前用户作为 owner、requester 或提交人的记录，并显示当前负责人和退回状态 |
| `visible` | 我有权查看的事项   | 先执行原对象 ACL，再返回可见记录；不扩大正文、附件和 Trace 权限              |

没有当前负责人的记录不能进入 `to_me`，但可以进入 `mine` 或 `visible`。`capabilities` 是权限的唯一 UI 来源；角色名称只能作为上下文展示。

### 4.3 领域来源与动作

| 来源       | `to_me` 触发                      | 下一步动作                               | 深链目标                     |
| ---------- | --------------------------------- | ---------------------------------------- | ---------------------------- |
| 节点任务   | assignee 提交、reviewer 退回/完成 | `SUBMIT`、`RETURN`、`COMPLETE`           | 课题详情的节点任务面板       |
| 周报       | 导师/审阅人阅读或审阅             | `READ`、`REVIEW`、`RETURN`、`ACCEPT`     | 周报详情                     |
| 论文评审   | final reviewer 评审、owner 重提   | `SUBMIT`、`RETURN`、`ACCEPT`、`WITHDRAW` | `PAPER_WRITING` 节点评审面板 |
| 阶段评审   | 有效 reviewer assignment 且未完成 | `REVIEW`、`REVISE`                       | 阶段评审详情                 |
| Agent 审批 | 当前人工确认人可决策              | `APPROVE`、`REJECT`                      | Agent 审批队列和会话上下文   |
| 办公审批   | 当前 flow step approver 可决策    | `APPROVE`、`REJECT`                      | 办公审批当前步骤             |

列表动作只调用领域 API。成功后刷新统一投影；冲突保留当前上下文并提示“状态已变化，请刷新”；不得在前端直接修改 `handling_status` 或 `business_status`。

## 5. UX 产品与交互设计

本节遵循 `academic-editorial-ui`：层级由排版、间距和中性色建立；统一待办使用一个表面区块和横向分隔线；紧急状态只使用克制红色并同时显示“逾期 / 今天截止”文字。

### 5.1 首页工作台

首页继续使用“两列工作台”：

- 左列：科研项目概览、行政项目概览、报告提交摘要。
- 右列：统一待办、最近动态。

右列的统一待办组件必须增加范围选择器。范围切换只刷新投影，不改变左列项目统计。

桌面布局：

```text
Workspace Home
├─ Header：标题、周期、刷新
├─ 左列
│  ├─ 科研项目概览
│  ├─ 行政项目概览
│  └─ 报告提交摘要
└─ 右列
   ├─ 统一待办
   │  ├─ 范围：我可处理 / 我发起 / 全部可见
   │  ├─ 降级来源提示（有故障时才显示）
   │  └─ 待办列表
   └─ 最近动态
```

首页待办行固定展示：

1. 处理状态徽标。
2. 来源与标题。
3. 课题、节点或审批流上下文。
4. 发起人和当前负责人。
5. 原业务状态。
6. 截止时间、文字化紧急程度和倒计时。
7. 服务端计算的下一步链接。

空态按范围区分：

- `to_me`：当前没有需要处理的事项。
- `mine`：当前没有由你发起或提交的事项。
- `visible`：当前权限范围内没有可见事项。

### 5.2 审批中心

审批中心保留四个领域 Tab，但在 Tab 上方增加同一个 `ResearchTodoEnvelopeList` 的统一待办区。统一区是入口，不替换领域队列；领域队列继续作为详细处理工作台。

```text
审批中心
├─ 统一待办
│  ├─ 范围切换
│  ├─ 降级来源提示
│  └─ 统一待办行，点击跳到对应 Tab / 对象详情
└─ 领域队列 Tabs
   ├─ 阶段评审
   ├─ 报告审核
   ├─ Agent 审批
   └─ 办公审批
```

统一区和首页必须传入同一 `scope`、同一 `workspaceSlug` 和同一服务组件。点击统一待办的链接时：

- `STAGE_REVIEW` 跳转到 `?tab=stage_review` 对应阶段。
- `REPORT` 跳转到报告详情或 `?tab=report_review`。
- `AGENT_APPROVAL` 跳转到 `?tab=agent_approval`。
- `OFFICE_APPROVAL` 跳转到 `?tab=office`。
- `CHAIN_TASK` 和 `PAPER_REVIEW` 跳转到课题详情深链。

点击 Tab 不应改变统一待办范围。用户切换范围后返回页面，范围保留在 URL 查询参数 `todo_scope` 中；无效值回退到 `to_me` 并不发起越权请求。

### 5.3 加载、错误与降级状态

统一待办需要区分三类状态：

| 状态         | 表现                                                         | 行为                               |
| ------------ | ------------------------------------------------------------ | ---------------------------------- |
| 全部加载失败 | 区块显示错误和“重试”                                         | 只在 API、认证或聚合基础故障时使用 |
| 部分来源降级 | 列表照常显示可用来源，顶部显示“部分来源暂时不可用”及来源名称 | 允许刷新；不清空已返回事项         |
| 空结果       | 显示当前范围专属空态                                         | 不显示“系统错误”                   |

部分降级提示不得泄露内部异常堆栈、数据库表名或上游地址。日志中保留 source、request ID 和异常类型，响应只返回稳定来源枚举。

### 5.4 指派原型与角色切换

静态原型继续标注“静态原型，非功能实现”。角色切换必须同步更新：

| 原型角色        | 科研任务候选示例                   | 行政负责人候选示例          | 操作状态                           |
| --------------- | ---------------------------------- | --------------------------- | ---------------------------------- |
| 学生            | 自己、同组织成员、显式协作者       | 当前行政 Project 成员       | 可提交自己的任务；不能伪造评审权限 |
| 直接导师        | 当前组织及祖先组织成员、显式协作者 | 当前行政 Project 成员       | 可创建/指派，能看到评审动作        |
| 课题组主 PI     | 当前组织及祖先组织成员、显式协作者 | 当前行政 Project 成员       | 可协调和完成符合 ACL 的任务        |
| Workspace Admin | 不因管理员身份新增科研候选人       | 只有已加入该 Project 的成员 | 默认无科研评审动作                 |

原型行为要求：

- 候选集合由角色数据对象驱动，不在 `renderRole` 外写死。
- 无候选人时下拉禁用，提示当前范围无可指派用户。
- 无科研写权限时“创建任务 / 保存指派”按钮禁用，并显示原因。
- 行政候选人永远显示“项目成员”分组；科研候选人永远显示“组织范围 / 显式协作者”分组。
- 角色切换后更新辅助说明、表单按钮状态和示例反馈。
- 提交仍只模拟界面反馈，不写入真实系统。

### 5.5 响应式和可访问性

- 1440px：首页两列，审批中心统一区与 Tab 完整可见。
- 1280px：两列保持，表格允许横向滚动，核心动作列固定在可见区域。
- 900px 以下：首页转单列；统一待办先于最近动态显示。
- 390px：范围选择器、刷新按钮和待办操作可换行；不产生页面级横向溢出。
- 所有范围选择器使用原生 `select` 或带可访问名称的组合控件。
- 加载状态使用 `role=status` 和 `aria-busy`；部分降级使用 `role=status`；整体错误使用 `role=alert`。
- 键盘顺序为范围 → 刷新 → 列表行 → 下一步链接；焦点样式符合现有 Propel 规范。
- 颜色不是唯一状态表达方式；紧急状态必须同时显示文字。

## 6. 后端设计

### 6.1 API 端点

保留现有端点，不新增 v3：

```http
GET /api/research/workspaces/{slug}/research-todos/?scope=to_me|mine|visible&limit=50&cursor=...
```

响应：

```json
{
  "schema_version": "research-todo.v2",
  "results": [],
  "count": 0,
  "total_count": 0,
  "next_cursor": null,
  "degraded_sources": []
}
```

`degraded_sources` 只能包含六类稳定来源枚举，顺序固定为：

```text
CHAIN_TASK, REPORT, PAPER_REVIEW, STAGE_REVIEW, AGENT_APPROVAL, OFFICE_APPROVAL
```

### 6.2 Collector 隔离策略

将 `collect_research_todos` 改为每个来源独立执行。任何 collector 异常都必须：

1. 记录结构化错误日志：`source`、workspace、request ID、异常类别和耗时。
2. 将来源加入 `degraded_sources`。
3. 继续执行其余 collector。
4. 不将异常详情返回给客户端。

聚合基础故障仅限于无法建立请求上下文、无法确定 workspace 或响应序列化失败。基础故障仍返回稳定错误 envelope；单个领域查询失败不能触发整体失败。

建议实现：

```python
def collect_research_todos(workspace, user, scope):
    """独立聚合六类来源，单源异常不影响其他来源。"""
    collectors = (
        ("CHAIN_TASK", collect_chain_task_todos),
        ("REPORT", collect_report_todos),
        ("PAPER_REVIEW", collect_paper_review_todos),
        ("STAGE_REVIEW", collect_stage_review_todos),
        ("AGENT_APPROVAL", collect_agent_approval_todos),
        ("OFFICE_APPROVAL", collect_office_approval_todos),
    )
    todos = []
    degraded_sources = []
    for source, collector in collectors:
        try:
            todos.extend(collector(workspace, user, scope))
        except Exception as exc:
            logger.exception(
                "research todo source degraded",
                extra={"source": source, "workspace_id": str(workspace.id)},
            )
            degraded_sources.append(source)
    return stable_sort_and_dedupe(todos), degraded_sources
```

生产实现必须补充异常边界测试，不能用 `except Exception: pass` 静默吞错。若需要区分可预期的上游降级和编程错误，可在 collector 层将异常包装为 `ResearchTodoSourceError`，聚合层统一捕获该类型，同时保留未知异常的错误日志和降级行为，避免用户请求被单源 bug 拖垮。

### 6.3 ACL 与 capability

- 每个 collector 先走原对象 ACL，再构造 envelope。
- `to_me` 在投影后使用 `_has_action(todo)` 过滤。
- `mine` 以领域 owner/requester/submitted_by 过滤，不能只使用 `assigned_by`。
- `visible` 保留可见但不可操作的事项，`capabilities` 全部为 `allowed=false`。
- `requester` 与 `assignees` 必须来自领域关系；无负责人时返回空数组。
- Workspace Admin 不因技术身份自动获得科研 review capability。
- 过期的组织成员、无效 ProjectMember、Guest 和已撤销 Agent grant 不得成为可操作人。

### 6.4 稳定排序与分页

排序保持当前语义：

1. `BLOCKED` 优先。
2. `OVERDUE`、`DUE_TODAY`、`DUE_SOON`、`NORMAL`。
3. `due_at` 升序。
4. `updated_at` 降序。
5. `id` 升序作为最终稳定键。

游标必须基于稳定排序结果。单源降级时，游标只对本次响应中的稳定集合生效；下一次请求若来源恢复，允许结果集合变化，但不得在同一响应内重复 ID。

### 6.5 过时 v1 契约的处理

- 当前文档、TypeScript 类型、API 测试和前端代码统一使用 `research-todo.v2`。
- 删除旧设计蓝图中的 `research-todo-summary.v1` 示例、`upload:*` 来源、`kind` 和 `target` 字段。
- 若需保留历史内容，只在变更记录中写“v1 为设计期草案，未发布”。
- 本修复不提供 v1 兼容响应，避免出现两个真假契约。
- `docs/plans/phase-1.6/research-space-boundary-development-design.md`、本 PRD 和 `docs/README.md` 必须互相链接到同一 v2 说明。

## 7. 前端代码设计

### 7.1 组件收敛

新增或调整以下组件边界：

| 文件                                                                       | 变更                                                                              |
| -------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `apps/web/core/components/research/common/research-todo-index.tsx`         | 支持 `scope`、URL 状态、部分降级、统一空态和稳定深链                              |
| `apps/web/core/components/research/approvals/research-approval-center.tsx` | 在领域 Tab 上方接入同一 `ResearchTodoEnvelopeList`                                |
| `apps/web/core/components/home/workbench.tsx`                              | 传递首页范围参数；默认 `to_me`，不复制聚合逻辑                                    |
| `apps/web/core/services/research/research-todo.service.ts`                 | 只调用 v2 聚合 API，支持 scope、limit、cursor                                     |
| `packages/types/src/research.ts`                                           | 固定 `TResearchTodoEnvelope`、`TResearchTodoScope`、`TResearchTodoSource` v2 字段 |
| `apps/web/core/components/research/common/research-todo-source.ts`         | 标为兼容回滚代码；生产组件不得引用                                                |
| `docs/product/prototypes/phase-1.6-research-space.html`                    | 角色驱动候选集合、状态和提示同步                                                  |

共享组件 Props：

```ts
type ResearchTodoEnvelopeListProps = {
  workspaceSlug: string;
  scope?: TResearchTodoScope;
  limit?: number;
  periodDays?: number | null;
  showScopeControl?: boolean;
  scopeStorageKey?: string;
  onNavigate?: (todo: TResearchTodoEnvelope) => void;
};
```

首页和审批中心必须使用同一组件，不允许分别实现 `collectResearchTodos`、状态映射或 source label。

### 7.2 URL 和状态管理

- 首页使用 `todo_scope` 查询参数；缺省为 `to_me`。
- 审批中心使用同一 `todo_scope` 查询参数，不把范围存入独立组件 state 后丢失。
- 组件切换范围时更新 URL 并重新请求服务端。
- 页面刷新、浏览器后退和深链打开后，范围可恢复。
- 不把用户角色名称映射成范围或动作。

### 7.3 动作与错误

统一待办只渲染一个下一步链接，不在列表内复制编辑器或审批表单。动作详情由深链页面执行；页面离开前不提前改变列表状态。

前端错误分类：

- 401/403：显示权限提示，不展示对象敏感信息。
- 409：显示“状态已变化，请刷新”，保留当前范围和滚动位置。
- 5xx/网络错误：显示重试，不清理已存在的本地筛选参数。
- `degraded_sources`：显示来源名称和刷新入口，不将其当成空结果。

### 7.4 原型代码结构

原型中的角色数据改为如下结构，候选和能力从同一角色对象派生：

```js
const roleData = {
  student: {
    canCreateResearchTask: false,
    researchCandidates: [
      { group: "组织范围", label: "学生 A · 界面材料组" },
      { group: "显式协作者", label: "设备管理员 · 共享平台组" },
    ],
    administrativeCandidates: [{ group: "项目成员", label: "学生 A · MEMBER" }],
  },
  mentor: {
    canCreateResearchTask: true,
    researchCandidates: [
      { group: "组织范围", label: "导师 A · 导师组" },
      { group: "组织范围", label: "PI A · 基础研究方向" },
      { group: "显式协作者", label: "设备管理员 · 共享平台组" },
    ],
    administrativeCandidates: [
      { group: "项目成员", label: "管理员 A · ADMIN" },
      { group: "项目成员", label: "设备管理员 · MEMBER" },
    ],
  },
};

function renderAssignmentRole(role) {
  renderCandidates("research-assignee", role.researchCandidates);
  renderCandidates("administrative-assignee", role.administrativeCandidates);
  setDisabled("research-assignee-form", !role.canCreateResearchTask);
  setText("research-assignment-scope", role.researchScopeHint);
  setText("administrative-assignment-scope", role.administrativeScopeHint);
}
```

实际实现可以使用现有 HTML 结构，但必须保证角色切换不会只更新首页示例数据。

## 8. 类型、接口和文档代码清单

### 8.1 TypeScript 类型

```ts
export type TResearchTodoScope = "to_me" | "mine" | "visible";
export type TResearchTodoSource =
  | "CHAIN_TASK"
  | "REPORT"
  | "PAPER_REVIEW"
  | "STAGE_REVIEW"
  | "AGENT_APPROVAL"
  | "OFFICE_APPROVAL";

export type TResearchTodoEnvelopeList = {
  schema_version: "research-todo.v2";
  results: TResearchTodoEnvelope[];
  count: number;
  total_count: number;
  next_cursor: string | null;
  degraded_sources: TResearchTodoSource[];
};
```

类型必须禁止 `upload`、`kind`、`target` 作为当前 v2 的必需来源字段。若兼容旧回滚函数仍保留内部类型，不能从生产组件导出。

### 8.2 服务端错误 envelope

整体请求错误继续使用现有 research error envelope。单源降级不返回错误状态码，而是 200 响应中的 `degraded_sources`。客户端不应依赖异常文本判断来源。

### 8.3 文档修复清单

必须同步修复：

- `docs/product/research-intelligent-platform-phase-1.6-prd.md`：将统一待办的实施状态改为“修复中”，补充本 PRD 链接和新的发布门禁。
- `docs/plans/phase-1.6/research-space-boundary-development-design.md`：删除 v1 旧蓝图，保留 v2 端点和六类来源。
- `docs/plans/phase-1.6/research-space-ux-refinement-development-design.md`：补充审批中心共享组件和 URL 范围状态。
- `docs/plans/phase-1.6/research-space-code-refinement-development-design.md`：注明旧 `collectResearchTodos` 只能作为回滚路径，生产引用必须为零。
- `docs/README.md`：将 Phase 1.6 修复列入“灰度中”或“修复中”，不能写成完整统一待办交付。
- `README.md`：在 4.25.0 状态描述后注明统一待办和原型边界修复门禁。

## 9. 测试方案

### 9.1 后端契约测试

新增或扩展 `apps/api/plane/tests/contract/app/test_research_todos.py`：

1. 六类 collector 均成功时，返回 `research-todo.v2` 和稳定来源集合。
2. `to_me` 只返回当前用户存在允许动作的事项。
3. `mine` 返回当前用户发起、提交或拥有的事项，并保留真实负责人。
4. `visible` 只返回原对象 ACL 可见事项。
5. Workspace Admin 不因管理员身份自动获得科研评审 capability。
6. Guest、失效组织成员、已删除 ProjectMember 和撤销 Agent grant 不进入候选或待办动作。
7. 同一报告的待阅读和待审阅只生成一个 `REPORT:{id}`。
8. 同一对象不会因不同 collector 或范围重复生成两个 ID。
9. overdue / today / soon / normal 顺序稳定，cursor 无重叠。
10. 六类来源分别抛出异常时，接口仍返回其余来源，并在 `degraded_sources` 中标记对应枚举。
11. 聚合基础错误仍返回统一错误 envelope。
12. POST/PUT/PATCH/DELETE 统一待办端点返回 405。
13. 响应不包含 v1 的 `kind`、`target`，不生成 `upload:*` 来源。
14. `research_chain_enabled`、报告、审批和 Agent 开关关闭时，来源按 capability 正确为空或降级。

建议用参数化测试验证单源降级：

```python
@pytest.mark.parametrize(
    "source,collector_name",
    [
        ("CHAIN_TASK", "collect_chain_task_todos"),
        ("REPORT", "collect_report_todos"),
        ("PAPER_REVIEW", "collect_paper_review_todos"),
        ("STAGE_REVIEW", "collect_stage_review_todos"),
        ("AGENT_APPROVAL", "collect_agent_approval_todos"),
        ("OFFICE_APPROVAL", "collect_office_approval_todos"),
    ],
)
def test_one_source_degrades_without_dropping_other_sources(env, monkeypatch, source, collector_name):
    monkeypatch.setattr(research_todos, collector_name, lambda *_args, **_kwargs: (_ for _ in ()).throw(RuntimeError()))
    payload = _payload(_get(env, "advisor", "?scope=to_me"))
    assert payload["degraded_sources"] == [source]
    assert payload["results"]
    assert all(item["source"] != source for item in payload["results"])
```

测试代码应在实际仓库中使用已有 fixture 和更清晰的辅助异常函数，避免为了示例引入不可读的生成器技巧。

### 9.2 前端组件测试

新增或扩展：

- `apps/web/tests/components/research-todo-index.test.tsx`
- `apps/web/tests/components/research-approval-center.test.tsx`
- `apps/web/tests/components/research-home-workbench.test.tsx`
- `apps/web/tests/components/research-prototype-role-boundary.test.ts`（若原型继续以静态 HTML 校验）

必须覆盖：

1. 首页默认请求 `{ scope: "to_me" }`。
2. 切换范围后请求对应 scope，并更新 URL。
3. 审批中心渲染同一 `ResearchTodoEnvelopeList`，不会调用旧的前端聚合。
4. 首页和审批中心使用相同的 `id`、source label、处理状态和下一步链接。
5. 部分降级显示可用事项和降级来源，不进入整体 error 状态。
6. 整体错误显示重试按钮，重试后保留范围。
7. 空态按 `to_me`、`mine`、`visible` 显示不同文案。
8. 409、403 和 5xx 显示对应恢复路径。
9. 不渲染 `trace_ref` 敏感内容。
10. 不调用 `getChainNodes` 或 `getKnowledgeUploads` 作为首页待办来源。
11. 审批 Tab 切换不清除 `todo_scope`。
12. 1440、1280、390 fixture 下无横向溢出。

### 9.3 原型测试

静态原型不连接真实 API，但必须提供浏览器级验收：

- 四种角色切换后科研候选集合发生变化。
- 行政候选集合始终只显示“项目成员”。
- 无科研写权限角色的表单按钮禁用或给出清晰说明。
- `to_me`、`mine`、`visible` 三种范围改变可见行。
- 每条待办都有来源、发起人、负责人、业务状态、处理状态、下一步、截止时间和深链。
- 角色切换不出现控制台错误。
- 390px 下表单和待办表格可滚动或换行，不产生页面级横向溢出。

### 9.4 类型、静态审计和浏览器验证

推荐命令：

```bash
cd /home/fangyikai/code/_AI4MS/plane

# API 契约
docker compose -f docker-compose-test.yml run --rm api-tests pytest \
  plane/tests/contract/app/test_research_todos.py

# Web 组件与类型
pnpm --filter web test:components -- research-todo-index research-approval-center research-home-workbench
pnpm --filter web check:types
pnpm --filter web check:lint

# 旧前端聚合引用审计
pnpm --filter web test -- research-reference-audit

# 文档契约静态检查
rg -n "research-todo-summary.v1|upload:uuid|\"target\"|source.*upload" \\
  docs/plans/phase-1.6 docs/product/research-intelligent-platform-phase-1.6-prd.md
```

最后一个搜索命令只允许命中“历史变更记录”或本 PRD 的迁移说明，不允许命中当前 API、UX 合同或实现蓝图。

浏览器验证使用现有 web fixture 和 DevTools 流程，检查：

- 首页和审批中心网络请求是否均为 `/research-todos/?scope=...`。
- 切换范围是否没有旧 collector 的扇出请求。
- 单源降级时列表仍渲染，控制台没有未处理异常。
- 1440、1280、390 三个宽度的布局和焦点顺序。
- 页面无 console error/warning、无敏感 Trace 文本泄露。

## 10. 验收矩阵

| 验收域 | 通过标准                                                        | 证据                           |
| ------ | --------------------------------------------------------------- | ------------------------------ |
| 产品   | 首页与审批中心统一展示六类来源和三种范围                        | 产品走查记录、截图、接口日志   |
| UX     | 范围、状态、负责人和下一步可读；灰度下仍有层级                  | 1440/1280/390 截图与可访问性树 |
| 后端   | 六类来源任一失败不阻断其他来源；ACL 和 capability 正确          | 参数化 contract test、错误日志 |
| 前端   | 生产引用中旧聚合函数为零；两入口共用组件                        | 引用审计输出、组件测试         |
| 契约   | 当前文档只使用 v2 字段和六类来源                                | 文档搜索、schema 检查          |
| 原型   | 角色切换同步候选、提示和按钮状态                                | 浏览器验收录屏或截图           |
| 性能   | 首页和审批中心每次加载最多一次统一待办请求，不产生节点/上传扇出 | Network trace、request spy     |
| 安全   | 无权用户不能通过 scope、href 或伪造 ID 扩大可见范围             | API 越权测试                   |
| 发布   | 所有 P1 关闭，P2 原型问题关闭，真实课题灰度门禁仍单独跟踪       | 发布 checklist                 |

## 11. 实施拆分与代码工作包

### R1：契约清理

- 更新类型、服务端 schema 文档和三份 Phase 1.6 设计文档。
- 删除当前文档中的 v1 旧示例。
- 增加 schema 断言，禁止 v1 字段回流。

### R2：后端单源降级

- 修改 `apps/api/plane/research/services/research_todos.py` 的 collector 循环。
- 增加结构化降级日志和六源参数化测试。
- 保持响应码 200 + `degraded_sources` 语义。

### R3：共享待办入口

- 扩展 `ResearchTodoEnvelopeList` 的范围控制和 URL 状态。
- 在 `ResearchApprovalCenter` 接入共享组件。
- 删除生产路径对 `research-todo-source.ts` 的依赖，保留其回滚记录。
- 补齐首页、审批中心、路由和组件测试。

### R4：原型边界修复

- 将候选人、分组、按钮和提示纳入角色数据模型。
- 验证四角色、三范围和窄屏布局。
- 更新原型文件顶部注释和文档链接，明确“静态示例，不代表实时权限”。

### R5：发布复核

- 跑完整测试矩阵。
- 复核文档搜索无当前 v1 契约。
- 生成首页、审批中心和原型的浏览器证据。
- 更新 `docs/README.md`、根 README 和 Phase 1.6 PRD 状态。

## 12. 发布、灰度与回滚

### 12.1 发布门禁

以下条件全部满足后，才可将修复标记为已交付：

1. P1-1、P1-2、P1-3 和 P2-1 均有代码、测试和浏览器证据。
2. 首页和审批中心均使用 `ResearchTodoEnvelopeList`。
3. 单源降级测试覆盖六类来源。
4. 当前文档和类型没有未解释的 v1 字段。
5. 真实角色走查确认管理员、下级组织成员和 Guest 不获得越权候选。
6. 旧 IA v1 回退仍可访问，且不受统一待办修复影响。

### 12.2 灰度指标

发布后观察：

- `/research-todos/` 5xx 比例和 P95 延迟。
- `degraded_sources` 按来源计数。
- 首页与审批中心的待办请求重复率。
- 统一待办深链打开成功率。
- 409 权限/状态冲突率。
- 空态比例与真实业务量的偏差。

### 12.3 回滚

- 前端可通过 IA v2 开关回退到旧审批容器；统一待办 API 保留只读兼容。
- 后端 collector 隔离代码可独立回滚，不涉及数据库迁移。
- 原型和文档回滚不影响生产数据。
- 不删除 `ResearchChainNodeTask`、报告已读回执或论文评审数据。
- 回滚后必须保留错误日志和待办 API 访问指标，便于定位原因。

## 13. 决策记录

1. 选择“共享统一入口 + 保留领域 Tab”，避免把领域队列状态机复制到统一待办，也不强迫领域详情一次性重构。
2. 选择“所有 source 独立降级”，因为待办是跨领域工作台，单个领域不可用不应隐藏其他领域事项。
3. 选择“只保留 v2 当前契约”，避免同时维护未发布的 v1 草案和已运行的 v2。
4. 选择“原型角色数据驱动”，让权限边界在产品评审阶段可观察，但不把原型角色切换误认为生产权限系统。

## 14. 完成定义

当以下陈述全部为真时，本修复 PRD 视为完成：

- 研究者在首页和审批中心看到同一条待办，使用同一 ID、状态和动作入口。
- 用户能在两个入口切换“我可处理 / 我发起 / 全部可见”。
- 任一待办来源故障只影响该来源，并明确显示降级来源。
- 当前产品、代码、测试和文档只引用 `research-todo.v2`。
- 原型角色切换会同步改变候选人、按钮和提示，科研与行政候选来源没有混用。
- 领域对象、ACL、审计、通知和状态机仍由原服务负责。
- 所有测试、类型检查、引用审计和浏览器证据通过，且工作区无未解释的控制台错误。

## 15. 实施结果回写

2026-10-11 已按本 PRD 完成 `4.26.0` 修复：

- 首页与审批中心共用 `ResearchTodoEnvelopeList`；`to_me`、`mine`、`visible` 均通过 `todo_scope` URL 参数回放，切换审批领域 Tab 不丢失范围。
- 六类来源在服务端独立隔离异常，结构化日志包含 source、workspace、request ID、用户和异常类型，部分降级保持 HTTP 200 + `degraded_sources`。
- 当前产品 PRD、三份实施设计、README 与文档索引均收敛到 `research-todo.v2`；旧 v1 和上传来源只保留在历史/迁移说明中。
- HTML 原型由角色数据派生科研 / 行政候选人、能力提示、按钮禁用与无权限说明；四角色、三种范围、深链、键盘顺序和 390 / 1280 / 1440 响应式已通过浏览器验证。
