# 科研链与节点只读 MCP v1

本版扩展二开的科研模型，不经过官方 Plane SDK，也不把科研节点当作 Issue。保留现有基础只读和任务进展工具。

## 已实现的工具

```text
list_research_chains
get_research_chain
list_research_nodes
get_research_node_context
list_research_node_events
list_research_node_snapshots
list_research_node_tasks
list_research_task_comments
list_research_node_resources
read_research_resource
```

工具 Schema 由后端 `plane/research/services/mcp_catalog.py` 定义。所有工具只读；任务与评论指科研任务，不是 IssueComment。

`get_research_node_context` 返回节点及六类证据样本，明确 sample_only；完整历史使用分页工具。默认每页 20 条，最多 50 条；游标绑定用户、授权、工具与查询，不能跨节点/查询复用。单次最多扫描 200 条候选，即使本页没有可见结果，只要 has_more=true 仍应继续。cursor 还绑定 limit，请续页时保留原参数。

资源必须是节点的直接子对象，或在事件、快照、任务中有明确引用，并再次通过目标对象 ACL。不会把同项目全部实验/报告自动视为当前节点内容。

正文支持 task、task_comment、event、analysis、snapshot、experiment、report、agent_event。任务指令、评论和过程事件的列表项提供 content_ref，长内容可继续分段读取。正式报告要求显式 version，复用正式快照授权及版本漂移规则；内嵌节点授权只允许会话创建时固定的报告版本。实验不指定 version 时明确返回 current 状态，不冒称正式快照。agent_event 按 event_type 和 remote_type 白名单投影公开回答，隐藏内部推理及未知远端事件；工具事件只提供公开名称和调用 ID，不返回原始工具输出。事件带 run_id、session_id、seq，不能按 seq 跨运行去重。

upload、paper_review、stage_material、topic_material、external_reference 先提供元数据，正文读取返回 unsupported_content。不会下载任意 URL，不把 PDF 文件列表或 KB list 冒充已解析正文。

`read_research_resource` 返回可分页的 `json_text`；每段不一定是独立 JSON 文档，应按顺序拼接 text。content_hash 改变时旧游标失效，需重新开始。默认 8000 字符，最多请求 16000；若加上 JSON 转义超过总输出预算，可减小 max_chars。普通任务指令、评论及事件摘要是有界摘录，会标明相应截断。

## 部署开关

在 **Plane API 实际加载的环境文件** 中设置：

```dotenv
RESEARCH_MODULE_ENABLED=1
RESEARCH_MCP_ENABLED=1
RESEARCH_MCP_PUBLIC_BASE_URL=https://your-plane-backend.example
```

工作区还需开启科研模块、科研链；内嵌 Agent 还需开启 Agent 和个人 ScienceDiscovery 后端开关，并配置用户的 SD 连接。

PUBLIC_BASE_URL 是 SD 能访问的 Plane 后端 origin，不带 /api、认证信息或查询参数。不要使用只在浏览器所在机器可达的 localhost；通过反向代理时需保证 `/api/research/...` 被转发到该后端。独立客户端模式不使用 PUBLIC_BASE_URL，内嵌 SD 自动接入需要它。

这些开关默认关闭。已有会话不会被自动改造；配置完成后新建节点 Agent 会话。

科研 MCP 接口复用已有 ResearchContextGrant 和 AgentSession.assembly 保存范围与非敏感连接标识。后续补验修复了历史科研任务资源关联约束，新增 `0181_fix_research_task_resource_constraints`，部署当前代码需先执行数据库迁移；本地验收环境已备份并应用。授权有效期沿用 RESEARCH_CONTEXT_TOKEN_TTL_SECONDS（默认 600 秒）；过期后应新建会话，不静默延长或退回高权限凭据。

## 入口一：直接连接后端 HTTP MCP

后端新增：

```text
POST /api/research/workspaces/{slug}/agent-access/mcp/
```

独立个人客户端使用 `X-Api-Key`。内嵌 SD 使用 `X-Research-Context-Token` 和 `X-Research-Context-Hash`；这是独立于 SD bearer 的 Plane 节点授权。没有浏览器 Cookie 回退。过期/无效 Context 不回退到同时提交的 API Key。

支持 stateless JSON Streamable HTTP：initialize、ping、tools/list、tools/call；不建立 MCP session，不提供 SSE、prompts、资源下载或写工具。部署代理需允许 JSON POST；不缓存响应。每个凭据限制 120 请求/分钟。

另有机器 REST 入口（同一认证和授权逻辑）：

```text
GET  .../agent-access/tools/
POST .../agent-access/tools/{tool_name}/       # 只读工具调用
GET  .../agent-access/chains/
GET  .../agent-access/chains/{chain_id}/
GET  .../agent-access/chains/{chain_id}/nodes/
GET  .../agent-access/nodes/{node_id}/context/
GET  .../agent-access/nodes/{node_id}/events/
GET  .../agent-access/nodes/{node_id}/snapshots/
GET  .../agent-access/nodes/{node_id}/tasks/
GET  .../agent-access/tasks/{task_id}/comments/
GET  .../agent-access/nodes/{node_id}/resources/?kind=analysis
GET  .../agent-access/nodes/{node_id}/resources/{kind}/{id}/content/
```

资源列表的 kind 参数必填；报告正文需要 version。游标是短期签名值，不是页码。

## 入口二：独立 STDIO 或已有 HTTP facade

沿用本目录固定依赖环境和个人配置中的 PLANE_BASE_URL、PLANE_WORKSPACE_SLUG、PLANE_API_KEY。

