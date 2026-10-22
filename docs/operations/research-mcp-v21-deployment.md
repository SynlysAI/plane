# 科研链 MCP v2.1：给部署同学的操作说明

更新日期：2026-10-18。目标仓库为 `https://github.com/SynlysAI/plane`，目标分支为 `develop`。本文随代码交付，实际发布版本以 develop 的提交号为准；本次交付整理没有修改测试服务器。

## 本次需要部署什么

后端包含科研链/节点的十个读取工具，以及五类受控写入：创建科研任务、追加任务评论、保存分析草稿、关联任务资源、追加科研过程记录。前端新增节点授权和人工审核面板。必须同时部署后端、前端和数据库迁移。

Plane API 自带 MCP HTTP 接口，本次无需新建独立 MCP 服务，无需启动 ScienceDiscovery/Synlora，无需新增模型 API Key。旧 Demo 的独立 HTTP 网关不提供 v2.1 写模式，不要把它当作本版写入口。

部署前确认：

| 信息             | 由部署人员填写/核对                                             |
| ---------------- | --------------------------------------------------------------- |
| 代码版本         | `develop` 中本次发布提交号，记录实际 `git rev-parse HEAD`       |
| 服务器项目目录   | 使用现有部署目录，不使用开发者 Windows 路径                     |
| 对外入口         | 浏览器和 Agent 均能访问的 origin，包含协议及非默认端口          |
| 部署方式         | 下文以现有混合部署为例；镜像部署须先构建/拉取包含本次代码的镜像 |
| 验收位置         | 服务器上的工作区 slug、科研链、可操作节点、验收账号             |
| 开启工作区的账号 | 有该工作区有效成员身份的工作区管理员或实例管理员                |

本地演示账号、科研链、UUID、工作区策略和节点连接密钥都不会随 Git 迁移。无需把服务器密码、`.env` 或节点密钥提供到 GitHub。

## 1. 发布前备份与拉取

安排维护窗口，先记录当前版本并备份数据库、服务器 `.env`、Web/Admin 构建产物及代理配置。保留 PostgreSQL、Redis、MinIO 数据卷，不执行 `down -v`。

在服务器项目根目录执行，以下备份命令使用现有 `docker-compose-local.yml` 的 PostgreSQL 服务：

```bash
umask 077
backup_dir=".runtime/research-mcp-v21-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$backup_dir"
git rev-parse HEAD > "$backup_dir/before-commit.txt"
docker compose -f docker-compose-local.yml exec -T plane-db \
  sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' \
  > "$backup_dir/database.dump"
docker compose -f docker-compose-local.yml exec -T plane-db \
  pg_restore --list < "$backup_dir/database.dump" > "$backup_dir/database-contents.txt"
```

另行备份 `.env`、`apps/api/.env`、`apps/web/.env`、`apps/admin/.env`、`apps/web/build`、`apps/admin/build`、`docker-compose-prod-web.yml`、`apps/web/caddy/Caddyfile.prod`；备份保存在服务器私密位置，不提交 Git。

确认工作树没有需要保留的未提交改动后，再切到 `develop` 并拉取。若有冲突或本地修改，先处理，不使用强制重置覆盖：

```bash
git status --short
git switch develop
git pull --ff-only origin develop
git rev-parse HEAD
```

确认拉到的版本含有 `0181_fix_research_task_resource_constraints.py`、`0182_research_agent_operations.py`、后端 `agent_operations.py` 和前端 `research-agent-operations.tsx`。

## 2. 后端配置

修改服务器实际加载的 `apps/api/.env`，只调整相关配置，不覆盖现有数据库、存储、登录及 `SECRET_KEY`：

```dotenv
RESEARCH_MODULE_ENABLED=1
RESEARCH_MCP_ENABLED=1
RESEARCH_MCP_WRITE_ENABLED=1
RESEARCH_CONTEXT_TOKEN_TTL_SECONDS=600
RESEARCH_MCP_NODE_TOKEN_TTL_SECONDS=604800
```

三个功能开关在模板中默认关闭，部署脚本不会自动替管理员开放科研写入。显式节点 MCP 连接由 `RESEARCH_MCP_NODE_TOKEN_TTL_SECONDS` 控制，默认 604800 秒（7 天）；旧上下文交换仍由 `RESEARCH_CONTEXT_TOKEN_TTL_SECONDS` 控制，默认 600 秒。提案有效期仍为 24 小时，逐项人工审批、撤销和执行权限重检不变。已有连接不追溯延期，须由用户重新生成。

