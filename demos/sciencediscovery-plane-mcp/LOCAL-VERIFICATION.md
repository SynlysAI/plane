# 科研链 MCP v1 本地验证方案

适用代码：`D:\plane-main\plane-dev`。本文保留 v1 本地验证步骤，可用于后续复验；实际已完成结果见 [验收摘要](../../docs/operations/research-mcp-v21-acceptance.md)，不要将方案条目本身当成通过证据。服务器部署及 v2.1 写入步骤见 [部署说明](../../docs/operations/research-mcp-v21-deployment.md)。

目标是分别证明：二开的科研数据确实可读、权限范围没有扩大、真实 Agent 确实使用 MCP 读取了证据。只发现十个工具或只看到模型回答，都不足以完成验收。

## 1. 准备一组可人工核对的科研数据

在本地测试工作区通过现有页面准备以下数据，不使用生产工作区：

| 对象           | 建议内容                                    | 用途                                     |
| -------------- | ------------------------------------------- | ---------------------------------------- |
| 科研链         | 电池循环稳定性研究                          | 核对链列表、标题和节点                   |
| 节点 A         | 首轮实验分析                                | 本次主要读取对象                         |
| 节点 B         | 第二轮实验设计                              | 同链其他节点，验证节点授权隔离           |
| A 的科研任务   | 核对三组样品的温度和倍率                    | 确认读取科研任务，而非原生 Issue         |
| 任务评论       | LOCAL-MCP-A17：温度未统一，暂不判断衰减原因 | 留一个模型无法凭空猜中的验收标记         |
| A 的分析记录   | 包含结论、依据和待验证项                    | 正文读取                                 |
| A 的事件、快照 | 至少各两条，内容可以逐条核对                | 分页及历史溯源                           |
| A 的上传文件   | 任意本地演示 PDF                            | 验证只能读元数据，不会声称读过 PDF 正文  |
| 正式报告、实验 | 经节点事件、快照或任务明确引用              | 验证引用关联和版本读取；仅放在同项目不够 |
| 未关联的实验   | 同项目下另建一条，不引用到 A                | 验证关联边界                             |
| 账号甲、乙     | 甲可访问 A；乙不能访问所在私有课题          | 验证对象权限                             |

不必一次准备全部资源。最小业务闭环是：链 → 节点 → 科研任务 → 带标记的评论。报告、长正文和权限边界作为第二轮验收。

原 Demo 中 `SDMCP-1` 到 `SDMCP-4` 是原生 Plane 任务，不能用它们证明科研链、科研任务和科研评论已接通。原 Demo 令牌也可能已过期，请使用当前有效令牌。

## 2. 让本地 API 加载本次代码和开关

确认服务运行的是 `plane-dev/apps/api`，不要连接旧的 `plane-main` 快照。在 **API 实际加载的环境文件** 中设置：

```dotenv
RESEARCH_MODULE_ENABLED=1
RESEARCH_MCP_ENABLED=1
RESEARCH_MCP_PUBLIC_BASE_URL=http://host.docker.internal:8001
```

这里的 PUBLIC_BASE_URL 仅是“SD 在 Docker、Plane API 经宿主机 8001 端口访问”的示例。独立个人客户端只读接口不依赖该变量；Plane 内嵌 ScienceDiscovery 自动接入需要它。

| ScienceDiscovery 的运行位置        | 可选的 Plane API origin 示例        |
| ---------------------------------- | ----------------------------------- |
| 与 API 都是宿主机进程              | `http://127.0.0.1:8001`             |
| SD 在 Docker，API 通过宿主端口访问 | `http://host.docker.internal:8001`  |
| 两者在同一个 Docker 网络           | `http://api:8000`，以实际服务名为准 |

origin 不带 `/api`、用户名、密码、查询参数。必须从 **SD 服务端所在环境** 可达；浏览器能访问不代表 SD 能回连。Plane 访问个人 SD 后端是反方向链路，也要满足现有连接检查和允许网段配置。

工作区需开启科研模块、科研链。内嵌模式还需开启 Agent 和个人 ScienceDiscovery 后端，并完成该用户的 SD 连接配置。

已有本地 Compose 部署读取 `apps/api/.env`。若当前就是这个部署且镜像、依赖已准备好，可由你手动执行下列命令重新加载 API 环境：

