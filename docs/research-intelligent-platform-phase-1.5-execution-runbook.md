# 科研智能体平台 Phase 1.5 联调执行手册

> **当前人工测试入口（2026-09-26）**：本手册中的旧 seed 账号和历史课题矩阵只用于复盘证据；当前人工测试必须按 [分角色人工测试计划](./research-intelligent-platform-phase-1.5-role-validation-manual-test-plan.md) 解析 π-Lab Excel 身份，并使用 `plane测试` 知识库。

| 项目     | 内容                                                                                                                                                           |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 手册版本 | v1.1（配套计划 v1.6；当前软件版本 `4.15.0`）                                                                                                                   |
| 上游计划 | [`research-intelligent-platform-phase-1.5-integration-debug-plan.md`](./research-intelligent-platform-phase-1.5-integration-debug-plan.md)                     |
| 账号来源 | [`research-test-accounts.md`](./research-test-accounts.md)（身份清单；凭据由本机安全注入）                                                                     |
| 灰度手册 | [`research-intelligent-platform-phase-1-verification.md`](./research-intelligent-platform-phase-1-verification.md) §3                                          |
| 使用方式 | 每个联调日从 §1 开始逐层勾选；失败项当日登记附录 A，证据按附录 B 归档                                                                                          |
| 人工测试 | [`research-intelligent-platform-phase-1.5-role-validation-manual-test-plan.md`](./research-intelligent-platform-phase-1.5-role-validation-manual-test-plan.md) |

## 使用说明

- 每个联调日开始先完成 §1 七步自检并填写五服务健康快照，未通过不得进入后续层级。
- 勾选规则：一个用例的全部验证点通过才勾选；任何失败立即按计划 §7 登记附录 A，再决定继续或修复。
- 多身份并发测试使用浏览器隐私窗口，避免会话互相覆盖。账号通过本机安全凭据或环境变量注入；密码不得写入文档、截图、日志或命令历史。
- 联调工作区固定为 `public`；WeKnora 只使用测试知识库，不触碰生产数据。
- 证据截图/日志统一存放 `plane/docs/evidence/phase-1.5/`，按 `health/ links/ switches/ roles/ e2e/ degradation/` 分目录，文件名含日期与用例编号（如 `20260925-SW-01.png`）。

## 1. L1：环境七步自检

前置：WeKnora 已部署于 `http://10.26.15.93:8000/`，不自建；Synlora 必须单实例（`workers=1`）。

| #   | 动作                                   | 自检命令与预期                                                                                                                                                     | 结果 | 证据                                 |
| --- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---- | ------------------------------------ |
| 1   | 确认 WeKnora 可达                      | `curl -s http://10.26.15.93:8000/` 返回 HTTP 响应（非超时/拒绝）                                                                                                   | [x]  | `health/20260924-L1.md`              |
| 2   | 启动 RAGPortal                         | `cd RAGPortal/backend && .venv/bin/python -m uvicorn app.main:app --host 0.0.0.0 --port 8004`；`curl -s http://127.0.0.1:8004/api/health` 正常 JSON                | [x]  | `health/20260924-L1.md`              |
| 3   | 启动 Synlora（单实例）                 | `cd Synlora/apps/web/backend && .venv/bin/python run_uvicorn.py`；`curl -s http://127.0.0.1:8005/api/health` 正常 JSON                                             | [x]  | `health/20260924-L1.md`              |
| 4   | 更新 Plane env 并重建容器              | `docker compose -f docker-compose-local.yml -f docker-compose-local.override.yml up -d --force-recreate --no-deps api worker beat-worker`；`docker ps` 确认容器 Up | [x]  | `health/20260924-L1.md`              |
| 5   | 容器内验证两个上游服务                 | 容器内 Python urllib 访问 `http://172.19.0.1:8004/api/health` 与 `:8005/api/health` 均通（API 镜像不含 curl）                                                      | [x]  | `health/20260924-L1.md`              |
| 6   | 录入 RAGPortal 集成连接并启用          | 科研管理 / 集成界面连接测试返回 success，非 `not_configured`                                                                                                       | [x]  | `links/20260924-L1-RAGPortal-BFF.md` |
| 7   | 开四个 research 开关并绑定 AccountLink | 按当前 `public` 基线解析出的学生 AccountLink 状态 ACTIVE                                                                                                           | [x]  | `health/20260924-L1.md`              |

