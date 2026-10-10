# Phase 1.6 主轴三：科研空间代码精炼开发设计

| 项目     | 内容                                                                                                                             |
| -------- | -------------------------------------------------------------------------------------------------------------------------------- |
| 文档版本 | v1.2                                                                                                                             |
| 状态     | 设计复核修订版；增加统一待办投影边界，避免前端扇出与领域状态机重复实现                                                           |
| 日期     | 2026-10-09                                                                                                                       |
| 代码基线 | Plane `develop` / `4.24.0`                                                                                                       |
| 上游 PRD | [`research-intelligent-platform-phase-1.6-prd.md`](../../product/research-intelligent-platform-phase-1.6-prd.md)                 |
| 关联设计 | [逻辑厘清设计](research-space-boundary-development-design.md)、[UX 精炼设计](research-space-ux-refinement-development-design.md) |

## 1. 清理原则

Phase 1.6 的代码精炼不是“大规模重构”，而是小步、可验证地减少确定无用代码和重复逻辑：

1. **先证明，再删除**：以运行时引用、测试引用、兼容责任和外部契约四类证据分类。
2. **不加新抽象**：只有第三个真实调用点出现后才抽公共模块。
3. **不牺牲兼容**：旧路由、功能开关、审计、迁移和外部回执不因低引用而删除。
4. **不碰数据语义**：本主轴不删除数据库字段、公开 API 字段或事件类型。
5. **小步提交**：每个切片独立可回滚，禁止混合功能新增和大范围格式化。

## 2. 当前代码事实

### 2.1 已确认的运行时零引用

在 `apps/web/app`、`apps/web/core`、`apps/web/tests` 中按符号搜索，排除自身、构建产物和缓存后：

| 符号                     | 文件                                                      | 证据                          | 处理决策                      |
| ------------------------ | --------------------------------------------------------- | ----------------------------- | ----------------------------- |
| `ResearchGuard`          | `components/research/common/research-guard.tsx`           | 无运行时 / 测试引用           | 删除文件                      |
| `SYNLORA_URL`            | `components/research/chains/research-chain-detail.tsx`    | 只在本文件 `window.open` 使用 | 改跳既有 Agent 路由并删除常量 |
| `openSynlora`            | `components/research/chains/research-chain-detail.tsx`    | 只服务硬编码 URL              | 删除函数                      |
| `ResearchAgentSidePanel` | `components/research/agent/research-agent-side-panel.tsx` | 无运行时引用，仅测试引用      | 删除组件和对应测试            |

`ResearchAgentSidePanel` 的可访问性逻辑不应丢失：现有 `ResearchAgentPlugin` 内部已有抽屉和焦点逻辑；删除外层包装后，以现有 Agent 页面和插件抽屉为唯一入口。

### 2.2 零运行时引用的导出符号

以下符号只在自身文件内使用或在当前扫描中无外部运行时引用。它们不是必然死代码，但不应继续作为公共 API 导出：

- `ImportPreviewPerson`
- `PersonOption`
- `RESEARCH_AGENT_EVENT_TYPE_LABELS`
- `RESEARCH_GENERIC_ERROR_KEY`
- `RESEARCH_OVERVIEW_ROW_LIMIT`
- `TAgentMessageResponse`
- `TApprovalFlowPayload`
- `TInviteCodePayload`
- `TLiteratureImportResult`
- `TMainPiResolvedName`
- `TOrgUnitMemberPayload`
- `TResearchAgentRiskLevel`
- `TResearchAgentToolStatus`
- `TResearchAgentTranslate`
- `TResearchFeedbackFilters`
- `TResearchKnowledgeCandidate`
- `TResearchKnowledgeRequestState`
- `TResearchKnowledgeScope`
- `TResearchListStateConfig`
- `TResearchTodoAccess`
- `TResearchTodoKind`
- `TResearchTodoSource`
- `TResearchTodoTranslate`
- `TResearchWorkflow`
- `TResearchWorkflowStageStatus`
- `TStageListResponse`
- `TToMeResponse`
- `getResearchErrorCode`
- `isResearchOverviewSupervisor`
- `normalizeResearchTodos`
- `todoTimeValue`

处理：

- 只被自身文件使用：移除 `export`，保留实现。
- 完全无引用且不代表契约：删除。
- 若后续测试需要直接验证纯函数，测试应通过公共组件行为或移入明确的 `research/common/__tests__` 工具模块，不长期保留“仅为测试导出”。