```powershell
Set-Location D:\plane-main\plane-dev
docker compose -f docker-compose-local.yml -f docker-compose-local.override.yml up -d --no-build --no-deps --force-recreate api
```

这不是首次部署命令；它依赖已经存在的本地镜像及运行中的数据库等服务。修改环境变量后仅 `restart` 不会更新容器环境，需要重新创建容器。源码在该 Compose 中通过目录挂载加载；其他部署方式按实际代码加载方式更新。后续五类资源补验新增了历史任务关联约束修复迁移 `0181_fix_research_task_resource_constraints`，部署当前代码需先备份并在 API 环境执行 `python manage.py migrate`；本地验收环境已应用。

下文 `8001` 是仓库本地 override 的端口示例，没有检查当前端口或服务状态；如果经过网页代理访问，用能正确转发 `/api/research/` 的 origin。

## 3. 第一层：直接接口验证，先排除 Agent 因素

在 PowerShell 中运行以下步骤。个人 API Key 代表对应用户的当前权限，不使用浏览器登录 Cookie。

```powershell
$planeBase = 'http://127.0.0.1:8001'
$workspaceSlug = '替换成测试工作区slug'
$secureKey = Read-Host '输入当前有效的 Plane 个人 API Key' -AsSecureString
$credential = [System.Management.Automation.PSCredential]::new('plane', $secureKey)
$headers = @{ 'X-Api-Key' = $credential.GetNetworkCredential().Password }
$accessBase = "$planeBase/api/research/workspaces/$workspaceSlug/agent-access"

function Invoke-ResearchRead {
    param([string]$Name, [hashtable]$Arguments = @{})
    $payload = ConvertTo-Json -InputObject $Arguments -Depth 30 -Compress
    Invoke-RestMethod -Method Post -Uri "$accessBase/tools/$Name/" `
        -Headers $headers -ContentType 'application/json; charset=utf-8' `
        -Body ([System.Text.Encoding]::UTF8.GetBytes($payload))
}

$catalog = Invoke-RestMethod -Method Get -Uri "$accessBase/tools/" -Headers $headers
$catalog.tools | Select-Object name
$catalog.tools.Count  # 个人 Key 预期为 10

$chains = Invoke-ResearchRead -Name 'list_research_chains' -Arguments @{ limit = 20 }
$chains.data | Format-Table id, title, node_count_in_scope
```

从返回列表中选择测试链，不要把项目 ID 当作 chain_id：

```powershell
$chainId = '替换成返回的科研链UUID'
$nodes = Invoke-ResearchRead -Name 'list_research_nodes' -Arguments @{ chain_id = $chainId; limit = 20 }
$nodes.data | Format-Table id, title, status

$nodeId = '替换成节点A的UUID'
$context = Invoke-ResearchRead -Name 'get_research_node_context' -Arguments @{ node_id = $nodeId }
$context.data | ConvertTo-Json -Depth 20

$tasks = Invoke-ResearchRead -Name 'list_research_node_tasks' -Arguments @{ node_id = $nodeId; limit = 20 }
$tasks.data | Format-Table id, title, status
$taskId = '替换成刚才的科研任务UUID'
$comments = Invoke-ResearchRead -Name 'list_research_task_comments' -Arguments @{ task_id = $taskId; limit = 20 }
$comments.data | Format-Table id, text

$analyses = Invoke-ResearchRead -Name 'list_research_node_resources' -Arguments @{ node_id = $nodeId; kind = 'analysis'; limit = 20 }
$analyses.data | Format-Table id, title, content_state
```

通过标准：链、节点、任务与页面一致，评论中出现 `LOCAL-MCP-A17`。节点 context 里的 evidence sections 是样本，`sample_only=true`，不能将其条数视为全部历史。`list_research_node_resources` 必须提供 kind；用 `snapshot`、`report`、`experiment`、`upload` 等分别读取资源列表。

### 分页和正文

先用至少两条事件验证续页；下例保留相同 node_id、limit 和筛选条件：

```powershell
$eventArgs = @{ node_id = $nodeId; limit = 1 }
$eventIds = @()
do {
    $eventPage = Invoke-ResearchRead -Name 'list_research_node_events' -Arguments $eventArgs
    $eventIds += @($eventPage.data | ForEach-Object { $_.id })
    if ($eventPage.page.has_more) { $eventArgs['cursor'] = $eventPage.page.next_cursor }
} while ($eventPage.page.has_more)
$eventIds
```

