# Plane API / MCP 管理修复验证记录

初次验证：2026-10-21；提交前复验：2026-10-22（Asia/Shanghai）。开发目录：`D:/plane-main/plane-dev`。

提交分支：`fix/api-token-mcp-settings`，基于最新拉取的 `develop` 提交 `ae5ff902`（5.2.2）。

## 交付范围

个人 API 令牌表格、脱敏 Key、重命名和删除，以及 `/settings/profile/mcp/` 内的行政身份验证、来源工作区/科研链/节点选择、独立连接批量签发、配置导出和统一撤销管理。页面细节已按用户验收调整：隐藏内部 ID、撤销成功隐藏卡片、没有连接的科研工作区不展示空分组。

行政与科研沿用各自凭据及机器协议；科研写入仍需“准备提案 → 人工确认 → 执行”。没有新增共享机器地址、通用密钥或 API 权限范围。

接口、发布要求和后续边界见 [MCP 统一管理](mcp-unified-management.md)。

## 最终基线的验证结果

| 检查                            | 结果                | 覆盖范围                                                                                                                                 |
| ------------------------------- | ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| PostgreSQL 后端与行政桥接       | 95 项通过           | 个人令牌、候选权限、只读不可升级、跨工作区/节点/授权 ID 拒绝、会话与 CSRF、撤销、原科研协议、并发执行、有效期、日志脱敏与桥接隔离        |
| 独立行政门户                    | 17 项通过           | 候选权限交集、不可达反馈、凭据隔离、既有 HTTP/MCP 连接和撤销                                                                             |
| Web 组件及服务                  | 42 项通过，6 个文件 | 令牌错误/重试/重命名/删除/一次性密钥、中英文真实翻译加载、节点分页与选择、批量部分失败与重试、跨目标状态隔离、撤销、空科研分组和配置格式 |
| Web 类型检查                    | 通过                | 路由类型生成与 `tsc --noEmit`                                                                                                            |
| 依赖包及 Web 生产构建           | 11/11 通过          | 基于 5.2.2 重新构建全部 Web 依赖和静态客户端/服务端产物                                                                                  |
| Django 系统检查                 | 通过                | 0 issues                                                                                                                                 |
| 迁移图及模型一致性              | 通过                | 无冲突、无遗漏模型变更；包含 develop 迁移分支的合并迁移                                                                                  |
| 新增后端文件及 API 视图静态检查 | 通过                | Ruff 检查新接口、测试、迁移及 API 令牌视图/序列化器                                                                                      |

提交前检查还运行仓库自带格式化和前端静态检查钩子。构建日志保留现有包模块类型、插件时间和构建体积提示；类型检查和组件测试保留本地依赖链接提示，命令退出状态均为成功。未把提示或此前失败标记为测试通过。

复验时发现旧独立桥接测试使用 DRF 默认的未登录 403，而 Plane 实际认证异常处理返回 401。现将独立测试配置与现有 Plane 处理对齐并重新通过全部 95 项；没有为适配测试修改生产认证行为。

初次 SQLite 回归存在 4 项 PostgreSQL JSON 查询不兼容，最终使用临时 PostgreSQL 验证。初次历史结果和旧 develop 的更广泛回归不计入上表。

### Web 命令

依赖构建完成后执行组件测试及类型检查：

```powershell
pnpm exec turbo run build --filter=web...
pnpm --filter web test:components tests/components/api-token-management.test.tsx tests/components/api-token-service.test.ts tests/components/api-token-translations.test.tsx tests/components/mcp-management.test.tsx tests/components/mcp-services.test.ts tests/components/mcp-config.test.ts --maxWorkers=1
pnpm --filter web check:types
```

### 后端隔离方式

使用任务专用虚拟环境与独立临时 PostgreSQL 数据库，测试库以 `test_mcp_management_` 开头，默认连接不指向应用数据库。使用内存缓存、内存消息配置与合成夹具。测试运行器创建并在退出后删除测试库；测试没有删除真实令牌、撤销真实连接或批准真实科研提案。

后端测试文件：

```text
plane/tests/contract/app/test_api_token_management.py
plane/tests/contract/app/test_mcp_management.py
plane/tests/contract/app/test_research_machine_access.py
plane/tests/contract/app/test_research_agent_operations.py
plane/tests/unit/research/test_context_token_lifetimes.py
plane/tests/unit/middleware/test_logger.py
plane/mcp/tests.py
```

测试以 `--nomigrations` 创建隔离模型表；迁移图及模型状态另行检查，不宣称已在生产执行迁移。行政门户测试使用临时 SQLite 凭据库、模拟 Plane 上游与本机随机端口 HTTP/MCP 服务，不使用真实门户账号。

## 发布与人工验收

1. 发布时执行标准迁移，包含连接名称字段迁移 `0188_research_context_connection_label` 与空操作合并迁移 `0190_merge_mcp_and_asset_preview`，同步 Plane API、Web 和独立行政门户（提供 `/connect/api/candidates`）。不回写或轮换原密钥。此前本机页面验收已应用名称字段迁移；提交前复验没有对真实数据库迁移或发布服务。
2. 用户已验收页面布局；仍需在目标环境用隔离账号检查同实例/跨实例来源、独立门户身份，以及键盘/触屏交互。
3. 在实际目标客户端导入多个命名服务项，逐个核对范围、有效期、读取和撤销后的拒绝。
4. 在隔离环境联调科研“准备 → 人工确认 → 执行”，确认成员退出、开关关闭、状态变化和到期后的拒绝。此次不包含完整提案审核工作台。
5. 真实代理环境的无斜杠请求未用真实账号重放；接口地址不一致已修正，不能认定它是现场删除失败的唯一原因。

## 工作区与保留项

只在 `D:/plane-main/plane-dev` 工作。未强制重置、重跑 setup.sh、覆盖环境配置或启动 `docker-compose-test.yml`，未清空真实数据。用户原有的 Windows 部署脚本、服务器部署笔记和旧部署文档标题修改保留在工作区，不混入此功能提交。
