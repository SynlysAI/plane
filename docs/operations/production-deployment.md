# PiLab 当前生产环境部署与更新

本文记录 `10.26.15.53` 上正在使用的部署方式、首次配置、日常更新、验证与回滚步骤。该环境不是仓库根目录 `docker-compose.yml` 定义的完整生产栈，而是一套过渡性的混合部署：前端在宿主机通过 pnpm 构建，Caddy 容器托管静态产物；API、Worker 和基础设施由 `docker-compose-local.yml` 启动。

科研链 MCP v2.1 的增量部署见 [给部署同学的操作说明](research-mcp-v21-deployment.md)，当前能力及验收边界见 [验收摘要](research-mcp-v21-acceptance.md)。本文中的历史 IP 不代表本次测试服务器的最终地址，部署前以实际对外入口为准。

## 1. 当前架构

项目目录：

```text
/share/users/fangyikai/github_project/SynlysAI/plane
```

对外入口：

| 服务       | 地址                                     | 实现                                                           |
| ---------- | ---------------------------------------- | -------------------------------------------------------------- |
| Web        | `http://10.26.15.53:3300/`               | `apps/web/build/client`，由 `plane-web-prod-1` 中的 Caddy 托管 |
| 系统管理   | `http://10.26.15.53:3300/god-mode/`      | `apps/admin/build/client`，由同一个 Caddy 托管                 |
| API 与认证 | `http://10.26.15.53:3300/api/`、`/auth/` | Caddy 反向代理到 `api:8000`                                    |
| 附件       | `http://10.26.15.53:3300/uploads/`       | Caddy 反向代理到 `plane-minio:9000`                            |

主要容器：

| Compose 文件                  | 容器/服务                                  | 说明                                                          |
| ----------------------------- | ------------------------------------------ | ------------------------------------------------------------- |
| `docker-compose-prod-web.yml` | `web-prod` / `plane-web-prod-1`            | Caddy，监听宿主机 `3300`                                      |
| `docker-compose-local.yml`    | `api`、`worker`、`beat-worker`、`migrator` | Django、Celery 与迁移                                         |
| `docker-compose-local.yml`    | `document-converter`                       | 内部 Gotenberg/LibreOffice 附件预览转换服务，不暴露宿主机端口 |
| `docker-compose-local.yml`    | PostgreSQL、Redis、RabbitMQ、MinIO         | 后端基础设施                                                  |

管理端不再使用独立的宿主机 `3001` 端口。浏览器始终通过 `:3300/god-mode/` 访问，Caddy 再选择正确的静态目录。若前端构建配置中仍有 `localhost:3001`，Web 会把系统管理入口解析为 `10.26.15.53:3001`，最终出现 `ERR_CONNECTION_REFUSED`。

## 2. 环境变量

环境变量会在 Vite 构建时写入静态 JavaScript。修改 `.env` 后必须重新构建对应前端，仅重启 Caddy 不会生效。

`apps/web/.env` 至少保持：

```env
VITE_API_BASE_URL=""
VITE_WEB_BASE_URL="http://10.26.15.53:3300"
VITE_ADMIN_BASE_URL=""
VITE_ADMIN_BASE_PATH="/god-mode"
```

`apps/admin/.env` 至少保持：

```env
VITE_API_BASE_URL=""
VITE_WEB_BASE_URL="http://10.26.15.53:3300"
VITE_ADMIN_BASE_URL=""
VITE_ADMIN_BASE_PATH="/god-mode"
```

`apps/api/.env` 中保持：

```env
WEB_URL="http://10.26.15.53:3300"
ADMIN_BASE_URL="http://10.26.15.53:3300"
ADMIN_BASE_PATH="/god-mode"
ATTACHMENT_PREVIEW_ENABLED=1
ATTACHMENT_PREVIEW_CONVERTER_URL="http://document-converter:3000"
```

`ATTACHMENT_PREVIEW_ENABLED=0` 只会隐藏预览入口并停止生成派生文件，上传和下载仍继续可用。转换容器只接收后端上传的文件字节，已禁用 `downloadFrom`，并拒绝 LibreOffice 嵌入资源访问公网与私网地址。

