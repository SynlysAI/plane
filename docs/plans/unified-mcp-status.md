# 行政＋科研统一 MCP 实施状态

更新日期：2026-10-29（Asia/Shanghai）。本轮 **EXECUTION_PHASE = 6**；本轮记录见文末，阶段 1–5 历史记录保留。

| 阶段                     | 状态                             | 本轮实际交付                                                                                                                                   |
| ------------------------ | -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 盘点并冻结最小契约     | 已完成                           | 源码能力矩阵、真实层级/范围/授权与写路径、15 工具输入 schema/示例、客户端兼容核对、阶段依赖及非目标                                            |
| 2 统一连接＋端到端读取   | 已完成；未部署                   | 单条连接/单份配置、本人管理 API、Bearer、六个只读工具；159 项回归通过，含真实 SDK 网络闭环                                                     |
| 3 行政任务写入           | 已完成；未部署                   | 五个行政写入/结果工具、原生共享保存、创建/评论幂等回执；最终 327 项通过、6 项既有/不稳定项单独记录，真实 SDK 与隔离网页验收通过                |
| 4 科研授权适配与任务操作 | 已完成；未部署                   | 真实统一授权来源、旧哈希兼容、五类提案动作、直接编辑/状态；403 项通过、6 项既有问题单列，单配置跨两节点 SDK 闭环通过                           |
| 5 页面与单份配置         | 已完成；未部署                   | 最短签发流程、单 server 配置、分页范围/能力/期限/使用/撤销与兼容入口；后端 101、前端 86 项通过，真实页面→SDK→撤销失效通过                      |
| 6 集成验收与发布材料     | 验收中；已按用户追加要求启动本机 | 单配置双域/真实超时集成、真实 Codex 客户端闭环、协议兼容修复、发布材料；本机 localhost:3000 供人工验收，最终回归尚有一项原生事件排序失败待收尾 |

## 阶段 1 历史记录：实际基线与修改保护

- 预计位置已核实为 Git 根目录 `D:\plane-main\plane-dev`，没有在 `D:\plane-main` 旁边的其他源码快照实施。
- 分支：`周报mcp-demo`；HEAD：`8bea00299760808fd1775c3b3c6772971807138d`。本轮未创建分支、worktree、聊天或子 Agent，未暂存、提交、推送、合并。
- 适用规则：仓库根 `AGENTS.md`，包括禁止 docker-compose-test.yml、禁止 setup.sh 覆盖配置。扫描另有无关 `packages/tailwind-config/AGENTS.md`；本轮未触及该目录。
- 开始时已修改并保留：`deployments/windows/frontend-local.ps1`、`docs/operations/research-mcp-v21-deployment.md`。
- 开始时未跟踪并保留：`docs/operations/mcp-server-backend-setup.md`、`docs/operations/mcp-v22-deployment.md`。
- 文档生成时额外记录上述四文件 SHA-256，交付前再次比较；本轮始终未向其写入。保护清单只含路径/摘要，没有输出私密配置。
- 未运行部署、迁移、容器启停或数据清理，未读取用户密钥，未调用真实业务写入或通知。

## 本轮完成项和改动文件

1. [unified-mcp-v1.md](unified-mcp-v1.md)：完成源码盘点和最小契约冻结；区分已有服务、MCP 暴露缺口、新基础能力，并给出路径/符号。
2. [unified-mcp-v1.schemas.json](unified-mcp-v1.schemas.json)：冻结连接创建输入和 15 个工具的闭合 schema；23 个有效工具示例、15 个拒绝示例。schema 描述契约，没有接入业务运行时。
3. 本文件：记录基线、实际验证、限制及下一阶段入口。

仅以上三份文档是本轮新增交付。忽略目录 `.runtime/unified-mcp-phase1-20261028/` 保存生成/检查脚本、保护文件摘要和 proof.json；不纳入业务代码或部署。

冻结的实现选择：

- `/api/mcp/` 作为新单一机器入口，`/api/mcp/connections/` 管理本人连接；没有现存精确路径冲突，真实 resolver 验证留给阶段 2。
- 单条连接、哈希密钥、工作区范围与分域读写能力；显式 include_future_objects，true 动态交当前权限，false 保存父对象范围快照与后代/关联时间上界。
- 行政直接 Project→Issue/子任务；不新建行政节点。所有入口复用 administrative_projects 排除科研 Project，包括软删 chain/profile 的外壳。
- 行政普通写直接执行；create/comment 增最小事务幂等回执。普通编辑不引入新提案/确认票据，超时先按对象读回。
- 科研通过明确授权上下文适配真实旧 grant 和真实统一连接；不使用 grant=None、不伪造 ORM grant、不逐节点发子密钥。提案新增来源 FK/XOR 时保留旧 seal 和合法续签语义。
- 科研五类动作保留 prepare/execute；任务编辑/状态使用原共享服务、角色/状态规则，清楚声明 direct；统一连接不获得审批人身份。
- 统一 v1 沿用 2025-03-26 协议和项目锁定的 mcp 1.28.1 等依赖；单 server 配置，Bearer 一份凭据。
- 周报独立 purpose/header/提交服务保持兼容；已核实当前周报开关未配置默认是启用（common.py 与状态文档末尾），没有误用历史“默认关闭”作为现状。统一任务连接不获得正式周报提交权限。

## 验证命令与实际结果

执行目录均为 `D:\plane-main\plane-dev`。

| 验证                                                                                                     | 实际结果                                                                                                                                                                        |
| -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `git rev-parse --show-toplevel`、`git branch --show-current`、`git rev-parse HEAD`、`git status --short` | 根目录/分支/HEAD 与上述一致，初始四项修改保留                                                                                                                                   |
| `rg --files -g AGENTS.md` 及根规则读取                                                                   | 仅根及无关 tailwind-config 规则，无相关更深规则                                                                                                                                 |
| 源码与测试只读检查                                                                                       | 已核对统一管理、行政分类/角色/序列化/副作用、科研读取/资源/提案/状态服务、近期周报及相关测试；不是数据库集成通过声明                                                            |
| OpenAI 官方 MCP 文档与 MCP 2025-03-26 规范                                                               | 确认 Codex 的 Streamable HTTP/Bearer/TOML 配置形式；据项目源码冻结兼容基线；外部链接见契约，不代表真实客户端联调                                                                |
| MCP SDK 和 JSON Schema 离线检查                                                                          | 15 个 Tool 模型、ListToolsResult/InitializeResult 接受；16 份输入 schema 合法；23 有效＋15 拒绝工具示例、5 个连接样例均符合预期；所有对象闭合、无外部 $ref，15 工具均有有效示例 |
| 原有无依赖读取 catalog 边界检查                                                                          | 直接按文件加载真实 mcp_catalog.py，7 项检查通过：5 种非法输入拒绝、原 11 工具仍全部只读、写动作不能当读取别名；没有替代/模拟业务服务                                            |
| 本地文档链接/完整源码路径检查与四文件哈希复核                                                            | 检查通过，详细计数见忽略目录 proof.json；保护文件内容未变                                                                                                                       |
| `git diff --check`                                                                                       | 通过；另以检查脚本验证新增文件尾随空白/换行及补丁格式                                                                                                                           |

可重复运行最终检查（只读契约/源码，不加载 Plane 包初始化）：

```powershell
& '.runtime/mcp-management-validation/venv/Scripts/python.exe' `
  '.runtime/unified-mcp-phase1-20261028/validate_contract.py'
