# RWS-0 Synlora 持久卷验证

| 项目             | 内容                                                                     |
| ---------------- | ------------------------------------------------------------------------ |
| 时间             | 2026-11-07 18:35–18:39 +08                                               |
| Synlora 源码基线 | `e31acb6ca042fe508033dbc102c969a1797dcc2c7dcc2`                          |
| Synlora 版本     | `1.13.0`                                                                 |
| 执行器           | 源码内 `DockerCodeExecutor`                                              |
| 沙箱镜像         | `synlora-sandbox:rws0`，由 Synlora 仓库 `docker/sandbox/Dockerfile` 构建 |
| 工作副本         | Docker named volume，local bind backing directory                        |
| 资产卷           | 独立 Docker named volume，local bind backing directory                   |

## 1. 卷设计

验证使用两个 named volume：

```text
rws0-working-copy-OUWw4Y -> /tmp/rws0-synlora-poc.OUWw4Y/workspace
rws0-asset-OUWw4Y       -> /tmp/rws0-synlora-poc.OUWw4Y/asset
```

Docker volume options：

```json
{"device":"/tmp/rws0-synlora-poc.OUWw4Y/workspace","o":"bind","type":"none"}
{"device":"/tmp/rws0-synlora-poc.OUWw4Y/asset","o":"bind","type":"none"}
```

这样 Runner 和宿主验证工具看到同一 POSIX 目录，同时保留 named volume 的稳定挂载身份。

## 2. 执行请求

Runner 预先写入：

```text
.research/input.txt = runner-baseline-rws0
```

资产层预先写入：

```text
dataset/input.txt = immutable-asset-input
```

真实 `DockerCodeExecutor.execute()` 请求：

- Workspace root：named volume 对应的 Runner WorkingCopy。
- Workspace 挂载：`/workspace`，RW。
- 资产挂载：`/assets`，RO。
- cwd：`outputs/agent-rws0`。
- execution_id：`rws0-volume-proof`。
- 默认断网。

容器内验证：

1. 读取只读资产。
2. 读取 Runner 预置文件。
3. 写入 Agent 输出。
4. 尝试修改只读资产，若成功则退出 41。
5. 断言 `/workspace/.git` 不存在。

## 3. 实测结果

执行器返回：

```text
ok = true
sandbox = docker
exit_code = 0
```

容器身份：

```text
uid=1000 gid=1000 groups=1000
```

Agent 输出：

```text
outputs/agent-rws0/result.txt = synlora-agent-output
sha256 = 462fb41e278d1a019b2720549b45fe1fe7d3ef2801cf756bbb878380b6e31029
```

Runner 侧立即可见同一输出。

## 4. 运行时重建与只读撤权

临时沙箱退出后，用新容器以只读方式挂载同一 named volume：

```text
cat /workspace/outputs/agent-rws0/result.txt
```

返回：

```text
synlora-agent-output
```

再将同一 named volume 以 `:ro` 挂载并尝试写入：

```text
touch /workspace/outputs/agent-rws0/revoked.txt
```

写入被拒绝，校验脚本确认未产生新文件。

## 5. 结论

1. Synlora 现有 `DockerCodeExecutor` 不需要重写即可使用 Runner 提供的持久 WorkingCopy。
2. Agent 写入与 Runner 侧读取是同一目录，不是二次上传。
3. 计算环境销毁重建不删除 WorkingCopy。
4. 只读资产挂载保持只读。
5. 写挂载撤除后，新运行时不能继续写。
6. UID/GID 与宿主工作区属主保持 `1000:1000`。
7. Git 元数据不应放在 workspace 目录内，必须由 Runner 管理在独立路径。

## 6. 后续要求

Stage RWS-2 实现 Runner 时必须：

- 使用服务端 `mount_ref`，不接受客户端路径。
- 对每个 copy 保存 lease epoch。
- 撤权时停止旧容器或移除写挂载。
- 保持 workspace 与 Git 元数据分离。
- 将本验证脚本化为自动化并发和权限测试。
