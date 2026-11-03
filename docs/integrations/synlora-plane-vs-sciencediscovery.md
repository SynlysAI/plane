# Synlora × Plane 与 ScienceDiscovery × Plane 集成评估

## 范围

本文基于 Plane 与 Synlora 当前代码，以及 ScienceDiscovery × Plane 已有联调能力说明进行评估。此次工作只完善 Synlora × Plane；不修改 ScienceDiscovery 集成实现，也不合并两套执行链路。

## 两种集成的侧重点

| 维度         | Synlora × Plane                                                                          | ScienceDiscovery × Plane                                                           |
| ------------ | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| 执行位置     | Synlora 云端 Runtime                                                                     | Plane 侧本地/受控执行面                                                            |
| 身份与授权   | Plane BFF 代签 delegated auth；按用户和工作区隔离；Research Context grant 限定目标与能力 | 由 Plane 侧执行身份和项目上下文承载，适合直接使用 Plane 已有页面、评论和上下文工具 |
| 工具边界     | grant 中的工具、插件、MCP、知识库和文件白名单与 Synlora 能力取交集                       | 工具由 Plane/ScienceDiscovery 执行环境提供，适合受控访问本地资源                   |
| 长任务与产物 | 以会话事件和工具事件为主，执行产物可通过文件事件回传                                     | 长任务、Artifact、Provenance 与任务恢复是主要优势                                  |
| 断线恢复     | Synlora 持久事件序号支持回放；实时 delta 需要最终消息快照补齐                            | 适合借鉴任务级状态和产物恢复流程，执行任务可独立于浏览器连接继续                   |
| 用户交互     | Agent Dock 可统一呈现对话、grant、工具、审批和事件                                       | 更贴近 Plane 原生数据与执行任务，已有工具、评论和页面上下文访问能力                |

## 成熟度判断

两者解决的问题不同，不能用单一“成熟度”排序。Synlora × Plane 的优势是跨系统身份委托和上下文授权边界清楚，适合使用云端模型与 Synlora 能力中心；当前需要补足的是 Agent Dock 的实时状态、逐轮隔离和断线恢复体验。ScienceDiscovery × Plane 在本地执行、长任务、Artifact 与 Provenance 上更贴合 Plane 工作流；其授权委托和跨服务能力白名单可借鉴 Synlora 的实现。

从本次目标看，Synlora × Plane 的授权与执行基础已经具备，主要缺陷集中在事件投影和界面状态机，适合先沿现有 BFF 架构完善。ScienceDiscovery × Plane 对 Plane 本地资源和长任务管理更成熟，适合作为任务生命周期设计的参考，不代表应把它的执行后端替换成 Synlora。

## 可互相借鉴

- Synlora × Plane 可借鉴 ScienceDiscovery 的任务状态机、产物聚合、取消语义，以及断线后的任务恢复方式。
- ScienceDiscovery × Plane 可借鉴 Synlora 的 delegated auth、目标级 context grant、能力交集、工具白名单和审批边界。
- 两套集成都可共享 Agent Dock 的事件投影和呈现规范，但 provider 的授权、运行与持久化边界应保持独立。

## 建议

先完成 Synlora × Plane 的 SSE BFF、逐轮 run 隔离、上下文访问证据和统一面板状态展示。联调稳定后再单独评估共享的 UI 事件模型；目前不重构、不合并 ScienceDiscovery × Plane。
