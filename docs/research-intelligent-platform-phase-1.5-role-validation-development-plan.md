# 科研智能平台 Phase 1.5 分角色验证开发计划

| 项目     | 内容                                                                                                                              |
| -------- | --------------------------------------------------------------------------------------------------------------------------------- |
| 文档版本 | v1.0                                                                                                                              |
| 文档状态 | 待执行；只定义验证准备、mock 数据和验收门禁，不修改代码和数据库                                                                   |
| 适用版本 | Plane `4.15.0`，`develop`                                                                                                         |
| 上游结构 | Phase 1.5 L1 环境 → L2 契约 → L3 链路 → L3.5 开关 → L3.6 角色 → L4 闭环 → L5 降级/清理                                            |
| 真实基线 | `public` π-Lab Excel 导入基线：22 个组织节点、189 名学生、14 位导师、唯一 Main PI 洪文晶；初始课题、Project、Chain、KB 申请均为 0 |
| 知识库   | WeKnora/RAGPortal 仅使用现成测试知识库：`plane测试`                                                                               |
| 凭据     | 通过本机安全凭据注入；文档、截图、日志不得保存密码、Token 或 API Key                                                              |

## 1. 目标与边界

本计划用于验证 π-Lab 清库后真实组织数据上的多角色科研功能，覆盖主 PI、产业化负责人、直接导师、学生、管理员和访客。验证对象包括科研导航、课题与 Project 关系、报告与成果、审批、成员、Agent review、知识库上传/检索、降级和审计。

“产业化负责人”不是当前代码中的独立个人角色。当前实现通过 `OrgUnit.business_category=INDUSTRIALIZATION` 表达产业化业务单元，再由该单元内的 `OWNER` 或 `PI` 成员承担负责人职责。测试时必须同时记录业务分类和组织角色，不能把它写成新的枚举值。

本计划不使用旧 `seed_research_demo` 账号污染 `public`，不把旧测试组课题、旧报告或旧 KB 当作真实基线。自动化测试数据库可以继续使用旧 seed，但不得把其账号和数据写入本轮人工验收证据。

## 2. 当前身份解析规则

执行前从 `public` 工作区实时读取身份，不在文档中硬编码姓名或邮箱。每个角色保存一份脱敏角色清单，至少包含 `user_id`、邮箱哈希、显示名脱敏值、`profile.category`、`org_role`、组织单元和 `business_category`。

| 验证角色     | 解析条件                                                                                               | 业务用途                                                                  |
| ------------ | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| 主 PI        | `WorkspaceResearchSetting.main_pi`，必须为洪文晶                                                       | 组织级汇总、评审、审批和 Agent REVIEW                                     |
| 产业化负责人 | 有效成员位于 `INDUSTRIALIZATION` 单元，且 `org_role=OWNER` 或 `PI`；优先选择当前单元负责人             | 产业化课题读写、成果和节点操作                                            |
| 直接导师     | `profile.category=ADVISOR`、`org_role=ADVISOR`，且对目标学生存在有效 `MentorBinding`                   | 学生课题 REVIEW、报告审批和 Agent REVIEW                                  |
| 学生         | `profile.category=STUDENT`，`org_role=REVIEWER`，有有效组织归属                                        | 课题 owner、节点写入、知识上传和 OWNER Agent                              |
| 管理员       | InstanceAdmin 或 `public` Workspace role `20`                                                          | 配置、审计、用户/组织管理；不能因管理员身份绕过科研 ACL 查看 PRIVATE 内容 |
| 访客         | Workspace role `GUEST`，无科研组织成员关系；若当前基线没有访客，使用管理员界面临时创建并在清理阶段删除 | 403、导航隐藏和 fail-closed 负例                                          |

角色解析结果必须通过 `identity/me`、组织成员列表、Profile 和 Workspace 成员列表交叉确认。若任一角色不存在，记录为“前置阻塞”，不能用旧 seed 账号代替。

## 3. Mock 数据设计

### 3.1 主 mock 课题

| 字段      | 固定值/规则                                                                               |
| --------- | ----------------------------------------------------------------------------------------- |
| Workspace | `public`                                                                                  |
| 名称      | `P15-MOCK-产业化知识闭环-{YYYYMMDD}`                                                      |
| 类型      | `RESEARCH_CHAIN`；创建时必须自动生成一对一 Plane Project                                  |
| 组织      | 解析到的 `INDUSTRIALIZATION` 单元                                                         |
| Owner     | 解析到的学生                                                                              |
| 直接导师  | 解析到的有效 MentorBinding 对象                                                           |
| 可见性    | `WORKSPACE`，用于主 PI、产业化负责人、导师、学生、管理员和访客的正负例                    |
| 知识库    | 课题自动申请后，管理员在 RAGPortal/WeKnora 绑定现成 `plane测试`，回填后状态必须为 `READY` |
| 测试标记  | `P15-ROLE-MOCK-{YYYYMMDD}-{随机短码}`，写入一份脱敏 TXT/Markdown 测试文档                 |

### 3.2 可选 PRIVATE 对照课题

如需要验证 PRIVATE fail-closed，再创建第二个课题：

- 名称：`P15-MOCK-PRIVATE-隔离-{YYYYMMDD}`。
- Owner 仍为同一学生，组织和 Project 关系与主课题一致。
- 可见性为 `PRIVATE`，不绑定 `plane测试`，不上传任何文件。
- 第二课题只用于访问负例，测试结束后优先归档并删除；不能把同一个 `plane测试` KB 绑定到两个课题。

