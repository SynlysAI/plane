# MCP 本人周报契约 v1

契约标识：`plane.weekly-report.v1`。冻结日期：2026-10-26。EXECUTION_PHASE = 1。
本文件约束第 2 阶段实现；**第 1 阶段没有开放工具、凭据、管理 API 或新增开关**。
阶段 2 已实现，真实管理接口和脱敏样例见 [API v1 说明](mcp-weekly-report-api-v1.md)。
请求的可执行 JSON Schema 见 [v1.schemas.json](mcp-weekly-report-contract-v1.schemas.json)。
不兼容改动必须升契约版本，并更新发现目录、两个传输和兼容性测试。

## 1. 边界与授权

- 只支持本人 WEEKLY；owner/workspace 从独立周报凭据解析，请求不接受 owner、workspace、project、node 或审批动作。
- 新建 `ReportAgentGrant`、`ReportAgentOperation`（名称可按项目风格调整），不改现有节点 grant/operation 语义，不伪造项目或科研节点。
- grant 至少保存 workspace/user、purpose=`weekly_report`、动作集合、report_type=`WEEKLY`、周期策略版本、期限、撤销、摘要、名称、最近使用时间。完整密钥只在创建响应出现一次，不写日志、URL 或浏览器持久存储。
- 独立部署开关 `RESEARCH_WEEKLY_REPORT_MCP_ENABLED` 未配置时默认启用（2026-10-27 按测试服务器要求调整）；显式设置 `0` 可关闭。同时检查 reports 能力、部署/工作区报告开关、活跃账号、非访客工作区成员和有效组织关系。不能单因 research_chain 关闭而拒绝 reports 已开放的个人报告，也不能为本能力开放旧节点写权限。
- 新的专用鉴权头为 `X-Weekly-Report-Token`；独立随机不透明密钥（至少 256 位熵）、purpose 与 grant 摘要校验。复用现有安全随机数/摘要机制，不调用要求 project 的旧签发器来伪造授权。旧节点、只读、API key 和登录态不能在机器入口代替周报凭据。
- `save_draft`、`submit` 分别授权；submit 不隐含 save_draft，context 的 allowed_actions 是凭据与当前业务能力的交集。prepare/execute 均检查具体动作，签发与执行均重查成员、组织、开关、周期和报告权限。
- 首期周期策略固定 `current_and_previous_week.v1`：按当前工作区报告时区只允许本周和上一周。显式 period_key 也必须在该范围；不接受任意历史、未来或月报。grant 可进一步收窄但不能放宽。跨周后旧提案若不再在范围内必须拒绝，不改变它的周期。
- 签发允许有效期固定为 1、7、30 天，最大 30 天；后端 options 必须返回实际可选值。提案期限为 min(prepare + 15 分钟, grant.expires_at)。列表、查询和撤销均只作用于本人的授权记录。
- 现有 REST 的管理员代交能力保留；MCP 调用共享服务前额外强制 report.owner_id == grant.user_id。

## 2. 请求、发现与传输

五个工具的 inputSchema 由配套 JSON 文件冻结，所有对象均 additionalProperties=false。
UUID 使用标准 UUID 字符串；时间使用 RFC3339 UTC；日期为 YYYY-MM-DD；周期为规范 YYYY-Www，并再校验实际 ISO 周是否存在。
所有字符串拒绝空白值、NUL 和无效 Unicode；正文先规范 CRLF→LF 和 Unicode NFC，再验证字符/体积边界，不静默裁剪。

| 工具                            | 请求与副作用                                                                                                                                                                 | readOnlyHint |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| get_weekly_report_context       | 初次传 period_offset=-1/0 或 period_key，二者互斥且必须择一；分页传 period_key+cursor。只读。                                                                                | true         |
| prepare_weekly_report_operation | `save_draft` 只接受正文/周期/revision/source_refs；`submit` 还必须提供 UUID `reviewer_id`，可选 UUID 数组 `cc_user_ids`。审批选择进入请求哈希和不可变提案；prepare 只持久提案及审计，不创建 Report/Page/快照/通知。 | false        |
| execute_weekly_report_operation | 仅 operation_id；执行原提案，禁止正文/周期替换。submit 会改变正式状态、追加快照、写审阅日志/审计/站内通知，并进入现有审阅流程。                                              | false        |
| get_weekly_report_operation     | 仅 operation_id；恢复原提案和持久结果，不重做业务写入。                                                                                                                      | true         |
| cancel_weekly_report_operation  | 仅 operation_id；取消未执行提案，不撤销已提交业务数据。                                                                                                                      | false        |

