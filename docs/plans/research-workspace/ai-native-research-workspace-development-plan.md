# AI-Native Research Workspace 分阶段开发计划

| 项目     | 内容                                                                                          |
| -------- | --------------------------------------------------------------------------------------------- |
| 计划版本 | v1.2                                                                                          |
| 日期     | 2026-11-07                                                                                    |
| 状态     | Stage RWS-0 本地技术验证完成；远程 Plane 8.4.1 与本地 9.20.x 未对齐，部署待授权               |
| 目标架构 | [`AI-Native Research Workspace 目标架构`](../../architecture/ai-native-research-workspace.md) |
| 交付策略 | 先完成一个试点课题的纵向闭环，再扩大范围                                                      |
| 默认试点 | 咖啡课题；不做全库迁移                                                                        |
| 实现分支 | `ai-naive-workspace`；禁止直接推送 `main` / `develop`                                         |
| 测试环境 | 本地开发测试机、远程集成测试入口 `http://10.26.15.92:3300/`                                   |

## 1. 阶段总览

| 交付阶段    | 工作包     | 目标                                                          | 估算周期    |
| ----------- | ---------- | ------------------------------------------------------------- | ----------- |
| Stage RWS-0 | P0         | 冻结契约和技术假设，完成 Forgejo、持久卷、身份、RAGPortal POC | 第 1–2 周   |
| Stage RWS-1 | P1         | 建立 StudyWorkspace 资源模型、幂等 Ensure 和固定资源引用      | 第 2–3 周   |
| Stage RWS-2 | P2、P3     | 打通 Forgejo 原生协作、Workspace Runner、持久副本和写租约     | 第 3–6 周   |
| Stage RWS-3 | P4、P5     | 打通数据资产、manifest、Synlora 共享挂载、运行回执和候选提交  | 第 6–9 周   |
| Stage RWS-4 | P6、P7、P8 | 交付 Plane 工作台 UI、阶段固定引用和知识索引投影              | 第 8–12 周  |
| Stage RWS-5 | P9         | 完成咖啡课题迁移、备份恢复、回退和多角色试点验收              | 第 11–13 周 |
| Stage RWS-6 | P10、P11   | 按需补齐云端 IDE、CLI、远程 MCP 和 Coder 多机准备             | 第 12–16 周 |

估算团队配置：

- Plane / 平台后端：2 人。
- Synlora / Agent 后端：1 人。
- 前端：1 人。
- 测试 / 运维合计：约 1 人。

核心闭环 RWS-0 至 RWS-5 约 8–12 周；加入 RWS-6 后约 12–16 周。该估算是工程参考，不是交付承诺。

### 1.1 分支与测试环境策略

#### 分支策略

1. 从当前 `develop` 最新基线新建集成分支 **`ai-naive-workspace`**，全部实现提交只进入该分支。
2. 禁止任何实现提交直接推送 `main` 或 `develop`；也不能在本地把功能变更混入 `main` / `develop` 后再间接推送。
3. `ai-naive-workspace` 是本计划的长期功能集成分支。需要并行开发时，可以创建短生命周期子分支，但子分支 PR 只能合入 `ai-naive-workspace`。
4. 每个 PR 必须保持可部署、可测试，并说明对应 Stage / 工作包、测试环境和未覆盖项。
5. 只有 RWS-5 发布门槛全部通过，并由项目负责人确认后，才允许从 `ai-naive-workspace` 发起合入 `develop` 的发布 PR；`develop` 到 `main` 继续沿用既有发布流程。
6. 合入 `develop` / `main` 前必须按仓库版本管理规则检查版本号和兼容性；仅推 `ai-naive-workspace` 不视为发布。

#### 测试环境

本计划使用两台测试机器，不直接使用生产入口做开发验证：

