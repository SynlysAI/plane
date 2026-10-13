# ScienceDiscovery × Plane MCP Demo

远程接入：新增独立 [Streamable HTTP 服务](HTTP_MCP.md)，支持本机和服务器 ScienceDiscovery 访问同一服务器 MCP，包含每使用者 Bearer 认证、默认只读工具及 Docker 部署配置。原有 STDIO 入口继续可用。

新增通用 Agent 入口：按真实 Plane 任务链接读取上下文，由学生审阅后让 Codex、ScienceDiscovery 等 Agent 发布进展评论。接入配置、权限范围和测试方法见 [任务上下文与进展发布 MCP](AGENT_WORKFLOW.md)。原四任务只读 Demo 与独立评论验收继续保留。

本示例用人工构造的项目记录验证：ScienceDiscovery 通过官方 Plane MCP 读取项目和任务，模型总结进展、卡点及建议，再由独立脚本按明确指令添加一条评论并读回。模型运行使用只读代理，不能通过该 MCP 创建、修改或删除 Plane 数据。

```text
ScienceDiscovery Session → 只读 STDIO 代理 → 官方 Plane MCP 0.3.4 → Plane REST API
独立验收脚本 ──────────────────────────→ 官方 Plane MCP → 评论写入与读回
```

代码位于 `demo/sciencediscovery-mcp` 分支，基于 `develop` 的 Plane 4.27.0 源码。本示例连接已经存在的 Plane 服务，不要求为运行 Demo 升级 Plane。本机后续已部署 4.27.0，并完成升级后的连接兼容性验证，详情见文末验收记录。

## 本机现有配置

截至 2026-10-12，ScienceDiscovery 和原 Plane 后端已启动，测试工作区及数据已准备：

| 项目                    | 本机配置                                                                        |
| ----------------------- | ------------------------------------------------------------------------------- |
| Plane 宿主 API          | `http://127.0.0.1:8001`                                                         |
| ScienceDiscovery UI/API | `http://127.0.0.1:14310`                                                        |
| Plane 工作区 slug       | `science-mcp-demo`                                                              |
| Plane 项目              | `ScienceDiscovery MCP Demo`，标识符 `SDMCP`                                     |
| 任务编号                | `SDMCP-1` 到 `SDMCP-4`，实际 UUID 见清单                                        |
| 本机私密配置            | `D:\plane-main\plane-dev\.runtime\sciencediscovery-plane-mcp\config.local.json` |
| Plane API Token         | 测试账号的七天令牌，2026-10-19 到期                                             |

测试账号只加入这个演示工作区，原管理员仍为工作区 owner。Token 代表该账号的权限，不是所有 Plane 项目的通行证。配置包含 Plane Token 和 ScienceDiscovery 访问令牌，已放在 Git 忽略的 `.runtime` 中；不要在终端打印、贴到聊天或提交 Git。

任务内容是人工演示记录，不含真实实验数据：

| 任务               | 目标状态组  | 演示内容                                                       |
| ------------------ | ----------- | -------------------------------------------------------------- |
| 整理相关文献       | `completed` | 已整理三种材料的性能对比。                                     |
| 完成首轮循环测试   | `completed` | 三组样品结果存在波动；测试条件尚待核对。                       |
| 分析容量衰减原因   | `started`   | 等待核对温度、倍率、电压窗口和样品负载量是否一致，暂不能归因。 |
| 制定第二轮实验方案 | `unstarted` | 等待分析完成，再确定对照条件。                                 |

项目描述中的 `[ScienceDiscovery MCP Demo seed:v1]` 及任务描述中的 `task:<key>` 用于识别脚本归属。依赖关系写在描述中，不创建正式科研实验或研究链。模型应总结项目管理记录，不能据此给出科学结论。

## 1. 安装宿主运行环境

需要 Python 3.11、可用的 Plane API、ScienceDiscovery，以及 Docker Desktop Linux Engine（使用现有容器部署时）。在 PowerShell 中执行：

