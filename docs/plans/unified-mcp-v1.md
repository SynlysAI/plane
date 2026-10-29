# 行政＋科研统一 MCP v1：源码盘点与冻结契约

更新日期：2026-10-29（Asia/Shanghai）。第 1–10 节是阶段 1 冻结契约；第 11–14 节记录阶段 2–5 的实际实现。**当前完成统一读取、行政写入、科研任务操作及单份配置页面；已按用户要求启动本机验收版；真实 Codex 已通过双域调用，阶段 6 最终回归与人工验收仍在进行。**

实际仓库 `D:\plane-main\plane-dev`；分支 `周报mcp-demo`；HEAD `8bea00299760808fd1775c3b3c6772971807138d`。根 `AGENTS.md` 适用；除无关的 `packages/tailwind-config/AGENTS.md` 外未发现更深规则。各阶段改动和原有四项修改保护见 [状态记录](unified-mcp-status.md)。

## 1. 最小决策

- 新机器入口定为 `/api/mcp/`，人工管理为 `/api/mcp/connections/` 及 `/api/mcp/connections/<uuid>/revoke/`。`plane/urls.py` 已将 `plane.mcp.urls` 挂在 `/api/`；目前仅 `mcp/native/<path:action>/`，没有上述精确路径冲突。后续必须在真实 Django resolver 中验证具体路由与末尾 `/`，不依赖重定向传递机器请求。
- 同实例直接调用共享服务。一条连接、一个随机密钥、一个 MCP server 项，不创建逐节点子密钥。行政跨实例门户及科研旧入口继续兼容。
- 统一连接覆盖显式所选工作区；每个工作区分别选择行政/科研及 `read` 或 `read_write`。写隐含读；没有列出的业务域不授权。默认建议只读，是否包含未来对象必须显式提交，服务端不补默认值。
- 保留真实 `Project/Issue/IssueComment` 与 `ResearchChain/ResearchChainNode/ResearchChainNodeTask/ResearchTaskComment`；没有行政节点数据库。
- 冻结 15 个工具的上限与职责。机器可校验输入、23 个有效请求示例和 15 个拒绝示例见 [schema 附件](unified-mcp-v1.schemas.json)。其中 `tools[*]` 是契约数据，不导入生产代码充当动态注册平台。
- 行政创建、编辑、评论及原生状态变更直接执行。科研五类已有提案动作继续 prepare/execute；科研任务编辑与 submit/return/complete/cancel 直接调用现有任务服务，并明确返回 `execution_mode=direct`。不隐式准备或批准提案，不增加平台审批。

## 2. 源码能力矩阵

相对路径均以本文件所在仓库为根；符号名用于定位，避免把设计中的新接口写成现有能力。

| 能力                       | 已有可复用                                                                                                                                                                                                    | 需补 MCP 暴露/适配                                                                      | 需新增业务或基础能力                                                                                  |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| 统一人工管理               | `apps/web/core/components/mcp/mcp-management.tsx`、`native-mcp-manager.tsx`、`mcp-services.ts`；`apps/web/core/services/mcp.service.ts`                                                                       | 第 5 阶段改为工作区级签发；旧连接标兼容                                                 | 目前是逐项签发多个独立连接；没有通用密钥                                                              |
| 行政门户                   | `apps/api/plane/mcp/views.py:NativeMCPBridgeEndpoint`、`mcp/urls.py`；demo `http_mcp.py:AuthenticatedMCP`、`self_service.py`                                                                                  | 保留原 URL/门户身份语义                                                                 | 统一入口使用 Plane 本机 owner，不根据门户同名账号映射身份                                             |
| 行政分类/项目可见性        | `apps/api/plane/utils/administrative_projects.py:administrative_project_filter/research_project_ids/visible_administrative_projects`                                                                          | 统一列表、搜索、计数、详情、写入均应用同一过滤                                          | 不新建分类模型；科研 chain/profile 的 **all_objects** 排除必须保留，软删外壳也不能进入行政入口        |
| 行政参与/写权限            | 同文件 `effective_project_member/assignable_project_member_ids`；`apps/api/plane/app/permissions/base.py:allow_permission`                                                                                    | 提取现有权限判断供网页与 MCP 共用，包含 creator 例外、组织继承、私有工作区准入          | 不把“项目可见”直接等价为“可写”；不自动增建 ProjectMember                                              |
| 行政任务读取               | `apps/api/plane/app/views/issue/base.py:IssueViewSet.list/retrieve/get_queryset`，`api/views/issue.py:IssueListCreateAPIEndpoint/IssueDetailAPIEndpoint`                                                      | 统一检索、分页、上下文、真实层级；访客仅自己任务的限制也必须复用                        | 无新增任务模型；直接复用 ORM 查询与序列化投影，避免调用整个视图产生 recent-visited 等无关副作用       |
| 原行政 Agent 工具          | `demos/sciencediscovery-plane-mcp/agent_mcp.py:tools/create_server`、`agent_workflow.py`；只读代理 `read_only_mcp.py`                                                                                         | 可以借用已知 URL 解析和有界输出经验，不能当作通用编辑服务                               | 原工具只是 read_task_context/prepare_progress/publish_progress，publish 依赖配置；行政通用写入口尚缺  |
| 行政创建/编辑/状态         | `app/views/issue/base.py:create/partial_update`、`app/serializers/issue.py:IssueCreateSerializer.validate/create/update`；REST `api/views/issue.py` 和 `api/serializers/issue.py:IssueSerializer`             | 第 3 阶段抽最小共享 create/update 服务，网页入口与 MCP 同用                             | 需补事务内创建/评论幂等回执；现有普通 Issue/IssueComment 路径未提供可直接复用的 request_id 持久化机制 |
| 行政评论/活动通知          | `app/views/issue/comment.py:IssueCommentViewSet.create`、`app/serializers/issue.py:IssueCommentSerializer`；`plane/bgtasks/issue_activities_task.py:issue_activity`、`bgtasks/webhook_task.py:model_activity` | 共享 append 服务复用 HTML、附件限制、actor、活动、通知与 origin 语义；首版 MCP 不传附件 | 不在 MCP 复制 HTML 清洗或通知规则；需提交成功后才发异步副作用                                         |
| 科研链/节点读取            | `research/services/chain_context.py:ResearchReadService`，`services/mcp_catalog.py:TOOLS/validate_arguments`，`research/views/projects.py:visible_profile_queryset`                                           | 统一 scope 注入到 chains/nodes 查询层；在统一入口补负责人/关键词筛选                    | 已有 reader 的 grant=None 只供当前内部/既有 API 路径；不能作为统一凭据绕过授权的方法                  |
| 科研任务、评论、事件、快照 | `chain_context.py:list_research_node_tasks/list_research_task_comments/list_research_node_events/list_research_node_snapshots`                                                                                | 包装为分页列表和 context 分区；现有 MCP 任务列表未暴露负责人/关键词                     | 业务查询已有，需最小查询扩展，不新增数据层级                                                          |
| 科研资源                   | `chain_context.py:_candidates/_lookup/_linked/_allowed/_content/read_research_resource`，`mcp_catalog.py:RESOURCE_KINDS`                                                                                      | 统一范围与 formal report 版本策略；每次读回重新校验真实关联/ACL                         | 仅正文已支持的种类有正文；文件解析、任意 URL 获取不新增                                               |
| 科研五类提案               | `services/agent_operations.py:ResearchOperationService`，`services/operation_catalog.py:PAYLOADS/OPERATION_TOOLS`，`db/models/research/agent_operation.py`                                                    | 准备、执行、按 ID 恢复；列表增加 request_id 筛选以恢复 prepare 超时                     | 必须适配真实授权来源及提案归属，见第 7 节；不新增审批机制                                             |
| 科研任务创建/编辑          | `services/chain_tasks.py:create_task/update_task`；`research/views/chain_tasks.py`；`research/serializers/collaboration.py:ResearchChainNodeTaskSerializer/_capabilities`                                     | 创建仍走五类提案；编辑直接走共享服务，资源绑定另走 attach 提案                          | 编辑业务已存在，无需新状态机；首版不扩展提案创建的字段（仍仅 title/instruction）                      |
| 科研状态/负责人            | `chain_tasks.py:actor_can_submit_task/actor_can_review_task/actor_can_cancel_task/list_assignable_users` 及 submit/return/complete/cancel                                                                     | 统一 allowed_actions、可选负责人、动作上下文                                            | 已有业务能力，仅补授权适配和 MCP；不能将科研写连接等价为审核人                                        |
| 科研评论/分析副作用        | `services/chain_mutations.py:append_task_comment/save_analysis_draft`；`agent_operations.py:apply`                                                                                                            | 保留事务、锁、内容校验、审计、通知、来源事件                                            | 普通评论已有 request_id 幂等；无需另造科研评论回执表                                                  |
| 连接鉴权/生命周期          | `services/context_tokens.py`、`token_lifetimes.py`、`views/mcp_management.py` 提供哈希、到期、撤销、last_used、CSRF 模式                                                                                      | 新凭据不能伪装为旧节点凭据或 APIToken                                                   | 新 UnifiedMCPConnection 模型与必要迁移、机器 Bearer 鉴权、scope 校验，均为第 2 阶段工作               |
| 正式周报                   | `services/weekly_report_policy.py`、`weekly_report_operations.py`、`weekly_report_catalog.py`、`views/weekly_report_agent.py`；`db/models/research/report_agent.py`                                           | 只兼容保留原 purpose 凭据和工具                                                         | **不**将 weekly_report 的 save_draft/submit 加入统一任务能力                                          |

