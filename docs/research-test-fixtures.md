> **文档状态（2026-09-26）**：历史自动化夹具说明，不代表当前 `public` π-Lab Excel 基线。当前人工测试不执行本文件中的 seed 命令和旧账号矩阵。
>
> 当前人工测试请使用 [`research-intelligent-platform-phase-1.5-role-validation-development-plan.md`](./research-intelligent-platform-phase-1.5-role-validation-development-plan.md) 与 [`research-intelligent-platform-phase-1.5-role-validation-manual-test-plan.md`](./research-intelligent-platform-phase-1.5-role-validation-manual-test-plan.md)。

# PiLab 历史测试夹具档案

## 适用范围

本文件记录 `seed_research_demo`、`seed_system_baseline` 产生的自动化测试夹具，用于复现 P0/P1 合约测试和历史验收。夹具账号、旧组织树、旧课题、旧报告和旧审批只允许在隔离测试数据库使用。

## 当前人工测试替代流程

1. 使用 `scripts/rebuild-pi-lab-baseline.sh --verify-only` 校验当前 `public` 基线。
2. 从运行库动态解析主 PI、产业化负责人、直接导师、学生、管理员和访客。
3. 在 `public` 创建带日期的 mock `RESEARCH_CHAIN` 课题，检查 Project—Profile—Chain—KB request 一对一关系。
4. 管理员只绑定 WeKnora/RAGPortal 的 `plane测试` 知识库，状态必须从 `PENDING_ADMIN` 变为 `READY`。
5. 按 Phase 1.5 L3.6 矩阵验证查看、编辑、审批、Agent review、知识读取和知识写入。
6. 删除 mock 课题、测试文件和临时访客，再复核真实基线。

## 历史夹具中的数据规则

- 历史 seed 的账号和密码不再是当前人工测试凭据。
- 历史 seed 的“测试组”、旧课题、旧报告数量和旧组织树不代表 Excel 导入结果。
- `seed_research_demo --verify` 只允许在自动化测试数据库执行，不能在 `public` 验收环境执行。
- 旧夹具中的课题 A/B 只表示历史测试抽象；当前人工测试使用新计划定义的 `P15-MOCK-产业化知识闭环-{YYYYMMDD}` 和可选 PRIVATE 对照课题。

## 相关文档

- [`research-pi-lab-baseline-runbook.md`](./research-pi-lab-baseline-runbook.md)：真实 Excel 基线、备份、重建和校验。
- [`research-intelligent-platform-phase-1.5-role-validation-development-plan.md`](./research-intelligent-platform-phase-1.5-role-validation-development-plan.md)：分角色开发验证计划。
- [`research-intelligent-platform-phase-1.5-role-validation-manual-test-plan.md`](./research-intelligent-platform-phase-1.5-role-validation-manual-test-plan.md)：当前人工测试计划。