### 五服务健康快照（每轮联调开始时记录）

| 服务      | 时间             | 状态 | 版本 / 提交号   | 备注               |
| --------- | ---------------- | ---- | --------------- | ------------------ |
| Plane Web | 2026-09-24 23:50 | OK   | 33bacf0db       | `/` 返回 200       |
| Plane API | 2026-09-24 23:49 | OK   | c282ecc20       | 已加载集成环境变量 |
| Synlora   | 2026-09-24 23:50 | OK   | 1.4.0 / f59f6fb | tmux 单实例确认    |
| RAGPortal | 2026-09-24 23:50 | OK   | 5c7d0a9         | tmux 单实例确认    |
| WeKnora   | 2026-09-24 23:33 | OK   | 已部署实例      | 内网部署           |

## 2. L2：单服务契约回归

环境口径：当前联调机的 RAGPortal 服务与契约测试均使用 `RAGPortal/backend/.venv`；Synlora 使用后端仓内 `.venv`。不要混用其他项目的 Python 环境。

| 用例 | 命令要点                                                                                                                                                              | 结果 | 记录（passed/skipped） | 证据                    |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ---------------------- | ----------------------- |
| L2-1 | Plane API contract：`docker compose -f docker-compose-test.yml run --rm api-tests pytest -q` 跑 `test_research_phase1_e2e.py` + `test_research_agent_orchestrator.py` | [x]  | 3 passed / 0 skipped   | `health/20260924-L2.md` |
| L2-2 | Synlora：`.venv/bin/pytest -q` 跑 `test_research_context.py` / `test_research_agent_contracts.py` / `test_runtime_assembly.py` / `test_session_runtime.py`            | [x]  | 19 passed / 6 skipped  | `health/20260924-L2.md` |
| L2-3 | RAGPortal：`backend/.venv` 全量 pytest（带 `AUTH_SECRET` / `AI4MS_BASE_URL` / `WEKNORA_*` 测试环境变量）                                                              | [x]  | 31 passed / 0 skipped  | `health/20260924-L2.md` |

## 3. L3：双服务链路验证

每条链路先自查 Plane 侧（API/worker 日志 + `integration.call`），再自查外部服务侧（启动终端日志），两侧证据都留。

| 用例 | 链路                 | 验证点                                                                                                       | 通过标准                                                  | 结果 | 证据                   |
| ---- | -------------------- | ------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------- | ---- | ---------------------- |
| L3-1 | Plane ↔ Synlora      | delegated token 交换、capability manifest、`agent-context.v2` 会话、每轮复验、`allowed_tools` 交集、事件游标 | 无 401/403；`after_seq` 单调回放，`(run_id, seq)` 无重复  | [x]  | `links/20260925-L3.md` |
| L3-2 | Plane ↔ RAGPortal    | BFF 知识库列表、作用域上传、sha256 校验、状态轮询、引用确认、降级人工路径                                    | 上传返回 `knowledge_id/kb_id/task_id`；引用写入外部引用表 | [x]  | `links/20260925-L3.md` |
| L3-3 | RAGPortal ↔ WeKnora  | 真实文档上传、解析任务状态流转、KB 列表刷新                                                                  | 文档在 WeKnora 可检索到条目                               | [x]  | `links/20260925-L3.md` |
| L3-4 | Synlora → Plane 回连 | `PLANE_BASE_URL` 认证代理、`PLANE_API_TOKEN` 有效性、`PLANE_SERVICE_TOKEN` 验签                              | 回连请求无认证失败日志                                    | [x]  | `links/20260925-L3.md` |

## 4. L3.5：功能开关全量矩阵

### 4.0 基线冒烟（全开状态，编号 SW-00）

前置：五个开关全部开启。基线不通过时先修复再进入逐开关验证。