### 2.3 仅测试引用但建议保留的契约

| 符号                                  | 原因                                            |
| ------------------------------------- | ----------------------------------------------- |
| `RESEARCH_WORKFLOW_STAGE_DEFINITIONS` | 测试固定 13 阶段不变量，属于展示层契约          |
| `RESEARCH_NODE_STATUS_PRIORITY`       | 测试当前节点选择规则                            |
| `resolveChainTab`                     | 测试旧 Tab query 兼容映射                       |
| `createIdempotencyKey`                | 测试 HTTP/IP 下 Web Crypto 降级，仍承担兼容责任 |
| `researchStatusVariant`               | 测试状态字典映射                                |
| `resolveMainPiName`                   | 测试平台配置展示                                |

这些符号不清理；如未来要取消导出，必须先改测试为行为级断言。

### 2.4 重复逻辑

1. **项目 / 报告列表参数组装重复**
   - `ResearchProjectList` 与 `ResearchReportList` 都手写：
     - active filter 判断。
     - filter summary 数组。
     - `org_unit/owner/date_from/date_to/q/cursor` 请求参数。
   - 语义差异：项目使用 `workflow_status/research_type`，报告使用 `status/report_type/period_key/mine`。

2. **待办上传状态前端扇出**
   - `collectResearchTodos` 最多取 12 个课题、每课题前 20 个节点，再逐节点请求知识上传。
   - 最坏情况会发起大量上传列表请求，只为找非 `SUCCESS` 状态。
   - 该逻辑不能直接删除，需等待主轴一 L6 的服务端待办聚合。

3. **课题详情文件过大**
   - `research-chain-detail.tsx` 当前约 804 行，同时承担数据加载、URL 解析、节点生命周期、成员管理、资料聚合和 UI。
   - 后续 UX 任务和论文评审如果继续内联，会进一步膨胀。

### 2.5 必须保留的“低引用”代码

| 区域                                | 保留原因                                         |
| ----------------------------------- | ------------------------------------------------ |
| 旧科研路由与 `ResearchIaV2Redirect` | `research_ia_v2` 关闭回退和深链兼容              |
| `seed_research_demo`                | 隔离自动化数据库夹具和历史验收                   |
| legacy KB request / group KB 双路径 | 历史 Chain KB 兼容和团队 KB 迁移期               |
| feedback migration                  | 4.21 历史反馈导入和审计对账                      |
| `MAIN_PI` legacy 标签               | 历史身份兼容，不提升内容权限                     |
| audit append-only 约束              | 审计事实不可删除                                 |
| `check_access` 和角色解析           | 当前唯一权限语义，不能为了“少一个函数”合并成旁路 |
| Outcome 只读提交约束                | 成果登记状态语义，论文评审另行建模               |

## 3. 目标结构

### 3.1 前端科研模块边界

```text
apps/web/core/components/research/
├─ common/        # 页面壳、列表状态、筛选、格式化、待办聚合
├─ chains/        # 课题列表、13 段工作流、节点详情、任务、论文评审
├─ reports/       # 周报、正文、附件、已读状态
├─ approvals/     # 四个权威审批队列的容器
├─ projects/      # 科研项目保存视图
└─ ...
```

调整规则：

- 容器组件只做路由、数据加载和权限分支。
- 领域组件只渲染一个对象族。
- 纯函数优先放在相邻 `.ts` 文件，不用 hooks 包装。
- 不新建 `utils/general.ts` 这类无边界工具桶。

### 3.2 查询参数工具

在 `common/browse-query.ts` 增加纯函数，不新增全局状态：

```ts
export function researchBrowseParams(
  query: ReturnType<typeof useResearchBrowseQuery>,
  fixed: Record<string, string | undefined>
): Record<string, string>;

export function researchFilterSummary(values: Array<string | false | undefined>): string[];
```

要求：

- `researchBrowseParams` 只处理共同参数：`org_unit/owner/date_from/date_to/q/scope/cursor`。
- 领域参数仍留在项目 / 报告组件中，避免错误复用。
- 不改变 URL query 名称和请求参数名。
- 保留 `mine` 与 `scope` 的兼容转换。

### 3.3 课题详情拆分边界

在实现 UX U4 / U6 时同步拆分，避免“先拆空文件”：

```text
research-chain-detail.tsx        # 数据加载、URL 上下文、Tab 容器
research-chain-task-panel.tsx    # 节点任务
research-paper-review-panel.tsx  # 论文评审
```

