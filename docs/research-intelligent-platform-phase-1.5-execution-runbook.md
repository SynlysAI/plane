# 科研智能体平台 Phase 1.5 联调执行手册

| 项目     | 内容                                                                                                                                       |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| 手册版本 | v1.0（配套计划 v1.3）                                                                                                                      |
| 上游计划 | [`research-intelligent-platform-phase-1.5-integration-debug-plan.md`](./research-intelligent-platform-phase-1.5-integration-debug-plan.md) |
| 账号来源 | [`research-test-accounts.md`](./research-test-accounts.md) v2.5.1                                                                          |
| 灰度手册 | [`research-intelligent-platform-phase-1-verification.md`](./research-intelligent-platform-phase-1-verification.md) §3                      |
| 使用方式 | 每个联调日从 §1 开始逐层勾选；失败项当日登记附录 A，证据按附录 B 归档                                                                      |
| 人工测试 | [`research-intelligent-platform-phase-1.5-manual-testing-guide.md`](./research-intelligent-platform-phase-1.5-manual-testing-guide.md)     |

## 使用说明

- 每个联调日开始先完成 §1 七步自检并填写五服务健康快照，未通过不得进入后续层级。
- 勾选规则：一个用例的全部验证点通过才勾选；任何失败立即按计划 §7 登记附录 A，再决定继续或修复。
- 多身份并发测试使用浏览器隐私窗口，避免会话互相覆盖。夹具账号密码统一为 `Research@12345`；`admin@ai4ms.local` 为 `admin123456`。
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
| 7   | 开四个 research 开关并绑定 AccountLink | 试点学生账号（`liuyang.phd@ai4ms.local`）AccountLink 状态 ACTIVE                                                                                                   | [x]  | `health/20260924-L1.md`              |

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

| #      | 验证点                                                       | 结果 | 证据                          |
| ------ | ------------------------------------------------------------ | ---- | ----------------------------- |
| SW-00a | `liuyang.phd` 创建课题 A（WORKSPACE）与课题 B（PRIVATE）各一 | [x]  | `switches/20260925-L3.5.md`   |
| SW-00b | 课题节点上传一份测试 PDF 并确认引用                          | [x]  | `switches/20260925-L3.5.md`   |
| SW-00c | 创建一次 Agent 会话并收到事件投影                            | [x]  | `switches/20260925-L3.5.md`   |
| SW-00d | 审批中心处理一条等待项                                       | [x]  | `switches/20260925-L3.5.md`   |
| SW-00e | 导出 Markdown 并核对 `X-Research-Chain-SHA256`               | [x]  | `switches/20260925-SW-00B.md` |

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

### 5.1 角色-账号映射

| ResearchLevel | 账号                                             | 组织位置 / 角色                        | 用途                                   |
| ------------- | ------------------------------------------------ | -------------------------------------- | -------------------------------------- |
| ADMIN         | `admin@ai4ms.local`                              | 实例管理员 + 双工作区管理员            | 全量管理视角 / B 课题 fail-closed 负例 |
| PRINCIPAL     | `zhangwei.pi@ai4ms.local`                        | 张伟课题组 PI                          | 课题组管理链视角                       |
| PRINCIPAL     | `zhaoqiang.admin@ai4ms.local`                    | 材料科学与工程学院 UNIT_ADMIN          | 学院节点管理链视角                     |
| PRINCIPAL     | `liming.pi@ai4ms.local`                          | 李明课题组 PI（上级节点）              | 兄弟课题组隔离负例                     |
| PRINCIPAL     | `wangfang.lab@ai4ms.local`                       | 能源材料实验室 OWNER + 王芳课题组 PI   | 上级节点主 PI 视角                     |
| MENTOR        | `chenjing.advisor@ai4ms.local`                   | 张伟课题组 ADVISOR，绑定刘洋/孙浩/周敏 | 导师读写与审批视角                     |
| MENTOR        | `zhengkai.reviewer@ai4ms.local`                  | REVIEWER + 石墨负极小组 OWNER          | 阶段评审视角                           |
| RESEARCHER    | `liuyang.phd@ai4ms.local`                        | 博士生，课题 A/B owner                 | 学生 owner 主视角                      |
| RESEARCHER    | `sunhao.postdoc@ai4ms.local`                     | 博士后，同课题组对照                   | 同组学生对照                           |
| NONE          | `gaopeng.member@ai4ms.local`                     | 工作区成员，无科研组织关系             | 菜单收敛 + WORKSPACE 只读              |
| Guest         | `hexue.guest@ai4ms.local`                        | 访客                                   | 403 负例                               |
| 管理员标签    | `dev.admin` / `ops.admin` / `mainpi@ai4ms.local` | DEV_ADMIN / OPS_ADMIN / MAIN_PI        | 配置权标签补充行                       |