```powershell
$demoRoot = 'D:\plane-main\plane-dev\demos\sciencediscovery-plane-mcp'
Set-Location $demoRoot
python -m venv .venv
$demoPython = Join-Path $demoRoot '.venv\Scripts\python.exe'
& $demoPython -m pip install -r .\requirements.windows.lock.txt

$privateConfig = 'D:\plane-main\plane-dev\.runtime\sciencediscovery-plane-mcp\config.local.json'
$manifest = Join-Path $demoRoot 'output\demo-manifest.json'
```

`requirements.txt` 固定官方 `plane-mcp-server==0.3.4`、`plane-sdk==0.3.1`、`mcp==1.28.1`、`fastmcp==3.2.0`。`requirements.windows.lock.txt` 和 `requirements.linux.lock.txt` 保存本次 Windows 宿主与 Linux 容器实际安装的完整依赖版本，复现时优先使用对应平台的锁文件；其他平台可从 `requirements.txt` 安装。宿主环境用于 REST 建数、MCP 独立验收和 ScienceDiscovery 控制脚本；它与容器中的 MCP 环境独立。

## 2. 工作区、令牌和私密配置

使用当前本机配置时，无需再创建工作区。换到另一台机器时：

1. 登录 Plane，创建专用测试工作区，或使用已有测试工作区。浏览器工作区地址中的工作区标识就是 slug；项目名和 `SDMCP` 项目标识符都不是 slug。
2. 使用只加入演示工作区的测试账号。它需要创建演示项目和任务的权限；如只做读取，使用能访问目标项目的账号。
3. 在个人设置的 API Tokens 页面创建有期限的令牌；当前源码的页面路径为 `/settings/profile/api-tokens/`。将令牌直接填入本机私密配置，不作为命令行参数传递。
4. 在 ScienceDiscovery 的系统设置中确认模型连接可用。`SCIENCE_AGENT_AUTH_TOKEN` 用于访问本机 ScienceDiscovery 服务，与 Plane Token、模型 API Key 分别管理。模型 API Key 不需要写入此 Demo 配置。

参考 `config.example.json` 创建本机 JSON，键名与环境变量一致：

```json
{
  "PLANE_BASE_URL": "http://127.0.0.1:8001",
  "PLANE_WORKSPACE_SLUG": "science-mcp-demo",
  "PLANE_API_KEY": "REPLACE_LOCALLY",
  "SCIENCEDISCOVERY_BASE_URL": "http://127.0.0.1:14310",
  "SCIENCE_AGENT_AUTH_TOKEN": "REPLACE_LOCALLY",
  "PLANE_MCP_BASE_URL": "http://pilab-windows-api-1:8000",
  "PLANE_MCP_PYTHON": "/app/data/scientific-envs/plane-mcp-demo/.venv/bin/python",
  "PLANE_MCP_READ_ONLY_SCRIPT": "/app/data/plane-mcp-demo/read_only_mcp.py"
}
```

非空的同名环境变量覆盖 JSON。可选 `SCIENCEDISCOVERY_MODEL_ID` 指定已在 ScienceDiscovery 注册的模型 ID；省略则采用服务的默认模型。

`PLANE_BASE_URL` 是宿主脚本访问的 API **origin**，不能带 `/api/v1`；`PLANE_MCP_BASE_URL` 是 ScienceDiscovery 后端容器访问的 origin。容器中的 `127.0.0.1` 指向容器自身，因此不能直接照抄宿主地址。示例中的容器 DNS 应与现场 Plane API 容器及网络一致。

## 3. 检查或准备演示数据

```powershell
& $demoPython .\seed_demo.py check --config $privateConfig --output $manifest
```

`check` 只读取 Plane；它会验证项目归属、任务描述及状态，并写入本地脱敏清单。首次没有数据时会明确失败，此时执行：

```powershell
& $demoPython .\seed_demo.py seed --config $privateConfig --output $manifest
& $demoPython .\seed_demo.py check --config $privateConfig --output $manifest
```

`seed` 创建或复用专用项目及四条任务，通过真实 states 的 `group` 解析状态 ID，不假定本机状态名称。它读取完整游标分页；缺失状态组、重复资源、同名但无归属标记的项目/任务、已变化的任务内容都会使脚本停止，不覆盖业务数据。`--project-id <UUID>` 可以指定现有项目，但仍要求正确归属标记。