| #      | 验证点                                                               | 结果 | 证据                          |
| ------ | -------------------------------------------------------------------- | ---- | ----------------------------- |
| SW-00a | 当前解析学生创建主 mock 课题（WORKSPACE）和可选 PRIVATE 对照课题各一 | [x]  | `switches/20260925-L3.5.md`   |
| SW-00b | 课题节点上传一份测试 PDF 并确认引用                                  | [x]  | `switches/20260925-L3.5.md`   |
| SW-00c | 创建一次 Agent 会话并收到事件投影                                    | [x]  | `switches/20260925-L3.5.md`   |
| SW-00d | 审批中心处理一条等待项                                               | [x]  | `switches/20260925-L3.5.md`   |
| SW-00e | 导出 Markdown 并核对 `X-Research-Chain-SHA256`                       | [x]  | `switches/20260925-SW-00B.md` |

### 4.1 逐开关 OFF 验证表

操作方式：以管理员在平台配置页关闭，每次只关一个，其余保持开启；验证完成后立即恢复并回归。每行四要素缺一不可：入口、API、数据安全、独立性。

| #     | 开关                            | OFF 验证点（四项全过才勾选）                                                                                                         | 结果 | 恢复回归 | 证据                        |
| ----- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ---- | -------- | --------------------------- |
| SW-01 | `research_chain_enabled`        | ① 研究链入口消失 ② Chain API 返回 403/禁用口径 ③ 既有课题、事件与导出只读不受损 ④ 其余四开关功能不受影响                             | [x]  | [x]      | `switches/20260925-L3.5.md` |
| SW-02 | `research_agent_enabled`        | ① Agent 入口禁用 ② 新会话创建被拒，既有事件/快照只读 ③ Chain 人工记录不阻断 ④ 其余开关不受影响                                       | [x]  | [x]      | `switches/20260925-L3.5.md` |
| SW-03 | `research_external_rag_enabled` | ① 上传入口降级为人工路径 ② 状态/引用接口返回降级口径 ③ Chain 人工记录不阻断 ④ 其余开关不受影响                                       | [x]  | [x]      | `switches/20260925-L3.5.md` |
| SW-04 | `research_account_link_enabled` | ① 绑定入口禁用 ② 绑定 API 返回禁用口径 ③ 既有 ACTIVE AccountLink 保留（不删除、不解绑，Context 撤权逻辑不受影响） ④ 其余开关不受影响 | [x]  | [x]      | `switches/20260925-L3.5.md` |
| SW-05 | `research_ia_v2`                | 按 Phase 1 验收手册 §3.1 五步：旧平铺侧栏恢复、旧列表页恢复、旧路由 query/hash 兼容、四档宽度无溢出、恢复后四入口收敛                | [x]  | [x]      | `switches/20260925-L3.5.md` |

### 4.2 开关联动验证

| #     | 验证点                                                                                             | 结果 | 证据                        |
| ----- | -------------------------------------------------------------------------------------------------- | ---- | --------------------------- |
| SW-06 | 科研总开关（research 模块 enabled）关闭时，子开关开启与否都不生效（对应 `settings.py` 的联动逻辑） | [x]  | `switches/20260925-L3.5.md` |
| SW-07 | 恢复总开关后，子开关行为立即恢复（复跑 SW-00 冒烟三项：创建课题 / Agent 会话 / 导出）              | [x]  | `switches/20260925-L3.5.md` |

## 5. L3.6：分角色功能矩阵

> 当前执行口径：所有身份从 `public` π-Lab Excel 基线动态解析。旧 seed 邮箱、旧课题和旧组织名只存在于历史 evidence，不在本矩阵中复用。测试 KB 固定为 `plane测试`。

### 5.1 角色解析

| ResearchLevel           | 当前解析条件                                                                   | 测试职责                                        |
| ----------------------- | ------------------------------------------------------------------------------ | ----------------------------------------------- |
| ADMIN                   | InstanceAdmin 或 `public` Workspace role `20`                                  | 配置、组织、账号、审计；业务数据仍遵守 ACL      |
| PRINCIPAL               | `WorkspaceResearchSetting.main_pi`，当前为洪文晶；或有效 `OWNER/PI/UNIT_ADMIN` | 组织汇总、审批和 REVIEW Agent                   |
| INDUSTRIALIZATION_OWNER | `business_category=INDUSTRIALIZATION` 单元内有效 `OWNER/PI`                    | 产业化节点、成果和课题业务流程                  |
| MENTOR                  | `category=ADVISOR`、`org_role=ADVISOR`，并有有效 `MentorBinding`               | 绑定学生课题 REVIEW、报告审批和 REVIEW Agent    |
| RESEARCHER              | `category=STUDENT`、`org_role=REVIEWER`                                        | 创建 mock 课题、节点写入、KB 上传和 OWNER Agent |
| NONE                    | Workspace 成员但无科研组织关系                                                 | WORKSPACE 只读和导航收敛                        |
| Guest                   | Workspace role `GUEST` 且无科研组织关系                                        | 403、导航隐藏和 fail-closed 负例                |

