# 科研智能平台 Phase 1.5 分角色人工测试计划

| 项目     | 内容                                                                                              |
| -------- | ------------------------------------------------------------------------------------------------- |
| 文档版本 | v1.1（2026-09-26）                                                                                |
| 文档状态 | 可执行；测试结果按日期写入 evidence，不把执行结果预先标记为通过                                   |
| 启动入口 | [分角色人工测试启动与操作指南](./research-intelligent-platform-phase-1.5-manual-testing-guide.md) |
| 执行手册 | [Phase 1.5 联调执行手册](./research-intelligent-platform-phase-1.5-execution-runbook.md)          |
| 测试环境 | `public` π-Lab 基线 + Plane `4.15.2` + RAGPortal + Synlora + WeKnora                              |
| 测试 KB  | `plane测试`；不得选择其他知识库，不得绑定第二个课题                                               |
| 凭据     | 运行时注入；本文件不保存密码                                                                      |

## 1. 测试前说明

当前 `public` 基线由 π-Lab Excel 重建：22 个组织节点、189 名学生、14 名导师、唯一 Main PI 洪文晶，验证前没有预造课题、Project、Chain 或 KB request。历史 seed 账号和旧课题只用于自动化测试和历史复盘。

每个身份使用独立浏览器 Profile。开始前先完成启动指南 §3 健康快照和 `--verify-only`，再从运行库解析实际身份。测试记录只保存脱敏身份、对象 ID、状态码、错误码和 request id。

## 2. L1：环境与基线

### MT-L1-01 服务健康

执行启动指南 §3 的六项 curl 和 Docker 检查。五服务全部成功、research module enabled、容器 Up 才能进入写入测试。

### MT-L1-02 真实基线

执行：

```bash
cd /home/fangyikai/code/_AI4MS/plane
./scripts/rebuild-pi-lab-baseline.sh --verify-only
```

通过条件：组织节点 22、学生 189、导师 14、Main PI 唯一且为洪文晶，`projects/research_profiles/research_chains/knowledge_requests=0`。

## 3. L2：角色解析、导航与能力

| 编号     | 角色         | 登录后必须确认                                                                     |
| -------- | ------------ | ---------------------------------------------------------------------------------- |
| MT-L2-01 | 主 PI        | `identity/me`、Profile 和组织汇总范围一致；可进入审批和 REVIEW Agent               |
| MT-L2-02 | 产业化负责人 | `business_category=INDUSTRIALIZATION` 且 `org_role=OWNER/PI`；只能操作所属业务节点 |
| MT-L2-03 | 直接导师     | `category=ADVISOR`、`org_role=ADVISOR`，对目标学生有有效 MentorBinding             |
| MT-L2-04 | 学生         | `category=STUDENT`、`org_role=REVIEWER`，具备创建 mock 课题和 OWNER Agent 能力     |
| MT-L2-05 | 管理员       | 可配置、管理成员和审计；不能因 role `20` 绕过 PRIVATE ACL                          |
| MT-L2-06 | NONE         | 为 Workspace 成员但无科研组织关系；科研导航不渲染或只读收敛                        |
| MT-L2-07 | Guest        | role `GUEST` 且无科研组织关系；科研导航隐藏，直链/API fail closed                  |

每个角色先记录 `identity/me.user.role_context`，再记录四入口（科研总览、研究链、审批中心、科研管理）和十项能力：`view/edit/submit/review/accept/return/export/agent_review/knowledge_read/knowledge_write`。

## 4. L3：主课题、KB 和检索

### MT-L3-01 创建主课题

由解析出的学生在 `public` 创建：

- 名称 `P15-MOCK-产业化知识闭环-{YYYYMMDD}`；
- 类型 `RESEARCH_CHAIN`；
- 组织为解析出的产业化单元；
- 可见性 `WORKSPACE`；
- Owner 为当前学生。

验收：一对一 Project、ResearchProfile、Chain 和 KB request 自动生成；KB 为 `PENDING_ADMIN` 时上传按钮和 API 均被门禁拦截。

### MT-L3-02 管理员绑定 `plane测试`

管理员在 RAGPortal/WeKnora 选择现成 `plane测试` 并回填当前 KB request。验收：状态变为 `READY`，绑定只指向当前 `chain_id`，没有跨 workspace 信息。

### MT-L3-03 上传、引用和检索

学生上传只含 `P15-ROLE-MOCK-{YYYYMMDD}-{随机短码}` 的 TXT/Markdown，轮询至 `SUCCESS`，确认引用，再用 OWNER Agent 的 `knowledge.search` 检索标记。核对上传响应、状态、引用、Agent Trace、Chain Event 和导出 hash。

### MT-L3-04 KB 负例

- `READY` 前上传：`409 KB_NOT_READY`。
- 将 `plane测试` 绑定到第二个课题：`KB_SCOPE_CONFLICT`，不创建上传任务。
- 无权角色查看/搜索：403/404，不能泄露 KB 名称、文件名或正文。

## 5. L3.5：开关矩阵

每次只关闭一个开关，验证后立即恢复并重跑基线冒烟：

