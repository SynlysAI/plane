# Plane 4.27.0 本机部署验收

验收日期：2026-10-12。部署目录：`D:\plane-main\plane-dev`。

## 部署结果

- 已执行 `git fetch origin develop`；远端为 `577b97f9b09beeba86f18335ed7aec609fb32358`，本地 `demo/sciencediscovery-mcp` 基于该提交，应用版本为 4.27.0。
- 使用原有六份私密配置和 Compose 项目 `pilab-windows`；API/Worker/Beat 已切换挂载到新版 `apps/api`。数据库、存储、Redis、RabbitMQ 及 ScienceDiscovery 沿用现有服务和数据。
- 新版数据库迁移 `0166_project_navigation_categories` 和 `0167_research_task_paper_review_models` 均成功应用。迁移前 Django `check` 为 0 issues。
- 锁定依赖安装成功，Web/Admin/Space/Live 及依赖包的 16 项构建全部成功。四个应用已在后台运行。
- 旧版源码、构建产物和带 `before-4.27` 标签的后端镜像保留。部署操作未合并分支或更新团队环境，代码与文档另行通过独立分支提交审查。

## 实际检查

| 检查项                                    | 结果                                                    |
| ----------------------------------------- | ------------------------------------------------------- |
| API `:8001/`                              | 200，JSON 健康响应                                      |
| Web `:3000/`                              | 200；响应 SHA-256 与新版 `build/client/index.html` 一致 |
| Admin `:3001/god-mode/`                   | 200                                                     |
| Space `:3002/spaces/`                     | 200，SSR Preview                                        |
| Live `:3100/live/health/`                 | 200                                                     |
| Web/Admin/Space 的 `/api/instances/` 代理 | 全部 200                                                |
| Web 的 `/auth/get-csrf-token/`            | 200，设置 CSRF cookie                                   |
| MinIO 就绪检查                            | 200                                                     |
| ScienceDiscovery 健康检查                 | 200                                                     |
| 官方 Plane MCP                            | 项目、状态、四条任务、分页和已有评论读取通过；未写入    |
| ScienceDiscovery MCP Inspector            | 原连接器读取项目及四条任务通过                          |
| Demo 数据                                 | 2 条完成、1 条进行中、1 条未开始；分析任务仍为 1 条评论 |

数据库只读统计为 2 个账号、1 个工作区、2 个项目、4 条工作项和 1 条评论；两项新增迁移均已记录。没有重置已有账号的密码。

这次验证了登录页面所需的页面、API 代理和 CSRF 通路，没有代替用户输入密码完成交互式登录。没有重复调用模型生成新报告，也没有重复写入评论；模型主动调用 MCP 的先前证据见 Demo `output/run-read.json`，本次升级后的连接兼容性由真实 Inspector 和官方 MCP 调用验证。

## 测试限制

直接运行上游 `apps/web` 的 `node --test tests/*.test.mjs`：17 项中 15 项通过，2 项 `research-reference-audit` 测试失败，分别涉及运行时引用分类和 baseline 的 `reused` 状态。前端完整构建及上述实际服务检查通过。

后续隔离排查已确认：测试夹具使用 `/research-reference-fixture/...`，Windows 的 `normalize` 保留无盘符路径，而模块解析的 `resolve` 补上当前盘符，导致引用匹配失败。在忽略目录中生成临时测试副本，仅把夹具根目录转换为本机绝对路径，该组 4 项测试全部通过。原审计脚本和原测试未修改；正式 Web 测试结果仍记录为 15/17 通过，该跨平台测试修复可独立提交。

两个 Windows PowerShell 启动脚本通过语法解析，并已用于本次实际启动。完整 Django 业务测试、科研新功能的逐项 UI 验收、附件浏览器上传和多人协作不在本次验收范围。

## 本机证据及备份

忽略目录 `.runtime/windows-upgrade/2026-10-12-4.27.0/` 保存：

- `plane-before-4.27.dump`：初始数据库备份。
- `plane-cutover-4.27.dump`：停止旧应用后、迁移前的数据库备份；恢复时优先核对这一份。
- `uploads-before-4.27.tar.gz`、`config/`：附件及私密配置备份。
- `backup-manifest.json`：备份大小与 SHA-256。
- `backend-preflight.log`、`build.log`、`deployment.log`：预检、构建、迁移与启动。
- `http-verification.json`、`mcp-verification.json`、`verification.json`：HTTP、官方 MCP 和 ScienceDiscovery MCP 验收。
- `web-tests-direct.log`：包含两项失败的上游 Web 测试输出。
- `research-reference-audit.windows-path.test.mjs`：隔离验证 Windows 绝对路径夹具的临时副本，4 项通过。

配置备份、数据库 dump 和附件可能包含私密内容，留在本机恢复使用。日常操作见 [Windows 部署说明](README.md)。