git diff --check
```

环境已存在 `mcp==1.28.1`、`jsonschema==4.26.0`、`pytest==9.1.1`，本轮没有安装或升级依赖。

一次额外尝试未通过：在禁用 pytest 自动插件、使用 `--noconftest` 和 `-c NUL` 的前提下执行原 `test_mcp_catalog.py`，仍由测试包导入触发 `plane.__init__ → celery → redis_instance`，因 REDIS_URL 为空在收集阶段报 AttributeError；另有 Windows NUL 目录 pytest cache 警告。**没有测试用例执行，不计通过。** 本轮未为此读取/改写 .env 或连接/清理业务 Redis，而将最终检查改为按文件加载无依赖 catalog。原后端 pytest 套件仍未验证，最终离线结果不能替代该套件。

最终检查证据为 `.runtime/unified-mcp-phase1-20261028/proof.json`；生成脚本与检查脚本同目录。初始 schema 检查也已通过；表内数字为当前最终交付契约的检查范围，不与历史周报/科研测试数量相加。

## 发现的缺口与未验证项

- **没有统一运行能力交付**：本轮只有阶段 1 要求的盘点/契约/状态；新连接模型、机器 URL、业务工具尚待实现，未签发任何统一凭据。
- 当前手写科研 HTTP handler 的 POST/OPTIONS、Origin、batch 等行为不能直接当作完整 Streamable HTTP 验收。阶段 2 需真实 SDK 网络验证 GET/通知/错误/鉴权/版本等行为，不能只手写 POST。
- 科研提案 original_grant 必填、seal/load/readback/audit 绑定节点；阶段 4 需最小兼容迁移和来源适配，旧提案哈希不得回写。统一连接撤销后不能继续执行。
- 源码推断发现 submit 重放前的状态权限检查可能拒绝已成功提交的同请求；当前事件 MCP 投影也未暴露 request_id。已在契约写清阶段 4 的共享服务/结果恢复补充和所需回归；本轮未数据库复现、未修复，不声称现有状态重放全通过。
- 网页任务服务与 Agent 五动作的节点可写状态条件不同；统一机器写取更窄交集，契约已明确，后续 allowed_actions 必须真实反映。
- 原行政普通写逻辑分布在视图和序列化器，缺少可直接拿来用的 create/comment 持久幂等；阶段 3 需抽最小共享服务，保留活动、通知和说明版本任务。不能只直接 ORM save 后称已完成集成。
- 未运行数据库/缓存/通知集成、迁移演练、浏览器、完整后端回归、前端类型/构建。本轮没有业务代码或页面修改，不为文档变更启动这些服务。
- 尚未针对新统一 schema 做真实 Codex/ScienceDiscovery 导入与调用；SDK 离线类型接受不等于真实网络联调，真实 SDK 联调也不等于 Agent 验收。未改变任何已有客户端配置。
- ScienceDiscovery 某些部署缺注册 API；现有兼容说明已阅读，不能承诺自动注册或所有客户端无适配。

## 下一阶段入口

下一轮设置 **EXECUTION_PHASE = 2**，先重新核实 Git 基线和现有修改，读取本文、冻结契约与 schema；实施统一连接/必要迁移、人工管理 API、Bearer 鉴权、范围解析/科研读授权接口、统一导航和读取。用隔离账号/数据和真实 MCP SDK 证明一份配置同时读取两个行政项目及两个科研节点。

阶段 2 不提前接入行政写、科研写、重做页面或正式周报提交。本轮不自动进入阶段 2。

## 2026-10-28 阶段 2：统一连接＋端到端读取（本轮）

### 基线与范围

再次核实仓库为 `D:\plane-main\plane-dev`，分支 `周报mcp-demo`、HEAD `8bea00299760808fd1775c3b3c6772971807138d`。适用根 AGENTS.md；相关目录无更深规则。开始时原有四项本机/运维修改、阶段 1 三份文档均保留；本轮只更新已授权的契约说明和状态文档。没有创建分支、worktree、子 Agent 或新聊天，没有暂存、提交、推送、合并或部署。

按本轮输入增加的约束：**不新增 Redis、缓存、队列或分布式锁**。连接及 scope 持久化到现有 PostgreSQL，签发额度使用数据库事务和 owner 行锁，分页使用签名游标。原 Plane 自身 Redis/Celery 依赖保持原样；新连接/读取没有引入新的基础设施或任务队列。

### 已完成的实际能力

- 新增 `UnifiedMCPConnection` 与 **0207_unified_mcp_connection** 迁移：owner/name/token*hash/scope/到期/撤销/最近使用；密钥为高熵 `pum*` 凭据，只保存哈希，只在创建响应显示一次。
- 新增 Session + CSRF 的本人连接管理：`GET/POST /api/mcp/connections/`、`POST /api/mcp/connections/<id>/revoke/`。列表分页、不返回完整密钥或 hash；列表返回 csrf_token，可用于签发/撤销。撤销幂等，其他用户返回 404；失去工作区资格后仍可撤销自己的连接。
- 单个 `/api/mcp/` 机器入口，只接受统一 Bearer；不接受 Session、API Key、科研 Context Token 或周报 token 升级。签发响应输出一个 mcp_url、一个 Codex server 项和一个 ScienceDiscovery server 项；没有隐藏的逐节点子连接/子密钥。
- 当前只签发 `read`，显式请求 `read_write` 返回 capability_unavailable，不能静默降级。生产目录仅暴露 **6 个读取工具**：工作区、行政项目/科研链、节点、任务、上下文、资源。写入、提案、普通编辑回执都留在后续阶段；allowed_actions/可编辑字段/状态动作均明确为空。
- 动态范围实时取连接工作区/业务域与本人当前权限的交集；新增项目、科研节点和任务可在同一连接发现。快照模式保存创建时可见父对象 ID、节点资源 ID 和 snapshot_at，拒绝后来新增及后来才可访问的父对象/新挂接资源；超过 10,000 个引用明确拒绝并回滚，不截断、不复制正文。
- 行政读取复用 administrative_projects 的分类与可见性、原任务 manager、访客限制和有效负责人查询；科研 Project 的软删除档案/链外壳仍不能进入行政入口。行政节点返回 not_applicable 和真实任务入口；支持 Issue 子任务，不新增行政层级表。
- 科研读取通过显式 `UnifiedReadAuthorization` 进入共享 ResearchReadService 的链、节点和资源查询；没有伪造 grant 或以无授权 reader 执行机器调用。保留原节点授权和旧游标 binding；签发统一读连接与旧节点读连接共享相应每节点额度，不能换入口绕过上限。
- 列表在查询层应用范围/状态/负责人/关键词与稳定分页。支持原生 UUID 和已知同实例链接；核对域、类型、工作区和真实父对象；同名返回多个候选，不猜目标。上下文有界分区读取评论、资源、事件、快照；正文按 hash/offset 分页，内容变化拒绝续读。
- 科研资源继续复用 `_candidates/_linked/_allowed/_content` 的真实归属、ACL 和公开事件投影。文件/文献/外部引用等原本仅有元信息的对象仍显式标 metadata_only/unsupported_content，不请求任意 URL、不读取文件字节。
- 传输沿用 **2025-03-26**：initialize 协商、两页 tools/list、tools/call、ping、通知 202 空体、batch、无 SSE 的 GET/DELETE 405、Origin/Host 校验、Accept/协议头校验和 no-store；无 MCP session ID。目录游标只携 scope 摘要，不把大快照塞入游标。
- 新连接签发/撤销和成功读取复用现有审计表，记录摘要，不含密钥/正文。新入口不进入 API Token 正文日志，即使附加无关 X-Api-Key；旧行政门户日志行为保持兼容。

### 正式报告版本规则的核实修订

最终扩展测试确认：现有 `research/services/report_context.py:selected_report_content` **只接受当前最新正式版本**，即使旧快照记录仍存在，指定旧版也会返回 report_context_version_changed。阶段 1 对“固定版本”描述不足以表达这条限制；本轮不修改这项业务规则或放宽历史版本读取。

因此动态连接可明确选择当前最新正式版本；快照连接遇到较新正式版本时不自动纳入它，元信息标记 `content_available=false, content_state=version_changed`，读取旧版仍由共享服务明确拒绝，读取新版受快照上界拒绝。正式周报 purpose 凭据、草稿保存及提交均没有扩大；隔离测试验证统一密钥不能当作周报凭据使用。

### 改动文件

新增业务代码/迁移：

- `apps/api/plane/db/models/mcp.py`
- `apps/api/plane/db/migrations/0207_unified_mcp_connection.py`
- `apps/api/plane/mcp/authorization.py`
- `apps/api/plane/mcp/catalog.py`
- `apps/api/plane/mcp/endpoints.py`
- `apps/api/plane/mcp/reading.py`

小范围复用接入：`db/models/__init__.py`、`mcp/urls.py`、`middleware/logger.py`、`research/services/chain_context.py`、`research/views/mcp_management.py`（均位于 apps/api/plane）。

新增测试：`apps/api/plane/tests/contract/app/test_unified_mcp.py`、`apps/api/plane/tests/unit/research/test_unified_mcp_catalog.py`。更新本文及 [v1 契约](unified-mcp-v1.md) 的本阶段实施说明；冻结 schema 附件保留原内容，没有把未来 15 个工具误标为当前已实现。

### 隔离环境、实际验证与证据

验证没有使用业务数据库、现有 Redis、通知外发或部署中的 API。Docker 引擎当时不可用，未启动 Docker Desktop 或现有容器；改为从 EDB 官方 ZIP 提取 PostgreSQL **17.6** 服务文件，在本任务忽略目录运行临时实例，仅监听 `127.0.0.1:55448`。没有安装系统服务；集群、测试库及日志均位于 `.runtime/unified-mcp-phase2-20261028/`。缓存为进程内 LocMem，现有任务代理配置为 memory，未新增 Redis 实例。

仅使用自建 `unified_mcp_phase2` 迁移库与 `test_unified_mcp_phase2` 自动化测试库；脚本对库名和端口做断言。隔离配置不写入仓库设置或实际 .env。数据库初始化采用本机回环连接的专用临时配置，不能作为生产部署配置。

| 验证                                          | 结果/证据                                                                                                                                                                                                                                       |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 从空库完整迁移至 0207                         | 通过，migrate.log                                                                                                                                                                                                                               |
| 0207 回退到 0206，再升级 0207                 | 通过；既有合成用户保留，token_hash 唯一约束存在，migration-proof.json                                                                                                                                                                           |
| Django 系统检查                               | `System check identified no issues`                                                                                                                                                                                                             |
| 模型/迁移一致性                               | `makemigrations --check --dry-run`：No changes detected                                                                                                                                                                                         |
| 新增连接、scope、资源、传输、日志与旧入口回归 | **159 passed，55.13s**（新增 27、既有回归 132），无跳过/失败；backend-tests.log / backend-results.xml，命令见下文                                                                                                                               |
| 真实 SDK 网络验收                             | mcp 1.28.1 ClientSession + streamable_http_client 连接真实 Django live_server；真实 Session/CSRF 签发后，仅一份配置发现两页工具，读取两个行政项目、两个科研节点及各自任务正文；撤销后 401。JUnit 的 single_configuration_proof 属性保存脱敏证明 |
| Python 静态检查与新文件格式                   | 8 份新增 Python 文件 Ruff check 通过、format --check 全部通过                                                                                                                                                                                   |
| 修改保护/空白检查                             | 原四文件 SHA-256 与本轮开始清单比较；git diff --check；最终 proof.json 汇总                                                                                                                                                                     |

实际执行目录为仓库根，测试使用既有 `.runtime/mcp-management-validation/venv/Scripts/python.exe`（Django 5.2.15、mcp 1.28.1）。未升级依赖。测试命令的完整环境前缀：

```powershell
$env:PYTHONPATH = 'D:\plane-main\plane-dev\.runtime\unified-mcp-phase2-20261028;D:\plane-main\plane-dev\apps\api'
$env:DJANGO_SETTINGS_MODULE = 'unified_test_settings'
```

运行以下七份相关测试文件，使用 `-c apps/api/pytest.ini --reuse-db --nomigrations --tb=short -q -o addopts= -o junit_family=legacy`，JUnit 输出到本任务证据目录：

```text
apps/api/plane/tests/contract/app/test_unified_mcp.py
apps/api/plane/tests/unit/research/test_unified_mcp_catalog.py
apps/api/plane/tests/contract/app/test_research_machine_access.py
apps/api/plane/tests/contract/app/test_research_mcp_extended.py
apps/api/plane/tests/contract/app/test_mcp_management.py
apps/api/plane/tests/contract/app/test_research_agent_operations.py
apps/api/plane/tests/unit/middleware/test_logger.py
```

`--nomigrations` 仅用于隔离 pytest 建表；真实空库迁移与 0206↔0207 演练另已实际执行，不以同步建表代替迁移验收。

中间失败记录：首次新增测试 18 passed/3 failed，修正测试中 OrgUnitMember 失效字段、管理拒绝状态断言及 APIClient 默认 Accept 覆盖；随后新增 21 项通过。第一次扩展回归 157 passed/1 failed 是隔离配置将写开关设为 True，旧测试预期默认关闭，已恢复该隔离默认值；下一次扩展 158 passed/1 failed 揭示上述正式报告仅允许最新版本的真实规则，已保留业务校验、明确快照元信息，并以针对测试确认通过。格式检查初次发现长行/未用导入，已修正。不会把这些中间计数或历史周报测试累计成最终通过数。

交付前已停止本轮自建 PostgreSQL 进程，保留隔离集群及全部验证材料供复核；没有启动/停止原 Docker 部署或清理任何原有数据。最终 `.runtime/unified-mcp-phase2-20261028/proof.json` 汇总真实 SDK、迁移、159 项结果、四文件摘要及空白检查；本轮指定阶段已完成。

### 未验证项与下一阶段

- 本轮完成后端统一连接和读取，没有部署到现有运行实例；业务库未运行 0207，前端未改动、未构建或发布。后续部署须使用正常迁移流程；0207 回退会删除新统一连接记录，不能当作无损撤销操作。
- 真实网络 SDK 验收已做；真实 Codex/ScienceDiscovery Agent 导入、UI 操作及真实外部代理/TLS 尚未验收，留待阶段 6。没有以 SDK 冒充 Agent 验收。
- 未实现行政写、科研统一写授权/提案归属迁移、统一写结果回执、页面简化及正式周报提交。这些不在本阶段目录或签发能力中。
- 大规模快照签发、长期负载、连接并发签发压力、代理传输和浏览器交互没有做压力/现场验收；快照超限会明确拒绝。只重跑本轮涉及的后端范围，没有运行全仓或无关前端测试。
- 旧节点读写服务保持兼容，旧科研提案结果仍走原入口。阶段 4 再适配新提案来源，不提前修改原 FK、seal 或审批/角色规则。

下一轮设置 **EXECUTION_PHASE = 3**，重新核实工作区后实现行政任务共享写服务、创建/评论幂等回执及隔离写入闭环。本轮不自动进入阶段 3。

## 阶段 3：行政任务直接写入（2026-10-28）

### 实际基线与保护

- 本轮指定 **EXECUTION_PHASE = 3**。再次核实 Git 根 `D:\plane-main\plane-dev`、分支 `周报mcp-demo`、HEAD `8bea00299760808fd1775c3b3c6772971807138d`；在原工作目录实施，没有切换旁边源码快照。
- 根 `AGENTS.md` 仍适用。未运行禁用的 docker-compose-test.yml 或 setup.sh；未部署、迁移业务库、暂存、提交、推送或合并，未创建 worktree/聊天/子 Agent。
- 开始时对阶段 1–2 及用户已有的 20 份修改文件记录 SHA-256，并复制到忽略目录 `.runtime/unified-mcp-phase3-20261028/baseline/`；清单 `initial-files.json`。原用户四文件保持逐字节不变。前两阶段交付继续保留，本轮仅扩展本阶段所需文件。

### 已交付能力与文件

| 文件                                                                                                                                                                              | 本轮改动                                                                                                                                                       |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/api/plane/utils/issue_mutations.py`（新增）                                                                                                                                 | 原生共享保存；先校验网页项目域写准入，再校验原生有效角色/创建者/访客规则；调用已验证 serializer.save；真实事务提交后独立投递原活动/通知、webhook、说明版本任务 |
| `apps/api/plane/app/permissions/base.py`                                                                                                                                          | 抽出原项目有效角色判断供网页装饰器和共享保存复用；保留工作区门禁、默认管理与继承身份                                                                           |
| `apps/api/plane/app/views/issue/base.py`、`comment.py`                                                                                                                            | 网页任务创建/编辑/评论调用同一保存函数；保留原响应与评论附件服务                                                                                               |
| `apps/api/plane/app/serializers/issue.py`、`api/serializers/issue.py`                                                                                                             | 修复部分更新时日期只传一端未与已存另一端比较的缺口；仍由原生序列化器执行校验                                                                                   |
| `apps/api/plane/db/models/mcp.py`、`models/__init__.py`、`migrations/0208_unified_mcp_write_result.py`（新增迁移）                                                                | 仅创建/评论持久成功回执，连接＋工作区＋request_id 唯一，限制工具类型；原生对象 UUID 不增加阻碍原删除/清理的外键                                                |
| `apps/api/plane/mcp/writing.py`（新增）                                                                                                                                           | 五个行政写入/结果工具；实时 scope/行政域/原生权限；事务及真实用户身份；同键恢复、冲突拒绝、回滚/结果不确定/提交后读回分开呈现                                  |
| `apps/api/plane/mcp/catalog.py`、`authorization.py`、`endpoints.py`、`reading.py`                                                                                                 | 分能力发现 6/11 工具，行政闭合输入分支；允许动态范围行政 read_write；分页负责人/原生状态及 allowed_actions；按当前权限读回                                     |
| `apps/api/plane/tests/contract/app/test_unified_mcp_writes.py`（新增）                                                                                                            | 28 项行政测试，含真实 TCP SDK 闭环、原生网页接口、原通知/活动、并发重复创建/评论、只读/域/角色/撤销、失败恢复与原生默认负责人/子任务                           |
| `test_unified_mcp.py`、`test_unified_mcp_catalog.py`                                                                                                                              | 原只读拒绝继续成立；新增行政 schema 对齐阶段 1，科研分支留待阶段 4；只读目录仍六工具                                                                           |
| `test_administrative_assignment_boundary.py`、`test_administrative_inherited_members.py`、`test_administrative_project_default_access.py`、`test_administrative_organizations.py` | 原测试异步任务替代的导入路径随共享服务移动；未放宽断言或业务规则                                                                                               |
| 本文、`unified-mcp-v1.md` 第 12 节                                                                                                                                                | 当前能力、限制、证据、迁移/回退和阶段 4 入口                                                                                                                   |