## 3. 行政真实层级和对象定位

行政导航是 `Workspace → Project → Issue → Issue.parent 子任务`。行政组织是项目归属分类，Module/Cycle/状态分组是现有组织方式（`db/models/module.py`、`cycle.py`、`issue.py`），不映射成 ResearchChainNode，不赋予新增链/节点能力。科研是 `Workspace → ResearchChain（一对一 Project）→ ResearchChainNode（可有 parent_node/loop_iteration）→ ResearchChainNodeTask`，依据 `db/models/research/chain.py` 与科研协作模型。

`plane_list_nodes` 对行政 Project 成功返回 `applicability=not_applicable`、空 data 及指向该项目的 `plane_list_tasks` 参数；不是“节点数为 0 因而没有任务”。`plane_list_tasks` 以行政 Project 为父时返回项目内任务（保留 parent 引用），以行政 Issue 为父时返回直接子任务；科研以真实 node 为父，不用底层 Project 取科研任务。

引用格式为 `{domain, workspace_slug, object_type, id}` 或 `{domain, workspace_slug, object_type, url}`，严格二选一。原生 ID 必须为 UUID；名称仅用于 query 检索。多条同名结果带完整父对象/网页 URL，返回候选，Agent 必须选择后才能写；服务端不按名称猜目标。

URL 只解析已知本实例 Web origin/配置的既有 alias，接受已核实的 Issue 链接和科研链/节点链接；拒绝用户信息段、异域、未知路径或相互冲突的参数，不发网络请求。科研任务若当前网页仅有节点页定位，返回节点页 URL 加对象 ID，不凭空声称存在独立任务深链接。URL 中的 workspace/chain/project/node 与实际外键不符则拒绝；object_type/domain 也与实际归属复核。输入不接收任意服务地址。

## 4. 连接、范围和最小管理契约

有效权限始终为：连接声明范围 ∩ 当前 owner 的业务权限 ∩ 当前对象状态/部署策略。owner 停用、退出工作区、科研组织关系失效、连接到期/撤销均即时影响后续请求，初始化成功不会缓存长期授权。

最小连接记录：UUID、owner FK、name、唯一 token*hash（SHA-256 高熵随机 token）、经过闭合结构校验的 scope JSON、expires_at、revoked_at、last_used_at，以及项目惯例 created/updated 信息。scope 同时保存工作区的稳定 UUID（slug 仅显示/请求定位）、业务域能力与 include_future_objects；名称及范围不做就地扩权，扩大范围应新建连接。创建时只显示一次完整 `pum*` 随机密钥，后续列表不含密钥/哈希/配置，不存明文上游 PAT。管理响应 no-store，不记录带密钥正文。

创建输入冻结如下（完整 schema 在附件）：

```json
{
  "name": "我的任务助手",
  "workspaces": [
    {
      "workspace_id": "00000000-0000-4000-8000-000000000010",
      "domains": { "administrative": "read_write", "research": "read_write" }
    }
  ],
  "include_future_objects": true
}
```

最多 20 个工作区，重复 workspace_id 拒绝；空范围、未知域、非成员工作区拒绝。请求 read_write 不代表签发时必须拥有每个对象的每种动作，实际能力取对象当前 ACL；科研部署/工作区未开写时拒绝该域 read_write 并给出原因，不能偷偷降级或开启开关。

未来对象语义冻结为两种：

- `true`：所选工作区/业务域内，每次实时查询本人可见的全部对象，包含未来新增及未来获得权限的对象。页面必须明确说明这个授权。
- `false`：创建时保存当前可见的行政项目及科研 chain/node ID 集合，并保存 snapshot_at；查询仍交当前 ACL。任务/资源及关联记录还须满足创建/关联时间不晚于 snapshot_at，避免新任务、新节点或旧资源新挂接隐式加入。它冻结对象集合的上界，不冻结正文或权限；对象更新读取当前版本，后来失权立即消失。不能仅用 created_at 截止代替父对象 ID 快照，否则会纳入后来才获得权限的旧项目。若既有某种关联无可靠时间，则保存该关联 ID 快照，而不改造业务表。

快照只保存范围 ID/必要关联，不复制业务正文或逐对象密钥；签发在事务内完成范围采集，范围过大时明确拒绝并建议动态模式，不能截断后仍称全范围。首版不增加自选任意项目/链/节点模式的 UI；历史显式节点连接继续有原有范围。

管理 API：

| 请求                                          | 契约                                                                                        |
| --------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `POST /api/mcp/connections/`                  | 标准 SessionAuthentication + CSRF；返回元信息、一次性 secret、一个 mcp_url 与单 server 配置 |
| `GET /api/mcp/connections/?cursor=…&limit=20` | 仅本人，分页；返回范围摘要、实际能力、期限/撤销/最近使用，不返完整 secret                   |
| `POST /api/mcp/connections/<id>/revoke/`      | 仅本人、幂等、CSRF；不存在/非本人 404；连接功能开关关闭后仍可撤销                           |

统一凭据默认寿命沿用 `node_mcp_token_ttl_seconds()`（当前缺省 7 天），服务端返回实际 expires_at；不增加复杂期限选项。科研已有读写功能开关照常生效；行政沿用业务可用策略。不为所有业务组合增加部署开关。管理只接受会话，机器只接受统一 Bearer；不得将 APIToken、节点 token、周报 token 自动升级。