通过标准：最终到达 `has_more=false`，没有重复或遗漏。即使某页 data 为空，只要 has_more=true 也要续页。游标不能跨节点、用户或查询复用，续页时不能改变 limit。

读取一个真实存在的分析正文。为制造分段，可以在 UI 准备较长的分析内容，并使用较小的 max_chars：

```powershell
$resourceId = '替换成analyses.data中某个分析记录UUID'
$bodyArgs = @{ node_id = $nodeId; kind = 'analysis'; resource_id = $resourceId; max_chars = 256 }
$textParts = [System.Collections.Generic.List[string]]::new()
do {
    $part = Invoke-ResearchRead -Name 'read_research_resource' -Arguments $bodyArgs
    $textParts.Add($part.data.text)
    if ($part.page.has_more) { $bodyArgs['cursor'] = $part.page.next_cursor }
} while ($part.page.has_more)
$fullBody = ($textParts -join '') | ConvertFrom-Json
$fullBody | ConvertTo-Json -Depth 30
```

通过标准：拼接后内容与页面一致。返回格式是 `json_text`，不要对每一段单独 ConvertFrom-Json。正式报告使用 `kind='report'`、报告列表中的 id，并在参数中显式加入其整数 version；实验不传 version 时返回 current 状态。

上传文件预期 `content_state=metadata_only`；尝试读取其正文得到 `unsupported_content`（REST 422），这是本版的预期边界。

## 4. 第二层：验证 MCP 协议入口

沿用上节变量，直接请求新增后端 MCP，先确认初始化、工具发现和真实读取均可用：

```powershell
function Invoke-ResearchMcp {
    param([int]$Id, [string]$Method, [hashtable]$Params = @{})
    $payload = @{ jsonrpc = '2.0'; id = $Id; method = $Method; params = $Params } |
        ConvertTo-Json -Depth 30 -Compress
    Invoke-RestMethod -Method Post -Uri "$accessBase/mcp/" `
        -Headers $headers -ContentType 'application/json; charset=utf-8' `
        -Body ([System.Text.Encoding]::UTF8.GetBytes($payload))
}

$init = Invoke-ResearchMcp -Id 1 -Method 'initialize' -Params @{
    protocolVersion = '2025-03-26'; capabilities = @{}
    clientInfo = @{ name = 'local-research-check'; version = '1.0' }
}
$init.result.serverInfo
$toolList = Invoke-ResearchMcp -Id 2 -Method 'tools/list'
$toolList.result.tools.Count
$call = Invoke-ResearchMcp -Id 3 -Method 'tools/call' -Params @{
    name = 'get_research_node_context'; arguments = @{ node_id = $nodeId }
}
$call.result.isError
$call.result.structuredContent | ConvertTo-Json -Depth 20
```

通过标准：serverInfo.name 为 `plane-research-read-only`；发现十个只读工具；isError 为 false，内容与 REST 相同。遇到 HTTP 200 仍需检查顶层 error 与 result.isError，不能只看状态码。此入口不提供 GET/SSE 流、写工具或 prompts，不以这些能力作为通过条件。

## 5. 第三层：真实 Agent 的业务验收

### 5.1 独立客户端接入

在 ScienceDiscovery 的自定义 MCP 连接中选择 HTTP，填写完整 URL：

```text
http://<SD可访问的Plane地址>/api/research/workspaces/<slug>/agent-access/mcp/
```

Header 使用 `X-Api-Key: <当前测试用户的Plane个人Key>`。连接检测后，应发现十个工具；还要在实际会话中启用这个 connector。该模式按个人 Key 的可见范围读取，不限定到单个节点。

如果客户端只支持 STDIO，可以使用以下已有入口；私密配置包含 `PLANE_BASE_URL`、`PLANE_WORKSPACE_SLUG`、`PLANE_API_KEY`：

```powershell
Set-Location D:\plane-main\plane-dev\demos\sciencediscovery-plane-mcp
& .\.venv\Scripts\python.exe .\research_mcp.py --config C:\private\plane-config.json
```

STDIO 是供 MCP 客户端启动的进程，手工运行后等待输入不代表失败。不要把 STDIO 日志当作最终验收。

三种认证不要混用：直连 Plane 后端用 X-Api-Key；已有独立 HTTP facade 用其客户端 Bearer；Plane 内嵌模式自动签发 Context Token 和 Hash。

