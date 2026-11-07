# Stage RWS-1 控制面验证证据

| 项目 | 内容 |
| ---- | ---- |
| 日期 | 2026-11-07 |
| 分支 | `ai-naive-workspace` |
| 环境 | 本地 API 测试容器 + 独立 PostgreSQL 测试库 |
| 状态 | RWS-1 本地开发与验证完成；未部署远程集成机 |

## 1. 实现范围

- `StudyWorkspace` 以 active ResearchChain 唯一约束实现一链一资源身份。
- `WorkspaceWorkingCopy` 建立唯一默认持久副本骨架，状态为 `PENDING`，不暴露宿主路径。
- `WorkspaceOperation` 保存 actor、actor type、kind、request id、payload hash、expected head、状态、错误和结果。
- `WorkspaceResourceReference` 以 canonical payload digest 保存 Git / LFS / Asset / legacy external 固定引用。
- `WorkspaceAsset` 与 `WorkspaceIndexProjection` 提供后续对象资产和知识索引投影骨架。
- Workspace 级 `study_workspace_enabled` 与链级 `StudyWorkspace.is_enabled` 均默认关闭入口；RWS 开关不改变旧 Research Chain API。

## 2. 验证命令与结果

| 验证目标 | 结果 |
| -------- | ---- |
| `plane/tests/contract/app/test_research_workspace_control_plane.py` | 15 通过 |
| `plane/tests/unit/research/test_workspace_control_plane_migration.py` | 1 通过 |
| `plane/tests/contract/app/test_research_settings.py` | 23 通过 |
| `plane/tests/contract/app/test_research_basic_chain_permissions.py` | 45 通过 |
| `python manage.py check` | 0 issue |
| `python manage.py makemigrations db --check --dry-run` | No changes detected |
| Ruff check / format | 通过 |

说明：验证复用了已存在的隔离 API 测试容器和测试网络，并为本次验证创建独立 PostgreSQL 测试库；未启动禁用的 `docker-compose-test.yml` 测试栈。

## 3. 覆盖行为

1. 同 request id 重复 Ensure 返回同一资源，不新增操作。
2. 两个线程同 request id 并发 Ensure 收敛到同一 StudyWorkspace 和 WorkspaceOperation。
3. 同 request id 换 payload 返回 `RWS_IDEMPOTENCY_CONFLICT`。
4. 默认 WorkingCopy 为 `main` / `PENDING`，逻辑存储键为 `working-copies/<study-id>`。
5. Git、LFS、Asset 三类固定引用均可注册并幂等重放，返回 64 位 digest 和 `plane-rws://` URI。
6. study 不匹配、非法 Git SHA、非法 path、非法 content hash 均为 422 且不写引用。
7. 无项目可见性的用户探测 detail 返回 404，不返回资源存在性。
8. Workspace flag 或链 flag 关闭时 RWS API 返回 404；旧 Research Chain detail 仍返回 200。
9. 0235 迁移在 PostgreSQL 临时 schema 中执行 apply 与 unapply，六张 RWS 表创建后可全部回滚。

## 4. 已知非本阶段问题

在扩展回归中发现：

- `test_research_chain.py` 出现 9 个 fixture setup error；在 RWS-0 基线 `4e0e47e636` 抽样复现同型错误。
- `test_research_nav_capabilities.py` 中 2 个断言失败；在 RWS-0 基线同样复现。

这些问题先于 RWS-1 存在，不计入本阶段通过证据，也不被 RWS-1 的 legacy chain 兼容测试掩盖。后续应在独立缺陷任务中修正测试漂移。

## 5. 未覆盖项

- 未接 Forgejo，未创建真实仓库、分支或 PR。
- 未接 Workspace Runner，未创建物理 checkout 或写租约。
- 未上传对象资产，未写 RAGPortal / WeKnora 索引。
- 未部署 `http://10.26.15.92:3300/` 远程集成机。
- 未执行业务负责人人工签字确认。