禁止拆出仅转发 props 的无逻辑壳组件。

### 3.4 指派接口的代码边界

科研 `assignable-users` 与行政 Project 成员查询必须保持两个明确的 service / endpoint 边界。不得在前端建立全工作区成员缓存，再由组件自行推断可指派范围；科研候选人解析组织祖先和显式协作者，行政候选人解析当前 ProjectMember，审批人继续由 ApprovalRequest flow 解析。任何统一化只能抽取响应格式化等纯函数，不能合并权限判定。

偏差提醒属于后续独立能力：只允许消费课题目标和节点证据生成草稿风险提示，不能把模型输出塞进任务、审批或正式 Chain Event；本阶段只保留类型和路由预留，不提前清理现有 Agent / Trace 入口。

### 3.5 统一待办的代码边界

`collectResearchTodos` 当前是前端跨服务聚合，且会对课题、节点和上传状态产生扇出请求。后续只增加一个服务端只读 `research-todos` 聚合接口和一个前端 `ResearchTodoEnvelopeList`，不新建统一业务任务模型、不把领域状态转换逻辑搬到前端。

聚合器只负责 ACL 过滤、统一字段投影、稳定去重 ID、范围筛选、排序和 cursor。任务、报告、论文、阶段评审、Agent、办公审批各自的动作仍保留在原 service / endpoint；列表点击动作后回到领域页面，成功后刷新投影。`business_status` 必须来自原对象，`handling_status` 只能是展示派生值。

前端替换顺序为：先保留 `collectResearchTodos` 作为降级路径，再接入服务端聚合；服务端稳定后才删除重复的前端扇出。删除前必须保留无网络、部分来源失败和旧路由兼容测试。

### 3.6 分类导航代码边界

分类数据单独放在 research navigation model/service 中，不修改 `OrgUnit` 的权限语义，也不向普通 Project 列表注入科研分类字段。科研与行政分别请求 `scope`，共享树渲染组件但不共享分类数据。分类写 API 统一走服务端 workspace/research admin 判权，前端隐藏按钮只改善体验，不作为安全边界。

实现顺序：迁移与 API → 分类树只读渲染 → 移动/管理菜单 → 分类写入测试 → 删除旧固定项目子项。旧路由、项目详情、ProjectMember 和 `visible_profile_queryset` 必须保留；分类为空或接口降级时回退到未分类/原项目入口。

## 4. 清理切片

### C0：建立可重复引用审计

新增一个本地脚本或测试辅助，输出：

- 符号名。
- 定义文件。
- 运行时引用数。
- 测试引用数。
- 是否出现在 i18n 动态 key、路由注册或 barrel export。

验收：

- 不修改业务行为。
- 排除 `build/`、`dist/`、`.turbo/`、`node_modules/` 和 `*.tsbuildinfo`。
- 输出能被 code review 复核。
- 不把扫描结果当作删除充分条件。

### C1：删除确定死代码

- 删除 `research-guard.tsx`。
- 删除 `research-agent-side-panel.tsx` 与 `research-agent-side-panel.test.tsx`。
- 运行导航、Agent 页面和 Agent 插件测试。
- 确认路由注册中本来就没有这两个组件。

### C2：Agent 入口去硬编码

- `ResearchChainDetail` 的“打开智能体”改为 Link：
  `/{workspaceSlug}/research/chains/{chainId}/nodes/{nodeId}/agent`
- 删除 `SYNLORA_URL` 和 `openSynlora`。
- 保留新窗口行为可选，但 URL 必须来自当前路由。
- 更新课题详情测试断言目标路径。

### C3：导出降级

- 按 §2.2 逐个移除无效 `export`。
- 每次处理一个文件，避免全仓格式化。
- 对确实无实现的符号删除定义。
- 运行类型检查，防止动态 JSX / 类型推导漏检。

### C4：项目 / 报告共同查询参数抽取

- 增加 §3.2 两个纯函数。
- `ResearchProjectList` 与 `ResearchReportList` 只保留领域参数和领域筛选摘要。
- URL 回放测试必须覆盖：
  - scope、owner、org、keyword、date、cursor。
  - `mine=true` 旧参数。
  - 报告和项目的领域参数互不串扰。

### C5：待办上传扇出收敛

前置条件：主轴一 L6 已提供 Chain 聚合或待办聚合 API。

