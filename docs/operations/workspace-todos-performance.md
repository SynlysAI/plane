# 工作区待办性能与缓存运维

## 范围与兼容性

首页和 `/todos` 共用的 `GET /api/workspaces/:slug/todos/` 保留
`workspace-todo.v1` 结构、成员与私有空间准入校验、对象权限、来源降级、排序、
`total_count` 和游标分页。没有数据库迁移或新增公开 API。

冷请求仍聚合全部可见待办后排序、分页，以保留精确总数和现有全局排序。
`limit=50` 只限制返回条数。优化减少重复权限查询和逐条关联查询，不改变此语义。

## 查询优化

- 一次聚合使用 `ContextVar` 复用工作区配置、科研分区、管理员身份、ActorContext、
  项目准入、研究链写入权限和阶段审批人；请求结束释放，其他业务调用不复用。
- 报告最新快照版本和 Agent 最新事件使用子查询；报告审批路由、当前用户阅读回执、
  阶段分配和已评审记录批量读取；办公审批步骤与参与人批量读取。
- 工作项、报告、任务、论文评审和阶段查询裁剪字段，避免读取正文等无关大字段。
  查询量回归测试防止遗漏权限判断所需字段而触发延迟加载。

## 缓存与失效

使用现有 Django cache / Redis，成功完整响应缓存 **5 秒**。
缓存键包含工作区、用户、domain、limit、解码后的 cursor offset 和工作区版本。
每次命中前仍检查成员身份和工作区准入。任一来源降级、缓存异常或处于数据库事务中，
均执行正常聚合；降级响应和事务内结果不写共享缓存。

相关模型的 `save`、删除由信号安排失效；现有软删除 QuerySet 和只追加记录 QuerySet
补充覆盖 `update`、`bulk_create`、`bulk_update`。事务通过
`transaction.on_commit` 更新整个工作区的 UUID 版本，所有用户的旧键立即不可达。
回滚不更新版本；外键迁移同时更新新旧工作区；共享主 PI 配置更新会失效配对科研空间。
失效前启动的请求仍只会写旧版本键，不会覆盖新版本结果。旧响应键自行在 5 秒后到期。

依赖模型及工作区路径集中维护于
`apps/api/plane/utils/workspace_todos_cache.py::TODO_WORKSPACE_PATHS`。
新增待办来源、权限依赖或绕过 ORM 的原始 SQL 写入时，需同步补充失效入口。
Redis 故障记录错误并旁路，失效写失败不会撤销已提交的业务事务。

### Manager 与写入边界审计

2026-11-06 在隔离容器通过 Django `_meta.managers` 与 `manager.get_queryset()`
枚举了全部 40 个依赖模型。下表中的类型代表实际运行时的 manager/queryset：

- `S`：`objects: SoftDeletionManager -> SoftDeletionQuerySet`，
  `all_objects: ManagerFromTodoInvalidationQuerySet -> TodoInvalidationQuerySet`。
- `A`：`objects: AppendOnlyManager -> AppendOnlyQuerySet`。
- `R`：`objects: ManagerFromTodoInvalidationQuerySet -> TodoInvalidationQuerySet`。
- `U`：`objects: django.contrib.auth.models.UserManager -> TodoInvalidationQuerySet`。
  保留 stock `UserManager` 的创建、认证和迁移序列化，运行时仅配置其 `_queryset_class`；
  `makemigrations --check --dry-run` 确认没有模型状态变化。

