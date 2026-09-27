# Phase 1.5 0926 问题实施状态

更新时间：2026-09-27

本文记录 `research-intelligent-platform-phase-1.5-issue-0926-resolution-plan.md` 的代码落地状态、自动化验证和待部署环境验证项。凭据、完整邮箱、正文和外部系统密钥不写入本文。

## 已落地

- 周报协作断开回退改为替换共享文档内容，避免 Yjs 更新在自动保存周期内重复追加；提交状态与正文保存仍由各自接口维护。
- 系统管理导入表格增加局部错误边界；导入详情按页读取，默认最多 50 行，响应中的原始字段剔除密码键。
- 主 PI 私有工作区的科研摘要改为空态说明并链接公共总览；主 PI 的默认落地路径回到 `public`。
- 新增 `SYNLORA` 集成枚举、迁移和健康适配器；Agent 客户端优先使用工作区连接记录的地址、超时和后端凭据引用。
- 新建团队科研项目默认使用 `RESEARCH_CHAIN`；旧培养项目仍可读取和维护，但新建入口不再默认创建旧流程。
- 基线组织重建增加“基础研究”和“产业化”两个 `LAB` 方向节点，21 个小组挂到对应方向；测试小组归入基础研究。
- 平台配置在窄视口下改为单列/双列布局，输入控件允许收缩换行；集成页对 Phase 2 系统显示“本阶段不启用”。

## 自动化验证

- `pnpm --filter web test:components`：23 个测试文件、90 个测试通过。
- `pnpm --filter web test`：13 个 Node 测试通过。
- `pnpm --filter @plane/types build`、`pnpm --filter @plane/constants build`、`pnpm --filter web check:types`：通过。
- Python 模块编译、国际化 JSON 解析、前端格式检查和 `git diff --check`：通过。

## 部署环境验证

后端契约测试需要项目配置的 PostgreSQL 与 Redis。当前开发容器未启动这两个服务，直接使用 SQLite 会在项目既有 PostgreSQL 专用字段处建库失败，因此后端 pytest 尚未取得有效执行结果。部署前应按 `AGENTS.md` 的 Docker 测试命令运行 A–G 全量契约测试，并附脱敏 request id、耗时和基线对账。

## 仍需人工/集成验收

- RAGPortal 与 Synlora 的真实地址、凭据引用和健康探针。
- 组织迁移前后的真实数据库 ID/path 对账，以及 24 个节点基线。
- 按成员所属小组完成知识库“候选发现—管理员确认—同组复用—跨组拒绝”四步验收。
- 使用浏览器验证管理端超时页、工作项五类下拉和 1280/1440 宽度下的页面布局。
