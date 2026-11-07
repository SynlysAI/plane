# Stage RWS-0 双环境基线记录

| 项目     | 内容                                                                           |
| -------- | ------------------------------------------------------------------------------ |
| 记录日期 | 2026-11-07                                                                     |
| 实现分支 | `ai-naive-workspace`                                                           |
| 代码基线 | `59b3e9d2dfd068b6cebfd019b9a22508e25f96ce`                                     |
| 状态     | RWS-0 本地技术验证完成；远程 Plane 版本与卷运行时核对阻塞                      |
| 详细证据 | [`Stage RWS-0 技术验证证据`](../../evidence/research-workspace/rws0/README.md) |

## 1. 环境定义

| 环境           | 入口                       | 当前用途                                                             | 破坏性操作规则                         |
| -------------- | -------------------------- | -------------------------------------------------------------------- | -------------------------------------- |
| 本地开发测试机 | `http://127.0.0.1:3300/`   | 单元、契约、迁移初测、Forgejo / MinIO POC、故障注入                  | 允许，但必须使用测试库和临时卷         |
| 远程集成测试机 | `http://10.26.15.92:3300/` | 浏览器 E2E、多用户、Synlora / RAGPortal 集成、迁移 dry-run、恢复演练 | 仅在本地通过、版本对齐并完成快照后执行 |

两台机器都不得被描述为生产环境，也不得用生产数据做破坏性实验。

## 2. 当前结论

### 2.1 已通过

- Forgejo 15.0.11 本地隔离部署成功。
- 两名真实测试用户完成 HTTPS clone、分支推送、协作提交、PR、official review 和 merge。
- Git LFS 上传、下载和 hash 校验通过。
- `main` 分支保护拒绝直推。
- Reverse proxy auth 覆盖 Git Smart HTTP 与 LFS。
- 匿名 Git / LFS 均被拒绝。
- 撤销协作者后，仍有效的导师 token fetch 私有仓库失败。
- Forgejo push webhook 的 HMAC-SHA256 签名和 delivery ID 校验通过。
- Synlora 当前 `DockerCodeExecutor` 与 Runner 侧同一持久 WorkingCopy 同盘读写验证通过。
- 计算环境重建后 WorkingCopy 仍存在。
- 只读资产不可修改，写挂载撤除后不可写。
- RAGPortal 本地 OpenAPI 版本确认为 `0.3.2`。
- 三份核心契约完成工程评审并冻结 v1。

### 2.2 阻塞项

远程测试机无法完成运行时对齐：

```text
fangyikai@10.26.15.92: Permission denied
root@10.26.15.92: Permission denied
```

显式使用本机 `~/.ssh/plane_prod_ed25519` 同样被拒绝。因此不能读取远程 checkout、Docker volume 或执行部署脚本。

同时，远程 Plane `/api/instances/` 显示版本 `8.4.1`，本地代码为 `9.20.4`、实例记录为 `9.20.0`，当前不能视为同一集成基线。

## 3. 版本摘要

| 系统      | 本地                                                   | 远程                                   |
| --------- | ------------------------------------------------------ | -------------------------------------- |
| Plane     | 代码 `9.20.4`，instance `9.20.0`，commit `59b3e9d2...` | instance `8.4.1`，commit 未知          |
| Synlora   | 源码 `1.13.0`，commit `e31acb6c...`                    | health 返回 `1.13.0`，commit 未知      |
| RAGPortal | OpenAPI `0.3.2`，源码 `8446c200...`                    | 未暴露可匿名核对的 RAGPortal OpenAPI   |
| WeKnora   | 不适用                                                 | `8000` 返回 WeKnora，health 未授权 401 |

## 4. 远程对齐门槛

远程进入 E2E 前必须：

1. 部署负责人开通受控 SSH，或代为执行部署。
2. 备份数据库、静态构建和运行卷。
3. 检出 `origin/ai-naive-workspace`。
4. 执行 `./scripts/deploy.sh --skip-pull`。
5. 确认远程 Plane 版本、构建资源和本地基线一致。
6. 记录远程 Plane、Synlora、RAGPortal 的 commit、卷映射和回退命令。
7. 确认测试账号范围，不使用生产数据。

## 5. 记录纪律

- 不记录密码、Cookie、API token、完整账号邮箱或用户正文。
- 不把一台机器的测试结果写成另一台机器的结果。
- 不把入口 HTTP 200 写成 Forgejo、Synlora、RAGPortal 或 Workspace Runner 已接通。
- 远程 SSH 未授权时，不伪造卷映射和部署结果。
