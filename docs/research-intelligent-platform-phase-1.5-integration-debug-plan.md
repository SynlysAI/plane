# 科研智能体平台 Phase 1.5 联调与缺陷收敛计划

| 项目     | 内容                                                                                                                                                                                           |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 计划版本 | v1.3                                                                                                                                                                                           |
| 上游 PRD | [`research-intelligent-platform-prd.md`](./research-intelligent-platform-prd.md) §4–§10                                                                                                        |
| 前置计划 | [`research-intelligent-platform-phase-1-plan.md`](./research-intelligent-platform-phase-1-plan.md)                                                                                             |
| 后续计划 | [`research-intelligent-platform-phase-2-plan.md`](./research-intelligent-platform-phase-2-plan.md)                                                                                             |
| 执行手册 | [`research-intelligent-platform-phase-1.5-execution-runbook.md`](./research-intelligent-platform-phase-1.5-execution-runbook.md)                                                               |
| 人工测试 | [`research-intelligent-platform-phase-1.5-role-validation-manual-test-plan.md`](./research-intelligent-platform-phase-1.5-role-validation-manual-test-plan.md)                                 |
| 计划状态 | dev 五服务已启动并完成健康检查；真实课题证据、Tailnet HTTPS Serve 授权和 OIDC 绑定仍待完成，不标记为完全关闭                                                                                   |
| 执行模式 | 单人执行；A / B 保留为职责自查分区标签（见 §8）                                                                                                                                                |
| 修订记录 | v1.3（2026-09-26）：接入 `identity/me.user.role_context` 分角色解析和契约测试；补充分角色开发/人工测试入口、dev/Tailnet 启动口径和当前健康检查结论；保留真实课题、HTTPS Serve 与 OIDC 灰度门禁 |
| 目标     | 在 Phase 1 代码交付基础上拉通开发环境真实联调，完成基础功能验证，收敛跨服务缺陷，为 Phase 2 提供可用的联调环境                                                                                 |
| 不在范围 | 新业务功能、垂类工具生产化、生产灰度放量                                                                                                                                                       |

## 1. 背景与问题定位

Phase 1 的 Chain、RAGPortal BFF、Synlora MVP 与四入口 IA 均已按验收手册完成本地验证。2026-09-26 已按本计划拉起 Plane 栈（API / worker / beat / web / 依赖容器）、Synlora、RAGPortal，并确认 WeKnora 内网实例可达；以下链路进入当前 dev 环境的分角色人工验证：

- Plane → Synlora 的 delegated token、capability manifest、`agent-context.v2` 与事件投影。
- Plane → RAGPortal 的上传转发、状态轮询与引用确认。
- RAGPortal → WeKnora 的入库、解析与知识库检索。
- Synlora / RAGPortal 回连 Plane 的认证与账号绑定。

WeKnora 已部署在内网 `http://10.26.15.93:8000/`（从 plane-api 容器实测可达），不在本项目中开发。Phase 1 灰度手册第 3 节“准备外部服务”一步因此无法执行，试点灰度被阻塞。

Phase 1.5 的定位：**不新增业务功能**，只做三件事——拉通开发环境、完成基础功能验证、修复联调发现的缺陷。完成后再进入 Phase 2 实验运行能力开发。

## 2. 阶段目标与出口条件

### 2.1 目标

1. **环境拉通**：按本手册可在开发机上拉起 Plane + Synlora + RAGPortal，WeKnora 使用已部署实例，五个服务健康检查全部通过。
2. **基础功能验证**：完成六层验证（服务健康 → 单服务契约 → 双服务链路 → 功能选项矩阵 → 角色矩阵 → 端到端闭环），覆盖 Phase 1 出口场景与全部工作区开关、五档研究身份。
3. **缺陷收敛**：联调发现的 P0/P1 缺陷全部修复并回归通过，P2 缺陷有明确处理时限。

### 2.2 出口条件