| 依赖模型                           | 实际 manager 类型或附加 manager                                                                                                                                        |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Project`                          | S                                                                                                                                                                      |
| `ProjectMember`                    | S                                                                                                                                                                      |
| `Workspace`                        | S；实例删除使用原有 `Workspace.delete`                                                                                                                                 |
| `WorkspaceMember`                  | S                                                                                                                                                                      |
| `State`                            | `objects: StateManager -> SoftDeletionQuerySet`；`triage_objects: TriageStateManager -> SoftDeletionQuerySet`；`all_state_objects` 与 `all_objects` 均为 R 的 queryset |
| `Issue`                            | S；另有 `issue_objects: IssueManager -> SoftDeletionQuerySet`                                                                                                          |
| `IssueAssignee`                    | S                                                                                                                                                                      |
| `Page`                             | S                                                                                                                                                                      |
| `User`                             | U                                                                                                                                                                      |
| `WorkspaceResearchSetting`         | S                                                                                                                                                                      |
| `ResearchWorkspaceAccessGrant`     | S                                                                                                                                                                      |
| `PeriodicReport`                   | S                                                                                                                                                                      |
| `PeriodicReportProjectReference`   | S                                                                                                                                                                      |
| `PeriodicReportSnapshot`           | A                                                                                                                                                                      |
| `PeriodicReportReadReceipt`        | A                                                                                                                                                                      |
| `ReportAccessGrant`                | S                                                                                                                                                                      |
| `ResearchChainNodeTask`            | S                                                                                                                                                                      |
| `ApprovalFlow`                     | S                                                                                                                                                                      |
| `ApprovalFlowStep`                 | S                                                                                                                                                                      |
| `ApprovalRequest`                  | S                                                                                                                                                                      |
| `ApprovalAction`                   | R；保留其原有实例只追加限制                                                                                                                                            |
| `ResearchApprovalRoute`            | S                                                                                                                                                                      |
| `ResearchChain`                    | S                                                                                                                                                                      |
| `ResearchChainNode`                | S                                                                                                                                                                      |
| `ResearchChainStage`               | S                                                                                                                                                                      |
| `ResearchContextGrant`             | S                                                                                                                                                                      |
| `ResearchAgentSession`             | S                                                                                                                                                                      |
| `ResearchAgentRunEvent`            | A                                                                                                                                                                      |
| `AdministrativeOrganization`       | S                                                                                                                                                                      |
| `AdministrativeOrganizationMember` | S                                                                                                                                                                      |
| `OrgUnit`                          | S                                                                                                                                                                      |
| `OrgUnitMember`                    | S                                                                                                                                                                      |
| `MentorBinding`                    | S                                                                                                                                                                      |
| `ResearchPaperReview`              | S                                                                                                                                                                      |
| `ResearchProjectProfile`           | S                                                                                                                                                                      |
| `ResearchStageInstance`            | S                                                                                                                                                                      |
| `StageReviewerAssignment`          | S                                                                                                                                                                      |
| `StageReview`                      | S                                                                                                                                                                      |
| `StageReviewRevision`              | A                                                                                                                                                                      |
| `license.InstanceAdmin`            | S；没有独立的普通 manager                                                                                                                                              |

`SoftDeletionQuerySet` 与 `AppendOnlyQuerySet` 均继承 `TodoInvalidationQuerySet`。
所有类型的首次实例 `save` 由 `post_save` 失效。其余写入边界如下：

| 写入入口          | S / R / U                                                                                   | A                                     |
| ----------------- | ------------------------------------------------------------------------------------------- | ------------------------------------- |
| 实例更新 `save`   | 成功保存后由 `post_save` 失效；`ApprovalAction` 原有更新限制仍拒绝实例更新                  | 原有模型限制拒绝更新                  |
| QuerySet `update` | `TodoInvalidationQuerySet.update` 在提交后失效                                              | 原有 queryset 拒绝更新                |
| 实例软删除        | S 的 `save(deleted_at)` 路径由信号失效；R/U 没有软删除接口                                  | 拒绝删除                              |
| QuerySet 软删除   | S 的 `delete()` 通过 `update(deleted_at)` 失效；R/U 没有软删除语义                          | 拒绝删除                              |
| 实例硬删除        | S 的 `delete(soft=False)`、U 的原生删除由删除前后信号失效；`ApprovalAction.delete()` 仍拒绝 | 拒绝删除                              |
| QuerySet 硬删除   | S 的 `delete(soft=False)` 或 `all_objects.delete()`，R/U 的原生删除，由删除前后信号失效     | 拒绝删除                              |
| `bulk_create`     | 创建后安排失效，不依赖 `post_save`                                                          | 创建后安排失效                        |
| `bulk_update`     | Django 原生实现调用被扩展的 `.update()`，包括每批 CASE 更新                                 | 原有 `.update()` 限制拒绝非空批量更新 |

外键改绑会先记录旧归属，再按主键读取新归属，覆盖实例保存、`update`、`bulk_update`；
`InstanceAdmin.user` 改绑测试使用互不重叠的工作区成员关系验证两侧失效。
`User` 的停用、显示名和后备用户名更新会失效其成员工作区；通过 `save`、`update`、
`bulk_update` 写入登录时间等无关字段时不失效。
新用户 `bulk_create` 尚无成员关系时不会清除现有空间，后续成员创建负责失效。

`ignore_conflicts=True` 保持原有插入行为；直接带工作区字段的批次可能因全部冲突而多失效一次，
不会漏失效或修改冲突记录。`update_conflicts=True` 同时按冲突唯一键读取写入前后归属，
避免 UUID 输入主键与实际冲突记录主键不同而漏掉缓存版本更新。

审计覆盖上述声明的业务 manager。Django 自动生成的内部 `_base_manager`、`_raw_delete`
及原始 SQL 不作为业务写入入口扩展；使用这些内部接口新增直接写入时必须显式安排失效。
外键的 `PROTECT` 等原有限制保持不变，失败或回滚的事务不执行失效回调。
测试会遍历全部声明的 manager 断言实际 queryset 类型，避免新增别名 manager 再次绕过覆盖。

## 生产观测

现有 `plane.api` JSON 日志增加下列事件，不记录 SQL、参数或待办正文：

| event                                                            | 用途                           | 主要字段                                                                                                                                                                   |
| ---------------------------------------------------------------- | ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `workspace_todo_request`                                         | 每次 handler 的总耗时和 SQL 数 | `request_id`, `workspace_id`, `user_id`, `domain`, `duration_ms`, `query_count`, `result_count`, `total_count`, `status_code`, `cache_hit`, `degraded`, `degraded_sources` |
| `workspace_todo_source`                                          | 来源耗时、SQL、结果数和降级    | `request_id`, `workspace_id`, `source`, `duration_ms`, `query_count`, `result_count`, `degraded`                                                                           |
| `workspace_todo_source_failed` / `research_todo_source_degraded` | 来源故障及异常栈               | `request_id`, `workspace_id`, `source`                                                                                                                                     |
| `workspace_todo_cache_error`                                     | 缓存读、写或失效故障           | `workspace_id`                                                                                                                                                             |

`request_id` 沿用 `X-Request-Id`，缺失时生成。科研聚合会产生 `RESEARCH` 总来源和
各科研子来源记录，统计来源总耗时或 SQL 时不要将两层相加。
缓存命中不执行来源，因此只有请求记录。

上线后按工作区、domain、cache_hit 分组观察请求 P50/P95、查询量、命中率、降级率及
各来源耗时。`duration_ms` 从 handler 入口计时，包含成员校验和缓存访问，
不包含前置认证、响应序列化、网络与代理排队；接口端到端验收还需结合入口访问日志。
验收目标为真实生产请求 **P95 <= 1000ms**，不能只检查缓存命中或排除降级请求。

## 可复现验证

使用已有隔离测试容器，不能启动 `docker-compose-test.yml`，不能对生产数据库执行测试。

```bash
docker exec phase15-api-tests pytest \
  plane/tests/contract/app/test_project_domain_separation.py \
  plane/tests/contract/app/test_research_todos.py \
  plane/tests/contract/app/test_workspace_todo_cache_invalidation.py \
  -q --reuse-db

