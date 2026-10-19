# 科研链 MCP v2.1：任务、草稿与人工确认

2026-10-19 页面更新：从个人设置中 Plane API 与智能体配置之间的「MCP 连接」，或节点工作台「MCP / Agent 操作」进入 `/settings/profile/mcp/`，选择科研节点接入。旧管理页地址自动跳转并保留节点上下文；旧提案 `review_path` 保留原人工确认组件；协议、精确提案确认及执行流程不变。见 [统一管理说明](../../docs/operations/mcp-unified-management.md)。

实现日期：2026-10-17。本版新增受控写入代码，保留 v1 的十个只读工具与原连接入口。部署、人工业务确认和真实 Codex 操作验收须与代码测试区分。

2026-10-18 更新：本机主 Web 与 API 已部署、启动，0182 迁移及两个后端开关已生效；Web 构建和官方类型检查通过。用户人工确认后，已通过原生 MCP HTTP 真实执行创建任务、追加评论、追加科研过程记录，并独立读回一致。分析草稿及资源关联仍待真实业务验收。见 [验收摘要](../../docs/operations/research-mcp-v21-acceptance.md)。

服务器交付见 [给部署同学的操作说明](../../docs/operations/research-mcp-v21-deployment.md)；无需另外部署独立 MCP 服务，工作区和节点授权需在服务器重新生成。

## 已实现的五类动作

| action                 | 必填业务内容                              | 结果                                                 |
| ---------------------- | ----------------------------------------- | ---------------------------------------------------- |
| `create_task`          | `title`；可选 `instruction`               | 当前节点的新科研任务，固定 `DRAFT`，不指派、不设期限 |
| `append_task_comment`  | `task_id`、`text`                         | 当前节点科研任务追加评论，按纯文本转义后保存         |
| `save_analysis_draft`  | `method`、`summary`；可选 `conclusion`    | 新的 `DRAFT` 分析，保留来源，不生成正式快照          |
| `attach_task_resource` | `task_id`、`resource_type`、`resource_id` | 为可编辑且未绑定资源的任务新增绑定                   |
| `append_research_note` | `text`                                    | 节点新增 `RESEARCH_NOTE`，标明 Agent 来源            |

文本正文最多 8000 字符，任务标题最多 500 字符。任务评论是二开的科研任务评论，不是原生 IssueComment。

关联类型支持 `REPORT`、`STAGE_MATERIAL`、`PAPER_REVIEW`、`SNAPSHOT`、`EXTERNAL_REF`。报告和快照必须提供 `version`。所有资源都必须已经在当前节点可见，且来源 ACL 有效；此工具不提供把任意对象引入节点的捷径。正式报告还需要在连接授权时明确选择版本。

现有任务模型的 `OUTCOME` 暂不开放给机器关联：v1 没有对应的节点范围读取解析器。课题附件本体、任意上传对象也不是上述任务关联枚举。此处有意保持封闭范围，不绕过来源检查写入裸 ID。

本版允许在活动科研链的草稿、活动、需修改或失败节点中工作；待人工审核、已完成、归档节点拒绝 Agent 变更。不会改变节点状态、完成任务、认定分析结论或执行外部实验。

## 开启方式

1. 备份数据库，部署后端与前端代码，执行迁移至 `0182_research_agent_operations`。本版还有 v1 的 0181 迁移前置。
2. 后端保持 `RESEARCH_MODULE_ENABLED=1`，并同时设置 `RESEARCH_MCP_ENABLED=1`、`RESEARCH_MCP_WRITE_ENABLED=1`。这些开关默认关闭；本机现已按用户授权开启并应用 0182，其他部署需要显式配置。
3. 打开科研链，进入节点工作台，展开目标节点，下方可见“Agent 操作审核”。科研管理员可以显式启用工作区 Agent 操作。
4. 用户展开“连接 Agent 与管理授权”，勾选允许的动作、需要引用的正式报告版本，生成当前节点的连接配置。普通个人 API Key 与原来的只读 context grant 不会自动获得写能力。
5. 将配置保存到自己的本地私密设置。连接密钥只展示一次，可隐藏、撤销；显式节点连接由 `RESEARCH_MCP_NODE_TOKEN_TTL_SECONDS` 控制，默认 604800 秒（7 天）。旧上下文交换仍用 `RESEARCH_CONTEXT_TOKEN_TTL_SECONDS`，默认 600 秒。已有连接不追溯延期；到期后重新生成连接，旧操作仍可在同一用户、同一节点、相同动作范围下恢复。

工作区写开关、节点写授权、现有业务角色与每项操作确认共同决定最终权限。用户只能确认自己的提案，不借用另一审核人的高权限执行操作。

旧 `research_mcp.py`、`research-read-only` 网关模式及 v1 `/agent-access/mcp/` 均保留。v2.1 直接使用新后端 HTTP 地址或下列独立 STDIO 入口；现有独立 HTTP 网关的模式枚举没有扩展为写模式。

## Codex / 通用 Agent 连接

后端 HTTP 地址：

```text
http://127.0.0.1:8001/api/research/workspaces/<workspace-slug>/agent-operations/mcp/
```

请求头必须同时包含用户页面生成的 `X-Research-Context-Token`、`X-Research-Context-Hash`；操作入口不接受个人 API Key 代替节点写授权。配置里的地址必须使用 Agent 能访问的 Plane API origin。

本地 Codex TOML 配置示意，替换地址和页面生成的密钥；不要提交真实配置：

