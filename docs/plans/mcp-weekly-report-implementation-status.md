# MCP 周报提交实施状态

更新日期：2026-10-26（Asia/Shanghai）。本次 EXECUTION_PHASE = 4（隔离集成验收与发布材料，不新增前端功能）。

| 阶段                  | 状态                                                           | 交付                                                                                                                                                 |
| --------------------- | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 共享业务服务与契约  | 已完成；扩展图片套件存在已复现的基线失败，见下文               | 共享服务、REST 接入、18 项新增数据库回归、v1 契约及请求 schema                                                                                       |
| 2 授权与 MCP 可靠提交 | 已完成；默认关闭、未部署，浏览器与负载验收见剩余项             | 独立模型/0201 迁移、目的隔离凭据、五工具、管理 API、受限正文/完整 revision、可靠结果与 HTTP/STDIO；179 项后端、36 项传输通过                         |
| 3 周报连接子页        | 已完成；未部署；阶段 4 已补隔离浏览器/SDK 验收                 | 独立页签、本人连接管理、配置复制/导出、密钥清理与竞态恢复；79 项相关测试通过，Web 类型检查通过；全组件回归 727 通过/12 个原版同名失败，见下文        |
| 4 集成验收与发布材料  | 已执行并完成可用环境验收及材料；生产保持关闭，放量前缺口见末节 | 5 项新增真实网络集成、179 项原后端回归、36 项代理、79 项前端回归通过；隔离构建、真实浏览器、HTTP/STDIO、编辑器与 v2 验收；锁/灰度/窄屏等限制如实保留 |

## 阶段 1 仓库与修改保护（历史记录）

- 实际 Git 根目录：`D:\plane-main\plane-dev`；`D:\plane-main` 不是 Git 仓库，没有在旁边同名快照目录实施。
- 分支：`fix/sd-mcp-optional-binding`；本次基线 HEAD：`143eb5443386aa3a7fa2e3062b25d8e201949d65`。
- 已读取唯一适用的根 `AGENTS.md`；相关后端、前端和 demo 子目录未发现更深的 AGENTS.md。
- 开始时已有修改并保留：`deployments/windows/frontend-local.ps1`、`docs/operations/research-mcp-v21-deployment.md`；已有未跟踪 `apps/api/plane/backups/`、`docs/operations/mcp-server-backend-setup.md`、`docs/operations/mcp-v22-deployment.md` 和本功能的两份输入方案文档。没有覆盖、暂存、提交或清理这些内容。
- 没有调用子 Agent，没有创建聊天，没有部署、推送、合并；没有运行 docker-compose-test.yml、setup.sh，也没有操作业务数据库或数据卷。

## 阶段 1 核实的代码事实与最小范围

| 事项           | 实际入口/结论                                                                                                                                                                                                                                                                                       |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 网页 REST      | `research/views/reports.py` 的 ListCreate.post、Detail.patch、Submit.post；URL 前缀 `/api/research/workspaces/<slug>/reports/`，提交为 `<id>/submit/`                                                                                                                                               |
| 工作区鉴权     | `ResearchAPIView.get_workspace(section="reports")` 检查工作区非访客成员、有效科研组织关系、NAV_REPORTS 和报告开关；共享服务接收已解析的 workspace/actor，不能作为免鉴权入口公开                                                                                                                     |
| 报告权限       | 正文保存沿用 report_resource/check_access(edit)；提交沿用本人或 research admin；MCP 本人限制仍须阶段 2 额外强制，不把 REST 管理员能力扩给凭据                                                                                                                                                       |
| 身份/组织/模板 | 活跃 PHD/MASTER/POSTDOC 培养课题优先，否则有效主组织成员；团队课题引用必须是本人项目成员；模板选择/变量展开、时区、可见性上限及保密子树沿用现有工具                                                                                                                                                 |
| 唯一性         | PeriodicReport 活跃行唯一键 workspace+owner+report_type+period_key；不是按 project/node 分报告；project 可 null                                                                                                                                                                                     |
| 正文/正式版本  | 正文在唯一关联 Page；Page.save 从 HTML 更新 description_stripped；正式内容来自追加式 PeriodicReportSnapshot，含 JSON/HTML/纯文本/二进制、附件/图片清单                                                                                                                                              |
| 编辑器/转换    | PageBinaryUpdateSerializer 校验二进制、清洗 HTML、校验报告图片；现有 files.markdown_to_html 及附件 Markdown 导入仅有 HTML 初始表示，不满足新 MCP 的三种表示一致性，不能直接当成新转换器使用                                                                                                         |
| 协同二进制     | report-body 优先非空 JSON，再用 HTML；新正文无二进制输入时共享保存清空旧 Page.description_binary，提交也执行该规则。数据库层已测，浏览器重开/保存/刷新尚未验证                                                                                                                                      |
| 通知           | utils/notifications.notify_report_submitted 同步 bulk_create Notification（entity_name=research_report），没有该函数触发的外部投递；本次将其纳入业务事务，不把它描述为已有异步 outbox/邮件送达保证                                                                                                  |
| 原节点授权     | ResearchAgentOperation.node 必填；ResearchContextGrant.project 必填，旧签发/鉴权依赖节点作用域，不能直接承载无节点/无项目个人周报                                                                                                                                                                   |
| MCP/传输       | services/agent_operations.py、operation_catalog.py；机器 HTTP 入口 views/agent_operations.py 的 `/agent-operations/mcp/`，继承 agent_access 的协议实现；demo research_operations_mcp.py 有独立白名单/只读标记，research_client.py 有 256 KiB 响应预算；阶段 2 需独立注册/调整新传输预算，保留旧协议 |
| 设置前端       | mcp.tsx 当前只挂载 MCPManagement；MCPTarget/GeneratedConnections 绑定 admin/research；阶段 3 使用独立周报组件，不伪造 research target/nodeId；现有 inModal 不读背后页面查询参数的规则继续保留                                                                                                       |

最小变更：仅报告后端共享服务、三处 REST 适配、相关测试和契约文档。本次没有前端、模型、迁移、路由、授权签发器或旧节点 MCP 实现修改；周报列表、详情、编辑器、首页和审批前端均未改动。

## 阶段 1 实际代码

- 新增 `apps/api/plane/research/services/report_workflow.py`：
  - `resolve_report_context`：复用现有周期/培养课题或主组织/团队课题/可见性/模板解析，不创建业务报告。
  - `create_report_draft`：原子创建 Page、可选 ProjectPage、Report、团队引用、审计；唯一冲突在内部 savepoint 外转换为业务异常，避免遗留 Page。
  - `save_report_body`：锁 Report/Page，沿用编辑权限、模板变量及 Page serializer；模板更新和正文校验失败整体回滚。
  - `submit_report`：锁 Report/Page，沿用状态机和图片附件校验；正文、不可变快照、附件正式版本、审阅日志、审计和站内通知同事务提交。
  - `ReportWorkflowError`：携带原 REST 错误载荷与状态，在原子块外由视图转成响应；不把 Response 作为业务失败返回值。
- `apps/api/plane/research/views/reports.py`：创建/正文 PATCH/提交调用服务，保留 URL、成功状态、序列化和错误形状；列表/审阅/访问控制继续原入口。
- 修复行为：提交已保存最终正文后图片清单校验失败，原先正常返回错误可造成正文部分提交，现在异常回滚；审计/通知异常也不会留下“已提交但失败”的半成品。提交替换正文时未提供新二进制会清除旧协同状态。
- 新增 `apps/api/plane/tests/contract/app/test_report_workflow.py`（18 个实际用例）；原 `test_research_reports.py` 只将并发提交测试的 snapshot patch 目标移动到新服务，测试断言保留。

## 阶段 1 接口/迁移与契约

