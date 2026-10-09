# PiLab 文档总索引

> 当前代码事实：`develop` 分支，软件版本 `4.23.0`。本文档按代码、测试和运行证据整理，更新时间：2026-10-09。

本目录采用分层文档架构。文档不重复争夺同一份“当前状态”，而是分别回答产品为什么做、平台如何协作、代码如何实现、怎样验收和怎样发布。

## 1. 权威层级与状态

发生冲突时按以下顺序判断：

1. 当前代码、测试结果和 `docs/evidence/` 中的可复核证据。
2. `docs/contracts/` 中的接口与数据契约。
3. 当前发布说明、验收报告和运维 runbook。
4. 产品 PRD、阶段计划和 UX 设计规范。
5. 标记为历史或档案的旧版本文档。

| 状态     | 含义                                    | 当前文档口径                                                                                                                                                                                           |
| -------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 已交付   | 代码、自动化测试和发布/验收证据均已具备 | P0、P1、智能平台 Phase 0、Phase 1、Phase 1.5 代码修复、`4.20.0` 兼容发布、`4.21.0` 1008 主体补齐、`4.22.0` 反馈架构/收尾加固、`4.22.1` HTTP/IP 兼容修复、`4.22.2` 组合筛选基线与 `4.23.0` 二轮反馈收尾 |
| 灰度中   | 已实现，但仍有真实环境或跨仓门禁        | 首个真实课题的 workflow、KB、成员和 Agent 证据；真实 OIDC 绑定                                                                                                                                         |
| 规划中   | 已定义范围，尚未进入当前交付            | P2、智能平台 Phase 2/3                                                                                                                                                                                 |
| 暂缓     | 仅保留产品设计和边界                    | P3 AI 结合能力、微信小程序                                                                                                                                                                             |
| 历史冻结 | 保留当时事实，不覆盖当前契约            | P0/P1 旧版本基线、4.10–4.13 UI/UX 过程文档                                                                                                                                                             |

## 2. 从哪里开始读

### 2.1 目录职责

| 目录            | 职责                                                                    |
| --------------- | ----------------------------------------------------------------------- |
| `product/`      | 当前 PRD、路线图、UX 指南及原型                                         |
| `plans/`        | 按 Phase 0、1、1.5、2、3 分系列；账号绑定计划归 `identity-integration/` |
| `architecture/` | 当前 Workspace 与架构说明                                               |
| `contracts/`    | 跨仓接口与数据契约、JSON Schema、示例和错误码                           |
| `operations/`   | 部署、runbook、启动、测试计划、账号、夹具与开发检查指南                 |
| `releases/`     | 当前发布、验证和实施状态                                                |
| `archive/`      | 按 `p0/`、`p1/`、`system-management/`、`ui-ux/` 系列保存冻结文档        |
| `assets/`       | 普通文档素材（图片、图标）                                              |
| `evidence/`     | 既有证据层级，保持不变                                                  |

### 2.2 1008 归档迁移映射

2026-10-08 文档目录从根目录平铺迁移为上述职责结构，均使用 `git mv` 保留历史。迁移映射：

| 旧位置                                                                             | 新位置                             |
| ---------------------------------------------------------------------------------- | ---------------------------------- |
| `docs/<PRD/路线图/UX/原型>.md`                                                     | `docs/product/`                    |
| `docs/*phase-{0,1,2,3}-plan.md`                                                    | `docs/plans/phase-{0,1,2,3}/`      |
| `docs/*phase-1.5*plan*.md`                                                         | `docs/plans/phase-1.5/`            |
| `docs/ai4ms-plane-account-linking-development-plan.md`                             | `docs/plans/identity-integration/` |
| `docs/research-p0-p1-architecture.md`                                              | `docs/architecture/`               |
| `docs/<runbook/测试/部署/账号/夹具/lint>.md`                                       | `docs/operations/`                 |
| `docs/research-intelligent-platform-phase-1.5-issue-0926-implementation-status.md` | `docs/releases/`                   |
| `docs/research-p0-*`                                                               | `docs/archive/p0/`                 |
| `docs/research-p1-*`、`*phase-1-verification*`、`*p0-p1-usage-guide*`              | `docs/archive/p1/`                 |
| `docs/research-system-management-*`                                                | `docs/archive/system-management/`  |
| `docs/research-workspace-ui-ux-*`                                                  | `docs/archive/ui-ux/`              |
| `docs/*.png`、`docs/pilogo.svg`                                                    | `docs/assets/`                     |

