# 科研智能平台 Phase 1.5 分角色人工测试计划

| 项目     | 内容                                                                          |
| -------- | ----------------------------------------------------------------------------- |
| 文档版本 | v1.0                                                                          |
| 文档状态 | 待执行；面向人工测试，不修改代码和数据库                                      |
| 测试环境 | `public` π-Lab 真实基线 + Plane `4.15.0` + RAGPortal + Synlora + WeKnora      |
| 结构     | L1 健康、L2 角色、L3 主课题、L3.5 开关、L3.6 角色矩阵、L4 闭环、L5 降级与清理 |
| 测试 KB  | `plane测试`；不得选择其他知识库，不得把同一 KB 绑定到第二个课题               |
| 凭据     | 运行时注入；本文件不保存密码                                                  |

## 1. 测试前说明

当前 `public` 已按 π-Lab Excel 清理并重建：189 名学生、14 名导师、唯一 Main PI 洪文晶、0 个预造课题/Project/Chain/KB request。旧版 `liuyang`、`chenjing`、`zhangwei`、`test.*` 账号和旧课题来自历史 seed，不代表当前人工测试环境，不能直接照抄旧矩阵。

本次人工测试的账号由当前运行库实时解析：

- 主 PI：配置中的洪文晶。
- 产业化负责人：`INDUSTRIALIZATION` 单元内的 `OWNER` 或 `PI`。
- 直接导师：对目标学生存在有效 `MentorBinding` 的 `ADVISOR`。
- 学生：当前 Excel 导入、`STUDENT + REVIEWER` 的成员。
- 管理员：InstanceAdmin 或 `public` Workspace Admin。
- 访客：无科研组织关系的 Workspace Guest；不存在时由管理员临时创建，测试后删除。

测试开始前将实际解析结果填入内部受控记录，不把姓名、邮箱和密码写进截图或 Git 文档。

## 2. L1：环境与真实基线

### MT-L1-01 服务健康

```bash
curl -fsS http://127.0.0.1:3000/ >/dev/null
curl -fsS http://127.0.0.1:8001/api/research/health/
curl -fsS http://127.0.0.1:8004/api/health
curl -fsS http://127.0.0.1:8005/api/health
curl -fsS -o /dev/null -w 'WeKnora HTTP %{http_code}\n' http://10.26.15.93:8000/
```

通过条件：五项均正常；失败时不得进入 L3 写入测试。

### MT-L1-02 运行库基线

```bash
cd /home/fangyikai/code/_AI4MS/plane
./scripts/rebuild-pi-lab-baseline.sh --verify-only
```

通过条件：组织树 22 个节点、189 学生、14 导师、唯一 Main PI 洪文晶，`projects/research_profiles/research_chains/knowledge_requests=0`；验证前后不修改数据。

## 3. L2：角色解析与登录

为每个角色开独立浏览器 Profile。实际凭据从本机安全存储注入。

| 编号     | 角色         | 登录后必须确认                                                                                 |
| -------- | ------------ | ---------------------------------------------------------------------------------------------- |
| MT-L2-01 | 主 PI        | `identity/me` 显示主 PI 能力；组织汇总范围覆盖有效组织节点                                     |
| MT-L2-02 | 产业化负责人 | 组织单元 `business_category=INDUSTRIALIZATION`，成员 `org_role=OWNER/PI`；具备业务节点管理能力 |
| MT-L2-03 | 直接导师     | `profile.category=ADVISOR`、`org_role=ADVISOR`，对学生存在有效 MentorBinding                   |
| MT-L2-04 | 学生         | `profile.category=STUDENT`、`org_role=REVIEWER`，可作为 mock 课题 owner                        |
| MT-L2-05 | 管理员       | 可进入平台配置、组织、账号、审计；不能因管理员身份越过 PRIVATE ACL                             |
| MT-L2-06 | 访客         | Workspace Guest 且无科研组织关系；科研导航不渲染，直链/API fail closed                         |

每个角色记录导航四项：科研总览、研究链、审批中心、科研管理；记录 `view/edit/submit/review/accept/return/export/agent_review/knowledge_read/knowledge_write` 能力。

## 4. L3：创建 mock 课题与 Plane 测试知识库

### MT-L3-01 创建主课题

由学生在 `public` 创建：

- 名称：`P15-MOCK-产业化知识闭环-{YYYYMMDD}`。
- 类型：`RESEARCH_CHAIN`。
- 组织：解析出的产业化单元。
- 可见性：`WORKSPACE`。
- Owner：当前学生。

验收：自动生成一对一 Project、ResearchProfile、Chain 和 KB request；KB 状态为 `PENDING_ADMIN`，不能直接上传。

### MT-L3-02 绑定 `plane测试`

由管理员在 RAGPortal/WeKnora 中选择现成知识库 `plane测试`，回填当前课题的 KB request。验收：状态变为 `READY`，绑定关系显示当前 `chain_id`，未出现跨课题或跨 workspace 信息。

### MT-L3-03 上传并检索

学生上传一份脱敏 TXT/Markdown，正文只包含：

```text
P15-ROLE-MOCK-{YYYYMMDD}-{随机短码}
```

轮询至 `SUCCESS`，确认引用，再打开学生 OWNER Agent，要求调用 `knowledge.search` 检索唯一标记并返回引用片段。验收：上传、状态、引用、Agent Trace 和 Chain Event 均能按当前课题关联。

### MT-L3-04 KB 负例

