# 科研智能平台 Phase 1.5 分角色人工测试启动与操作指南

| 项目     | 内容                                                                                                |
| -------- | --------------------------------------------------------------------------------------------------- |
| 文档版本 | v1.1（2026-09-26）                                                                                  |
| 文档定位 | 启动 dev 环境、通过 Tailnet 访问、执行每日健康检查和处置常见故障                                    |
| 详细用例 | [分角色人工测试计划](./research-intelligent-platform-phase-1.5-role-validation-manual-test-plan.md) |
| 开发计划 | [分角色验证开发计划](./research-intelligent-platform-phase-1.5-role-validation-development-plan.md) |
| 执行手册 | [Phase 1.5 联调执行手册](./research-intelligent-platform-phase-1.5-execution-runbook.md)            |
| 环境     | `public` π-Lab 基线、Plane `4.15.2`、RAGPortal、Synlora、WeKnora                                    |
| 测试 KB  | 只使用 `plane测试`；不得跨课题复用                                                                  |

## 1. 使用规则

- 每轮测试先完成本指南 §2 和 §3；健康检查不通过时停止写入测试。
- 多身份使用浏览器隐私窗口或独立 Profile；凭据从本机安全存储注入，不写入命令历史、截图或文档。
- 工作区固定为 `public`，旧 seed 只允许出现在隔离自动化测试数据库。
- 证据放在 `docs/evidence/phase-1.5/`，文件只保留脱敏身份、对象 ID、状态码、错误码和结论。
- 具体角色动作、正负例和清理顺序以详细人工测试计划为准。

## 2. dev 环境启动与 Tailnet 访问

### 2.1 启动顺序

在开发机执行；已有同一服务时先确认端口和进程，避免启动第二个 Synlora 实例。

```bash
cd /home/fangyikai/code/_AI4MS/plane

# 1. WeKnora 已部署，不在本机重复启动
curl -fsS http://10.26.15.93:8000/ >/dev/null

# 2. RAGPortal（单实例）
cd /home/fangyikai/code/_AI4MS/RAGPortal/backend
.venv/bin/python -m uvicorn app.main:app --host 0.0.0.0 --port 8004

# 3. Synlora（单实例）
cd /home/fangyikai/code/_AI4MS/Synlora/apps/web/backend
.venv/bin/python run_uvicorn.py

# 4. Plane API、worker、beat；端口映射为宿主机 8001
cd /home/fangyikai/code/_AI4MS/plane
docker compose -f docker-compose-local.yml -f docker-compose-local.override.yml up -d

# 5. Web/Admin 以 Vite Preview 启动，供局域网和 Tailnet 使用
pnpm dev
```

RAGPortal 和 Synlora 建议分别放在 tmux 窗口，日志保存到本机 `/tmp/phase-1.5/`；日志不得提交 Git。Web 使用 `pnpm dev` 的 Preview，不要把 `react-router dev` 直接暴露给 Tailnet。

### 2.2 当前可用入口

- Tailnet 直连：<http://100.109.35.2:3000/>（当前已验证 HTTP 200，可立即开始测试）。
- 局域网备用：<http://192.168.3.245:3000/>。
- 本机入口：<http://127.0.0.1:3000/>。
- API 健康端点：<http://127.0.0.1:8001/>。

Tailscale Serve 当前尚未获得 Tailnet 管理员授权。授权后执行：

```bash
tailscale serve --bg 3000
tailscale serve status
curl -fsS -o /dev/null -w 'https=%{http_code} final=%{url_effective}\n' \
  https://fangyikai-pc.tail1b4cb7.ts.net/
```

在 Serve 授权完成前，不把 HTTPS 入口作为通过条件；HTTP Tailnet 直连仍可用于本轮内网测试。若浏览器无法访问 `100.109.35.2`，先确认客户端已加入同一 Tailnet，再检查 `tailscale ping fangyikai-pc`。

## 3. 每轮 L1 健康快照