角色清单必须同时核对 `identity/me`、Profile、组织成员、业务分类、MentorBinding 和 Workspace 成员。角色缺失时登记前置阻塞，不得用历史账号代替。

### 5.2 四入口导航矩阵

| 编号  | 当前角色                | 科研总览       | 研究链 | 审批中心 | 科研管理 |
| ----- | ----------------------- | -------------- | ------ | -------- | -------- |
| NAV-1 | RESEARCHER              | ✅             | ✅     | 按指派   | ❌       |
| NAV-2 | MENTOR                  | ✅             | ✅     | ✅       | ❌       |
| NAV-3 | PRINCIPAL               | ✅             | ✅     | ✅       | 按配置   |
| NAV-4 | INDUSTRIALIZATION_OWNER | ✅             | ✅     | 按指派   | ❌       |
| NAV-5 | ADMIN                   | ✅             | ✅     | ✅       | ✅       |
| NAV-6 | NONE                    | 不渲染科研分组 | 不渲染 | 不渲染   | 不渲染   |
| NAV-7 | Guest                   | 不渲染科研分组 | 不渲染 | 不渲染   | 不渲染   |

### 5.3 课题可见性与写权限矩阵

主 mock 课题由当前解析学生创建，类型为 `RESEARCH_CHAIN`、可见性 `WORKSPACE`，组织为 `INDUSTRIALIZATION` 单元；可选 PRIVATE 对照课题不绑定 KB。管理员只绑定 `plane测试`，READY 前不得上传。

| 编号  | 当前角色                | WORKSPACE 主课题           | PRIVATE 对照课题   | 写权限预期                                           |
| ----- | ----------------------- | -------------------------- | ------------------ | ---------------------------------------------------- |
| VIS-1 | RESEARCHER owner        | 读写                       | 读写               | 可创建节点、人工记录、上传和导出                     |
| VIS-2 | MENTOR                  | 按有效 MentorBinding 可见  | 未绑定则 403/404   | REVIEW scope；不可改节点生命周期、上传或覆盖正式内容 |
| VIS-3 | PRINCIPAL               | 组织范围可见               | 按组织 ACL         | 默认只读；可审批、评论和分析草稿                     |
| VIS-4 | INDUSTRIALIZATION_OWNER | 所属业务单元可见           | 跨单元按 ACL       | 仅拥有写权限的业务节点可写                           |
| VIS-5 | ADMIN                   | 按 ACL                     | 不因管理权自动可见 | 配置权与业务数据权分离                               |
| VIS-6 | NONE                    | WORKSPACE 只读或按当前 ACL | 403/不可见         | 不可写                                               |
| VIS-7 | Guest                   | 403/404                    | 403/404            | 不可写                                               |

### 5.4 功能权限矩阵

| 功能          | 通过条件                                                                |
| ------------- | ----------------------------------------------------------------------- |
| 报告/阶段审批 | 直接导师、主 PI 或明确指派人可审；普通可读者不可审                      |
| Agent OWNER   | 当前课题 owner 在 AccountLink ACTIVE 且具备节点写权限                   |
| Agent REVIEW  | 直接导师、主 PI 或明确 review scope；只读证据、评论、分析草稿           |
| 知识读取      | 按课题 ACL 和 `allowed_knowledge_base_ids`；只允许 `plane测试`          |
| 知识写入      | 课题 KB 为 `READY` 且调用者有节点写权限；否则 `KB_NOT_READY` 或权限错误 |
| AccountLink   | 本人绑定/解绑，或管理员操作；不接收密码                                 |
| 导出          | 仅能导出当前角色可见的 Chain、事件、快照和引用                          |

