# 科研智能平台 Phase 1.5 分角色验证开发计划

| 项目       | 内容                                                                                                                                                                      |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 文档版本   | v1.4（2026-09-26）                                                                                                                                                        |
| 文档状态   | 可执行；dev 五服务已启动，真实身份和 mock 课题由人工测试时动态解析                                                                                                        |
| 适用版本   | Plane `4.18.1`，`develop`                                                                                                                                                 |
| 上游文档   | [联调与缺陷收敛计划](./research-intelligent-platform-phase-1.5-integration-debug-plan.md)、[联调执行手册](./research-intelligent-platform-phase-1.5-execution-runbook.md) |
| 人工入口   | [分角色人工测试计划](./research-intelligent-platform-phase-1.5-role-validation-manual-test-plan.md)                                                                       |
| 快速启动   | [分角色人工测试启动与操作指南](./research-intelligent-platform-phase-1.5-manual-testing-guide.md)                                                                         |
| 数据基线   | `public` π-Lab Excel 基线：22 个组织节点、189 名学生、14 名导师、唯一 Main PI 洪文晶；验证前课题、Project、Chain、KB request 均为 0                                       |
| 测试知识库 | 只使用 WeKnora/RAGPortal 现成知识库 `plane测试`                                                                                                                           |
| 凭据规则   | 运行时从本机安全存储注入；Git、截图、日志和证据不得保存密码、Token、API Key 或完整邮箱                                                                                    |

## 1. 目标、范围与当前结论

本计划把 Phase 1.5 的分角色验证拆成可复核的准备、实现检查、人工执行和清理门禁，覆盖主 PI、产业化负责人、基础研究负责人、直接导师、学生、管理员、NONE 和访客。验证范围包括科研导航、课题与 Project 一对一关系、节点和报告动作、审批、Agent OWNER/REVIEW scope、知识库 READY 门禁、降级、审计和导出完整性。

当前 dev 环境已完成启动检查：Plane Web `3000`、Plane API `8001`、RAGPortal `8004`、Synlora `8005` 和 WeKnora 均可达，Docker API/worker/beat 容器处于运行状态；Tailscale 直连入口 `http://100.109.35.2:3000/` 可访问。Tailscale Serve 尚未获管理员授权，HTTPS 入口在授权前保持阻塞，不能把该项标记为通过。

本计划不修改 `public` 基线、不执行历史 `seed_research_demo`，不把旧 seed 账号、旧课题或旧证据当作当前人工结果。自动化测试数据库仍可独立使用历史夹具。

## 2. 验证对象与角色解析

测试前从 `public` 工作区实时读取身份。角色记录写入受控证据，仅保存 `user_id`、邮箱哈希、脱敏显示名、Profile category、组织角色、组织单元、业务分类和能力摘要。

| 角色                      | 解析条件                                                                                           | 主要验证职责                                       |
| ------------------------- | -------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `PRINCIPAL`               | `WorkspaceResearchSetting.main_pi`；当前基线应为洪文晶                                             | 组织汇总、评审、审批、Agent REVIEW                 |
| `INDUSTRIALIZATION_OWNER` | `business_category=INDUSTRIALIZATION` 单元内有效成员，`org_role=OWNER` 或 `PI`                     | 产业化节点、成果和业务流程                         |
| 基础研究负责人            | `business_category=BASIC_RESEARCH` 单元内 `org_role=OWNER`；解析结果为 `PRINCIPAL`，不带产业化标记 | 基础研究节点和继承范围内的课题                     |
| `MENTOR`                  | `profile.category=ADVISOR`、`org_role=ADVISOR`，且对目标学生存在有效 `MentorBinding`               | 绑定学生课题 REVIEW、报告审批                      |
| `RESEARCHER`              | `profile.category=STUDENT`、`org_role=REVIEWER`，有有效组织归属                                    | 创建 mock 课题、节点写入、KB 上传、OWNER Agent     |
| `ADMIN`                   | InstanceAdmin 或 `public` Workspace role `20`                                                      | 配置、成员、集成和审计；不因管理员身份绕过业务 ACL |
| `NONE`                    | Workspace 成员但无科研组织关系                                                                     | WORKSPACE 只读和导航收敛                           |
| `Guest`                   | Workspace role `GUEST` 且无科研组织关系                                                            | 403/404、导航隐藏和 fail-closed 负例               |