历史文档正文不回写当前事实，只通过本索引和各目录职责标明取代关系。

| 读者           | 推荐顺序                                                                                                                                                                                                                                                                                                                                                                                                          |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 新成员         | 根 [`README.md`](../README.md) → 本索引 → 当前契约 → 对应发布说明                                                                                                                                                                                                                                                                                                                                                 |
| 产品与业务     | [管理路线图](product/research-management-prd-roadmap.md) → [平台总 PRD](product/research-intelligent-platform-prd.md) → 阶段计划                                                                                                                                                                                                                                                                                  |
| Plane 开发     | [Workspace v3 契约](product/research-workspace-v3.md) → [跨仓契约](./contracts/research-intelligent-platform/README.md) → 对应代码和测试                                                                                                                                                                                                                                                                          |
| Phase 1.5 联调 | [0926 后续修复计划](plans/phase-1.5/research-intelligent-platform-phase-1.5-issue-0926-followup-plan.md) → [分角色验证开发计划](plans/phase-1.5/research-intelligent-platform-phase-1.5-role-validation-development-plan.md) → [启动与操作指南](operations/research-intelligent-platform-phase-1.5-manual-testing-guide.md) → [执行手册](operations/research-intelligent-platform-phase-1.5-execution-runbook.md) |
| 部署运维       | [生产部署](operations/production-deployment.md) → [Phase 0 runbook](operations/research-intelligent-platform-phase-0-runbook.md) → [π-Lab 基线 runbook](operations/research-pi-lab-baseline-runbook.md)                                                                                                                                                                                                           |
| 验收测试       | [测试账号](operations/research-test-accounts.md) → [测试夹具](operations/research-test-fixtures.md) → 对应验收报告；真实课题证据补录前不得伪造数据                                                                                                                                                                                                                                                                |

## 3. 产品与平台层

| 文档                                                                                                           | 职责                                                          | 当前状态                                                               |
| -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- | ---------------------------------------------------------------------- |
| [`research-management-prd-roadmap.md`](product/research-management-prd-roadmap.md)                             | PiLab 产品目标、生态边界、P0–P3 路线                          | P0/P1 已交付，P2 规划，P3 暂缓；不覆盖平台 Phase 0/1 的实现细节        |
| [`research-intelligent-platform-prd.md`](product/research-intelligent-platform-prd.md)                         | Plane、Synlora、RAGPortal、WeKnora 与专业系统的跨仓平台总 PRD | Phase 0/1/1.5 已进入实现事实层，跨仓真实绑定和首个真实课题证据仍灰度中 |
| [`research-intelligent-platform-phase-0-plan.md`](plans/phase-0/research-intelligent-platform-phase-0-plan.md) | 契约、授权、BFF、安全和观测基础                               | 已实施，历史计划保留                                                   |
| [`research-intelligent-platform-phase-1-plan.md`](plans/phase-1/research-intelligent-platform-phase-1-plan.md) | UI/UX Ready 工作台和最小闭环                                  | 已实施，真实课题证据灰度中                                             |
| [`research-intelligent-platform-phase-2-plan.md`](plans/phase-2/research-intelligent-platform-phase-2-plan.md) | 实验运行、Job、数据资产和垂类能力                             | 规划中                                                                 |
| [`research-intelligent-platform-phase-3-plan.md`](plans/phase-3/research-intelligent-platform-phase-3-plan.md) | 治理、规模化、灾备和开放能力                                  | 规划中                                                                 |
| [`wechat-mini-program-prd.md`](product/wechat-mini-program-prd.md)                                             | 微信小程序独立产品设想                                        | 暂缓，不计入当前 Plane Web 交付                                        |

## 4. 实现规格与当前契约