- [x] 五个服务健康检查通过（见 §4 自检清单）。
- [x] Synlora delegated token 交换、capability manifest、`agent-context.v2` 每轮复验在真实服务间通过。
- [x] RAGPortal 经 Plane BFF 上传一份真实文档到 WeKnora，解析状态可轮询、引用可确认。
- [x] 功能开关全量矩阵通过：5 个开关逐项 ON/OFF，关闭时入口降级、API 返回禁用口径、既有数据只读不受损、其余开关功能不受影响（见执行手册 L3.5）。
- [x] 角色功能矩阵通过：5 档 ResearchLevel + Guest 负例的导航、课题可见性、审批、Agent、知识、绑定与导出权限逐格验证（见执行手册 L3.6）。
- [x] 一次完整端到端闭环：双课题创建 → 上传入库 → Agent 会话与检索 → 事件回放 → 快照导出。
- [x] 降级演练通过：分别停止 Synlora、停止 RAGPortal、模拟 WeKnora key 失效，Chain 人工记录路径均不受阻断，恢复后自动重连。
- [x] 联调缺陷清单中 P0/P1 全部关闭，每条有根因、修复提交与回归证据。
- [x] Phase 1 灰度手册“准备外部服务”与“内部试点”两节可在本环境完整执行。

## 3. 开发环境拓扑

### 3.1 服务与端口矩阵

| 服务           | 进程形态                                       | 监听地址                                                                      | 健康检查             | 负责人 |
| -------------- | ---------------------------------------------- | ----------------------------------------------------------------------------- | -------------------- | ------ |
| Plane Web      | 既有开发栈                                     | `http://100.109.35.2:3000`（Tailnet） / `http://192.168.3.245:3000`（局域网） | 页面可登录           | A      |
| Plane API      | Docker `plane-api-1`，宿主机 8001 → 容器 8000  | `http://127.0.0.1:8001`                                                       | 登录 / 科研接口可用  | A      |
| Plane 异步     | Docker `plane-worker-1`、`plane-beat-worker-1` | 容器内                                                                        | `docker ps` 状态正常 | A      |
| Synlora        | 宿主机 `python run_uvicorn.py`                 | `0.0.0.0:8005`                                                                | `GET /api/health`    | B      |
| RAGPortal      | 宿主机 uvicorn                                 | `0.0.0.0:8004`                                                                | `GET /api/health`    | B      |
| RAGPortal 前端 | 宿主机 Vite（可选，人工核对入库状态用）        | `http://localhost:3002`                                                       | 页面可打开           | B      |
| WeKnora        | 已部署内网服务，不自建                         | `http://10.26.15.93:8000/`                                                    | HTTP 可达（已实测）  | B 对接 |

### 3.2 网络连通矩阵

plane-api 容器位于 `plane_dev_env` Docker 网络，默认网关为 `172.19.0.1`（以 `docker exec plane-api-1 ip route` 的 `default via` 为准）。容器访问宿主机服务必须走该网关地址，宿主机服务必须监听 `0.0.0.0` 而非 `127.0.0.1`。

| 发起方              | 目标      | 地址                        | 关键前提                         |
| ------------------- | --------- | --------------------------- | -------------------------------- |
| plane-api 容器      | Synlora   | `http://172.19.0.1:8005`    | Synlora `HOST=0.0.0.0`           |
| plane-api 容器      | RAGPortal | `http://172.19.0.1:8004`    | uvicorn `--host 0.0.0.0`         |
| Synlora（宿主机）   | Plane API | `http://127.0.0.1:8001`     | Docker 端口映射已存在            |
| RAGPortal（宿主机） | Plane API | `http://127.0.0.1:8001`     | 同上                             |
| RAGPortal（宿主机） | WeKnora   | `http://10.26.15.93:8000`   | 内网可达，携带 `WEKNORA_API_KEY` |
| 浏览器              | Plane Web | `http://192.168.3.245:3000` | 与 `WEB_URL`、CORS 口径一致      |

> 换机器部署时，`172.19.0.1` 需按 plane-api 所在 Docker 网络的实际网关调整；`192.168.3.245` 需换成本机局域网 IP。

### 3.3 环境变量与凭证矩阵

#### Plane（`plane/apps/api/.env`，修改后重启 plane-api / worker / beat 容器）

