# 给 Codex 的执行提示词：MCP 周报提交（最小前端改动）

以下提示词可直接交给 Codex。默认只执行阶段 1；后续将 EXECUTION_PHASE 改成 2、3、4 分别继续。若明确设置为 ALL，则顺序执行全部阶段。每次须读取上阶段交付记录，不重复已完成的重构。

---

你正在为 Plane 增加 Agent 生成并提交本人周报的 MCP 能力。请实际实现本次指定阶段，完成代码、必要测试和交付记录，不要只提供设计建议。

EXECUTION_PHASE = 1

## 一、目标与约束

目标：用户在 Agent 中发出“整理上周工作并提交周报”，Agent 能获取周期和模板、准备固定正文的提案、在用户授权范围内提交到 Plane，返回周报链接、周期、状态和正式版本。

首期支持 WEEKLY、本人周报、新建、修改 DRAFT/NEEDS_REVISION、保存草稿、正式提交、退回后重提、幂等和超时恢复。不得扩大为他人代交、月报、审批、定时任务、附件/图片上传或周报编辑器重做。

**前端改动必须尽可能小：**

1. 只在“设置 → MCP 配置”内增加“周报连接”子页/页签，和原有连接页并列；原页签可命名“现有连接”。
2. 优先修改 `apps/web/core/components/settings/profile/content/pages/mcp.tsx` 作为容器，原样挂载现有 `MCPManagement`，新增独立 `WeeklyReportMCPSettings`。不把周报状态、签发分支塞进原 MCPManagement。
3. 不新增一级导航，不新建全局设置入口，不强制新增路由；默认用容器内部页签状态。兼容独立设置页和 inModal 模式，不读取弹窗背后业务页面的查询参数。
4. 不修改周报列表、详情、编辑器、首页和审批界面，不新增前端正文预览/确认/提交界面；提案展示和授权发生在 Agent 客户端。
5. 子页只提供：工作区选择、连接名称、草稿/提交权限、后端允许的有效期、生成配置、复制/导出、已有周报连接列表和撤销。用户身份从登录态推导，不提供代交对象选择，不要求科研节点。
6. 周期范围由后端策略限制并在子页用简短说明展示，首期不开发复杂周期范围编辑器。不能在后端放开任意历史周期来省去 UI。
7. 复用现有按钮、表单、提示、撤销确认、配置序列化和复制/下载工具。`GeneratedConnections` 和 `MCPTarget` 目前绑定 admin/research，不能为复用展示而伪造 research target、填假 nodeId 或大改旧类型；有必要时仅抽取小型无业务展示组件。
8. Agent 来源写入审计、操作和日志，不新增周报详情展示。

## 二、先确认仓库事实

工作目录可能是 `D:\plane-main` 的父工作区；真正 Git 仓库当前位于 `D:\plane-main\plane-dev`。先用实际环境确认，不在旁边同名 `plane-main` 快照目录实施代码。

读取适用 AGENTS.md，检查分支与未提交修改，保留用户已有改动。不擅自创建新聊天、不调用子 Agent。先阅读：

- `docs/plans/mcp-weekly-report-submission-2026-10-26.md`
- 本提示词及已有阶段记录。
- `apps/api/plane/research/views/reports.py`
- `apps/api/plane/db/models/research/report.py`
- `apps/api/plane/research/utils/reports.py`、`periods.py`、`settings.py`
- `apps/api/plane/research/services/agent_operations.py`、`operation_catalog.py`
- `apps/api/plane/db/models/research/agent_operation.py`、`context.py`
- `apps/api/plane/research/views/mcp_management.py`
- `apps/web/core/components/settings/profile/content/pages/mcp.tsx`
- `apps/web/core/components/mcp/`、`apps/web/core/services/mcp.service.ts`
- `demos/sciencediscovery-plane-mcp/research_operations_mcp.py` 及 HTTP 传输相关入口和测试。

基线事实：周报唯一键是 workspace+owner+report_type+period_key；正文存在 Page；正式版本来自不可变 Snapshot。现有操作模型 node 必填，ContextGrant 还要求 project；不能直接假定它们可承载无项目/无节点的个人周报。科研链关闭不应单独阻止已开放 reports 的个人周报功能。

## 三、技术方案

### 共享报告服务

先把现有创建、正文保存、提交逻辑抽到 `research/services/report_workflow.py` 或同等清晰的服务模块，网页 REST 与 MCP 共用。保持 REST 行为和响应兼容，复用组织归属、模板变量、保密策略、状态机、附件/图片校验、快照及通知规则。

