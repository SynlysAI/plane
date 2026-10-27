# 周报 MCP v1：阶段 2 接口与连接说明

日期：2026-10-26。契约：`plane.weekly-report.v1`。
接口已实现；本次没有部署、推送或合并，也没有前端改动。

完整规范见 [v1 契约](mcp-weekly-report-contract-v1.md)，请求字段见 [schema](mcp-weekly-report-contract-v1.schemas.json)。
[脱敏请求/响应样例](mcp-weekly-report-api-v1.examples.json) 是在独立、已迁移的临时 PostgreSQL 上通过真实 Django API 捕获的 12 组结果；账号/工作区为合成夹具，密钥、CSRF、签名 revision 已替换为 `<redacted>`，不能直接执行。

## 登录态管理 API

管理面只接受当前登录会话，POST 必须带同会话 `X-CSRFToken`；周报 token、节点 token 和 API key 不能替代登录与 CSRF。
响应都带 `Cache-Control: no-store`；错误是 `{error_code,message,retryable,operation_id}`，operation_id 可 null。
路径中 slug 必须 URL 编码。

| 方法 | 路径                                                                               | 请求/响应                                                                                             |
| ---- | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| GET  | `/api/research/mcp/weekly-report/options/`                                         | 本人有有效非访客席位的候选工作区及能力；返回 workspaces、identity、csrf_token、contract_version       |
| GET  | `/api/research/workspaces/<slug>/mcp/weekly-report/options/`                       | 同形响应，workspaces 仅含所选工作区                                                                   |
| POST | `/api/research/workspaces/<slug>/mcp/weekly-report/connections/`                   | 仅 `{label,actions,ttl_days}`；HTTP 201，连接元数据加 mcp_path、headers、csrf_token、contract_version |
| GET  | 上述 connections 路径                                                              | 本人连接，每页 30 条；仅可传 cursor；返回 results、next_cursor、csrf_token、contract_version          |
| POST | `/api/research/workspaces/<slug>/mcp/weekly-report/connections/<grant_id>/revoke/` | 必须为空对象 `{}`；返回 `{revoked:true,id}`，重复撤销幂等                                             |

workspaces 每项字段固定为：

```text
id: UUID
slug, name: string
enabled: boolean
unavailable_reason: string | null
actions: ["save_draft", "submit"]，不可用时 []
ttl_days: [1, 7, 30]
period_policy: "current_and_previous_week.v1"
period_description: "仅本人本周与上周的周报，周期按工作区报告时区计算。"
```

签发请求示例：

```json
{ "label": "个人周报助手", "actions": ["save_draft", "submit"], "ttl_days": 7 }
```

label 去除两端空白后 1–100 字符，不允许控制字符；动作不得重复、不得为空；ttl_days 必须是后端选项中的整数。
只选 save_draft 不获得 submit；只选 submit 也不隐含 save_draft。
同一工作区/本人最多 10 条未撤销、未过期连接，达到限制返回 grant_limit/409。

连接元数据字段：id、workspace（slug）、label、actions、report_type="WEEKLY"、period_policy、created_at、expires_at、revoked_at、last_used_at。
完整密钥仅在签发响应的 `headers["X-Weekly-Report-Token"]` 出现一次；列表和撤销不返回密钥/摘要。
列表包括过期、撤销记录；开关关闭或失去科研组织关系后，仍可由有效工作区成员登录列出/撤销自己的连接。
列表 cursor 有效 1 小时，绑定本人和工作区；不能复用于其他账号或工作区。

## HTTP 与 STDIO

原生 HTTP MCP 地址直接使用签发响应 `mcp_path`，加当前 API origin：

```json
{
  "mcpServers": {
    "plane_weekly_report": {
      "type": "http",
      "url": "https://plane.example/api/research/workspaces/example/weekly-report-agent/mcp/",
      "headers": { "X-Weekly-Report-Token": "<one-time-secret>" },
      "timeoutSeconds": 30
    }
  }
}
```

机器 REST 与 HTTP MCP 使用同一服务、目录及 schema：

```text
GET  /api/research/workspaces/<slug>/weekly-report-agent/tools/
POST /api/research/workspaces/<slug>/weekly-report-agent/tools/<tool_name>/
POST /api/research/workspaces/<slug>/weekly-report-agent/mcp/
```

JSON RPC 支持 initialize、ping、tools/list、tools/call；使用无会话 JSON 响应，不提供 SSE、审批页或额外平台授权步骤。
tools/call 业务错误使用 isError=true，structuredContent 是同一错误对象；REST 使用对应 HTTP 状态。
只读标记仅 context/get-operation 为 true；execute 明确标记会更新业务数据，并描述正式状态、快照、审阅日志和站内通知。

STDIO 入口为 `demos/sciencediscovery-plane-mcp/weekly_report_mcp.py`。使用现有 demo MCP 运行环境，私密配置只接受以下三个身份参数：

```json
{
  "PLANE_BASE_URL": "https://plane.example",
  "PLANE_WORKSPACE_SLUG": "example",
  "WEEKLY_REPORT_TOKEN": "<one-time-secret>"
}
```