普通写入均直接执行，不建立行政提案或批准步骤。支持标题、HTML 说明、优先级、最多一名负责人、开始/截止日期（含清空）、原生 set_state 和追加非空评论。默认负责人、子任务父对象、HTML 净化/说明文本、完成时间均复用原生行为。新连接只输出同一 MCP server 项，不给节点复制凭据。

创建/评论请求与成功回执同事务提交，摘要绑定规范化目标、工具和参数。同键同内容返回同对象，不重复活动/通知；同键异内容报 idempotency_conflict。`plane_get_write_result` 只查同一连接/工作区的回执，并重新执行当前可见性检查。普通编辑/设状态不存回执；不确定时先读目标。已提交但读回失败只返 COMMITTED/pending；没有把读取故障当作失败重新创建。若提交后连接撤销/失权，返回的最小提交信息不含历史正文、commit 摘要或新对象 ID。

最终复核将网页 `TimezoneMixin` 使用的 `project_domain_allows(write=True)` 纳入共享服务，保证创建者/访客例外不能跳过原网页域写门禁；新增一致性检查比较 MCP 拒绝、网页 403 和空 allowed_actions。

### 真实隔离验证与证据

证据统一位于 `.runtime/unified-mcp-phase3-20261028/`（忽略目录，不含业务配置变更）。测试只使用既有本地 Python 环境及既有阶段 2 原生 PostgreSQL 17.6；重新启动的隔离集群是阶段 2 的 pgdata，地址 `127.0.0.1:55448`、账号 `unified_test`。本轮独立数据库 `unified_mcp_phase3`、`test_unified_mcp_phase3`，迁移演练用 `unified_mcp_phase3_migrations`。设置在导入前断言专用库名/端口，不读取业务 .env。