- `collectResearchTodos` 停止逐节点请求上传列表。
- 上传待办从服务端聚合结果读取。
- 保留单课题详情中的上传列表请求。
- 回归 12 课题 / 多节点场景的请求数。

### C6：课题详情拆分

前置条件：UX U4 / U6 需要新增面板。

- 抽出任务面板和论文评审面板。
- 容器只传入 workspaceSlug、chain、node、capabilities 和刷新回调。
- 不复制加载逻辑。
- 不改变现有 URL 参数。

### C7：后端辅助函数审计

只审计，不默认合并：

- 对比 `visible_*`、`can_*`、`serialize_*` 的调用对象和动作。
- 语义完全相同且无兼容责任时才移动到 utils/service。
- 涉及 ACL、审计、迁移、外部回执的函数保留原位。
- 每次移动函数必须保留原测试名或补等价契约测试。

## 5. 禁止事项

- 不删除旧科研路由来减少文件数。
- 不删除历史迁移和 seed 夹具。
- 不把 `check_access` 的判断复制到视图层。
- 不把 UI capability 当成后端权限。
- 不用注释掉的代码保留废弃实现。
- 不引入新的通用 EventBus、状态管理或配置驱动表单。
- 不把科研候选人接口改造成行政项目成员接口，也不把行政 ProjectMember 当成科研组织继承的替代来源。
- 不把统一待办投影当作新的写入口，不在 `ResearchTodoEnvelopeList` 内复制任务、报告或审批状态机。
- 不一次性格式化无关文件。
- 不为了通过 lint 而放宽全局 warning 阈值。

## 6. 验证矩阵

| 变更            | 前端测试                         | 类型 / lint                     | 其他                         |
| --------------- | -------------------------------- | ------------------------------- | ---------------------------- |
| C1 死代码删除   | Agent、导航、课题详情组件测试    | `pnpm --filter web check:types` | 确认无路由注册残留           |
| C2 Agent 路由   | 课题详情测试、返回导航测试       | 类型检查                        | 路由注册测试                 |
| C3 导出降级     | 相关组件测试                     | 类型检查                        | 引用审计脚本输出为零或预期值 |
| C4 查询参数抽取 | 报告 / 项目浏览测试              | 类型检查                        | URL query 回放               |
| C5 待办扇出收敛 | 待办索引测试                     | 类型检查                        | 请求次数断言                 |
| C6 课题详情拆分 | 课题详情、任务面板、论文评审测试 | 类型检查                        | 1440 / 390 浏览器检查        |
| C7 后端函数移动 | 对应 contract / unit 测试        | API lint / format               | Docker pytest                |

推荐命令：

```bash
pnpm --filter web test:components -- research-agent-plugin research-chain-detail research-report-list research-project-list research-todo-index
pnpm --filter web check:types
pnpm --filter web check:lint
```

后端若被 C7 触达：

```bash
docker compose -f docker-compose-test.yml run --rm api-tests pytest \
  plane/tests/unit/research/test_acl.py \
  plane/tests/contract/app/test_research_chain_foundation.py \
  plane/tests/contract/app/test_research_reports.py
```

## 7. 回归清单

每次清理后至少确认：

1. IA v2 四入口和关闭开关后的旧导航。
2. 旧科研路由 redirect。
3. 科研总览、项目与课题三个视图。
4. 课题详情 13 段 Workflow 和四个 Tab。
5. 节点状态按钮与 capability 拒绝原因。
6. 报告创建、筛选、详情、提交、退回、接受。
7. Agent 页面路由和插件内部抽屉。
8. 办公审批列表。
9. 普通 Plane Workspace / Project / Issue / Page 可用。
10. 构建产物和缓存未被加入 Git。

## 8. 验收

- 引用审计有可重复输出，且清理后无已知零引用运行时代码。
- `ResearchGuard` 和外层 Agent Side Panel 删除后，现有功能和测试无回归。
- Agent 入口不再包含硬-coded 外部域名。
- 项目 / 报告列表请求参数和 URL 回放行为不变。
- 待办上传来源不再产生最坏 240 次请求的扇出。
- 课题详情新增功能后文件行数下降或至少不继续膨胀。
- 所有删除都有引用、兼容、回归和回滚记录。
- 不存在为了清理而引入的新抽象或无边界工具桶。

## 9. 工程执行附录：代码精炼落地蓝图

### 9.1 引用审计脚本