## 5. 工具契约与结果

附件每个 inputSchema 根为 `type=object`，所有对象闭合 `additionalProperties=false`；业务分支用 anyOf 和唯一的 domain/type/动作常量区分，分支也闭合。无任意 JSON dispatch。科研 prepare 的 payload 是五个明确 schema 的联合，沿用原字段要求，而非无约束载荷。日期/UUID 还需服务端验证，schema 不能代替业务校验。

| 工具                               | 关键输入（必填项加粗）                                                                               | 执行/返回要点                                                                                                                            |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `plane_list_workspaces`            | query、cursor、limit                                                                                 | 只列连接所选且仍可访问的工作区                                                                                                           |
| `plane_list_containers`            | **workspace_slug**，domain=administrative/research/all、query、分页                                  | 行政 Project 和科研 ResearchChain，默认 all；范围内计数                                                                                  |
| `plane_list_nodes`                 | **container**，query、status、node_type、分页                                                        | 科研节点；行政 not_applicable；行政不接受 node_type/status 筛选                                                                          |
| `plane_list_tasks`                 | **parent**，行政 state_id 或科研 status、assignee_id、query、分页                                    | 原生状态；科研 status 只接受六个任务状态枚举                                                                                             |
| `plane_get_context`                | **target、section**，resource_kind、query、分页                                                      | details/capabilities/comments/resources/events/snapshots/operations；一次只读一个分区                                                    |
| `plane_read_resource`              | **parent、kind、resource_id**，version、cursor、max_chars                                            | 正文有界读取；正式 report 必填版本；无正文返回显式 unsupported_content                                                                   |
| `plane_create_task`                | **行政 parent、request_id、name**，description_html、priority、assignee_ids、start_date、target_date | 直接创建 Issue，Issue 父表示子任务；科研返回应使用 prepare 的指引                                                                        |
| `plane_update_task`                | **target、changes**                                                                                  | 行政 name/description_html/priority/assignee_ids/start_date/target_date；科研 title/instruction/assignee/due_at；无 status/resource 字段 |
| `plane_add_comment`                | **行政 target、request_id、comment_html**                                                            | 直接创建 IssueComment；科研评论走 prepare                                                                                                |
| `plane_transition_task`            | **target、action**；行政 **state_id**；科研 **request_id**，return/cancel **reason**                 | 行政 set_state；科研 submit/complete/return/cancel；complete 可选 comment                                                                |
| `plane_prepare_research_operation` | **node、request_id、action、payload**，source_refs                                                   | 五动作；不可变提案，不修改目标，confirmation_mode=agent_client                                                                           |
| `plane_execute_research_operation` | **workspace_slug、operation_id**                                                                     | 不接受替换 payload；成功返回原生对象和读回状态                                                                                           |
| `plane_get_research_operation`     | **workspace_slug、operation_id**                                                                     | 恢复 COMMITTED 结果；重新校验当前可见性                                                                                                  |
| `plane_list_research_operations`   | **node**，request_id、分页                                                                           | 既有提案分页＋request_id 查询，恢复 prepare 响应丢失                                                                                     |
| `plane_get_write_result`           | **workspace_slug、request_id**                                                                       | 仅查本连接行政 create/comment 回执，不执行写操作                                                                                         |

科研 create/comment 没有第二种隐式自动 prepare+execute 别名。create_task 提案仍只接受 title/instruction，创建后按 `allowed_actions` 调用 update 分配负责人和 due_at。说明这一点可避免把网页已有字段误报为现有提案字段。

行政 assignee_ids 为 0 或 1 项（现有单负责人规则），空数组明确清除；创建省略该字段才应用有效默认负责人，编辑省略则保留，依据 IssueCreateSerializer 和 replace_issue_assignee，必须返回真实负责人。科研 assignee 是单 UUID，不支持清除已分配负责人，due_at 为带时区时间或 null；没有优先级/开始日期，不创造这些字段。行政日期为本地日期而非 UTC 时间；HTML 由既有校验处理。科研 instruction 是现有富文本字符串，统一工具限制为 8,000 字符（网页可更长），不暴露附件字段或新增图片，沿用 \_clean_instruction 的清洗及已有内嵌图片归属校验。

context 支持矩阵：Project/ResearchChain 具有 details/capabilities；Issue/科研任务增加 comments/resources/events；ResearchChainNode 增加 resources/events/snapshots/operations。科研任务 resources/events 映射其绑定和任务相关事件，不能泄露同节点其他对象；node comments、行政 snapshots/operations 等无对应层级返回 not_applicable。node 的 resources 必须传 resource_kind（附件定义 13 类）；其他分区不接受无意义的 resource_kind；query 只用于 capabilities 的负责人候选检索。此类跨字段规则由 adapter 明确验证，尚未全部编码进通用输入 schema。

分页统一 `limit=20`、1–50、opaque cursor；提案底层一次最大 20，统一层对该分区也拒绝 >20，不悄悄截断。负责人候选也分页；沿用 `chain_tasks.py:list_assignable_users` 的业务资格，避免把候选全部塞入任务详情。统一游标绑定 connection_id、scope 摘要、owner、workspace、domain、tool、section、筛选和排序，1 小时过期；每页重算 ACL、软删与归属。混合容器稳定按 `(domain, created_at, id)` seek，游标保存业务域位置，不无限拉取两域再内存合并。范围筛选在分页/计数前完成；资源 ACL 需逐项判断时沿用 reader 的扫描锚点推进，允许空页加 has_more，不能静默丢后续数据。

工具统一返回 JSON 文本；支持时可同时带相同 structuredContent。业务结果 envelope 为 `schema_version=plane.unified-mcp.v1`、data、page（has_more/next_cursor）、retrieved_at、truncated、content_policy=untrusted_reference_data。正文分页携带 content_hash/offset/complete；正文改变后续页拒绝 version_changed。结果沿用当前 reader 的 MAX_OUTPUT=24,000 字符上限（序列化 JSON），默认正文 8,000、256–16,000 字符；超大对象显式报 response_too_large，不返回未标记的截断正文。

列表中的对象最小形状如下；所有 UUID/地址仅为示例，并非现场数据：

```json
{
  "schema_version": "plane.unified-mcp.v1",
  "data": [
    {
      "domain": "administrative",
      "object_type": "Issue",
      "id": "00000000-0000-4000-8000-000000000002",
      "workspace_slug": "lab",
      "name": "核对材料",
      "parent": {
        "domain": "administrative",
        "object_type": "Project",
        "workspace_slug": "lab",
        "id": "00000000-0000-4000-8000-000000000001"
      },
      "status": { "id": "00000000-0000-4000-8000-000000000008", "name": "进行中", "group": "started" },
      "url": "https://plane.example/lab/projects/00000000-0000-4000-8000-000000000001/issues/00000000-0000-4000-8000-000000000002",
      "allowed_actions": ["update_task", "add_comment", "set_state"]
    }
  ],
  "page": { "has_more": false, "next_cursor": null },
  "retrieved_at": "2026-10-28T10:00:00+08:00",
  "truncated": false,
  "content_policy": "untrusted_reference_data"
}
```

