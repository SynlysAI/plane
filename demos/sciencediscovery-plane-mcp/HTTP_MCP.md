# Plane Demo 的 HTTP 接入

本目录新增 `http_mcp.py`，通过 MCP SDK 的 Streamable HTTP 提供 `/mcp`。
原有 `read_only_mcp.py`、`agent_mcp.py` 和 STDIO 配置继续可用，不需要迁移。
这是独立服务，部署它不会自动升级或重启 Plane / ScienceDiscovery。

```text
本机 ScienceDiscovery ────┐
                         ├─ Bearer 认证 → HTTP MCP /mcp → 官方 STDIO MCP → Plane API
服务器 ScienceDiscovery ─┘
```

## 配置与权限

复制 `http-config.example.json` 为受保护的 `http.local.json`（已忽略 Git），修改配置：

| 项                         | 作用                                                                                        |
| -------------------------- | ------------------------------------------------------------------------------------------- |
| `host` / `port`            | 服务监听地址与端口；容器内使用 `0.0.0.0:8765`                                               |
| `allowed_hosts`            | 客户端请求中的 Host 白名单，包含服务器 IP/域名及内部服务名；`name:*` 允许该主机的不同端口   |
| `allowed_origins`          | 默认空列表；无 Origin 的后端客户端可访问，浏览器 Origin 默认拒绝；没有开放 CORS             |
| `state_dir`                | 发布草稿的持久目录；容器固定 `/app/data`，直接运行时改为本机可写目录                        |
| `clients[].name`           | 稳定且唯一的使用者标识，勿重复使用已离职用户的名称                                          |
| `clients[].bearer_token`   | HTTP MCP 专用随机令牌，至少 32 个 URL-safe 字符，每人独立；不是 Plane API Token             |
| `clients[].plane`          | 该使用者的 Plane API/UI origin、工作区和个人 Plane Token                                    |
| `clients[].mode`           | `read-only`（默认）保留原四资源读取工具与策略工具；`agent` 提供任务链接上下文及可选进展发布 |
| `clients[].enable_publish` | 仅 agent 模式可设为 `true`；默认关闭；仍需展示草稿并获用户明确发布指令                      |

生成 HTTP 访问令牌，在本机终端运行后直接填入私密配置：

```bash
python -c "import secrets; print(secrets.token_urlsafe(32))"
```

每个使用者独立运行官方 MCP 子进程，HTTP 每次请求都校验 Bearer，按令牌选择固定的 Plane 账号与工具范围。
请求不能覆盖 Plane 地址、凭据或启动命令。服务端不会从宿主环境继承另一使用者的 `PLANE_*` 配置。
不同使用者的草稿独立存储；同一使用者从本机/服务器使用相同凭据时可以继续自己的草稿。
Plane 资源权限仍由其个人账号控制，HTTP 令牌本身不会扩大 Plane 权限。
多名用户若配置相同 Plane 账号，他们仍能看到该共享账号拥有权限的同一批资源；应使用各自个人账号。

`PLANE_WORKSPACE_SLUG` 是浏览器地址中 `/<workspaceSlug>/projects/...` 的工作区标识，不一定等于工作区显示名称。首段为 `public` 时也可能表示名为 `public` 的实际工作区，不能仅凭单词将它当成公共页面前缀；用该账号的项目 API 读取结果确认。

配置文件包含两类令牌，仅服务账号可读，不放入镜像、Git 或客户端共享配置。
增加/移除使用者或轮换令牌后需重启 HTTP 服务。HTTP 令牌轮换保留同名使用者草稿；Plane Token 轮换后旧草稿不复用。
HTTP 传输无服务端会话，重连不丢草稿；发布仍使用既有持久化日志、文件锁和不确定写入恢复规则。
客户端取消/断线不保证撤销远端写入，重新连接后应重试同一 `draft_id`，不可创建新草稿绕过待核实状态。

## 直接在本机运行

使用原 Demo 的独立 Python 环境和当前平台锁文件；HTTP 依赖已包含在现有锁文件中。
在 `http.local.json` 中将 `host` 改为 `127.0.0.1`，`state_dir` 改为本机可写目录（相对路径以配置文件目录为准）。

Windows，在本目录执行：

```powershell
& .\.venv\Scripts\python.exe .\http_mcp.py --config .\http.local.json
```

Linux，在本目录执行：

```bash
python3.11 -m venv .venv
.venv/bin/python -m pip install -r requirements.linux.lock.txt
.venv/bin/python http_mcp.py --config /absolute/private/http.local.json
```

本机 MCP URL 为 `http://127.0.0.1:8765/mcp`；健康检查为 `/healthz`，仅返回服务是否就绪，不包含配置。
直接运行如需供其他机器连接，把 `host` 改为 `0.0.0.0`，并在 `allowed_hosts` 添加实际服务器 IP/域名。

## Docker 部署到服务器

在本目录使用独立 Compose 文件。先填写私密配置，保证容器 UID 10001 能读取该文件，且其他不相关用户不能读取。
文件绑定只读；草稿存储在独立 named volume，不放在镜像内。
模板要求容器内部监听 `0.0.0.0:8765`、`state_dir=/app/data`；更改外部端口用 `PLANE_HTTP_PORT`。

默认只映射服务器回环地址，适合经反向代理访问：