新增脚本：`scripts/research-reference-audit.mjs`

依赖现有 `typescript` package，不引入新依赖。

CLI：

```bash
node scripts/research-reference-audit.mjs
node scripts/research-reference-audit.mjs --format markdown
node scripts/research-reference-audit.mjs --format json
node scripts/research-reference-audit.mjs --compare docs/plans/phase-1.6/research-reference-baseline.json
```

默认输出 Markdown 到 stdout；只有显式 `--out` 才写文件，避免意外修改工作区。

扫描范围：

```text
apps/web/core/components/research/**/*.{ts,tsx}
apps/web/core/services/research/**/*.{ts,tsx}
apps/web/app/**/*.{ts,tsx}
apps/web/tests/**/*.{ts,tsx,mjs}
packages/constants/src/**/*.ts
packages/i18n/src/locales/zh-CN/common.json
```

固定排除：

```text
node_modules
dist
build
.turbo
*.tsbuildinfo
*.map
```

AST 识别：

- `export const`
- `export function`
- `export type`
- `export interface`
- `export class`
- default export 的 local name
- re-export / barrel export

引用分类：

| 分类         | 判定                                               |
| ------------ | -------------------------------------------------- |
| runtime      | `apps/web/app` 或 `apps/web/core` 中非定义文件引用 |
| test         | `apps/web/tests` 引用                              |
| barrel       | `index.ts` re-export                               |
| route        | `apps/web/app/routes/core.ts` 或 route 文件引用    |
| i18n_dynamic | 动态 key 前缀能覆盖该符号相关文案                  |
| internal     | 仅定义文件内引用                                   |
| unused       | 无任何引用                                         |

Markdown 输出列：

```text
symbol | defined_in | runtime | test | barrel | route | i18n_dynamic | classification | suggested_action
```

比较模式：

- baseline 中 `unused` 仍为 unused → 报错。
- baseline 中 `runtime=0` 但当前 runtime > 0 → 输出 `reused`，禁止继续删除。
- 当前出现 baseline 未记录的 unused → 输出 `new`。

单元测试：

- `apps/web/tests/research-reference-audit.test.mjs`
- 使用脚本导出的纯函数分析临时 fixture，不扫描真实仓库。
- 至少覆盖 export type、default export、barrel、test-only、dynamic i18n、排除产物。

### 9.2 零运行时导出处理表