| 验证                 | 实际结果/证据                                                                                                                                                                                                                                                                                                                         |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 空库真实迁移至 0208  | `migrate.log` 全部成功，含真实 0207/0208；不是以 pytest 的同步建表代替迁移                                                                                                                                                                                                                                                            |
| 0208→0207→0208       | 在隔离验收库克隆中实测；Issue 1、评论 1、活动 7、0207 连接 2 在前后均保留。回退删除两条回执，再升级创建空回执表；`migration-probe.log` / `migration-proof.json`                                                                                                                                                                       |
| Django 配置/模型检查 | `django check` 无问题；`makemigrations --check --dry-run` 无变化                                                                                                                                                                                                                                                                      |
| 后端最终回归         | **327 passed / 6 deselected，234.45s**，无执行用例失败或跳过；6 项排除原因及独立结果见下文。最终以 `backend-acceptance.log` / `backend-acceptance.xml` 为准，不将中间结果累计计数                                                                                                                                                     |
| 真实 SDK             | 原有 mcp 1.28.1 `ClientSession + streamable_http_client` 通过真实 TCP initialize、三页 tools/list（11 工具）、tools/call；真实 Session/CSRF 签发一份配置，发现两个行政项目/两个科研节点，完成创建→调整负责人和日期→设状态→评论→读回/结果恢复；JUnit `administrative_write_sdk_proof`                                                  |
| 实际网页             | 已有 `apps/web/build/client` 构建经任务自有本地代理连接隔离后端，独立浏览器会话加载 SDK 任务。`native-task-comments-activities.png` 实际可见说明、评论、负责人、开始/截止日期、完成状态和创建/分配/优先级/日期/状态活动；`browser-proof.json` 无页面运行错误，`browser-sdk-proof.json` 记录真实 TCP 写入                              |
| 活动与通知           | 运行原活动/通知/说明版本任务函数，真实生成 IssueActivity、IssueDescriptionVersion、Notification 和 EmailNotificationLog；后端断言通知收件人为新负责人，重复请求不新增副作用。独立网页验收库另核实活动 7、说明版本 1、站内通知 6、邮件待发日志 6、回执 2（`native-records-proof.json`）。未运行邮件发送/beat，无实际外部收件人/webhook |
| 静态/保护检查        | Ruff check/format、原四文件 SHA-256、git diff --check、task-owned 进程清理在交付前汇总到 `proof.json`                                                                                                                                                                                                                                 |

隔离副作用执行边界：原后台任务 `.delay` 在测试/独立验收进程中适配为运行**未改动的任务函数**，以便实际提交后核对业务记录；原活动任务的既有 Redis origin 提示用局部内存替代，不替代业务权限、serializer、数据库活动/通知逻辑。其余套件沿用既有 memory broker/LocMemCache。真实 MCP 鉴权/网络/数据库没有 mock。没有启动 Redis、Celery worker 或邮件服务，不能将本结果称为真实 broker/worker/SMTP 部署验收。前端复用已有构建，没有修改、覆盖或重建正在部署的构建。

复现环境前缀与最终命令（工作目录均为仓库根）：

```powershell
$env:PYTHONPATH = 'D:\plane-main\plane-dev\.runtime\unified-mcp-phase3-20261028;D:\plane-main\plane-dev\.runtime\unified-mcp-phase2-20261028;D:\plane-main\plane-dev\apps\api'
$env:DJANGO_SETTINGS_MODULE = 'unified_phase3_settings'
& '.runtime/mcp-management-validation/venv/Scripts/python.exe' -m django check
& '.runtime/mcp-management-validation/venv/Scripts/python.exe' -m django makemigrations --check --dry-run
& '.runtime/unified-mcp-phase3-20261028/run-acceptance.ps1'
```

`run-acceptance.ps1` 保存十五份相关测试文件及完整参数：`--reuse-db --nomigrations -q --tb=short -o addopts= -o junit_family=legacy`，明确排除下列六项既有问题；它们不计通过，不添加 xfail 或放宽断言。`--nomigrations` 仅用于隔离 pytest 建表，真实迁移已另验。浏览器临时下载安装的测试引擎只放在本证据目录，没有升级项目依赖或修改锁文件。

### 中间问题与既有失败（如实保留）

- 初始 29 项 24 passed/5 failed：副作用任务 eager 配置未生效、并发测试直接调用服务时缺原生 request、外工作区拒绝码及原网页字段/活动路径断言。改为真实 HTTP 并发、实际提交后运行原任务，使用原生 state_id 和网页分型 history 接口。
- 第二次新增验证 22 passed/2 failed：测试直接 JSON 编码原生 UUID，以及遗漏 history 的 `activity_type`。网页实际分开请求 issue-property / issue-comment；已按网页接口核对活动，未改旧无类型混合 history 的既有缺陷。
- 首次扩展 169 passed/7 failed：上述两项活动接口断言，加以下五项成员接口既有失败。后续扩展 326 passed/2 failed/5 deselected：旧分类迁移的不稳定命名及新访客测试的可见性拒绝码；后者修正为 not_found。修正后曾获 327 passed/6 deselected，随后发现并补齐域写准入，最终再运行完整相关套件，不以该较早数字替代最终结果。
- **五项稳定既有失败**：`test_administrative_project_membership.py::test_direct_access_is_denied_without_active_membership` 四参数（当前确为 403，但测试要求的 code 被现有前置 TimezoneMixin 拒绝覆盖）；`test_authorized_invitation_can_add_administrative_member`（现有域写准入在邀请加入前返回 403）。用只读 `git show HEAD:.../permissions/base.py` 替换测试进程内装饰器后，独立复现 **5 failed / 35 deselected**；`baseline_permissions_probe.py` / `baseline-membership.log/xml`。未覆盖工作树，也未绕过或放宽该门禁。
- **一项历史迁移不稳定测试**：`test_administrative_organizations.py::test_migration_creates_default_and_flattens_legacy_categories`。未改动的 0171 按 created_at、UUID 排序，路径与同名字面分类碰撞时可能反向取得 `(2)`；扩展运行失败，基线单项重跑 **1 passed**（`baseline-category.log/xml`）。本轮不修改旧迁移或为该项声称稳定通过；最终明确排除并记录。
- 早期基线复现曾忘记为同步建表的隔离测试库传 `--nomigrations`，导致 django_content_type 已存在，5 项未执行；已用一致参数复现，错误记录不计通过。初次静态检查长行/未使用导入已修正。
- 本轮域写准入针对检查 **4 passed / 24 deselected**，比较原生网页和 MCP 的角色变化后拒绝。

### 限制、迁移与下一阶段

- 行政 read_write 暂只支持动态范围 `include_future_objects=true`；快照继续只读，false＋写能力返回 capability_unavailable。科研 read_write、科研统一提案/任务状态、正式周报提交、文件上传、删除/批量操作仍未开放。
- 已交付 0208 **未迁移业务库**。正式部署需依次应用 0207/0208 和兼容代码；若需回退，先停用统一写连接并备份回执，再部署只读兼容代码、回退 0208。回退会删除回执但保留原生对象；失去幂等记录后不能盲目重放历史请求。0207 回退还会删除统一连接，另需备份。
- 回调投递失败不会把已提交原生写入误报为失败，也不会阻止其他回调；投递故障修复由现有 worker/运维承担，没有新增 outbox 或后台补偿平台。普通编辑的不确定结果需先读回，不宣称所有动作恰一次。
- 真实 SDK 与隔离网页已验；真实 Codex/ScienceDiscovery Agent 导入和代理/TLS、真实 broker/worker 仍未验，按阶段 6 分别记录。源码实现和隔离验收不代表部署。
- 原用户四文件不改，业务数据/业务服务不动。临时代理、隔离 API 和本轮启动的 PostgreSQL 在交付前停止，保留证据与隔离库。

下一轮设置 **EXECUTION_PHASE = 4**，按冻结方案适配科研真实授权来源/旧提案归属及任务操作；不得使用 grant=None 或隐式逐节点发证。本轮不进入阶段 4，也不实施阶段 5 页面简化。

## 阶段 4：科研授权适配与任务操作（2026-10-28）

### 基线与修改保护