```powershell
python research_mcp.py --config C:\private\plane-config.json
```

STDIO 从机器 API 发现 Schema，再进行本地白名单/Schema 校验，不启动官方 plane_mcp 子进程。

已有 `http_mcp.py` 增加 `research-read-only` 模式，示例见 [research-http.example.json](research-http.example.json)。仍为每个客户端单独绑定个人 Plane 凭据；enable_publish 必须为 false。原 `/connect` 自助门户仍提供原生任务工作流，未默认切换科研模式。

HTTP Dockerfile 已包含新增 Python 文件；不要将示例 token 原样使用，也不要提交真实凭据。

## Plane 内嵌 ScienceDiscovery

新建节点会话时，Plane：

1. 签发绑定用户/工作区/课题/节点的只读 grant，允许十个科研 Tool。
2. 固定该节点明确引用且当前可读的正式报告版本，最多 50 份。
3. 使用现有 SD `/api/mcp/servers` 接口创建**每 grant 独立 Server ID**，SD 将 header 凭据加密保存。
4. 在会话 settingsOverrides 中显式启用该 sourceId，禁止复用共享 Server 的授权 header；普通 SD 工作区能力仍由 SD 自身策略决定。
5. 关闭 Plane 会话时先撤销 grant，再尝试删除 SD connector；即使 SD 离线，撤销后的后端读取也被拒绝。

这里使用现有 SD custom connector 的按 Server ID 连接隔离和禁用结果缓存，无需修改 SD TypeScript 运行时。新增会话只显式启用当前科研 connector，不自动开放其他第三方 connector。

创建后的工具发现是运行时接入步骤；失败则撤销 grant 并使创建失败，不伪装科研 MCP 已就绪。SD 服务端若无法回连 PUBLIC_BASE_URL，会在此阶段失败。远端调用较慢时可按部署情况调整已有 SCIENCE_DISCOVERY_TIMEOUT_SECONDS。

过期 Server 在同一用户后端的下一次注册时清理；SD 原有限制最多 50 个自定义 Server，未关闭且未过期会话仍占配额。失败后残留的凭据会随 grant 过期/撤销失效。Synlora 的自动绑定未在本版实现；它可以使用独立 HTTP MCP 接入，但需其自身的真实工具配置接口。

## 代码与测试

后端：`views/agent_access.py`、`services/chain_context.py`、`services/mcp_catalog.py`；会话装配改动位于 `agent_orchestrator.py`、`sciencediscovery.py`、`views/agent.py`。

新增测试：

- `plane/tests/unit/research/test_mcp_catalog.py`：拒绝扩权输入、隐藏未授权工具。
- `plane/tests/contract/app/test_research_machine_access.py`：个人 Key、节点 grant、撤销、跨范围、500+ 事件分页、引用关联、科研评论及内容版本变化。
- 本目录 `tests/test_research_mcp.py`：STDIO facade 边界、Schema 校验与错误脱敏。
- `plane/tests/unit/research/test_sciencediscovery_research_binding.py`：独立连接配置、会话 source 选择与失败清理。

初次实现时按当时要求未运行测试、构建、部署或端到端验证。本仓库仍禁止自主运行 Docker 测试栈。

### 2026-10-17 本地 Plane × Codex 验证

后续按用户授权，在已有本地 Plane 环境完成验证：独立代理单测 5 项、后端单元与契约测试 21 项、真实 REST/HTTP MCP 检查 46 项及授权生命周期检查 9 项全部通过。后端测试使用独立测试数据库与进程内缓存，未运行 `docker-compose-test.yml` 或构建镜像；ScienceDiscovery 装配单测只模拟远端请求。

Codex CLI 两轮业务验收共执行 24 次真实科研 MCP 调用，确认评论随机标记、分析正文、正式报告版本、分页与文件元数据边界，并实际验证同链其他节点和未关联实验被拒绝。修复正文缩短时旧游标误报 `invalid_cursor` 的问题，现统一返回 `version_changed`，并补充长、短正文变化的契约用例。

结果见 [验收摘要](../../docs/operations/research-mcp-v21-acceptance.md)。两轮 Codex 原始回答及脱敏调用记录保留在开发机根 `output/research-mcp-validation-2026-10-17/` 忽略目录，不随 Git 发布。演示数据保留，测试凭据已撤销；本次未进行 ScienceDiscovery 集成验收。

### 同日五类资源补充验收

按 [补充验收计划](EXTENDED-ACCEPTANCE-PLAN.md) 完成 paper_review、stage_material、topic_material、external_reference 和 agent_event 验收：后端 79 项（核心 21、扩展 58）、独立代理 5 项、真实接口检查 71 项均通过；201 条已关联但来源无权候选后的空页续读另有加强用例通过。Codex 三轮共 21 次真实调用，12 次正常读取、9 次预期拒绝。

补验修复了内部 Agent 事件/原始工具输出过滤、外部引用撤销、材料评审人权限与父阶段删除，以及历史任务关联数据库约束；新增 0181 迁移。前四类仅元数据验收通过，正文仍未实现；Agent 公开投影正文通过。结果见 [验收摘要](../../docs/operations/research-mcp-v21-acceptance.md)，原始证据保留在开发机根 `output/research-mcp-extended-validation-2026-10-17/` 忽略目录；18 张业务表快照一致，临时凭据已撤销，未启动 ScienceDiscovery 或进行真实文件上传/解析、源端联调。