在同一文件中核对已有的以下配置。把示例 origin 替换成实际入口，保留仍在使用的其他合法来源；不使用通配符绕过人工确认的来源校验：

```dotenv
WEB_URL=https://plane-test.example.org
CORS_ALLOWED_ORIGINS=https://plane-test.example.org
CSRF_TRUSTED_ORIGINS=https://plane-test.example.org
```

若实际使用内网 HTTP 加端口，三个地址相应改为完整的 `http://实际地址:端口`。现有 `ADMIN_BASE_URL`、`APP_BASE_URL` 也应与部署方式匹配。根目录 `.env` 不是该 Compose 的 API `env_file`，只改根文件不保证 API 生效。

`RESEARCH_MCP_PUBLIC_BASE_URL` 用于 v1 内嵌 ScienceDiscovery 的自动接入；本次直连 v2.1 不依赖它。节点面板的连接 URL 来自前端 API origin/当前页面 origin。

## 3. 前端、代理与迁移

同源部署的 `apps/web/.env` 与 `apps/admin/.env` 使用 `VITE_API_BASE_URL=""`，`VITE_WEB_BASE_URL` 使用真实入口；保留现有 `/god-mode` 管理端路径配置。前端变量会写入构建产物，修改后必须重新构建。

代理保留现有 `/api/*`、`/auth/*` 路由，转发完整 Host 和端口，并允许两个 `X-Research-Context-*` 请求头透传。现有 `Caddyfile.prod` 已有 `/api/*` 代理，无需为 MCP 新增端口或单独进程。HTTPS 经外层代理终止时，应保持正确的转发协议和 Host，避免登录/CSRF 来源不一致。

仓库的 `scripts/deploy.sh` 适用于现有混合部署，要求 Node 满足根 `package.json` 的版本条件、pnpm 使用其中指定的版本。当前要求 Node >= 22.22.0，pnpm 11.10.0。完成备份、拉取、配置后，由部署人员手动运行：

```bash
./scripts/deploy.sh --skip-pull
```

脚本会安装锁定依赖、构建 Web/Admin、更新 Caddy、执行迁移并重新创建 API/Worker/Beat；其中会构建 Caddy 镜像。它不会自动设置 MCP 开关、开启工作区策略或签发节点授权。若服务器不是该混合架构，采用现有发布流程完成同等步骤，不直接套用脚本。

手工部署时必须完成以下事项：

1. 使用本次代码执行 `python manage.py migrate`，确认迁移进程成功退出；0182 依赖 0181，不手动跳过前置迁移。
2. 使用锁文件安装前端依赖，构建 Web 与 Admin，更新实际对外托管的产物和 Caddy 挂载。
3. 重新创建 API、Worker、Beat 容器，使新代码及新环境变量生效；普通 `restart` 不会更新容器创建时的环境。

部署后核对迁移和有效开关，命令仅输出开关与版本信息，不打印完整环境：

```bash
docker compose -f docker-compose-local.yml exec -T api \
  python manage.py showmigrations db
docker compose -f docker-compose-local.yml exec -T api \
  python manage.py shell -c 'from django.conf import settings; from plane.research.views.agent_operations import ResearchOperationMCPHTTPEndpoint as E; print({"module": settings.RESEARCH_MODULE_ENABLED, "read": settings.RESEARCH_MCP_ENABLED, "write": settings.RESEARCH_MCP_WRITE_ENABLED, "version": E.server_version})'
```

0181、0182 应标为 `[X]`，三个开关应为 `True`，版本为 `2.1.0`。执行正常迁移至服务器代码的最新版本，不为了核对 0182 而回退更新的迁移。

## 4. 页面授权及 Agent 连接

个人设置「MCP 连接」现统一管理行政项目连接与显式科研节点连接，支持候选选择、批量生成、查看和撤销。行政项目区域通过 `NATIVE_MCP_PORTAL_URL` 连接独立门户，发布时需同步门户新增的候选接口。科研受控写入仍需逐项人工确认提案；勾选节点或写能力不会确认业务提案。旧 `/mcp/`、`/{workspace-slug}/mcp/` 继续跳转到设置页且只保留工作区参数；机器协议地址不变。需执行 `0188_research_context_connection_label` 及 `0190_merge_mcp_and_asset_preview` 等待应用的迁移。详情与部署边界见 [统一 MCP 管理说明](mcp-unified-management.md)。