| 文档                                                                                                       | 职责                                                                | 当前状态                                                            |
| ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------- |
| [`research-workspace-v3.md`](product/research-workspace-v3.md)                                             | 组织、权限、Workspace、Project、报告与 Agent Context 的当前实现契约 | 当前权威                                                            |
| [`research-p0-development-prd.md`](archive/p0/research-p0-development-prd.md)                              | P0 开发规格和需求编号                                               | 历史开发规格；版本号是 `2.0.1 → 2.1.0` 基线                         |
| [`research-p1-development-prd.md`](archive/p1/research-p1-development-prd.md)                              | P1 阶段、评审、文献、实验、代码、成果与集成规格                     | 历史开发规格；版本号是 `2.1.0 → 2.2.0` 基线                         |
| [`research-system-management-prd.md`](archive/system-management/research-system-management-prd.md)         | 系统管理、导入、管理员和主 PI 能力                                  | 历史 v2.4 规格；当前取代关系见 Workspace v3                         |
| [`research-navigation-visibility.md`](product/research-navigation-visibility.md)                           | 科研导航能力投影和可见性                                            | 历史版本保留，当前规则以代码 `capabilities.py` 和 Workspace v3 为准 |
| [`research-workspace-ux-guide.md`](product/research-workspace-ux-guide.md)                                 | UI/UX 系列唯一设计入口                                              | 当前有效                                                            |
| [`research-p0-p1-architecture.md`](architecture/research-p0-p1-architecture.md)                            | P0/P1 功能与技术架构汇总                                            | 历史架构基线                                                        |
| [`contracts/research-intelligent-platform/README.md`](./contracts/research-intelligent-platform/README.md) | JSON Schema、示例、错误码和兼容性规则                               | 当前跨仓契约；含 `agent-context.v2`、能力投影与 REVIEW scope        |

## 5. 验收、发布与运维

| 文档                                                                                                                                                                         | 用途                                                                               |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| [`research-p0-acceptance-report.md`](archive/p0/research-p0-acceptance-report.md)、[`research-p1-release-notes.md`](archive/p1/research-p1-release-notes.md)                 | P0/P1 历史验收和发布门禁                                                           |
| [`research-intelligent-platform-phase-1-verification.md`](archive/p1/research-intelligent-platform-phase-1-verification.md)                                                  | Phase 1 灰度验收                                                                   |
| [`research-intelligent-platform-phase-1.5-optimization-fix-plan.md`](plans/phase-1.5/research-intelligent-platform-phase-1.5-optimization-fix-plan.md)                       | Phase 1.5 问题、任务、回滚和当前实现回写                                           |
| [`research-intelligent-platform-phase-1.5-issue-1008-plan.md`](plans/phase-1.5/research-intelligent-platform-phase-1.5-issue-1008-plan.md)                                   | 1008 人工测试反馈：报告/项目筛选、附件、Agent Context、反馈与文档整理实施计划      |
| [`releases/research-intelligent-platform-phase-1.5-issue-1008-release-notes.md`](./releases/research-intelligent-platform-phase-1.5-issue-1008-release-notes.md)             | 1008 反馈已交付范围、验证结果、回滚与后续未实现项                                  |
| [`20261009-isolated-browser-verification.md`](evidence/phase-1.5/release/1008-final/20261009-isolated-browser-verification.md)                                               | 1008 收尾隔离浏览器证据：反馈、权限、成果日期、报告模板与 AI4MS 四态               |
| [`research-intelligent-platform-phase-1.5-issue-0926-resolution-plan.md`](plans/phase-1.5/research-intelligent-platform-phase-1.5-issue-0926-resolution-plan.md)             | 0926 第一轮诊断；第 9 节是人工复核结论                                             |
| [`research-intelligent-platform-phase-1.5-issue-0926-followup-plan.md`](plans/phase-1.5/research-intelligent-platform-phase-1.5-issue-0926-followup-plan.md)                 | 0926 复核后的当前修复任务、顺序和回归                                              |
| [`research-intelligent-platform-phase-1.5-issue-0926-implementation-status.md`](releases/research-intelligent-platform-phase-1.5-issue-0926-implementation-status.md)        | 0926 复核项的代码关闭状态；R1–R12 已有实现和证据，人工点击仍按计划第 7 节          |
| [`research-intelligent-platform-phase-1.5-execution-runbook.md`](operations/research-intelligent-platform-phase-1.5-execution-runbook.md)                                    | Phase 1.5 联调执行步骤                                                             |
| [`research-feedback-ai4ms-migration.md`](operations/research-feedback-ai4ms-migration.md)                                                                                    | 4.21 Plane → AI4MS 历史反馈 dry-run、幂等导入、验收与回滚                          |
| [`research-intelligent-platform-phase-1.5-role-validation-development-plan.md`](plans/phase-1.5/research-intelligent-platform-phase-1.5-role-validation-development-plan.md) | Phase 1.5 分角色验证开发计划（开发验证入口）                                       |
| [`research-intelligent-platform-phase-1.5-role-validation-manual-test-plan.md`](operations/research-intelligent-platform-phase-1.5-role-validation-manual-test-plan.md)      | Phase 1.5 分角色人工测试计划（逐格用例入口）                                       |
| [`research-intelligent-platform-phase-1.5-manual-testing-guide.md`](operations/research-intelligent-platform-phase-1.5-manual-testing-guide.md)                              | Phase 1.5 dev 启动、Tailnet 访问与健康检查                                         |
| [`research-pi-lab-baseline-runbook.md`](operations/research-pi-lab-baseline-runbook.md)                                                                                      | 真实人员组织基线、备份、重建、恢复和验收                                           |
| [`evidence/phase-1.5/role-validation/`](./evidence/phase-1.5/role-validation/)                                                                                               | 当前分角色验证证据；历史问题转录见 [`issue0925/`](./evidence/phase-1.5/issue0925/) |
| [`production-deployment.md`](operations/production-deployment.md)                                                                                                            | 当前生产部署、更新、验证与回滚                                                     |
| [`research-test-accounts.md`](operations/research-test-accounts.md)、[`research-test-fixtures.md`](operations/research-test-fixtures.md)                                     | 测试身份、夹具和人工验收约束                                                       |