不要把生产 `.env` 或密码提交到 Git。

## 3. Caddy 配置要求

`docker-compose-prod-web.yml` 必须同时挂载 Web 与 Admin 构建产物：

```yaml
services:
  web-prod:
    image: caddy:2-alpine
    restart: unless-stopped
    networks:
      - dev_env
    volumes:
      - ./apps/web/build/client:/usr/share/caddy/html:ro
      - ./apps/admin/build/client:/usr/share/caddy/admin:ro
      - ./apps/web/caddy/Caddyfile.prod:/etc/caddy/Caddyfile:ro
    ports:
      - "3300:3300"

networks:
  dev_env:
    external: true
    name: plane_dev_env
```

`apps/web/caddy/Caddyfile.prod` 中，`/api/*`、`/auth/*` 和 `/uploads/*` 的代理规则之后、Web SPA 的兜底规则之前，必须包含 Admin SPA 路由：

```caddyfile
redir /god-mode /god-mode/ 308
handle_path /god-mode/* {
	root * /usr/share/caddy/admin
	try_files {path} /index.html
	file_server
}
```

如果缺少这段路由，访问 `/god-mode/` 会返回普通 Web 的 `index.html`，不会进入系统管理应用。

API、认证和存储代理必须保留浏览器发送的完整 Host，包括非默认端口：

```caddyfile
header_up Host {http.request.hostport}
```

不要使用 `{http.request.host}`：它只包含主机名。例如，浏览器访问 `http://10.26.15.92:3300/` 时，后端会丢失 `:3300`，将默认封面上传地址生成为 `http://10.26.15.92/uploads/`。项目创建会先上传封面，这个跨源请求会被生产 CSP 拦截，前端显示 `Network Error`，项目创建接口尚未调用。存储下载签名同样依赖完整 Host，三处代理应保持一致。

修复此配置后，先验证并重新加载 Caddy；本项修复无需重新构建前端或修改数据库：

```bash
docker exec plane-web-prod-1 caddy validate --config /etc/caddy/Caddyfile
docker exec plane-web-prod-1 caddy reload --config /etc/caddy/Caddyfile
```

本地有 Caddy 可执行文件时，可以运行真实代理回归测试。测试使用临时监听端口和模拟上游，不连接生产服务；未安装 Caddy 时，此用例会跳过：

```bash
CADDY_BINARY=/path/to/caddy node --test apps/web/tests/production-proxy.test.mjs
```

## 4. 日常更新流程

在服务器执行：

```bash
cd /share/users/fangyikai/github_project/SynlysAI/plane

# 1. 拉取代码和安装依赖
git pull
pnpm install

# 2. Web 与 Admin 必须一起构建
pnpm turbo run build --filter=web --filter=admin

# 3. 静态产物更新后重启 Caddy
docker-compose -f docker-compose-prod-web.yml restart web-prod

# 4. 构建内部转换服务并执行数据库迁移
docker-compose -f docker-compose-local.yml up -d --build document-converter
docker-compose -f docker-compose-local.yml up -d migrator

# 5. 重启使用 bind mount 代码的后端进程
docker rm -f plane-api-1 plane-worker-1 plane-beat-worker-1
docker-compose -f docker-compose-local.yml up -d api worker beat-worker
```

不要再只运行 `--filter=web`，否则 Web 可能已经引用新接口或新路由，而系统管理仍停留在旧构建。

如果修改了 `docker-compose-prod-web.yml` 的端口、卷挂载、网络或其他容器定义，`restart` 不会应用这些变化，需要重新创建容器：

```bash
docker-compose -f docker-compose-prod-web.yml up -d --no-deps --force-recreate web-prod
```

如果只修改了 `apps/api/.env`，也需要重新创建 API、Worker 和 Beat Worker；普通 restart 可能继续使用容器创建时的旧环境变量：

```bash
docker-compose -f docker-compose-local.yml up -d --no-deps --force-recreate api worker beat-worker
```

## 5. 部署后验证