details 保留 native 字段；科研任务 status 为原生枚举（如 ASSIGNED），parent 为真实 node，并附 chain_id/project_id。原生模型无 status 时返回 null，不伪造状态。网页 URL 对没有独立页面的资源指向父页面，并标明 url_target=parent。

capabilities 分区另返回 `editable_fields`、分页 `assignable_users`（id/display_name）、当前允许的 `state_options` 或 `transition_options`、每种动作 required_fields、`execution_mode=direct|proposal`。例如普通科研负责人可有 submit，却没有 return/complete；只读连接 allowed_actions=[]。列表只含简短能力，不默认预装全部节点全文或成员。能力是当前提示，真正执行仍重新验证。

行政无节点返回示例：

```json
{
  "schema_version": "plane.unified-mcp.v1",
  "data": [],
  "applicability": "not_applicable",
  "reason": "Administrative tasks belong directly to projects.",
  "next_tool": {
    "name": "plane_list_tasks",
    "arguments": {
      "parent": {
        "domain": "administrative",
        "workspace_slug": "lab",
        "object_type": "Project",
        "id": "00000000-0000-4000-8000-000000000001"
      }
    }
  },
  "page": { "has_more": false, "next_cursor": null },
  "truncated": false,
  "content_policy": "untrusted_reference_data",
  "retrieved_at": "2026-10-28T10:00:00+08:00"
}
```

鉴权失败使用 HTTP 401/403，Bearer challenge、no-store，不跳 HTML；协议错误用 JSON-RPC -32600/-32601/-32602。合法调用中的业务失败以 `isError=true` 的 content JSON 返回稳定 error_code/message（如 scope_denied、not_found、state_conflict、idempotency_conflict、invalid_cursor、unsupported_content）；不泄露范围外对象存在性，不回显密钥/原异常。超时/读回异常需区分已提交与未知结果，不能一律当成写入失败。

## 6. 写入路径、状态规则和恢复

行政：统一鉴权 → 真实项目分类/对象归属/任务可见性 → 与网页一致的角色/creator 规则 → 共享最小服务 → IssueCreateSerializer 或 IssueCommentSerializer → atomic 保存 → 提交后 issue_activity/model_activity → 新鲜读回。已有 model save 的状态联动、版本记录不得绕开。原 `skip_activity`、is_draft、archived_at、二进制、任意关联字段不暴露。

优先从网页 IssueViewSet 与评论视图抽出共享的校验/保存/副作用；REST 对应路径一并审查其别名字段与差异，小范围复用一致逻辑，不在 MCP 中新写状态合法性/负责人验证。不通过构造 Django 假请求调用带会话权限的视图；业务服务显式接收 actor/project/request 审计上下文。当前业务普通编辑没有统一 revision 协议，v1 不引入全库锁或强制 revision；提案继续现有 preconditions 全字段哈希，直接更新沿用现有事务与状态冲突语义。

行政 create/comment 引入一个最小持久回执模型（第 3 阶段，非提案），唯一键 `(connection, workspace, request_id)`，保存 tool/规范化参数摘要、目标 ID、提交结果/读回状态；与业务写入同一事务提交，并发靠唯一键和行锁重查。相同请求重放返回原结果，不同工具/载荷同键返回 idempotency_conflict。事务回滚不留已提交回执。网络断开后 `plane_get_write_result` 查同键；没有回执只能说明当前未观察到提交，必须用同键重试、不能换键重复创建。已提交但读回失败返回 `status=COMMITTED, readback=pending`。撤销/失权后不能用回执泄露业务内容，持久结果仍保存用于审计。普通编辑/行政 set_state 不另造回执：超时按对象 ID 读取确认；不能无条件重试、重发通知或宣称精确一次。注解对这些直接编辑保守设 idempotentHint=false。

科研五类：统一授权上下文 → 原 validate_operation/提案 prepare → 保留 seal、原 request_id 唯一约束、source_state/preconditions → execute 再鉴权并锁提案/父对象 → 原 apply → 原 audit/事件 → readback。execute 只携 operation_id；执行前冲突不得覆盖旧 payload；原 COMMITTED/CONFLICT/EXPIRED/CANCELLED/拒绝语义保留。prepare 超时先按 node/request_id 列表找提案。原 prepare 唯一键为 `(workspace,user,request_id)`，统一连接不重新定义它；撞上其他授权来源请求返回冲突，不泄露或接管不属于本连接的提案。

科研编辑：显式字段映射到 `update_task`；资源绑定仅通过已有 attach_task_resource 提案。状态动作调用 `submit_task/return_task/complete_task/cancel_task`，沿用 request_id、payload_hash、任务事件幂等和通知。状态操作超时以事件 request_id 和 context events 读回；统一 context 的任务事件投影需要补充“当前 owner 自己动作”的 request_id/提交结果，现有 reader.\_event_data 没有直接输出 request_id，不能宣称已经具备这个恢复入口。不同 owner 的请求标识不额外披露。task update 无原生持久请求回执，不冒称精确一次。

盘点发现一个阶段 4 必须实际验证的已有缺口：submit_task 在入口及 \_run_task_action.guard 先用包含状态的 actor_can_submit_task 检查，之后才 \_replay_task_event。第一次已提交为 SUBMITTED 后，同请求重放可能先被拒绝。应在共享服务中把当前有效身份/负责人权限与“首次转换所需状态”分开，在真实授权和父对象校验后检查同 request_id/hash/目标的已提交事件，再验证首次转换状态；不能通过放松当前权限恢复重放。本轮仅记录源码推断，没有数据库复现或修复；阶段 4 应新增重复 submit 的隔离回归，不把现有 create 幂等测试当作全部状态动作幂等证明。

| 科研动作 | 当前真实业务规则（还需连接能力、当前成员和父对象可写）                                                              |
| -------- | ------------------------------------------------------------------------------------------------------------------- |
| update   | actor_can_manage_chain_tasks；DRAFT/ASSIGNED/NEEDS_REVISION；负责人来自 list_assignable_users，已分配负责人不可清空 |
| submit   | 当前有效负责人；ASSIGNED/NEEDS_REVISION → SUBMITTED                                                                 |
| return   | actor_can_review_task（科研管理员或 review_only_actor）；SUBMITTED → NEEDS_REVISION；reason 必填                    |
| complete | 同审核权限；SUBMITTED → COMPLETED；comment 可选                                                                     |
| cancel   | chain_manager；DRAFT/ASSIGNED/NEEDS_REVISION → CANCELLED；reason 必填                                               |

注意：现有 Agent 五动作策略 `agent_operations.context/issue_write_grant` 对 node ARCHIVED/COMPLETED/WAITING_HUMAN 均拒绝；网页任务服务 `_ensure_task_parent_writable` 只要求 chain ACTIVE、node 非 ARCHIVED。统一 v1 对所有科研机器写入取两者交集，继续拒绝上述三种 node 状态，并记录为机器策略；不能误报网页状态机已经完全相同。只读仍按已有可见性开放。任务状态不改变节点工作流状态。

## 7. 单节点授权适配：明确接口，不复制子授权

选择抽出内部显式 `ResearchAuthorization` 接口，供 legacy-node 与 unified-connection 两个真实认证来源实现；不是通用插件框架。通过受信工厂创建，经数据库重新读取来源、owner、到期/撤销和策略，接口值不能由工具参数直接构造。读服务、提案服务和直接任务操作必须显式要求该上下文，统一请求不能走 grant=None。既有内部网页 reader 路径维持其原调用语义，不能被机器入口误用。