| 环境           | 地址 / 位置                | 主要职责                                                                     | 数据策略                               |
| -------------- | -------------------------- | ---------------------------------------------------------------------------- | -------------------------------------- |
| 本地开发测试机 | 开发者本机 Plane 环境      | 单元测试、契约测试、迁移初测、Forgejo / MinIO POC、破坏性实验                | 可重建；优先使用测试库和临时卷         |
| 远程集成测试机 | `http://10.26.15.92:3300/` | 浏览器 E2E、多用户协作、Synlora / RAGPortal 集成、迁移 dry-run、备份恢复演练 | 固定测试基线；执行破坏性操作前必须快照 |

环境晋级规则：

1. 本地测试通过并输出证据后，才允许部署 `ai-naive-workspace` 到远程集成测试机。
2. 远程测试机只部署当前检出的 `ai-naive-workspace`，部署时使用 `./scripts/deploy.sh --skip-pull`，避免脚本自动拉取 `develop` 覆盖功能分支。
3. 涉及数据库迁移、Forgejo、持久卷、对象存储或 Synlora 挂载的测试，必须先在本地完成，再在远程测试机执行 dry-run，最后才执行实际变更。
4. 远程测试机执行备份恢复、权限撤回、服务故障注入或迁移演练前，必须记录当前 commit、数据库备份、卷快照和回退命令。
5. 每个阶段的验收证据必须标明环境：`local`、`10.26.15.92:3300` 或 `both`。仅在一个环境通过时，不得写成整体通过。
6. 远程测试机发现阻塞问题时，优先在本地复现并添加回归测试；无法复现的问题保留环境差异、日志和配置摘要。

## 2. Stage RWS-0：技术验证与契约冻结

### 2.1 目标

在写业务代码前验证外部依赖和部署假设，冻结跨系统契约，避免后续用虚假集成或 mock 结果代替真实能力。

### 2.2 工作包 P0

当前已产出的 RWS-0 初版材料：

- [`ADR 0001：AI-Native Research Workspace 首期形态`](../../architecture/adr/0001-ai-native-research-workspace.md)
- [`Research Workspace 跨系统契约`](../../contracts/research-workspace/README.md)
- [`Stage RWS-0 双环境基线记录`](../../operations/research-workspace/rws0-environment-baseline.md)
- [`Stage RWS-0 技术验证证据`](../../evidence/research-workspace/rws0/README.md)

| 任务               | 交付物                                                            | 验收                                  |
| ------------------ | ----------------------------------------------------------------- | ------------------------------------- |
| 固定代码与部署基线 | ADR、真实 commit、部署拓扑、端口和卷映射说明                      | 每个外部依赖有版本和责任人            |
| Forgejo POC        | 独立部署配置、建仓脚本、权限映射脚本                              | 两名真实用户可 clone、push、PR、merge |
| Git / LFS 鉴权验证 | reverse proxy auth 与 shadow token 对比结论                       | 撤权后原生 HTTPS Git 拒绝访问         |
| 持久卷验证         | Runner 与 Synlora 同宿主挂载记录                                  | 容器重启后草稿仍在，UID/GID 正确      |
| RAGPortal 验证     | 实际部署版本、接口和状态同步结论                                  | 上传、状态查询、409 和超时行为有记录  |
| 双环境基线         | 本地与 `10.26.15.92:3300` 的 commit、服务版本、端口、卷和账号清单 | 两台机器均可达，差异和用途明确        |
| 契约冻结           | JSON Schema、错误码、事件示例、兼容规则                           | 评审通过并进入 `docs/contracts/`      |

### 2.3 必须实测的问题

- [x] Forgejo reverse proxy auth 覆盖 Git HTTP / LFS。
- [x] Forgejo webhook 签名、delivery ID 和 push payload。
- [ ] Webhook 重放去重与乱序对账策略。
- Plane / AI4MS 用户 subject 与 Forgejo 用户名的稳定映射。
- [x] Runner 与 Synlora 能挂载同一持久卷。
- [x] 写挂载撤除后新运行不能继续写。
- [ ] 正在运行的旧容器被强制撤权的行为。
- MinIO / 对象存储是否支持版本、校验、保留和下载授权。
- [x] RAGPortal 本地部署版本与 upload / status API 存在性。
- [ ] 远程 RAGPortal / WeKnora 实际部署版本。
- 原始实验数据的大小、保留期和备份责任。

