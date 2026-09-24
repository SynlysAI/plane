# Research Workspace 4.13.0 验收报告

| 项目     | 内容                                                                             |
| -------- | -------------------------------------------------------------------------------- |
| 验收日期 | 2026-09-24                                                                       |
| 目标版本 | `4.13.0`                                                                         |
| 基线分支 | `develop`                                                                        |
| 验收状态 | 通过                                                                             |
| PRD      | [`research-workspace-ui-ux-4.13-prd.md`](./research-workspace-ui-ux-4.13-prd.md) |

## 1. 交付范围

| 范围    | 结果                                                                   |
| ------- | ---------------------------------------------------------------------- |
| F1 口径 | `pickCurrentChain` / `pickCurrentNode` 统一出口，总览顶栏与摘要卡同链  |
| F2 归档 | Workflow `archived` kind，muted + 70% 透明度，与未来态区分             |
| F3 双向 | `RESEARCH` 节点前驱优先、后继兜底映射；映射循环 O(n)                   |
| F4 面板 | Agent panel 就地重连；装配三栏进入运行详情折叠区                       |
| F5 宽度 | `w-[min(400px,100vw)]`，390px 视口不溢出                               |
| F6 日期 | `formatResearchDateTime` / `formatResearchDate` / `formatResearchTime` |
| F7 待办 | `collectResearchTodos` 共享聚合；摘要卡计数与待办索引同口径            |
| F8 文档 | Phase 1 清单勾选；4.12 验收报告附录 A；UX 指南 v1.4                    |

## 2. 架构收敛

- Agent 875 行单文件拆为 session hook + utils + header/conversation/runtime 共享区块 + page/panel 双布局。
- 待办聚合、当前对象推导、日期格式化分别收敛为单一语义出口。
- 遮罩 `bg-black/20` 按原生惯例保留，并在 UX 指南登记例外。

## 3. 质量结果

| 检查                                | 结果                                             |
| ----------------------------------- | ------------------------------------------------ |
| `pnpm --filter web test:components` | 21 文件、78 用例全部通过                         |
| `pnpm --filter web check:types`     | 通过                                             |
| `pnpm --filter web check:lint`      | 0 errors；739 个既有 warning（与 4.12 基线持平） |
| `pnpm --filter web check:format`    | 通过                                             |
| `pnpm --filter web build`           | 通过                                             |
| 后端 `apps/api`                     | 无代码变更，不触发业务回归                       |

## 4. 验证口径说明

- 390px 溢出：jsdom 不计算布局，组件测试以 `w-[min(400px,100vw)]` 类约束断言；浏览器 boundingRect 走查按 4.12 附录 A 的 fixed 审计口径在发布走查中执行。
- 语言：新增 `not_started_hint`、`handle_current_node` 两键，zh-CN / en 同步。

## 5. 结论

4.13.0 完成 4.12 验收后复核登记的全部偏离修复、架构收敛与总览下一步增强，功能与工程质量验收通过，可以发布 `4.13.0`。
