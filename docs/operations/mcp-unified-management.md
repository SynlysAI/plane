# MCP 配置页面与科研操作 API

更新日期：2026-10-20。科研节点连接、授权和提案审核不再提供页面入口；相关后端 API 与机器 MCP 协议保持兼容。服务器配置、发布和回退步骤见 [部署说明](mcp-unified-deployment.md)。

## 路由与入口

- 主入口为个人设置 → Plane API →「MCP 连接」，页面地址 `/settings/profile/mcp/`，只提供「行政项目接入」配置。
- 原 `/mcp/`、`/{workspace-slug}/mcp/` 和科研深链自动跳转到设置页，仅保留工作区参数；`mode`、链、节点、任务、提案和令牌等上下文一律丢弃。
- 设置页使用 `workspace` 查询参数显式定位工作区；未指定时使用当前工作区，也可选择其他工作区。设置弹窗中的选择只在弹窗内生效，不读写底层工作台 URL。
- 科研链节点工作台和科研任务详情不再渲染「MCP / Agent 操作」入口。

实施前核对：仓库没有原有的 Plane `/mcp` 管理路由。`10.26.15.92:3300/mcp` 返回 SPA HTML 的 200，不能证明管理页存在；`10.26.15.92:8765/mcp` 匿名请求返回 401，是机器协议；独立自助页实际为 `10.26.15.92:8765/connect`。

此前读取测试服务器独立服务配置为 `public`、只读、最长 90 天；本地测试现在使用独立的本机服务，当前开放 `test11`。统一页实时读取所在环境的服务配置，不硬编码服务器工作区。

## 原生任务桥接

新增可选后端变量，默认留空。留空时原生区域明确显示未配置，科研区域不受影响：

```dotenv
# 固定服务 origin，不带 /connect 或 /mcp，不含用户信息及查询参数
NATIVE_MCP_PORTAL_URL=http://localhost:8765
# 仅 API 在 Docker、本机门户在宿主机时设置；浏览器与 Agent 不使用该内部地址
NATIVE_MCP_PORTAL_INTERNAL_URL=http://host.docker.internal:8765
```

`NATIVE_MCP_PORTAL_URL` 是浏览器与 Agent 能访问的公开 origin；可选的 `NATIVE_MCP_PORTAL_INTERNAL_URL` 是 API 访问门户的固定传输 origin。桥接只通过该固定地址连接，Host/Origin 仍保留公开门户身份；会话也绑定内部目标，避免更换服务时重用凭据。服务器部署按自身网络配置，不能复制 localhost 指向另一台机器。

本地链路：`localhost:3000` 管理页 → 本机 `localhost:8765` 行政 MCP → 本机 `127.0.0.1:8001` Plane API。新模板为 `demos/sciencediscovery-plane-mcp/http-local-self-service.example.json`；复制到 `.runtime/windows/native-mcp/http.local.json`，填写实际本地工作区及独立的绝对 `state_dir`。本地启动脚本验证三个 origin 都是 loopback，不接受测试服务器地址。

```powershell
# 使用已有 Demo Python .venv，无镜像构建，也不启动 ScienceDiscovery
./deployments/windows/native-mcp-local.ps1 -Action Start
./deployments/windows/native-mcp-local.ps1 -Action Status
./deployments/windows/native-mcp-local.ps1 -Action Stop
```

`start-local.ps1` 在配置使用本机门户时会启动该服务；Stop 会停止其拥有的进程，保留私密凭据库。新门户不会复制远端 Bearer、个人令牌或业务数据；测试时应由用户提供本机 Plane 的个人令牌。此前远端连接不自动迁移，也不会被本地操作撤销。

页面采用「行政项目接入」名称，因为二开前端的行政项目沿用 Project/Issue 模型；`native` 路由、工具名和凭据类型保持兼容。现有外部项目 API 仍可能按 ACL 返回科研项目的原生项目壳，改名不扩大或额外缩减接口权限，也不把科研节点任务当作 Issue。

`/api/mcp/native/{action}/` 只转发原有 `/connect/api/` 的 options、session、login、tokens、logout 和按 ID revoke。登录、创建、撤销、退出要求 Plane Session 与标准 CSRF；原生会话变更还保留其 `X-MCP-CSRF` 校验。不代理机器 `/mcp`、科研审批或任意 URL，不跟随重定向，限制请求时限和响应大小。