角色解析必须交叉核对 `identity/me`、Profile、组织成员、`business_category`、MentorBinding 和 Workspace 成员。缺少任何角色时登记前置阻塞，不使用旧账号替代。

## 3. 验证数据与生命周期

### 3.1 主 mock 课题

| 字段      | 规则                                                                                       |
| --------- | ------------------------------------------------------------------------------------------ |
| Workspace | `public`                                                                                   |
| 名称      | `P15-MOCK-产业化知识闭环-{YYYYMMDD}`                                                       |
| 类型      | `RESEARCH_CHAIN`，创建时自动生成一对一 Plane Project、ResearchProfile、Chain 和 KB request |
| 组织      | 解析出的 `INDUSTRIALIZATION` 单元                                                          |
| Owner     | 解析出的 `RESEARCHER`                                                                      |
| 直接导师  | 目标学生的有效 `MentorBinding`                                                             |
| 可见性    | `WORKSPACE`                                                                                |
| KB        | 管理员将现成 `plane测试` 回填到该课题；状态必须从 `PENDING_ADMIN` 变为 `READY`             |
| 测试文档  | 只包含 `P15-ROLE-MOCK-{YYYYMMDD}-{随机短码}` 的脱敏 TXT/Markdown                           |

### 3.2 可选 PRIVATE 对照课题

仅在需要验证 PRIVATE fail-closed 时创建 `P15-MOCK-PRIVATE-隔离-{YYYYMMDD}`。它由同一学生拥有、可见性为 `PRIVATE`、不绑定 KB、不上传文件，测试结束后优先归档或删除。`plane测试` 可以复用给同一小组的后续课题，不得绑定到另一个小组。

### 3.3 创建、幂等与回滚

- 优先通过 Web 创建；使用 API 时保存 request id、Project/Chain/KB request id 和状态变化。
- KB 未达到 `READY` 时上传必须被门禁拦截，预期为 `409 KB_NOT_READY`。
- 同一小组的多个课题复用 `plane测试`；只有绑到另一个小组时才返回 `KB_SCOPE_CONFLICT`，且不得产生 WeKnora 上传任务。
- 清理顺序为：删除测试文件和引用 → 归档/删除 mock 课题 → 清理临时访客和 AccountLink → 复核 `public` 基线。
- 清理失败不得强删生产对象；登记对象 ID、状态和补偿动作，保留可回滚证据。

## 4. 开发验证任务与依赖

### 阶段 A：环境和契约准备

#### DEV-A1：固定 dev 启动基线

**验收标准：**

- [ ] Plane Web/API、RAGPortal、Synlora、WeKnora 健康检查全部通过。
- [ ] API 容器能通过 Docker 网关访问宿主机 `8004` 和 `8005`。
- [ ] 四个 research 开关和 RAGPortal 集成连接状态可在 `public` 配置页核对。
- [ ] Tailnet 至少有一个可用入口；HTTPS Serve 未授权时明确记录为阻塞。