- 在 READY 前上传：返回 `409 KB_NOT_READY`。
- 尝试把 `plane测试` 绑定到第二个课题：返回 `KB_SCOPE_CONFLICT`，不创建上传任务。
- 访客和无权角色查看/搜索：返回 403/404，不泄露 KB 名称、文件名和正文。

## 5. L3.5：开关人工测试

每次只关闭一个开关，验证后立即恢复：

| 开关                            | 验证                                                       |
| ------------------------------- | ---------------------------------------------------------- |
| `research_chain_enabled`        | 研究链入口消失，API 禁用，人工记录和既有只读导出按契约处理 |
| `research_agent_enabled`        | 新 Agent session 被拒，人工记录仍可用                      |
| `research_external_rag_enabled` | `plane测试` 上传降级为人工路径，Chain 不阻断               |
| `research_account_link_enabled` | 新绑定被拒，既有绑定不被删除                               |
| `research_ia_v2`                | 旧导航/路由兼容，恢复后四入口收敛                          |

每项记录：入口、API 状态码/错误码、既有数据、恢复后回归。

## 6. L3.6：分角色功能矩阵

主课题为 `WORKSPACE`；可选 PRIVATE 对照课题不绑定 KB。每一行必须用真实解析角色完成。

| 编号    | 角色         | 查看课题                           | 编辑/节点                         | 报告审批           | Agent                 | KB 读取         | KB 写入              |
| ------- | ------------ | ---------------------------------- | --------------------------------- | ------------------ | --------------------- | --------------- | -------------------- |
| MT-R-01 | 学生 owner   | 主课题 ✅                          | ✅                                | 自己提交；不可自审 | OWNER ✅              | ✅              | READY 后 ✅          |
| MT-R-02 | 直接导师     | 绑定学生课题 ✅                    | REVIEW scope；不可改生命周期      | 有效指派 ✅        | REVIEW ✅             | ✅              | ❌                   |
| MT-R-03 | 主 PI        | 组织范围 ✅                        | 默认只读                          | 主 PI 分支 ✅      | REVIEW ✅             | 允许范围 ✅     | ❌                   |
| MT-R-04 | 产业化负责人 | 所属产业化单元 ✅                  | 负责业务节点 ✅                   | 仅被指派项 ✅      | 按 owner/review scope | 课题授权范围 ✅ | 仅其拥有写权限的课题 |
| MT-R-05 | 管理员       | 按 ACL；PRIVATE 不因管理权自动可见 | 配置/组织/账号 ✅；业务数据按 ACL | 明确指派才可审     | 无自动 REVIEW         | 按 ACL          | 不绕过 READY/ACL     |
| MT-R-06 | 访客         | ❌或 403/404                       | ❌                                | ❌                 | ❌                    | ❌              | ❌                   |

重点负例：导师访问未绑定课题、管理员访问 PRIVATE、访客直链、产业化负责人访问其他业务单元、导师/PI 尝试上传或覆盖正式报告。

## 7. L4：完整人工闭环

1. 学生创建主课题和第一个节点。
2. 管理员绑定 `plane测试`，学生上传并确认引用。
3. 学生添加人工记录、提交阶段材料和分析草稿。
4. 直接导师打开 REVIEW Agent，读取证据、评论并提交审批意见；尝试上传/改节点应被拒。
5. 主 PI 查看组织聚合、审批待办和 Chain 回放；尝试覆盖学生正式内容应被拒。
6. 产业化负责人完成产业化业务节点和成果草稿；跨组织访问应按 ACL 失败。
7. 管理员查看配置、成员和审计；访客验证导航隐藏和 API fail closed。
8. 导出 Chain，核对响应头 hash 与本地文件 hash。

## 8. L5：降级、清理与恢复

### MT-L5-01 Synlora 降级

停止 Synlora，确认 Agent 显示中文降级原因，人工记录仍能保存；恢复后新 session 可创建且事件不重复。

### MT-L5-02 RAGPortal/WeKnora 降级

停止 RAGPortal 或临时使用无效 WeKnora key；确认 `plane测试` 上传转为人工路径、Chain 记录不阻断；恢复后列表和上传成功。

### MT-L5-03 清理

删除测试文件，归档/删除 mock 课题和可选 PRIVATE 对照课题，清理临时访客和 AccountLink。再次执行 `--verify-only`，确认真实 Excel 基线不变，`pi` 工作区仍为空。

## 9. 证据格式

证据目录：`docs/evidence/phase-1.5/role-validation/`。

| 文件                         | 内容                                    |
| ---------------------------- | --------------------------------------- |
| `role-resolution-{date}.md`  | 脱敏角色解析和能力摘要                  |
| `mock-topic-{date}.md`       | Project/Chain/KB request 状态和清理结果 |
| `L3.6-role-matrix-{date}.md` | 六角色逐格结果、状态码、错误码          |
| `L4-e2e-{date}.md`           | 主课题闭环                              |
| `L5-cleanup-{date}.md`       | 降级恢复、清理和基线复核                |

禁止保存密码、Token、API Key、完整邮箱、原始课题正文和未脱敏截图。

## 10. 通过标准

- [ ] L1 五服务健康和真实基线通过。
- [ ] L2 六类角色均由当前运行库解析，不使用旧 seed。
- [ ] 主课题 Project—Profile—Chain—KB 一对一成立。
- [ ] `plane测试` READY 门禁、上传、引用和 Agent 检索通过。
- [ ] L3.6 六角色矩阵无未解释差异。
- [ ] 至少一个开关和一个降级场景完成恢复。
- [ ] mock 数据和临时访客清理完成，真实基线复核通过。
- [ ] 证据脱敏且可追溯。
