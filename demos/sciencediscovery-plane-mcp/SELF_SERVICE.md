# 个人 Agent 自助接入：Codex 优先，兼容 ScienceDiscovery

2026-10-19 统一入口更新：Plane 个人设置新增 `/settings/profile/mcp/`，旧 `/mcp/` 与 `/{workspace-slug}/mcp/` 自动跳转；通过固定上游的同源桥接管理本服务的行政项目连接。原 `/connect`、所有客户端协议地址和 Bearer 验证保持兼容；本服务不自动获得科研节点写权限。配置与使用见 [统一 MCP 管理说明](../../docs/operations/mcp-unified-management.md) 和 [部署说明](../../docs/operations/mcp-unified-deployment.md)。以下仍描述独立部署和旧入口。

本方案只扩展独立 MCP 服务，不修改 Plane 的前端、登录或 API。`/mcp` 是通用 Streamable HTTP 接口，Codex、ScienceDiscovery 等客户端均可使用。原 `http-config.example.json` 中管理员分配的静态令牌继续有效；自助模式为可选能力，默认不开启。

## 使用流程

1. 用户在 Plane 的个人设置中创建自己的个人访问令牌。
2. 打开部署者提供的 `/connect`，粘贴个人令牌并验证。页面不接收 Plane 密码，也不复用 Plane 浏览器 Cookie。
3. 选择工作区，填写连接名称和有效期，生成个人 MCP 连接。
4. 优先复制 Codex 的 TOML 片段，合并到个人 `~/.codex/config.toml`，保留其他已有配置，然后重新连接或重启 Codex。
5. 也可下载 ScienceDiscovery JSON，在系统设置中导入、测试、启用，并在会话中选择该连接器。
6. 不再使用的连接可在“我的连接”中撤销。首次配置后，客户端自动携带请求头，不需要每次聊天填写令牌。

导出的 Codex 配置使用官方支持的 `url`、`http_headers`、`tool_timeout_sec` 与 `default_tools_approval_mode = "prompt"`，保留客户端操作审批。配置中只包含新生成的 MCP 令牌，不包含 Plane 个人令牌。完整 MCP 令牌仅在生成时返回，不可再次查询；遗失后重新生成并撤销旧连接。

这仍是独立 MCP 令牌的自助发放方案，不是 OAuth 登录。Plane 令牌仅由 MCP 后端使用 `X-Api-Key` 访问固定的 Plane API；不会直接作为 MCP Bearer 令牌，也不会发送给其他 Agent 或模型。

## 服务器配置

使用 `http-self-service.example.json`。容器的启动方式与 [HTTP_MCP.md](HTTP_MCP.md) 相同：

```bash
cd demos/sciencediscovery-plane-mcp
cp http-self-service.example.json http.local.json
# 编辑 http.local.json，核对以下部署项。
```

| 设置                               | 说明                                                                                |
| ---------------------------------- | ----------------------------------------------------------------------------------- |
| `self_service.enabled`             | 设为 `true` 开启独立自助页面；关闭时原静态客户端继续运行                            |
| `self_service.public_url`          | 用户浏览器和 Agent 共同访问的 MCP origin，不含路径，例如 `https://mcp.lab.example`  |
| `self_service.plane_base_url`      | MCP 服务访问的固定 Plane API origin，不能由用户覆盖                                 |
| `self_service.plane_ui_url`        | 浏览器访问的 Plane origin，用于生成任务链接和个人设置入口                           |
| `self_service.workspaces`          | 管理员开放自助接入的工作区 slug 列表，如 `["public"]`；用户仍需通过实际账号权限验证 |
| `self_service.allow_publish`       | 默认 `false`；为 `true` 时，用户才可以选择启用草稿与评论发布                        |
| `self_service.allow_insecure_http` | 仅可信内网 Demo 可显式设为 `true`，公网部署使用 HTTPS 并关闭此选项                  |
| `self_service.max_token_days`      | MCP 令牌允许的最大天数，默认 90                                                     |
| `self_service.max_tokens_per_user` | 每人有效连接数量上限，默认 10                                                       |
| `self_service.max_runtimes`        | 动态上游运行环境数量上限，默认 20；达到上限时返回 503，空闲环境 5 分钟后释放        |
| `clients`                          | 可为空，也可保留原管理员配置的静态客户端；无需手动添加自助用户                      |
| `state_dir`                        | 容器保持 `/app/data`，用于凭据和草稿持久化                                          |
| `allowed_hosts`                    | 保留 MCP 实际公网/内网主机名白名单；自助页面只接受 `public_url` 中的 Host           |

当前内网模板给出的地址为：

```text
自助接入页：http://10.26.15.92:8765/connect
Agent 接口：http://10.26.15.92:8765/mcp
Plane 地址：http://10.26.15.92:3300
工作区 slug：public
```

上述是部署配置，不代表服务器已经启动新版服务。若使用不同外部端口，必须同时修改 `public_url`、Compose 的 `PLANE_HTTP_PORT` 和访问地址。反向代理应原样传递 Host、Origin、Authorization 和 `/connect`、`/mcp` 路径；无需给自助页面开放 CORS。