### 5.2 Plane 内嵌节点会话

1. 完成第 2 节配置及用户 SD 连接检查，然后在节点 A **新建** Agent 会话，选择 ScienceDiscovery。已有会话不会自动升级。
2. 后端应创建该 grant 专用的 SD connector，发现十个工具，再把 source_id 加入新会话；创建失败不能视为接入成功。
3. 在可查看的会话详情/服务端记录中核对 `assembly.research_mcp` 的 context_id、server_id/source_id、expires_at，不复制或打印原始授权 header。两个节点会话应使用不同 server_id。
4. 确认会话实际使用 ScienceDiscovery。落到 Synlora 不能证明这条自动绑定链路通过；本版没有实现 Synlora 自动绑定。

向 Agent 提问时不粘贴评论或分析正文，可使用以下验收问题：

> 读取当前科研节点，列出未完成的科研任务、讨论中提出的实验条件问题和已有分析结论。为每项依据标注任务、评论或分析记录的 ID；没有读取到的证据请明确说明。

通过标准：工具执行记录中真实出现科研 MCP 调用；回答能复述 `LOCAL-MCP-A17` 对应的温度问题并引用正确记录，不将“温度未统一”推断成已确定的衰减机理。

再问：

> 列出当前节点的上传文件，说明你能读到哪些内容。只有元数据时不要总结文件正文。

通过标准：能列出测试文件，同时说明未解析正文。再用有正式报告引用的节点提问，核对回答中的报告 ID 和 version。

## 6. 权限和生命周期验收

| 验收项       | 操作                                               | 预期                                     |
| ------------ | -------------------------------------------------- | ---------------------------------------- |
| 无凭据       | 不带任何机器认证请求 tools/，即使浏览器已登录      | 拒绝读取，401/403；不能靠 Cookie 通过    |
| 私有课题     | 使用账号乙的 Key 请求甲的私有节点                  | 不泄露节点或正文，403/404                |
| 节点范围     | 使用 A 的内嵌会话授权请求 B 的 context/任务/资源   | 拒绝读取；链内节点列表也不能列出 B       |
| 关联范围     | 用 A 请求同项目但没有关联到 A 的实验               | 拒绝读取，不因同项目即可访问             |
| 无效 Context | 同时带有效个人 Key 和无效 Context Token            | 拒绝读取，不回退个人 Key                 |
| 参数边界     | limit=51、缺少必填项或添加未知参数                 | invalid_arguments；MCP 返回 isError=true |
| 写入边界     | 调用不存在的创建、更新、删除科研工具               | 拒绝调用，业务数据不变化                 |
| 跨节点游标   | 将 A 的分页 cursor 用于 B                          | 拒绝，而非返回 B 的续页                  |
| 正文变化     | 读取长正文首段，在 UI 修改内容，再用旧 cursor 续读 | version_changed；REST 409，MCP 工具错误  |
| 关闭会话     | 关闭 A 的 Plane 会话，再使用原 grant 请求          | 立即拒绝；SD connector 正常情况下被删除  |
| 授权到期     | 保持会话超过默认 600 秒，再请求原 grant            | 拒绝；新建会话获得新的有效授权           |

节点范围验收必须使用 A 的 **内嵌 grant**。个人 owner Key 本来可能可读 A、B，不能据此判定隔离失效。仅让模型回答“我不能读取 B”也不够，应核对实际工具拒绝记录；如果模型没有尝试，使用下一节对应契约测试验证。

人工重放 grant 请求时需同时使用对应的 X-Research-Context-Token 与 X-Research-Context-Hash，并保持凭据只在本地内存中；不要把带 header 的抓包或日志提交到仓库。授权默认 600 秒，尽量在有效期内完成正向操作。到期应新建会话，本版没有自动续期。

## 7. 已写测试的手动执行方案

### 独立代理测试：不依赖 Plane、数据库或 SD

使用已有 Demo Python 环境；如果不存在，先按 README 安装对应锁文件中的依赖。该组使用模拟后端，验证代理白名单、参数校验、Schema 隔离和错误处理，不证明真实服务已接通。

```powershell
Set-Location D:\plane-main\plane-dev
& .\demos\sciencediscovery-plane-mcp\.venv\Scripts\python.exe -B -m unittest discover -s demos/sciencediscovery-plane-mcp/tests -p test_research_mcp.py -v
```