- 本阶段没有新增对外端点或数据库迁移；没有改报告唯一约束、旧 grant/operation 语义或默认开关。
- [v1 契约](mcp-weekly-report-contract-v1.md) 固定五工具请求/响应、闭合字段、授权/周期范围/期限、正文/分页边界、revision 前置条件、固定提案哈希、取消/过期、错误、幂等及 COMMITTED/readback=pending 恢复。
- [五工具请求 JSON Schema](mcp-weekly-report-contract-v1.schemas.json) 供阶段 2 目录实现使用；schema 文件自身不是已运行的 MCP 工具。
- 首期只允许工作区报告时区的本周与上周；默认关闭的独立周报开关及 1/7/30 天可选期限在阶段 2 落实。Markdown 转换器、完整 revision、purpose 凭据和来源版本校验本阶段只冻结契约，没有假称已实现。

## 阶段 1 实际验证与证据

测试环境：独立任务容器 `plane-weekly-phase1-postgres-20261026`，PostgreSQL 15.7，绑定 `127.0.0.1:55439`，tmpfs 数据目录，无挂载业务卷。Django 5.2.15 / Python 3.11.8 / pytest 9.1.1。测试仅使用 `test_weekly_phase1_20261026`，LocMemCache、内存任务 broker、禁用节流及最小会话中间件；不是生产环境等价验证。
本地运行材料在忽略目录 `.runtime/weekly-report-phase1/`，无业务密钥；测试专用依赖 pytest-mock 已补齐。

| 检查                                            | 实际结果                                                                                                                                            | 证据                                                                     |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| 最终核心回归：新服务 18 项 + 既有周报完整 47 项 | **65 passed，28.42s**；含并发提交/审阅、创建/月报兼容、无项目主组织、模板、权限/保密、版本状态机、两种图片格式、三类 serializer 错误形状            | final-core-regression.log；中间重跑不重复计数                            |
| 回滚与原子性                                    | 通过：保存最终正文后 image_manifest 失败；审阅日志/审计/通知实际写后抛错；外层 operation 结果写失败；唯一冲突无孤立 Page；模板+无效二进制共同回滚   | 新服务测试                                                               |
| 正式版本/附件图片                               | 通过：v1 保留、退回重提 v2、草稿不通知；SUBMITTED/ACCEPTED 不覆盖；旧二进制清除；两种图片格式及附件清单冻结、official_version_no、授权图片回读      | 新服务测试                                                               |
| REST 失败兼容                                   | 通过：提交字段类型错误、无效协同二进制和未授权图片仍返回 serializer 形状的 400；提交后图片清单错误为原研究错误形状的 422，均不保存部分正文          | 新服务测试                                                               |
| 扩展原图片套件                                  | 首次扩大运行 81 项：70 passed / 10 failed / 1 error；error 是缺 mocker 夹具，依赖补齐后已由 47 项周报重跑消除；图片套件本身为 11 passed / 10 failed | workflow-regression.log                                                  |
| 扩展图片失败的基线对照                          | 用 git show HEAD 的原 reports.py 在内存中替换入口重跑同 21 项，仍为相同 10 failed / 11 passed（1 条 pytest import rewrite warning）                 | original-images-regression.log、run_original_images.py；未交换工作区文件 |
| 契约 schema                                     | 五个 inputSchema 均通过 Draft 2020-12 元校验，25 个正反例通过；覆盖互斥周期、未知字段、50001 字正文、非法动作、来源数量、execute 禁止换正文等       | contract-validation.log                                                  |
| Ruff / 格式 / diff                              | 修改的四个 Python 文件 lint 与格式检查通过；git diff --check 通过                                                                                   | 最终检查                                                                 |

图片套件的 10 个基线失败：6 个已提交图片读取变体、2 个历史清单读取、1 个退回/图片保留、1 个草稿不可见测试。
共同问题是 attachment_env 中 advisor/outsider 没有有效 OrgUnitMember，被 ResearchAPIView 的组织关系检查先返回 403（部分断言预期 302/200/404）。HEAD 原入口复现相同失败；本阶段没有为通过测试放宽权限或改写这些无关夹具。新回归使用有效组织成员验证相应图片/附件提交流程。

复跑核心测试（仓库根目录 PowerShell；需先启动同配置的独立测试 PostgreSQL，不能改指向业务库）：

```powershell
$env:PYTHONPATH = 'D:\plane-main\plane-dev\apps\api;D:\plane-main\plane-dev\.runtime\weekly-report-phase1'
.runtime/mcp-management-validation/venv/Scripts/python.exe -m pytest -c apps/api/pytest.ini --ds=weekly_phase1_settings apps/api/plane/tests/contract/app/test_report_workflow.py apps/api/plane/tests/contract/app/test_research_reports.py -q --tb=short
```

测试容器在本阶段完成后停止，tmpfs 测试数据随容器移除；本地日志/隔离设置保留以供复现。

## 阶段 1 当时的未验证项、风险与下一阶段入口（阶段 2 更新见后文）

- 尚未做浏览器编辑器重开/保存/刷新、HTTP/STDIO 周报工具端到端、Agent 授权交互或正式报告网页打开验收；这些工具/连接尚未实现，不能标通过。
- 本次没有真实对象存储上传/下载、邮件或 worker 崩溃恢复验证。图片回读测试 mock 了预签名 URL，附件仅验证数据库快照清单与正式版本号。
- 当前共享服务保留网页创建时模板 JSON + 空 HTML 的旧行为，不承诺已有网页任意输入的 JSON/HTML 自动一致；阶段 2 必须用一个受限 Markdown AST 统一生成三种正文表示，并校验体积、旧二进制及浏览器重载。
- 完整 revision 和授权/策略锁协议尚未实现；阶段 2 必须审计通用 Page、附件、图片、组织/保密/模板变更等后端路径的并发互斥。当前 Report/Page 锁和报告唯一约束不等于已完成 MCP 并发安全。
- 默认 pytest 使用 --nomigrations；本阶段未改模型，不代表历史或未来迁移已经验证。没有运行完整后端/前端构建或全仓测试；扩展图片套件基线失败仍需单独处理。
- 下一次入口：设置 EXECUTION_PHASE = 2，先阅读本记录、v1 契约/schema、新 report_workflow.py 与测试。复用本次共享服务，不重做抽取；实现独立 grant/operation/必要通知持久化、purpose 鉴权、默认关闭开关、revision/转换、五工具、管理 API、HTTP/STDIO 及脱敏示例。暂不开发前端。
- 后续阶段 3 仅在 `apps/web/core/components/settings/profile/content/pages/mcp.tsx` 容器并列原 MCPManagement 与周报连接组件，不修改周报列表/详情/编辑器/首页/审批页面。

## 阶段 2：实际交付

2026-10-26：用户澄清选择第 2 阶段，EXECUTION_PHASE = 2。已重新确认 Git 根目录/分支与适用 AGENTS.md；保留阶段 1 全部未提交成果及用户原有修改，没有重做报告服务抽取，没有子 Agent、新聊天、部署、推送、合并或提交。

### 模型、授权与可靠提交