```bash
# Synlora 服务地址（容器视角，走 Docker 网关）
SYNLORA_BASE_URL="http://172.19.0.1:8005"
# 与 Synlora 侧 PLANE_SERVICE_TOKEN 使用同一随机串
SYNLORA_SERVICE_TOKEN="<共享服务凭证>"
# 联调期放宽超时，避免首轮冷启动误判降级
SYNLORA_TIMEOUT_SECONDS=15
# RAGPortal 集成连接的凭证引用（ExternalSystemConnection.credential_ref 指向）
RAGPORTAL_AUTH_SECRET="<与 RAGPortal AUTH_SECRET 一致>"
```

#### Synlora（`Synlora/apps/web/backend/.env`）

```bash
AUTH_SECRET="<与 Plane / RAGPortal 口径一致>"
AUTH_ENABLED=true
PLANE_BASE_URL="http://127.0.0.1:8001"
PLANE_API_TOKEN="<A 在 Plane 侧创建并提供>"
PLANE_SERVICE_TOKEN="<与 Plane SYNLORA_SERVICE_TOKEN 一致>"
# 如启用 knowledge.list / knowledge.search 工具
WEKNORA_BASE_URL="http://10.26.15.93:8000/api/v1"
WEKNORA_API_KEY="<WeKnora 受控 key>"
```

> Synlora 部署硬约束：**必须单实例**（uvicorn `workers=1`），多副本会导致插话、问答回填与取消失效。

#### RAGPortal（`RAGPortal/.env`，后端从 `../.env` 读取）

```bash
AUTH_SECRET="<与 Plane 口径一致>"
AI4MS_BASE_URL="http://127.0.0.1:8001"
AI4MS_PORTAL_URL="http://192.168.3.245:3000"
WEKNORA_BASE_URL="http://10.26.15.93:8000"
WEKNORA_API_KEY="<WeKnora scoped key>"
FRONTEND_ORIGIN="http://localhost:3002"
```

#### Plane 侧 RAGPortal 集成连接

Plane 调用 RAGPortal 不走环境变量 base URL，而是通过 `ExternalSystemConnection` 记录：A 在科研管理 / 集成界面录入 `base_url=http://172.19.0.1:8004`，`credential_ref=RAGPORTAL_AUTH_SECRET`，并启用连接。

#### 工作区开关矩阵

联调工作区开启 `research_account_link_enabled`、`research_external_rag_enabled`、`research_chain_enabled`、`research_agent_enabled`；其他工作区保持关闭，`research_ia_v2` 按灰度手册默认开启。任一链路故障时先关对应写入开关再排查，不删除 AccountLink。

开关自身的 ON/OFF 行为、数据只读保护与相互独立性验证见执行手册 L3.5；本节口径只是联调基线配置，不替代开关测试。

## 4. 启动顺序与健康自检

按以下顺序拉起服务，每步自检通过后再进行下一步：

| 步骤 | 动作                                                                                                                | 自检命令与预期                                                                                                                                                     | 负责人 |
| ---- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------ |
| 1    | 确认 WeKnora 可达（已部署，无需启动）                                                                               | `curl -s http://10.26.15.93:8000/` 返回 HTTP 响应（非超时/拒绝）                                                                                                   | B      |
| 2    | 配置并启动 RAGPortal：`cd RAGPortal/backend && .venv/bin/python -m uvicorn app.main:app --host 0.0.0.0 --port 8004` | `curl -s http://127.0.0.1:8004/api/health` 返回正常 JSON                                                                                                           | B      |
| 3    | 配置并启动 Synlora：`cd Synlora/apps/web/backend && .venv/bin/python run_uvicorn.py`（默认 `0.0.0.0:8005`）         | `curl -s http://127.0.0.1:8005/api/health` 返回正常 JSON                                                                                                           | B      |
| 4    | A 更新 `plane/apps/api/.env` 后重建 Plane 容器                                                                      | `docker compose -f docker-compose-local.yml -f docker-compose-local.override.yml up -d --force-recreate --no-deps api worker beat-worker`；`docker ps` 确认容器 Up | A      |
| 5    | 从容器内验证两个上游服务                                                                                            | 容器内 Python urllib 访问 `http://172.19.0.1:8004/api/health` 与 `:8005/api/health` 均通（API 镜像不含 curl）                                                      | A      |
| 6    | 录入 RAGPortal `ExternalSystemConnection` 并启用                                                                    | 科研管理 / 集成界面连接测试返回 success，非 `not_configured`                                                                                                       | A      |
| 7    | 开启联调工作区四个 research 开关，绑定 Synlora AccountLink                                                          | 试点学生账号 AccountLink 状态 ACTIVE                                                                                                                               | A      |