**依赖：** 无。
**执行入口：** [启动与操作指南 §2](./research-intelligent-platform-phase-1.5-manual-testing-guide.md#2-dev-环境启动与-tailnet-访问)。

#### DEV-A2：冻结角色和权限契约

当前实现已新增 `role_resolution.resolve_role_context`，并由 `identity/me` 返回脱敏 `role_context`；覆盖 ADMIN、PRINCIPAL、INDUSTRIALIZATION_OWNER、MENTOR、RESEARCHER、NONE 和 Guest 的关系解析。

**验收标准：**

- [x] 七类身份（含 `NONE` 和 Guest）均有解析条件、导航预期和动作矩阵。
- [ ] 管理员配置权与业务数据 ACL 分离；主 PI/导师 REVIEW scope 不包含节点生命周期、上传、引用确认和正式报告覆盖。
- [ ] 每个拒绝动作记录 HTTP 状态、稳定错误码、中文原因和 request id。

**依赖：** DEV-A1。

#### DEV-A3：冻结课题 KB 生命周期

**验收标准：**

- [ ] 创建请求可安全重试，同一 `TEAM` 最多一条未结束的小组知识库绑定。
- [ ] `PENDING_ADMIN`、`READY`、失败、归档和恢复状态可追踪。
- [ ] KB 映射按小组归属和唯一性校验，不把 WeKnora 全局 API key 当作业务授权。已 `READY` 的历史课题绑定保持原库。

**依赖：** DEV-A2。

### 阶段 B：按角色的闭环验证

#### DEV-B1：学生 OWNER 路径

学生创建主课题、节点、人工记录、分析草稿，等待管理员完成 KB 回填后上传测试文档，执行引用确认、`knowledge.search` 和 Chain 导出。

**通过条件：** Project—Profile—Chain 一一对应，同一 `TEAM` 共享一条 KB 绑定；事件游标单调；导出 hash 与响应头一致；不能自审自己的正式报告。

#### DEV-B2：导师和主 PI REVIEW 路径

导师只能访问有效 MentorBinding 范围，主 PI 只能访问组织范围；两者可读取证据、评论、审批和提交分析结果草稿。

**通过条件：** 未绑定课题、跨组织课题和 PRIVATE 课题均 fail closed；上传、确认引用、节点生命周期写入和正式报告覆盖均被拒。

#### DEV-B3：产业化负责人路径

在 `INDUSTRIALIZATION` 单元内验证业务节点、成果草稿和被指派审批；访问其他业务分类单元时验证 ACL。

**通过条件：** 业务分类和 `OWNER/PI` 组织角色同时成立；越权写入返回稳定拒绝。

#### DEV-B4：管理员、NONE 和 Guest 负例

管理员验证配置、组织、AccountLink、集成和审计；NONE 验证 WORKSPACE 只读；Guest 验证导航隐藏、直链和 API fail closed。

**通过条件：** 管理员不自动获得 PRIVATE 内容；NONE/Guest 不泄露课题标题、文件名、KB 名称或正文。

### 阶段 C：开关、降级和清理

逐项关闭并恢复 `research_chain_enabled`、`research_agent_enabled`、`research_external_rag_enabled`、`research_account_link_enabled`、`research_ia_v2`，每项同时验证入口、API、既有数据安全和恢复回归。

依次停止 Synlora、RAGPortal，并以受控方式模拟无效 WeKnora key；验证人工记录不中断、页面给出中文降级原因、恢复后新会话/上传可用且事件不重复。

## 5. 开发验收矩阵

| 编号   | 目标         | 通过条件                                                          | 证据                         |
| ------ | ------------ | ----------------------------------------------------------------- | ---------------------------- |
| DEV-01 | dev 启动     | 五服务健康、Docker 容器 Up、Tailnet 入口可达                      | `health/{date}-startup.md`   |
| DEV-02 | 真实身份解析 | 角色来自当前 `public`，无旧 seed                                  | `role-resolution-{date}.md`  |
| DEV-03 | 关系一致性   | Project、ResearchProfile、Chain 一一对应；同一 TEAM 一条 KB 绑定  | `mock-topic-{date}.md`       |
| DEV-04 | KB 门禁      | 仅 `plane测试`；READY 前阻断；跨小组返回 `KB_SCOPE_CONFLICT`      | `L3-kb-{date}.md`            |
| DEV-05 | 权限一致     | 页面、列表、详情、直 ID、导出、Agent、KB 七条路径一致             | `L3.6-role-matrix-{date}.md` |
| DEV-06 | REVIEW 隔离  | 导师/主 PI 可读、评论、审批、分析草稿；拒绝所有写入正式内容的动作 | `review-scope-{date}.md`     |
| DEV-07 | 开关与降级   | 五开关逐项恢复，三类外部服务降级可回退                            | `switches/`、`degradation/`  |
| DEV-08 | 清理可回滚   | mock 数据、临时访客、AccountLink 和测试文件清理；真实基线不变     | `L5-cleanup-{date}.md`       |
| DEV-09 | 证据安全     | 无密码、Token、API Key、完整邮箱、原始正文和未脱敏截图            | 证据抽查记录                 |

任何 P0（越权、数据丢失、五服务不可用、闭环阻断）或未解释的权限差异都会阻断 Phase 1.5 出口；P1 必须在重新开放人工测试前完成回归。

## 6. 证据、任务卡与检查点

证据目录固定为 `docs/evidence/phase-1.5/role-validation/`，启动和联调健康记录仍放在 `docs/evidence/phase-1.5/health/`。每份证据至少包含：日期、代码提交号、服务版本、角色标识（脱敏）、对象 ID（可截断）、请求/响应状态、错误码、结论和清理状态。

每个开发任务完成后必须执行：

1. 运行对应自动化测试或契约子集。
2. 按人工计划完成正例和负例，并记录 request id。
3. 对照 `docs/contracts/research-intelligent-platform/` 检查字段和错误码。
4. 更新缺陷台账、证据 manifest 和回滚说明。

检查点：

- **Checkpoint A（DEV-A1～A3）**：服务健康、角色解析和 KB 状态机可复核。
- **Checkpoint B（DEV-B1～B4）**：七类身份矩阵无未解释差异。
- **Checkpoint C（阶段 C）**：开关、降级和清理全部恢复，真实基线复核通过。

## 7. 已执行夹具与测试账号（2026-09-26）

重新创建角色账号时不要加 `--reset-passwords`，否则会轮换下表密码，包括已经改过的管理员密码。只补账号和验证单元用：

```bash
docker compose -f docker-compose-local.yml -f docker-compose-local.override.yml run --rm api \
  python manage.py prepare_phase15_role_validation --workspace public --apply --json
```

| 对象          | 值                                                                  |
| ------------- | ------------------------------------------------------------------- |
| MentorBinding | `f09c7fe9-c565-4904-9598-54e39e1f5c39`，刘俊扬 → 邱智鑫，当前仍有效 |
| mock Project  | 当前库中没有；按人工计划 L3 新建，不沿用已删除的旧 ID               |

2026-09-26 17:01 的初始密码导出覆盖了三名基线账号的密码。开发库已把这三名账号恢复为下表密码，并重新创建产业化负责人、基础研究负责人和访客。管理员密码已由本人修改，下表中的管理员密码不再有效。

本轮测试账号和明文密码（仅限当前 dev 测试环境）：

| 角色                    | 账号                                 | 密码                     |
| ----------------------- | ------------------------------------ | ------------------------ |
| ADMIN                   | `admin@ai4ms.local`                  | 已改为个人密码           |
| PRINCIPAL / MENTOR      | `whong@xmu.edu.cn`                   | `P15!Dp4oexY8F1gIZn51js` |
| MENTOR                  | `jyliu@xmu.edu.cn`                   | `P15!muRa0cCV3PY5yGkLKF` |
| RESEARCHER              | `qiuzhixin@stu.xmu.edu.cn`           | `P15!HvMLgY8YwxJ5q9j8T3` |
| INDUSTRIALIZATION_OWNER | `phase15.industry.owner@ai4ms.local` | `P15!0GBdxQAfI4N7qfH8Wn` |
| 基础研究负责人          | `phase15.basic.owner@ai4ms.local`    | `P15!RfExPSKRHfgAdQPnJn` |
| Guest                   | `phase15.guest@ai4ms.local`          | `P15!8Qx2w0wpnmL9gEvaOH` |

角色核验结果：洪文晶→`PRINCIPAL + MENTOR`，刘俊扬→`MENTOR`，邱智鑫→`RESEARCHER`，产业化负责人→`PRINCIPAL + INDUSTRIALIZATION_OWNER`，基础研究负责人→`PRINCIPAL` 且 `business_category=BASIC_RESEARCH`，访客→`Guest`。除管理员外，这些账号首次登录后会要求设置个人密码。

清理命令：

```bash
docker compose -f docker-compose-local.yml -f docker-compose-local.override.yml run --rm api \
  python manage.py prepare_phase15_role_validation --workspace public --cleanup --json
```

## 8. 当前执行顺序

1. 按[启动与操作指南](./research-intelligent-platform-phase-1.5-manual-testing-guide.md)从 L1 健康快照开始。
2. 按[人工测试计划](./research-intelligent-platform-phase-1.5-role-validation-manual-test-plan.md)解析角色，先完成 L2，再创建 mock 课题。
3. 依次完成 DEV-B1～B4、开关和降级验证；失败项登记执行手册附录 A，不用旧 seed 绕过门禁。
4. 完成清理和基线复核后，才可将 Phase 1.5 标记为可移交 Phase 2。