默认清单为 `output/demo-manifest.json`，包含项目/任务 UUID、状态组、编号及时间，不含 Token。每次 POST 前持久化 `pending_write`：写入超时或异常后，再次执行先读取并按标记恢复；若仍找不到对应资源，会停止，避免盲目重复创建。先在 Plane 核实结果，再处理本地日志。不要并发运行 seed，也不要通过删除清单来绕过不确定写入保护。异常退出遗留 `.lock` 时，确认旧进程已结束后再手工移除。

## 4. 为 ScienceDiscovery 容器准备 MCP 环境

STDIO 子进程运行在 ScienceDiscovery 后端容器内，宿主 `.venv` 不能直接供它使用。本机将 venv 放在 Linux 持久卷的专用目录 `/app/data/scientific-envs/plane-mcp-demo/.venv`；代理脚本和依赖锁仍保存在 `/app/data/plane-mcp-demo/`。

此前把大量 Python 依赖放在 Windows bind mount 的 `/app/data/plane-mcp-demo/.venv`，MCP 导入启动超过 60 秒而导致连接测试超时。使用 Linux 卷避免该文件访问瓶颈，独立目录也不覆盖原科学环境。当前本机已有 `pilab-sciencediscovery-scientific-envs` named volume；其他部署先确认 `/app/data/scientific-envs` 实际挂载 Linux volume，再使用此安装路径。

以下命令适用于当前本机 Compose 项目：

```powershell
$dockerExe = 'D:\Applications\DockerDesktop\resources\bin\docker.exe'
$scienceContainer = & $dockerExe ps -q `
  --filter 'label=com.docker.compose.project=pilab-sciencediscovery' `
  --filter 'label=com.docker.compose.service=sciencediscovery'
if (-not $scienceContainer) { throw 'ScienceDiscovery container is not running.' }

& $dockerExe inspect --format '{{range .Mounts}}{{if eq .Destination "/app/data/scientific-envs"}}{{.Type}} {{.Name}}{{end}}{{end}}' $scienceContainer
# 本机预期输出：volume pilab-sciencediscovery-scientific-envs
& $dockerExe exec $scienceContainer mkdir -p /app/data/plane-mcp-demo /app/data/scientific-envs/plane-mcp-demo
& $dockerExe cp (Join-Path $demoRoot 'requirements.linux.lock.txt') "${scienceContainer}:/app/data/plane-mcp-demo/requirements.linux.lock.txt"
& $dockerExe cp (Join-Path $demoRoot 'read_only_mcp.py') "${scienceContainer}:/app/data/plane-mcp-demo/read_only_mcp.py"
& $dockerExe exec $scienceContainer /opt/sciencediscovery/envs/gateway/bin/python `
  -m venv /app/data/scientific-envs/plane-mcp-demo/.venv
& $dockerExe exec $scienceContainer /app/data/scientific-envs/plane-mcp-demo/.venv/bin/python `
  -m pip install -r /app/data/plane-mcp-demo/requirements.linux.lock.txt
```

这里使用 gateway 环境的 Python 创建 venv：当前镜像的系统 Python 缺少 `ensurepip`，直接运行系统 `python -m venv` 会失败。不要把 MCP 依赖混装到 ScienceDiscovery 自身运行环境。

如果依赖安装因继承的代理设置失败，并且已经验证容器直连包源可用，可仅对这一条安装命令清空代理环境变量；它不修改全局代理或服务配置：

```powershell
& $dockerExe exec -e HTTP_PROXY= -e HTTPS_PROXY= -e ALL_PROXY= $scienceContainer `
  /app/data/scientific-envs/plane-mcp-demo/.venv/bin/python `
  -m pip install -r /app/data/plane-mcp-demo/requirements.linux.lock.txt
```

`compose.demo.override.yml` 让 ScienceDiscovery 加入现有 Plane 网络，默认网络为 `pilab_windows_local`，可以用 `PLANE_DEMO_NETWORK` 指定。它不包含 Plane 升级操作。保持现有 ScienceDiscovery Compose 项目、数据目录和其他 overrides：