- 再次核实实施根目录 `D:\plane-main\plane-dev`，分支 `周报mcp-demo`，HEAD `8bea00299760808fd1775c3b3c6772971807138d`，适用根 `AGENTS.md`；没有使用旁边同名快照。
- 开始时 33 份已有修改/未跟踪文件已保存 SHA-256 与保护副本，位于 `.runtime/unified-mcp-phase4-20261028/initial-files.json` / `baseline/`。原用户四文件逐字节保持；前两阶段 schema 附件、阶段 3 原生保存/日期修复等继续保留。仅对本阶段所需统一模块/契约/测试作增量修改。
- 未运行 docker-compose-test.yml 或 setup.sh；未部署、迁移业务库、推送、合并或清理现有数据；未创建分支、worktree、聊天或子 Agent。

### 实际交付与改动文件

| 文件                                                                                                                       | 本阶段交付                                                                                                                                                                 |
| -------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/api/plane/research/services/operation_authorization.py`（新增）                                                      | 两种明确授权实现：真实旧节点读/写授权与真实统一连接；校验当前 owner/scope/策略/权限/撤销，不发子凭据、不伪造 grant                                                         |
| `apps/api/plane/research/services/agent_operations.py`                                                                     | 同一原生服务接受授权接口；共享 prepare/execute/get/list、前置条件、校验、保存和读回；旧 seal 字段/算法不变；统一来源按版本＋连接 ID 签名/筛选/溯源；旧签发器合并统一写额度 |
| `apps/api/plane/db/models/research/agent_operation.py`、`migrations/0209_research_operation_unified_source.py`（新增迁移） | original_connection 与 nullable original_grant，加恰一来源约束；保留原唯一键和旧行哈希；存在统一来源记录时拒绝结构回退                                                     |
| `apps/api/plane/mcp/research_writing.py`（新增）                                                                           | 五类提案动作适配，以及直接 update/submit/return/complete/cancel；复用原 serializer/任务状态机；原生事件恢复、不确定结果处理、UTC 时间点读回及统一结果元数据                |
| `apps/api/plane/mcp/research_capabilities.py`（新增）                                                                      | 按当前角色/状态、连接和既有策略投影允许动作；分页原生候选成员；明确 proposal/direct 与必填字段，不把写能力当审批权                                                         |
| `apps/api/plane/mcp/authorization.py`                                                                                      | 动态范围科研 read_write 签发；复用既有全局/工作区策略；科研读/写分别五条，旧节点与统一范围双向计数；快照仍只读                                                             |
| `apps/api/plane/mcp/catalog.py`、`reading.py`、`endpoints.py`                                                              | 全部 15 个冻结输入 schema、6/11/12/15 工具发现、科研路由和 operations 上下文；文本/structuredContent 的日期、UUID 等值一致；管理响应反映实际实现能力                       |
| `apps/api/plane/tests/contract/app/test_unified_mcp_research_writes.py`（新增）                                            | 25 项科研验证，含五类动作、跨两个节点、角色全流程、并发、结果恢复、撤销/过期/成员退出/策略/归属/篡改、旧来源兼容、双向额度及真实周报 purpose 隔离                          |
| `test_unified_mcp_catalog.py`、`test_unified_mcp.py`、`test_unified_mcp_writes.py`                                         | 全 15 schema 与示例验证；将旧“未实现科研写”断言更新为现有部署策略拒绝，保留只读/快照拒绝和原行政测试                                                                       |
| 本文、`unified-mcp-v1.md` 第 13 节                                                                                         | 能力、边界、命令、迁移/回退、已验证与未验证及阶段 5 入口                                                                                                                   |

科研创建、评论、分析草稿、资源关联、过程记录均显式 prepare→execute，未隐式创建批准记录；普通编辑和任务状态直接执行。统一提案只由原连接 get/list/execute；旧同 owner/同 node 的合法刷新节点授权仍能恢复旧提案。状态动作调用原生业务函数，不直接 ORM 改 status；节点状态不随任务操作改变。新普通编辑不建提案/回执表，状态重试复用原事件记录。

### 验证环境与真实证据

证据目录 `.runtime/unified-mcp-phase4-20261028/`。复用已有 Python/Django/MCP SDK 和阶段 2 原生 PostgreSQL 17.6 隔离集群，地址 `127.0.0.1:55448`、用户 `unified_test`；本轮只新建/使用 `unified_mcp_phase4`、`test_unified_mcp_phase4`、`unified_mcp_phase4_migrations`。没有使用业务库、Redis、worker 或外部通知目标。

| 检查             | 实际结果/证据                                                                                                                                                                                                                                                                                                      |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 真实空库迁移     | `migrate.log` 全部成功至 0209；不以 pytest 同步建表替代迁移                                                                                                                                                                                                                                                        |
| 迁移与旧数据兼容 | 专用克隆中创建真实旧授权/提案；0209→0208→0209 后哈希/原归属保留，旧提案升级后执行 COMMITTED；再建立统一提案，反向迁移明确拒绝且两条提案/迁移记录保留。`migration-probe.log` / `migration-proof.json`                                                                                                               |
| 后端最终相关回归 | **403 passed / 6 deselected，285.63s**，执行用例无失败或跳过；`backend-acceptance.log` / `backend-acceptance.xml`。六项阶段 3 已记录的既有问题明确排除，不计通过                                                                                                                                                   |
| 真实 SDK         | 同一真实 Session/CSRF 签发的一份配置；mcp 1.28.1 ClientSession + streamable_http_client 在真实 TCP 上 initialize、三页 tools/list（15 工具）、tools/call；发现两个行政项目/两个科研节点，逐节点创建提案/执行→编辑负责人/日期→评论提案/执行→原生取消→读回，并经原网页 REST 读回。JUnit `unified_research_sdk_proof` |
| 角色与原生状态   | 当前负责人提交；审核人退回→负责人再提交→审核人完成；普通写者/链 owner 无审核身份不能 complete，审核身份不自动获得 cancel；链管理者可取消。能力字段与实际拒绝/允许一致                                                                                                                                              |
| 故障/重复与来源  | 五动作重复执行不重复对象/事件/通知；并发执行只得一个结果；旧/统一来源不可互相收养；准备超时按 request_id 列表恢复；执行后读回故障可查询原 operation_id 恢复；篡改、前置条件变化、退出成员、撤销、过期、策略关闭和节点归档均拒绝新执行                                                                              |
| 周报隔离         | 实际签发可正常读取周报上下文的 purpose=weekly_report/WEEKLY 凭据，验证其 header/Bearer 均不能调用统一入口；统一 token 不能进入周报入口，正式快照未新增；旧周报完整相关回归包含在最终套件中                                                                                                                         |
| 静态/模型        | Django check 无问题；makemigrations --check --dry-run 无变化；10 份相关新/统一文件 Ruff check/format 通过，原服务 Pyflakes 检查通过；日志见同目录                                                                                                                                                                  |
| 修改保护/清理    | 原四文件及不需扩展的其余既有交付 SHA-256、git diff --check、隔离进程停止，交付前汇总 `proof.json`                                                                                                                                                                                                                  |

本轮科研事件、审计、站内通知使用原服务真实写入隔离数据库；没有 mock 业务保存、鉴权或 MCP 网络。异步的旧行政回归继续沿用阶段 3 的本地任务执行适配；这不等于真实 broker/worker/SMTP 验收。没有新 Redis、缓存、队列、全库并发锁或基础设施。没有前端代码改动/构建，也未将原网页 REST 读回称为本阶段新增 GUI 验收。

环境前缀和复现入口（仓库根执行）：

```powershell
$env:PYTHONPATH = 'D:\plane-main\plane-dev\.runtime\unified-mcp-phase4-20261028;D:\plane-main\plane-dev\.runtime\unified-mcp-phase2-20261028;D:\plane-main\plane-dev\apps\api'
$env:DJANGO_SETTINGS_MODULE = 'unified_phase4_settings'
& '.runtime/mcp-management-validation/venv/Scripts/python.exe' -m django check
& '.runtime/mcp-management-validation/venv/Scripts/python.exe' -m django makemigrations --check --dry-run
& '.runtime/unified-mcp-phase4-20261028/run-acceptance.ps1'
```

脚本保存十八份实际测试文件，覆盖统一读/行政写/科研写、旧节点读取/提案/管理、科研原生任务、周报、原行政权限/附件/REST 校验和日志。参数为 `--reuse-db --nomigrations -q --tb=short -o addopts= -o junit_family=legacy`。六项排除与阶段 3 相同：四参数成员拒绝码、邀请加入准入和历史 0171 名称排序不稳定项，未改断言、未加 xfail，也未称其通过；阶段 3 已单独基线复现，详见历史记录。

### 中间发现与限制

- 原节点/提案与全契约首轮 **51 passed**（`legacy-initial.log/xml`），证明授权抽取未改变旧场景。
- 新科研首轮 **18 passed / 3 failed**：能力投影误取返回外层，导致编辑读回 pending、能力 KeyError 和 SDK 失败；已按原 serializer 的 actions 层修正。随后含原生任务的 **35 passed / 1 failed** 揭示 datetime 在 MCP 文本与 structuredContent 中编码不同，现已统一 JSON 值，未改变游标/提案哈希算法。
- 扩展统一验证 **78 passed / 1 failed**：周报测试账号未设置必需的 primary 组织关系；只修正隔离数据，保留原周报业务要求。专项 **7 passed / 17 deselected**（五动作/准备恢复/真实周报凭据）。
- 首次完整相关验证 **401 passed / 1 failed / 6 deselected**：截止时间相同瞬间的 UTC 与上海表示造成假 changed；已改按 UTC 时间点比较，并显式加入两种时区。`backend-before-timezone-fix.xml` 保存失败证据；专项 **2 passed / 23 deselected**（`timezone-readback.log`），最终完整套件再次验证。
- 所有写能力暂要求 include_future_objects=true；快照仍只读。科研只开放冻结的五类提案动作和任务编辑/状态；不含正式周报提交、任意文件上传、删除/批量破坏性操作、链/节点生命周期或任意资源编辑。
- 0209 仅在隔离库执行。业务部署需先应用兼容迁移；已有统一来源提案时，结构回退会主动阻止，不能转写假 grant/哈希或自动清理原提案。应先停用相关统一写连接并保留兼容 schema/代码；需要结构回退时，运维须先明确导出/处理这些记录。只有旧来源记录的往返迁移已实测可行。
- 已验证真实 SDK/API；真实 Codex/ScienceDiscovery Agent 导入、外部代理/TLS、真实 worker/通知投递及本阶段 GUI 未验。留待相应阶段，不以 SDK 替代目标 Agent 验收。未部署、未改业务数据库。

交付前停止本轮启动的隔离 PostgreSQL；保留数据库、保护副本与验证材料。下一轮设置 **EXECUTION_PHASE = 5**，实施统一连接页面与单份配置流程；本轮不进入阶段 5 或阶段 6。

## 2026-10-29 阶段 5：页面与配置简化（本轮）

### 基线、实施位置与保护

重新核实 Git 根目录 `D:\plane-main\plane-dev`，分支 `周报mcp-demo`、HEAD `8bea00299760808fd1775c3b3c6772971807138d`。适用根 AGENTS.md，相关路径无更深规则。开始时有 40 项既有修改/未跟踪文件，已逐文件保存摘要与副本；仅在原阶段 2 的 endpoints/urls 和两份计划文档上做本阶段必要扩展。其余既有交付以及原四份本机/运维文件保持原字节，证据 `.runtime/unified-mcp-phase5-20261029/initial-files.json`、`baseline/`、最终 `proof.json`。

本轮没有暂存、提交、推送、合并、创建分支/worktree/子 Agent、部署或迁移业务库；没有改写 .env、运行 setup.sh 或禁止的 Docker 测试栈。原服务中的 Redis/Celery 依赖保留；新功能未新增缓存、队列、锁、表、迁移或策略开关。

### 实际交付和改动文件

| 文件                                                                                               | 本阶段交付                                                                                                                                                                                     |
| -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/web/core/components/mcp/mcp-management.tsx`                                                  | 原个人设置 MCP 页面优先展示统一连接，保留原 PageHead/风格；兼容区域仅展开后挂载，默认不请求旧门户或逐节点内容                                                                                  |
| `unified-mcp-manager.tsx`（同目录，新增）                                                          | 名称→工作区（最多 20 个，完整分页）→各域不授权/只读/读写→生成单份配置；默认预选当前工作区；连接分页、重试、真实期限/最近使用、状态和确认撤销                                                   |
| `unified-config.ts`（同目录，新增）                                                                | 单个 `/api/mcp/` HTTP server 与 Bearer 配置校验，复用原 TOML/JSON 配置生成/下载；列表只保留白名单元数据，解析错误不回显配置/密钥                                                               |
| `legacy-mcp-management.tsx`（同目录，新增）                                                        | 搬入原页面连接、节点精细签发及撤销逻辑，明确兼容语义；没有给旧授权扩大范围或换发统一 token                                                                                                     |
| `existing-connections.tsx`（同目录）                                                               | 旧连接卡片显式标记“兼容连接”，保留原范围、能力与撤销                                                                                                                                           |
| `apps/web/core/services/unified-mcp.service.ts`（新增）                                            | 独立 Session 管理请求，沿用 API_BASE_URL；写入带 CSRF，错误脱敏，无机器凭据存储/全局登录拦截改动                                                                                               |
| `apps/api/plane/mcp/endpoints.py`、`urls.py`                                                       | 新增 Session-only `GET /api/mcp/connections/options/`，按原成员/私有工作区及科研策略返回可选域/能力、TTL、CSRF 与 owner 绑定的签名分页；不签发凭据，不预加载项目/节点；POST 仍重新验证实时权限 |
| `apps/api/plane/tests/contract/app/test_unified_mcp_options.py`（新增）                            | 4 项真实数据库验证：策略能力、分页/本人游标、权限退出/私有范围、Session 鉴权与输入、签发时再校验                                                                                               |
| `apps/web/tests/components/unified-mcp-management.test.tsx`、`unified-mcp-service.test.ts`（新增） | 14 项组件场景及 2 项请求测试；覆盖一连接/一配置、模式、分页、错误恢复、重复/过期响应、身份切换、密钥清除、撤销失败与恶意配置                                                                   |
| `apps/web/tests/components/mcp-management.test.tsx`                                                | 原 30 项旧管理逻辑继续测试独立兼容组件，个人设置集成显式展开兼容入口，新增兼容标记断言                                                                                                         |
| 本文、`unified-mcp-v1.md` 第 14 节                                                                 | 当前交付、复现入口、真实验证与限制，保留前四阶段历史                                                                                                                                           |