第 2 阶段机器命名空间固定为 `/api/research/workspaces/<slug>/weekly-report-agent/`，提供 `tools/`、`tools/<name>/`、`mcp/`。
URL slug 必须与凭据工作区一致。登录态管理 API 使用独立 `/mcp/weekly-report/` 子命名空间，session + CSRF；机器凭据不能签发新凭据。
管理 API 的完整 options/issue/list/revoke 载荷和脱敏示例是阶段 2 交付，不由阶段 3 前端猜测。
HTTP JSON RPC 与 STDIO 必须返回同一目录/schema/错误码和只读标记；STDIO 更新专用白名单，保留现有连接协议。
每个响应最多 2 MiB UTF-8，不能直接沿用旧代理 256 KiB 预算导致合法完整提案无法展示；超限明确返回 response_too_large，不截断正文后标记 complete。

## 3. 成功响应（闭合对象）

以下列出的字段全部必返；`?` 表示可为 null，不表示省略。字符串上限按字符计，除明确说明外数组无可选隐藏成员。
所有响应带 `contract_version="plane.weekly-report.v1"`；不返回凭据。枚举、nullable 规则也适用于数据库 result。

### 3.1 公共结构

| 结构            | 字段与限制                                                                                                                                                                                                                                           |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| identity        | workspace_id:UUID, user_id:UUID, display_name:string≤255                                                                                                                                                                                             |
| period          | report_type:"WEEKLY", key:string(8), start:date, end:date, timezone:string≤255                                                                                                                                                                       |
| policy          | version:"current_and_previous_week.v1", allowed_period_keys:string[≤2], allowed_actions:(save_draft\|submit)[≤2], effective_visibility:现有 ReportVisibility 枚举, audience_summary:string≤2,000, policy_hash:sha256                                 |
| template        | id:UUID?, version:sha256, is_fallback:boolean；version 覆盖解析变量前模板和解析变量/回退模板                                                                                                                                                         |
| report          | id:UUID, status:DRAFT\|NEEDS_REVISION\|SUBMITTED\|ACCEPTED, official_version:integer≥0, url:string≤2,048                                                                                                                                             |
| approval        | schema_version, candidates:候选人数组, default_reviewer_id:UUID?, rules:闭合规则, active_route:route?；候选项包含 id、display_name、email、role、is_default                                                                                              |
| normalized_body | body_markdown:string≤50,000, description_json:编辑器 doc JSON, description_html:string, description_stripped:string, body_hash:sha256；JSON+HTML+纯文本合计≤512 KiB UTF-8，JSON≤2,000节点、深度≤16                                                   |
| source_result   | kind, id, node_id, version, content_hash:沿用输入；verification:"visible_version_checked", read_evidence:"declared_only", note:string≤500?                                                                                                           |
| effects         | creates_report:boolean, saves_draft:boolean, changes_status_to:DRAFT\|NEEDS_REVISION\|SUBMITTED, appends_official_snapshot:boolean, appends_review_log:boolean, writes_audit:boolean, creates_in_app_notifications:boolean, external_delivery:"none" |
| diff            | previous_body_hash:sha256?, proposed_body_hash:sha256, added_lines:integer≥0, removed_lines:integer≥0, summary:string≤2,000；摘要不是完整正文的替代品                                                                                                |
| commit_result   | report_id:UUID, period:period, status:DRAFT\|NEEDS_REVISION\|SUBMITTED, snapshot_version:integer≥1?, body_hash:sha256, report_url:string≤2,048, audit_id:UUID, committed_at:RFC3339, notification_record_ids:UUID[≤1,000], approval_route_id:UUID?, reviewer_id:UUID? |

