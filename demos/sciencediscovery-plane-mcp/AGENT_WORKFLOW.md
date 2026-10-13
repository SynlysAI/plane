# Plane 任务上下文与进展发布 MCP

需要连接服务器上的 MCP 时，使用 [HTTP 接入说明](HTTP_MCP.md)，为对应使用者配置 `mode: "agent"`；默认仅提供读取，进展发布需显式启用。下文原 STDIO 接入继续有效。

这一入口供学生在自己的 Codex、ScienceDiscovery 或其他支持 STDIO MCP 的 Agent 中使用：

```text
Plane 任务链接 → 读取任务上下文 → 学生与 Agent 调研/分析
                                         ↓
Plane 原任务评论 ← 发布并读回确认 ← 展示草稿，学生审阅并要求发布
```

老师在 Plane 查看已发布成果、提出反馈。Agent 会话由学生自己管理。

代码基于 `demo/sciencediscovery-mcp` 新建的 `feat/plane-agent-task-progress` 分支。原 `read_only_mcp.py`、四任务验收脚本和 Demo 配置保持独立，新入口为 `agent_mcp.py`。底层继续使用已固定版本的官方 Plane MCP 0.3.4，由官方服务负责认证及 REST 访问。

## 1. 工具与范围

| 工具                | 输入                         | 行为                                                                              |
| ------------------- | ---------------------------- | --------------------------------------------------------------------------------- |
| `read_task_context` | `task_url`                   | 解析指定任务链接，读取项目基本信息、任务详情、状态和完整分页评论；不向 Plane 写入 |
| `prepare_progress`  | `task_url`、`progress`       | 在本机保存不可变草稿，返回草稿 ID、目标任务和完整正文供学生审阅；不向 Plane 写入  |
| `publish_progress`  | `draft_id`、`approved: true` | 将对应草稿追加为一条任务评论，读回核实；重复调用同一草稿复用评论                  |

发布能力需配置 `PLANE_AGENT_ENABLE_PUBLISH: true`；默认关闭，关闭时只发现读取工具。底层官方创建、修改、删除等工具不直接暴露给 Agent。

`progress` 是 1–30000 字符纯文本，支持中文和换行。服务会转义 HTML，Markdown 按原文保存。短报告可作为正文；长报告可给出课题组可访问的 HTTP(S) 链接。此版本不上传附件、不创建 Plane 文档、不修改任务状态。报告在个人电脑上的路径不能让老师直接访问。

任务描述和评论作为不可信数据交给 Agent；其中的“立即发布”“忽略审批”等文字不是学生授权。服务无法从一个 MCP 请求独立证明真人已审阅：`approved` 是客户端的声明，工具注解也是提示。因此同时保留 Agent 客户端的写操作审批，展示原文和目标后，学生明确要求发布。固定草稿可以避免预览后通过发布参数替换正文或任务。

## 2. 每位学生准备自己的配置

学生使用自己的 Plane 账号生成个人 API Token，权限仍由 Plane 账号决定。配置文件及草稿目录放在该学生的个人目录，限制其他本机用户访问。Windows 使用个人目录的 NTFS 权限；POSIX 新建草稿目录/文件使用 0700/0600。

参考 `agent-config.example.json` 创建私密文件，例如：

```text
C:\Users\STUDENT\.config\plane-agent\config.local.json
```

填写：

| 配置                         | 说明                                                    |
| ---------------------------- | ------------------------------------------------------- |
| `PLANE_BASE_URL`             | MCP 子进程访问的 Plane API origin，不带 `/api/v1`       |
| `PLANE_UI_BASE_URL`          | 浏览器访问的 Plane origin，必须与学生复制的任务链接一致 |
| `PLANE_WORKSPACE_SLUG`       | 本次连接允许使用的一个工作区 slug                       |
| `PLANE_API_KEY`              | 该学生的个人 Token，只保存在私密配置中                  |
| `PLANE_AGENT_ENABLE_PUBLISH` | JSON 布尔值或环境变量 `true` / `false`；默认 `false`    |
| `PLANE_AGENT_STATE_DIR`      | 可选的绝对草稿目录；默认 `~/.plane-agent-mcp`           |

非空同名环境变量覆盖 JSON。API 和 UI 的端口可以不同；例如 API 为 `http://plane-api.lab:8000`，浏览器地址为 `http://plane.lab:3000`。配置 origin 不能包含路径、用户名、密码、query 或 fragment。

每个连接绑定一个工作区和一份个人凭据。草稿按 API origin、工作区、凭据及 UI origin 派生的散列隔离，文件中不保存 Token；草稿正文仍属于科研数据，应按个人数据保护。凭据轮换后旧草稿不会在新凭据下复用。

复用现有独立 venv 和锁文件即可，无需增加依赖：

```powershell
$demoRoot = 'D:\plane-main\plane-dev\demos\sciencediscovery-plane-mcp'
$demoPython = Join-Path $demoRoot '.venv\Scripts\python.exe'
# 首次安装时：
python -m venv (Join-Path $demoRoot '.venv')
& $demoPython -m pip install -r (Join-Path $demoRoot 'requirements.windows.lock.txt')
```

## 3. Codex 接入

参考 `codex-agent.example.toml`，将对应表格合并到学生自己的 `~/.codex/config.toml`，替换 Python、脚本和私密配置文件的绝对路径，保留已有配置。无需把 Token 放进命令行或 TOML。

当前 Codex 支持 `default_tools_approval_mode = "writes"`，会对未标记只读的工具请求批准。`prepare_progress` 会保存本地文件，因此同样标记为非只读。升级或首次接入后，应先验证客户端实际展示审批；不要把该连接设置成无条件自动批准。