### 2.4 Stage 出口

- [x] ADR 明确服务形态、Git 引擎、存储布局和鉴权方案。
- [x] 外部依赖失败项均有替代方案或明确阻塞。
- [x] `research-resource-ref.v1`、`research-workspace-binding.v1`、`research-dataset-manifest.v1` 契约工程冻结。
- [x] POC 不是全 mock；真实 Forgejo 和持久卷已验证。
- [x] 试点课题范围、回退标准和数据清单确认。
- [x] `ai-naive-workspace` 分支建立，且未推送 `main` / `develop`。
- [x] 本地与 `http://10.26.15.92:3300/` 的环境基线和差异已确认。
- [ ] 远程 Plane 已部署 `ai-naive-workspace` 且与本地版本一致。

## 3. Stage RWS-1：资源模型与幂等控制面

### 3.1 目标

在 Plane 中建立 StudyWorkspace 的最小资源身份；本阶段不接 Forgejo、不做 UI、不迁移文件。

### 3.2 工作包 P1

| 任务         | 主要内容                                                                               |
| ------------ | -------------------------------------------------------------------------------------- |
| 数据模型     | `StudyWorkspace`、`WorkspaceWorkingCopy`、`WorkspaceOperation`、资产与索引投影模型骨架 |
| 固定引用     | `research-resource-ref.v1` 序列化、校验、digest 计算和展示 URI                         |
| 幂等 Ensure  | 以 ResearchChain 为唯一键创建工作区；重复请求返回同一资源                              |
| 操作记录     | 保存 actor、kind、payload hash、expected head、状态和错误                              |
| feature flag | 按 workspace / chain 控制入口，不影响旧研究链                                          |
| 契约测试     | 重复创建、跨工作区访问、无效引用、状态枚举和权限                                       |

### 3.3 主要代码落点

- `apps/api/plane/db/models/research/`
- `apps/api/plane/research/services/workspaces/`
- `apps/api/plane/research/views/`
- `apps/api/plane/tests/contract/app/`
- `docs/contracts/research-workspace/`

实际文件名以开发时分支为准；不要预先写死 Django migration 编号。

### 3.4 Stage 出口

- [ ] 一条链重复 `ensure` 只产生一个 StudyWorkspace。
- [ ] 无权限用户无法探测其他课题工作区。
- [ ] 旧课题在 feature flag 关闭时行为不变。
- [ ] 固定资源引用测试覆盖 Git、LFS 和 Asset 三类。
- [ ] 模型迁移可回滚并在测试库通过。

## 4. Stage RWS-2：Forgejo 协作与 Workspace Runner

### 4.1 目标

让多人可以在本地和云端围绕同一课题仓库真实协作，并让 Plane 网页操作写入持久 WorkingCopy。

### 4.2 工作包 P2：Forgejo 集成

| 任务     | 内容                                                      |
| -------- | --------------------------------------------------------- |
| Provider | 在既有仓库登记模型上扩展 Forgejo provider，不做大而全抽象 |
| 建仓     | 以 StudyWorkspace 稳定 ID 建私有仓库和默认模板            |
| 权限同步 | Plane 研究角色映射到 Forgejo team / repository permission |
| 分支保护 | `main` 禁止强推，PR 合并，Agent 分支仅服务身份可写        |
| PR 代理  | Plane 工作台可创建、查看、评论和合并 PR                   |
| Webhook  | 签名校验、delivery ID 去重、远端 refs 对账                |
| Git 访问 | HTTPS Gateway 或经验证的 Forgejo 直接 HTTPS 访问          |

### 4.3 工作包 P3：Runner 与 WorkingCopy

| 任务           | 内容                                                            |
| -------------- | --------------------------------------------------------------- |
| 独立进程       | Runner 不运行在 Django Web 进程内                               |
| mount registry | 服务端注册 mount_ref，拒绝任意路径                              |
| 副本创建       | 按用户 / Agent / 分支创建独立持久副本                           |
| Git 隔离       | workspace 与 Git 元数据分离；受控 argv、禁 hooks、禁任意 remote |
| 文件 API       | tree、read、write、upload、status，路径防逃逸                   |
| 原子写         | expected ETag、临时文件、原子替换、配额检查                     |
| 写租约         | 单活动写者、lease epoch、到期撤权、长任务心跳                   |
| Git 操作       | commit、fetch、integrate、push，不 force reset 草稿             |