动态范围明确说明：包含所选工作区本人当前有权访问，以及未来新增且仍有权访问的项目、链、节点和任务；每次调用重新取当前权限交集。取消动态范围即创建已有对象快照，只读；选择读写而取消动态范围时阻止提交并说明原因，不静默降级。域能力以真实选项为准，不提供未启用的科研写选项；额度/权限变化由原签发服务再次拒绝。

密钥只在成功生成的内存结果中展示；关闭、修改范围/名称、切换上下文/用户、刷新或离开后清除。刷新列表不能恢复密钥；复制/导出需要用户主动操作，无 localStorage/sessionStorage 或 URL 保存。成功签发后禁止连续重复签发，需明确新建另一条；网络/5xx 结果不明确时先核对/刷新列表，不自动重试创建。撤销失败保留列表和错误；成功后清除配置并更新元数据，后续列表失败不会误报撤销失败。正式周报页面与 API Token 页面未改动。

### 验证环境、命令与实际结果

证据均在忽略目录 `.runtime/unified-mcp-phase5-20261029/`。复用已有 Python venv、MCP SDK 1.28.1、Node/Playwright 和阶段 2 原生 PostgreSQL 17.6 集群 `127.0.0.1:55448`，仅使用新建 `unified_mcp_phase5`、`test_unified_mcp_phase5`。前者空库真实执行已有迁移至 0209；后者为 pytest 专用同步表。没有连接业务库、真实 broker/worker/SMTP 或通知目标。

| 检查                  | 实际结果与证据                                                                                                                                                                                                                                                                                                      |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 后端最终相关回归      | **101 passed，180.72s，0 失败/跳过/排除**；统一选项 4、读取 22、行政写 28、科研写 25、旧管理 11、catalog 5、日志 6；`backend-final.log`、`backend-results.xml`。此前 options+读取 26 passed 不与最终数相加                                                                                                          |
| 前端相关回归          | **7 文件 86 passed**；统一页面 14、统一请求 2、旧管理 30、周报设置 21，以及原配置/下载/管理请求；`frontend-final.log`。周报页面源码未改动                                                                                                                                                                           |
| 前端类型和构建        | 在独立 `web/` 镜像执行 `react-router typegen` → `tsc --noEmit` → `react-router build` 全部退出 0；`typegen-final.log`、`types-final.log`、`build-final.log`。未写 `apps/web/build/client`，逐文件摘要和文件集合复核一致                                                                                             |
| 静态/模型             | Django check 无问题；makemigrations --check --dry-run 无变化；3 份相关后端文件 Ruff check/format 通过；4 份新/统一生产 TS 文件 oxlint 零警告；9 份改动 TS/TSX 文件 oxfmt check 通过；git diff --check 通过                                                                                                          |
| 真实页面创建/导出     | 专用 API 18553＋隔离 Vite 18552＋实际 Playwright 页面；真实 Session/CSRF、选择两个工作区、工作区一行政/科研读写＋工作区二双域只读、动态范围；创建 POST **恰好一次**，库中只有一条统一连接；实际 TOML、JSON 和下载文件均一个 server。截图 `unified-create-desktop.png`、`unified-generated-redacted.png`（凭据遮挡） |
| 真实 SDK 使用页面配置 | 从实际页面读取配置并在真实 TCP 上 initialize、三页 tools/list（15 工具）、tools/call；同一连接发现两个工作区/行政项目和两个科研节点，不切节点凭据；`browser-sdk-proof.json`、`browser-sdk.log`                                                                                                                      |
| 真实页面管理与失效    | 关闭/刷新后不再展示密钥；最近使用显示 SDK 调用时间；原旧节点连接仍可见且有兼容标识；页面确认撤销后数据库 revoked_at 已写入，同一配置调用返回 HTTP 401；`browser-proof.json`、`browser-db-proof.json`、`browser-revoked.log`、`unified-revoked.png`                                                                  |
| 原连接/业务数据保护   | 专用库原节点授权仍只有一条且 hash 不变，未创建旧 WriteGrant、提案或任务；原四文件及其余无需扩展的既有修改逐字节保留；`proof.json`                                                                                                                                                                                   |