| 符号                               | 当前文件                                       | 动作           | 理由 / 验证                                     |
| ---------------------------------- | ---------------------------------------------- | -------------- | ----------------------------------------------- |
| `ResearchGuard`                    | `common/research-guard.tsx`                    | 删除文件       | 运行时和测试均零引用                            |
| `ResearchAgentSidePanel`           | `agent/research-agent-side-panel.tsx`          | 删除组件和测试 | 仅测试引用；生产入口是 Agent 页面与插件内置抽屉 |
| `getResearchErrorCode`             | `common/error-messages.ts`                     | 删除函数       | 文件内也无调用；保留 `getResearchErrorKey`      |
| `ImportPreviewPerson`              | `services/account.service.ts`                  | 去掉 export    | 仅 `ImportApprovalPreview` 内部使用             |
| `PersonOption`                     | `common/person-select.tsx`                     | 去掉 export    | 组件内部类型                                    |
| `RESEARCH_AGENT_EVENT_TYPE_LABELS` | `agent/research-agent-utils.ts`                | 去掉 export    | 仅 `agentEventLabel` 使用                       |
| `RESEARCH_GENERIC_ERROR_KEY`       | `common/error-messages.ts`                     | 去掉 export    | 仅 `getResearchErrorKey` fallback 使用          |
| `RESEARCH_OVERVIEW_ROW_LIMIT`      | `common/research-overview-rows.ts`             | 去掉 export    | 内部 slice 上限                                 |
| `TAgentMessageResponse`            | `services/agent.service.ts`                    | 去掉 export    | 内部响应类型                                    |
| `TApprovalFlowPayload`             | `services/approval.service.ts`                 | 去掉 export    | 内部请求类型                                    |
| `TInviteCodePayload`               | `services/account.service.ts`                  | 去掉 export    | 内部请求类型                                    |
| `TLiteratureImportResult`          | `services/literature.service.ts`               | 去掉 export    | 内部响应类型                                    |
| `TMainPiResolvedName`              | `settings/platform/platform-settings-form.tsx` | 去掉 export    | 内部表单类型                                    |
| `TOrgUnitMemberPayload`            | `services/org.service.ts`                      | 去掉 export    | 内部请求类型                                    |
| `TResearchAgentRiskLevel`          | `agent/research-agent-utils.ts`                | 去掉 export    | 内部函数返回类型                                |
| `TResearchAgentToolStatus`         | `agent/research-agent-utils.ts`                | 去掉 export    | 内部函数返回类型                                |
| `TResearchAgentTranslate`          | `agent/research-agent-utils.ts`                | 去掉 export    | 内部函数参数类型                                |
| `TResearchFeedbackFilters`         | `services/feedback.service.ts`                 | 去掉 export    | 内部查询类型                                    |
| `TResearchKnowledgeCandidate`      | `services/chain.service.ts`                    | 去掉 export    | 内部返回类型                                    |
| `TResearchKnowledgeRequestState`   | `services/chain.service.ts`                    | 去掉 export    | 内部状态类型                                    |
| `TResearchKnowledgeScope`          | `services/chain.service.ts`                    | 去掉 export    | 内部 scope 类型                                 |
| `TResearchListStateConfig`         | `common/research-list-state.tsx`               | 去掉 export    | 内部配置类型                                    |
| `TResearchTodoAccess`              | `common/research-todo-source.ts`               | 去掉 export    | 内部参数类型                                    |
| `TResearchTodoKind`                | `common/research-todo-source.ts`               | 去掉 export    | 内部联合类型                                    |
| `TResearchTodoSource`              | `common/research-todo-source.ts`               | 去掉 export    | 内部联合类型                                    |
| `TResearchTodoTranslate`           | `common/research-todo-source.ts`               | 去掉 export    | 内部函数类型                                    |
| `TResearchWorkflow`                | `chains/research-chain-workflow.ts`            | 去掉 export    | 内部返回类型                                    |
| `TResearchWorkflowStageStatus`     | `chains/research-chain-workflow.ts`            | 去掉 export    | 内部联合类型                                    |
| `TStageListResponse`               | `services/stage.service.ts`                    | 去掉 export    | 内部响应类型                                    |
| `TToMeResponse`                    | `services/review.service.ts`                   | 去掉 export    | 内部响应类型                                    |
| `isResearchOverviewSupervisor`     | `common/research-overview-rows.ts`             | 去掉 export    | 仅内部使用                                      |
| `normalizeResearchTodos`           | `common/research-todo-source.ts`               | 去掉 export    | 仅内部使用                                      |
| `todoTimeValue`                    | `common/research-todo-source.ts`               | 去掉 export    | 仅内部使用                                      |

保留导出：

- `RESEARCH_WORKFLOW_STAGE_DEFINITIONS`
- `RESEARCH_NODE_STATUS_PRIORITY`
- `resolveChainTab`
- `createIdempotencyKey`
- `researchStatusVariant`
- `resolveMainPiName`

原因：这些符号被测试用于锁定兼容契约，不能仅为引用计数删除。

### 9.3 Agent 入口去硬编码

当前问题：

```ts
const SYNLORA_URL = "https://synlora.xmuzc.com";
window.open(SYNLORA_URL, ...);
```

目标行为：

```tsx
<Link
  href={`/${workspaceSlug}/research/chains/${chainId}/nodes/${selected.node.id}/agent`}
  target="_blank"
  rel="noreferrer"
>
```

实施要求：

- 删除 `SYNLORA_URL` 和 `openSynlora`。
- 使用当前 `workspaceSlug/chainId/selected.node.id`。
- 保留 capability 判断。
- 更新 `research-chain-detail.test.tsx` 断言 href。
- 路由注册测试继续锁定 Agent 路径。

### 9.4 浏览参数抽取

在 `common/browse-query.ts` 追加纯函数：

```ts
export type TResearchBrowseCommonValues = {
  org_unit?: string;
  owner?: string;
  date_from?: string;
  date_to?: string;
  q?: string;
  scope?: string;
  mine?: string;
  cursor?: string;
};

export function researchBrowseRequestParams(
  values: TResearchBrowseCommonValues,
  domain: Record<string, string | undefined>,
  options?: { per_page?: string }
): Record<string, string>;
```

规则：

- 输出始终包含 `per_page`，默认 `50`。
- 共同参数为空时不输出。
- `scope` 为空或 `all` 时不输出。
- 兼容旧参数：
  - 若 `scope` 缺失且 `mine=true`，输出 `mine=true`。
  - 若 `scope` 存在，不输出 `mine`。