### 4.4 Stage 出口

- [ ] 两名学生本地建分支、推送，导师在 Plane 比较、评论并合并。
- [ ] 原生 Git HTTPS 绕过网页时仍执行 repo ACL。
- [ ] 撤权后 clone、fetch、push、API 和预签名 URL 均失效。
- [ ] Plane 保存文件后，Runner 目录中的 hash 一致。
- [ ] 同一 WorkingCopy 第二个写者被拒绝。
- [ ] 容器或 Runner 重启后未提交草稿仍在。
- [ ] 伪造 `.git`、hook、路径逃逸和任意 remote 均被拒绝。

## 5. Stage RWS-3：数据资产与 Synlora 共享执行

### 5.1 目标

把大实验数据纳入不可变版本，并让 Synlora 与 Plane 真正使用同一个 WorkingCopy。

### 5.2 工作包 P4：数据资产

| 任务           | 内容                                                          |
| -------------- | ------------------------------------------------------------- |
| 分片上传       | 声明 size / sha256，分片上传，完成后流式校验                  |
| 不可变版本     | `ResearchAssetRevision` 一版一 hash，READY 后不可覆盖         |
| manifest       | `research-dataset-manifest.v1` 保存逻辑路径、hash、来源和字典 |
| LFS 校验       | commit 存在但 LFS 对象缺失时标记不完整                        |
| required check | 缺 LFS / 资产的分支不能作为正式材料或可复现输入               |
| 资产物化       | Agent 只读挂载或按需下载，下载后再次校验                      |

### 5.3 工作包 P5：Synlora 绑定

| 任务        | 内容                                                             |
| ----------- | ---------------------------------------------------------------- |
| 受信绑定    | 以 StudyWorkspace / WorkingCopy 为共享逻辑身份                   |
| 短期凭据    | Synlora 向 Plane / Runner 校验 grant，不信任客户端能力扩张       |
| 挂载根      | 只挂载当前授权 WorkingCopy 到 `/workspace`                       |
| 运行分支    | 默认 `agent/<run-id>`，不直接写 main                             |
| 输入固定    | input commit、资产清单、Skills digest、MCP snapshot、镜像 digest |
| run receipt | 保存委托人、参数、输出、改动清单、退出状态和候选提交             |
| 失败语义    | 绑定失效直接失败，不回落个人目录                                 |
| 删除保护    | 删除 Synlora 会话不删除共享课题工作区                            |

### 5.4 Stage 出口

- [ ] Plane 保存后 Synlora 直接读取同一文件，hash 一致且无二次上传。
- [ ] Agent 输出出现在运行分支，可查看与 main 的差异。
- [ ] Agent 产物生成候选提交 / PR，不直接修改 main。
- [ ] 停止容器和会话后，草稿、结果和资产仍在。
- [ ] 撤权后旧运行不能继续写。
- [ ] 多 GB 数据分片中断后可恢复，不产生半文件 READY。
- [ ] Synlora 旧个人项目回归通过。

## 6. Stage RWS-4：Plane 工作台、阶段证据与知识投影

### 6.1 目标

让学生和导师不用命令行完成主流程，同时保持科研审批与知识索引边界。

### 6.2 工作包 P6：工作台 UI

首期页面能力：

- 工作区总览：分支、基线、远端差异、存储和运行状态。
- 文件树与阶段筛选。
- Markdown / 文本预览和基础编辑。
- LFS 与资产的元信息展示和授权下载。
- 变更列表、diff、commit、fetch、push、冲突提示。
- PR 列表、详情、评论、合并。
- Agent 运行结果、run receipt 和候选改动入口。