```bash
export PLANE_HTTP_CONFIG_FILE=/absolute/private/http.local.json
docker compose -f compose.http.yml up -d --build
docker compose -f compose.http.yml ps
```

如在可信内网中直接向本机客户端开放，启动前设置：

```bash
export PLANE_HTTP_BIND=0.0.0.0
export PLANE_HTTP_PORT=8765
docker compose -f compose.http.yml up -d --build
```

此时计划接入地址为 `http://10.26.15.92:8765/mcp`，这是模板约定，需部署后实际验证。
3300 仍是 Plane 网页/API 端口；新增服务不会自动出现在 3300 下。
服务需能访问配置的 Plane API origin，容器中的 `127.0.0.1` 不指向服务器宿主。
服务器实际防火墙需允许选定的外部端口。

跨不可信网络使用 HTTPS 反向代理，避免 Bearer 和科研内容明文传输。
反向代理需保留 `Authorization`、原始 Host 和完整路径，将 `/mcp` 转发至内部 `8765/mcp`，并允许 GET/POST/DELETE。
增加代理域名到 `allowed_hosts`；工具请求超时至少 120 秒。
服务不信任 `X-Forwarded-*`，不依赖浏览器 Cookie，不提供旧版 `/sse` 入口。
停用用 `docker compose -f compose.http.yml stop`；保留草稿 volume，不使用 `down -v`。

## ScienceDiscovery 接入

在“系统设置 → MCP 服务器 → 自定义”选择 **Streamable HTTP**，或导入 `sciencediscovery-http.example.json`：

- URL 填服务器 MCP 地址，如 `http://10.26.15.92:8765/mcp`。
- 请求头填 `Authorization: Bearer <分配给本人的 HTTP MCP 令牌>`，不要填写 Plane Token。
- 内网部署为此 MCP 选择内网直连代理策略；不要仅依赖环境变量 `NO_PROXY`。
- 测试连接成功后全局启用，并在目标 Session 中启用对应连接器。

服务器 ScienceDiscovery 可使用相同外部 URL（前提是其后端网络可达）；若加入同一 Docker 网络，可以改用
`http://plane-mcp-http:8765/mcp`，该服务名已在示例 Host 白名单内。跨 Compose 项目默认不共享网络，需部署时显式加入同一网络。
原有 STDIO 接入可继续使用，HTTP 层不会改动旧配置。

连接测试只证明 MCP 协议与工具发现正常。用 Inspector 调用 `project(action=list)`（read-only 模式），
或 `read_task_context(task_url=真实任务链接)`（agent 模式），确认真实 Plane 权限与业务读取。
agent 模式要发布评论，应先在专用测试任务准备草稿、展示完整正文，再经用户批准发布并核对读回。

## 验证与排查

本地离线验证（真实 HTTP + MCP 客户端、假 Plane 上游，不修改真实 Plane）：

```powershell
& .\.venv\Scripts\python.exe -m unittest discover -s tests -p 'test_*.py' -v
```

测试覆盖每次请求的认证、无效/重复 Authorization、Host/Origin 限制、只读写入拒绝、双客户端并发读取、
跨用户草稿拒绝、经批准发布、断开后同一草稿重试，以及原有 STDIO 回归。

| 现象                   | 检查                                                                        |
| ---------------------- | --------------------------------------------------------------------------- |
| 401                    | HTTP MCP Bearer 缺失、错误或已轮换；不能用 Plane Token 替代                 |
| 421                    | 请求 Host 未加入 `allowed_hosts`；核对代理是否修改 Host                     |
| 403                    | 请求携带未允许的 Origin；后端直连不需要添加浏览器 Origin                    |
| 健康检查失败           | 私密配置、锁文件依赖、容器读取权限和内部监听端口；官方 MCP 初始化也必须成功 |
| 工具发现成功但读取失败 | Plane Token、工作区/项目权限、服务到 Plane API 的网络                       |
| 只有一个读取工具       | mode=agent 且默认关闭发布；符合配置                                         |
| 默认没有服务器外部端口 | Compose 默认仅绑定回环；经代理访问或显式设置内网监听                        |
| 上游进程退出           | 重启 HTTP 服务；草稿日志保留在 volume；不可删日志盲目重发                   |

源码依据：[MCP Python SDK Streamable HTTP 示例](https://github.com/modelcontextprotocol/python-sdk/blob/v1.28.1/examples/servers/simple-streamablehttp/mcp_simple_streamablehttp/server.py)。

本次验证（2026-10-13）：106 项自动测试通过，包含真实回环 HTTP 协议及官方 Plane MCP 子进程的工具发现；Python 依赖检查、Compose 配置校验通过。自动测试中的业务读写使用假 Plane 上游。

另外已完成“本机 HTTP MCP → 服务器 Plane”的真实联调：读取指定项目、完整分页状态、任务详情及评论，并在用户明确要求后通过 agent 模式新增恰好一条测试评论，再通过 HTTP MCP 读回核对。发布能力仅对该次测试在内存中启用，本机保存的配置仍默认只读。私密配置、草稿日志及含业务内容的验证证据保留在 Git 忽略目录，不提交。

本机 Docker 引擎未启动，未验证容器构建；HTTP 服务尚未部署到服务器，因此服务器上的示例 MCP URL 需部署后才会生效。客户端选择 Streamable HTTP，请求头填写 `Authorization: Bearer <HTTP MCP token>`；直接在聊天里发送 URL 不会自动注册连接器。