## 5. 分层联调与基础功能验证

### 5.1 L1：服务健康

按 §4 自检清单逐项通过，并记录每次联调开始时的五服务健康快照（服务、时间、状态、版本/提交号）。

### 5.2 L2：单服务契约回归

在真实联调前先跑各仓快速测试子集，确保单服务基线可用：

```bash
# Plane API contract
cd plane/apps/api && docker exec plane-api-tests-live pytest -q \
  plane/tests/contract/app/test_research_phase1_e2e.py \
  plane/tests/contract/app/test_research_agent_orchestrator.py

# Synlora
cd Synlora/apps/web/backend && AUTH_SECRET=test-secret .venv/bin/pytest -q \
  tests/test_research_context.py \
  tests/test_research_agent_contracts.py \
  tests/test_runtime_assembly.py \
  tests/test_session_runtime.py

# RAGPortal
cd RAGPortal/backend && AUTH_SECRET=test-secret \
  AI4MS_BASE_URL=http://ai4ms.test \
  AI4MS_PORTAL_URL=http://ai4ms.test \
  WEKNORA_BASE_URL=http://weknora.test \
  WEKNORA_API_KEY=test-key \
  .venv/bin/pytest -q
```

> 环境口径说明：当前联调机的 RAGPortal 服务与契约测试均使用 `RAGPortal/backend/.venv`；Synlora 同样使用后端仓内 `.venv`。不要混用其他项目的 Python 环境。

### 5.3 L3：双服务链路验证

| 链路                 | 验证内容                                                                                                                  | 通过标准                                                        | 主责 | 协作 |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | ---- | ---- |
| Plane ↔ Synlora      | delegated token 交换、capability manifest 拉取、`agent-context.v2` 创建会话、每轮复验、`allowed_tools` 交集、事件游标消费 | 无 401/403；事件按 `after_seq` 单调回放，`(run_id, seq)` 无重复 | A    | B    |
| Plane ↔ RAGPortal    | BFF 知识库列表、作用域上传、sha256 校验、状态轮询、引用确认、降级人工路径                                                 | 上传返回 `knowledge_id/kb_id/task_id`；引用写入外部引用表       | A    | B    |
| RAGPortal ↔ WeKnora  | 真实文档上传、解析任务状态流转、KB 列表刷新                                                                               | 文档在 WeKnora 可检索到条目                                     | B    | —    |
| Synlora → Plane 回连 | `PLANE_BASE_URL` 认证代理、`PLANE_API_TOKEN` 有效性、`PLANE_SERVICE_TOKEN` 验签                                           | 回连请求无认证失败日志                                          | B    | A    |

### 5.3.5 L3.5：功能选项矩阵

对 5 个工作区开关（`research_chain_enabled`、`research_agent_enabled`、`research_external_rag_enabled`、`research_account_link_enabled`、`research_ia_v2`）执行逐项 ON/OFF 全量矩阵：每次只关一个，验证入口降级、API 禁用口径、既有数据只读不受损、其余开关独立性，恢复后回归；另验证总开关关闭时子开关的联动失效。完整用例、操作步骤与勾选表见执行手册 L3.5。

### 5.3.6 L3.6：角色矩阵

按当前 `public` π-Lab Excel 基线动态解析主 PI、产业化负责人、直接导师、学生、管理员和访客；不再复用旧 seed 账号。主课题绑定 WeKnora/RAGPortal 测试知识库 `plane测试`，逐格验证四入口导航、WORKSPACE/PRIVATE 可见性、审批、Agent、KB 上传与引用、AccountLink 和导出。完整角色解析、mock 课题、逐格矩阵与负例见 [分角色开发计划](./research-intelligent-platform-phase-1.5-role-validation-development-plan.md) 和 [人工测试计划](./research-intelligent-platform-phase-1.5-role-validation-manual-test-plan.md)。