UI 遵循 `academic-editorial-ui`，不得新增渐变、发光、彩色卡片或 AI 仪表盘装饰。

### 6.3 工作包 P7：阶段固定引用

| 任务     | 内容                                                      |
| -------- | --------------------------------------------------------- |
| 材料引用 | MaterialItem 支持旧 upload 与新 resource_ref 并存         |
| 提交冻结 | 固定 commit、path、blob / LFS / asset hash 和材料要求版本 |
| 阶段标签 | 审批通过后创建受保护 `stage/<STAGE_CODE>/v<N>`            |
| 快照回放 | v1 审批在 v2 出现后仍能精确恢复                           |
| 评估失效 | 相关输入变化可见，不篡改历史评估                          |
| 审批边界 | Git PR 合并不推进科研阶段                                 |

### 6.4 工作包 P8：知识投影

| 任务     | 内容                                           |
| -------- | ---------------------------------------------- |
| 手动推送 | 用户选择固定 commit/path 或 asset revision     |
| 幂等任务 | source digest + KB + 策略版本唯一              |
| RAG 调用 | 复用现有 `POST /api/uploads` 和状态查询        |
| 回执映射 | 保存 upload_id、knowledge_id、generation、状态 |
| 对账     | 超时、409、乱序回执不误报成功                  |
| 状态 UI  | 区分源文件 READY 与索引 READY                  |
| 失败恢复 | 只重试投影，不回滚源文件                       |

### 6.5 Stage 出口

- [ ] 学生和导师不用命令行完成上传、保存版本、分支、diff、PR 和合并。
- [ ] 阶段材料能固定到具体版本。
- [ ] v1 审批与 v2 修改可并行回放。
- [ ] RAGPortal 超时、409、乱序回执状态正确。
- [ ] 知识库不可用时不影响源文件保存、Git 提交和旧审批查看。

## 7. Stage RWS-5：试点迁移、备份与发布验收

### 7.1 目标

只迁移咖啡课题，完成真实多角色闭环和恢复演练，形成可回退发布包。

### 7.2 工作包 P9

#### 7.2.1 迁移前库存

导出并核对：

- ResearchChain、Project、OrgUnit 和权限。
- ResearchChainUpload 与旧下载链接。
- FileAsset 课题材料。
- RAGPortal 上传状态和 knowledge_id。
- Synlora 历史个人目录与会话上下文。
- 现有 Git 登记和外部引用。
- hash、大小、可下载性和归属。

#### 7.2.2 迁移规则

1. 只给咖啡课题创建 StudyWorkspace 和私有 Forgejo 仓库。
2. 老文件经既有授权端点下载并校验 hash。
3. 按类型进入 Git、LFS 或资产层。
4. 无法下载或无法归属的文件保留 `LEGACY_EXTERNAL` / 待归类，不伪造归属。
5. 旧 upload_id 与新 source_ref 建立映射。
6. 旧审批快照保持原样，不后台追认新文件。
7. 双读单写：旧数据可读，试点新写入只写新工作区。

#### 7.2.3 备份与恢复

备份对象：

- Forgejo bare repo 与 LFS。
- Plane 数据库。
- 未提交 WorkingCopy。
- 对象资产与 manifest。
- Agent run receipt。
- 索引投影和对账记录。

先做一课题冷备恢复，再扩大。恢复后逐项校验 commit、对象 hash、审批引用和运行回执。

### 7.3 Stage 出口

- [ ] 咖啡课题完成真实纵向闭环。
- [ ] 学生、导师、PI、平台管理员分别验收。
- [ ] 旧上传链接、旧审批和旧个人项目仍可用。
- [ ] 新增资源可导出；回退包包含兼容读适配。
- [ ] Git、LFS、资产、审批引用和 run receipt 可从备份恢复。
- [ ] 权限撤回演练通过。

## 8. Stage RWS-6：AI-native 增强与规模化准备

### 8.1 工作包 P10：最小增强

只有 RWS-5 通过后才开始。