```powershell
$scienceRoot = 'D:\plane-main\sciencediscovery'
$composeArgs = @(
  'compose', '--project-name', 'pilab-sciencediscovery',
  '--project-directory', $scienceRoot,
  '--env-file', (Join-Path $scienceRoot '.env'),
  '-f', (Join-Path $scienceRoot 'docker-compose.yml'),
  '-f', (Join-Path $scienceRoot '.local\compose.windows.yml')
)
if (Test-Path (Join-Path $scienceRoot '.local\clash-proxy.enabled')) {
  $composeArgs += @('-f', (Join-Path $scienceRoot '.local\compose.clash.yml'))
}
$composeArgs += @('-f', (Join-Path $demoRoot 'compose.demo.override.yml'))
& $dockerExe @composeArgs up -d --no-build sciencediscovery
```

这一步可能重建 ScienceDiscovery 容器，请先结束正在进行的模型任务。后续启动 Demo 时也带上该 override；若普通启动脚本没有加载它，共享网络可能丢失。应用数据保留在原 `/app/data` bind mount，独立 MCP venv 保留在 `/app/data/scientific-envs` 的 Linux named volume；复现时保持这两处原有挂载。

## 5. 官方 MCP 独立验收

`verify_mcp.py` 由宿主 venv 启动真正的官方 STDIO Server，默认只做读取验证；`--read-only-proxy` 切换为本示例的强制只读代理。它发现真实工具 Schema，并读取项目、分页任务、状态及目标任务评论，验证结果写入脱敏证据。

```powershell
& $demoPython .\verify_mcp.py --config $privateConfig --manifest $manifest `
  --output .\output\mcp-verification.json
& $demoPython .\verify_mcp.py --config $privateConfig --manifest $manifest `
  --read-only-proxy --output .\output\mcp-read-only-verification.json
```

只读代理暴露四个官方资源工具：`project`、`workitem`、`workitem_comment`、`state`，仅允许经 Schema 校验的 `list` / `retrieve` 动作；另有本地 `plane_demo_read_only_policy` 工具，共五个工具。写动作、未知工具和额外字段在转发前拒绝。官方 Server 仍负责 Plane 认证和 REST 访问；这里没有自己重写官方 MCP。

这层限制针对演示 Session 的 Plane MCP。它不替代 Plane 账号权限；应继续使用专用测试账号。不要给演示 Session 启用其他能够绕过此代理访问 Plane 的连接器。

## 6. ScienceDiscovery 注册、Inspector 和模型读取

下面的全局参数必须放在子命令前。各脚本默认清单已统一为 `output/demo-manifest.json`；仍建议显式指定 `--manifest`，确保使用本次建数得到的资源清单。

```powershell
& $demoPython .\sciencediscovery_demo.py --config $privateConfig --manifest $manifest register
& $demoPython .\sciencediscovery_demo.py --config $privateConfig --manifest $manifest verify
& $demoPython .\sciencediscovery_demo.py --config $privateConfig --manifest $manifest `
  run-read --wait-seconds 300 --poll-seconds 2
```

`register` 注册或复用专用只读 MCP，测试连接并全局启用，同时创建专用 ScienceDiscovery 项目及 Inspector Session，显式启用该连接器。凭据发送到本机服务，由 ScienceDiscovery 自身的秘密存储机制处理；注册结果仅保存资源 ID。注册脚本通过 `/api/mcp/proxy-policies` 将这台 Demo MCP 设为 `none`（内网直连），保留其他服务器的策略。ScienceDiscovery 会忽略 MCP 配置中的代理环境变量，不能只靠设置 `NO_PROXY` 绕过它的专用代理策略。

也可参考 `sciencediscovery-mcp.example.json` 在系统设置中手动导入；需替换本机占位值，设置此服务器内网直连，测试后全局启用，并在演示 Session 中选择对应连接器。自动脚本已完成这些配置时无需再次导入。

`verify` 经 ScienceDiscovery 的真实 MCP Inspector 逐一读取清单中的项目和任务 UUID，保存 invocation ID 和状态信息。`run-read` 创建新的演示 Session，仅启用此只读连接器及选定模型，并要求模型实际读取项目和四条任务再总结。它保存模型调用证据，只有任务完成、正文存在且真实读取覆盖清单时才成功。该演示 Session 的自动批准仅服务于经校验的只读代理，不修改现有用户 Session。

如需区分“Inspector 连通”和“模型主动调用工具”两个问题，可以运行：

```powershell
& $demoPython .\sciencediscovery_demo.py --config $privateConfig --manifest $manifest `
  run-snapshot --wait-seconds 300 --poll-seconds 2
```

