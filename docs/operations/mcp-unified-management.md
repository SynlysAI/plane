# 统一 MCP 连接与操作页面

更新日期：2026-10-19。基于 `develop` 的 `98c528ee` 实施，随代码交付。服务器配置、发布和回退步骤见 [部署说明](mcp-unified-deployment.md)。本次未自动部署测试服务器。

## 路由与入口

- 主入口为个人设置 → Developer →「MCP 连接」，位于 Plane API（个人访问令牌）与「智能体配置」之间。页面地址 `/settings/profile/mcp/`，提供「行政项目接入」和「科研链节点接入」两个区域，不再在工作区侧栏重复显示。
- 原 `/mcp/` 和 `/{workspace-slug}/mcp/` 自动跳转到设置页，保留工作区、链、节点、任务及提案定位；只转发允许的定位字段。新节点和任务链接直接进入设置页。
- 设置页使用 `workspace` 查询参数显式定位工作区；未指定时使用当前工作区，也可选择其他工作区。设置弹窗中的选择只在弹窗内生效，不读写底层工作台 URL。切换工作区和接入类型仍清除旧节点上下文与密钥。
- 节点工作台在科研任务与课题资料之间保留「MCP / Agent 操作」，携带工作区、科研链、节点跳转。科研任务详情入口额外携带任务上下文，授权仍是节点级。
- `?mode=research&workspace=<slug>&chain=<id>&node=<id>&task=<optional-id>&operation=<optional-id>` 只包含定位信息，密钥不进入 URL、浏览器存储或工作区状态。

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

## 科研节点与人工确认

可选择工作区、科研链、节点、动作与后端提供的正式报告版本。先通过现有科研链、节点和任务接口核对定位信息；节点不属于链、任务不属于节点或读取无权限时，不挂载授权面板。

直接复用 `ResearchAgentOperations` 与 `ResearchAgentOperationService`，集中生成/撤销授权、预览提案、确认/拒绝和展示结果。人工确认仍绑定精确 `proposal_hash` 和 CSRF，页面不调用机器执行，不自动批准。显式节点 MCP 连接使用 `RESEARCH_MCP_NODE_TOKEN_TTL_SECONDS=604800`，默认 7 天；提案仍为 24 小时，实际连接到期以服务端响应为准。旧的上下文交换保留 `RESEARCH_CONTEXT_TOKEN_TTL_SECONDS=600`，不随节点 MCP 延长。已有授权不追溯修改期限，需用户重新生成。五类受控动作、来源 ACL、权限重检、幂等与读回逻辑不变。

切换工作区、链、节点或接入类型时清除旧连接配置及不再适用的任务/提案定位，延迟的节点或授权响应不能进入新上下文。同用户、节点与足够动作范围的新连接仍可恢复原提案。

## 兼容与故障定位

- 原 `/connect`、`/connect/api/*`、8765 `/mcp` 与已有 Bearer 客户端保持兼容，独立服务无需升级。
- 科研 `/agent-access/mcp/`、`/agent-operations/mcp/` 均不变，两套凭据不能互换。
- 历史 `review_path` 继续打开节点页，并按 `operation` 参数挂载原人工审核组件，同时提供统一页链接。
- 节点快捷入口不依赖 MCP 开关隐藏；面板收到 `disabled` 明确显示不可用状态。
- 历史截图的原因尚未确认：旧组件存在 `disabled -> return null` 路径，但本次远端节点页要求登录，无法据此断言服务器故障原因。本轮未创建服务器凭据、修改权限或批准提案。

## 发布与验收

无新增迁移或依赖。部署既有 Plane API 与 Web，更新 Web 构建产物，重新创建 API 加载路由和新增变量；保持 v2.1 开关、`/api/*` 代理和可信 CSRF 来源。统一页复用现有独立门户协议；本机测试额外启动该门户的本地实例，端口仅绑定 `127.0.0.1:8765`。无需 iframe 或额外 CORS。

检查命令：

```bash
# apps/api 内，使用已安装 Django/DRF/httpx 的环境；无数据库/Redis/网络访问
python -m plane.mcp.tests
# 仓库根目录
pnpm --filter web exec vitest run --config vitest.config.ts --testTimeout=20000 tests/components/mcp-management.test.tsx tests/components/mcp-services.test.ts tests/components/research-agent-operations.test.tsx tests/components/research-chain-route-registration.test.ts tests/components/research-chain-detail.test.tsx tests/components/research-chain-task-panel.test.tsx tests/components/research-chain-workbench.test.tsx
pnpm --filter web check:types
pnpm --filter web build
```

测试服务器仍需用户用自己的账号验收原生连接验证/创建/撤销、上下文切换、科研 prepare → 本人确认 → Agent execute → 真实对象读回。此前分析草稿和资源关联未完成的真实 MCP 业务验收仍需补齐，组件和桥接检查不替代它们。

本轮不运行 Docker 测试栈、不构建镜像、不启动 ScienceDiscovery、不写入真实凭据或批准业务提案。历史结果见 [v2.1 验收摘要](research-mcp-v21-acceptance.md)。

## 本次检查结果

- 9 个前端测试文件共 68 项通过，覆盖设置中的入口顺序与权限、设置弹窗隔离、旧管理地址跳转、节点/任务定位、节点与工作区切换、原生服务目标与本地工作区分离、延迟响应隔离、凭据及 CSRF 分离、7 天展示、人工确认的精确哈希与拒绝流程。
- 桥接 20 项隔离检查通过，包含固定内部传输 URL、公开 Host/Origin、目标更改后的会话隔离；期限 4 项检查通过，实际调用签发函数但 mock 数据库创建，验证节点 7 天且旧交换仍为 600 秒。使用现有 API 容器执行无数据库写入的测试进程，没有运行测试栈或创建镜像。
- 现有独立自助服务的 15 项测试通过，包括凭据隔离、HTTP/MCP 调用、撤销和 CSRF。使用测试凭据与临时存储，不生成真实用户连接。
- Web 官方 `check:types`、生产构建、本次 19 个前端文件的 OxLint（零警告）与差异空白检查通过。构建有仓库既有的模块类型和大分块提示。
- 本地浏览器实际核对统一页选择链/节点、加载已有授权/提案，以及节点工作台在科研任务和课题资料之间的快捷入口。只读核对，没有创建连接或批准提案。
- 实现阶段基线为远端 develop 的 `98c528ee`；保留此前已有的部署文档标题本地修改。
- 后续按用户要求，本机从测试服务器上游切换为全本地链路，未修改远端服务、账号或权限。真实 `.env`、本机门户配置/凭据库和备份都在 Git 忽略范围。未使用真实个人令牌签发/撤销连接，完整业务流程仍由用户验收。未重新声称历史 146 项后端回归或整个 monorepo 通过。
- 本轮浏览器已实际显示「行政项目接入」、`http://localhost:3000` 与 `test11`，个人令牌管理和兼容门户均指向本机；科研节点面板通过现有人工接口显示连接有效期 7 天。没有生成新授权或批准提案。
- 设置入口调整后，浏览器确认「Plane API → MCP 连接 → 智能体配置」顺序，以及旧工作区 MCP 地址跳转到设置页后仍选中原科研链和节点。调整后 Web 官方类型检查、生产构建、15 个涉及入口调整的 TypeScript 文件 OxLint（零警告）和差异空白检查通过；本次入口移动不增加环境变量、迁移或服务。