| 能力           | 首期边界                                                 |
| -------------- | -------------------------------------------------------- |
| 云端 IDE       | 最小 JupyterLab / code-server 启动，挂载既有 WorkingCopy |
| 本地文档       | 标准 Git / Git LFS 使用说明，不要求自定义 CLI            |
| 轻量 CLI       | 可选封装 clone、数据 pull、PR；不是核心依赖              |
| 远程 Agent MCP | 为未挂载工作区的专项 Agent 提供受控工具                  |
| Skills / MCP   | 显式选择、digest 锁定、工具白名单，不自动执行仓库脚本    |

### 8.2 工作包 P11：规模化

| 能力               | 进入条件                                             |
| ------------------ | ---------------------------------------------------- |
| Coder              | 明确需要多机、GPU、模板化开发环境或更强资源调度      |
| OpenHands adapter  | 存在 Synlora 无法满足的明确场景，且不绕开 Plane 授权 |
| 多机 Runner        | POSIX 卷或远程 Runner 适配已通过验证                 |
| 自动索引           | 已合并 main 且显式允许发布的资料策略明确             |
| push mirror / 双活 | 数据主权、带宽、冲突和合规要求明确                   |

### 8.3 Stage 出口

- [ ] 云端环境重建不重建或误删研究数据卷。
- [ ] 自定义 CLI 不成为基础协作前置依赖。
- [ ] 远程 MCP 无法越权访问其他课题。
- [ ] 未实施的 Coder / OpenHands 功能不在 UI 显示为已接通。

## 9. PR 拆分与并行策略

| PR 类型          | 建议大小 | 说明                                 |
| ---------------- | -------- | ------------------------------------ |
| 契约 / ADR       | 小       | 只改文档与 schema，不混业务代码      |
| 模型迁移         | 中       | 必须包含兼容测试和回滚说明           |
| 服务纯函数       | 小       | digest、引用校验、状态机可先独立交付 |
| Forgejo Provider | 中       | 只实现当前需要的 API，不做通用框架   |
| Runner           | 中       | 每次只交付一个操作组                 |
| Synlora 绑定     | 中       | 保留个人项目回归                     |
| UI               | 中       | 按页面区域或旅程拆分                 |
| 迁移脚本         | 中       | dry-run、对账报告和回退策略同 PR     |

可并行：

- 契约文档与模型测试。
- Forgejo Provider 与 Runner 内部 Git 操作。
- UI mock 与后端 API。
- Synlora 绑定与 Plane 阶段引用。

必须先冻结：

- 数据库 schema。
- resource ref 与 binding schema。
- 错误码和状态机。
- mount_ref 和租约语义。
- RAGPortal 对账规则。

## 10. 验收矩阵

| ID  | 场景                           | 通过标准                                  |
| --- | ------------------------------ | ----------------------------------------- |
| A01 | 一链重复初始化 / 超时重放      | 只有一个 StudyWorkspace 和一个仓库        |
| A02 | Plane 与 Synlora 同盘读写      | hash 一致，无二次上传                     |
| A03 | 容器 / 会话停止重启            | 草稿、提交和资产仍在                      |
| A04 | 两学生、多导师分支协作         | fetch、push、PR、merge 可用，冲突不覆盖   |
| A05 | 同副本并发写                   | 第二写者被拒绝；租约到期旧运行停止        |
| A06 | 原生 Git HTTPS                 | 仍执行 repo ACL；撤权后拒绝访问           |
| A07 | 伪造 `.git` / hook / 路径      | 不能逃逸或执行宿主 hook                   |
| A08 | v1 审批后产生 v2               | v1 仍精确可回放，新评估提示输入更新       |
| A09 | LFS / 资产缺失                 | 不能通过阶段 required check 或可复现运行  |
| A10 | 大文件分片中断                 | 可恢复或清晰失败，不产生半文件 READY      |
| A11 | 相同内容跨权限域               | 不泄露存在性，授权域内才可复用            |
| A12 | Agent 修改结果或 receipt       | 文件是候选提交，权威审计不可改写          |
| A13 | RAG 超时、409、乱序            | 对账后处理，不覆盖新源版本                |
| A14 | 共享 KB 查询                   | 按授权过滤并显示来源                      |
| A15 | 旧上传和旧下载链接             | 仍可读，hash 与归属正确                   |
| A16 | 无法归属的 Synlora 历史        | 待归类，不自动分给课题                    |
| A17 | Windows 大小写 / 保留名 / 中文 | 上传前提示不可移植冲突                    |
| A18 | 本地与云端分叉                 | 保留双方并提示处理，不自动覆盖            |
| A19 | Git / DB / 对象存储故障        | 状态可解释，恢复后可对账                  |
| A20 | 整课题备份恢复                 | Git、LFS、资产、审批和 run receipt 可校验 |
| A21 | KB 或 AI 不可用                | 源文件、Git 和旧审批不受影响              |
| A22 | 浏览历史阶段                   | 不改变业务推进阶段和审批数                |
| A23 | 模板 / 目录 / 重复文献         | 不自动充当多个原创材料                    |
| A24 | Synlora 个人项目切换           | 身份、路径和上下文明确，未保存内容不丢    |