`run-snapshot` 先从真实 Inspector 获取快照，再创建禁用全部连接器的模型 Session 分析快照。它能验证模型理解，但不能替代 `run-read` 的模型工具调用验收。

## 7. 明确添加一条评论并读回

`run-read` 不向 Plane 写评论。检查 `output/run-read.json` 中的 `report`，确认建议符合演示记录后，显式执行独立评论模式。脚本仅接受 `ok=true`、`mcp_verified=true` 的 JSON 证据并提取其 `report` 字段：

```powershell
& $demoPython .\verify_mcp.py --config $privateConfig --manifest $manifest `
  --write-comment --comment-file .\output\run-read.json `
  --output .\output\comment-verification.json
```

这一命令直连官方 MCP，在“分析容量衰减原因”任务上执行评论去重、写入和读回。也可通过 `--comment-file .\output\comment.txt` 提供人工审阅后的 UTF-8 纯文本，正文限制为 1–30000 字符。

评论带 `[ScienceDiscovery MCP Demo]` 标记；已有一条带标记评论时复用，不覆盖原内容；多条带标记评论时停止。第一次写入验证返回 ID 及读回内容一致，写入前保存 `output/comment-journal.json`，遇到超时先读取核实，不盲目重试。不要同时使用 `--read-only-proxy` 和评论写入选项。独立 MCP 验收默认总超时 180 秒，可通过 `--timeout` 调整。

## 8. 证据、测试及排查

| 产物                               | 用途                                                    |
| ---------------------------------- | ------------------------------------------------------- |
| `output/demo-manifest.json`        | Plane 演示资源及建数恢复日志                            |
| `output/mcp-verification.json`     | 官方 MCP 读取验收                                       |
| `output/sciencediscovery.json`     | 专用 MCP / ScienceDiscovery 项目 / Inspector Session ID |
| `output/verification.json`         | ScienceDiscovery Inspector 调用证据                     |
| `output/run-read.json`             | 模型回复、运行状态及实际 MCP 调用覆盖                   |
| `output/run-snapshot.json`         | 快照分析证据，可选                                      |
| `output/comment-verification.json` | 评论去重、写入及读回证据                                |
| `output/comment-journal.json`      | 评论写入前日志及恢复检查依据                            |

控制台仅输出结果摘要和脱敏错误；MCP STDIO 的 stdout 用于协议消息。`output/`、`.venv/`、`*.local.json` 和 `.env` 已在本目录忽略，仓库根 `.runtime/` 也忽略。证据虽不保存密钥，仍含本机资源 UUID 和模型正文，分享前按内容审阅；不要分享原始请求头或原始服务日志。

运行全部离线单元测试：

```powershell
& $demoPython -m unittest discover -s .\tests -p 'test_*.py' -v
```

常见问题：