```bash
set -e
curl -fsS -o /dev/null http://127.0.0.1:3000/
curl -fsS http://127.0.0.1:8001/
curl -fsS http://127.0.0.1:8001/api/research/health/
curl -fsS http://127.0.0.1:8004/api/health
curl -fsS http://127.0.0.1:8005/api/health
curl -fsS -o /dev/null http://10.26.15.93:8000/
docker compose -f docker-compose-local.yml -f docker-compose-local.override.yml ps
```

通过条件：Web/API、RAGPortal、Synlora、WeKnora 全部返回成功；`api`、`worker`、`beat-worker` 容器状态为 `Up`；API research health 的 `module_enabled=true`；未出现第二个 Synlora 进程。

每轮记录以下字段到 `docs/evidence/phase-1.5/health/{YYYYMMDD}-startup.md`：时间、Plane commit、版本、五服务状态、Tailnet 入口、容器状态和阻塞项。不要记录环境变量值。

## 4. 测试前数据与身份检查

```bash
cd /home/fangyikai/code/_AI4MS/plane
./scripts/rebuild-pi-lab-baseline.sh --verify-only
```

通过条件：22 个组织节点、189 名学生、14 名导师、唯一 Main PI 洪文晶，`projects/research_profiles/research_chains/knowledge_requests=0`；验证命令只读。

在 `identity/me` 的 `user.role_context` 中核对实际解析标签，然后打开[详细人工测试计划](./research-intelligent-platform-phase-1.5-role-validation-manual-test-plan.md)，按 L2 解析主 PI、产业化负责人、直接导师、学生、管理员、NONE 和 Guest。角色缺失时停止，不得用历史账号代替。

## 5. 测试执行与证据

1. L1 健康和真实基线。
2. L2 角色解析、四入口导航和能力摘要。
3. L3 学生创建主课题、管理员绑定 `plane测试`、上传和检索。
4. L3.5 五个开关逐项 OFF/恢复。
5. L3.6 七类身份正例与负例。
6. L4 完整闭环、导出 hash 和审批。
7. L5 Synlora、RAGPortal/WeKnora 降级、清理和基线复核。

证据命名示例：`role-resolution-20260926.md`、`L3.6-role-matrix-20260926.md`、`L4-e2e-20260926.md`。证据不得保存密码、Token、API Key、完整邮箱、原始正文或未脱敏截图。

## 6. 故障处置

| 现象                      | 处理                                                                                 |
| ------------------------- | ------------------------------------------------------------------------------------ |
| Web 200 但白屏            | 确认 3000 是 Vite Preview；查看 `pnpm dev` 日志并强制刷新                            |
| API 访问 8004/8005 超时   | 确认宿主服务监听 `0.0.0.0`，并按 `docker exec plane-api-1 ip route` 核对 Docker 网关 |
| 登录 CSRF 403             | 核对 Tailnet 来源已在 `CSRF_TRUSTED_ORIGINS`，重建 API 容器                          |
| 页面显示 `not_configured` | 检查科研管理 / 集成中的 RAGPortal 连接和启用状态                                     |
| Agent 创建即过期          | 检查 Context TTL、宿主机时间和 Synlora 日志                                          |
| 上传一直解析中            | 在 WeKnora 核对任务状态，回到 RAGPortal 手动刷新；不要重复上传                       |
| Tailscale HTTPS 拒绝连接  | 执行 `tailscale serve status`；若显示未启用，先由管理员批准 Serve 链接               |

## 7. 停止与恢复

```bash
# 停止 Web/Admin（在启动 pnpm dev 的终端按 Ctrl-C）
# 停止 Plane 容器
cd /home/fangyikai/code/_AI4MS/plane
docker compose -f docker-compose-local.yml -f docker-compose-local.override.yml stop api worker beat-worker

# 恢复前重新启动并执行 §3 健康快照
docker compose -f docker-compose-local.yml -f docker-compose-local.override.yml up -d api worker beat-worker
```

降级演练只在详细人工测试计划 L5 中执行；恢复后必须重新跑 L1，并确认事件没有重复、人工记录仍可保存。