docker exec -e PLANE_TODO_LOAD_TEST=1 phase15-api-tests \
  pytest plane/tests/performance/test_workspace_todos.py -q -s --reuse-db
```

负载测试默认追加 100 份报告、300 条任务、3 个阶段，场景合计 408 条待办。
每种模式执行 60 次请求，并发度为 6；冷模式绕过响应缓存，命中模式预热后使用真实测试 Redis。
每个线程使用独立客户端和数据库连接。输出 `workspace_todos_load` JSON，包括 P50/P95、
SQL 中位数、待办总数和命中率。可通过以下环境变量调整：

| 变量                          | 默认值 | 用途                          |
| ----------------------------- | ------ | ----------------------------- |
| `PLANE_TODO_LOAD_REPORTS`     | 100    | 追加报告数量                  |
| `PLANE_TODO_LOAD_TASKS`       | 300    | 追加任务数量                  |
| `PLANE_TODO_LOAD_REQUESTS`    | 60     | 每种模式请求次数              |
| `PLANE_TODO_LOAD_CONCURRENCY` | 6      | 并发数                        |
| `PLANE_TODO_LOAD_P95_MS`      | 不设置 | 设置后同时断言冷、热 P95 预算 |

该场景使用 `DEBUG=False`、进程内 APIClient 和预认证用户，包含 Django 请求处理及序列化，
不包含实际 HTTP 传输和认证开销；大量对象共享课题和参与人，不能视为真实生产分布。
默认只输出延迟，固定查询量由契约测试断言；需要强制 1 秒预算时设置
`PLANE_TODO_LOAD_P95_MS=1000`。不要与其他 pytest 进程共用同一个测试数据库并行执行。

### 本次隔离验证记录

2026-11-06 的待办接口、权限契约、查询量、缓存失效及观测测试共 **87 项通过**。
`manage.py check`、Ruff 和 `git diff --check` 通过，迁移检查没有发现变化。
manager 审计新增了全量类型断言及 `User`、`State.all_state_objects`、`ApprovalAction`、
`InstanceAdmin` 的定向写入回归，包括提交后失效、回滚、用户 upsert 和忽略冲突的批次。

最后一次默认规模负载样本包含 408 条待办，每种模式 60 请求、并发 6：

| 模式       | P95       | SQL 数量中位数 | 命中率 |
| ---------- | --------- | -------------- | ------ |
| 冷聚合     | 约 1380ms | 50             | 0%     |
| 预热后缓存 | 约 187ms  | 3              | 100%   |

冷路径样本未达到 1000ms 预算。该样本用于记录隔离容器中的查询和缓存收益，
不构成生产基线或上线验收，实际部署仍需检查整体请求 P95。

扩展共享业务回归没有全通过：旧全局科研开关、管理员标签准入、阶段自动初始化等用例失败。
选取 7 个代表失败用例，在隔离测试进程中恢复 HEAD 的原 `stage_resource` 后仍出现相同断言失败；
全局科研开关的 HEAD 实现也已固定返回开启。本次没有修改这些旧业务规则或测试预期，
不能将待办测试通过表述为整个应用回归通过。

## 发布与回退

本次代码不自动部署。发布时需更新所有 API 和执行相关写入的 worker 进程，
保证缓存读取和写入失效逻辑同时生效。保留生产观测样本，比较同等流量下的整体与冷路径 P95。
若目标未达到，按来源日志继续定位 SQL、CPU 或排队成本。

回退使用项目原有发布流程回退本次后端变更并重启相关进程，无需回退数据库迁移；
旧响应缓存最多在 5 秒后自然过期，无需清空整个 Redis。
