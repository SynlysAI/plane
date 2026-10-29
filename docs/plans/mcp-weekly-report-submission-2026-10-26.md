# MCP 个人周报生成与提交实施方案

日期：2026-10-26。依据本地 `plane-dev` 当前代码编写；未核验线上版本，未执行部署。本文件是待实施方案，以下新工具和文件尚未实现。

2026-10-26 范围收敛：前端仅在设置的 MCP 配置页新增“周报连接”子页，保留原连接页；不修改周报列表、详情、编辑器、首页或审批界面。Agent 来源只落库到操作结果、审计和既有日志，不新增详情展示。具体分阶段执行提示词见同目录 `mcp-weekly-report-codex-prompt-2026-10-26.md`；与本文前端建议冲突时，以该收敛范围为准。

## 1. 交付目标与首期范围

用户在已连接 Plane 的 Agent 中说“整理上周工作并提交周报”，Agent 可以读取授权素材，编写正文，准备固定内容的提案，在用户授权范围内执行，最后返回 Plane 周报链接、周期、提交状态和正式版本号。

首期支持：本人 WEEKLY 周报、新建或修改 DRAFT/NEEDS_REVISION、保存草稿、正式提交、重复请求恢复、已有周报冲突处理。沿用工作区时区、模板、组织归属、保密策略及现有审阅流程。

首期不扩展他人代交、审批通过/退回、月报、附件上传、自动定时运行。用户提供的工作描述可作为素材；Plane 节点素材通过现有节点连接读取。没有节点连接也可生成并提交本人周报。

## 2. 已确认的实现基础

| 现有代码                                                      | 可复用能力 / 约束                                                                     |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `apps/api/plane/research/views/reports.py`                    | 创建、编辑、提交、快照、审阅日志、通知；业务逻辑目前主要在 View 内                    |
| `apps/api/plane/db/models/research/report.py`                 | `PeriodicReport` + 独立 `Page` 正文 + 不可变 `PeriodicReportSnapshot`                 |
| 同上                                                          | 活跃报告按 workspace、owner、report_type、period_key 唯一，**不按项目或节点分别创建** |
| `apps/api/plane/research/utils/periods.py`                    | ISO 周一至周日，工作区报告时区解析周期                                                |
| `apps/api/plane/research/utils/reports.py`                    | 草稿/退回可编辑；已提交/已接受不能直接覆盖                                            |
| `apps/api/plane/research/services/operation_catalog.py`       | 当前五类写入 action 均不包含报告创建或提交                                            |
| `apps/api/plane/research/services/agent_operations.py`        | 不可变提案、请求幂等、执行时重验、提交后回读的设计可复用                              |
| `apps/api/plane/db/models/research/agent_operation.py`        | 现有 Operation 的 node 必填，不适合直接承载独立个人周报                               |
| `apps/api/plane/research/views/mcp_management.py`             | 当前科研连接候选和授权入口均以节点为中心，需要新增个人周报入口                        |
| `demos/sciencediscovery-plane-mcp/research_operations_mcp.py` | STDIO 代理采用工具名白名单，新工具需同步注册                                          |

## 3. 推荐架构

在统一 MCP 管理页新增“个人周报”连接类型。独立授权、独立操作记录，调用现有报告业务服务；保留原节点 MCP 协议。

```text
Agent
  ├─ 现有科研节点 MCP：读取被授权节点证据（按需）
  └─ 新个人周报 MCP：查本人周报 → 准备提案 → 执行 → 查询结果
                                      │
                           共享报告业务服务
                                      │
                   Page / PeriodicReport / Snapshot
                                      │
                           审阅日志 / 审计 / 通知
```

报告归属从登录用户的培养课题/主组织关系解析，不能把取材节点的 project 直接当作个人周报所属 project。团队课题引用只能从本人有权引用的项目选择。

不建议直接给 `prepare_research_operation` 加一个 `submit_report` action 后就上线：它还受节点状态、节点管理权和节点回读约束，既无法覆盖无节点用户，也容易让节点权限被误当成个人报告权限。

## 4. MCP 工具契约（拟新增）

| 工具                              | 参数摘要                                                                         | 行为                                                                                             |
| --------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `get_weekly_report_context`       | `period_offset` 或 `period_key`，二者互斥                                        | 解析为固定周期，返回本人已有报告、状态、revision、模板、有效可见性、可用操作；正文较长时分页返回 |
| `prepare_weekly_report_operation` | `request_id, action, period_key, expected_revision, body_markdown, source_refs?` | action 为 `save_draft` 或 `submit`；校验并生成不可变提案，不创建/修改业务报告                    |
| `execute_weekly_report_operation` | `operation_id`                                                                   | 提交固定提案；禁止携带替换正文或切换周期                                                         |
| `get_weekly_report_operation`     | `operation_id`                                                                   | 查询原操作与持久化结果，恢复超时调用                                                             |
| `cancel_weekly_report_operation`  | `operation_id`                                                                   | 取消未执行提案                                                                                   |

