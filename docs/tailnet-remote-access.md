# PiLab Tailnet 远程访问说明

本文描述开发机的 Tailnet 内 HTTPS 入口。该入口只允许已加入当前 Tailscale 网络的设备访问，不使用 Funnel，也不暴露到公网。

截至 2026-09-26，开发机的 Web 已在 `0.0.0.0:3000` 监听，Tailnet HTTP 直连 `http://100.109.35.2:3000/` 已验证可用。Tailscale Serve 尚未获得管理员授权；授权前使用 HTTP 直连开始人工测试，HTTPS 入口保持待启用状态。

## 1. 固定入口

| 用途              | 地址                                                         |
| ----------------- | ------------------------------------------------------------ |
| Web 首页          | `https://fangyikai-pc.tail1b4cb7.ts.net/`                    |
| 科研工作台        | `https://fangyikai-pc.tail1b4cb7.ts.net/fangyikai/research/` |
| API / 认证 / 附件 | 同源 `/api/`、`/auth/`、`/uploads/`，由 Vite 代理转发        |

局域网备用入口仍为 `http://192.168.3.245:3000/`；Tailscale HTTP 诊断入口为 `http://100.109.35.2:3000/`。

Web 由 `pnpm dev` 先执行生产构建，再用 Vite Preview 监听 3000。不要把未压缩的
`react-router dev` 直接暴露给 Tailnet 远程浏览器：DERP 中继下大量开发态模块容易超时，进而出现
React 未执行的白屏。需要前端热更新时，仅在本机开发会话中使用
`pnpm --filter web dev:hmr`。

## 2. 开启 Tailscale Serve

1. 在开发机确认 Tailscale 已连接：

   ```bash
   tailscale status --self
   ```

2. 首次开启 Serve 前，Tailnet 管理员需要允许该节点使用 Serve。执行下面命令时，CLI 会给出
   `https://login.tailscale.com/f/serve?...` 授权链接；管理员打开并确认后重试：

   ```bash
   tailscale serve --bg 3000
   ```

3. 确认代理指向本地 Web 服务：

   ```bash
   tailscale serve status
   ```

4. 确认本地 3000 已运行 Vite Preview（日志应出现 Preview 监听地址），而不是 `react-router dev`。

## 3. 本地配置口径

`apps/web/.env` 使用稳定 HTTPS 域名作为 Web 回跳基准：

```env
HOST=0.0.0.0
VITE_WEB_BASE_URL="https://fangyikai-pc.tail1b4cb7.ts.net"
```

`apps/api/.env` 将该域名加入来源白名单，并同步 Web 回跳地址：

```env
CORS_ALLOWED_ORIGINS="...,https://fangyikai-pc.tail1b4cb7.ts.net"
CSRF_TRUSTED_ORIGINS="...,https://fangyikai-pc.tail1b4cb7.ts.net"
WEB_URL="https://fangyikai-pc.tail1b4cb7.ts.net"
APP_BASE_URL="https://fangyikai-pc.tail1b4cb7.ts.net"
```

修改 `apps/web/.env` 后需重启 Web 开发服务器；修改 `apps/api/.env` 后需强制重建 API 容器：

```bash
docker compose -f docker-compose-local.yml -f docker-compose-local.override.yml \
  up -d --no-deps --force-recreate api
```

## 4. 验证

1. Tailnet 设备打开 Web 首页并登录，地址应始终保持
   `https://fangyikai-pc.tail1b4cb7.ts.net`，不跳回局域网 IP，也不出现 mixed content。
2. 打开研究链详情，确认 `/api/research/...` 请求为 HTTPS 同源请求。
3. 上传或读取一个附件，确认请求走 `/uploads/` 代理。

命令行快速检查：

```bash
curl -fsS -o /dev/null -w 'web=%{http_code} final=%{url_effective}\n' \
  https://fangyikai-pc.tail1b4cb7.ts.net/
```

## 5. 故障排查

| 现象                                 | 处理                                                                   |
| ------------------------------------ | ---------------------------------------------------------------------- |
| Serve 命令提示“Serve is not enabled” | 由 Tailnet 管理员打开 CLI 给出的授权链接，确认后重试                   |
| 登录返回 CSRF 403                    | 检查 `CSRF_TRUSTED_ORIGINS` 是否包含 HTTPS 域名，并确认 API 容器已重建 |
| 登录后跳回 `192.168.3.245`           | 检查 `VITE_WEB_BASE_URL`、`WEB_URL`、`APP_BASE_URL`，重启 Web 与 API   |
| 页面出现 HTTP 子资源                 | 检查是否绕过 Tailnet Serve 直接访问了 HTTP 诊断地址                    |
| 附件失败                             | 确认浏览器请求为同源 `/uploads/`，且 Vite 的 storage proxy 指向 MinIO  |

### 传输问题

| 现象                  | 处理                                                                     |
| --------------------- | ------------------------------------------------------------------------ |
| 首页 200 但长时间白屏 | 确认 3000 是 Vite Preview；开发态 HMR 请改用 `pnpm --filter web dev:hmr` |

## 6. 回滚

```bash
tailscale serve reset
```

随后把 `VITE_WEB_BASE_URL`、`WEB_URL`、`APP_BASE_URL` 恢复为局域网地址，移除新增 CORS / CSRF
来源，并重启 Web 与 API。