- domain 参数原样输出，但空值剔除。
- 不读取 URL，不调用 hook，便于单元测试。

再追加：

```ts
export function researchFilterSummary(values: Array<string | false | null | undefined>): string[];
```

调用改造：

- `ResearchProjectList` 保留：
  - `workflow_status`
  - `research_type`
  - 项目状态标签
- `ResearchReportList` 保留：
  - `status`
  - `report_type`
  - `period_key`
  - `mine`
  - 报告状态标签
- 共同参数和日期摘要改用上述函数。

测试文件：

- 扩展 `research-browse-query.test.ts`。
- 扩展 `research-project-list.test.tsx` 与 `research-report-list.test.tsx`。

URL 回放断言：

- `?scope=owned&owner=uuid&q=xxx&date_from=2026-10-01`
- `?mine=true`
- `?scope=mine`
- `?cursor=uuid`
- 项目和报告领域参数互不串扰。

### 9.5 待办上传扇出收敛

当前问题：

```text
chains ≤ 12
× nodes ≤ 20
× getKnowledgeUploads(node)
```

最坏请求 240 次。

目标：

```text
GET /research/workspaces/{slug}/research-todos/
```

实施步骤：

1. 后端实现主轴一 §11.9 聚合 API。
2. `collectResearchTodos` 改为：
   - 优先调用聚合 API。
   - 将 `target` 映射为前端 route。
   - 保留单源失败降级。
3. 删除链式逐节点上传请求循环。
4. 保留集成健康请求，直到聚合 API 返回 `degraded_sources` 稳定后移除。
5. 增加请求次数 spy 测试：加载总览对两个课题 / 四节点只发一次聚合请求。

### 9.6 课题详情拆分

目标文件结构：

```text
research-chain-detail.tsx
research-chain-task-panel.tsx
research-paper-review-panel.tsx
```

容器保留：

- chain / nodes / members 加载
- URL `tab/stage/node` 解析
- stage detail 请求
- lifecycle transition
- toast 和权限分支

子面板不得：

- 读取 URL。
- 直接调用 identity store 判断角色。
- 重复加载 chain。
- 复制状态字典。

数据流：

```text
ResearchChainDetail
  ├─ tasks, assignableUsers, loading, error
  │  └─ ResearchChainTaskPanel
  └─ review, versions, events, loading, error
     └─ ResearchPaperReviewPanel
```

拆分顺序：

1. 先加任务面板并保持行为测试通过。
2. 再加论文评审面板。
3. 最后整理容器 import 和无效状态。
4. 不拆出只有 props 转发的组件。

### 9.7 清理切片执行表

| 切片                | 修改 / 删除                              | 必跑验证                                             | 回滚                             |
| ------------------- | ---------------------------------------- | ---------------------------------------------------- | -------------------------------- |
| C0 audit script     | 新增 script + test                       | `pnpm --filter web test -- research-reference-audit` | revert 单个脚本                  |
| C1 dead code        | 删除 guard、side panel、side panel test  | Agent / navigation tests                             | git revert 删除提交              |
| C2 agent route      | chain detail + detail test               | route registration + detail test                     | 恢复 Link 为 window.open         |
| C3 export downgrade | §9.2 表中文件                            | typecheck                                            | 逐文件恢复 export                |
| C4 browse params    | browse-query + two lists + tests         | browse / project / report tests                      | 回退共同函数，保留领域参数       |
| C5 todo aggregate   | research-todo API + frontend todo source | todo tests + request spy                             | 前端临时恢复旧扇出，API 保留只读 |
| C6 detail split     | chain detail + two panels                | detail / task / paper tests                          | 将面板内容内联回容器             |
| C7 backend helpers  | 只审计，不默认移动                       | 对应现有 tests                                       | 不产生代码变更                   |

### 9.8 清理完成定义

- `research-reference-audit` 输出中不存在未解释的 `unused`。
- 所有 `internal` 符号无 `export`。
- 所有保留的 test-only 契约在文档中有对应兼容理由。
- Agent 入口无外部硬-coded 域名。
- 总览待办加载不再逐节点请求上传状态。
- `research-chain-detail.tsx` 在新增面板后不低于当前可读性，且不继续膨胀。
- 普通 Plane Workspace / Project / Issue / Page 行为回归通过。