### 5.4 L4：端到端闭环（Phase 1 出口场景）

1. **双课题与 ACL**：一个学生创建公开 + 隔离两个 `RESEARCH_CHAIN` 课题，验证页面、API、Context、导出路径权限一致，Guest 负例生效；随后按 L3.6 角色矩阵逐格复验导师、PI、同组学生、上级节点 PI、无关系成员与 Guest 的可见性与写权限。
2. **上传入库引用**：课题节点上传 PDF → RAGPortal → WeKnora 解析 → 状态轮询 → 引用确认；同 `sha256 + chain_id + node_id` 幂等。
3. **Agent 会话与检索**：Plane 自动装配 persona / 插件 / 工具白名单创建 Synlora 会话；Agent 使用 `knowledge.search` 命中已入库文档；事件投影为 Agent run event 与 Chain event。
4. **计划实验分析沉淀**：调研 → AI 讨论/选题 → 研究计划 → 实验记录 → 分析 → 人工确认生成 typed snapshot → Markdown 导出并核对 `X-Research-Chain-SHA256`。
5. **降级演练**：三项——`Ctrl+C` 停 Synlora、停 RAGPortal、将 `WEKNORA_API_KEY` 临时改为无效值模拟 WeKnora 失效；确认 Chain 人工记录均不受阻断、页面显示中文原因与人工路径；恢复后自动重连、入库可重测、事件不重复。

## 6. Debug 手段与常见故障排查

### 6.1 日志与观测

| 观测点                  | 位置 / 方式                                                             | 关注内容                                   |
| ----------------------- | ----------------------------------------------------------------------- | ------------------------------------------ |
| Plane API / worker 日志 | `docker logs -f plane-api-1` / `plane-worker-1` / `plane-beat-worker-1` | 5xx、integration 调用失败、事件投影异常    |
| IntegrationCallLog      | Plane 数据库 `integration.call` 记录                                    | success/degraded 比例、latency、request_id |
| Synlora 日志            | 启动终端                                                                | delegated token 验签失败、工具调用异常     |
| RAGPortal 日志          | 启动终端                                                                | WeKnora 401、上传校验失败、解析超时        |
| 事件游标                | Synlora event 流 + Plane 投影日志                                       | cursor 单调性、`(run_id, seq)` 去重        |

### 6.2 常见故障速查表

| 症状                               | 高概率原因                                    | 处理                                                           |
| ---------------------------------- | --------------------------------------------- | -------------------------------------------------------------- |
| plane-api 容器访问 8004/8005 超时  | 宿主机服务只监听 `127.0.0.1`                  | RAGPortal 加 `--host 0.0.0.0`；确认 Synlora `HOST=0.0.0.0`     |
| 容器访问网关地址不通               | 使用了错误的 Docker 网关                      | `docker exec plane-api-1 ip route` 重新确认 `default via` 地址 |
| Synlora / RAGPortal 回连 Plane 401 | `PLANE_API_TOKEN` 失效或 `AUTH_SECRET` 不一致 | A 重新签发 token；三方核对 `AUTH_SECRET` 口径                  |
| RAGPortal → WeKnora 401            | `WEKNORA_API_KEY` 无效或过期                  | B 更换 scoped key 并重测 `/api/health` 与 KB list              |
| Agent 会话创建即过期               | `RESEARCH_CONTEXT_TOKEN_TTL_SECONDS` 过短     | 联调期适当调大 TTL，排查时钟偏差                               |
| Chain 事件重复                     | 事件游标重放未去重                            | A 检查 `after_seq` 与 `(run_id, seq)` 幂等逻辑                 |
| 上传一直解析中                     | WeKnora 任务积压或回调丢失                    | B 在 WeKnora 侧核对任务状态，RAGPortal 手动触发状态刷新        |
| 页面显示 `not_configured`          | RAGPortal 集成连接未录入或未启用              | A 检查 `ExternalSystemConnection` 的 base_url / credential_ref |

### 6.3 联调纪律