接口职责最小为：`authenticate(tool, lock=False)`、`scoped_chains/scoped_nodes`、`require_node(node_id, action, mutable, lock)`、`allows_report_version(report, version)`、`require_operation(operation)`、`audit_identity`、`expires_at/agent_label`。所有实现共享真实用户/工作区/组织/资源 ACL 及锁前/锁后检查；不能用未校验的内存布尔值证明授权。

| 现有硬依赖位置                                                                                                                | 必须如何改造（后续阶段）                                                                                                                                                                                                                                                  |
| ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `context_tokens.py:load_context_grant`；`views/agent_access.py:read_service` 的双 header/context_hash/last_used               | 旧 header 完整保留；统一 Bearer 单独 hash 查真实连接及更新时间，不能用同一 secret 反查所有节点 token                                                                                                                                                                      |
| `ResearchReadService.execute/chains/nodes/_node_data` 的 workspace/user/allowed_tools、project_id/chain_node_id、游标 binding | 通过 authorization 注入受限 queryset；父引用范围外时保留 parent_outside_scope，不泄露 ID                                                                                                                                                                                  |
| `chain_context.py:_allowed/_resource_data/_content` 的 allowed_reports 及固定版本                                             | legacy 维持显式选取正式版本；统一动态读取当前本人可读且已关联节点的正式版本，读正文仍必须明确 version，并经 selected_report_content 再校验。snapshot 模式额外取 snapshot_at 上界；不接触周报写 purpose                                                                    |
| `agent_operations.py:authenticate/context` 对 grant.pk/chain_node_id 和 WriteGrant 的硬依赖                                   | legacy 实现继续验证真实 ContextGrant+WriteGrant；unified 实现验证真实 UnifiedMCPConnection 与 scope，再交共同业务权限，不能跳过 authenticate                                                                                                                              |
| `ResearchAgentOperation.original_grant` 必填 FK、`prepare` 归属、`seal`                                                       | 最小新增 original_connection nullable FK、original_grant 改 nullable，加数据库恰一来源 XOR 约束；旧数据不回写 hash，不重建旧提案                                                                                                                                          |
| `seal/present/load/get/list/execute/readback`、`apply` provenance 的 grant_id                                                 | legacy seal 字节/字段算法保持原样；unified seal 使用带版本的 authorization_source+original_connection_id；load/list 先限定 owner/workspace/来源，再校验真实 node；读回用同一 verified context；来源事件写真实 connection_id，不冒充 grant_id                              |
| `views/agent_operations.py:catalogue/audit_operation_call`                                                                    | 显式工具映射，不能调用时用任意字符串 dispatch；按连接能力裁剪工具，目标动作再按实时 ACL 裁剪；审计中区分两种来源                                                                                                                                                          |
| issue_write_grant 和 mcp_management 的每节点 5 条有效读/写授权上限、有效期/撤销                                               | 不把统一连接拆成 N 条 grant；统一连接限同一 owner/工作区/科研读写类别各 5 条有效连接，且签发/旧节点签发时将覆盖该节点的统一连接计入原相应类别 5 条上限。动态范围按声明覆盖计算，未来旧节点签发也计入；锁同一 owner 行避免并发超发。现有执行无额外次数额度，不发明执行额度 |

统一连接的提案必须由原连接继续 get/execute，撤销或到期立即拒绝执行；新连接不能收养旧 unified 提案。旧 legacy 提案继续允许同 owner、同 node 的合法刷新授权查询/执行（现有 `test_refresh_grant_recovers_same_operation_without_expanding_scope` 的语义），不额外强制当前 grant ID 等于 original_grant。统一入口不自动接管旧节点提案；旧入口继续可查询旧结果。source 变化/软删/正式版本失权会影响执行和结果展示。

迁移先增加新 FK、放宽旧 FK 并加 XOR，旧记录 original_grant 非空且 original_connection 为空；旧 seal 分支不变。阶段 2 先实现连接与读授权接口，阶段 4 再扩提案 FK/来源；不能为读取提前建立所有节点写授权。撤销与执行按相同连接行锁序串行：撤销返回后开始的新调用不得写；已经持锁提交的操作保留真实结果，不做假回滚。原审计/幂等/不可变哈希均继续有效。

## 8. 资源与周报边界

科研已有 13 类：analysis、snapshot、upload、paper_review、report、experiment、stage_material、topic_material、external_reference、agent_event、event、task、task_comment。正文读取实际支持 analysis/snapshot/report/experiment/公开 agent_event/task/task_comment/event；其余只给已有元数据与 content_state，不宣称能解析上传文件、文献或外部网页。report 必须是当前有权限的正式版本；报告反馈继续用原隔离读取规则，不把普通评论伪装为反馈。

行政首版读取 Issue 说明、IssueComment、IssueActivity 以及已有链接/附件元信息；附件不读字节、不上传，不给外部链接抓正文。Project 文档等首版没有已核实共享正文服务的对象不冒称可读，context 明确 unsupported/not_applicable；后续若扩展必须先盘点权限和读取服务。

近期周报状态以 `docs/plans/mcp-weekly-report-implementation-status.md` **末尾更新**为准：2026-10-27 已改未配置默认启用，保留显式 0；不能引用文件开头历史“默认关闭”当作当前事实。`ReportAgentGrant` 的 purpose=weekly_report、WEEKLY、独立 token header、周期/正文 revision/提交恢复均保持原样。统一任务连接不被 weekly_report_policy.check_grant 接受，不调用周报提交工具，不复用周报全表 consistency_barrier。

## 9. 目标客户端、传输和版本核对

沿用项目 `demos/sciencediscovery-plane-mcp/requirements.txt` 固定版本：mcp 1.28.1、plane-mcp-server 0.3.4、plane-sdk 0.3.1、fastmcp 3.2.0，不升级全仓依赖。现有独立 HTTP 用 SDK StreamableHTTPSessionManager(stateless=True,json_response=True)；Plane 内科研 handler 初始化返回 **2025-03-26**。统一 v1 保持此协议基线，不能因为输入建议链接是 2025-06-18 就宣称已升级。