### 3.3 创建与回滚约束

- 课题创建优先走 Web 真实流程；需要 API 时使用现有 Chain create endpoint，并保存 request id、返回的 Project/Chain/KB request id。
- 任何非 `READY` KB 都不得上传，预期返回 `409 KB_NOT_READY`。
- 任何跨课题复用 `plane测试` 都必须返回 `KB_SCOPE_CONFLICT`，不得产生 WeKnora 上传任务。
- 验证结束后删除测试文件、归档/删除 mock 课题、清理临时访客和 AccountLink；保留脱敏的对象 ID、状态和结果，不保留正文。

## 4. 分阶段执行计划

### L1：环境与数据基线

1. 确认 Plane Web/API、RAGPortal、Synlora、WeKnora 健康检查。
2. 执行 `scripts/rebuild-pi-lab-baseline.sh --verify-only`，确认 `public` 组织、人员、Main PI 和零课题基线。
3. 导出角色解析清单；任何旧 seed 账号只允许出现在自动化测试数据库。

### L2：契约与角色前置

1. 记录六个角色的解析条件和实际脱敏身份。
2. 确认 `identity/me` 的导航能力、`profile.category`、`org_role`、`business_category` 和 MentorBinding。
3. 确认管理员配置权与业务数据权分离。
4. 确认 `plane测试` 在 RAGPortal/WeKnora 可列出，并未绑定其他课题。

### L3：主课题闭环

1. 学生创建主 mock 课题，检查 Project—Profile—Chain 一对一。
2. 管理员绑定 `plane测试`，确认 `PENDING_ADMIN → READY`。
3. 学生上传带唯一标记的测试文档，完成状态轮询、引用确认和 Agent `knowledge.search`。
4. 学生创建节点、添加人工记录、提交分析草稿；不得把导师/PI review 草稿当正式内容。
5. 导师和主 PI 查看并审批允许范围内的报告/阶段事项。

### L3.5：开关与降级

逐项关闭并恢复 `research_chain_enabled`、`research_agent_enabled`、`research_external_rag_enabled`、`research_account_link_enabled` 和 `research_ia_v2`。每次验证入口、API、数据安全和恢复回归四项。

### L3.6：分角色矩阵

对每个角色执行 `view / edit / submit / review / accept / return / export / agent_review / knowledge_read / knowledge_write`。每一格记录页面、API、响应码、错误码、是否泄露标题/文件名/正文及审计 request id。

### L4：端到端验收

至少完成：学生创建课题 → KB READY → 上传与检索 → 节点记录 → 导师 REVIEW → 主 PI 汇总/审批 → 产业化负责人完成业务节点 → 管理员查看配置审计 → 访客 fail closed。

### L5：降级、清理与证据

停止 Synlora、RAGPortal、模拟 WeKnora 认证失败并恢复；确认人工记录路径可用。完成 mock 数据清理、KB 上传记录核对、临时访客清理和证据脱敏。

## 5. 开发验收矩阵

| 编号   | 目标         | 通过条件                                                                                |
| ------ | ------------ | --------------------------------------------------------------------------------------- |
| DEV-01 | 真实身份解析 | 六个角色均能从当前 `public` 数据解析，未引用旧 seed                                     |
| DEV-02 | 产业化语义   | 产业化负责人同时具备 `INDUSTRIALIZATION` 单元和 `OWNER/PI` 组织角色                     |
| DEV-03 | 一对一关系   | Mock Project、ResearchProfile、Chain、KB request 关系唯一且可追溯                       |
| DEV-04 | KB 门禁      | 仅 `plane测试`，READY 前阻断，跨课题绑定返回 `KB_SCOPE_CONFLICT`                        |
| DEV-05 | 权限一致     | 页面、列表、详情、直 ID、导出、Agent、KB 七条路径口径一致                               |
| DEV-06 | REVIEW 隔离  | 导师/主 PI 可读、评论、审批和分析草稿；不能上传、确认引用、改节点生命周期或覆盖正式报告 |
| DEV-07 | 清理可回滚   | mock 数据、临时访客和测试文件可删除，真实 Excel 基线无变化                              |
| DEV-08 | 证据安全     | 无密码、Token、API Key、原始正文和未脱敏个人信息                                        |

## 6. 交付物与记录

- `role-resolution-{date}.json`：只含脱敏身份、角色、组织和能力摘要。
- `mock-topic-{date}.json`：课题/Project/Chain/KB request id、状态和清理结果。
- `L3.6-role-matrix-{date}.md`：逐角色权限矩阵。
- `L4-e2e-{date}.md`：主课题闭环记录。
- `L5-cleanup-{date}.md`：降级恢复和数据清理记录。

文件放在 `docs/evidence/phase-1.5/role-validation/`，不得保存密码、Token、API Key、原始课题正文或完整邮箱。

## 7. 后续动作

1. 先执行 L1/L2，确认角色清单后再创建 mock 课题。
2. 由管理员在 RAGPortal/WeKnora 中确认 `plane测试` 可用并只绑定主 mock 课题。
3. 完成 L3.6 和 L4 后，再决定是否开启 Phase 2 的专业能力联调。
4. 若身份缺失、KB 不可用或权限矩阵出现不一致，停止写入并登记 Phase 1.5 缺陷，不用旧 seed 数据绕过门禁。