所有工具使用闭合 schema、长度限制和规范化校验。owner/workspace 从凭据推导，不接受客户端传入任意 owner。首期建议 Markdown 正文上限 50,000 字符，转换后的节点数/大小也设上限。工具列表按实际授权返回，不能只依赖客户端隐藏按钮。

`expected_revision` 必填：来自 context 的不透明版本令牌；无报告时返回表示“该周期尚不存在”的令牌。提交请求一律使用已经解析的 `period_key`，不能在执行时重算“上周”。例如工作区时区为 Asia/Shanghai，2026-10-26 的上周为 `2026-W43`，范围为 10-19 至 10-25。

拟定调用示例：

```json
{
  "request_id": "weekly-2026-W43-run-001",
  "action": "submit",
  "period_key": "2026-W43",
  "expected_revision": "<context 返回的版本令牌>",
  "body_markdown": "## 本周完成\n完成事项及结果。\n\n## 问题与风险\n待解决的问题。\n\n## 下周计划\n计划及预期产出。",
  "source_refs": [],
  "reviewer_id": "<从 context.approval.candidates 选择的 UUID>",
  "cc_user_ids": []
}
```

模板优先使用工作区周报模板；没有模板才使用上述默认结构。提案返回最终渲染正文、差异摘要、周期、本人身份、报告 ID 或待新建标记、可见对象、模板版本、proposal_hash、到期时间及预期副作用。

## 5. 授权与素材

新增 `ReportAgentGrant`，记录 workspace、user、允许动作、WEEKLY 类型、有效期、撤销时间和凭据摘要；复用已有令牌签发/鉴权基础，但显式区分用途。允许限定周期范围，默认不授予任意历史周期补交权限。所有执行均重查账号、工作区成员、报告功能开关、组织关系和当前报告 ACL。

“保存草稿”和“正式提交”分别授权；只有草稿权限的连接不能执行 submit。旧节点令牌和普通只读令牌不能调用周报写入工具。现有管理员可代交的网页能力不自动开放给 Agent，首期强制 owner=user。

用户选择节点作为素材时仍使用原节点 MCP 凭据。周报凭据不自动获得节点读取权。`source_refs` 可携带节点、资源、版本和摘要哈希用于溯源；后端须独立验证该用户当前可见性，引用本身不能成为读取授权。若需要机器可验证的“本次确实读取过”，由原节点读取接口签发短期证据票据并在 prepare 时核验；首期没有票据时不得宣称已验证读取，只记录为引用声明。

事实须来自实际读取的证据或用户输入；将进展、已完成结果与后续计划分开。附件只有元数据时不能声称解析了附件内容。跨多个授权节点可汇总到同一份个人周报。

沿用“准备提案 → Agent 客户端授权 → 执行”的交互，不增加 Plane 平台二次审批。用户已经明确授权具体周期和提交动作时按既有授权继续；未授权提交时先展示完整提案并取得授权。持有技术凭据与客户端取得人的具体授权是两层不同约束，后端不可声称能仅凭 execute 请求证明人看过正文。

## 6. 抽取共享报告服务

新增 `apps/api/plane/research/services/report_workflow.py`，由网页 REST 和 MCP 共用：

- `resolve_report_context(...)`：身份、主组织、培养课题、模板、时区、可见性与周期。
- `create_report_draft(...)`：保留现有唯一性、Page 和团队课题引用规则。
- `save_report_body(...)`：统一正文校验、规范化保存与版本冲突检查。
- `submit_report(...)`：锁报告和 Page，检查可提交状态，冻结快照、附件/图片清单，记录提交日志及审计。

MCP 不经内网 HTTP 伪装网页请求，也不直接更新数据库状态。先抽服务并验证网页行为未改变，再接新工具。

正文由服务端受限 Markdown 转成编辑器兼容的 JSON/HTML/纯文本，保持三者内容一致。拒绝原始 HTML、脚本、未授权资源引用；首期不接收图片/附件上传。清空或重建旧的协同编辑二进制，防止打开编辑器后旧正文覆盖新内容。验证网页编辑器再次打开、保存、重载后的正文一致性。

## 7. 原子执行、并发与恢复

新增 `ReportAgentOperation`，保存 grant、workspace、user、周期、action、request_id、规范化 payload、source_refs、preconditions、proposal_hash、expires_at、status、result；report 外键允许为空，因为 prepare 时不创建业务报告。对 workspace/user/request_id 建唯一约束。

执行事务顺序：

1. 锁操作记录并重验凭据；已 COMMITTED 的操作返回原结果，不再次执行业务操作。
2. 重验提案哈希、有效期、报告功能、组织关系、当前模板/可见性策略、素材权限与版本。
3. 锁现有 Report、Page 及相关可变状态，比较 revision。revision 覆盖报告状态、正文、附件/图片及相关策略；不能只比较 report.updated_at，因为正文存在 Page。
4. 无报告则新建，依靠现有用户/周期唯一约束拦截并发；捕获唯一冲突并返回重新准备要求，不能静默覆盖另一份报告。
5. 保存规范化正文；submit 动作接着生成新正式快照，更新为 SUBMITTED，写审阅日志、Agent 溯源、审计及通知 outbox。
6. 同一事务写入 COMMITTED 和 report_id、snapshot_version、正文哈希、URL、audit_id。任一步失败整体回滚。
7. 提交后回读目标正式快照；回读失败返回已提交 + readback=pending。客户端查询同一 operation_id，不重新创建操作。