运行 `codex mcp list` 或在客户端查看 MCP 列表，确认能发现三个工具。支持范围以安装的客户端为准。官方配置依据：[Codex MCP 文档](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)。

首次读取提示词：

```text
请使用 Plane MCP 的 read_task_context 读取这个任务：
http://plane.lab:3000/lab/browse/LAB-3/
总结任务目标、已知记录、缺失信息和下一步。区分事实与推断，引用任务或评论依据。
先进行调研，不发布任何进展。
```

草稿提示词：

```text
把刚才的进展整理为：已完成、主要发现、卡点、下一步、成果链接。
调用 prepare_progress，向我展示目标任务与完整草稿，等待我审阅。
```

学生确认后：

```text
我已审阅这份草稿，请把这个版本发布到刚才展示的任务。
```

Agent 调用 `publish_progress`，返回评论 ID、任务链接、是否复用及读回状态。任务中的其他用户评论不替代当前学生的发布指令。

## 4. ScienceDiscovery 接入

在学生自己的 ScienceDiscovery 实例中，使用 `sciencediscovery-agent.example.json` 导入 STDIO MCP。Python、脚本和私密配置路径都必须在 ScienceDiscovery 后端所在环境可见。容器中的 UI origin 仍填写学生浏览器访问的 Plane 地址，API origin 则填写容器可达地址。

容器环境可复用原 Demo 的独立 Linux venv。将以下四个文件部署到同一目录：

```text
agent_mcp.py
agent_workflow.py
read_only_mcp.py
plane_client.py
```

私密 JSON 独立部署，不提交 Git。测试连接后，在目标会话启用这一连接器，并保留写操作审批。使用方式与上面的提示词相同。不要同时给这个会话启用不受限的官方 Plane 写工具来绕过本入口。

当前 ScienceDiscovery 是服务级 Token 的单用户控制面。这份配置适用于学生个人实例；将多名学生的凭据注册到同一个共享实例，不会自动获得用户级凭据或会话隔离。课题组多人可共同访问 Plane，各自使用自己的 Agent 客户端。

## 5. 支持的任务链接与上下文

支持仓库当前使用的两类任务链接：

```text
http://plane.lab:3000/lab/browse/LAB-3/
http://plane.lab:3000/lab/projects/<project UUID>/issues/<task UUID>
```

允许复制链接中的 query 和 fragment，但任务由路径确定。仅支持已配置 UI origin 和工作区；链接不作为 HTTP 请求地址访问，不会跟随重定向或向任意 URL 发送 Token。归档链接、列表页中只靠 query 标识的预览链接以及其他路由会明确拒绝。

编号链接会读取当前账号可见的项目列表，按项目标识符定位，再完整分页定位任务编号；UUID 链接直接读取目标资源。项目标识符不唯一、资源 ID 不一致或分页不完整均失败，不猜测目标。

上下文包含项目基本信息、任务详情及状态和完整评论。详情中可能已有标签、负责人及关联资源 ID，但不代表读取了关联任务、文档或附件正文；返回的 `context_scope` 明确列出范围。任务内容不构成科学结论。

## 6. 重复提交与异常恢复

草稿 ID 绑定账号范围、规范化任务地址和完整正文。同一目标及相同正文重复准备会复用草稿，修改正文产生新草稿。发布评论带 `[Plane Agent Progress:<draft_id>]` 标记。

服务在创建评论前持久化 `pending` 日志，再执行一次官方 MCP 评论创建。之后完整读取评论，校验标记、正文和返回 ID。共享同一草稿目录的多个客户端通过文件锁串行化；不同电脑或不同草稿目录之间没有分布式锁，同一账号应避免跨设备同时发布同一稿。

写入超时后再次调用**同一草稿**：如评论已存在且完全匹配，则恢复为已发布；如仍不存在，则保留待核实状态，停止再次创建。已发布评论被删除、修改，或同一标记出现多条时，也停止写入。不要删除日志或改正文创建新草稿来绕过不确定结果。

进程崩溃可能留下 `.lock`。先确认原进程已结束，再移除对应锁文件，保留 `.json` 日志后重试同一草稿。重新发布一份确实未写入的待核实草稿，需要人工核对 Plane 与日志后处理；本版不提供自动强制重发。

## 7. 验证

本次实现验证（2026-10-13）：98 项测试全部通过；已离线核对本机安装的官方 Plane MCP 0.3.4 读取与评论创建 Schema。JSON/TOML 配置解析、文档格式和 Python 编译检查通过。本机 3000、8001、14310 端口当时未监听，因此真实 Plane 读取联调尚未完成；本次未向真实 Plane 新增评论。

离线回归覆盖链接边界、完整分页、账号隔离、权限撤销、HTML 转义、草稿篡改、进程重启、并发发布、写入超时恢复，并通过真正的 STDIO MCP 客户端与假 Plane 上游验证工具发现和发布流程：

```powershell
& $demoPython -m unittest discover -s (Join-Path $demoRoot 'tests') -v
```

连接真实 Plane 的只读验收：

```powershell
& $demoPython (Join-Path $demoRoot 'verify_agent_mcp.py') `
  --config 'C:\Users\STUDENT\.config\plane-agent\config.local.json' `
  --task-url 'http://plane.lab:3000/lab/browse/LAB-3/' `
  --output (Join-Path $demoRoot 'output\agent-read-verification.json')
```

验收脚本默认只读取并记录 ID、条数、工具名及上下文范围，不发布评论或保存任务正文。真实写入请在专用测试任务中，由学生审阅后通过 Agent 调用，检查 Plane 中同一条评论以及重复调用返回的 `reused: true`。