目标为本机 Codex（CLI/桌面使用的 MCP host）和项目已有 ScienceDiscovery。2026-10-28 查询的 [OpenAI 官方 MCP 文档](https://learn.chatgpt.com/docs/extend/mcp?surface=cli) 确认 Codex 支持 Streamable HTTP、Bearer，以及 TOML 的 url/http_headers/bearer_token_env_var。该项是文档兼容性核对，未代表本机客户端实际连接成功。ScienceDiscovery 以本仓库 connection-config.ts、SELF_SERVICE.md、HTTP_MCP.md 及既有 SDK 网络测试为证，使用 `mcpServers`、type=http、url、headers；`docs/operations/sd-mcp-compatibility.md` 还记录一些部署没有 `/api/mcp/servers`，因此不能承诺 SD 自动注册总可用。

| 客户端/环节           | 本阶段结论                                                              | 后续必须验证                                                                     |
| --------------------- | ----------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Codex                 | 官方传输/鉴权配置已查；不读取或修改用户私密配置                         | 第 6 阶段真实导入/发现/调用，记录客户端版本；不能拿 SDK 代替 Agent 验收          |
| ScienceDiscovery      | 仓库有 HTTP 和 STDIO 适配、Inspector 历史证据；本轮没有登录 SD          | 目标部署是否支持 HTTP/header/schema/连接注册，以真实调用确认                     |
| Python MCP SDK 1.28.1 | 本机已有该版本，Tool/InitializeResult 可离线校验；支持列表含 2025-03-26 | 第 2 阶段 ClientSession + streamable_http_client 的真实网络 initialize/list/call |
| schema                | 使用 SDK Tool 接受的根 object，内联闭合分支、不用外部 $ref              | 复杂 anyOf 与工具名在真实目标 Agent 的发现/调用仍待验收                          |

单连接配置示例（仅占位，阶段 2 尚未实现）：

```toml
[mcp_servers.plane]
url = "https://plane.example/api/mcp/"
http_headers = { "Authorization" = "Bearer <ONE_TIME_UNIFIED_SECRET>" }
tool_timeout_sec = 120
default_tools_approval_mode = "prompt"
```

```json
{
  "mcpServers": {
    "plane": {
      "type": "http",
      "url": "https://plane.example/api/mcp/",
      "headers": { "Authorization": "Bearer <ONE_TIME_UNIFIED_SECRET>" },
      "timeoutSeconds": 120
    }
  }
}
```

Codex 也可用 bearer_token_env_var 避免静态 secret；生成器默认沿用现有 http_headers 兼容格式，不能把字符串 `${ENV}` 当作已经展开的密钥。配置只含一个 server 项，不附加科研 context hash 第二凭据。工具审批策略由 Agent 客户端承接，不在 Plane 伪造人工记录。

统一 transport 需要补足的实际差距：当前 Plane handler 只有 POST/OPTIONS、无 Origin 显式校验且不接受 JSON-RPC batch；这些不能直接复制后称完整协议实现。按 [2025-03-26 transports](https://modelcontextprotocol.io/specification/2025-03-26/basic/transports) 验证 POST Accept/JSON、通知 202 空体、GET 无 SSE 时 405、Origin/Host、协议版本协商和 batch 行为；无 session 不发 Mcp-Session-Id，DELETE 405。优先复用可兼容当前 Django 部署的最小传输实现；不为此另起通用网关或跨实例聚合进程。按 [同版 tools 规范](https://modelcontextprotocol.io/specification/2025-03-26/server/tools) 返回标准文本结果，structuredContent 仅兼容扩展，不作为旧协议唯一读回渠道。不宣称支持 SSE、prompts、采样或资源订阅。

15 个内联闭合 schema 合计约 50 KB（紧凑 JSON，尚未裁剪连接能力），因此 tools/list 也分页：每页最多 5 个工具并受 24,000 字符响应预算约束，使用协议字段 nextCursor（不同于业务结果的 page.next_cursor），游标绑定连接/能力/目录版本。初始化只宣告能力，不携带完整目录或节点正文。第 2 阶段 SDK 必须翻完目录并调用后页工具；第 6 阶段确认目标 Agent 同样能发现完整目录，不能仅校验第一页。

## 10. 阶段依赖、验收入口和明确不做项

| 阶段      | 依赖/交付和完成门槛                                                                                                                            |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| 1（本轮） | 完成本文、可校验输入契约、状态记录；源码与规则盘点、离线校验；不修改业务代码                                                                   |
| 2         | 新连接/迁移/会话管理/Bearer/授权读接口和 6 类读取工具；对范围/分类/软删/分页做隔离回归；真实 SDK 证明同一连接读两个行政项目与两个科研节点      |
| 3         | 行政共享写服务和 create/comment 幂等回执；复用活动/通知；隔离数据闭环及网页读回，通知不真实群发；只读/越权/重复/超时恢复                       |
| 4         | 扩授权接口到提案/直接任务动作及最小提案归属迁移；旧 seal/额度/续签结果回归；同连接跨两个科研节点操作和角色状态限制；周报 purpose 拒绝          |
| 5         | 工作区/业务/读写/未来范围最短创建流程；单 server 输出、列表/到期/最近使用/撤销；旧连接兼容标记、完整密钥仅一次                                 |
| 6         | 真实 Agent＋隔离全链路、SDK、权限/动态新增/退出/撤销/错域/科研外壳/分页/同名/重复/冲突/读回恢复及旧入口回归；必要前端检查/构建；发布与回退材料 |

阶段 2–4 应优先复用的测试：

- `apps/api/plane/tests/contract/app/test_mcp_management.py`：当前可见性、节点隔离、CSRF/所有权、开关/额度、分页。
- `test_research_agent_operations.py`：五动作、无平台二次审批、重复请求、seal/source/precondition、撤销、旧授权刷新、并发、提交后读回失败。
- `test_research_chain_tasks.py`：创建/负责人/提交/退回/完成/取消角色及通知、幂等、节点状态不受任务动作影响。
- `test_research_mcp_extended.py`：13 类资源关联/ACL/版本/软删/扫描续页；`test_administrative_project_default_access.py`、`test_administrative_project_membership.py`、`test_administrative_project_overview.py`：默认管理员、公共/组织/私有项目、研究分类、可见性计数。
- `test_weekly_report_agent.py`、`test_weekly_report_transport_integration.py`：purpose/只读/恢复与真实 SDK 网络验证方法；`demos/sciencediscovery-plane-mcp/tests/test_http_mcp.py`、`test_research_operations_mcp.py`；Web `mcp-management.test.tsx`、`mcp-config.test.ts`、`mcp-services.test.ts`、周报组件测试。

上述是已阅读/抽查的测试资产，不是本轮全部重跑结果。仓库 conftest 自动清 Redis，默认 pytest 配置复用数据库；后续必须专用 PostgreSQL 测试库、隔离缓存/消息配置与凭据，不在当前业务库/Redis 自动执行。禁止 docker-compose-test.yml、setup.sh。最终离线检查不加载 Django 设置或 conftest，不连接任何业务服务；另一次原 pytest 收集因 Plane 包初始化依赖 Redis 配置失败，未执行测试，详情如实记入状态文档。

明确不做：跨实例通用聚合、行政链/节点表、任意 SQL/URL/模型写入口、删除及批量破坏性动作、链/节点创建或归档、任意文档编辑、文件上传/解析、正式周报写/提交、OAuth 体系重做、依赖整体升级、通用插件注册/消息总线、多层重试降级、全库并发锁、新平台审批、自动替换旧授权、部署/迁移业务库/推送/合并。

本阶段没有必须由用户裁决的产品含义问题；采用以上最小选择。后续若真实客户端不支持闭合联合 schema 或现有业务校验发生变化，先在状态记录说明证据并做必要的局部契约修订，不能悄悄改变范围或跳过权限。下一轮入口仅为 `EXECUTION_PHASE = 2`，本轮到此停止实现。

## 11. 阶段 2 实施注记（历史，2026-10-28）

第 1–10 节保留阶段 1 的整体契约；本轮已实现并隔离验证单连接、管理 API、Bearer 和前六个读取工具，具体文件及命令见 [最新状态](unified-mcp-status.md)。schema 附件中的 15 工具是整体 v1 目标，**当前目录仅有 6 个读取工具**；签发只接受 read，read_write 明确拒绝，后续阶段完成后才接受。只读 capabilities 的 allowed_actions/可编辑字段/负责人候选/状态动作为空，不提前承诺写入。

实现只使用现有数据库、事务、owner 行锁和签名游标；不新增 Redis、缓存、队列或分布式锁。快照保存 ID/关联上界，超过 10,000 个引用明确回滚拒绝；目录分页游标保存 scope 摘要，避免将大快照带入游标。Workspace 本身跨域，返回 domain=null 及实际可用 domains；业务对象仍保留 administrative/research 和原生类型。

正式报告版本规则的源码核实修正：`report_context.py:selected_report_content` 只接受**当前最新正式版本**，不是任意历史正式快照。统一读取继续复用它。快照连接可保留原报告的元信息，但如果最新正式版超过范围上界，元信息标 `content_available=false/content_state=version_changed`；旧版正文按原服务拒绝，新版不能隐式加入快照。动态连接须指定当前最新版本。该规则没有扩大周报 purpose 或正式提交权限，也未改变历史节点连接的版本漂移语义。

协议已用既有 mcp 1.28.1 SDK 在真实 TCP 上验证 initialize、两页 tools/list、tools/call、一份配置读取两个行政项目和两个科研节点以及撤销拒绝；这属于隔离 SDK 验收，真实目标 Agent 验收仍在阶段 6。新统一 URL 尚未部署到业务运行实例。本轮交付止于阶段 2，下一轮应设置 EXECUTION_PHASE = 3。

## 12. 阶段 3 行政写入实现（历史，2026-10-28）

只读连接仍发现原六工具。至少一个工作区含行政 `read_write` 的连接发现十一工具：六个读取工具，加 `plane_create_task`、`plane_update_task`、`plane_add_comment`、`plane_transition_task`、`plane_get_write_result`。这些工具在每次执行时重新验证连接、目标所属行政域、工作区和原生角色；全局发现不替代目标授权。科研仍只读，不暴露提案、正式周报或删除工具。冻结 JSON 中 update/transition 的科研分支留给阶段 4，当前输入只接受行政分支。

本阶段签发行政 `read_write` **要求 `include_future_objects=true`**；false 与写能力组合明确返回 `capability_unavailable`。快照只读含义不变。此限制避免新任务/新评论创建后立即落在快照外，或为了读回而偷偷扩大快照；尚未实现快照写入例外授权。科研 `read_write` 仍明确拒绝。页面选项在阶段 5 接入真实后端能力。

行政直接调用原生 `IssueCreateSerializer` / `IssueCommentSerializer` 和新抽取的 `utils/issue_mutations.py`；原网页创建/编辑/评论也调用同一保存函数。先执行网页 TimezoneMixin 使用的 `project_domain_allows(write=True)`，再执行抽取自 `allow_permission` 的有效项目角色、创建者和访客规则；默认管理和继承成员继续生效，不创建额外成员。创建者/访客例外不能越过网页已有的域写准入。原生单负责人、默认负责人、项目状态、HTML 净化、说明文本及完成时间继续生效；日期校验补齐部分更新与已有另一端日期的比较（app/REST 两序列化器一致）。

保存后在实际事务提交时投递原活动、通知、webhook 和说明版本任务；不新增消息系统。各投递回调独立，投递失败记录错误，已提交业务结果仍返回 COMMITTED，不伪报回滚。现有后台投递故障恢复仍由原 worker 运维承担，本阶段没有增加 outbox 或交付恰一次保证。

`UnifiedMCPWriteResult` / 0208 只记录成功的创建/评论，唯一键 `(connection, workspace, request_id)`，摘要绑定工具、规范化父目标和参数。请求与回执同事务提交；相同请求返回同一原生对象，换参数或换工具同键报 `idempotency_conflict`。不持久化普通编辑/设状态回执，也没有 prepare/审批记录。连接行和原生目标事务锁串行化撤销/重试，数据库唯一约束兜底。

创建/评论超时先以同连接同 request_id 查询 `plane_get_write_result`，再决定同键重试；禁止换键重建。结果展示仍受当前 scope/ACL 约束，失权后不返历史正文或回执摘要。保存成功但独立读回故障返回 `status=COMMITTED, readback=pending, data=null`；后续读回可能为 verified 或 changed。后者明确原生对象已发生后续变化。普通编辑/状态不使用持久回执；不确定时先读目标再决定是否重试。完全重复的绝对设值跳过多余副作用，不宣称跨其他编辑的恰一次保证。

capabilities 按当前原生角色返回 allowed_actions、明确可编辑字段、分页可选负责人和原生 state_options；状态 action 为 set_state，不套用科研 submit/approve。创建 name 必填；负责人最多一个，空列表清除；开始/截止日期为 ISO 日期或 null。说明允许空串清除，评论按原生非空校验执行，不支持 MCP 附件上传。

已用真实 TCP MCP SDK 跑同一配置发现两个行政项目、两个科研节点及行政创建→负责人/日期编辑→设状态→评论→读回/结果恢复。另在隔离浏览器加载已有 Web 构建，看到任务、说明、评论、负责人、日期、状态及原活动记录；截图和证据路径见状态。通知以原函数生成站内 Notification 与 EmailNotificationLog 验证，未运行邮件发送/beat，也未注册真实 webhook。隔离任务执行适配及已有 Redis origin 提示的替代边界已在状态如实说明，不冒称 worker/Redis 实际部署联调。

0208 是本阶段唯一新迁移。隔离空库迁移和克隆库 0208→0207→0208 已实测；回退保留 Issue/评论/活动/0207 连接，但会删除创建/评论回执。正式回退应先停用统一写连接、保存回执备份并部署兼容只读代码；回执丢失后禁止盲目重放旧 request_id。没有迁移或修改业务数据库。本轮止于阶段 3，下一轮入口 **EXECUTION_PHASE = 4**。

## 13. 阶段 4 科研授权与任务操作（2026-10-28，当前）

本阶段允许签发科研 `read_write`，复用原 RESEARCH_MCP_ENABLED / RESEARCH_MCP_WRITE_ENABLED、工作区 research_chain/research_mcp_write_enabled 和实时科研成员准入。所有写能力仍要求动态范围；快照保持只读。科研读/写按原类别分别最多五条有效连接，统一连接与覆盖节点的旧授权双向合并计数；不为未来节点复制 ContextGrant/WriteGrant。

`NodeOperationAuthorization` 验证真实旧 ContextGrant＋WriteGrant，`UnifiedOperationAuthorization` 验证真实统一连接、owner、声明工作区、科研写能力、到期/撤销和既有策略。两者交给同一 `ResearchOperationService`。机器调用不以 grant=None 绕过 authenticate；grant=None 仍仅保留原人工页面的内部读取/决定路径，机器执行会拒绝。统一写的锁序先连接，再原工作区策略/用户，再链/节点/目标；撤销沿用同一连接行锁。

0209 为原提案增加 nullable original_connection，并将 original_grant 改为 nullable，加数据库恰一来源约束。旧提案继续按原字段/算法计算 seal，不回写已有哈希；统一来源采用显式版本 unified_mcp.v1＋连接 ID。唯一键 `(workspace,user,request_id)` 保持原样，跨连接/来源同键不能收养提案。旧同 owner、同 node 的合法刷新写授权继续查询/执行旧提案；统一提案只允许原连接 get/list/execute，撤销/失权即时拒绝。游标也绑定连接、scope 和 request_id 筛选。溯源记录真实 connection_id，未伪造 grant_id 或批准人。

当前目录最多 **15 个工具**：只读 6；仅行政写 11；仅科研写 12；行政＋科研写 15。工具数量取决于声明能力，目标动作继续校验当前角色/状态/策略。阶段 1 JSON 的全部 15 个输入 schema 已与实现逐项对齐，没有额外万能 JSON 写入口。

科研五类动作统一使用 `plane_prepare_research_operation` → `plane_execute_research_operation`：create_task、append_task_comment、save_analysis_draft、attach_task_resource、append_research_note。准备只保存不可变提案，执行直接复用原任务/评论/分析/资源/事件服务，不自动准备并批准，也不要求 Plane 二次确认。`plane_get_research_operation` 恢复提交/读回结果；准备超时用 `plane_list_research_operations` 按同 request_id 查找，再决定同键重试。列表支持完整游标，沿用原服务每页最多 20 的保守上限，即使请求 limit 更大也不会截断后续数据。

`plane_update_task` 科研分支直接编辑 title/instruction/assignee/due_at；仍经过原生任务 serializer 和 update_task，不接受 status 或 resource_type/id。赋负责人导致 DRAFT→ASSIGNED 是原服务行为，不能把角色权限当成审批权。`plane_transition_task` 直接调用 submit/return/complete/cancel；提交限有效课题成员中的当前负责人，退回/完成限真实科研审核角色，取消限链管理者。任务状态不直接赋值，也不改变节点生命周期。

直接状态动作复用原 ResearchChainEvent 幂等结果，键由连接/工作区/客户端 request_id 确定；重试先校验当前身份/角色和原事件归属/摘要，再返回已有结果，不要求任务仍处于动作前状态。普通编辑不增加提案/回执表。状态不确定先读任务/事件，再使用原 request_id 重试；长提案操作始终查询原 operation_id，不换键重建。所有提交后读回与业务保存分开；读回故障不会重复业务写入。截止时间以 UTC 时间点比较，避免时区表示不同导致假 changed；MCP 文本和 structuredContent 统一为相同 JSON 值。

capabilities 与列表 allowed_actions 按真实 owner/角色、状态、原生能力投影及连接/策略交集计算；给出分页的原生课题成员候选、可编辑字段、状态动作必填字段、五类提案 payload schema 与 proposal/direct 执行模式。科研链自身不伪装成任务。提案返回保留原生版本标识，并补统一 domain/type/ID、父节点、网页链接与允许动作。

已完成真实 TCP SDK 同一配置跨两个节点的创建、编辑/分配/日期、评论、原生取消及读回；角色矩阵另验证 submit→return→resubmit→complete 与取消限制，并通过原网页 REST 读回任务。旧授权/旧提案、并发执行、失权/撤销、只读、篡改/冲突、超时恢复和真实周报凭据隔离均有专用测试。这里是 SDK/API 验收，未冒称目标 Agent 导入验收或阶段 4 新增 GUI 操作。

0209 在隔离库实际迁移与回退：只有旧提案时 0209→0208→0209 保留原哈希且升级后可执行；存在统一来源提案时，反向迁移明确拒绝，事务保留数据和迁移记录。部署回退不得伪造节点授权、重写哈希或自动删除提案；应停用相关统一写连接并保留 0209 兼容 schema/代码，结构回退须先由运维明确导出和处理统一来源记录。本轮未迁移业务库，未部署。下一阶段入口 **EXECUTION_PHASE = 5**。

## 14. 阶段 5 实现记录（2026-10-29）

原个人设置 MCP 页面以统一连接为首要入口：连接名称→选择工作区→各工作区行政/科研与只读/读写→生成一条连接、一份配置。默认当前工作区、动态范围；选项完整分页，不预加载项目/节点。新 Session-only `/api/mcp/connections/options/` 沿用原工作区/科研策略返回能力、TTL、CSRF、最多 20 工作区；权限仍在签发和每次机器调用时重查。

动态范围明确覆盖当前及未来新增且本人有权访问的项目、链、节点和任务；关闭动态只允许快照只读。统一列表展示实际范围、分域能力、到期、最近使用、撤销状态和分页。密钥只在生成结果内存中显示，关闭/修改/切换/刷新即清除，不能由列表恢复；TOML/JSON 复用原配置工具并校验只有一个 `/api/mcp/` server，不将旧节点配置打包当统一配置。

旧门户/节点精细范围搬到显式展开的“兼容与精细范围连接”，每张旧连接标为兼容连接；保留原签发/撤销/范围语义，不扩大或替换旧授权。未知签发结果不自动重试，先核对连接列表；撤销仍用原 Session+CSRF 管理服务。本轮无新增表、迁移、缓存、队列、依赖或开关，未修改 API Token/周报页面。

实际验证：后端 101 项、前端七文件 86 项；类型生成/检查和隔离构建通过；真实页面生成/下载一个 server，真实 SDK 同配置读取两个工作区/行政项目及两个科研节点，页面撤销后 HTTP 401，旧节点凭据 hash 不变。现有个人设置外框在 390px 窄屏裁切主内容，已保存截图并如实记录，未宣称移动端通过。未部署，真实目标 Agent/完整集成及发布材料仍属阶段 6；命令、路径、证明及限制见 [阶段 5 状态](unified-mcp-status.md#2026-10-29-阶段-5页面与配置简化本轮)。

## 15. 阶段 6 进展与本机验收（2026-10-29）

真实 Codex CLI 发现并调用统一服务，完成行政与科研任务闭环；由此发现并修复 tools/list 对标准请求级 `_meta.progressToken` 的兼容问题。元数据仅作为协议字段忽略，不改变权限或闭合业务输入。新增单配置双域、未来节点、成员退出和真实 HTTP 超时恢复集成，修复后相关 25 项通过；完整相关回归尚有一项原生事件无显式排序断言失败，未标全通过。

用户追加要求后已启动原 Windows 本机环境 http://localhost:3000/settings/profile/mcp/，原账号/数据/配置保留，事先备份数据库与旧前端；本机待办迁移 0205–0209 已应用，远端未部署。阶段 6 尚未宣布完成，详细结果见 [当前状态](unified-mcp-status.md)，发布、配置和兼容回退说明见 [发布材料](../operations/unified-mcp-v1-release.md)。

## 16. 同步 develop 后的当前原生规则（2026-10-29）

上游 194f1320 将科研任务作为工作项，负责人直接 complete/reopen，管理者 cancel；统一 MCP 已同步当前状态枚举、动作投影、服务调用及回归，不继续暴露旧 submit/return，也不将写权限当作审核权限。报告审批保持独立，网页与周报 MCP 共用提交服务，并要求显式 reviewer_id，可附 cc_user_ids；候选来自原生审批组，提案冻结选择，执行重新验证。上述变化取代前节历史版本中的任务提交/审核语义。

新增 0210 合并迁移保留两支 0209 记录；业务库尚未执行本次 develop 新迁移。相关后端 200 项及类型/隔离构建通过，前端科研面板测试仍有 20 项失败，不能称全量验收通过。见当前状态中的 develop 同步记录。

### 最新 develop 继续同步

2026-10-29 继续同步到 `48bf0767`（本地 `71d22dbe`），上游也已合入个人周报 MCP 的完整显式审批选择 schema，沿用其实现。新增 0211 空合并迁移；原连接/提案与旧迁移记录不重写。科研面板测试加载问题已修复，最新前端 114 项通过；后端 207 项通过，隔离缓存适配后原失败项所在文件 4 项复验通过。详细版本与测试边界以状态文档和 develop 同步记录为准，未自动部署新版本。