### 5.2 四入口导航渲染矩阵（编号 NAV）

预期依据：Phase 1 验收手册 §3.1——学生不可见科研管理，导师/PI 按评审能力显示审批中心，管理员可见科研管理；NONE 与 Guest 不渲染科研导航分组。

| #     | 账号（角色）                 | 科研总览       | 研究链 | 审批中心   | 科研管理 | 结果 | 证据                     |
| ----- | ---------------------------- | -------------- | ------ | ---------- | -------- | ---- | ------------------------ |
| NAV-1 | `liuyang.phd`（RESEARCHER）  | ✅             | ✅     | ❌（按人） | ❌       | [x]  | `roles/20260925-L3.6.md` |
| NAV-2 | `chenjing.advisor`（MENTOR） | ✅             | ✅     | ✅         | ❌       | [x]  | `roles/20260925-L3.6.md` |
| NAV-3 | `zhangwei.pi`（PRINCIPAL）   | ✅             | ✅     | ✅         | ❌       | [x]  | `roles/20260925-L3.6.md` |
| NAV-4 | `admin`（ADMIN）             | ✅             | ✅     | ✅         | ✅       | [x]  | `roles/20260925-L3.6.md` |
| NAV-5 | `gaopeng.member`（NONE）     | 不渲染科研分组 | 不渲染 | 不渲染     | 不渲染   | [x]  | `roles/20260925-L3.6.md` |
| NAV-6 | `hexue.guest`（Guest）       | 不渲染科研分组 | 不渲染 | 不渲染     | 不渲染   | [x]  | `roles/20260925-L3.6.md` |

### 5.3 课题可见性矩阵（编号 VIS）

课题 A = `liuyang.phd` 创建的 WORKSPACE 课题；课题 B = 同 owner 的 PRIVATE 课题（SW-00a 已建）。读 = 详情/时间线/导出可见；写 = 可追加节点/事件/上传。判定依据为项目级研究 ACL（owner / 项目协作者 / 有效导师绑定 / 组织管理链 / WORKSPACE 可见即工作区成员 / 配置主PI），Guest 无席位则 fail closed。

| #     | 账号（角色）                    | 课题 A（WORKSPACE） | 课题 B（PRIVATE）         | 写权限预期                          | 结果 | 证据                             |
| ----- | ------------------------------- | ------------------- | ------------------------- | ----------------------------------- | ---- | -------------------------------- |
| VIS-1 | `liuyang.phd`（owner）          | 读 ✅               | 读 ✅                     | A/B 均可写、可导出、可加协作者      | [x]  | `roles/20260925-VIS-matrix.json` |
| VIS-2 | `sunhao.postdoc`（同组学生）    | 读 ✅（工作区成员） | 403/不可见                | A 只读                              | [x]  | `roles/20260925-VIS-matrix.json` |
| VIS-3 | `chenjing.advisor`（导师）      | 读 ✅               | 读 ✅（有效导师绑定）     | A/B 可写（导师为有效 chain writer） | [x]  | `roles/20260925-VIS-matrix.json` |
| VIS-4 | `zhangwei.pi`（课题组 PI）      | 读 ✅               | 读 ✅（组织管理链）       | 默认只读（除非被加为项目协作者）    | [x]  | `roles/20260925-VIS-matrix.json` |
| VIS-5 | `liming.pi`（兄弟课题组 PI）    | 读 ✅（工作区成员） | 403/不可见                | A 只读                              | [x]  | `roles/20260925-VIS-matrix.json` |
| VIS-6 | `zhaoqiang.admin`（学院管理员） | 读 ✅               | 按组织管理链实测记录      | 默认只读                            | [x]  | `roles/20260925-VIS-matrix.json` |
| VIS-7 | `admin`（工作区管理员）         | 读 ✅（工作区成员） | 403/不可见（fail closed） | A 只读（管理权不等于数据可见权）    | [x]  | `roles/20260925-VIS-matrix.json` |
| VIS-8 | `gaopeng.member`（NONE）        | 读 ✅（工作区成员） | 403/不可见                | A 只读                              | [x]  | `roles/20260925-VIS-matrix.json` |
| VIS-9 | `hexue.guest`（Guest）          | 403                 | 403                       | 均不可写                            | [x]  | `roles/20260925-VIS-matrix.json` |

每个 VIS 用例的验证三要素：页面入口或列表可见性、API 直接访问（含 ID 直闯）返回码、导出入口是否出现。三类口径必须一致，任一不一致即为缺陷。

### 5.4 功能权限矩阵（编号 PER）

