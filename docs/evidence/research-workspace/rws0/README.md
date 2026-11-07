# Stage RWS-0 技术验证证据

| 项目 | 内容                                              |
| ---- | ------------------------------------------------- |
| 日期 | 2026-11-07                                        |
| 分支 | `ai-naive-workspace`                              |
| 环境 | 本地隔离 POC 与远程只读探测                       |
| 状态 | 核心技术验证通过；远程 Plane 版本对齐和部署待授权 |

## 证据文件

| 文件                                                    | 内容                                                                  |
| ------------------------------------------------------- | --------------------------------------------------------------------- |
| [`Forgejo Git/LFS/PR/Webhook 验证`](forgejo-git-lfs.md) | Forgejo 15.0.11、两用户协作、HTTPS、LFS、反向代理鉴权、撤权和 webhook |
| [`Synlora 持久卷验证`](synlora-volume.md)               | 真实 `DockerCodeExecutor`、named volume、只读资产和写挂载撤除         |
| [`环境版本与卷映射基线`](environment-and-versions.md)   | 本地 / 远程 Plane、Synlora、RAGPortal 版本与映射差异                  |
| [`契约三方评审记录`](contract-review.md)                | Plane / Runner / Synlora 视角评审和冻结结论                           |

## 结论

1. Forgejo 15.0.11 的 Git、LFS、PR、分支保护、reverse proxy auth、撤权和 webhook 均通过本地真实 POC。
2. Synlora 当前 `DockerCodeExecutor` 可以把同一个持久 WorkingCopy 挂载为 `/workspace`；Agent 写入立即可见于 Runner 侧，运行时重建后仍可读。
3. 只读资产挂载不可修改；将同一 named volume 改为只读后，运行时不能继续写。
4. RAGPortal 本地实际服务 OpenAPI 版本为 `0.3.2`，源码基线为 `8446c200...`。
5. 三份核心契约通过 JSON Schema 与示例校验，并完成 Plane / Runner / Synlora 三个消费视角的工程评审，进入 v1 冻结。
6. 远程 Synlora `1.13.0` 与本地源码版本一致。
7. 远程 Plane 实例版本为 `8.4.1`，本地代码为 `9.20.4`、实例记录为 `9.20.0`，当前不能视为同一集成基线。
8. 本机现有 SSH 密钥无法登录 `fangyikai@10.26.15.92`，因此无法读取远程运行卷或执行 `./scripts/deploy.sh --skip-pull`。该项保持阻塞，不伪称完成。