- 只使用联调工作区与测试账号，不写入生产数据。
- 缺陷先登记清单再修复，禁止“顺手改、不记录”。
- 任何接口口径变更必须先完成两侧契约实现自查确认，再动代码。
- 每个修复必须跑 §5.2 对应回归子集 + 触发该缺陷的原始场景。

## 7. 缺陷记录与修复流程

### 7.1 缺陷清单字段

统一登记在[执行手册](./research-intelligent-platform-phase-1.5-execution-runbook.md)附录 A 的联调缺陷表中，字段包括：编号、发现日期、层级（L1–L4）、严重度（P0–P3）、负责分区（Plane 侧 / 外部服务侧 / 共同）、复现步骤、预期与实际、根因、修复提交、回归证据、状态。单人模式下缺陷当日登记、不过夜。

| 严重度 | 定义                                      | 处理时限         |
| ------ | ----------------------------------------- | ---------------- |
| P0     | 数据丢失/越权/五服务无法连通/闭环完全阻断 | 当日修复         |
| P1     | 核心链路功能错误但有人工绕行              | 2 个工作日内     |
| P2     | 非核心功能、体验问题、日志与文案          | Phase 1.5 内修复 |
| P3     | 优化建议                                  | 转入 Phase 2     |

### 7.2 修复流程

1. **复现**：按登记步骤最小化复现，固定测试数据与请求。
2. **定界**：按 §3.2 连通矩阵与 §6.1 日志判定缺陷归属（Plane / Synlora / RAGPortal / WeKnora 配置 / 契约口径）。
3. **修复**：归属方在自己的仓内修复；契约类缺陷先完成两侧契约实现自查确认，再双侧修改。
4. **回归**：跑 §5.2 对应子集 + 原始复现场景，留截图或日志。
5. **关闭**：清单更新根因、提交号与证据，按执行手册勾选闭环。

## 8. 单人执行与职责分区

本期由单人使用一台开发机与一套联调环境执行（避免环境漂移）。原 A / B 分工保留为**职责自查分区标签**：每条链路验证时先按“Plane 侧”自查，再切换到“外部服务侧”自查，防止只看单侧日志造成定界遗漏。跨服务契约变更由同一人完成两侧实现核对后再动代码。

### 8.1 职责自查分区

| 职责领域                 | Plane 侧（原 A）                                                    | 外部服务侧（原 B，Synlora 及其他组件）                                                           |
| ------------------------ | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| 环境维护                 | Plane 容器栈启停、迁移、`.env`、工作区开关、测试账号                | Synlora 8005 拉起（单实例）、RAGPortal 8004 拉起、WeKnora 连通与 key                             |
| 凭证管理                 | 签发 `PLANE_API_TOKEN`、共享 `SYNLORA_SERVICE_TOKEN`、录入集成连接  | 配置 `PLANE_BASE_URL/PLANE_API_TOKEN/PLANE_SERVICE_TOKEN`、`WEKNORA_API_KEY`、对齐 `AUTH_SECRET` |
| Plane ↔ Synlora 链路     | delegated token 签发、Context v2 组装、事件投影/去重/快照、Agent UI | token 验签、capability manifest、每轮复验、`allowed_tools` 交集、event cursor                    |
| Plane ↔ RAGPortal 链路   | BFF 四接口、上传转发、状态轮询、引用、降级路径                      | `/api/kb/list`、`/api/uploads`、`/api/health` 契约实现与错误码                                   |
| RAGPortal ↔ WeKnora 链路 | —                                                                   | 上传、解析状态、KB 列表、检索、key 权限核对                                                      |
| 测试与验收               | Plane contract E2E、web vitest、浏览器验收、灰度手册演练            | Synlora pytest 子集、RAGPortal pytest、WeKnora 真实样例上传                                      |
| 缺陷修复                 | Plane 仓内 P0–P2                                                    | Synlora / RAGPortal 仓内 P0–P2；WeKnora 侧问题提配置变更                                         |

### 8.2 接口契约自查责任