## 6. 维护约定

1. 实现以代码和测试为准；发现冲突时回写当前契约、发布说明和索引，历史文档只补充取代说明。
2. 产品 PRD 只定义目标、边界和优先级；开发 PRD 定义实现规格；契约文件定义跨服务交换格式；验收/发布文档记录实际结果。
3. 版本号与根 `package.json`、各应用/包和 API `pyproject.toml` 同步；当前软件版本为 `4.23.0`，文档版本独立维护。
4. `public` π-Lab 基线不预造课题；一次性凭据、原始 xlsx、`.runtime/` 备份和 `refer/issue.docx` 不进入 Git。
5. 真实 OIDC 绑定必须双方完成认证；未完成前只能记录为灰度门禁，不能标记为完全打通。
6. 首个真实课题创建后，补录 workflow、节点动作、成员回执、KB 上传和 Agent 会话证据；不得为截图向 `public` 写入虚构课题。
7. 新增开关、错误码、字段或跨仓能力时，同步更新契约、示例、根 README、相关发布说明和本索引。

### 变更记录

| 日期       | 版本 | 变更                                                                                       |
| ---------- | ---- | ------------------------------------------------------------------------------------------ |
| 2026-10-08 | v2.8 | 补充反馈限流配额、成果发表日期、报告模板、迁移哈希复验、测试镜像与 AI4MS 四态兼容口径      |
| 2026-10-08 | v2.7 | 反馈闭环修正为 Plane 内建模型、FileAsset/S3 与审计，不再依赖 AI4MS；版本推进 4.22.0        |
| 2026-10-09 | v2.9 | 复测修复 HTTP/IP 部署缺少 Web Crypto `randomUUID` 时的反馈幂等键兼容问题；版本推进 4.22.1  |
| 2026-10-09 | v4.0 | 补齐 1008 二轮反馈的项目与课题入口、返回导航、报告/成果边界和反馈管理体验；版本推进 4.23.0 |
| 2026-10-08 | v2.6 | 目录按职责归档并回写 1008 补齐状态、4.21.0 版本与验证说明                                  |
| 2026-10-08 | v2.5 | 回写 1008 反馈实现范围、4.20.0 版本、办公附件限制与验证说明                                |
| 2026-09-27 | v2.3 | 补齐 R1、R3、R9 证据，并把方向迁移后的组织节点验收从 22 改为 24                            |
| 2026-09-27 | v2.2 | 回写 0926 后续修复 R1–R12 的代码关闭状态，并链到证据目录                                   |
| 2026-09-27 | v2.1 | 接入 0926 人工复核后的后续修复计划，并修正第一轮实施状态口径                               |
| 2026-09-26 | v2.0 | 按 `4.16.0` 当前代码重建文档层级、状态矩阵、阅读入口和真实数据/跨仓验收门禁                |
| 2026-09-24 | v1.x | 原有 P0/P1、平台、UI/UX 和 Phase 计划索引                                                  |
