> **文档状态（2026-09-26）**：历史账号快照，仅用于复盘旧 seed 和自动化测试，不代表当前 `public` π-Lab Excel 基线。
>
> 当前人工测试唯一入口：[`research-intelligent-platform-phase-1.5-role-validation-manual-test-plan.md`](./research-intelligent-platform-phase-1.5-role-validation-manual-test-plan.md)。账号必须从运行库动态解析，凭据通过本机安全存储注入。

# PiLab 测试身份历史档案

## 当前基线

当前 `public` 工作区由 π-Lab Excel 重建：

- 22 个组织节点、189 名学生、14 名导师。
- 唯一 Main PI：洪文晶。
- 152 条主导师绑定，37 条主导师缺口，14 条联合导师引用缺口。
- `projects`、`research_profiles`、`research_chains`、`knowledge_requests` 初始均为 0。
- `pi` 工作区保持无科研业务数据。

## 当前角色解析

| 角色         | 运行库解析条件                                                                                     |
| ------------ | -------------------------------------------------------------------------------------------------- |
| 主 PI        | `WorkspaceResearchSetting.main_pi`，当前应为洪文晶                                                 |
| 产业化负责人 | `OrgUnit.business_category=INDUSTRIALIZATION` 且成员 `org_role=OWNER` 或 `PI`                      |
| 直接导师     | `ResearchUserProfile.category=ADVISOR`、`OrgUnitMember.org_role=ADVISOR`，并有有效 `MentorBinding` |
| 学生         | `ResearchUserProfile.category=STUDENT`、`OrgUnitMember.org_role=REVIEWER`                          |
| 管理员       | InstanceAdmin 或 `public` Workspace role `20`                                                      |
| 访客         | Workspace role `GUEST` 且无科研组织成员关系；如不存在，人工测试时临时创建并清理                    |

验证角色时同时记录 `user_id`、脱敏显示名、Profile category、org role、组织单元、业务分类和 `identity/me` 能力。不要把姓名、完整邮箱和密码写入证据。

## 当前数据检查

```bash
cd /home/fangyikai/code/_AI4MS/plane
./scripts/rebuild-pi-lab-baseline.sh --verify-only
```

通过条件：22 个组织节点、189 名学生、14 名导师、唯一 Main PI 洪文晶，且 `public` 没有预造课题、Project、Chain、KB request。

## 历史 seed 说明

本文原有的 `admin@ai4ms.local`、`liuyang.phd@ai4ms.local`、`chenjing.advisor@ai4ms.local`、`zhangwei.pi@ai4ms.local`、`test.*` 等账号，以及旧课题、报告和待办数量，均属于历史 seed 快照。它们保留在 Git 历史中，不得重新写入当前 `public` 验收环境。

自动化测试数据库可以继续使用 `seed_research_demo`，但人工测试、浏览器截图、Phase 1.5 evidence 和 `plane测试` KB 验收不得引用这些历史账号。

## 安全规则

- 密码、Token、API Key 只通过运行时安全凭据注入。
- 证据只保留脱敏角色和对象 ID，不保存完整邮箱、密码或原始正文。
- WeKnora/RAGPortal 人工测试固定使用 `plane测试` 知识库。
- 清理 mock 课题、测试文件、临时访客和 AccountLink 后，再运行 `--verify-only` 复核基线。