### 后端单元、契约测试：只在独立测试数据库与缓存上运行

仓库禁止自主运行 `docker-compose-test.yml` 测试栈，此处不使用该栈。以下方案供你在已经准备好的独立测试环境手动执行。

**隔离依据：** `apps/api/plane/tests/conftest.py` 的 autouse fixture 会在每个测试前后执行 `cache.clear()`；`plane.settings.test` 本身不隔离数据库和 Redis。不要连接现有开发/共享/生产 Redis。使用独立测试 Redis 实例；数据库使用专门的测试连接，用户应有创建 pytest 测试库的权限。Demo Python 环境不能代替装好 Django 后端依赖的 Python 环境。

在单独 PowerShell 窗口中，先按 API 环境要求准备其他非敏感配置，再覆盖数据库和缓存连接：

```powershell
Set-Location D:\plane-main\plane-dev\apps\api
$backendPython = '替换为已安装后端及requirements/test.txt依赖的python.exe绝对路径'
$env:DJANGO_SETTINGS_MODULE = 'plane.settings.test'
$env:RESEARCH_MODULE_ENABLED = '1'
$env:RESEARCH_MCP_ENABLED = '1'
$env:ENABLE_READ_REPLICA = '0'
# 输入专用测试库URL，不使用日常开发库或生产库。
$secureDbUrl = Read-Host '输入专用测试PostgreSQL URL' -AsSecureString
$dbCredential = [System.Management.Automation.PSCredential]::new('test-db', $secureDbUrl)
$env:DATABASE_URL = $dbCredential.GetNetworkCredential().Password
# 示例端口：应是你另行准备的专用测试Redis，而非开发Redis。
$env:REDIS_URL = 'redis://127.0.0.1:6389/0'

& $backendPython -m pytest `
    plane/tests/unit/research/test_mcp_catalog.py `
    plane/tests/unit/research/test_sciencediscovery_research_binding.py `
    plane/tests/contract/app/test_research_machine_access.py -q
```

第三个测试文件覆盖节点 grant、无效 Context 不回退、503 条事件的完整分页、游标范围、实验关联、科研评论、正文变化和直接 MCP 入口。SD binding 单测使用模拟远端，不代替第 5 节真实 Agent 验收。仓库默认 `--nomigrations`，这组测试也不证明迁移部署过程通过。执行完关闭该专用终端，避免测试环境变量混入日常服务启动。

## 8. 常见失败定位与验收记录

| 现象                        | 优先检查                                                                        |
| --------------------------- | ------------------------------------------------------------------------------- |
| 404 / disabled              | 是否运行本次代码；API 环境开关、工作区科研模块/链开关；路径和 slug              |
| 401/403                     | Key 是否有效，用户是否有工作区/课题权限；Context Token 与 Hash 是否匹配或已过期 |
| 链列表为空                  | 测试用户能否在页面看到对应科研课题；不要用原生 Issue Demo 当科研数据            |
| MCP HTTP 200 但失败         | 顶层 error 或 result.isError，以及 content 中的 error_code                      |
| 文件正文 422                | metadata_only 是本版预期；上传文件解析不在此次范围                              |
| 续读 409                    | 正文或正式版本变化后旧游标失效，从头重读                                        |
| 429                         | 当前凭据每分钟超过 120 次请求，等窗口恢复再继续                                 |
| REST 可用，内嵌会话创建失败 | SD 连接配置；SD 能否回连 PUBLIC_BASE_URL；代理路由；连接发现错误和超时          |
| 内嵌会话没有科研工具        | 是否为启用功能后新建的 SD 会话；connector 是否成功发现并在会话启用              |
| SD 创建 connector 失败      | 除连通性外，检查最多 50 个 custom server 的配额和旧会话清理                     |

建议记录：代码版本/是否有本地改动、测试日期、服务地址、测试用户、chain_id/node_id、十个工具名、评论标记的读取结果、Agent 实际工具记录、权限拒绝结果及测试摘要。不记录任何凭据。

最终通过条件：真实科研数据与页面一致；任务评论及可读正文可追溯；分页不漏；越权被拒绝；Agent 使用实际工具生成有依据的回答；文件解析和授权到期边界被准确呈现。完成后可按需将 RESEARCH_MCP_ENABLED 改回 0 并重新加载 API 环境。