可重复的后端验证入口（根目录；隔离 PostgreSQL 需先启动）：

```powershell
$env:PYTHONPATH = 'D:\plane-main\plane-dev\.runtime\unified-mcp-phase5-20261029;D:\plane-main\plane-dev\.runtime\unified-mcp-phase4-20261028;D:\plane-main\plane-dev\.runtime\unified-mcp-phase2-20261028;D:\plane-main\plane-dev\apps\api'
$env:DJANGO_SETTINGS_MODULE = 'unified_phase5_settings'
& '.runtime/mcp-management-validation/venv/Scripts/python.exe' -m pytest -c apps/api/pytest.ini apps/api/plane/tests/contract/app/test_unified_mcp_options.py apps/api/plane/tests/contract/app/test_unified_mcp.py apps/api/plane/tests/contract/app/test_unified_mcp_writes.py apps/api/plane/tests/contract/app/test_unified_mcp_research_writes.py apps/api/plane/tests/contract/app/test_mcp_management.py apps/api/plane/tests/unit/research/test_unified_mcp_catalog.py apps/api/plane/tests/unit/middleware/test_logger.py --reuse-db --nomigrations -q --tb=short -o addopts= -o junit_family=legacy
```

前端在 `apps/web` 执行 `vitest run --config vitest.config.ts`，选取 `tests/components/` 中 `unified-mcp-management.test.tsx`、`unified-mcp-service.test.ts`、`mcp-management.test.tsx`、`mcp-services.test.ts`、`mcp-config.test.ts`、`mcp-download.test.ts`、`weekly-report-settings.test.tsx` 七文件。构建只在隔离镜像运行：复制受影响源码和配置，node_modules 链接复用已有依赖，隔离 .env 指向 18552/18553；不读取/覆盖业务 .env 或正在服务的产物。真实页面脚本 `browser_check.cjs` 用于全新空库创建，`browser_finish.cjs` 是本轮复用已创建连接的撤销续验，不能在已撤销记录上直接重复创建验收。

### 中间发现、未验证项与下一阶段

- 首轮前端 83 通过/2 失败来自测试夹具：处理中按钮文字和非 observable 用户 mock；调整夹具后覆盖真实身份切换/请求中禁重复，最终 86 通过。中间一次单独执行 tsc 时缺失 React Router 自动类型；按 typegen→tsc 顺序最终通过，不将失败日志当通过。
- 真实页面第一次撤销脚本未匹配原弹窗英文默认 Delete；当时尚未发送撤销请求。已为统一撤销显式提供中文“确认撤销/取消”，并消除嵌套 p；重建后复用原连接继续验证，未重签发，实际已撤销/401。组件 mock 通过不替代该真实页面结果。
- **390px 窄屏存在原个人设置页固定侧栏/内边距裁切主内容的限制**，截图 `unified-mobile.png`。页面根 scrollWidth 未增大仍可能因内层 overflow 裁切，不据此宣称移动端通过。本阶段未扩大到全局设置布局或 API Token/周报页面重构；需在后续界面工作中解决并复验。
- 隔离环境旧门户 URL 有意不配置，旧门户显示配置提示；未验证真实旧门户网络服务。原节点连接真实记录和兼容展示已验证，旧页面逻辑 30 项回归通过。
- 本轮真实页面/SDK 验证创建、配置、读取、最近使用和撤销；行政/科研写服务回归包含于 101 项，但没有重跑阶段 6 的完整双域任务 GUI/Agent 闭环。SDK 不等于真实 Codex/ScienceDiscovery Agent 导入验收；目标 Agent、外部 TLS/代理及真实 worker/通知仍未验证。
- 阶段 3/4 历史六项既有问题保持原记录；本轮选取的七份后端文件不含那些用例，没有将它们计入本轮通过/排除数。未升级依赖、修改旧测试业务断言或把它们标为已修复。

交付前停止仅本轮启动的隔离 API、Vite 与原生 PostgreSQL，保留专用数据库和全部验证证据；测试用 UI 配置已撤销，私密 session/导出仅留忽略目录，不附入文档。**当前阶段 5 已完成，未部署；下一轮设置 EXECUTION_PHASE = 6，先读取本状态和契约再做完整集成/真实目标 Agent 及发布材料。本轮不自动进入阶段 6。**

## 2026-10-29 阶段 6：集成验收，以及用户追加的本机启动

### 基线与当前状态

实施位置再次核实为 `D:\plane-main\plane-dev`，分支 `周报mcp-demo`，HEAD `8bea00299760808fd1775c3b3c6772971807138d`。根 AGENTS.md 适用；初始 50 项修改已备份到 `.runtime/unified-mcp-phase6-20261029/baseline/` 并保存 SHA-256。未创建分支/worktree/子 Agent、暂存、提交、推送或合并。

用户随后要求“启动本地 plane 我来验收”，本轮据此启动原有 Windows 本机环境，入口 **http://localhost:3000/settings/profile/mcp/**，使用原账号登录。该动作是用户追加授权的本机启动；远端服务器没有部署。阶段 6 仍在验收中，不能将下面有失败的完整回归标为全通过；没有下一阶段，也未自动推进。

### 已完成的实际交付

- 新增 `apps/api/plane/tests/contract/app/test_unified_mcp_acceptance.py`：真实 Session/CSRF 签发的一份配置，真实 MCP SDK/TCP，15 工具分页、两工作区、同名候选、行政创建/编辑/负责人/日期/状态/评论、科研两节点提案/编辑/评论/取消/读回，其中一个节点在签发后新增；重复请求不产生重复对象，退出成员在已初始化会话中即时生效，错误域/ID/工作区和科研 Project 外壳被拒绝，最后撤销返回 401。另有实际 HTTP 客户端 ReadTimeout：服务器真实提交后暂缓响应，客户端超时，随后只查询原 request_id，查回 COMMITTED 且任务只有一个。
- 真实 Codex CLI 首次启动暴露协议差异：tools/list 带标准 `_meta.progressToken`，原统一入口只允许 cursor，错误拒绝。已在 `apps/api/plane/mcp/endpoints.py` 最小修复：允许并忽略请求级字典元数据，保留分页与闭合业务参数，拒绝非对象元数据。未将 `_meta` 转为授权或业务输入；新增对应回归，不升级协议或依赖。
- 新增 `scripts/unified-mcp-agent-acceptance.py`：调用已安装、已登录的真实 Codex CLI；只接受本机隔离服务器的一份 UI 导出配置，Bearer 只放进该进程的环境，使用 ephemeral/ignore-user-config，不改现有客户端配置。保存私密事件与不含凭据的证明，明确记录工具失败，不将 SDK 当作 Agent。
- 真客户端版本 **codex-cli 0.165.0-alpha.1.2**。从真实页面下载的同一份配置提取单 server URL/凭据，经 `bearer_token_env_var` 接入；真实模型自主发现两个工作区和行政/科研对象，并完成行政任务创建→编辑标题/期限→评论→读回，科研 prepare/execute 创建→编辑→评论 prepare/execute→取消→读回。21 次调用中 20 次成功；一次模型误用 target 代替 node 被闭合 schema 拒绝，模型改为 node、复用原 request_id 后成功。没有 shell/文件/网页/其他 MCP 调用，未创建额外授权或人工批准记录。数据库核对标题、期限、两条评论各一次、取消状态、2 条 COMMITTED 提案及原节点授权 hash 均符合预期。
- 发布/迁移/回退说明与单份配置示例见 `docs/operations/unified-mcp-v1-release.md`。ScienceDiscovery 真实 Agent、远端 TLS/代理和本机之外部署仍未验收；不能因通用 JSON/SDK 或容器启动而标成通过。

### 验证记录与未收尾项

证据目录 `.runtime/unified-mcp-phase6-20261029/`；复用已有原生 PostgreSQL 17.6 的 55448 隔离集群，仅使用 `unified_mcp_phase6`（真实空库迁移至 0209）和 `test_unified_mcp_phase6`。模拟数据绝不写入原本机业务库。异步行政副作用沿用前阶段仅在验证进程内执行原任务体的适配，不等于真实 worker/SMTP 验收。

