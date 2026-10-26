# SD 缺少自定义 MCP 接口时的配置

日期：2026-10-26。

## 原因

提交 `3316e3d4` 在 `create_science_discovery_session` 中复用了 `RESEARCH_MCP_ENABLED`：
开启 Plane 对外科研 MCP，也会在创建 SD 会话时向 SD 的 `/api/mcp/servers` 注册科研只读连接器。
SD 实例未提供该接口（或部署入口未转发该接口）时，注册返回 404，Plane 随即撤销本次上下文授权并终止创建会话。
个人 MCP 连接管理、Agent 客户端确认流程本身没有调用这个 SD 接口。

## 调整

本次增加独立后端开关 `SCIENCE_DISCOVERY_RESEARCH_MCP_ENABLED`，默认 `1`，保持已有支持连接器的部署行为。
只有它与 `RESEARCH_MCP_ENABLED` 都为 `1` 时，Plane 才向 SD 自动注册科研连接器。

将包含该修复的代码部署到服务器后，在 API 实际使用的环境文件中设置（仓库混合部署为 `apps/api/.env`）：

```dotenv
# 保留外部 Agent 直连 Plane 的科研读取/写入功能及原有授权策略
RESEARCH_MCP_ENABLED=1
RESEARCH_MCP_WRITE_ENABLED=1

# 当前 SD 不支持 /api/mcp/servers，关闭向 SD 自动注册科研只读连接器
SCIENCE_DISCOVERY_RESEARCH_MCP_ENABLED=0
```

写入开关保持服务器原值；无需为了本修复开启写入权限。
旧版本不识别新增开关，必须先更新代码。无需数据库迁移、前端构建或修改已有用户连接凭据。

## 使用现有部署脚本

`scripts/deploy.sh` 与 `scripts/deploy-mcp.sh` 均无需修改。前者部署 Plane 后端，后者部署独立行政 MCP 门户；
本次修复不修改门户代码或其私密配置，也无需重新运行 `deploy-mcp.sh`。

在服务器仓库中先拉取包含修复的代码，修改上述 `apps/api/.env` 后，运行：

```bash
./scripts/deploy.sh --backend --skip-pull
```

`--backend` 跳过前端构建，仍按既有流程检查迁移并重新构建、创建 API/Worker/Beat 等后端服务；
`--skip-pull` 部署已经核对过的当前代码。该脚本不设置新增开关，必须手动在环境文件中添加。
本次修复不新增迁移；若服务器还落后其他提交，脚本仍会应用那些提交的待执行迁移。

审批合并到 `develop` 后，如按原流程让脚本自行拉取代码，可在确认当前分支及上游为目标 `develop`、
工作区没有阻止拉取的改动后运行 `./scripts/deploy.sh --backend`。原完整命令 `./scripts/deploy.sh` 也可使用，
但会额外构建前端。发布分支测试、未合并分支或已手动选择代码时使用 `--skip-pull`。

如不使用部署脚本，也可按现有部署方式使 API 加载新代码和新环境变量。混合部署的手工命令如下，
保留服务器原有的 Compose 项目名及所有 `-f` 参数：

```bash
docker compose -f docker-compose-local.yml up -d --no-deps --no-build --force-recreate api
```

镜像部署先构建或拉取包含修复的镜像，再重新创建 API；普通 `restart` 不更新容器环境变量。

只读取开关核对实际生效值，不输出凭据：

```bash
docker compose -f docker-compose-local.yml exec -T api \
  python manage.py shell -c 'from django.conf import settings as s; print({k: getattr(s,k,None) for k in ["RESEARCH_MCP_ENABLED","RESEARCH_MCP_WRITE_ENABLED","SCIENCE_DISCOVERY_RESEARCH_MCP_ENABLED"]})'
```

预期对外读取保持开启，SD 自动注册为 `False`。重新创建一个 SD 科研助手会话，确认不再请求 `/api/mcp/servers`，
同时验证原有外部科研 MCP 连接仍能读取授权节点。旧会话不会自动增加或移除连接器。

## 功能影响

关闭自动注册后，SD 仍可创建项目、会话和运行，使用自身工具及上传的会话文件；
它不再通过该连接器自动读取 Plane 的科研链、节点、任务和报告。
外部 Agent 仍可直接使用 Plane 科研 MCP，权限、到期和撤销规则不变。
如果需要 SD 自动访问上述 Plane 数据，应升级 SD 或修复其 API 转发，使其支持自定义 MCP 服务注册和测试，再把新开关设回 `1`，
并配置 SD 可访问的 `RESEARCH_MCP_PUBLIC_BASE_URL`。

旧代码的临时处理只能把 `RESEARCH_MCP_ENABLED=0` 后重新创建 API；这同时关闭 Plane 对外科研 MCP，
因此需要保留外部 MCP 时，应采用本次独立开关。

SD 设置页“测试连接”目前检查 `/api/models`，不检查连接器接口；测试成功并不能证明 SD 支持 `/api/mcp/servers`。
