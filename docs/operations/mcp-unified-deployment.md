# 统一 MCP 设置页：部署说明

更新日期：2026-10-19。目标仓库 `SynlysAI/plane`，分支 `develop`。本说明随统一 MCP 设置页、行政项目桥接和科研节点 7 天连接一起交付；服务器部署由部署人员执行。

## 1. 本次发布内容

- 主入口：个人设置 → Plane API → **MCP 连接** → 智能体配置；页面 `/settings/profile/mcp/`。
- 旧 `/mcp/`、`/{workspace-slug}/mcp/` 自动跳转并保留节点定位；历史提案 `review_path` 仍有效。
- 行政项目接入通过 Plane API 的同源桥接访问独立自助服务，个人令牌与科研节点凭据分开。
- 显式科研节点连接默认 7 天；提案仍为 24 小时，逐项人工确认不变。已签发连接不追溯延期。
- 无新增依赖或数据库迁移。服务器须已有 v2.1 的 `0181`、`0182` 迁移；如未应用，按既有迁移流程更新到当前版本，不回退更高迁移。

源码不绑定本机地址。Windows 本地运行助手和 `http-local-self-service.example.json` 专用于本机，不能当作服务器配置直接使用。

## 2. 发布前核对

保留服务器未提交修改，备份现有数据库、实际加载的环境配置、前端产物和独立门户凭据目录。不要将备份、真实 `.env`、`http.local.json`、令牌、运行日志或 `.runtime` 提交到 Git。

```bash
git status --short
git switch develop
git pull --ff-only origin develop
git rev-parse HEAD
```

若有冲突或分叉，先处理再部署，不强制重置。确认本次代码包含 `apps/api/plane/mcp/` 和 `apps/web/core/components/settings/profile/content/pages/mcp.tsx`。

## 3. Plane 后端环境配置

仓库 `docker-compose-local.yml` 和根 `docker-compose.yml` 的 API 从 **`apps/api/.env`** 读取环境，不是只改根目录 `.env`。其他部署方式应写入 API 实际加载的位置；采用显式 `environment` 白名单的 Compose 时，也要把新增变量传入 API。

以下按此前内网入口举例，并不表示当前服务器配置已经核验。按实际域名、端口、开放工作区调整，不复制本机的 `localhost`、`test11` 或 `host.docker.internal`。

```dotenv
# 独立行政 MCP 服务的公开 origin，不带 /connect 或 /mcp
NATIVE_MCP_PORTAL_URL=http://10.26.15.92:8765
# API 可直接访问上述地址时留空；否则填 API 可达的固定内部 origin
NATIVE_MCP_PORTAL_INTERNAL_URL=

# 已有 v2.1 开关，须由管理员决定是否开放
RESEARCH_MODULE_ENABLED=1
RESEARCH_MCP_ENABLED=1
RESEARCH_MCP_WRITE_ENABLED=1
# 本次新增：显式节点 MCP 连接，7 天
RESEARCH_MCP_NODE_TOKEN_TTL_SECONDS=604800
# 旧上下文交换继续使用 600 秒
RESEARCH_CONTEXT_TOKEN_TTL_SECONDS=600

# 保留已有合法来源；这里仅展示单一内网入口
WEB_URL=http://10.26.15.92:3300
CORS_ALLOWED_ORIGINS=http://10.26.15.92:3300
CSRF_TRUSTED_ORIGINS=http://10.26.15.92:3300
```

两个 `NATIVE_MCP_*` 变量默认为空；未配置公开地址时，行政接入区域显示未配置，科研接入仍可使用。节点期限默认已是 604800 秒，建议部署时显式记录。

公开门户地址须能被浏览器和 Agent 访问。内部地址仅供 API 连接，不会成为客户端连接地址；两者不能含账号、密码、路径或查询参数。若使用容器服务名，API 与门户必须处于可互通的网络。桥接仍向门户发送公开地址对应的 Host/Origin。

`RESEARCH_MCP_PUBLIC_BASE_URL` 用于既有内嵌 ScienceDiscovery 自动接入，不是本次设置页的必填项。本次不要求启动 ScienceDiscovery。

## 4. 独立行政 MCP 服务

已有 `/connect` 与 `/mcp` 自助服务时可继续复用，无须为统一页面再建第二套凭据服务。未部署时，按 [SELF_SERVICE.md](../../demos/sciencediscovery-plane-mcp/SELF_SERVICE.md) 和 [HTTP_MCP.md](../../demos/sciencediscovery-plane-mcp/HTTP_MCP.md) 部署现有服务。

从 `demos/sciencediscovery-plane-mcp/http-self-service.example.json` 复制为服务器私密配置，保留原服务的 `state_dir` 及持久化卷，逐项核对：