sha256 均为 64 个小写十六进制字符。report_url 是现有网页可打开的报告链接，不加入 Agent 展示分支。
body_hash 是规范 JSON 对象 `{description_json,description_html,description_stripped}` 的 SHA256（UTF-8 NFC、排序键、紧凑分隔符）；Markdown 和二进制另由 proposal_hash/revision 覆盖。
save_draft 的 snapshot_version=null（即使已有 v1），不得拿上一正式版本冒充本次草稿版本；提交结果精确指向本次新快照。

### 3.2 get_weekly_report_context

响应字段：contract_version、identity、period、policy、template、report:report?、approval、revision:string(1–2048)、content_page。
不存在报告时 report=null，revision 仍必须绑定“该周期尚不存在”的前置条件。
已 SUBMITTED/ACCEPTED 时 allowed_actions=[]，返回现有正式版本，只能提示冲突，不能自动退回。

content_page 是闭合对象：encoding="utf-8-json"、text:string≤8,000、offset:integer≥0、total_chars:integer≥0、body_hash:sha256、next_cursor:string≤4,096?、complete:boolean。
完整编码流为 `{template_content:{description_json,description_html,description_stripped},report_content:{description_json,description_html,description_stripped}|null}` 的确定性 JSON 文本。
按 Unicode 字符边界切片，offset/total_chars 按字符计；连接全部 text 后解析 JSON，不把片段当完整正文。
正文不含旧协同二进制，只返回内容，其摘要仍受 revision 覆盖。模板/内容超过总预算则明确报 body_too_large。
cursor 必须签名并绑定 workspace/user/grant/period/revision/offset/流哈希，最长有效 15 分钟；任何内容变更返回 report_revision_conflict，不能混合两个版本。
complete 当且仅当 next_cursor=null 且 offset+len(text)==total_chars。

### 3.3 prepare / execute / get / cancel

这四个工具统一返回 operation：contract_version、operation_id:UUID、request_id:string≤128、status、action、identity、period、report_id:UUID?、expected_revision、proposal_hash:sha256、expires_at:RFC3339、proposal、result:commit_result?、readback、failure。

- status = PROPOSED | COMMITTED | CANCELLED | EXPIRED | REJECTED；不持久暴露中间执行状态。锁事务中的执行进度不可被误报为业务失败。
- proposal 是闭合对象：normalized_body、template、policy、source_refs:source_result[≤8]、diff、effects、approval:{reviewer_id:UUID,reviewer_role,cc_user_ids:UUID[≤100]}|null、agent_label:string≤100。submit 的 reviewer_id 必须来自当前 approval.candidates；save_draft 的审批字段被 schema 拒绝。
- readback = not_applicable | verified | pending。只有 COMMITTED 使用 verified/pending，其余为 not_applicable。
- failure 为 null 或 `{error_code:string≤80,message:string≤1,000}`；只在 EXPIRED/REJECTED 非空。
- result 仅 COMMITTED 非空，并与事务中持久的原 result 完全一致；prepare 不创建报告，未存在时 report_id=null。
- prepare 同 workspace/user/request_id、相同规范输入返回原 operation（含已 COMMITTED 的结果）；不同输入返回 idempotency_conflict。request_hash 包含动作、固定周期、原 expected_revision、规范 Markdown、审批人、抄送人和排序去重的引用，不包括瞬时当前状态；不能先重做业务验证而破坏丢响应恢复。
- 重复 prepare 仍要求当前有效凭据，并且只能回读原 grant 的操作；换 grant 不能接管旧提案或复用 request_id 改正文。跨用户/工作区/grant 的 operation_id 返回 not_found。
- execute 仅在 PROPOSED 下执行；COMMITTED 返回原结果；CANCELLED/EXPIRED/REJECTED 返回对应终态及 failure（取消的 failure=null），无业务写入。取消 PROPOSED→CANCELLED；重复取消幂等；取消 COMMITTED 返回原 COMMITTED，明确未撤销。
- 查询会把已超时 PROPOSED 持久转为 EXPIRED；execute 的预置条件/权限/策略失败可持久转为 REJECTED（业务回滚后另一个事务锁 operation 写终态），不得带半成品 result。临时数据库/网络故障不标 REJECTED，按同 operation_id 恢复。
- revoked/expired grant 一律拒绝机器调用；需通过登录态管理面排查或原网页核对结果，不能把重签凭据自动绑定到旧操作。