```bash
sudo chown 10001:10001 http.local.json
sudo chmod 600 http.local.json
export PLANE_HTTP_CONFIG_FILE="$PWD/http.local.json"
export PLANE_HTTP_BIND=0.0.0.0
export PLANE_HTTP_PORT=8765
docker compose -f compose.http.yml up -d --build
docker compose -f compose.http.yml ps
curl --noproxy '*' http://127.0.0.1:8765/healthz
```

健康检查表示 MCP 接入服务已初始化；用户验证时才会访问 Plane API。首次自助配置不需要师兄分配个人 MCP 令牌，也不需要重启服务。修改部署策略、域名、工作区白名单等管理员设置仍需重启。

## 在本机试用

从模板复制一个新的私密配置，例如 `http-self-service.local.json`，避免覆盖已有静态 Demo 配置。修改：

```json
{
  "host": "127.0.0.1",
  "port": 8765,
  "state_dir": "./output/self-service-state"
}
```

本地测试请使用 `http-local-self-service.example.json`：`public_url=http://localhost:8765`、`plane_base_url=http://127.0.0.1:8001`、`plane_ui_url=http://localhost:3000`，并填写本地工作区及独立的状态目录。不要在本地测试配置中沿用测试服务器的 Plane 地址。统一页显示为「行政项目接入」，底层原生协议保持兼容。

```powershell
& .\.venv\Scripts\python.exe .\http_mcp.py --config .\http-self-service.local.json
```

然后打开 `http://127.0.0.1:8765/connect`。Codex 和浏览器必须能访问同一个 `public_url`；`127.0.0.1` 对应各自运行的机器，服务器部署不能照搬本机地址。

## 权限、存储与撤销

- 用户验证调用 Plane `/api/v1/users/me/`；生成连接前再次验证身份及所选工作区的项目读取权限。不会创建 Plane 账号、Plane API Token 或业务数据。
- Plane 个人令牌使用 Fernet 加密保存在 `<state_dir>/self-service/credentials.sqlite3`。MCP 令牌与页面会话令牌仅保存 SHA-256 散列。
- 加密密钥为同目录 `encryption.key`。备份和恢复时必须保留数据库与密钥；已有数据库但密钥丢失时拒绝启动，不重新生成密钥覆盖已有凭据。生产部署应限制整个数据卷访问；掌握数据库和密钥的服务器管理员仍能读取凭据。
- POSIX 新建目录/文件使用 0700/0600。Windows 部署应另外限制该数据目录的 NTFS 权限，仅服务账号可访问。
- 页面验证会话 30 分钟后失效；Cookie 使用 HttpOnly、SameSite=Strict，在 HTTPS 下使用 Secure。所有写操作校验固定 Origin 和 CSRF 值；验证和发放令牌有限流和数量上限。
- 新 MCP 令牌立即生效。每个 MCP HTTP 请求都会查验过期/撤销状态，撤销后新请求返回 401。已经在执行的调用可能完成，撤销不等于回滚已提交的评论。
- 撤销连接会清除其保存的加密 Plane 凭据；过期凭据定期清除。退出自助页面只结束页面会话，不撤销 Agent 连接。
- Plane 账号、个人令牌或项目权限变化仍由 Plane API 在真实工具调用时检查；不能绕过 Plane 权限。Plane 个人令牌失效时，用新的个人令牌重新绑定。
- 同一账号、工作区、Plane 个人令牌和权限组合的多个 MCP 连接共享自己的草稿范围，便于换新 MCP 令牌后核对待发布草稿；不同账号、工作区或不同 Plane 个人令牌隔离。不要在写入结果不确定时更换 Plane 个人令牌或权限来重新发起同一条评论。

生成的配置文件含 MCP 令牌，应放在个人目录，不提交 Git、不分享。`*.local.json`、`*.private.json`、`*.private.toml`、SQLite 数据库、密钥及本机 `output/` 均已在 Demo 目录排除。

## 验证

```powershell
& .\.venv\Scripts\python.exe -m unittest discover -s tests -p 'test_*.py' -q
```

自动测试包括：旧 STDIO/静态 HTTP 回归；令牌加密与持久化；Codex TOML 和 ScienceDiscovery JSON；固定 Plane origin 和重定向拒绝；页面来源/CSRF/请求体限制；自助发放后的真实 HTTP MCP 调用；用户隔离；令牌续建与草稿核对；即时撤销、过期、数量与运行环境上限。业务写入测试使用假 Plane 上游，不重复向真实服务器发布测试评论。

官方客户端配置依据：[Codex MCP](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)。

2026-10-14 本地验证：121 项自动测试通过；浏览器验证个人令牌绑定、配置生成、Codex TOML 下载及撤销；已安装的 Codex CLI 能识别导出的 HTTP 配置（测试仅使用临时配置覆盖，不修改个人 Codex 设置）。另通过真实服务器完成“自助绑定 → 导出 Codex 配置 → 使用其中的地址与请求头调用 HTTP MCP → 读取 TEST1-1 及评论 → 撤销后返回 401”。此次真实联调只读，测试连接已撤销，临时凭据存储和测试服务已清理；未通过 Codex 模型对话发起工具调用。本机 Docker 引擎未启动，容器配置已校验，镜像构建尚未验证。
