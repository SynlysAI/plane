# 行政＋科研统一 MCP v1：发布、迁移与回退

日期：2026-10-29。当前为本机人工验收版；完整状态与真实/未验证项见 [实施状态](../plans/unified-mcp-status.md)。最新 develop 兼容回归已完成；ScienceDiscovery 目标 Agent 验证和生产发布验收仍需记录，远端尚未部署。

## 配置与使用

进入个人设置 → MCP 配置，填写名称、选择工作区和分域读写能力，生成一条连接。动态包含未来对象仍与本人当前权限取交集；固定快照只读。复制/导出一次性配置后关闭，密钥不能恢复，可撤销重建。新入口为同实例 `/api/mcp/`，只有一个 server。配置页仅展示统一连接；旧接口和既有授权保留原范围，不会自动升级。周报 purpose 与正式提交保持独立。

Codex 示例（替换域名，在启动客户端的环境中设置 PLANE_MCP_TOKEN 为本次一次性统一密钥；不要把尖括号占位文本当成密钥）：

```toml
[mcp_servers.plane]
url = "https://plane.example.invalid/api/mcp/"
bearer_token_env_var = "PLANE_MCP_TOKEN"
tool_timeout_sec = 120
default_tools_approval_mode = "prompt"
```

通用 MCP JSON 示例，与上方代表同一连接的另一客户端格式：

```json
{
  "mcpServers": {
    "plane": {
      "type": "http",
      "url": "https://plane.example.invalid/api/mcp/",
      "headers": { "Authorization": "Bearer <ONE_TIME_UNIFIED_SECRET>" },
      "timeoutSeconds": 120
    }
  }
}
```

真实 Codex CLI 已完成发现与双域调用；验证脚本 `scripts/unified-mcp-agent-acceptance.py` 仅用于隔离本机账号/数据，要求已有 Codex 登录，读取真实 UI 导出的单 server JSON、明确的验收 prompt 和新的私密输出目录。它将凭据只传入该子进程环境，忽略用户全局配置、使用 ephemeral 会话，保留实际工具失败证据。它不代替 ScienceDiscovery Agent 的验证。

配置方式依据已读取的 [官方 MCP 文档](https://developers.openai.com/codex/mcp) 和 [非交互运行文档](https://developers.openai.com/codex/noninteractive)，实际支持以已验证 CLI 为准。本机验收使用临时明确授权的 auto 工具策略，未修改用户全局策略；上方示例保留普通 prompt 默认。

## 增量发布准备

1. 核实目标目录、当前分支/HEAD、已有改动及实际部署入口，备份原数据库、上传文件、环境文件、源码差异和前端产物，检查数据库备份能列出目录。禁止 setup.sh 覆盖现有配置或 down -v 删除卷。
2. 对比并构建当前后端锁定依赖。统一入口本身不新增基础设施；当前周报源码另要求 requirements/base.txt 已声明的 markdown-it-py==4.2.0，旧本机镜像曾缺失此包，不能只挂源码就认为镜像可用。
3. 暂停应用写入，应用现有迁移；统一功能需 **0207_unified_mcp_connection、0208_unified_mcp_write_result、0209_research_operation_unified_source**，与当前 develop 的迁移分支通过 **0210_merge_develop_unified_mcp、0211_merge_latest_develop_unified_mcp** 汇合。目标库可能还欠前序迁移，先查看完整计划，不仅执行某个新表 SQL。0209 只扩展真实统一连接来源及恰好一个来源约束，不回写旧提案 seal/hash；两项合并迁移没有数据操作。
4. 更新 API 与 Web，沿用现有 worker/beat/存储/门户。按现有流程启动；生产入口复用同域 `/api/mcp/`，反代需正确保留 Host/协议与 Authorization，沿用既有 Origin、CSRF、成员/科研策略。无需新增网关、Redis、队列或逐节点子凭据。
5. 使用专用验收账号创建一条连接，在目标环境实际验证工具发现、双域读取、普通写/提案写、网页读回、撤销 401 与旧入口。仅 health 200 或 SDK 成功不能作为目标 Agent 已通过。记录真实通知/worker与外部代理/TLS的实际状态，再决定对外发布。

本仓库部署脚本与环境说明仍是准绳：远端通常用 scripts/deploy.sh --skip-pull；Windows 本机用 deployments/windows/start-local.ps1。本文不自动执行远端命令。本次用户授权的本机启动已完成，原账号/数据/配置保留；访问 http://localhost:3000/settings/profile/mcp/。

## 回退

先停止新连接签发并撤销/停用需停止的统一写连接，停止相关写入，备份最新数据后恢复经过验证的兼容代码/前端产物。不要把恢复旧 dump 当成无损操作；它会丢失备份之后的业务变更。

**已有统一来源提案时，不能直接回退 0209。** 迁移会明确拒绝；应保留兼容 schema/服务并停用相关写入，先由运维导出、核对并明确处理这些记录。不得伪造节点 grant、回写哈希、批量删除提案或绕过外键强制回退。只有旧来源记录的 0209→0208→0209 往返已在阶段 4 隔离库验证。

本机启动前旧镜像标记为 pilab-windows-backend:before-unified-mcp-20261029，旧前端与数据库 dump 位于 `.runtime/windows-start-20261029-unified-mcp/`。这些材料含私密数据，不能提交或贴入工单。当前保持本机服务运行供用户验收；没有执行回退或清理数据。