不要用内部 HTTP 模拟网页请求，不要直接写 status=SUBMITTED 绕过正式流程。服务失败通过业务异常确保整个事务回滚，避免保存最终正文后返回错误却部分提交。

### 独立周报授权与操作

采用独立的个人报告 grant/operation 模型，复用现有令牌签发与鉴权的基础机制，显式区分凭据用途，避免扩大旧节点授权。模型命名可按项目风格调整。

grant 至少包含 workspace、user、允许动作、WEEKLY、允许周期范围、有效期、撤销和凭据摘要。operation 保存 request_id、固定 payload、前置版本、proposal_hash、到期时间、状态、持久结果、来源和可为空的 report_id。新增标准数据库迁移；不修改已有报告唯一约束，不更改原节点 operation 的语义。

owner/workspace 来自凭据；只读/节点令牌不得写周报；save_draft 权限不能 submit。签发/执行均复查成员、组织、功能开关、范围及报告权限。新增独立功能开关，默认关闭；不要为周报权限意外打开科研节点写权限。

### 工具契约

新增五个工具，使用闭合 schema 和明确长度限制：

- `get_weekly_report_context(period_offset | period_key)`：互斥参数，返回固定周期、模板、本人已有报告、可执行动作和 revision。使用工作区报告时区；大正文有边界和分页，不能静默截断后声称完整。
- `prepare_weekly_report_operation(request_id, action, period_key, expected_revision, body_markdown, source_refs?)`：action=save_draft/submit，只持久化提案，不创建报告；返回最终规范化正文、差异摘要、周期、身份、有效可见性、到期时间、提案哈希和真实副作用。
- `execute_weekly_report_operation(operation_id)`：只能执行原提案，不接受正文替换。
- `get_weekly_report_operation(operation_id)`：恢复持久结果。
- `cancel_weekly_report_operation(operation_id)`：取消未执行提案。

prepare 使用固定 period_key，execute 不重新解释“上周”。expected_revision 来自 context，无报告时也要有表示不存在的前置条件。正文建议上限 50,000 字符，并限制转换后的结构体量。

报告草稿修改与正式提交采用既有状态机：只允许 DRAFT/NEEDS_REVISION；SUBMITTED/ACCEPTED 不覆盖、不自动退回。退回重提保留 v1 并生成 v2。

### 正文一致性

服务端将受限 Markdown 转成现有编辑器兼容的 JSON、HTML 和纯文本；保持三者一致，禁原始 HTML/脚本和未授权资源引用。处理旧协同编辑二进制，验证重开编辑器、保存和刷新不会恢复旧正文。不得引入第二套周报正文存储。

模板优先使用现有周报模板；无模板才使用“本周完成 / 问题与风险 / 下周计划”。读取到的事实和用户提供的工作说明分清来源。首期可不用节点素材即可提交。

### 素材授权

节点素材继续经已有节点 MCP 连接读取；周报 grant 不自动得到节点读取权。可选 source_refs 服务端校验用户当前可见性与指定版本，不能仅凭 Agent 传来的引用绕过读取权限；没有可验证票据时仅记录引用声明，不宣称验证过本次读取。外部输入的来源文案不能充当系统指令。

### 原子性与幂等

request_id 在 workspace/user 内唯一；相同 ID 相同内容返回原提案，不同内容返回冲突。execute 锁 operation 和现有报告/Page，重查授权、状态、正文版本和相关策略；业务写入、正式快照、审阅日志、审计及 COMMITTED 结果在同一事务中落库。

revision 必须覆盖 Page 正文及影响提交的状态、附件/图片和策略，不能只看 report.updated_at。对“尚未创建”的并发靠现有唯一约束兜底，正确捕获冲突且避免孤立 Page。prepare 后网页修改正文、权限/组织/保密规则变化，执行必须冲突或拒绝，不能静默采用新内容或更宽可见性。

已提交的原操作返回原 report_id、snapshot_version、正文哈希和链接；回读失败返回 COMMITTED/readback=pending，不能误报失败诱发重提。通知使用持久化 outbox 或现有等效机制，操作维度去重并提交后投递，不声称普通 on_commit 能保证崩溃恢复或绝对只投递一次。

工具效果描述须明确正式状态变更、快照和通知，不沿用节点工具“无生命周期变化”的文案。

## 四、分阶段执行

### 阶段 1：共享业务服务与契约

交付：