### 5.5 负例

- 访客直链主课题和 PRIVATE 对照课题，页面和 API 均 fail closed。
- 管理员访问 PRIVATE 对照课题，不能因 role `20` 绕过 ACL。
- 导师访问未绑定课题，不能创建 REVIEW Agent。
- 产业化负责人访问其他业务分类单元，不能写节点或成果。
- 导师/主 PI 尝试上传、确认外部引用、修改节点生命周期或覆盖正式报告，必须被拒。

## 6. L4：端到端闭环五场景（编号 E2E）

### E2E-1 双课题与 ACL

- [x] 当前解析学生 创建主 mock 课题（WORKSPACE）与PRIVATE 对照课题（PRIVATE）。
- [x] 页面、API、Context、导出四条路径权限一致；当前解析访客 负例生效。
- [x] 按 L3.6 矩阵复验 VIS-1 至 VIS-9 全格。

### E2E-2 上传入库引用

- [x] 课题节点上传 PDF → RAGPortal → WeKnora 解析。
- [x] 状态轮询至完成；引用确认写入外部引用表。
- [x] 同 `sha256 + chain_id + node_id` 重复上传幂等（不产生重复记录）。

### E2E-3 Agent 会话与检索

- [x] Plane 自动装配 persona / 插件 / 工具白名单创建 Synlora 会话。
- [x] Agent 使用 `knowledge.search` 命中 E2E-2 已入库文档。
- [x] 事件投影为 Agent run event 与 Chain event，`after_seq` 单调、`(run_id, seq)` 无重复。

### E2E-4 计划实验分析沉淀

- [x] 调研 → AI 讨论/选题 → 研究计划 → 实验记录 → 分析逐节点推进。
- [x] AI 产物经人工确认生成 typed snapshot。
- [x] Markdown 导出并核对 `X-Research-Chain-SHA256` 与文件内容一致。

### E2E-5 降级演练

见 §7 三项降级演练，全部通过后勾选本项。

- [x] 停 Synlora、停 RAGPortal、WeKnora key 失效三项全部通过。

## 7. 降级演练三项（编号 DEG）

### DEG-1 停止 Synlora

| 步骤 | 验证点                                                                | 结果 | 证据                          |
| ---- | --------------------------------------------------------------------- | ---- | ----------------------------- |
| 演练 | `Ctrl+C` 停 Synlora；Chain 人工记录不阻断；页面显示中文原因与人工路径 | [x]  | `degradation/20260925-DEG.md` |
| 恢复 | 重启后 Agent 会话可继续；事件自动补投，`(run_id, seq)` 不重复         | [x]  | `degradation/20260925-DEG.md` |

### DEG-2 停止 RAGPortal

| 步骤 | 验证点                                                              | 结果 | 证据                          |
| ---- | ------------------------------------------------------------------- | ---- | ----------------------------- |
| 演练 | `Ctrl+C` 停 RAGPortal；上传入口降级为人工路径；Chain 人工记录不阻断 | [x]  | `degradation/20260925-DEG.md` |
| 恢复 | 重启后上传/状态/引用恢复；`not_configured` 或连接错误提示消失       | [x]  | `degradation/20260925-DEG.md` |

### DEG-3 模拟 WeKnora key 失效

| 步骤 | 验证点                                                                                           | 结果 | 证据                          |
| ---- | ------------------------------------------------------------------------------------------------ | ---- | ----------------------------- |
| 演练 | 临时将 RAGPortal `WEKNORA_API_KEY` 改为无效值并重启；上传返回 401 中文原因；Chain 人工记录不阻断 | [x]  | `degradation/20260925-DEG.md` |
| 恢复 | 恢复原 key 并重启；重测入库成功；此前失败的文档可重新上传且幂等                                  | [x]  | `degradation/20260925-DEG.md` |

> DEG-3 演练后必须立即恢复 key 并复测 `L1` 步骤 1 与 `L3-3`，确认 WeKnora 链路回到绿色后再继续后续用例。

## 8. 附录 A：缺陷登记表

登记纪律：发现即登记、当日不过夜；字段口径与计划 §7.1 一致。状态取值：新建 / 定界中 / 修复中 / 回归中 / 已关闭。