- 新增 `apps/api/plane/db/models/research/report_agent.py`：独立 ReportAgentGrant / ReportAgentOperation。grant 绑定本人、工作区、WEEKLY、用途、动作、固定周期策略、有效期、撤销和凭据摘要；operation 保存原授权、固定 payload、前置摘要/revision、request/proposal 哈希、状态、持久 result、失败原因和可空 report。
- 标准迁移 `apps/api/plane/db/migrations/0201_weekly_report_agent.py`，依赖 0200。保持报告唯一键和旧节点 operation/grant 语义不变。
- `apps/api/plane/settings/common.py` 新增 `RESEARCH_WEEKLY_REPORT_MCP_ENABLED`，默认 false；没有更改当前部署配置或开启旧节点写权限。
- 新服务 `weekly_report_policy.py`、`weekly_report_errors.py`：专用 `pwr_` 随机凭据和 `X-Weekly-Report-Token` 鉴权，复用原摘要函数，purpose 严格为 weekly_report；只存摘要，完整值仅签发时返回。重查账号/席位/组织/报告能力；期限 1/7/30 天、本周与上周，10 条有效连接上限。
- 新 `weekly_report_body.py`：单个 markdown-it-py AST 生成编辑器 JSON、清洗 HTML 和 Page 纯文本；拒绝 HTML/脚本、图片、未授权资源路径及不支持语法；正文 50,000 字符、转换后 512 KiB、2,000 节点、16 层。只写原 Page 并清空旧协同二进制。`requirements/base.txt` 增加精确依赖 `markdown-it-py==4.2.0`。
- 新 `weekly_report_catalog.py`：五工具闭合 schema 与已冻结 v1 请求一致；按 grant 动作收窄 prepare 的发现 schema，执行仍在服务端重验；execute 描述真实正式状态/快照/审阅/通知效果，标为会更新数据。
- 新 `weekly_report_operations.py`：固定周期和正文的不可变提案、身份与有效受众、分页上下文、包含 Page/状态/附件图片/组织模板策略的签名 revision、来源当前可见性/版本/哈希检查、准备/执行/查询/取消/过期/拒绝、幂等与正式快照回读。
- 相同 workspace/user/request_id 只能回到同一原授权、同一输入；不同输入冲突。prepare 不创建 Report/Page；execute 不能换正文。新建仍由原报告唯一约束兜底，失败整体回滚。
- `report_workflow.py` 仅补充返回本次持久 Notification 实例供操作 result 绑定，不重构已完成服务。正文、快照、附件正式版本、审阅日志、普通报告审计、Agent 来源审计、站内 Notification 与 COMMITTED/result 同事务。
- Notification 是本项目现有的持久站内机制；操作锁和同事务结果保证同一操作不再创建通知。没有新增外部邮件投递或不可靠的 on_commit 替代方案。没有接收人时提案明确不承诺创建通知；接收人集合也进入 revision 摘要。
- COMMITTED 回读失败返回 pending 和原持久结果；后续查询验证原 snapshot_version，不用此刻 Page 或后来 v2 重建 v1。业务错误回滚后记录 REJECTED；数据库/通知/结果写故障保留可恢复状态，不误报成功或部分提交。

### 管理 API、传输与脱敏

- 新 `apps/api/plane/research/views/weekly_report_agent.py`，在 `research/urls.py` 注册独立 weekly-report-agent 和 mcp/weekly-report 命名空间；管理面只接受登录态 + CSRF，机器面只接受专用 token。候选工作区/能力、签发、分页列表、撤销已实现；列表/撤销在功能关闭时仍可用于本人管理。
- 原生 HTTP MCP 与机器 REST 共用五工具目录/服务/错误对象，JSON RPC tools/call 返回 structuredContent/isError；MCP 的副作用和授权说明独立于原节点文案。
- 新 `demos/sciencediscovery-plane-mcp/weekly_report_mcp.py`：独立 STDIO 五工具白名单、发现与只读标记校验、专用头/命名空间、2 MiB 响应预算、无重定向/无自动重提、超时同 ID 恢复。旧节点、只读入口和原 HTTP 门户未改。
- `apps/api/plane/middleware/logger.py` 增加周报凭据头脱敏；周报管理/工具命名空间跳过旧 API key 请求正文与响应正文日志，防止附带无关 API key 时把一次性密钥或正文写入日志。操作只记录来源/摘要审计。
- [API v1 说明](mcp-weekly-report-api-v1.md) 给出阶段 3 可直接使用的真实字段、状态、分页/撤销与 HTTP/STDIO 配置方式。
- [12 组脱敏请求/响应](mcp-weekly-report-api-v1.examples.json)：来自已完整迁移的独立临时数据库与合成账号，通过 Django 真实 API 捕获 options/workspaces/issue/list/tools/context/prepare/execute/get/cancel-committed/rpc-catalogue/revoke；验证 COMMITTED v1 / readback=verified，完整密钥、CSRF、revision 已脱敏。没有使用生产业务数据。

### 实际验证

环境：独立 `plane-weekly-phase2-postgres-20261026` 容器，PostgreSQL 15.7，localhost:55439，tmpfs，无业务卷。复用阶段 1 本地隔离设置与 Python 环境；数据库 `weekly_phase1` 用于新迁移/合成 API 样例，`test_weekly_phase1_20261026` 用于 pytest，两者均为本次新临时容器中的空库起步。没有连接应用生产库，没有启动被禁用的测试 compose 栈。

| 验证                                     | 最终结果                                                                                                                                                                                                                      | 本地证据 `.runtime/weekly-report-phase2/`               |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| 新功能 + 阶段 1 + 旧节点/管理 + 日志组合 | **179 passed，134.42s**                                                                                                                                                                                                       | backend-final.log                                       |
| 新增数据库/API用例                       | 上行包含 **37 项**：创建/草稿/提交/退回 v2、原 v1 恢复、重复请求/重复执行、同/不同操作并发新建与编辑、网页正文写入、完整分页、来源撤变、周期/时区/模板、CSRF、跨工作区/原授权、撤权/过期/停用、通知与结果写失败回滚、持久拒绝 | test_weekly_report_agent.py                             |
| 新增正文/schema/脱敏单元用例             | 上行包含 **14 项**：单 AST 表示、HTML/脚本/图片/资源/不支持语法拒绝、字符/节点限制、schema 与冻结契约一致、一次性密钥日志保护                                                                                                 | test_weekly_report_body.py                              |
| 原有回归                                 | 上行包含阶段 1/既有周报 **65 项**，旧节点 operation **46 项**，原 MCP 管理 **11 项**，原日志 **6 项**；均通过                                                                                                                 | backend-final.log                                       |
| 新旧传输代理                             | **36 tests / OK**（新周报 6 + 原 operation/read/readonly 30）                                                                                                                                                                 | transport-regression.log                                |
| 全迁移链                                 | 全新独立库 migrate 完成，包含 db.0201；不是 --nomigrations 的推断结果                                                                                                                                                         | migrate.log                                             |
| 新迁移回退与再应用                       | 0201→0200→0201 成功，仅临时空授权/操作表；未对业务环境逆迁移                                                                                                                                                                  | migrate-reverse.log、migrate-reapply.log                |
| 迁移一致性 / 系统检查                    | makemigrations db --check --dry-run：No changes detected；Django check：no issues                                                                                                                                             | 本次命令输出                                            |
| 脱敏 API 合成流                          | 12 组响应捕获成功；COMMITTED v1、readback=verified；样例扫描无完整周报 token                                                                                                                                                  | examples.log、capture_examples.py、已交付 examples.json |
| Ruff / diff                              | 新功能模块/测试及本次小改文件 lint 通过；新文件格式检查通过；git diff --check 通过。urls.py 存在 **17 条 HEAD 同样的旧行长告警，0 条新增**，没有为本功能批量格式化旧路由                                                      | url-lint-baseline.log、最终检查                         |

中间测试曾因 Windows 将 50,001 字符参数用作测试名称而超过环境变量长度限制，已为边界用例设置短 ID；最终组合已全部通过。中间失败/重跑不重复计入 179。
阶段 1 已复现的图片套件 10 个组织成员夹具基线失败没有被修改，也没有标为通过；本次组合覆盖有效组织成员下的图片/附件冻结与授权回读。

核心复跑命令沿用阶段 1 的 PYTHONPATH/--ds=weekly_phase1_settings，增加：

```text
plane/tests/contract/app/test_weekly_report_agent.py
plane/tests/unit/research/test_weekly_report_body.py
```