| 编号     | 开关                            | OFF 预期                                                         |
| -------- | ------------------------------- | ---------------------------------------------------------------- |
| MT-SW-01 | `research_chain_enabled`        | 研究链入口隐藏，Chain API 禁用；人工记录和既有只读导出按契约可用 |
| MT-SW-02 | `research_agent_enabled`        | 新 Agent session 被拒；已有事件、快照和人工记录可读写范围不变    |
| MT-SW-03 | `research_external_rag_enabled` | 上传转人工路径；Chain 记录不阻断                                 |
| MT-SW-04 | `research_account_link_enabled` | 新绑定被拒；既有 ACTIVE 绑定不删除、不自动解绑                   |
| MT-SW-05 | `research_ia_v2`                | 旧导航、列表、query/hash 路由兼容；恢复后四入口收敛              |

每项记录入口、API 状态码/错误码、既有数据安全、恢复时间和回归结果。

## 6. L3.6：分角色权限矩阵

主课题为 `WORKSPACE`，PRIVATE 对照课题可选且不绑定 KB。每个单元都用真实解析身份执行，并分别记录页面、列表、详情、直 ID、导出、Agent 和 KB API。

| 编号    | 角色         | 查看                   | 编辑/节点                     | 审批             | Agent              | KB 读       | KB 写            |
| ------- | ------------ | ---------------------- | ----------------------------- | ---------------- | ------------------ | ----------- | ---------------- |
| MT-R-01 | 学生 owner   | 主课题 ✅              | ✅                            | 可提交，不可自审 | OWNER ✅           | ✅          | READY 后 ✅      |
| MT-R-02 | 直接导师     | 已绑定课题 ✅          | REVIEW scope，不改生命周期    | 有效指派 ✅      | REVIEW ✅          | ✅          | ❌               |
| MT-R-03 | 主 PI        | 组织范围 ✅            | 默认只读                      | 主 PI 分支 ✅    | REVIEW ✅          | 授权范围 ✅ | ❌               |
| MT-R-04 | 产业化负责人 | 所属业务单元 ✅        | 负责节点 ✅                   | 仅被指派项 ✅    | owner/review scope | 授权范围 ✅ | 仅拥有写权课题   |
| MT-R-05 | 管理员       | 按 ACL                 | 配置/成员/审计 ✅；业务按 ACL | 明确指派才可审   | 无自动 REVIEW      | 按 ACL      | 不绕过 READY/ACL |
| MT-R-06 | NONE         | WORKSPACE 只读或按 ACL | ❌                            | ❌               | ❌                 | 按 ACL      | ❌               |
| MT-R-07 | Guest        | 403/404                | ❌                            | ❌               | ❌                 | ❌          | ❌               |

重点负例：导师访问未绑定课题、主 PI/管理员访问 PRIVATE、产业化负责人访问其他业务单元、导师/PI 上传或覆盖正式报告、Guest 直链课题。

## 7. L4：端到端闭环

1. 学生创建主课题和第一个节点。
2. 管理员绑定 `plane测试`，学生上传、轮询并确认引用。
3. 学生添加人工记录、提交阶段材料和分析草稿。
4. 导师打开 REVIEW Agent，读取证据、评论并提交审批意见；上传和改节点必须被拒。
5. 主 PI 查看组织聚合、审批待办和 Chain 回放；覆盖学生正式内容必须被拒。
6. 产业化负责人完成被授权业务节点和成果草稿；跨单元访问必须按 ACL 失败。
7. 管理员查看配置、成员和审计；NONE/Guest 验证导航和直链 fail closed。
8. 导出 Chain，核对 `X-Research-Chain-SHA256` 与本地文件 hash。

## 8. L5：降级、清理与恢复

### MT-L5-01 Synlora 降级

停止 Synlora，确认 Agent 显示中文降级原因、人工记录仍能保存；恢复后新 session 可创建且 `(run_id, seq)` 不重复。

### MT-L5-02 RAGPortal/WeKnora 降级

停止 RAGPortal，或在受控副本中使用无效 WeKnora key；确认上传转人工路径、Chain 记录不中断；恢复后 KB 列表和上传可重测。不得把真实 key 写入证据。

### MT-L5-03 清理

删除测试文件和引用，归档/删除 mock 课题及 PRIVATE 对照，清理临时 Guest 和 AccountLink；再次执行 `--verify-only`，确认 Excel 基线不变且 `pi` 工作区为空。

## 9. 证据与通过标准

证据目录：`docs/evidence/phase-1.5/role-validation/`。

| 文件                         | 内容                                |
| ---------------------------- | ----------------------------------- |
| `role-resolution-{date}.md`  | 脱敏角色、组织和能力                |
| `mock-topic-{date}.md`       | Project/Chain/KB request 状态和清理 |
| `L3.6-role-matrix-{date}.md` | 七类角色逐格结果、状态码和错误码    |
| `L4-e2e-{date}.md`           | 主课题闭环、事件游标和导出 hash     |
| `L5-cleanup-{date}.md`       | 降级恢复、清理和基线复核            |

通过条件：L1 健康和基线通过；七类身份均由当前运行库解析；关系一对一；`plane测试` READY/上传/引用/检索通过；角色矩阵无未解释差异；至少完成一次开关恢复和一次降级恢复；清理后基线不变；证据脱敏可追溯。
