# Phase 1.5 issue0925 验收台账

## 运行环境与数据基线

- 代码分支：`develop`（包含本轮未提交变更）
- 后端/实例版本：`4.14.2`
- Web/Admin：已按 `4.14.2` 重新构建并重启
- 运行库：`public` 已重建 π-Lab 基线；`pi` 科研业务数据为 0
- 基线断言：22 个组织节点、189 名学生、14 位导师、唯一 PI 洪文晶、152 条主导师绑定、37 条主导师缺口、0 个预造课题/链/KB
- 有效备份：`.runtime/backups/pi-lab-20260925T133734Z`
  - PostgreSQL SHA-256：`91fe1d2f7ba89a567f980420809d512afd8f9b76956cac7d5f5e73af33f6aece`
  - MinIO 快照 SHA-256：`0b40eb8eb5ffd7506122990da0532002f7a6ff876e794b5d1cf4e32304d3e4b5`
  - 恢复演练：PASSED；一次性凭据 manifest 权限 `0600`
- 旧科研对象：1 个仍被数据库引用的旧科研 PDF 已删除，Head Object 验证 404
- 身份映射：旧映射已清空（0 条）；真实 AI4MS ↔ Plane 绑定等待双方 OIDC 认证，未伪造

## 问题状态

| 编号 | 状态 | 证据与剩余动作 |
| --- | --- | --- |
| P15-O01 workflow 换行 | 代码完成 / 待真实课题截图 | `research-chain-workflow-rail` 390px 单/双列与桌面 wrap 组件测试通过；浏览器空科研页 1440/390 均无横向溢出 |
| P15-O02 节点操作入口 | 自动化通过 / 待浏览器验收 | Chain detail 组件测试覆盖节点上下文与动作区 |
| P15-O03 报告成果与实验外部资产 | 自动化通过 | Reports/Outcomes/Experiments 124 项相关契约测试通过 |
| P15-O04 一课题一 KB 申请与 READY 门禁 | 代码完成 / 待首个真实 KB 回填 | Project 创建与 Chain 创建均生成 `PENDING_ADMIN`；非 READY 上传返回 `KB_NOT_READY`，86 项关键 API 测试通过 |
| P15-O05 文件选择反馈 | 组件测试通过 / 待浏览器验收 | KB 面板与导入面板组件测试通过 |
| P15-O06 成员操作回执 | 组件测试通过 / 待浏览器验收 | Chain detail/user import 相关组件测试通过 |
| P15-O07 节点提交后可读 | 自动化通过 | Chain detail/生命周期测试通过 |
| P15-O08 Project—Profile—Chain—KB 一对一 | 自动化通过 | 项目创建组合关系与 KB 申请由 124 项项目/资源测试覆盖 |
| P15-O09 PRIVATE 课题越权 | 自动化通过 | Security/Phase1 E2E 负例通过 |
| P15-O10 科研摘要多课题切换 | 代码完成 | 摘要组件测试通过；修复错误 i18n key；门户同样支持切换 |
| P15-O11 跨组件待办分页 | 组件测试通过 | Todo index 最多 5 行与分页测试通过 |
| P15-O12 项目类型说明 | 组件测试通过 / 待人工视觉复核 | 项目列表/导航组件测试通过 |
| P15-O13 学生/导师/Main PI 报告范围 | 自动化通过 | Reports/Reviews/Capabilities 相关测试通过 |
| P15-O14 可见即可审 / 范围越权 | 自动化通过 | Reports/Reviews/Approvals 负例通过；当前待审批项由有效导师或洪文晶处理 |
| P15-O15 身份映射与 OIDC | 数据清理完成 / 真实绑定待认证 | 旧映射 0 条；不采集或保存明文密码 |
| P15-O16 平台配置与 Main PI 展示 | 自动化通过 / 待浏览器截图 | 洪文晶为唯一配置 Main PI 和 MAIN_PI 标签 |
| P15-O17 PI/导师 Agent review | 代码完成 | REVIEW scope serializer/工具策略/草稿边界修复，23 项 Agent 测试通过 |
| P15-O18 Agent 输出结构化 | 组件测试通过 / 待真实会话验收 | Agent 插件/侧栏/审批队列组件测试通过 |
| P15-D01 全实例数据重建 | 完成 | 备份、恢复演练、清理、重建、幂等和空 `pi` 断言通过 |

## 测试记录

- API 全量：`1414 passed, 1 skipped`（唯一 skip 为 CI 镜像不含真实 xlsx；本机 dry-run 和运行库 verify 均通过）
- 导入/关系：`50 passed`
- Chain/KB/Agent/Security 关键集：`86 passed`
- Projects/Reports/Outcomes/Experiments/Reviews/Account links：`124 passed`
- Web 科研组件：19 个文件，`79 passed`
- Web 检查：format 通过、typecheck 通过、lint 0 error（存量 warning 在允许阈值内）
- 构建：Web/Admin 均成功；API `/`、Web `/` 与 Admin `/god-mode/` 均返回 200
- 浏览器：1440 与 390 宽度 `scrollWidth == clientWidth`，截图见 `rebuilt-public-research-1440.png`、`rebuilt-public-research-390.png`
- 浏览器控制台：1440/390 均 0 error；同构 HydrateFallback 已修复存量 hydration `#418`，Vite preview 显式指向 `build/client` 后深链返回 200

## 验收限制

真实基线不预造课题，因此 workflow、节点、成员、KB 上传和 Agent 会话的“真实课题截图”必须在第一个真实课题创建后补录。禁止为生成截图向 `public` 写入虚构课题。