| 配置                          | 服务器要求                                             |
| ----------------------------- | ------------------------------------------------------ |
| `self_service.public_url`     | 与 `NATIVE_MCP_PORTAL_URL` 一致                        |
| `self_service.plane_base_url` | 门户进程可访问的本环境 Plane API origin，不附加 `/api` |
| `self_service.plane_ui_url`   | 用户可访问的本环境 Plane 页面 origin                   |
| `self_service.workspaces`     | 实际允许接入的工作区 slug，用户仍须有业务权限          |
| `self_service.allow_publish`  | 仅管理员明确开放时设为 `true`，否则保持 `false`        |
| `self_service.max_token_days` | 行政连接的独立期限策略，不受科研节点 7 天设置影响      |
| `allowed_hosts`               | 包含实际公开门户的主机名/IP                            |
| `state_dir`                   | 沿用原凭据库和草稿目录，持久化保存且不提交 Git         |
| `host`、`port`                | 容器内通常监听 `0.0.0.0:8765`，按实际网络提供访问      |

`allow_insecure_http` 只在既有可信内网 HTTP 部署中显式启用；公网使用 HTTPS。现有 `compose.http.yml` 默认仅发布到宿主机 `127.0.0.1`：保留反向代理入口，或按实际内网部署设置绑定地址；仅设置 `public_url` 不会自动让端口可达。

若修改门户配置，按原有管理方式重启该服务。保留原凭据目录，不用本地测试凭据库覆盖服务器数据。门户已有配置及 Bearer 连接保持兼容。

## 5. 前端、代理与服务更新

同源部署的 `apps/web/.env` 保持 `VITE_API_BASE_URL=""`，`VITE_WEB_BASE_URL` 指向服务器 Plane 入口。科研节点客户端地址由前端 API origin 或当前页面 origin 生成；不要把内部容器地址写入浏览器构建配置。

按仓库指定 Node/pnpm 版本安装锁定依赖，构建相关共享包及 Web，更新实际对外托管的产物。可在现有发布环境中执行：

```bash
pnpm install --frozen-lockfile
pnpm turbo run build --filter=web
```

既有部署若同时发布 Admin 等应用，仍沿用其完整发布流程。仅构建 Web 而继续使用旧的共享包产物，可能导致设置菜单缺少新项。

保留入口代理 `/api/*` 和 `/auth/*`，透传 Host、正确的协议、`Authorization`、`X-Research-Context-Token`、`X-Research-Context-Hash`。登录后的人工操作仍经 Session + CSRF；不需要 iframe 或为门户新增跨域放行。

更新 API 代码后重新创建 API 容器以加载环境变量；若代码打包在镜像中，则使用发布流程生成的新版镜像。普通 `restart` 不会更新容器创建时的环境。Worker/Beat 按既有后端发布流程保持同版本。不要清空数据库或门户数据卷。

现有混合部署脚本 `scripts/deploy.sh` 会构建 Caddy 镜像。部署人员应确认适用于自己的架构后手动执行；本次交付没有自动运行部署脚本、构建镜像或启动测试栈。

## 6. 发布后验收

1. 登录设置页，确认 Plane API、MCP 连接、智能体配置的顺序；智能体配置仍受原权限限制。
2. 行政接入显示正确的服务器 Plane 地址、开放工作区和发布策略，不出现本机 `localhost:3000` 或 `test11`。用户自行使用本环境个人令牌验证、签发和撤销；生成的 MCP URL 应为服务器公开地址。
3. 从节点工作台进入设置页，确认工作区、链、节点和可选任务对应正确。测试旧工作区 MCP 地址与历史 `review_path`。
4. 科研节点面板显示 7 天。已有授权仍按旧到期时间处理，需要延长期限时由用户重新生成。
5. 切换工作区、节点或接入类型，旧连接配置和不适用的提案定位被清除。两种凭据不能互换。
6. 由用户手动验收科研 prepare → 精确提案人工确认 → Agent execute → 对象读回；不由部署脚本生成真实连接或自动批准。

常见问题：行政区域未配置检查 API 的有效环境；连接失败检查 API 到门户网络、公开 Host 与门户健康；生成本机地址检查门户 `public_url` 和前端构建变量；设置菜单缺失检查共享包/Web 产物；CSRF 失败检查入口来源、代理协议和 Host。

本地已通过 68 项相关前端检查、桥接 20 项、期限 4 项及独立自助服务 15 项检查；Web 类型检查和构建通过。它们不代表测试服务器部署完成，也不替代真实个人令牌流程及尚待补齐的分析草稿、资源关联业务验收。详见 [统一管理与验证说明](mcp-unified-management.md)。

## 7. 回退

保留发布前提交号、前端产物和私密配置备份。需要回退时恢复已验证代码/镜像及对应前端，按原环境配置重建服务；不要反向删除 `0182` 的审批数据表，不清空凭据库。已提交的业务写入不会因撤销连接或代码回退而自动撤销。
