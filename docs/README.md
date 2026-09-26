# PiLab 文档总索引

> 当前代码事实：`develop` 分支，软件版本 `4.15.0`。本文档按代码、测试和运行证据整理，更新时间：2026-09-26。

本目录采用分层文档架构。文档不重复争夺同一份“当前状态”，而是分别回答产品为什么做、平台如何协作、代码如何实现、怎样验收和怎样发布。

## 1. 权威层级与状态

发生冲突时按以下顺序判断：

1. 当前代码、测试结果和 `docs/evidence/` 中的可复核证据。
2. `docs/contracts/` 中的接口与数据契约。
3. 当前发布说明、验收报告和运维 runbook。
4. 产品 PRD、阶段计划和 UX 设计规范。
5. 标记为历史或档案的旧版本文档。

| 状态     | 含义                                    | 当前文档口径                                                              |
| -------- | --------------------------------------- | ------------------------------------------------------------------------- |
| 已交付   | 代码、自动化测试和发布/验收证据均已具备 | P0、P1、智能平台 Phase 0、Phase 1、Phase 1.5 代码修复与 `4.15.0` 兼容发布 |
| 灰度中   | 已实现，但仍有真实环境或跨仓门禁        | 首个真实课题的 workflow、KB、成员和 Agent 证据；真实 OIDC 绑定            |
| 规划中   | 已定义范围，尚未进入当前交付            | P2、智能平台 Phase 2/3                                                    |
| 暂缓     | 仅保留产品设计和边界                    | P3 AI 结合能力、微信小程序                                                |
| 历史冻结 | 保留当时事实，不覆盖当前契约            | P0/P1 旧版本基线、4.10–4.13 UI/UX 过程文档                                |

## 2. 从哪里开始读

| 读者           | 推荐顺序                                                                                                                                                                                                      |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 新成员         | 根 [`README.md`](../README.md) → 本索引 → 当前契约 → 对应发布说明                                                                                                                                             |
| 产品与业务     | [管理路线图](./research-management-prd-roadmap.md) → [平台总 PRD](./research-intelligent-platform-prd.md) → 阶段计划                                                                                          |
| Plane 开发     | [Workspace v3 契约](./research-workspace-v3.md) → [跨仓契约](./contracts/research-intelligent-platform/README.md) → 对应代码和测试                                                                            |
| Phase 1.5 联调 | [优化修复计划](./research-intelligent-platform-phase-1.5-optimization-fix-plan.md) → [执行手册](./research-intelligent-platform-phase-1.5-execution-runbook.md) → [证据目录](./evidence/phase-1.5/issue0925/) |
| 部署运维       | [生产部署](./production-deployment.md) → [Phase 0 runbook](./research-intelligent-platform-phase-0-runbook.md) → [π-Lab 基线 runbook](./research-pi-lab-baseline-runbook.md)                                  |
| 验收测试       | [测试账号](./research-test-accounts.md) → [测试夹具](./research-test-fixtures.md) → 对应验收报告；真实课题证据补录前不得伪造数据                                                                              |

## 3. 产品与平台层

| 文档                                                                                               | 职责                                                          | 当前状态                                                               |
| -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- | ---------------------------------------------------------------------- |
| [`research-management-prd-roadmap.md`](./research-management-prd-roadmap.md)                       | PiLab 产品目标、生态边界、P0–P3 路线                          | P0/P1 已交付，P2 规划，P3 暂缓；不覆盖平台 Phase 0/1 的实现细节        |
| [`research-intelligent-platform-prd.md`](./research-intelligent-platform-prd.md)                   | Plane、Synlora、RAGPortal、WeKnora 与专业系统的跨仓平台总 PRD | Phase 0/1/1.5 已进入实现事实层，跨仓真实绑定和首个真实课题证据仍灰度中 |
| [`research-intelligent-platform-phase-0-plan.md`](./research-intelligent-platform-phase-0-plan.md) | 契约、授权、BFF、安全和观测基础                               | 已实施，历史计划保留                                                   |
| [`research-intelligent-platform-phase-1-plan.md`](./research-intelligent-platform-phase-1-plan.md) | UI/UX Ready 工作台和最小闭环                                  | 已实施，真实课题证据灰度中                                             |
| [`research-intelligent-platform-phase-2-plan.md`](./research-intelligent-platform-phase-2-plan.md) | 实验运行、Job、数据资产和垂类能力                             | 规划中                                                                 |
| [`research-intelligent-platform-phase-3-plan.md`](./research-intelligent-platform-phase-3-plan.md) | 治理、规模化、灾备和开放能力                                  | 规划中                                                                 |
| [`wechat-mini-program-prd.md`](./wechat-mini-program-prd.md)                                       | 微信小程序独立产品设想                                        | 暂缓，不计入当前 Plane Web 交付                                        |

## 4. 实现规格与当前契约