通知采用持久 outbox/既有等效机制，按 operation_id 和事件类型去重，由 Worker 在事务提交后投递。单用 on_commit 只能避免提前通知，不能解决提交后进程崩溃丢通知；外部投递按至少一次处理，并尽可能使用幂等键。

不同 request_id 针对同周期也必须服从报告状态机：SUBMITTED/ACCEPTED 不再覆盖、不自动退回、不再生成快照。NEEDS_REVISION 可重新准备并提交，产生下一正式版本。

建议错误码：`report_revision_conflict`、`report_already_submitted`、`report_owner_denied`、`report_org_required`、`report_period_denied`、`grant_revoked`、`source_changed`、`proposal_expired`、`idempotency_conflict`。冲突后展示差异并重新准备，不能自动替用户接受更新后的内容。

## 8. 工程改动清单

| 层         | 改动                                                                                                       |
| ---------- | ---------------------------------------------------------------------------------------------------------- |
| 共享业务   | 新增 report_workflow.py；改 reports.py 复用服务，保留 REST 响应兼容                                        |
| 数据库     | 新增报告 grant、operation 和必要的通知 outbox 模型/迁移；保留现有报告唯一约束                              |
| MCP 服务   | 新增 weekly_report_catalog.py、weekly_report_operations.py 及对应鉴权/视图/路由；独立报告状态和回读解析器  |
| 管理后端   | mcp_management.py 增加个人周报候选、创建、列出、撤销；使用 reports 能力检查，不要求 research_chain 开启    |
| 前端       | 仅在设置的 MCP 配置页新增周报连接子页：工作区、名称、草稿/提交权限、期限、配置导出及撤销；不改周报业务页面 |
| HTTP/STDIO | 注册新工具及对应只读标记，更新白名单、协议说明与兼容性测试；旧节点连接不能获得新能力                       |
| 文档       | 配置样例、客户端提示、错误恢复、发布及回滚说明；刷新已连接客户端的工具目录                                 |

不要复用旧节点操作的通用 effects 文案：当前文案声称“无生命周期变化、无外部调用”，与正式提交和通知不符。新提案必须明确“生成正式版本、变更提交状态、进入现有审阅及通知流程”。

## 9. 验收标准

- 无培养课题但有合法主组织的用户，可不选择节点提交本人周报；缺组织时返回现有业务错误。
- 指定周期/上周解析正确，覆盖周日跨周、ISO 跨年和工作区时区；prepare 到 execute 跨周不改变周期。
- 首次 submit 只生成一份 Report、一份 Page、一个 v1 快照，网页详情、编辑器、正式版本和审阅队列显示一致。
- save_draft 不产生正式快照或提交通知；退回重提生成 v2，v1 不变。
- 同 request_id 同 payload 返回同一提案；不同 payload 冲突；重复 execute 和超时恢复不重复创建快照/审阅日志/通知事件。
- 两个 Agent 或网页与 Agent 并发操作时只有一方按原 revision 成功，另一方得到明确冲突；覆盖无报告并发创建。
- 授权撤销、账号禁用、成员移除、组织/保密策略变更、素材权限撤销和版本变化在执行前均生效。
- 只读节点令牌、只有草稿能力的周报令牌不能正式提交；不能代交他人、跨工作区或超出周期授权范围。
- 已提交和已接受报告不可直接覆盖；回读故障不能把已提交误报为未提交。
- 模板变量正确展开；Markdown 转换和编辑器重载一致；不一致/非法正文在准备阶段失败。
- 现有网页报告流程、节点 MCP 和只读 MCP 回归通过；HTTP、STDIO 工具发现与错误语义一致。

## 10. 实施顺序与发布

以熟悉该项目的一名工程师估算，首期约 5–7 个工作日，取决于正文转换、通知机制和现有测试环境；这是实施估算，不是已验证工期。

1. 第 1–2 天：抽取报告共享服务，固定正文转换与 revision 规则，完成网页回归。
2. 第 3–4 天：授权/操作模型、迁移、MCP 工具、事务执行及恢复测试。
3. 第 5 天：统一管理页、配置导出、HTTP/STDIO 注册。
4. 第 6–7 天：并发、撤权、编辑器及通知故障验收，小范围发布。

新增周报 MCP 开关，初始关闭；按现有发布流程备份、跑迁移、更新 API/Worker 和前端，给测试用户单独创建周报连接后验收，再开放其他用户。回滚先关闭新能力并撤销新凭据，保留已提交报告、正式快照、操作结果和审计数据，不删除业务数据或强行逆迁移。

遵守本仓库 AGENTS.md：不启动被禁用的 docker-compose-test.yml 测试栈；测试采用当前允许的本地/独立测试环境，不向生产业务数据写入验收案例。