- **Plane 401/403**：检查令牌是否到期、账号是否加入目标工作区和项目，更新私密配置后重跑。当前本机令牌 2026-10-19 到期。
- **宿主读取成功，ScienceDiscovery MCP 失败**：检查容器共享网络、`PLANE_MCP_BASE_URL` 的 DNS 和端口；不要使用容器自身的 `127.0.0.1:8001`。
- **`register` 连接失败或启动超时**：先确认 `PLANE_MCP_PYTHON` 指向 Linux 卷中的 `/app/data/scientific-envs/plane-mcp-demo/.venv/bin/python`，容器内依赖及 `read_only_mcp.py` 已准备，再核对网络；Windows bind mount 中的旧 venv 可能导入过慢，不能把包安装耗时算作连接测试。
- **MCP Inspector 成功但 `run-read` 失败**：检查模型配置、ScienceDiscovery Session 和 `output/run-read.json`；缺少真实读取覆盖时，不把模型输出当成全链成功。
- **建数出现不确定写入或归属冲突**：保留 manifest，在 Plane 核实已有资源；脚本不会自动覆盖、删除或重建冲突资源。
- **PQL 不兼容**：本示例使用基础列表和 UUID 详情，不要求 PQL。官方统一工具的参数名以本次发现的 Schema 为准。

## 本机真实验收结果

2026-10-12 本机真实验收通过：

- 在独立工作区 `science-mcp-demo` 创建项目 `SDMCP` 和四条演示任务；状态为已完成 2 条、进行中 1 条、未开始 1 条。
- 官方 `plane-mcp-server==0.3.4` 的项目、状态、工作项和评论读取通过；每页限制 2 条，工作项跨 2 页、状态跨 3 页，验证了分页完整性。
- ScienceDiscovery 的 MCP Inspector 验收通过。配置使用 Linux 卷中的 Python 环境，并将专用 Demo MCP 设为内网直连；重复注册复用原资源。
- ScienceDiscovery 使用已配置的 `deepseek-flash` 模型，实际完成 7 次 MCP 调用：只读策略、项目详情、状态列表及四条工作项详情。运行 `790653f3-2638-4856-bac0-f56f097cba09` 状态为 `completed`，`mcp_verified=true`，读取阶段没有向 Plane 写入。
- 模型报告见 `output/analysis-report.md`。审阅后的五条建议保存为 `output/comment.txt`，由独立官方 MCP 写入脚本添加到 SDMCP-3 并读回一致；评论 ID 为 `fc300230-aa46-4372-b10f-119bef439307`。重复执行返回同一 ID、`reused=true`、`plane_writes=false`，评论总数仍为 1。
- 全部 79 项离线单元测试通过；Windows 与 Linux Demo 环境的 `pip check` 通过。

本次链路为“ScienceDiscovery 模型只读分析 → 审阅建议 → 独立官方 MCP 脚本写入一条评论”，模型 Session 自身不具备 Plane 写权限。证据保存在本机忽略目录 `output/`，包括 `run-read.json`、`comment-verification.json` 和 `comment-reuse.json`。

开发分支为 `demo/sciencediscovery-mcp`，基于 `origin/develop` 的 `577b97f9b09beeba86f18335ed7aec609fb32358`（源代码版本 4.27.0）。首次模型联调使用原有 Plane 部署（挂载的源代码版本 4.22.0）及 ScienceDiscovery `ab1403f` 镜像。

后续按用户要求，已于 2026-10-12 将本机 Plane 切换到 4.27.0，保留原有账号、工作区、任务和评论。升级后官方 MCP 读取和 ScienceDiscovery Inspector 读取再次通过，未新增评论；本次没有重复运行模型。部署及验证记录见 [Windows 部署验收](../../deployments/windows/verification-2026-10-12.md)。代码与部署记录通过独立分支提交审查，验收不涉及团队部署环境。

## 代码与依据

- `plane_client.py` / `seed_demo.py`：标准库 REST 读取、幂等建数及恢复。
- `read_only_mcp.py`：转发官方 STDIO Server 的只读代理。
- `verify_mcp.py`：真实 MCP 独立验收及显式评论模式。
- `sciencediscovery_demo.py`：ScienceDiscovery 注册、Inspector、模型运行与证据核验。
- [官方 Plane MCP](https://github.com/makeplane/plane-mcp-server)。
- 本分支 `apps/api/plane/api/urls/{project,state,work_item}.py` 及对应 serializers：已核对 `/api/v1` 路由、`X-Api-Key`、项目描述、工作项 `description_html` / `state` 和游标分页。

停止演示时可停用专用 MCP；测试项目和数据保留供复现。本示例不自动删除业务数据。