| 文档                                                                                                       | 职责                                                                | 当前状态                                                            |
| ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------- |
| [`research-workspace-v3.md`](./research-workspace-v3.md)                                                   | 组织、权限、Workspace、Project、报告与 Agent Context 的当前实现契约 | 当前权威                                                            |
| [`research-p0-development-prd.md`](./research-p0-development-prd.md)                                       | P0 开发规格和需求编号                                               | 历史开发规格；版本号是 `2.0.1 → 2.1.0` 基线                         |
| [`research-p1-development-prd.md`](./research-p1-development-prd.md)                                       | P1 阶段、评审、文献、实验、代码、成果与集成规格                     | 历史开发规格；版本号是 `2.1.0 → 2.2.0` 基线                         |
| [`research-system-management-prd.md`](./research-system-management-prd.md)                                 | 系统管理、导入、管理员和主 PI 能力                                  | 历史 v2.4 规格；当前取代关系见 Workspace v3                         |
| [`research-navigation-visibility.md`](./research-navigation-visibility.md)                                 | 科研导航能力投影和可见性                                            | 历史版本保留，当前规则以代码 `capabilities.py` 和 Workspace v3 为准 |
| [`research-workspace-ux-guide.md`](./research-workspace-ux-guide.md)                                       | UI/UX 系列唯一设计入口                                              | 当前有效                                                            |
| [`research-p0-p1-architecture.md`](./research-p0-p1-architecture.md)                                       | P0/P1 功能与技术架构汇总                                            | 历史架构基线                                                        |
| [`contracts/research-intelligent-platform/README.md`](./contracts/research-intelligent-platform/README.md) | JSON Schema、示例、错误码和兼容性规则                               | 当前跨仓契约；含 `agent-context.v2`、能力投影与 REVIEW scope        |

## 5. 验收、发布与运维

| 文档                                                                                                                                                           | 用途                                             |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| [`research-p0-acceptance-report.md`](./research-p0-acceptance-report.md)、[`research-p1-release-notes.md`](./research-p1-release-notes.md)                     | P0/P1 历史验收和发布门禁                         |
| [`research-intelligent-platform-phase-1-verification.md`](./research-intelligent-platform-phase-1-verification.md)                                             | Phase 1 灰度验收                                 |
| [`research-intelligent-platform-phase-1.5-optimization-fix-plan.md`](./research-intelligent-platform-phase-1.5-optimization-fix-plan.md)                       | Phase 1.5 问题、任务、回滚和当前实现回写         |
| [`research-intelligent-platform-phase-1.5-execution-runbook.md`](./research-intelligent-platform-phase-1.5-execution-runbook.md)                               | Phase 1.5 联调执行步骤                           |
| [`research-intelligent-platform-phase-1.5-role-validation-development-plan.md`](./research-intelligent-platform-phase-1.5-role-validation-development-plan.md) | Phase 1.5 分角色验证开发计划（当前执行入口）     |
| [`research-intelligent-platform-phase-1.5-role-validation-manual-test-plan.md`](./research-intelligent-platform-phase-1.5-role-validation-manual-test-plan.md) | Phase 1.5 分角色人工测试计划（当前人工测试入口） |
| [`research-pi-lab-baseline-runbook.md`](./research-pi-lab-baseline-runbook.md)                                                                                 | 真实人员组织基线、备份、重建、恢复和验收         |
| [`evidence/phase-1.5/issue0925/`](./evidence/phase-1.5/issue0925/)                                                                                             | 脱敏问题转录、验收台账、截图和验证 JSON          |
| [`production-deployment.md`](./production-deployment.md)                                                                                                       | 当前生产部署、更新、验证与回滚                   |
| [`research-test-accounts.md`](./research-test-accounts.md)、[`research-test-fixtures.md`](./research-test-fixtures.md)                                         | 测试身份、夹具和人工验收约束                     |

## 6. 维护约定

1. 实现以代码和测试为准；发现冲突时回写当前契约、发布说明和索引，历史文档只补充取代说明。
2. 产品 PRD 只定义目标、边界和优先级；开发 PRD 定义实现规格；契约文件定义跨服务交换格式；验收/发布文档记录实际结果。
3. 版本号与根 `package.json`、各应用/包和 API `pyproject.toml` 同步；当前软件版本为 `4.15.0`，文档版本独立维护。
4. `public` π-Lab 基线不预造课题；一次性凭据、原始 xlsx、`.runtime/` 备份和 `refer/issue.docx` 不进入 Git。
5. 真实 OIDC 绑定必须双方完成认证；未完成前只能记录为灰度门禁，不能标记为完全打通。
6. 首个真实课题创建后，补录 workflow、节点动作、成员回执、KB 上传和 Agent 会话证据；不得为截图向 `public` 写入虚构课题。
7. 新增开关、错误码、字段或跨仓能力时，同步更新契约、示例、根 README、相关发布说明和本索引。

### 变更记录

| 日期       | 版本 | 变更                                                                        |
| ---------- | ---- | --------------------------------------------------------------------------- |
| 2026-09-26 | v2.0 | 按 `4.15.0` 当前代码重建文档层级、状态矩阵、阅读入口和真实数据/跨仓验收门禁 |
| 2026-09-24 | v1.x | 原有 P0/P1、平台、UI/UX 和 Phase 计划索引                                   |