| 验证                    | 实际结果                                                                                                                                                                                                                                                                                                                                                                 |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 新双域/超时集成         | 首轮 1 passed / 1 failed：成员退出后的错误预期应为原策略 scope_denied，已修正测试；随后 **2 passed**，`integration.xml/log`                                                                                                                                                                                                                                              |
| 协议修复后相关读取/集成 | **25 passed，90.84s**，`transport-final.xml/log`；含标准请求元数据、闭合业务输入、同配置双域和真实超时恢复                                                                                                                                                                                                                                                               |
| 扩展相关后端回归        | **408 passed / 1 failed / 6 deselected，362.37s**，`backend-acceptance.xml/log`。失败是原 `test_research_chain_tasks.py::TestResearchChainNodeTaskApi::test_create_assign_submit_return_resubmit_and_complete` 对未 order_by 的事件查询要求固定顺序，实际 TASK_COMPLETED 排首；尚未完成基线复现/修复，不标通过。此运行早于元数据修复；修复后 25 项另列，不把两次次数相加 |
| 前端                    | 七文件 **86 passed**；阶段 6 隔离镜像 typegen、tsc、build 均退出 0；本机实际 Web 亦已重新构建成功。日志 `frontend.log`、`typegen.log`、`types.log`、`build.log`；本机日志见下文                                                                                                                                                                                          |
| 真实页面与 Agent        | UI 一次创建/导出、两个工作区双域读写、单 server、关闭/刷新清除密钥；`browser-create-proof.json`。Agent 事件 `codex-agent-final/events.private.jsonl`，安全摘要 `proof.json`，独立真实数据库核对 `agent-db-proof.json`。截图 `page-current-desktop.png`、`page-current-connections.png`、`created-config-redacted.png`                                                    |
| 静态                    | 新增集成用例、客户端验证脚本、修改的统一入口 Ruff check/format 通过                                                                                                                                                                                                                                                                                                      |

完整回归旧六项排除仍沿用阶段 3/4 已记录的四参数成员拒绝码、邀请准入和历史 0171 迁移排序不稳定项；没有把它们计为通过。新发现的原生事件顺序失败没有被排除或修改断言来凑通过数。390px 设置页外框裁切仍为阶段 5 已记录限制，未顺带重构其他设置页面。

### 用户追加要求：启动本机 Plane 供验收（已实际执行）

原有本机入口不是远端部署的 3300，而是 Windows 助手管理的 `http://localhost:3000`，API 为 `http://localhost:8001`。最初 Docker Desktop 和原服务均停止。本轮启动已安装的 Docker Desktop，沿用 `pilab-windows` 的原数据库、附件、Redis、MQ 卷和配置，无替代卷、清库或账号重置。

执行前保存 `.runtime/windows-start-20261029-unified-mcp/plane-before.dump`（pg_dump 自定义格式，pg_restore --list 成功）、`web-build-before/`，并对六份现有 .env 保存摘要。旧后端镜像保留为 `pilab-windows-backend:before-unified-mcp-20261029`。首次启动被旧镜像缺少已在仓库声明的 markdown-it-py 阻断，迁移未执行；比较确认其余固定 base 依赖版本一致，仅补 **markdown-it-py==4.2.0** 及其正常依赖到本地增量镜像，不修改仓库依赖或用户配置。

随后预检迁移计划，按现有 `deployments/windows/start-local.ps1 -Action Start` 成功执行原库待办 **0205、0206、0207、0208、0209**，启动 API/worker/beat、原行政 MCP 和 Web/Admin/Space/Live。本机 Web 单独使用已有依赖重新构建当前源码；没有运行 Prepare 安装全仓依赖、setup.sh、被禁用 Docker 测试栈或 down -v。受保护的原 Windows 脚本和运维文档未改。

实测 API health、Web 首页、`/settings/profile/mcp/`、代理 `/api/instances/` 全部 HTTP 200；四个前端及原行政 MCP 均运行。六份原 .env 摘要一致。启动、迁移、构建、备份和健康证明在 `.runtime/windows-start-20261029-unified-mcp/`，该目录是私密本机恢复材料，不提交或分享。已为用户打开 MCP 验收入口；使用原邮箱密码，不把隔离账号当成本机账号。

**本机验收服务保持运行。阶段 6 仍待原生事件排序回归收尾、最终发布验收记录和用户人工验收反馈；后续继续使用 EXECUTION_PHASE = 6，不存在自动进入的阶段 7。**

## 2026-10-29 后续请求：同步最新 develop（不是新执行阶段）

已将 origin/develop `194f1320` 合入当前分支，合并提交 `f055b860`；解决科研报告共享提交与上游审批路由冲突，保留初始 52 项本地改动与备份 stash。统一科研任务适配最新原生 complete/reopen/cancel，原阶段 4 的 submit/return/审核人完成描述仅为历史版本记录，不代表当前规则。周报提交必须显式选审核人，MCP 提案保留该选择并在执行时再验证。原凭据、提案哈希及已应用迁移未重写。

新增 0210 空合并迁移衔接两支 0209；专用隔离库迁移、Django/模型检查、后端 200 项、类型及隔离构建通过。前端十文件 94 通过/20 失败，失败集中在与上游相同的科研面板测试，尚未宣称全前端通过。Windows 依赖构建误包含主应用后已恢复先前验收版预览；未重启后端、执行新业务迁移或推送。详细命令、证据和限制见 `D:\plane-main\output\develop-sync-2026-10-29.md`。阶段 6 仍按原待办收尾，不自动部署新 develop。

### develop 同步继续后的最终结果（2026-10-29）

继续期间远端更新到 `48bf0767`，已再次合入当前分支，最终 HEAD `71d22dbe`。第二轮 5 处周报相关文本冲突采用完整上游审批实现并保留共享事务回滚验证；原有未提交工作与两轮备份 stash 均保留。新增 0211 空迁移衔接上游 0210 周报合并与本地 0210 统一分支，专用库增量升级成功，未迁移业务库。

前节科研面板 20 项失败已定位为测试首次动态加载超时；仅改测试导入位置，不放宽断言，最新十文件 **114 passed**。最新后端组合 **207 passed / 1 failed**（隔离内存缓存缺 keys）；补齐隔离缓存接口后受影响权限文件 **4 passed**，包含该失败项，业务权限代码不变。类型、隔离构建、Django/模型及静态检查通过；第一轮 200 项属于旧远端版本，不与第二轮相加。

运行环境仍为此前验收版，未部署新 develop；第二轮构建明确排除主应用并验证预览文件摘要未变。完整过程、先前误构建恢复说明、备份与证据见 `D:\plane-main\output\develop-sync-2026-10-29.md`。当前没有未解决 Git 冲突，阶段 6 及部署不自动推进。

## 2026-10-29 用户追加：删除 MCP 配置底部旧版入口

已从 MCP 设置主页面移除“兼容与精细范围连接”及其旧行政/科研管理组件的加载入口，同时删除统一连接列表中“展开下方兼容区域”的提示。统一连接的工作区选择、生成配置、列表与撤销流程继续保留。旧连接记录、服务端接口及业务数据未删除。

针对入口更新现有组件验证：个人设置不加载旧行政/科研服务，旧 URL 参数不展示凭据，仍可生成统一配置；保留旧组件独立权限验证。六个 MCP 测试文件 **66 passed**；最新源码隔离 typegen、tsc 均通过；修改的生产组件及原 MCP 测试文件严格 lint 通过。统一管理测试文件原有循环中的两条 no-await-in-loop 警告未顺带修改。

本机运行中的验收版前端已仅应用这两处页面源码修改，重新构建并更新 `apps/web/build/client`，未部署其余新 develop 页面或重启后端、执行业务迁移。页面 `http://localhost:3000/settings/profile/mcp/`、新 MCP 资源及现有 API instances 均 HTTP 200；校验新构建不含被删入口或提示，实际服务内容与新构建一致。刷新页面即可验收。

原修改文件及更新前的完整前端构建保存在 `.runtime/remove-legacy-mcp-20261029/`；测试、类型、构建日志及 `deployment-proof.json` 同目录。此次为独立页面调整，不改变阶段 6 的历史验收状态。

## 2026-10-29 用户授权提交 GitHub：提交前复核

目标为 GitHub `SynlysAI/plane` 的 `develop` 合并请求，提交分支 `codex/unified-mcp-20261029`。提交前重新 fetch 确认最新 develop 为 `48bf0767895a1a1b0a4f75a04adea061e57b66c9`，已被本地完整包含，没有未解决冲突。合并请求覆盖统一 MCP 连接、双域导航/写入、迁移、设置页和旧版区域移除；不自动合并或部署远端。

原 Windows 前端脚本、科研 v2.1 运维说明和两份历史运维文档继续留在本地，不混入此次提交。补充跟踪文档引用的独立 Agent 验证脚本，排除 .env、.runtime、数据库与页面构建备份。三份周报契约文档恢复最新 develop 内容，避免历史合并结果覆盖新审批契约。

最新前端十文件 **117 passed**；原名称校验用例改为参数化，保留全部输入断言，严格 lint 的循环警告已消除。新入口和脚本 Ruff 检查通过，相关前端严格 lint 通过；凭据扫描未发现真实密钥。类型和页面构建沿用本轮删除入口后的成功验证，生产源码未再修改。后端沿用同步后的 **207 passed / 1 failed** 加受影响文件 **4 passed** 复验结果，详细环境原因见前节，不将两轮数字相加或宣称同次全通过。

提交前快照、文件清单、凭据扫描和最新前端日志在本机忽略目录 `.runtime/unified-mcp-pr-20261029/`，不随合并请求发布。ScienceDiscovery 目标 Agent 验证、生产升级及发布验收仍需按发布说明执行。