| 编号    | 日期       | 层级    | 严重度 | 负责分区              | 复现步骤                                                       | 预期                                 | 实际                                          | 根因                                                                                      | 修复提交            | 回归证据                                                          | 状态   |
| ------- | ---------- | ------- | ------ | --------------------- | -------------------------------------------------------------- | ------------------------------------ | --------------------------------------------- | ----------------------------------------------------------------------------------------- | ------------------- | ----------------------------------------------------------------- | ------ |
| P15-001 | 2026-09-24 | L1      | P0     | Plane integration     | 启动 RAGPortal 后，Plane BFF 调用 `/api/kb/list`               | 返回知识库列表                       | HTTP 401 `unauthorized`                       | Plane HMAC 模式发送 `X-AI4MS-*` 请求头；RAGPortal 契约要求共享 secret 签发的 Bearer token | c282ecc20           | 单测 23 passed；真实 BFF HTTP 200、5 个知识库、调用日志 SUCCESS   | 已关闭 |
| P15-002 | 2026-09-25 | L3-4    | P0     | Synlora integration   | Synlora `PlaneResearchClient` 写入 Plane `agent/chain-events/` | 事件写入成功                         | Plane 返回 401，Synlora 归一为 502            | Synlora 使用 Bearer；Plane Agent 事件端点未启用 API Key 认证                              | 80f854e + e6b261de1 | Synlora 19 passed / 6 skipped；Plane 20 passed；真实事件写入成功  | 已关闭 |
| P15-003 | 2026-09-25 | L3-2    | P2     | RAGPortal integration | Plane BFF 上传后检查 RAGPortal 回执                            | `knowledge_id/kb_id/task_id` 齐返    | `task_id` 为空                                | 部署版 WeKnora 上传响应省略独立 parse task ID                                             | 0a55fbd             | 单测 31 passed；真实二次上传三标识齐返并轮询 SUCCESS              | 已关闭 |
| P15-004 | 2026-09-25 | L3.5    | P1     | Plane Web IA          | 关闭 IA v2 后访问旧项目路由并携带 query/hash                   | query 与 hash 均保留                 | `#projects` 保留，`source=sw05` 丢失          | 项目路由归一化/跳转时未透传 search                                                        | 1d81a468b           | 五条旧路由 query/hash 均保留；组件 82 passed                      | 已关闭 |
| P15-005 | 2026-09-25 | L3.6    | P1     | Plane capabilities    | 当前解析学生 无评审指派时查看导航与 identity                   | 审批中心不渲染                       | identity nav 含 `approvals`，侧栏渲染审批中心 | RESEARCHER 级别默认 nav 集合包含审批入口                                                  | 1d81a468b           | identity nav 不含 approvals；浏览器 NAV-1 不渲染审批中心          | 已关闭 |
| P15-006 | 2026-09-25 | L3.6    | P1     | Plane research ACL    | VIS-7 管理员写 A；VIS-8 NONE 读 A                              | 管理员只读；NONE 可读 WORKSPACE 课题 | 管理员事件写入 201；NONE Chain API 403        | Chain manager 误包含工作区管理员；Chain 读接口被 nav 能力提前拦截                         | 1d81a468b           | 相关后端 51 passed；VIS-7 写 403，VIS-8 A 页面/API/导出可读       | 已关闭 |
| P15-007 | 2026-09-25 | DEG-1   | P1     | Plane Web Agent       | 停止 Synlora 后打开 Agent 页面                                 | 显示中文降级原因与人工路径           | 显示“没有访问当前科研对象的权限”              | 会话创建失败被前端统一映射为 forbidden                                                    | cb4178931           | 组件 85 passed；浏览器显示中文降级与人工路径                      | 已关闭 |
| P15-008 | 2026-09-25 | DEG-2/3 | P1     | RAGPortal UI/API      | 停 RAGPortal 或 WeKnora key 失效后上传                         | 中文降级、上传入口与人工路径可用     | key 失效返回 500；上传面板未挂载              | WeknoraError 未在 KB 校验层捕获；ResearchChainKnowledgePanel 未接入外部引用页             | 5efbe91 + cb4178931 | RAGPortal 33 passed；DEG-2/3 页面中文降级、人工路径与恢复回归通过 | 已关闭 |