```toml
[mcp_servers.plane_research_operations]
url = "http://127.0.0.1:8001/api/research/workspaces/REPLACE_WORKSPACE/agent-operations/mcp/"
http_headers = { "X-Research-Context-Token" = "REPLACE_LOCALLY", "X-Research-Context-Hash" = "REPLACE_LOCALLY" }
```

独立 STDIO 入口：`research_operations_mcp.py --config <private-file>`。使用已有 Demo Python 环境，私密 JSON 为：

```json
{
  "PLANE_BASE_URL": "http://127.0.0.1:8001",
  "PLANE_WORKSPACE_SLUG": "REPLACE_WORKSPACE",
  "RESEARCH_CONTEXT_TOKEN": "REPLACE_LOCALLY",
  "RESEARCH_CONTEXT_HASH": "REPLACE_LOCALLY"
}
```

同名环境变量可覆盖配置。该入口不会读取 `PLANE_API_KEY` 作为写授权，也不会把 context token 发送到原生 Plane MCP。

## 一次完整操作

1. Agent 使用 v1 读工具取得节点和证据。
2. 调用 `prepare_research_operation`。例如：

```json
{
  "request_id": "temperature-check-001",
  "node_id": "REPLACE_NODE_UUID",
  "action": "create_task",
  "payload": { "title": "核对首轮实验的温度条件", "instruction": "比较设备日志和实验记录，标明缺失资料。" },
  "source_refs": []
}
```

如需依据，`source_refs` 最多 8 项，每项为 `{ "kind": "analysis", "id": "UUID", "usage": "body" }`，可附 `version`。`usage=metadata` 只引用元数据；`body` 必须有正文读取能力，不能给附件元数据伪造全文依据。此标记声明引用方式，不代表已经证明模型完整阅读过全文。

3. 返回 `operation_id`、不可变提案哈希、内容、来源与 `review_path`。用户打开 Plane 链接，核对目标节点、任务和全部内容，选择确认或拒绝。准备提案会写提案表与审计，但不新增目标科研任务/评论/分析。
4. Agent 调用 `execute_research_operation`，参数只有 `{ "operation_id": "UUID" }`。它没有批准工具，也不能传入替换载荷或 `approved=true`。
5. 成功返回 `COMMITTED`、真实对象 ID、Agent 来源事件 ID、审计 ID，以及读回状态：`verified` 表示内容相符，`pending` 表示待读回，`changed` 表示对象已有后续修改。Agent 可继续使用 v1 读取正文。

其余工具：`get_research_operation`、`list_research_operations`、`cancel_research_operation`。工具目录按当前授权裁剪允许的动作；工具标签不能取代后端权限检查。

## 并发、到期与恢复

- 提案有效期 24 小时，显式节点 MCP 连接默认 7 天；这两个期限不同。审核记录绑定同一提案哈希及有效期。
- 同一用户和工作区的同一 `request_id` 返回同一提案；改载荷返回冲突。重新连接后仍可以查询自己同节点、动作范围允许的提案。
- 执行重新检查当前授权、业务角色、链/节点状态、任务完整数据和来源完整哈希。网页改了目标、资源已有绑定或依据变化后，不覆盖执行，需要准备新提案。
- 同一操作并发或重复执行只产生一次业务结果，事件与审计随业务事务一起提交。原生任务事件保留实际用户，另有明确 `actor_type=AGENT` 的来源事件关联操作、Agent、提出者、确认者及当前连接。
- 提交后读回失败仍返回 `COMMITTED`，读回为 `pending`；查询同一操作补读，不重建任务。响应丢失时也先查询同一操作。
- 不确定 `prepare` 是否成功时，重复相同 `request_id` 与载荷，不生成新 ID。执行重试始终使用原来的 `operation_id`。
- 取消只对未执行提案有效。多个提案独立执行，不能自动删除已经写入的数据来模拟整批回滚。
- 来源权限撤销后，相关提案也会从当前可查询结果中隐藏。审计只记录摘要、ID 和哈希，不存连接密钥。

## 人工接口与鉴权

人工界面 API：`GET/POST /api/research/workspaces/{slug}/nodes/{node_id}/agent-operations/`。

仅接受真实登录会话，采用 DRF 标准 `SessionAuthentication` 校验 CSRF。GET 返回受保护页面需要的 CSRF token；POST 必须携带 `X-CSRFToken`。个人 Key/context token 无法调用人工确认接口。`issue_grant`、`revoke_grant`、`decision` 与管理员 `workspace_policy` 都在此可信入口处理。

机器接口另设 `/agent-operations/tools/`、`/tools/{name}/`、`/mcp/`，不接受登录 Cookie 回退。读功能与操作工具分别保留白名单；ScienceDiscovery、Synlora 的写会话分发及最终联调不在本版范围。

## 验证与交付状态

代码测试、本机部署和真实写入结果见 [验收摘要](../../docs/operations/research-mcp-v21-acceptance.md)。2026-10-18 已完成三类真实 MCP 写入：创建任务、追加评论、追加科研过程记录，均经过页面人工确认、执行及读回；另两类通过代码测试，尚待真实业务验收。未启动 ScienceDiscovery，未使用真实科研文件。

测试服务器上线后的人工验收按上述流程，用自己的测试节点完成五种动作、拒绝一项提案、重复执行一项、撤销连接后重试，并核对真实对象和来源事件。本机已完成项不等于服务器验收通过；分析草稿及资源关联的真实业务验证仍须补齐。