## 11. 发布门槛

1. A01–A24 中属于当前发布范围的项目全部有通过、失败、未测三态证据。
2. 核心契约测试、Django 迁移测试、真实 Forgejo 集成测试通过。
3. 至少一个真实课题由学生、导师和平台管理员分别验收。
4. 完成权限撤回、服务故障和冷备恢复演练。
5. 旧研究链、旧上传链接和 Synlora 个人项目回归通过。
6. 未实施的 Coder、OpenHands、CLI 或自动索引不得显示为已接通。
7. 迁移脚本必须先 dry-run，输出 hash 对账报告，并包含回退方案。
8. 全部实现仍停留在 `ai-naive-workspace`，没有直接推送到 `main` / `develop`。
9. 本地与 `http://10.26.15.92:3300/` 的通过、失败、未测证据已分开记录。

## 12. 风险与应对

| 风险                                        | 影响         | 应对                                               |
| ------------------------------------------- | ------------ | -------------------------------------------------- |
| Forgejo reverse proxy auth 不覆盖 Git / LFS | 统一身份受阻 | P0 首先验证；不可用则走 per-user shadow token      |
| 普通目录被误当作安全隔离                    | Agent 越权   | `.git` 独立、只挂 workspace、受控 argv、能力白名单 |
| 同副本多写者覆盖数据                        | 草稿丢失     | 单活动写者、租约 fencing、独立副本和分支           |
| 大文件进入普通 Git                          | 仓库膨胀     | 10 MiB / 200 MiB 策略、pre-receive、manifest 分流  |
| RAGPortal 状态误判                          | 索引假成功   | 幂等任务、generation、409 / 超时对账               |
| 历史归属不清                                | 迁移错分课题 | 双读单写、待归类、不自动共享个人目录               |
| Git 与 DB 部分成功                          | 状态漂移     | WorkspaceOperation 意图记录和恢复动作              |
| 多机卷不可用                                | 无法扩展     | 首期单宿主；多机前验证 POSIX 卷或远程 Runner       |
| 用户不熟悉 Git                              | 采用率低     | Plane 按钮化旅程，保留明确语义和冲突提示           |

## 13. 开发纪律

1. 每个 PR 必须说明用户可观察行为、兼容策略、测试证据和未覆盖项。
2. 外部系统测试不得全部 mock；至少真实 Forgejo、持久卷和对象存储进入 CI 或验收环境。
3. 不用上传副本演示冒充同盘运行。
4. 不把目录名、用户名或课题标题拼接为授权路径。
5. 不提交密钥、长期下载地址或原始 MCP token。
6. 不用 Git PR 替代科研审批。
7. 不把估算工期写成已验证性能。
8. 每个阶段完成后回写本文状态和实际偏差；未运行的项目保持“未测”。
9. 所有实现提交只进入 `ai-naive-workspace`；短分支合入该分支，发布前不得混入 `main` / `develop`。
10. 本地测试负责快速反馈和破坏性实验，`http://10.26.15.92:3300/` 负责集成验收；两边证据不可互相冒充。
