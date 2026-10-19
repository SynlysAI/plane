# 本机 Plane 4.27.0 部署

## 统一 MCP 页的本地测试（2026-10-19）

页面的「行政项目接入」使用本机行政 MCP 门户，不连接测试服务器。当前链路为 Web `http://localhost:3000` → 本机 MCP `http://localhost:8765` → Plane API `http://127.0.0.1:8001`，工作区使用本机 `test11`，个人令牌也必须在本机 Plane 生成。

私密配置位于 `.runtime/windows/native-mcp/http.local.json`，从 `demos/sciencediscovery-plane-mcp/http-local-self-service.example.json` 复制后填写真实本地工作区和独立绝对状态目录。已有 Demo `.venv` 提供 MCP 依赖，无需 Docker 镜像或 ScienceDiscovery。

```powershell
./deployments/windows/native-mcp-local.ps1 -Action Start
./deployments/windows/native-mcp-local.ps1 -Action Status
./deployments/windows/native-mcp-local.ps1 -Action Stop
```

本机 `apps/api/.env` 使用 `NATIVE_MCP_PORTAL_URL=http://localhost:8765`；API 容器另设 `NATIVE_MCP_PORTAL_INTERNAL_URL=http://host.docker.internal:8765` 访问宿主机。浏览器/Agent 始终使用 localhost 地址。日常 `start-local.ps1` 会按该配置启动本机 MCP，Stop 保留门户凭据库。

科研节点新连接默认 7 天（`RESEARCH_MCP_NODE_TOKEN_TTL_SECONDS=604800`），提案仍为 24 小时；旧上下文交换默认 600 秒。已有连接不追溯延长，按实际到期时间由本人重新生成。详见 [统一 MCP 管理](../../docs/operations/mcp-unified-management.md)。下文保留此前本机部署记录。

代码目录：`D:\plane-main\plane-dev`，分支 `demo/sciencediscovery-mcp`，基础提交 `577b97f9b09beeba86f18335ed7aec609fb32358`（`origin/develop`）。旧版目录 `D:\plane-main\plane-main` 保留。

本机沿用 Compose 项目 `pilab-windows`、网络 `pilab_windows_local` 和原有数据库、附件卷。六份 `.env` 从旧目录复制，未重新生成密钥。API、Worker、Beat 挂载新版 `apps/api`；Python 依赖和 Dockerfile 与旧版逐项核对一致，因此复用已安装依赖的本地镜像。未来 Python 依赖变更时应先构建对应镜像，再执行迁移。

前端采用已构建产物：Web/Admin 使用 Vite Preview，Space 使用 React Router 的 SSR Preview，Live 直接运行构建入口。进程在后台启动，日志和进程记录位于 `.runtime/windows/`。这是仅供本机使用的混合部署；Live 沿用上游的监听行为。

## 访问与日常操作

| 服务      | 地址                               |
| --------- | ---------------------------------- |
| Plane     | http://localhost:3000/             |
| 系统管理  | http://localhost:3001/god-mode/    |
| 公开内容  | http://localhost:3002/spaces/      |
| API 健康  | http://localhost:8001/             |
| Live 健康 | http://localhost:3100/live/health/ |

使用已有邮箱和密码登录，Demo 工作区仍为 `science-mcp-demo`。不要同时运行旧目录的启动脚本。

```powershell
Set-Location D:\plane-main\plane-dev
powershell -NoProfile -ExecutionPolicy Bypass -File deployments/windows/start-local.ps1 -Action Status
powershell -NoProfile -ExecutionPolicy Bypass -File deployments/windows/start-local.ps1 -Action Stop
powershell -NoProfile -ExecutionPolicy Bypass -File deployments/windows/start-local.ps1 -Action Start
```

`Stop` 停止本目录管理的前端和 Plane 后端应用，保留基础设施、ScienceDiscovery 和数据。`Start` 恢复已有基础设施、执行迁移、启动后端并等待健康，然后启动前端；已有前端进程时需先 `Stop`。脚本不创建替代数据卷或重置账号。Windows 重启后，先启动 Docker Desktop，再运行 `Start`。

修改源码后，先停止应用，再备份数据库及附件，然后构建并启动：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File deployments/windows/start-local.ps1 -Action Prepare
powershell -NoProfile -ExecutionPolicy Bypass -File deployments/windows/start-local.ps1 -Action Start
```

`Prepare` 使用仓库锁定的 pnpm 安装依赖，以并发 2 构建四个应用。不要执行 `setup.sh` 覆盖已有配置，也不要使用 `docker compose down -v` 删除数据卷。

## 本次备份与回退

升级备份位于 `.runtime/windows-upgrade/2026-10-12-4.27.0/`：

- `plane-before-4.27.dump`：PostgreSQL custom format；已通过 `pg_restore --list` 检查。
- `plane-cutover-4.27.dump`：停止旧应用后、迁移前的数据库备份；同样通过目录检查。
- `uploads-before-4.27.tar.gz`：附件卷只读打包。
- `config/`：原有六份私密配置，仅供本机恢复，不要提交或分享。
- `migrations-before.txt`、`backend-preflight.log`、`build.log`：迁移状态、预检和构建记录。

旧镜像保留为 `pilab-windows-api:before-4.27`、`pilab-windows-worker:before-4.27`、`pilab-windows-beat-worker:before-4.27`。新版迁移为 `db.0166`、`db.0167`，增加分类、论文审核和任务相关模型。

如果需要回退，先停止新版前后端，再从旧目录启动同一 Compose 项目并使用旧源码和旧构建。升级后数据库的正式回退应先另外备份最新数据，再由执行者核对迁移兼容性或恢复升级前 dump；恢复旧 dump 会丢失升级后的数据，不能直接自动覆盖当前数据库。附件备份同样仅在核实需要时恢复。

验收结果见 [本次部署记录](verification-2026-10-12.md)。Demo 本身的配置、运行方式与证据说明见 [Demo README](../../demos/sciencediscovery-plane-mcp/README.md)。