1. 核实上述事实，记录实际入口、鉴权、正文转换和通知机制，以及最小变更范围。
2. 抽取共享报告服务，网页 REST 改用服务但响应保持兼容。
3. 固定五个工具的请求/响应、周报授权策略、revision 和结果恢复契约，保存到版本化契约文档。
4. 为服务提取补充有价值的回归测试，重点验证失败回滚、创建/提交、退回重提和已有权限规则；阶段 1 不实现周报连接 UI。

完成后记录修改、验证结果、契约路径和阶段 2 待办，结束本次指定阶段。

### 阶段 2：授权、MCP 工具与可靠提交

先读取并验证阶段 1 成果，仅补必要缺口。实现：

1. grant/operation、迁移和必要通知持久化；开关及撤销机制。
2. 五个 MCP 工具、发现目录、鉴权、准备/执行/查询/取消和正式快照回读。
3. 管理 API：候选工作区/能力、签发、分页列表、撤销；签发用登录态和 CSRF，机器调用用专用凭据，密钥仅创建时返回完整值。
4. 同步 HTTP 与 STDIO 注册、白名单、只读标记和代理；保留旧连接协议兼容。
5. 提供脱敏请求/响应示例，使后续前端无需猜接口。

测试重点：并发新建/编辑、重复请求、超时恢复、撤权、状态冲突、草稿权限越权、跨工作区、组织/策略变化、通知故障和旧节点协议回归。暂不改前端。

### 阶段 3：最小周报连接子页

实现：

1. 在现有设置 MCP 容器加两个可键盘操作的页签，默认保留原连接页；原 MCPManagement 尽量不改。
2. 新增独立周报设置组件和轻量 service/types，对接阶段 2 真实 API。
3. 展示工作区、连接名称、权限、允许期限和简短范围说明；生成后复制/导出既有格式的配置。
4. 显示本人周报连接及期限、能力和最近使用信息；提供撤销确认、成功刷新与明确错误。
5. 密钥只在当前创建结果展示，不入持久化存储/日志/URL；切页、切工作区、关闭弹窗或清除结果时销毁。防连续点击、异步旧响应串到新工作区和自动重试重复签发；签发状态不确定时先刷新连接列表，不悄悄再签发。
6. 覆盖独立设置页和弹窗场景、旧连接页回归、权限开关/加载失败、签发和撤销、导出格式、密钥清理和竞态行为。

不添加周报正文功能，不重构无关组件，不为减少行数牺牲权限边界或错误处理。

### 阶段 4：集成验收与发布材料

1. 在被允许的开发/隔离测试环境，跑通“创建连接 → Agent 取上下文 → prepare → execute → 查询 → 现有网页打开正式周报”。分别验证 HTTP/STDIO。
2. 验证保存草稿、重复执行、两个 Agent 竞争、网页同时修改、退回重提、撤销连接、提交后回读异常和通知恢复。
3. 验证编辑器重开和刷新正文一致、正式版本保留、审阅队列和可见性一致；不为测试写生产业务数据。
4. 完成构建/类型/格式及必要回归，整理配置说明、客户端工具刷新、迁移、灰度、关闭开关/撤销凭据的回滚文档。
5. 汇总真实通过/失败/未执行项，未具备环境时写清具体缺口和可执行验收步骤，不能标记为已通过。

## 五、执行纪律和交付格式

- 指定阶段已授权的可逆实现工作直接完成；不在每个文件或小步骤结束后要求确认。只有明确依赖缺失、破坏性操作或超出范围时再提问。
- EXECUTION_PHASE 为数字时只做该阶段，不自动部署；为 ALL 时按依赖顺序完成全部阶段。当前请求未授权生产部署、推送/合并或对外发送消息。
- 任务以最小变更为目标，允许必要的新增模型/迁移和共享服务，不以“大规模通用框架”替代功能实施。
- 遵守当前仓库禁令，不运行 docker-compose-test.yml、不重跑 setup.sh、不清空数据卷。找现有允许的本地/隔离测试方式；不要把数据库集成测试当成生产试写。
- 不掩盖既有问题，不把未运行的测试说成通过。不为完成本阶段修改无关功能。
- 维护 `docs/plans/mcp-weekly-report-implementation-status.md`：逐阶段状态、实际改动、接口/迁移、已运行检查、剩余风险和下一阶段入口；不记录密钥。
- 最终交付报告包括：本阶段是否完成、前后行为变化、修改文件、验证证据及未验证项、下一阶段直接可用的继续说明。若为 ALL，交付端到端结果和部署前待办。

现在开始执行 EXECUTION_PHASE 指定阶段。