用该环境的 Python 运行 `weekly_report_mcp.py --config <私密配置路径>`，或设置同名环境变量。
STDIO 有独立的五工具白名单，校验目录及只读标记，禁止节点工具混入；只发送专用周报头，不回退到 API key/节点凭据。
两个传输的响应预算均按 2 MiB 设计；新代理不沿用旧研究客户端的 256 KiB 限制，不跟随重定向、不自动重试写入、不输出原始异常或服务器回显的敏感消息。
现有 research_mcp.py、research_operations_mcp.py、HTTP 管理门户和旧连接协议不变。

## 提交与恢复

1. context 选择 period_offset=-1 或 0（也可显式 period_key），返回固定周期、模板、身份、受众范围及 revision。正文分页串接全部 text 后才是完整 JSON，不可把第一页当完整正文。
2. prepare 必须传 request_id、固定 period_key、expected_revision、action、body_markdown，可传 source_refs。返回完整规范正文、差异、有效可见性、真实副作用和不可变哈希；此时没有创建 Report/Page。
3. Agent 客户端展示提案并在用户已授权范围内 execute 同一 operation_id。不能传替换正文、owner、workspace 或新周期。
4. 超时先 get 原 operation_id；prepare 超时用相同 request_id 与完全相同参数重试。不得悄悄换 ID 重提。
5. COMMITTED 的 result 始终是原报告/正式版本/哈希/链接/审计与通知 ID；readback=pending 仍表示已提交，继续查询同一操作。

取消只能取消未执行提案；对 COMMITTED 调用取消返回原 COMMITTED，不撤销正式报告。
过期提案持久变成 EXPIRED；冲突/业务拒绝在业务事务回滚后持久为 REJECTED。
数据库争用或临时故障保留可恢复状态，返回 retryable=true 的 503；不把失败通知或结果写入误记为已提交。
凭据已撤销/过期或成员资格失效时机器回读也会拒绝，应从登录态管理列表及原报告网页核对，不能让新凭据接管旧操作。

source_refs 不自动取得节点读取权限。继续使用原节点连接获得素材；后端在准备/执行时独立验证当前节点可见性、版本和内容哈希。
对正文可读资源，content_hash 沿用原 read_research_resource 返回值。仅有元数据但不能验证编号版本/哈希的资源会被拒绝，不声称解析过附件。
来源返回 `verification=visible_version_checked`、`read_evidence=declared_only`，不声称 Agent 本次实际读取过。无素材引用的本人周报同样可用。

## 实现边界与阶段 3 接入

- `RESEARCH_WEEKLY_REPORT_MCP_ENABLED` 未配置时默认启用（2026-10-27 按测试服务器要求调整），无需在 `.env` 添加启用项；显式 `0` 仍可关闭。报告能力沿用当前 workspace_research_sections/nav_allowed 规则，不依赖旧 RESEARCH_MCP_ENABLED/WRITE_ENABLED 或科研链写开关。没有改动当前部署环境变量。
- 新迁移：`0201_weekly_report_agent`，新增独立 grant/operation；未改旧报告唯一键或节点操作语义。
- 正文只写原 Page，旧 description_binary 清空；官方 Snapshot、审阅日志、Agent 审计、站内 Notification 和 COMMITTED/result 在一个事务提交。Notification 是现有持久站内通知机制，没有新增外部发送或普通 on_commit“绝对一次”的承诺。
- 新接口采用 PostgreSQL 写入屏障，覆盖 Page、资源、组织/成员、模板和策略变更，包括并发插入；持有期间会阻塞相关表的其他写操作，可能影响其他工作区。带来源校验时覆盖面更大。每次锁等待上限 3 秒（不是整个操作耗时承诺），争用/死锁回滚返回 503，不能盲目创建新操作。尚未做负载与长期运行验收；需要保持关闭的环境须显式设置 `RESEARCH_WEEKLY_REPORT_MCP_ENABLED=0`。
- revision 对组织/成员策略做保守摘要，工作区内其他策略变更也可能要求重新准备。这是首期安全边界，不能通过删掉相关版本检查来减少冲突。
- 浏览器真实编辑器重开/保存/刷新，以及实际客户端 HTTP/STDIO 到网页的完整验收留在阶段 4，当前只验证了数据库正文表示、旧二进制清理、接口与代理。
- 阶段 3 只新增独立 WeeklyReportMCPSettings 与轻量 service/types，由 MCP 设置容器内部页签挂载；保留原 MCPManagement，不伪造 research MCPTarget/nodeId。
- 前端只处理候选工作区、名称、动作、后端期限、签发结果复制/导出、列表、撤销。使用签发响应组装通用 MCPConfig 即可复用 configurationFiles，无需改变旧连接业务类型。
- 切页/切工作区/关闭弹窗必须销毁本次 headers；不得写入 localStorage、日志或 URL。签发结果不确定时先刷新列表，不自动重新签发。inModal 不读取背后业务页面参数。