## 4. 正文、模板、来源

本阶段共享服务接收现有 REST 正文，不实现新的 Markdown 转换器；以下规范由阶段 2 落实并测试。

- Markdown 采用受限集合：段落、h1–h3、无序/有序列表、引用、分隔线、代码块/行内代码、粗体/斜体、http(s)/mailto 普通链接。遇到原始 HTML/脚本、图片、嵌入、资源附件或不支持语法须明确拒绝，不丢弃内容后继续提交。
- 一个解析后的 AST 同时生成编辑器兼容 JSON、HTML、纯文本；不分别用两个不一致的转换器。校验保存前后的规范体与 body_hash 一致。复用已有 HTML sanitizer 和报告图片/附件校验。
- 新正文写入同一个 Page，description_binary 置 null；不能添加第二套正文存储或把 Markdown 当唯一正文存放位置。normalized_body 存在 proposal 中是不可变执行载荷，不是新业务正文源。
- 优先展开现有周报模板；无模板才用“本周完成 / 问题与风险 / 下周计划”。不改变网页无模板时的旧行为。变量未解析失败，模板/组织/可见性变化执行拒绝重新准备，不能静默换模板。
- source_refs 是引用声明，不能带来源指令影响服务端策略。每项要求 kind/id/node_id/version/content_hash，可选 note；禁止重复项。服务端独立检验本人当前节点/资源可见性、指定版本和哈希；无法验证则拒绝，不把周报 grant 当节点读取凭据。节点素材仍从原节点连接读取。
- 首期没有机器可验证的读取票据，始终 read_evidence=declared_only；visible_version_checked 只说明服务器此刻验证了可见性与版本，绝不声称 Agent 本次实际读过。source_refs=[] 合法，可完全使用用户输入。

## 5. revision 与执行事务

revision 为签名的不透明版本令牌，不能只取 report.updated_at。规范前置摘要至少覆盖：

1. workspace/user/固定 period、报告存在/不存在、report.id/page.id/deleted_at。
2. 报告状态、组织/项目、可见性、授权读者、提交/接受时间、模板及团队引用；Page 的 JSON/HTML/纯文本/二进制完整哈希及 updated_at。
3. 活跃附件的 id/asset/内容元数据/删除与上传状态/official_version_no、正文图片资源状态及清单；正式快照最新版本及内容哈希。
4. 账号/工作区成员与组织关系、培养课题归属、组织保密路径、报告配置/时区/能力/模板版本、有效可见性与受众摘要。角色/策略与可见性变化必须冲突或拒绝，不能静默变宽。

不存在报告的令牌绑定唯一键及同样的策略/身份摘要；并发新建靠已有 workspace+owner+type+period 唯一约束兜底，在 savepoint 外捕获 IntegrityError，整体回滚 Page/引用，不留下孤立 Page。
签名过期或版本不一致都必须重新 context→prepare。分页期间也固定 revision。

阶段 2 的新写路径统一先取得 PostgreSQL 相关表的事务写入屏障，再锁 grant/operation，最后由共享服务锁 Report/Page；读取/取消不执行报告变更。
每次屏障锁等待上限 3 秒（不是整个操作耗时承诺）；它覆盖旧正文、图片/附件、组织/模板/策略写路径及并发插入，不要求修改报告前端。锁争用/死锁回滚返回可恢复的 503。
这是比单个报告行锁更保守的实现，会阻塞相关表的其他写入（包括其他工作区），带来源时覆盖研究域更多表；负载验证和更细的锁协议仍须后续评估，不能宣称只影响当前报告。
所有可影响 revision 的写入路径必须参与相同锁协议或有等效防竞态措施，包括通用 Page 保存、图片/附件变化及组织/策略变化；仅锁 Report 而任由关联数据写入并不满足并发安全。
阶段 2 已用上述屏障覆盖现有后端写路径；未来缩小屏障时必须保留同等防竞态措施，不修改报告前端。
同一事务中执行：重验授权与 proposal_hash/原前置版本及审批候选人→保存正文→既有 submit 状态机与不可变快照→创建 ResearchApprovalRoute→附件正式版本→审阅日志→来源审计→向选定 reviewer/CC 写持久通知→COMMITTED/result。审批路由表进入一致性屏障和 revision 前置摘要。
共享服务异常必须穿过最外层业务事务，不能捕获后正常退出原子块导致部分正文提交。