| #     | 功能               | 预期权限规则                                                                          | 账号与操作                                              | 结果 | 证据                             |
| ----- | ------------------ | ------------------------------------------------------------------------------------- | ------------------------------------------------------- | ---- | -------------------------------- |
| PER-1 | 审批中心等待队列   | MENTOR 及以上可见队列；RESEARCHER 仅在被指派评审时看到“待我评审”                      | `chenjing.advisor` 见队列；`liuyang.phd` 默认不见       | [x]  | `roles/20260925-PER-matrix.json` |
| PER-2 | Agent 会话创建     | 按节点写权限（owner / 有效导师 / 项目协作者 ≥15）+ 操作者自身 AccountLink ACTIVE      | `liuyang.phd` ✅；未绑定的 `sunhao` 得到明确错误        | [x]  | `roles/20260925-PER-matrix.json` |
| PER-3 | 知识上传与引用确认 | 同节点写权限；读权限者只可见状态与引用                                                | `liuyang.phd` / `chenjing.advisor` 可传；PI 只读        | [x]  | `roles/20260925-PER-matrix.json` |
| PER-4 | AccountLink 绑定   | 仅本人可绑定/解绑自己的账号，或工作区管理员操作；导师/PI 不可替他人绑定               | `liuyang.phd` 自绑 ✅；`chenjing.advisor` 替绑被拒      | [x]  | `roles/20260925-PER-matrix.json` |
| PER-5 | 快照导出           | 跟随课题读权限；导出内容与 hash 对读权限一致                                          | VIS 各账号对 A/B 分别导出，与 VIS 矩阵一致              | [x]  | `roles/20260925-VIS-matrix.json` |
| PER-6 | 管理员标签配置权   | DEV/OPS/MAIN_PI 标签只扩大配置权，不扩大业务数据可见范围（数据仍按组织架构 ACL 收敛） | `mainpi` 进 `pi` 工作区；对 B 课题可见性以 VIS 规则为准 | [x]  | `roles/20260925-L3.6.md`         |

### 5.5 负例三则（编号 NEG）

| #     | 负例                                        | 预期                                             | 结果 | 证据                             |
| ----- | ------------------------------------------- | ------------------------------------------------ | ---- | -------------------------------- |
| NEG-1 | `hexue.guest` 访问课题 A/B 页面与 API       | 页面不渲染入口；API 直闯返回 403；导航无科研分组 | [x]  | `roles/20260925-NEG-1.png`       |
| NEG-2 | `gaopeng.member` 登录后查看科研菜单         | 菜单收敛为最小集，仅可见 WORKSPACE 级内容        | [x]  | `roles/20260925-NEG-2.png`       |
| NEG-3 | `liming.pi` 尝试访问张伟课题组 PRIVATE 课题 | 兄弟课题组隔离：课题 B 403/不可见，列表不出现    | [x]  | `roles/20260925-VIS-matrix.json` |

## 6. L4：端到端闭环五场景（编号 E2E）

### E2E-1 双课题与 ACL

- [x] `liuyang.phd` 创建课题 A（WORKSPACE）与课题 B（PRIVATE）。
- [x] 页面、API、Context、导出四条路径权限一致；`hexue.guest` 负例生效。
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
| P15-005 | 2026-09-25 | L3.6    | P1     | Plane capabilities    | `liuyang.phd` 无评审指派时查看导航与 identity                  | 审批中心不渲染                       | identity nav 含 `approvals`，侧栏渲染审批中心 | RESEARCHER 级别默认 nav 集合包含审批入口                                                  | 1d81a468b           | identity nav 不含 approvals；浏览器 NAV-1 不渲染审批中心          | 已关闭 |
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
| P15-006 | L3.6 缺陷回归    | WORKSPACE 课题 ACL                   | Markdown + JSON                | `docs/evidence/phase-1.5/roles/20260925-VIS-matrix.json`     | 管理员/NONE 只读          |
| L4      | 端到端闭环       | E2E-1 至 E2E-5                       | Markdown + 导出文件            | `docs/evidence/phase-1.5/e2e/20260925-L4.md`                 | 五场景全部通过            |
| DEG     | 降级演练         | DEG-1 至 DEG-3                       | Markdown + 截图                | `docs/evidence/phase-1.5/degradation/20260925-DEG.md`        | 三项全部通过并恢复        |
| P15-007 | DEG-1 缺陷回归   | Synlora 停机页面提示                 | Markdown + 截图                | `docs/evidence/phase-1.5/degradation/20260925-DEG.md`        | 中文原因 / 人工路径       |
| P15-008 | DEG-2/3 缺陷回归 | RAGPortal 降级与上传入口             | Markdown + 截图                | `docs/evidence/phase-1.5/degradation/20260925-DEG.md`        | 401 中文化 / 恢复成功     |
| D5      | 收敛与移交       | 最终测试、健康快照与灰度复演         | Markdown 记录                  | `docs/evidence/phase-1.5/health/20260925-D5.md`              | Phase 1.5 验收通过        |