完整本次组合还包括原 `test_report_workflow.py`、`test_research_reports.py`、`test_research_agent_operations.py`、`test_mcp_management.py`、`unit/middleware/test_logger.py`。
代理用现有 Python 环境运行 unittest：`test_weekly_report_mcp test_research_operations_mcp test_research_mcp test_read_only_mcp`，将 demo 和 demo/tests 目录放入 PYTHONPATH。

### 未验证项与剩余风险

- **数据库屏障较保守**：由于原 Page/资源/组织写入口没有同一细粒度锁协议，本阶段采用 PostgreSQL 相关表 SHARE ROW EXCLUSIVE 事务屏障，再锁 grant/operation 和业务行。防止旧写路径和新增行穿过最终校验，但会阻塞相关表的其他写入，包括其他工作区；有来源时覆盖更多研究表。每次锁等待限制 3 秒，不是操作总耗时保证。已测竞争正确性，**未测吞吐/长期负载**；默认开关保持关闭，缩小屏障前必须保留等效并发安全。
- revision 对工作区组织/成员/模板等使用保守摘要，不相关策略变更也可能导致重新准备；不能为了减少冲突静默采用更宽可见性。
- 尚未验证真实浏览器中的编辑器重开、保存、刷新、审阅队列或现有网页打开正式报告；数据库层验证了三种正文表示、旧二进制清除、正式版本保留。端到端客户端/浏览器验收属于阶段 4，不标通过。
- 原生 HTTP 的 Django API/JSON RPC 与 STDIO 代理均已测试，但尚未用真实 Agent 客户端进程经实际网络完成“连接→提案→执行→网页”的双传输完整流程。
- 没有真实对象存储内容上传/下载、外部邮件/worker 崩溃投递验证；本实现使用已有事务性站内 Notification，未增加外部投递通道。来源没有读取票据，仍只标 declared_only；不能验证编号版本/哈希的元数据来源会拒绝，可使用 source_refs=[]。
- 当前 Markdown 子集不支持的富模板节点/标记会明确拒绝，不悄悄裁剪或换成默认模板。没有改造现有编辑器或任意旧 REST 正文的转换规则。
- 没有运行前端构建/类型检查或全仓测试（本阶段不改前端）；没有对当前部署运行迁移或启用新功能，也没有修改部署密钥/环境配置。

### 下一阶段直接入口

执行 EXECUTION_PHASE = 3：先读本节、[API v1](mcp-weekly-report-api-v1.md)、[真实脱敏样例](mcp-weekly-report-api-v1.examples.json)、v1 契约与新后端测试。
复用已完成的授权/操作/服务及 0201 迁移，不重做后端。仅在 `apps/web/core/components/settings/profile/content/pages/mcp.tsx` 内新增可键盘操作的“周报连接”页签，与原 MCPManagement 并列，新增独立 WeeklyReportMCPSettings 和轻量 service/types。
按后端 options 显示工作区、名称、动作和期限；签发后仅当前结果持有 headers，复制/导出用通用 MCPConfig/configurationFiles。实现分页列表和撤销、重复点击/旧响应竞态/不确定签发恢复、切页切工作区/关闭弹窗清除密钥，兼容独立设置页与 inModal。
不伪造 research target/nodeId，不读取弹窗背后页面参数，不改周报列表/详情/编辑器/首页/审批界面；本次及后续指定单阶段均不得自动部署、推送或合并。

本次临时数据库容器在交付前停止并移除，tmpfs 中的合成数据随之删除；保留本地验证日志、设置和脱敏样例以便复现。

## 阶段 3：最小周报连接子页（历史记录）

### 范围与修改保护

- 用户明确澄清按阶段 3 开发 MCP 设置子页；原请求中“不开发前端”不适用于本次。未改输入提示词内供复制使用的默认 EXECUTION_PHASE；本次实际执行值为 3。
- 再次确认 Git 根为 `D:\plane-main\plane-dev`，分支 `fix/sd-mcp-optional-binding`，读取根 AGENTS.md、两份实施规范、前两阶段记录及实际 API/样例。所有阶段 1/2 和用户原有未提交内容均保留。
- 本次只改 MCP 设置容器及相关组件、轻量服务、测试和本状态记录。没有改后端/迁移、旧 MCPManagement 业务逻辑、旧 MCPTarget 业务类型、周报列表/详情/编辑器/首页/审批界面；没有新增路由或一级导航。
- 没有部署、推送、合并、提交或暂存，没有修改功能开关/部署环境，没有运行 setup.sh、被禁止的测试 compose、迁移或业务数据库写入；没有子 Agent。

### 实际文件与前后行为