先检查容器：

```bash
docker ps --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}' \
  --filter name=plane-web-prod-1 \
  --filter name=plane-api-1 \
  --filter name=plane-worker-1 \
  --filter name=plane-beat-worker-1 \
  --filter name=plane-document-converter-1
```

再检查 HTTP 链路：

```bash
curl -fsS -o /dev/null -w 'web=%{http_code}\n' \
  http://10.26.15.53:3300/
curl -fsS -o /dev/null -w 'admin=%{http_code}\n' \
  http://10.26.15.53:3300/god-mode/
curl -fsS -o /dev/null -w 'api=%{http_code}\n' \
  http://10.26.15.53:3300/api/instances/
```

三项都应返回 `200`。最后使用实例管理员账号从 Web 左下角点击「系统管理」，确认地址停留在 `http://10.26.15.53:3300/god-mode/`，登录后能进入管理菜单。

检查内部转换服务：

```bash
docker-compose -f docker-compose-local.yml exec document-converter \
  curl -fsS http://127.0.0.1:3000/health
```

返回 JSON 的 `status` 应为 `up`。该服务没有宿主机端口，不应在 Caddy 中增加公开路由。

常见故障：

| 现象                                               | 原因                                                         | 处理                                                                       |
| -------------------------------------------------- | ------------------------------------------------------------ | -------------------------------------------------------------------------- |
| 跳转到 `10.26.15.53:3001`                          | Web 构建时仍使用 `VITE_ADMIN_BASE_URL=http://localhost:3001` | 修正 `apps/web/.env`，重新构建 Web                                         |
| `/god-mode/` 显示普通 Web 首页                     | Caddy 缺少 Admin 路由或 Admin 卷挂载                         | 检查两个生产配置文件，并强制重建 `web-prod`                                |
| Admin 页面静态资源 404                             | 未构建 Admin，或 Admin 构建基路径不为 `/god-mode/`           | 检查 `.env`，运行 `pnpm turbo run build --filter=admin`                    |
| Admin 页面接口 502                                 | API 正在重启或 Caddy 无法解析 `api:8000`                     | 检查 `plane-api-1` 状态和 `plane_dev_env` 网络                             |
| 登录后再次跳到 `localhost:3001`                    | 后端 `ADMIN_BASE_URL` 仍是旧值                               | 修正 `apps/api/.env` 并重新创建 API 容器                                   |
| 创建项目提示 `Network Error`，上传地址缺少 `:3300` | Caddy 的 `{http.request.host}` 转发丢失端口                  | 将 API、认证、存储代理改用 `{http.request.hostport}`，验证并重新加载 Caddy |

## 6. 回滚

部署前至少备份以下服务器本地配置和当前静态产物：

```text
apps/web/.env
apps/admin/.env
apps/api/.env
docker-compose-prod-web.yml
apps/web/caddy/Caddyfile.prod
apps/web/build/
apps/admin/build/
```

代码回滚到上一已验证提交后，重新执行 Web/Admin 构建、迁移和容器重启。若只是 Caddy 配置或挂载错误，可先恢复备份的 `docker-compose-prod-web.yml` 与 `Caddyfile.prod`，然后强制重建 `web-prod`。

## 7. 已知限制

当前后端使用 `docker-compose-local.yml`、`Dockerfile.dev` 和 Django 开发服务器。这适合作为现阶段内网过渡部署，但不具备正式生产 WSGI/ASGI 服务的并发、超时、滚动发布和进程监管能力。后续迁移到仓库标准生产栈时，应统一由外层代理提供 Web、Admin、Space、Live、API 与对象存储入口，并相应替换本文流程。

## 8. 变更记录

| 文档版本 | 日期       | 说明                                                                  |
| -------- | ---------- | --------------------------------------------------------------------- |
| v1.0     | 2026-09-18 | 记录当前混合部署架构，补齐 Web/Admin 构建、Caddy 路由和管理端排错流程 |
| v1.1     | 2026-10-22 | 补充内部 Office 附件预览转换服务的部署、健康检查与出站边界            |
