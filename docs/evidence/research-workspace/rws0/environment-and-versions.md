# RWS-0 双环境版本与卷映射基线

| 项目              | 内容                                       |
| ----------------- | ------------------------------------------ |
| 时间              | 2026-11-07 18:07–18:50 +08                 |
| 本地 Plane 分支   | `ai-naive-workspace`                       |
| 本地 Plane commit | `59b3e9d2dfd068b6cebfd019b9a22508e25f96ce` |
| 远程入口          | `http://10.26.15.92:3300/`                 |

## 1. Plane

| 项目                       | 本地                        | 远程                       |
| -------------------------- | --------------------------- | -------------------------- |
| Web 入口                   | `http://127.0.0.1:3300/`    | `http://10.26.15.92:3300/` |
| HTTP                       | 200                         | 200                        |
| Server                     | Caddy                       | Caddy                      |
| 代码版本                   | `9.20.4`                    | 未能通过 HTTP 直接判定     |
| Instance `current_version` | `9.20.0`                    | `8.4.1`                    |
| Instance ID                | `b06732e26d6e72d17d4a66fe`  | `a5d91e6423af08e45afc4a02` |
| App base URL               | `http://192.168.3.245:3300` | `http://10.26.15.92:3300`  |
| 前端入口资源               | `entry.client-D70WU3GH.js`  | `entry.client-DukNfcGk.js` |

结论：

1. 两台 Plane 当前不是同一构建，也不是同一版本基线。
2. 远程 `8.4.1` 不能直接作为 `ai-naive-workspace` 的 E2E 环境。
3. 远程必须由部署负责人检出 `ai-naive-workspace` 并执行 `./scripts/deploy.sh --skip-pull` 后，才能进入 RWS-1 集成验证。

## 2. Synlora

| 项目        | 本地源码                                                          | 远程服务                                                                |
| ----------- | ----------------------------------------------------------------- | ----------------------------------------------------------------------- |
| 入口 / 仓库 | `/home/fangyikai/code/_AI4MS/Synlora`                             | `http://10.26.15.92:8006/`                                              |
| 分支 / 状态 | `develop`，commit `e31acb6ca042fe508033dbc102c969a1797dcc2c7dcc2` | 未取得 SSH 内部 commit                                                  |
| 版本        | `1.13.0` 正式版                                                   | `1.13.0` 正式版                                                         |
| Health      | 本地服务未运行                                                    | `{"status":"ok","deployment_id":"2a06c121f8d04a04","version":"1.13.0"}` |

结论：两端应用版本口径一致，但部署 commit、`DATA_DIR`、沙箱镜像 digest 和持久卷仍未远程核对。

## 3. RAGPortal / WeKnora

本地实际 RAGPortal：

| 项目            | 值                                                   |
| --------------- | ---------------------------------------------------- |
| 入口            | `http://127.0.0.1:8004/`                             |
| OpenAPI title   | `RAGPortal`                                          |
| OpenAPI version | `0.3.2`                                              |
| 进程            | `uvicorn app.main:app --host 0.0.0.0 --port 8004`    |
| 进程目录        | `/home/fangyikai/code/_AI4MS/RAGPortal/backend`      |
| 源码基线        | `8446c20059488721a3a585c9900475591ba9ccb5`           |
| 当前分支        | `hotfix/research-source-download`，同 `origin/main`  |
| Upload 接口     | `/api/uploads` 存在于 OpenAPI                        |
| 状态 / 列表接口 | `/api/uploads/mine`、`/api/uploads/{upload_id}` 存在 |

远程：

- `http://10.26.15.92:8000/` 返回 WeKnora 页面。
- `/api/health/` 未授权时返回 401。
- 未获得测试凭据，不能验证远程 RAGPortal / WeKnora 内部版本。

## 4. 本地 Plane 卷映射

实测容器挂载：

| 服务                  | 映射                                                                                                          |
| --------------------- | ------------------------------------------------------------------------------------------------------------- |
| `plane-api-1`         | `/home/fangyikai/code/_AI4MS/plane/apps/api -> /code`，RW                                                     |
| `plane-worker-1`      | `/home/fangyikai/code/_AI4MS/plane/apps/api -> /code`，RW                                                     |
| `plane-web-prod-1`    | `apps/web/build/client -> /usr/share/caddy/html`，RO；`apps/admin/build/client -> /usr/share/caddy/admin`，RO |
| `plane-plane-db-1`    | named volume `plane_pgdata -> /var/lib/postgresql/data`                                                       |
| `plane-plane-minio-1` | named volume `plane_uploads -> /export`                                                                       |

本地 RWS-0 POC 独立资源：

| 资源                | 值                                         |
| ------------------- | ------------------------------------------ |
| Forgejo 数据        | `rws0-forgejo-data`                        |
| Git 客户端          | `rws0-git-lfs:local`                       |
| Synlora WorkingCopy | named volume，local bind backing directory |
| Synlora 只读资产    | 独立 named volume                          |
| 临时凭据            | 仅保存在 `/tmp`，不入 Git                  |

## 5. 远程部署路径与访问状态

既有文档记录远程项目路径：

```text
/home/fangyikai/github_project/SynlysAI/plane
```

SSH 尝试：

```text
fangyikai@10.26.15.92: Permission denied (publickey,gssapi-keyex,gssapi-with-mic,password)
root@10.26.15.92: Permission denied
```

显式使用本机 `~/.ssh/plane_prod_ed25519` 也被拒绝。

因此以下事项无法远程运行时核对：

- 当前 checkout commit。
- `apps/api` bind mount。
- 数据库 volume。
- MinIO volume。
- Caddy 静态目录。
- Synlora `DATA_DIR` 和沙箱镜像。
- Forgejo / Runner 后续部署卷。

## 6. 对齐决定

当前只能完成“基线差异识别”，不能完成“运行版本对齐”。

进入远程 E2E 前的门槛：

1. 部署负责人为当前开发机开通受控 SSH，或代为执行部署。
2. 备份远程 Plane 数据库和静态构建。
3. 远程检出 `origin/ai-naive-workspace`。
4. 执行：

```bash
./scripts/deploy.sh --skip-pull
```

5. 远程 `/api/instances/`、前端构建和本地 commit 对齐。
6. 记录远程 Docker volume、Synlora `DATA_DIR` 和测试账号边界。
7. 完成远程回退说明后才允许浏览器 E2E。