| 契约                                 | Plane 侧               | 外部服务侧（Synlora / RAGPortal） |
| ------------------------------------ | ---------------------- | --------------------------------- |
| `plane-delegated-auth.v1` token 交换 | 签发与撤权             | 验签与每轮复验                    |
| `capability-manifest.v1`             | 拉取与装配             | 提供与版本化                      |
| `agent-context.v2`                   | 组装与 Context TTL     | 校验与工具白名单交集              |
| Synlora Session/Trace 与事件游标     | 消费、去重、Chain 投影 | 产出、`after_seq` 语义            |
| RAGPortal 上传/状态/引用四接口       | BFF 转发与幂等         | 实现、错误码与 WeKnora 状态映射   |
| WeKnora 入库与检索                   | —（仅经 RAGPortal）    | RAGPortal 适配层                  |

### 8.3 单人执行节奏

- **每日开工 10 分钟**：过一遍缺陷清单新增/阻塞项，确认当日目标并写进执行手册勾选页。
- **环境变更留痕**：改 `.env`、开关、容器状态前先在执行手册记录变更原因与回滚方式，避免环境状态不可复现。
- **契约变更自查**：涉及 §8.2 契约的改动，先分别读两侧实现核对口径一致，再动代码。
- **联调窗口约定**：上午环境稳定窗口跑 L3–L4 场景，下午修复与回归，避免边改边测。

## 9. 时间计划（5 个工作日，单人）

| 阶段           | 天数 | 当日任务                                                                | 出口                                         |
| -------------- | ---- | ----------------------------------------------------------------------- | -------------------------------------------- |
| 环境拉通与基线 | D1   | §4 七步自检、L1 五服务健康快照、L2 三仓契约回归                         | 七步全通过，L2 三仓测试绿                    |
| 双服务链路     | D2   | L3 四条链路逐条调通，按 §8.1 两侧分区自查定界                           | §5.3 四条链路全部通过                        |
| 开关与角色矩阵 | D3   | L3.5 功能开关全量矩阵、L3.6 角色功能矩阵                                | 5 开关 ON/OFF 独立性 + 角色矩阵逐格通过      |
| 端到端与降级   | D4   | L4 五场景、三项降级演练（停 Synlora / 停 RAGPortal / WeKnora key 失效） | 五场景通过，降级三项通过且事件不重复         |
| 收敛与移交     | D5   | 缺陷回归、证据包整理、灰度手册“准备外部服务/内部试点”复演               | P0/P1 清零，Phase 1.5 验收通过，移交 Phase 2 |

## 10. 验收证据包

每次 Phase 1.5 验收保留：

- 五服务健康快照（含各仓 git 提交号与启动时间）。
- §5.3 / §5.4 各链路的请求-响应摘录或截图（脱敏后）。
- L3.5 开关矩阵与 L3.6 角色矩阵的勾选结果页（含逐格预期与实测记录）。
- 联调缺陷清单终版（含根因、修复提交、回归证据）。
- 一份端到端 Markdown 导出文件及其 `X-Research-Chain-SHA256`。
- 降级演练日志（停 Synlora、停 RAGPortal、WeKnora key 失效模拟各一次）与恢复记录。
- 启动手册修订稿（如命令、地址、凭证口径与本计划有偏差，以实测为准回写）。

## 11. 风险与对策

| 风险                               | 影响                   | 对策                                                           |
| ---------------------------------- | ---------------------- | -------------------------------------------------------------- |
| 宿主机 IP / Docker 网关漂移        | Plane 访问上游服务失败 | 环境变更留痕于执行手册；§4 步骤 5 每次联调开始时复查           |
| WeKnora key 权限不足或服务策略变更 | 上传入库与检索失败     | 外部服务侧首日优先做 key 与最小权限验证，必要时申请 scoped key |
| Synlora 单实例被误起多副本         | 插话/回填/取消失效     | 启动命令固定写入手册，每次启动前检查进程数                     |
| 联调数据混入生产                   | 数据污染               | 只用联调工作区与测试账号；WeKnora 侧使用测试知识库             |
| 单人跨仓切换遗漏定界线索           | 修复方向错误           | 按 §3.2 / §6.1 日志定界；每条链路按 §8.1 两侧分区各自自查一遍  |
| 环境状态不可复现                   | 联调结果不可信         | 环境变更留痕于执行手册；每日开工先跑 L1 健康快照               |