桥接会话用签名 HttpOnly Cookie，绑定当前 Plane 用户与固定上游，有效 30 分钟。只转发专用原生门户会话，不转发 Plane Cookie、API Key、科研 Context Token。响应禁止缓存，原生桥接请求与响应正文不进入外部 API 日志。

用户单独输入个人 API Token，由现有自助服务继续验证身份与工作区权限，签发及撤销 Bearer；提交后清空输入框。统一页展示当前服务能力、有效期、连接状态及一次性客户端配置，不重做原生凭据存储，不转换为科研节点写授权。

当原生服务连接的是另一套 Plane 时，其工作区可能与本地科研工作区不同。原生区域提供独立的「行政服务目标工作区」，选项只来自服务公开配置；不匹配当前本地工作区时必须显式选择。个人令牌管理链接指向原生服务所属的 Plane。签发仍由上游验证个人令牌对目标工作区的权限。切换原生目标清除连接密钥，并隔离延迟响应，不创建本地同名工作区或修改权限。

## 科研节点操作 API

科研写入的后端能力保持不变，但只能由 API 客户端调用：

- 人类接口：`GET/POST /api/research/workspaces/<slug>/nodes/<node_id>/agent-operations/`，用于查看状态、启用工作区写入、签发/撤销节点授权和按精确 `proposal_hash` 确认/拒绝提案。该接口必须使用 Plane 登录会话和 `X-CSRFToken`，不接受 API Key 或机器 Context Token。
- 机器接口：`/api/research/workspaces/<slug>/agent-operations/mcp/`，仍使用 `X-Research-Context-Token` 和 `X-Research-Context-Hash`，只能 prepare/query/execute 已获人工确认的提案。
- 显式节点 MCP 连接使用 `RESEARCH_MCP_NODE_TOKEN_TTL_SECONDS=604800`，默认 7 天；提案仍为 24 小时。旧上下文交换保留 `RESEARCH_CONTEXT_TOKEN_TTL_SECONDS=600`。已有授权、提案、审计和权限重检逻辑不变。

页面删除不影响科研 `/agent-access/` 只读 MCP，也不影响内置科研 Agent 与 ScienceDiscovery 的只读绑定。

## 兼容与故障定位

- 原 `/connect`、`/connect/api/*`、8765 `/mcp` 与已有 Bearer 客户端保持兼容，独立服务无需升级。
- 科研 `/agent-access/mcp/`、`/agent-operations/mcp/` 均不变，两套凭据不能互换。
- 历史 `review_path` 仍会打开节点页，但 `operation` 参数被忽略，不再挂载审核组件；待审提案需调用人类 API 处理。
- 历史统一页科研链接会进入行政项目配置页，只保留工作区定位，不携带提案或密钥参数。

## 发布与验收

无新增迁移或依赖。部署既有 Plane API 与 Web，更新 Web 构建产物，重新创建 API 加载路由和新增变量；保持 v2.1 开关、`/api/*` 代理和可信 CSRF 来源。统一页复用现有独立门户协议；本机测试额外启动该门户的本地实例，端口仅绑定 `127.0.0.1:8765`。无需 iframe 或额外 CORS。

检查命令：

```bash
# apps/api 内，使用已安装 Django/DRF/httpx 的环境；无数据库/Redis/网络访问
python -m plane.mcp.tests
# 仓库根目录
pnpm --filter web exec vitest run --config vitest.config.ts --testTimeout=20000 tests/components/mcp-management.test.tsx tests/components/mcp-services.test.ts tests/components/research-chain-route-registration.test.ts tests/components/research-chain-detail.test.tsx tests/components/research-chain-task-panel.test.tsx tests/components/research-chain-workbench.test.tsx
pnpm --filter web check:types
pnpm --filter web build
```

测试服务器仍需用户用自己的账号验收原生连接验证/创建/撤销，以及科研 prepare → API 人工确认 → Agent execute → 真实对象读回。组件和桥接检查不替代真实业务验收。

本轮不运行 Docker 测试栈、不构建镜像、不启动 ScienceDiscovery、不写入真实凭据或批准业务提案。历史结果见 [v2.1 验收摘要](research-mcp-v21-acceptance.md)。

## 历史验收说明

2026-10-19 的页面式科研授权与提案审核验收结果见 [v2.1 验收摘要](research-mcp-v21-acceptance.md)。这些结果证明后端协议和审计链路曾完整工作；当前版本移除的是页面入口，不表示删除或降级后端 API。