## 9. 附录 B：证据记录表

目录约定：`plane/docs/evidence/phase-1.5/` 下设 `health/`、`links/`、`switches/`、`roles/`、`e2e/`、`degradation/`；文件名格式 `YYYYMMDD-用例编号.扩展名`；含敏感信息的截图先脱敏再归档。

| 编号    | 层级             | 用例                                 | 证据类型（截图/日志/导出文件） | 文件路径                                                     | 备注                      |
| ------- | ---------------- | ------------------------------------ | ------------------------------ | ------------------------------------------------------------ | ------------------------- |
| L1      | 环境健康         | 七步自检与五服务快照                 | Markdown 记录                  | `docs/evidence/phase-1.5/health/20260924-L1.md`              | 2026-09-24 全部通过       |
| L2      | 单服务契约       | Plane / Synlora / RAGPortal 测试摘要 | Markdown 记录                  | `docs/evidence/phase-1.5/health/20260924-L2.md`              | 3+19+31 passed            |
| P15-001 | L1 缺陷回归      | Plane BFF → RAGPortal 真实调用       | Markdown 记录                  | `docs/evidence/phase-1.5/links/20260924-L1-RAGPortal-BFF.md` | HTTP 200 / 5 KB / SUCCESS |
| L3      | 双服务链路       | L3-1 至 L3-4                         | Markdown 记录                  | `docs/evidence/phase-1.5/links/20260925-L3.md`               | 四条链路全部通过          |
| P15-002 | L3-4 缺陷回归    | Synlora → Plane 回写                 | Markdown 记录                  | `docs/evidence/phase-1.5/links/20260925-L3.md`               | 真实事件写入成功          |
| P15-003 | L3-2 缺陷回归    | 上传三标识回归                       | Markdown 记录                  | `docs/evidence/phase-1.5/links/20260925-L3.md`               | task_id 齐返 / SUCCESS    |
| L3.5    | 功能开关矩阵     | SW-00 至 SW-07                       | Markdown + JSON + 截图         | `docs/evidence/phase-1.5/switches/20260925-L3.5.md`          | 全部通过                  |
| L3.6    | 角色矩阵         | NAV / VIS / PER / NEG                | Markdown + JSON + 截图         | `docs/evidence/phase-1.5/roles/20260925-L3.6.md`             | 全部通过                  |
| P15-004 | L3.5 缺陷回归    | 旧路由 query/hash                    | Markdown 记录                  | `docs/evidence/phase-1.5/switches/20260925-L3.5.md`          | 五条路由完整保留          |
| P15-005 | L3.6 缺陷回归    | RESEARCHER 审批入口                  | Markdown + 截图                | `docs/evidence/phase-1.5/roles/20260925-L3.6.md`             | 默认不渲染审批中心        |
| P15-006 | L3.6 缺陷回归    | WORKSPACE 主 mock 课题CL             | Markdown + JSON                | `docs/evidence/phase-1.5/roles/20260925-VIS-matrix.json`     | 管理员/NONE 只读          |
| L4      | 端到端闭环       | E2E-1 至 E2E-5                       | Markdown + 导出文件            | `docs/evidence/phase-1.5/e2e/20260925-L4.md`                 | 五场景全部通过            |
| DEG     | 降级演练         | DEG-1 至 DEG-3                       | Markdown + 截图                | `docs/evidence/phase-1.5/degradation/20260925-DEG.md`        | 三项全部通过并恢复        |
| P15-007 | DEG-1 缺陷回归   | Synlora 停机页面提示                 | Markdown + 截图                | `docs/evidence/phase-1.5/degradation/20260925-DEG.md`        | 中文原因 / 人工路径       |
| P15-008 | DEG-2/3 缺陷回归 | RAGPortal 降级与上传入口             | Markdown + 截图                | `docs/evidence/phase-1.5/degradation/20260925-DEG.md`        | 401 中文化 / 恢复成功     |
| D5      | 收敛与移交       | 最终测试、健康快照与灰度复演         | Markdown 记录                  | `docs/evidence/phase-1.5/health/20260925-D5.md`              | Phase 1.5 验收通过        |