| 文件（仓库相对路径）                                                                        | 改动                                                                                                                                                                                                                                                                  |
| ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/web/core/components/settings/profile/content/pages/mcp.tsx`                           | 原来只挂载 MCPManagement；现在默认“现有连接”，并列“周报连接”，内部状态切换，无查询参数。原组件按原 props 挂载。页签支持左右方向键、Home/End、焦点移动及 tab/tabpanel 关联。非活动内容卸载；外部当前工作区改变会重新挂载；弹窗观察真实 isOpen 并在退出动画前立即卸载。 |
| `apps/web/core/components/mcp/weekly-report-settings.tsx`（新增）                           | 独立 WeeklyReportMCPSettings：登录账号、后端候选工作区、名称、分别选择保存草稿/正式提交、仅后端提供的期限、范围说明。无身份代选/节点要求/正文功能。生成后仅当前结果持有配置；本人连接分页列表、到期/撤销/最近使用、撤销确认、刷新与错误恢复。                         |
| `apps/web/core/services/weekly-report-mcp.service.ts`（新增）                               | 独立类型与 axios 客户端，对接阶段 2 的 options/list/issue/revoke。会话 cookies + POST CSRF；slug/id 编码；30 秒超时；不添加机器凭据/自动重试/全局登出拦截器。只返回固定安全错误，不透传可能包含密钥的服务端消息或原异常。                                             |
| `apps/web/core/components/mcp/weekly-report-config.ts`（新增）                              | 生成独立 plane_weekly_report 服务名，校验工作区、连接 ID、同源专用 MCP 路径及 token 格式，只复制 X-Weekly-Report-Token，不借用 research target/nodeId。复用现有 configurationFiles 的 JSON/TOML 格式。                                                                |
| `apps/web/core/components/mcp/connection-download.ts`（新增）及 `generated-connections.tsx` | 将原下载小函数抽为通用工具供两处使用，保留文件名/格式/按钮行为；临时对象 URL 在 finally 释放。原连接业务逻辑未重构。                                                                                                                                                  |
| `apps/web/tests/components/weekly-report-settings.test.tsx`（新增）                         | 16 项组件场景，见验证表。                                                                                                                                                                                                                                             |
| `apps/web/tests/components/weekly-report-service.test.ts`（新增）                           | 14 项接口路径/会话/CSRF/超时配置/错误脱敏/配置隔离与拒绝场景。                                                                                                                                                                                                        |
| `apps/web/tests/components/mcp-download.test.ts`（新增）                                    | 1 项共享下载行为验证。                                                                                                                                                                                                                                                |
| `apps/web/tests/components/mcp-management.test.tsx`                                         | 只为新容器增加“设置弹窗已打开”的 store mock，保留旧业务断言；与旧配置/服务测试合计 48 项通过。                                                                                                                                                                        |

管理 API 与 0201 迁移沿用阶段 2：[真实接口](mcp-weekly-report-api-v1.md)、[脱敏样例](mcp-weekly-report-api-v1.examples.json)。本次没有新增接口，也没有改机器 HTTP/STDIO 协议。

### 密钥与恢复的实际边界

- 默认不选择写入动作，两种动作分别勾选；无能力、未加载成功、无 CSRF、名称/期限无效时不能签发。开关关闭仍显示本人连接，并支持撤销。
- 签发/撤销使用同步 ref 拦住连续点击。签发成功后先保存本次配置，再刷新列表；保留结果时不再签发，先明确清除结果。
- 切页、切工作区、外部工作区改变、能力刷新、关闭弹窗或清除结果会移除本次配置状态和展示。卸载后的签发/列表/能力/复制异步回调不能恢复旧结果，工作区列表还过滤返回记录的 workspace。
- 不将密钥写入持久化存储、查询参数或日志；复制/导出是用户主动动作，已复制/下载的内容由用户保管，清除界面不会删除剪贴板或已下载文件。
- 网络/超时/5xx 或成功响应配置无效，都可能已经签发：自动尝试一次刷新列表，显示“签发结果尚未确认”，禁用再次创建。只有成功刷新并由用户点“已核对连接，继续创建”后才允许新建，绝不自动重试签发。失败分页可重试原 cursor，不丢已加载记录。
- 若签发尚未返回就离开子页，迟到密钥丢弃；界面提示先在已有连接中核对。列表无法找回密钥，可撤销不需要的连接后重新创建。

### 实际验证与证据

证据保存在本机忽略目录 `.runtime/`，没有真实密钥或生产业务写入。

| 检查                                   | 实际结果                                                                                                                                                                                                                                                                                                     | 证据                                                                                                                                                                       |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 新周报设置/服务/下载 + 原 MCP 相关回归 | **6 文件、79 passed，3.38s**；新 31 + 原 48                                                                                                                                                                                                                                                                  | `weekly-report-phase3-tests.log`                                                                                                                                           |
| 新组件场景                             | 上行包含 **16 项**：独立/弹窗、默认原页、键盘页签、后端能力/期限、独立动作、复制/导出、切页/工作区/外部工作区/关闭清理、迟到响应、连续签发、状态不确定恢复及恢复失败、异常配置拒绝、关开关仍管理、分页失败续页、撤销取消/失败/成功、加载失败/空列表、StrictMode、复制/导出失败                               | `weekly-report-settings.test.tsx`                                                                                                                                          |
| Web 完整组件套件（最终，4 workers）    | **148 文件；147 通过/1 失败；727 passed / 12 failed，94.52s**，不能标为全绿                                                                                                                                                                                                                                  | `weekly-report-phase3-components-final.log`                                                                                                                                |
| 全套失败对照                           | 对全套中最初失败的 5 套件，使用临时 Vite load 插件从 git HEAD 读取原版 MCP 容器和配置结果组件，**27 passed / 12 failed**；当前组件同范围也是 **27 passed / 12 failed**。12 个失败名称完全一致，均在既有 `research-chain-detail.test.tsx`；最终全套失败名称也与原版对照完全一致。没有覆盖工作树文件来做对照。 | `weekly-report-phase3-baseline.log`、`weekly-report-phase3-failures-recheck.log`、`weekly-report-phase3-baseline.config.mts`、`weekly-report-phase3-baseline-sources.json` |
| 初次高并发全套                         | 699 passed / 38 failed；另外 26 项未在单独复跑和最终降低并发运行中重现，保留原始结果，不据此声称其根因已修复                                                                                                                                                                                                 | `weekly-report-phase3-components.log`                                                                                                                                      |
| Web 路由类型生成与完整类型检查         | `pnpm run check:types`（react-router typegen + tsc --noEmit）**退出 0**                                                                                                                                                                                                                                      | `weekly-report-phase3-types.log`                                                                                                                                           |
| 本次 10 个 TS/TSX 文件 lint            | oxlint --deny-warnings：**0 warnings / 0 errors**                                                                                                                                                                                                                                                            | `weekly-report-phase3-lint.log`                                                                                                                                            |
| 格式与差异                             | oxfmt --check 本次 10 文件通过；git diff --check 通过                                                                                                                                                                                                                                                        | 本次命令输出                                                                                                                                                               |

可复跑（工作目录 `apps/web`）：

```text
pnpm exec vitest run --config vitest.config.ts tests/components/weekly-report-settings.test.tsx tests/components/weekly-report-service.test.ts tests/components/mcp-download.test.ts tests/components/mcp-management.test.tsx tests/components/mcp-services.test.ts tests/components/mcp-config.test.ts
pnpm exec vitest run --config vitest.config.ts --maxWorkers=4
pnpm run check:types
```

现有工具链会提示 tailwind-config 的 postcss.config.js 未声明模块类型、vite-tsconfig-paths 可迁至 Vite 内建解析；本次没有为这些提示修改无关配置。

### 未验证项与下一阶段入口

- 上述组件用 jsdom 与合成管理 API 响应验证，不等于真实浏览器、真实登录态 CSRF、网络/代理和 Agent 客户端验收。未做真实浏览器的布局/窄屏/键盘/关闭动画验收；应在隔离开发环境验收，不能从当前线上旧构建推断新子页已上线。
- 本次完成 Web 类型生成/类型检查，没有运行生产 build：根 AGENTS.md 明确当前 Caddy 直接服务 `apps/web/build/client`，本次未授权部署，因此没有覆盖该目录。阶段 4 需使用隔离构建输出完成构建与浏览器验收，不先覆盖线上静态目录。
- 全套仍有上述 12 个可对照的既有科研链详情失败；没有修改无关科研链详情或周报讨论/审批等组件来消除测试失败。阶段 1 图片套件基线失败、阶段 2 数据库写入屏障负载风险等历史剩余项继续有效。
- 没有重跑阶段 2 数据库/传输套件，因为本次没有改后端；历史 179/36 结果为阶段 2 证据，不冒充本次重跑。默认功能开关继续关闭。

下一次执行 **EXECUTION_PHASE = 4**：先读本节、API v1 与契约，不重做前三阶段。在允许的独立后端/数据库/前端输出环境应用 0201、仅对测试账号启用能力，完成“设置创建连接 → HTTP/STDIO Agent context → prepare → execute → get 恢复 → 现有网页打开正式周报”，同时检查草稿、竞争/网页修改、退回 v2、撤销、回读 pending、通知恢复与编辑器重开/保存/刷新。

阶段 4 还需真实浏览器覆盖独立设置/弹窗、复制下载、分页和关闭清理，隔离输出完整构建，整理客户端刷新、灰度与关闭开关/撤销凭据的回滚材料。没有后续明确授权仍不得部署、推送或合并，也不得在生产库构造验收数据。

## 阶段 4：隔离集成验收与发布材料（本次）

### 执行范围与实际交付

本次实际执行 EXECUTION_PHASE = 4，按规范开展验收与发布材料；请求末段“不开发前端”按不新增/修改前端产品功能执行，没有重复前三阶段的共享服务与契约重构。

- 再次确认实际 Git 根为 `D:\plane-main\plane-dev`、分支 `fix/sd-mcp-optional-binding`，读取根 AGENTS.md、实施规范、方案和前三阶段记录；没有在相邻快照目录实施，没有子 Agent。
- 新增 `apps/api/plane/tests/contract/app/test_weekly_report_transport_integration.py`：**5 项真实网络集成用例**。使用真实 MCP SDK、真实 TCP、STDIO 子进程、合成登录 session 和 CSRF；覆盖双传输、保存/提交/恢复、网页并发修改、通知故障回滚、提交后 pending 回读、撤销、两个客户端竞争及锁超时恢复。仅面向 pytest live_server 与测试库，没有生产目标参数。SDK 缺失会明确 skip；本次 5 项均实际通过，0 skipped。
- 新增 [发布与回滚说明](../operations/mcp-weekly-report-release-2026-10-26.md)：真实配置/工具刷新、同 ID 恢复、迁移、灰度能力边界、关闭开关/撤销和数据保留、未覆盖项及继续步骤。
- 本状态文件记录实际结果。阶段 4 没有修改前端产品代码、报告 REST/共享服务、机器工具、模型/迁移或部署配置；没有修改周报列表、详情、编辑器、首页、审批或原连接页业务逻辑。
- 原有部署脚本/说明、备份目录、输入方案和前三阶段未提交代码均保留；没有提交、暂存、推送、合并、部署、执行 setup.sh/被禁止测试 compose，也没有生产数据写入。

### 隔离环境与构建保护

- 新临时容器 `plane-weekly-phase4-postgres-20261026`：PostgreSQL 15.7，端口仅 `127.0.0.1:55439`，tmpfs，无业务卷。`weekly_phase4` 为浏览器合成数据，`test_weekly_phase4_20261026` 为 pytest；均由本次空库起步。
- 全迁移链实际运行成功，包含 `db.0201_weekly_report_agent`；与 pytest 默认 --nomigrations 区分。Django 服务 `127.0.0.1:18541`、前端代理 `127.0.0.2:18540`，仅使用合成记者/导师、两个合成工作区；临时设置关闭外发邮件与真实 broker/Redis 依赖。
- 登录会话初始化只存在于 `.runtime` 临时 URLConf，用于合成登录态，不加入产品路由/鉴权。**没有验证正式密码登录 UI 或生产反向代理**。
- Web 源码复制到 `.runtime/weekly-report-phase4/web`，独立构建并在该产物上做浏览器验收；没有复制部署 .env。实际部署目录 `apps/web/build/client` 的 **1,489 个文件逐个 SHA-256 前后完全一致**，文件数量也一致。
- 首次隔离构建使用 HOST=127.0.0.2 时，React Router 预渲染无法取得 Vite resolved URL，构建未成功；将**临时构建进程** HOST 改为 127.0.0.1 后完整构建成功，验收服务仍绑定隔离地址。没有为此修改仓库 Vite/Router 配置。

### 真实浏览器与双传输结果

1. 独立 MCP 设置默认保留原连接页，键盘左右键切换成功。周报子页显示后端工作区、本人身份、分别授权的动作和期限，浏览器真实签发连接、复制 JSON 内容核对成功。
2. 使用**该浏览器实际生成的连接**，经前端代理完成 HTTP MCP initialize→五工具→context→prepare→execute→get：上周 `2026-W43` 正式 SUBMITTED v1，重复执行结果一致；同一配置用于真实 STDIO 子进程，为本周 `2026-W44` 保存 DRAFT，未生成正式版本。
3. 现有网页打开 HTTP 正式报告成功；STDIO 草稿用现有编辑器输入标记、保存、刷新，新内容保留。Agent 再次替换正文，浏览器重开、再次保存/刷新后新内容仍在，旧修改没有恢复覆盖。
4. 进一步在测试库注入包含旧文本的 **83 字节有效 Yjs 协同文档**，重新取 context 后由 Agent 保存正文，description_binary 实测为 null；浏览器重开只见新正文，不见旧协同文本。证据 `legacy-binary-proof.json`、`legacy-binary.log`；首次自然浏览器保存的 binary 为 0 字节，未把该次单独说成非空二进制验证。
5. 合成导师通过既有网页退回 v1，Agent 重提生成 v2；数据库确认 v1 的 JSON/HTML/纯文本不变，原 operation_id 仍回读 v1。导师网页显示“正式版本 v2”，审核历史含两次 SUBMIT 和一次 RETURN；现有“我需审核”队列列出该报告，可见范围为既有工作区全员。
6. 在带 `view=reports&scope=review` 的背景页面打开设置弹窗，默认原页→周报页正常，列表只见当前导师本人的连接。创建仅草稿权限连接，实际 JSON 下载与展示配置一致，测试下载文件已删除；关闭弹窗后密钥文本域为 0，重新打开也未恢复。
7. 浏览器撤销两条合成连接后，列表自动刷新为已撤销。原双传输机器凭据通过真实网络访问返回 **403 / grant_revoked**；登录态导师仍能查看正式 v2，撤销不删除已提交业务数据。
8. 本次真实网络流使用 source_refs=[]。来源 ACL/版本等由本次重跑的既有后端用例覆盖，未另用真实节点客户端把“读素材→周报引用”完整串联；没有把已有授权自动扩大。

本机浏览器证据与脚本均在 `.runtime/weekly-report-phase4/`。可用截图包括经实际画面复核的 `advisor-official-v2.png`、`browser-grant-revoked.png`；部分早期截图截到加载画面，**不作为通过证据**。正文保存/替换另有 DOM 状态与数据库证明；不是仅凭截图推断。

### 本次检查与准确计数

| 检查                                          | 实际结果                                                                                                                              | 本机证据 `.runtime/weekly-report-phase4/`            |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| 原后端回归 + 初版新增 3 集成组合              | **182 passed，328.91s**；含阶段 2 原 179 项 + 当时已完成的 3 项新网络集成                                                             | backend-final.log、backend-results.xml               |
| 最终新增网络集成（含再补的两个 TCP 竞争变体） | **5 passed，0 skipped，121.08s**；与上行中的 3 项重叠，不重复计数。去重覆盖为原 179 + 新 5 = 184 项                                   | network-final.log、network-results.xml               |
| 原后端范围                                    | 周报共享服务/REST 65、周报授权/操作 37、正文/schema/脱敏 14、原节点操作 46、原 MCP 管理 11、原日志 6                                  | backend-final.log                                    |
| 新旧传输代理                                  | **36 tests / OK，2.645s**                                                                                                             | transport-regression.log                             |
| 周报及原 MCP 前端回归                         | **6 文件、79 passed，43.11s**                                                                                                         | frontend-regression.log                              |
| 完整隔离 Web 构建                             | **退出 0**，生成独立 SPA index.html；不是只跑类型检查                                                                                 | build-final.log、web/build/client/index.html         |
| 原部署构建保护                                | **1,489 文件，SHA-256 完全一致**                                                                                                      | build-isolation-proof.json、served-build-before.json |
| 完整 Web 类型生成/检查                        | `pnpm run check:types`（react-router typegen + tsc --noEmit）**退出 0**                                                               | types.log                                            |
| 真实空库迁移                                  | 完整迁移链成功，包含 0201；不依赖 --nomigrations 的推断                                                                               | migrate.log                                          |
| Django / 模型检查                             | check：no issues；makemigrations db --check --dry-run：No changes detected                                                            | django-check.log、migration-check.log                |
| 新 Python 集成用例                            | Ruff check 与 format --check 通过                                                                                                     | 本次命令输出                                         |
| 差异检查/范围                                 | git diff --check 通过；报告 UI、原 MCPManagement/types 仍无差异；阶段 4 未改 TS/TSX 产品文件，阶段 3 格式/lint 结果继续按历史记录保留 | 本次命令输出                                         |
| 密钥日志检查                                  | `.runtime/weekly-report-phase4/*.log` 扫描无完整周报 token；下载/剪贴板和私密测试配置在交付前清理                                     | post-revoke-proof.json、本次检查                     |

SDK 测试使用的 streamablehttp_client 别名有一条弃用提醒；首次组合的 JUnit xunit2 对 record_property 另有提醒，最终 5 项补跑使用 legacy JUnit 后只余 SDK 提醒。不是功能失败，也没有为消除提醒改生产依赖或协议。中间新增用例曾因把现有字段名/错误码写成假定名称而失败，已改为实际 latest_official_version、作者 draft_content、report_revision_conflict 后通过，未修改业务响应迎合测试。

核心复跑命令（仓库根；必须使用独立 PostgreSQL 测试设置与 demo SDK 开发依赖）：

```text
python -m pytest -c apps/api/pytest.ini --ds=<isolated_settings> apps/api/plane/tests/contract/app/test_weekly_report_transport_integration.py -q --tb=short
```

本机完整组合及参数保留在日志与本次工具记录；前端 79 项复跑命令沿阶段 3。缺 SDK 导致 skip 时不能标为网络验收完成。

### 已证实的限制与未验证项

- **全表写屏障影响已证实，不再只是理论风险**：Page 普通写锁会使周报 execute 等待，3 秒 lock_timeout 后保留 PROPOSED 并返回 retryable 503；本次网络实测总耗时 **5.951 秒**（首次组合为 6.267 秒），不能把 3 秒写成请求耗时保证。释放后同 operation_id 成功，未留下报告/快照半成品。
- 反向验证：持有一致性屏障 0.75 秒，**另一工作区** Page 更新被阻塞 **0.76 秒**。证据 `cross-workspace-probe.json`。这不是吞吐、尾延迟或长期压力测试；共享生产实例放量前需收窄锁协议或明确接受受控低并发部署条件，不能删除一致性检查来换性能。
- 当前只有全局周报 MCP 开关，没有独立账号/工作区灰度白名单；可在隔离实例灰度，不能宣称全局开关只为某个测试账号开放，也不应通过改变原报告权限实现伪灰度。
- **现有作者版本标签问题**：作者详情页面显示“正式版本 v—”；导师页面正确显示 v1/v2。`report-body.tsx` 标签只取 official_content.version_no，而既有 serializer 对作者返回 draft_content；数据库 Snapshot、MCP 结果、讨论固定版本均正确。此路径不是新 MCP 分支，本阶段遵守“不改详情/编辑器”未改该标签，后续需单独确认修复范围。
- 浏览器真实验收在默认桌面视口进行。当前工具未提供视口调整能力，**窄屏/触摸、其他浏览器未测**。TOML 已做序列化/按钮自动测试，没有手工下载 TOML。大列表分页与签发不确定竞态由自动回归覆盖，没有在浏览器制造所有网络断连组合。
- 未用第三方 Agent 产品的真实界面验证审批/工具刷新；本次客户端是实际 MCP SDK 与 STDIO 子进程，不冒称为 Codex/其他产品 UI 验收。正式域名/TLS/代理、真实密码登录、真实对象存储/外部邮件/worker 崩溃与长期负载仍未验证。
- 真实浏览器正文覆盖本次基础标题/段落模板，没有逐个手测全部 Markdown 子集节点；AST/schema 由单元回归覆盖。
- 阶段 3 全组件 727 通过/12 个科研链详情原版同名失败、阶段 1 图片夹具 10 个原版失败继续保留。本次没有修改这些组件/夹具，**没有重跑全仓并声称全部通过**。原行政门户在隔离环境未配置，原页面可挂载与旧代理单测通过不等于真实门户网络已验收。

### 交付结论与继续入口

本阶段已完成可执行的隔离集成验收、必要测试代码与发布/回滚材料；**不等于生产放量条件全部满足**，默认开关及生产部署保持原状。

没有约定的阶段 5。下一步按 [发布与回滚说明](../operations/mcp-weekly-report-release-2026-10-26.md) 做“部署前缺口收敛与发布评审”：优先处理全表屏障/灰度边界，明确作者版本标签修复范围，补窄屏与目标客户端/环境验收。仍需另行明确授权才能部署、推送或合并；不在生产库构造测试数据。

本次合成凭据已通过管理 UI 撤销，机器 403 已确认。交付前停止并移除专用数据库容器（tmpfs 合成数据随之删除），停止独立 API/预览进程并关闭临时浏览器页；保留脱敏日志、截图、测试设置和脚本以供复现，不保留有效私密测试连接文件。

## 2026-10-27 develop 兼容修复

用户授权以最新 develop 为基线，保留新版报告能力，再接入现有周报 MCP。已重新 fetch 核对 GitHub；本次基线为 `9f93b5245c14555b49022e91033c2b3f55d9f591`（8.4.1）。当前工作分支仍为 `fix/sd-mcp-optional-binding`，已快进到该基线；没有创建新的业务提交或推送。阶段 1–4 的历史计数保持原义，不与本次重复计数。

### 备份与实际修复

- 整合前对原有 48 个修改/未跟踪文件逐一备份并校验 SHA-256，保存二进制补丁及 Git stash 快照，均保留在本地。用户原有 Windows 启动脚本、运维文档和备份文件按原字节保留；新 develop 将 API backups 目录纳入忽略规则，文件仍存在，不是删除。
- 解决 reports.py 的两处文本冲突。创建、正文保存和正式提交仍由 `report_workflow.py` 统一提供给网页 REST 与周报 MCP；共享 `report_queryset` 接收新版 `include_deleted`，默认使用 active manager，回收站入口显式选择 all_objects 并继续执行新版权限过滤。
- 保留新版恢复、撤回、导出、审阅、历史及可见性能力，补齐恢复接口所需 Page、ProjectPage、PeriodicReportProjectReference、ReportAttachment、IntegrityError 和撤回通知导入。AST 对照确认最新 develop 的 17 个视图方法/函数保持原逻辑，包括列表 GET、恢复、撤回、删除、审阅等；报告前端及报告 service 与该 develop 完全一致。
- 模型导出、路由和报告测试保留双方新增项；原连接页及周报子页沿用阶段 3 实现，没有新增 MCP 工具或权限范围。
- 新增 `0205_merge_weekly_report_agent.py`，空 operations，同时依赖 `0201_weekly_report_agent` 与 `0204_researchchainnodetaskattachment`。保留已应用的周报迁移身份，不重复建表、不 fake、不重置数据库。
- 新增 4 项跨入口回归：MCP 提交→网页撤回→MCP 重提 v2 并保留 v1/原操作结果；网页删除/恢复使旧提案失效（两种情况）；网页提交再撤回不能使旧草稿提案重新有效。
- 修复固定 ISO 边界测试的日期依赖：只把该测试的组织/导师夹具生效日期提前到固定时钟之前，避免 10 月 27 日运行时因夹具晚于 10 月 25 日而权限失败，未放宽真实权限。
- 解决最新 develop 的一个既有类型检查阻塞：智能体工具消息合并分支显式判断 index 不为 undefined，已有 8 项消息合并测试通过。新版撤回测试的 4 处旧文案断言同步当前翻译，未改报告界面。

### 本次实际验证

任务设置/日志位于忽略目录 `.runtime/weekly-develop-integration-20261027/`。PostgreSQL 15.7 使用独立容器、127.0.0.1:55440、tmpfs；图片导出使用独立 MinIO、127.0.0.1:19000、tmpfs。所有数据库均为 synthetic weekly_integration/test_weekly_integration 前缀；没有连接本地 Plane 业务数据库做迁移或测试。未运行 docker-compose-test.yml。

| 检查                  | 实际结果                                                                                                                                            | 证据                                          |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| 最终后端组合          | **157 passed，218.00s，0 skipped**；新版报告、共享服务、周报授权/操作、Markdown、5 项真实 TCP/STDIO 集成、新增跨入口回归、Markdown ZIP 导出和 Inbox | backend-final.log / backend-final-results.xml |
| 迁移：空库            | 完整迁移成功，db 单末端 0205，MCP/Inbox/任务说明附件表均存在                                                                                        | migration-scenarios.json                      |
| 迁移：已有周报库      | 从旧 0201 周报迁移状态升级；草稿正文、连接与 COMMITTED 操作结果均保留                                                                               | migration-scenarios.json                      |
| 迁移：已有 develop 库 | 从 0204 状态升级；已有草稿与 Inbox 数据保留                                                                                                         | migration-scenarios.json                      |
| MCP 与新版报告前端    | **12 文件、126 passed**，含旧连接、周报子页、复制/配置/服务、报告正文/列表/恢复/撤回/导出服务                                                       | frontend-verified.log                         |
| 智能体类型修复回归    | **8 passed**                                                                                                                                        | agent-types-regression.log                    |
| 新旧 MCP 代理         | **15 passed，1.77s**（本次选择两份 pytest 文件；不冒称重跑阶段 4 的全部 36 项传输检查）                                                             | proxy.log                                     |
| Web 类型与构建        | 最新共享包产物更新后，完整 typegen、tsc --noEmit、独立 Web SPA 构建退出 0                                                                           | types-verified.log / web-build.log            |
| Django 与模型迁移     | check 无问题；makemigrations --check --dry-run：No changes detected                                                                                 | check-final.log / migration-check-final.log   |
| 静态检查              | 修改的 4 个 Python 文件 Ruff check / format 通过；2 个新改动 TS/TSX 文件 oxlint 无警告错误、oxfmt 通过；git diff --check 通过                       | 工具输出 / frontend-lint.log                  |
| 保留性核对            | 原用户改动及数据文件保留；报告 UI 与 develop 一致；原部署 Web 1,489 文件 SHA-256 与历史清单完全一致；无未解决 Git 冲突                              | integration-proof.json                        |

首轮后端为 131 passed / 1 failed，失败是上述固定日期夹具问题；修复后完整重跑为最终 157 项全通过。首轮导出补跑缺少隔离存储配置而失败，补建独立 MinIO 后全部在最终组合通过。首轮前端和类型检查使用旧共享 dist，刷新共享构建产物后确认；撤回旧文案和 index 类型错误另按上述小范围修复。不得把这些中间失败隐去或叠加进最终通过计数。最终后端仅保留 MCP SDK 别名弃用、JUnit record_property 格式两条提醒，无功能失败。

补充旧连接回归：原节点 Agent operations、MCP 管理和日志脱敏 **63 passed，32.31s**，见 legacy.log / legacy-results.xml；与上述 157 项文件范围不同，本次后端合计 **220 项通过**。前端 126 + 8 合计 **134 项通过**，代理另计 15 项。交付前已停止并移除上述两个专用容器，tmpfs 测试数据库和对象随之删除，日志与恢复备份保留。

### 边界与下一步

本次完成源码整合和隔离验证，没有部署、重启现有服务或迁移本地业务库，没有推送、创建 PR 或业务提交；当前运行实例仍是重启前的进程与旧前端产物。新增 Web 构建仅在任务目录。备份和 stash 留作恢复。

本次未做新版浏览器完整回归、真实目标 Agent UI、TLS/正式代理、生产数据/外部邮件/worker 崩溃或长期负载验收。全表屏障、全局灰度开关、图片/附件与局部修改等既有限制未在兼容修复中扩展。阶段 1/3 其他套件的历史失败未重跑或宣称修复。

下一步可在明确的本地服务更新任务中应用 0205 及新版构建再进行人工验收；生产发布仍按发布说明处理锁/灰度等缺口，不应直接复用隔离测试设置。

## 2026-10-27 测试服务器默认启用

用户明确要求测试服务器无需添加 `RESEARCH_WEEKLY_REPORT_MCP_ENABLED=1`。已将 common.py 的未配置默认值改为 `1`；保留显式 `0` 关闭能力，没有删除授权检查或更改旧节点 MCP 开关。账号、组织、报告能力、专用凭据、动作及周期限制均继续生效；本次不改实际 `.env`，不部署或重启服务。

同步 API/契约/发布说明及 `.env.example` 注释；此前阶段记录中的“默认关闭”属于历史状态，以本节与当前代码为准。部署新版本后，服务器可删除该环境变量；如果已经配置为 `0`，它仍优先关闭，需要删除该配置才能采用新默认值。

实际验证：在 4 个独立 Python 进程中加载真实 `plane.settings.test`（继承 common），未配置→True、`0`→False、`1`→True、空值→False；原节点 MCP 读写开关在 4 种情况下均未改变。验证不连接数据库或对象存储，结果保存在 `.runtime/weekly-default-enabled-20261027/settings-smoke.json`。文档格式及 git diff --check 通过。本次为配置默认值的小范围调整，没有重跑上一节 220 项后端及其他完整回归，不将历史结果冒称本次重跑。

## 2026-10-27 本地人工验收重启

用户明确要求更新并重启本地实例供人工验收。再次通过 GitHub ls-remote 核对 develop 仍为 `9f93b524`（8.4.1），当前 HEAD 与其一致，周报及用户原有修改仍保留为未提交状态。

- 对现有本地 PostgreSQL 完成 custom-format 全库备份，文件 `.runtime/windows/restart-latest-20261027/before-restart-20261027-180344.dump`，约 1.51 MB，包含私密业务数据，不提交。
- 停止原应用进程后，在本地业务库应用 0201_asset_preview_chain_upload、0202、0203、0204、0205 合并迁移，重建 API/worker/beat 容器；保留数据卷及原账号。不是此前隔离数据库的迁移演练，也没有部署到服务器。
- 使用当前源码和本地地址重新独立构建 Web。3000 主入口与 3005 兼容入口均已启动，服务的 index SHA-256 与本次构建一致；保留 3005 使原周报 MCP 配置地址继续可用。原 apps/web/build/client 未被覆盖。辅助前端及原独立 MCP 门户也已重启。
- 运行中 API 实测：weekly enabled=True、未配置周报开关环境变量；数据库单末端 0205，无冲突、无待执行迁移。先前保存的 2026-W44 周报仍为 DRAFT，原周报连接仍存在。
- 实际检查：3000、3005、Admin、Space 返回 HTTP 200，API health=OK，原 MCP healthz=200；3005 周报管理接口可达，未登录请求正确返回 401；受管理前端、原 MCP 和后端容器均运行。

本次已更新并重启本地测试实例，但未推送或操作服务器。后续人工验收入口为 http://localhost:3000/ → 设置 → MCP → 周报连接；原账号和已有草稿可继续使用。当前本地运行说明、构建、日志及镜像覆盖配置位于 `.runtime/windows/restart-latest-20261027/`。

## 2026-10-27 develop 8.5.0 审核交付

本次按用户要求，从最新 `develop`（`8009f8a00e5c97ba3728ae1c71fe33f5bd48eee1`，8.5.0）创建 `周报mcp-demo` 分支，交付现有周报 MCP 供审核。提交前再次 fetch 并核对远端 develop；45 个周报相关文件纳入交付，另 4 个本机启动/运维文件保持原字节并留在工作区。未运行部署或合并。

- 新增 `0206_merge_weekly_report_demo` 空操作迁移，合并周报 `0205_merge_weekly_report_agent` 与新版 `0205_action_item_notification_subscribers`，保留此前迁移身份。
- 当前基线实际检查：Django check 无问题；迁移图无冲突、db 单末端 0206；模型与迁移无差异。新版 17 个报告视图方法/函数逻辑、266 条已有 research 路由及报告产品前端保持原能力，新增 7 条周报路由。
- 交付前重跑 6 份 MCP 前端测试文件，**79 passed**，日志 `.runtime/weekly-review-delivery-20261027/frontend.log`；暂存补丁空白检查、凭据扫描通过。此前 220 项后端、134 项前端及完整构建结果属于上文 8.4.1 整合验证，未冒称在 8.5.0 全量重跑。
- 当前尚未在 8.5.0 重跑完整数据库集成、三种实际迁移场景、完整构建或浏览器验收；0206 本次验证为迁移图与模型检查，本地业务库未因此执行迁移。

审核重点：此演示按用户要求默认启用，可显式设 `RESEARCH_WEEKLY_REPORT_MCP_ENABLED=0` 关闭；仍有全表锁、无工作区灰度、无图片/附件及局部正文修改能力。下一入口为针对 develop 的分支审核；生产发布前仍需评估锁争用和灰度策略，补齐上述最新基线验证。审核通过后的合并与部署由维护者另行执行。