proposal_hash 覆盖契约版本、workspace/user/grant、request_id、action、固定 period、expected_revision、完整 normalized_body、来源、模板、策略、effects、expires_at；使用 UTF-8 NFC、JSON 排序键/紧凑分隔符的 SHA256，不哈希裁剪展示。
已提交操作的 result 指向原正式快照，不用此刻可变 Page 重建。execute 提交后快照回读失败仍返回 COMMITTED + 原 result + readback=pending；get 重试只更新回读投影，不重新通知或生成快照。

## 6. 通知与恢复

已核实当前 `notify_report_submitted` 同步 bulk_create 到 Notification，无外部发送调用。
本阶段将这些持久站内通知移入业务事务；这是站内通知的等效持久机制，不是新增异步 outbox，也不承诺外部邮件已送达。
阶段 2 用 operation 行锁与同事务 COMMITTED 保证重复 execute 不再创建 Notification，并持久记录通知 ID；若新增异步投递，应增加持久 outbox，唯一键(operation_id,event_type,receiver)，提交后由 worker 恢复投递。
外部投递最多承诺至少一次并使用投递幂等键，普通 on_commit 不提供崩溃恢复或“绝对一次”。
提案在没有实际通知接收人时 creates_in_app_notifications=false；接收人集合进入 revision 策略摘要，不能在执行时静默更换。

## 7. 错误

REST 保留已有错误 envelope 和 HTTP 状态；新工具业务错误统一为闭合 `{error_code,message,retryable,operation_id}`（operation_id 可 null）。
HTTP 直接工具入口使用对应状态；JSON RPC tools/call 以 isError=true+structuredContent 返回同一对象，不把未授权资源存在性带给客户端。

| HTTP    | error_code                                                                                                                                          | 客户端处理                                                       |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| 400     | invalid_arguments, invalid_markdown, invalid_cursor, body_too_large                                                                                 | 修正输入；不截断、不自动换 request_id                            |
| 401/403 | weekly_grant_required, grant_revoked, grant_expired, scope_denied, report_owner_denied, report_org_required, report_period_denied, reports_disabled | 停止写入，按登录态恢复权限；retryable=false                      |
| 404     | not_found                                                                                                                                           | 不泄漏其他用户/工作区/grant 的对象                               |
| 409     | report_revision_conflict, report_already_submitted, report_state_conflict, policy_changed, source_changed, idempotency_conflict                     | 重新读取、展示差异、重新准备；禁止自动接受变化                   |
| 410     | proposal_expired                                                                                                                                    | 重新读取并准备                                                   |
| 413     | response_too_large                                                                                                                                  | 明确失败，不返回伪完整正文                                       |
| 503     | temporarily_unavailable                                                                                                                             | retryable=true；同 operation_id 查询或同 request_id 重试 prepare |

其余错误 retryable=false。机器超时是“结果未知”，不能由客户端推断为未提交。
共享报告服务原有研究业务错误码及 422 等状态继续沿用，转换为相同闭合错误对象；业务写入先完整回滚，再记录操作拒绝。
业务失败不返回正文/凭据到日志；操作和审计保存 Agent 来源，不新增周报详情展示。

## 8. 阶段 2 入口

先核对本契约、共享服务和阶段状态记录。增加独立模型/迁移、purpose 鉴权、可显式关闭的开关（当前默认启用）、revision/Markdown 转换、五工具/管理 API、HTTP/STDIO 和可靠结果恢复。
补齐并发/撤权/组织保密变化/来源变化/通知故障测试，验证编辑器重开、保存、刷新后正文不恢复旧二进制。
前端等阶段 3，仅在现有 MCP 设置容器并列挂载原 MCPManagement 和独立 WeeklyReportMCPSettings；不复用伪 research target，不修改周报业务页面。