1. 登录服务器，确认目标工作区科研模块和科研链已开启，并创建/选择活动科研链中的可操作节点。v2.1 不能通过 MCP 创建链和节点。
2. 由研究管理员调用 `POST /api/research/workspaces/<slug>/nodes/<node_id>/agent-operations/`，请求体 `{ "kind": "workspace_policy", "enabled": true }`，启用工作区 Agent 操作。该请求必须携带 Plane 登录会话和 `X-CSRFToken`。
3. 用户调用同一接口 `GET` 获取可用动作与报告版本，再提交 `{ "kind": "issue_grant", ... }` 生成节点连接配置；响应只展示一次 `X-Research-Context-Token` 与 `X-Research-Context-Hash`。
4. 将配置保存到客户端私密设置。机器 MCP 地址为下方 `agent-operations/mcp/`；个人 API Key 或旧只读 grant 不会自动获得写权限。
5. Agent prepare 提案后，用户调用 `{ "kind": "decision", "operation_id": "...", "proposal_hash": "...", "decision": "APPROVED" }` 精确确认或拒绝，再由 Agent execute。

新地址形如：

```text
https://plane-test.example.org/api/research/workspaces/<workspace-slug>/agent-operations/mcp/
```

地址必须从 Agent 的运行位置可达。远端 Agent/容器中的 `localhost` 指向自身，不应复制本机开发地址。默认 7 天到期后重新生成同用户、同节点、所需动作范围的连接；已有提案可继续查询和执行，无需重复创建。

## 5. 上线验收与故障定位

脚本对 Web/Admin/API 的 200 检查只证明服务可达。还需使用测试节点逐项完成五类动作：prepare → API 核对 → 人工确认 → execute → 读回。执行结果应为 `COMMITTED`，`readback=verified`，人类接口能查到对象和 Agent 来源记录。

另检查未确认/拒绝提案不能执行、重复执行原 operation_id 不重复创建、撤销节点授权后调用被拒绝。出现超时先查询原 operation_id；不确定 prepare 是否成功时复用原 request_id 和内容。

| 现象                    | 检查方向                                                                             |
| ----------------------- | ------------------------------------------------------------------------------------ |
| 看不到 MCP / Agent 入口 | 当前版本预期行为；科研操作应检查 `agent-operations` API 和机器 MCP，不再检查节点页面 |
| 有面板但无启用按钮      | 当前账号是否为该工作区有效管理员/已入工作区的实例管理员；是否工作区已启用            |
| 授权/确认返回 403       | 登录会话、CSRF token、真实入口和 `CSRF_TRUSTED_ORIGINS`，不要关闭 CSRF               |
| MCP 返回 401            | 缺少/过期/撤销的节点 Token，或 Token 与 Hash 不匹配；匿名探测返回 401 是正常保护行为 |
| MCP 返回 404 / disabled | 发布版本、科研总开关、读取/写入开关、工作区科研链配置、slug、代理路径                |
| HTTP 200 但无业务结果   | 继续检查 JSON-RPC `error` 或 `result.isError`，不能只按 HTTP 状态判成功              |
| 提案确认后执行冲突      | 节点、任务或依据已改变；按错误准备新提案并重新人工确认                               |

本地已实际验收三类写入；分析草稿和资源关联仍需补齐真实 MCP 业务验收。详细边界见 [验收摘要](research-mcp-v21-acceptance.md)。测试服务器尚未验收，不把本机结果当成远端结果。

## 6. 暂停与回滚

优先关闭工作区 Agent 操作，或将后端 `RESEARCH_MCP_WRITE_ENABLED=0` 后重新创建 API/Worker/Beat，暂停机器写入，保留现有提案、审计和业务数据。若连读取也需关闭，再设置 `RESEARCH_MCP_ENABLED=0`。

需要代码回退时，先备份当前数据库，再恢复已验证版本及对应前端。不要直接反向迁移删除 0182 的操作/审批数据表，也不要清空数据卷；数据库恢复需按维护窗口和备份时间评估，避免覆盖上线后人工新增的数据。MCP 的 cancel 不能撤销已经提交的业务写入。
