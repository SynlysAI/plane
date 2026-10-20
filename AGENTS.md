# CLAUDE.md

## 项目开发规范

主要开发规范见 [AGENTS.md](AGENTS.md)（命令、代码风格、测试约定）。

## 部署（重要）

本机采用混合生产部署：后端 `docker-compose-local.yml`（api/worker/beat 源码卷挂载），前端 `docker-compose-prod-web.yml`（Caddy 服务 `apps/web/build/client`）。更新部署统一用：

```bash
./scripts/deploy.sh              # 完整更新：git pull → pnpm build web/admin → 重建 Caddy → 跑迁移 → 重建 api/worker/beat → 健康检查
./scripts/deploy.sh --skip-pull  # 部署当前检出的代码（本地分支 / 未推送提交必须加此参数，否则 git pull 会失败或拉错分支）
./scripts/deploy.sh --web        # 仅构建前端并重建 Caddy
./scripts/deploy.sh --backend    # 仅跑数据库迁移并重建后端容器
```

- 部署入口：Web `http://127.0.0.1:3300`（`PLANE_WEB_PORT` 可覆盖），API 由 Caddy 反代
- 迁移失败：`docker logs <migrator容器ID>`；服务日志：`docker compose -f docker-compose-local.yml logs api`
- 已初始化的部署缺 .env 时脚本直接报错——**不要重跑 setup.sh**（会覆盖全部 .env）
- 禁用项：`docker-compose-test.yml` 测试栈不要运行（用户明确要求）
