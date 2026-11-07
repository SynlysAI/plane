# ADR 0001：AI-Native Research Workspace 首期形态

| 项目     | 内容                                                                          |
| -------- | ----------------------------------------------------------------------------- |
| 状态     | 已接受                                                                        |
| 日期     | 2026-11-07                                                                    |
| 决策范围 | Plane、Forgejo、Workspace Runner、Synlora、RAGPortal / WeKnora                |
| 实现分支 | `ai-naive-workspace`                                                          |
| 上游文档 | [`AI-Native Research Workspace 目标架构`](../ai-native-research-workspace.md) |

## 背景

Plane 研究链的课题资料目前分散在 RAGPortal 上传、Plane 文件资产和 Synlora 个人目录中，缺少统一版本、多人分支协作、离线工作、Agent 可复现输入和阶段证据回放能力。直接引入一个独立 Workspace 微服务会同时增加身份映射、权限同步、部署和迁移复杂度；而只给现有资料入口增加文件夹也不能满足“同盘执行、真实 Git、大实验数据和版本化审批”的目标。

## 决策

1. **一条 ResearchChain 对应一个 StudyWorkspace，并对应一个 Forgejo 私有仓库。**
2. **首期在 Plane 仓库内实现研究工作区控制面，不新建独立 RWS Web 服务。**
3. **新增独立 Workspace Runner 进程执行文件、Git、租约和资产物化操作；Django Web 进程不持有 Docker socket，也不直接写全部课题目录。**
4. **Forgejo 独立部署，只通过 API、Webhook 和 HTTPS Git 协议集成，不修改其源码。**
5. **Synlora 保留现有 harness 和 Docker 沙箱，通过受信 StudyWorkspace / WorkingCopy 绑定访问共享工作副本。**
6. **普通文本进入 Git，中等二进制进入 Git LFS，原始实验数据和大结果进入不可变对象资产层，Git 只保存 manifest。**
7. **RAGPortal / WeKnora 只作为固定版本的派生知识投影，不反向成为文件权威源。**
8. **Plane 阶段审批仍是唯一正式审批；Git PR 合并、Agent 运行成功和知识库索引 READY 是不同事件。**

## 备选方案

| 方案                       | 不采用为首期默认的原因                                              |
| -------------------------- | ------------------------------------------------------------------- |
| 独立 RWS 微服务            | 需要额外身份、权限、部署和迁移面；在单宿主试点阶段收益不足          |
| OneDev                     | Git、CI 和工作区能力与 Plane / Synlora 重叠更多；可作为后续替代选型 |
| Coder 首期必装             | 云端 IDE 和资源调度有价值，但会推迟核心资料、Git、Agent 同盘闭环    |
| OpenHands 替换 Synlora     | 会形成两套 Agent 主链，且不能复用现有科研上下文和沙箱治理           |
| 将所有课题放在一个共享目录 | 无法隔离并发写者、Agent 权限和 Git 分支，容易互相覆盖               |

## 后果

### 正面影响

- 复用 Plane 的组织、课题、13 阶段、审批和 Agent Context 权限体系。
- Forgejo 提供成熟的原生 Git、PR、分支保护和 LFS 能力。
- Synlora 可以在同一持久 WorkingCopy 上执行，避免二次上传和上下文漂移。
- 大实验数据不进入普通 Git 对象，阶段审批能固定到内容 hash。
- WeKnora 故障不会阻断源文件保存和 Git 提交。

### 需要接受的成本

- Plane 数据模型、服务层和测试范围扩大。
- Runner、Forgejo、Synlora 和对象存储需要联合部署与备份。
- 同一副本必须实施单活动写者和租约 fencing。
- 旧上传、旧审批和 Synlora 个人目录需要双读单写迁移。
- 多机部署前必须重新验证 POSIX 卷或远程 Runner。

## 验证要求

Stage RWS-0 必须在本地测试机和 `http://10.26.15.92:3300/` 两处记录证据，并完成：

- Forgejo 建仓、权限、分支保护和 webhook 验证。
- Git HTTPS / LFS 鉴权与撤权验证。
- Runner、Synlora 和持久卷同宿主挂载验证。
- RAGPortal 实际部署版本和上传状态行为验证。
- 三份契约 Schema 评审。

在上述验证完成前，不得宣称 Workspace 已接通，也不得把 mock 结果写成真实集成结果。
