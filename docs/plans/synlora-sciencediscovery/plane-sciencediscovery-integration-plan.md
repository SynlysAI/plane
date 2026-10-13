# Plane 科研智能体前端接入 ScienceDiscovery 后端 —— 完整方案

| 项目     | 内容                                                                                                                              |
| -------- | --------------------------------------------------------------------------------------------------------------------------------- |
| 文档版本 | v1.5（2026-10-13）                                                                                                                |
| 状态     | 方案设计，待评审                                                                                                                  |
| 涉及仓库 | `SynlysAI/plane`（develop，4.19.x）、`sciencediscovery_github`（main，JiuwenSwarm 默认执行器）                                    |
| 关联文档 | plane `docs/research-intelligent-platform-prd.md`（§6.2）、`docs/research-intelligent-platform-phase-1.5-execution-runbook.md`    |
| 结论预览 | 可行，SD 侧零代码改动；核心 = 复刻 SynloraClient 模式新增 runtime provider，SD 以学生自助级（用户级）连接接入——每人自己的本地实例 |

---

## 1. 背景与目标

学生在 Plane 的科研智能体前端（节点详情 → Agent 工作台）提问，问题交给 **ScienceDiscovery（SD）** 处理，大模型回复回流 Plane 前端展示，全程留痕到研究链时间线。

## 2. 现状代码事实（本方案的地基）

### 2.1 Plane 侧：前端不认识任何后端

「前端契约」指前后端之间约定好的调用方式——前端只管按约定调用，不关心背后是谁在真正干活。Plane 的智能体聊天界面从设计上就**不知道后端是谁**，它只会用下面这几个固定函数（`apps/web/core/components/research/agent/use-research-agent-session.ts`）：

```
createSession(workspaceSlug, chainNodeId)       → session（含 run_id）
sendMessage(workspaceSlug, sessionId, content)  → {session, events}   ← 同步，等整个 run 结束
getEvents(workspaceSlug, runId, afterSeq)       → {results, count, latest_seq}  ← 游标增量（书签式：记住上次取到第几条，下次只取新事件）
cancelRun / closeSession / decideApproval / saveArtifact
```

- 事件形状 `TAgentRunEvent {run_id, seq, event_type, payload}`（`agent-plugin.v1`）——AI 回复过程中的每段文字、每次调用工具，在后端看来都是一条带编号的事件，前端从事件的 `payload`（事件携带的内容）里取 `content`/`text` 当正文、`reasoning` 当思考过程、`sources` 当引用来源（`research-agent-conversation.tsx:31`）
- 会话状态机即会话的几种状态标签：`READY`（空闲，随时可发消息）/ `WAITING_APPROVAL`（等用户审批）/ `STREAMING`（正在流式输出）/ `SAVING` / `DEGRADED`（上游出错、降级运行）/ `ERROR` / `CLOSED`
- **当前智能体后端是 Synlora**（`SynloraClient`），其全部细节（delegated token、SSE、远端 session id）封在 BFF（Backend for Frontend——Plane 自己的后端中间层，负责鉴权、转发、翻译，前端不直连 Synlora/SD）后面 → **换/加后端只需改 Plane 后端，前端不动**

前端的请求先打到 Plane 自己的后端（即上面说的 BFF），再由它去调用真正的智能体服务。这层有四个关键文件（全部可作为新 provider 的参照实现）：

| 文件                                                                 | 职责                                                                                                           |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `apps/api/plane/research/views/agent.py`（前台接待）                 | 接收前端请求、返回响应；消息发送时同步接收流式回复，事件轮询端点每次增量拉远端事件并翻译入库                   |
| `apps/api/plane/research/services/synlora.py`（通讯客户端）          | `SynloraClient`：封装与 Synlora 通话的全部细节（token 交换、能力查询、建会话、发消息收流、拉事件、取消、关闭） |
| `apps/api/plane/research/services/agent_orchestrator.py`（装配车间） | 决定一个会话能用什么人设、插件、工具、知识库、文件，签发上下文凭据（`agent-context.v2`），串起建会话流水线     |
| `apps/api/plane/research/services/chain_projection.py`（翻译与记账） | 把外部事件翻译成 Plane 格式并写入研究链留痕；幂等键 `synlora:{远端session}:{远端seq}` 防止同一事件重复记账     |

接入 SD，本质上就是照着这四件套再写一套。

### 2.2 ScienceDiscovery 侧：API 服务，同一入口端口（本机 adapter 5300）

SD 把所有能力通过一组 HTTP 接口对外开放——建会话、发消息、取回复、传文件各有一个对应「窗口」，Plane 后端要做的所有事都能在下表找到地方。鉴权上整个 SD 只认一个令牌（单 Bearer token，`SCIENCE_AGENT_AUTH_TOKEN`）：谁拿到令牌谁能用，这也是后文反复强调它不能暴露公网的原因。

| 端点                                                                                | 作用                                                                                                          |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `POST /api/projects/{pid}/sessions`                                                 | 建会话（`CreateSessionRequest`：title、modelId?、approvalMode?、specialistId?、runnerIds?）                   |
| `POST /api/sessions/{id}/runs`                                                      | 发消息 `{content, references?, skillLibraryRefs?, webForceRefresh?}` → **201 立即返回 runId（异步排队执行）** |
| `GET /api/sessions/{id}/runs/{runId}/events?after=N`                                | 增量拉事件（JSON 数组；`Accept: text/event-stream` 则 SSE），`SessionRunEvent{sequence, event}`               |
| `POST /api/sessions/{id}/runs/{runId}/cancel`                                       | 取消运行                                                                                                      |
| `GET /api/sessions/{id}/messages`                                                   | 会话历史                                                                                                      |
| `POST /api/sessions/{id}/workspace/upload`                                          | multipart 文件上传进会话工作区（conflict 策略 + 三层配额）                                                    |
| `GET/POST /api/models`、`PUT/DELETE /api/models/{id}`、`POST /api/models/{id}/test` | 模型 profile 管理（管理员）                                                                                   |

一次运行过程中，SD 会陆续发出下列事件——相当于执行过程的实时播报：开始跑了、正在思考、正文写到哪了、调用了什么工具、是否需要用户批准、最后跑完（`run.completed` 带最终全文和产出文件）。Plane 的任务就是把这份播报逐条翻译成自己的事件格式（见 §7 对照表）。完整词汇定义见 `packages/schema/src/session.ts:405-472`：

```
run.started / run.queued / run.status / run.completed{message:{content}, files}
run.cancelled / run.failed{error, errorCode}
assistant.delta{delta}          ← 流式正文，字段名与 Plane 前端渲染契约直接兼容
assistant.snapshot{content}
assistant.thinking.delta / assistant.thinking.snapshot
assistant.response.started / assistant.response.settled
agent.phase{phase:"thinking"}
tool.started / tool.output{toolCallId, chunk} / tool.completed
permission.required{request} / permission.resolved{request}
plan.updated / workspace.changed / artifact.upserted / model.usage / subagent.*
```

架构链：Web/外部调用 → adapter(5300) → API 服务(5400，sessions/runs/工件/技能/记忆)；adapter → gateway(WS) → JiuwenSwarm（agent loop 真正执行处）→ llm_proxy（每 run 私有模型路由）→ LLM。通俗地说：所有请求统一从 5300 这一个端口进入，由 adapter 总机分流——管会话、文件、模型档案的是 API 服务，真正驱动 AI 干活的循环在更里层、经 llm_proxy 找到大模型。对本方案最重要的结论：**Plane 只需要跟 5300 这一个门口打交道**。

**三处天然对齐**（工程量小的原因）：

1. 事件游标模式同构：SD `events?after=N` ≡ Synlora `after_seq` ≡ Plane BFF `after_seq`
2. 回复字段名直接兼容：`assistant.delta{delta}` / `run.completed{message:{content}}` → 前端读的 `content/text`
3. Plane 前端零后端感知：换 provider 不动前端契约

这三条合起来就是「工程量小」的底气——两个系统在「怎么取增量消息」「回复字段叫什么名字」这两个最核心的机制上天生一致，几乎不用做格式转换；前端又本来就不关心后端是谁，改动因此可以集中在 Plane 后端一处。

### 2.3 模型管理：SD 管理员一次性配置，Plane 不碰 key

- 大模型以「档案」（profile：模型地址、名称、API key）的形式登记在 SD 内部，由使用者在其界面一次性配置，key 加密存储
- 会话只引用 `modelId`（可选，缺省用默认模型）；执行时查档案，无模型/无 key 直接报 400（`services/api/src/runs/index.ts:725-732`）——**若 SD 未配过模型，使用者在 Plane 上提问会立刻收到「模型不可用」报错**；配好了则完全无感
- Plane 零感知、零配置；判断方法很简单：能在本机 SD 网页里正常聊天，就说明已配好

### 2.4 文件现状：Plane 科研文件「不落库」

现状下，Plane 对上传文件只当「搬运工」（`views/knowledge.py:269-358`）：文件从浏览器上传后，在 Plane 后端内存里过一遍手（算个指纹、验下大小类型），转头就交给 RAGPortal 送进 WeKnora 知识库；Plane 自己只留一张「快递单」——`ResearchChainUpload` 元数据（文件名/类型/大小/哈希/kb_id/external_upload_id），不存文件内容，RAGPortal 同样不存。**也就是说，「事后从库里取回文件」今天并不存在。**

SD 侧的规则则相反：AI 只能读**会话工作区**——相当于给这次对话配的专属文件夹，文件传进去（workspace/upload）会真正落盘并记录来源（溯源 origin=user_upload + 记忆图谱 SourceFile 节点），模型通过桥接工具 `read_file` / `list_files` / `run_shell`（沙箱）处理。一边不留文件、一边必须要文件，两边对不上——这就是 §9 文件通道要解决的问题。

### 2.5 PRD 既有定位（§6.2）

- Synlora 是**唯一**云端通用 Agent Runtime；SD 定位本地/可信网络工作站（连接器、MCP、长任务、证据链、CAS/Artifact）
- SD 单 bearer token 形态**不得直接公网部署**
- 本方案与该定位不冲突（SD 仍在内网当工作站），但「唯一 runtime」的表述需更新，见 §12

## 3. 总体方案

**复刻 Synlora 接入链，新增一个 runtime provider（运行时提供方）**——可以理解为**可更换的发动机**：Plane 前端是同一辆车、同一套方向盘（契约不变），后端发动机既可以是 Synlora，也可以换成 SD。现有代码已把 Synlora 接入封装成独立的客户端类（`SynloraClient`），因此接入 SD 就是照着它写一个 `ScienceDiscoveryClient`、插到同一位置，其余流程原样复用：

```
Plane 前端（契约不变）
   ↕ 现有 BFF 契约（agent-plugin.v1）
Plane BFF（views/agent.py）
   ├─ SynloraClient            ← 现有，不动
   └─ ScienceDiscoveryClient   ← 新增，同一套方法签名
        POST /runs（异步）→ 轮询 events?after=N → 投影 → 前端
```

### 端到端数据流（目标形态）

```
学生在 Plane 节点提问（可附文件）
 → BFF：权限校验 + 装配 + 审计（复用现有逻辑）
 → [文件通道] BFF multipart 转传 SD workspace/upload（见 §9）
 → POST SD /api/sessions/{id}/runs {content} → 拿到 runId 立即返回
 → 前端自动轮询 BFF getEvents(after_seq)
 → BFF 每次轮询调 SD events?after=N，翻译 + 落库 + 幂等去重
 → assistant.delta → OUTPUT 事件（payload.content=文本）→ 前端渲染
 → run.completed → 最终回复 + 写 Chain Event（source_system="SCIENCE_DISCOVERY"）
 → 研究链时间线留痕，节点详情六段视图可见
```

整条链路串起来读：学生提问后，问题先经 Plane 后端把关（这个人能不能问、能引用哪些资料），带文件就先送进 SD 的会话文件夹；然后问题递给 SD——**SD 立刻回一张「受理单号」（runId），并不当场回答**；前端拿着单号定时来问「有新进展吗」，Plane 后端每次去 SD 取增量、翻译、存档去重；AI 的回答一段段流回来渲染到界面；整轮跑完后写入研究链时间线，成为课题的正式留痕。

## 4. 会话与身份映射

两个系统的「组织结构」不一样，先对上号——Plane 的科研课题 ↔ SD 的 project（该课题的所有历史对话归在它名下），某用户在某节点的会话 ↔ SD 的 session，会话里的一问一答 ↔ SD 的 run：

| Plane 概念                   | SD 概念    | 映射策略                                                                                                                                                                                                                                                                                   |
| ---------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 用户 + 连接配置              | —          | `ResearchAgentBackendConnection`（用户级，§5）：一学生一条，base_url + credential_ref；建会话时解析——自配且启用的 SD 连接优先，否则回落平台默认 Synlora                                                                                                                                    |
| 科研课题（research project） | SD Project | **一个课题一个 SD project**：首次使用时惰性创建（避免空 project 堆积），命名 `plane-{课题ID前8位}-{课题名}`，`sd_project_id` 记在 Plane 侧。课题归档/删除不碰学生 SD——数据在学生自己机器上，Plane 只管自己侧的留痕（自包含，不依赖 SD 存活）；学生误删 SD project 也无妨，下次使用自动重建 |
| (用户, 链节点)               | SD Session | 一个 Plane Agent 会话 ↔ 一个 SD session，`sd_session_id` 存 `ResearchAgentSession`（复用现有字段模式，参照 `synlora_session_id`）                                                                                                                                                          |
| 消息轮次                     | SD Run     | `sd_run_id` 存 session                                                                                                                                                                                                                                                                     |

**身份**：SD 只认一把总令牌、无租户隔离（不区分「这是谁家的数据」），因此不需要 Synlora 那套「替用户换临时票」的机制（delegated-token / AccountLink / context-token 回调校验）——Plane BFF 是唯一调用方，SD 只管干活；**谁有权限用、能用哪个节点、哪些文件，全部由 Plane 自己把关**，SD 信任来自内网的调用方。SD 侧发来的编号（project/session/run id）都记在 Plane 数据库里，下次接着用。补偿措施见 §11。

## 5. 用户级后端配置：学生自助连接本地 SD

SD 是单用户系统——一把钥匙、不区分来客，这恰好与目标场景「一个学生一个本地 SD」匹配。连接因此设计为**用户级**：每个学生在 Plane 上自助把自己的 SD 配成「我的智能体后端」，一学生一条连接，各用各的钥匙、数据、模型 key。这不同于 Synlora 的接法（Synlora 是云端多租户，workspace 配一条连接、全员共用，用户身份用 delegated token 随请求携带）——SD 没有租户概念，若同样按 workspace 共享一条连接，所有学生会挤进同一个实例（该共享形态要不要作为补充，见 §15 决策点 4）。

**解析优先级**（建会话时解析一次，会话期内钉死）：

```
学生自配的 SD 连接（存在且启用）→ ScienceDiscoveryClient(该连接)
否则                             → SynloraClient(workspace)   ← 平台默认，现状不变
```

路由只看学生的意图（配了且启用），**不看 SD 当前在不在线**——SD 掉线不静默换后端，而是明确报「本地 SD 不可达」进降级态，由学生自己决定：修好它，或停用自己的连接、回落默认 Synlora。健康徽标只是提示，不参与路由。

**数据模型（Plane 侧新增，SD 零改动）**：新表 `ResearchAgentBackendConnection`——workspace + user 联合唯一、base_url、credential_ref（密文引用）、is_enabled / health_status / last_health_at。不复用现有 `ExternalSystemConnection`——那张表的语义是「一个 workspace 一条系统连接」（Synlora 用的就是它），SD 走用户级、一学生一条，是新表、新语义。`ResearchAgentSession` 增加 provider + backend_connection_id 两个字段：会话一旦建立就钉死走哪个后端，后续轮询、审批、取消、传文件都按会话记录路由，不跟随用户后来的改动——跑到一半换发动机，事件流就对不上了。

**学生视角的配置流程**：设置 →「智能体后端」→ 看到平台默认（Synlora）和「添加我的 ScienceDiscovery 实例」→ 填 base URL 和自己 SD 的访问令牌 → 点「测试连接」（BFF 调 SD `GET /api/models`，能列出模型即通，顺带确认模型档案已配好，见 §2.3）→ 保存启用，之后新建的会话就走自己的 SD。界面上常驻健康徽标；SD 掉线（笔记本合盖很常见）时按现有 fail-closed 原则明确报「本地 SD 不可达」并进入降级态，人工科研记录不受影响。

**网络与安全（本设计的关键约束，逐一过）**：

- **可达性前提**：Plane 后端必须能直连学生的 SD——适合校园网、实验室内网或 VPN 部署；若 Plane 在公网而 SD 在学生家宽路由器后面（NAT 后），直连不可行，需要隧道方案另行立项。PRD 红线「SD 不暴露公网」继续成立：是 Plane 主动进来找 SD，不是 SD 开门出去。
- **SSRF 防护（新增攻击面，必须做）**：从此 BFF 会向「用户随手填的 URL」发起请求，若不设防，等于给学生一个探测内网的跳板。对策：仅允许 http/https；域名解析出 IP 后限定私有网段白名单（CIDR 可配置）；显式拒绝云 metadata 地址（如 169.254.169.254）与回环；只放行 SD 已知的 `/api/` 路径前缀，不做通用代理；不跟随重定向。
- **令牌安全**：密文存储、界面只回显「已配置」，与 Synlora 连接走同一套 secret 管理。
- **治理开关**：workspace 级设置「允许成员使用自有智能体后端」，默认关——管理员不开，学生就配不了，学校保留最终控制权。
- **审计**：`IntegrationCallLog` 照记，补上 user 维度（谁的自有后端、调用了多少次）。

**隔离为什么不再是问题**：SD 单 token、无租户隔离的固有风险，在一人一 SD 下自然消解——每个学生一把自己的钥匙、自己的数据、自己的模型 key（模型账单也归自己），隔离边界从应用层移到了部署层。代价是上面的 SSRF 防护必须做扎实，且平台要承担「学生 SD 不可达」的答疑成本。

## 6. 消息链路：异步化（最重要的技术决策）

现有 Synlora 模式是「站在窗口等」：发消息后 Plane 后端一直等到 AI 完整说完才返回，前端全程转圈。SD 的任务动辄跑几分钟到几小时（文献综述、演化搜索），这么等会把请求拖死；好在 SD 的 run 本来就是异步排队的，顺势改成「取号模式」：

- **sendMessage 改为提交即返回**：BFF 转发 `POST /runs` 拿到 runId 后立即响应 `{session, events}`（events 含用户 COMMUNICATION 事件），session 置 `STREAMING`——交完问题立刻拿号，不站窗口等
- **增量事件靠现有轮询端点**：`RunEventEndpoint`（`agent.py:629`）本来就是「每次轮询 remote_after → 拉远端 → 投影」模式，SD 路径照搬：前端每次来问「有新进展吗」，BFF 就去 SD 取一次增量（`events?after=N`）
- **前端唯一改动**：发送后自动轮询 `getEvents`（现在 `reconnect` 是手动按钮，改成自动，约 20 行）。轮询节奏用指数退避：起初约 1 秒问一次，没新消息就逐步放慢（2 秒、4 秒……），最慢 30 秒一次，避免空耗服务器

落到界面上，两种模式的差别一目了然：

- **同步（现状）**：用户点发送后，输入框置灰、按钮转圈，界面停在「发送中」——任务跑多久就转多久。问一个要跑两分钟的文献综述，就干看两分钟转圈；碰上几十分钟的长任务更糟：浏览器和网关通常一两分钟就会掐断这种「迟迟不返回」的请求，界面直接报错，而后端其实还在跑。中途关掉页面再回来，只能手动点「重连」把已产生的事件捞回来。
- **异步（目标）**：点发送后，用户的问题立即上屏，回答区马上打开并显示「思考中」；随后思考过程、正文、工具卡、产物卡随着轮询一段段长出来，像看直播。期间可以切到别的节点再回来（游标自动补齐错过的事件），甚至关掉页面晚点再看；几十分钟的长任务也稳——没有任何一个 HTTP 请求需要从头挂到尾。

## 7. 事件映射与投影

SD 与 Plane 各说各的「方言」（`run.completed`、`assistant.delta`… 对 OUTPUT、TOOL_CALL…），中间需要一张对照表逐条翻译——落到代码上是泛化 `chain_projection.py`，`EVENT_TYPE_MAP` 按 provider 配置。翻译完还要记账，幂等键 `sd:{sdSessionId}:{sequence}` 相当于防重复记账的流水号：同一条远端事件哪怕因网络重试被拉回两次，凭流水号认出「已记过」，只记一次（同 Synlora 模式）。下表即翻译对照表，并注明每类事件最终在界面上呈现成什么：

| SD 事件                                     | Plane event_type        | Chain event_type        | 前端呈现                                                                           |
| ------------------------------------------- | ----------------------- | ----------------------- | ---------------------------------------------------------------------------------- |
| `run.started` / `run.queued` / `run.status` | `AI_ACTION`             | `AI_ACTION`             | 过程行                                                                             |
| `assistant.delta`                           | `OUTPUT`                | `OUTPUT`                | 正文（payload.content=增量）                                                       |
| `assistant.snapshot`                        | `OUTPUT`                | `OUTPUT`                | 正文快照                                                                           |
| `assistant.thinking.delta/snapshot`         | `AI_ACTION`             | `AI_ACTION`             | payload.reasoning                                                                  |
| `agent.phase{thinking}`                     | `AI_ACTION`             | `AI_ACTION`             | 思考中                                                                             |
| `tool.started/output/completed`             | `TOOL_CALL`             | `TOOL_CALL`             | 工具卡（现有 toolEvents 过滤直接命中）                                             |
| `permission.required`                       | `APPROVAL`              | `APPROVAL`              | 触发 WAITING_APPROVAL + 审批抽屉                                                   |
| `permission.resolved`                       | `HUMAN_DECISION`        | `HUMAN_DECISION`        | 决策留痕                                                                           |
| `plan.updated`                              | `AI_ACTION`             | `AI_ACTION`             | 计划行                                                                             |
| `workspace.changed`                         | `DATA_CHANGE`           | `DATA_CHANGE`           | 文件变更行                                                                         |
| `artifact.upserted`                         | `INTERMEDIATE_ARTIFACT` | `INTERMEDIATE_ARTIFACT` | 产物行（artifactEvents 过滤直接命中）                                              |
| `model.usage`                               | `AI_ACTION`             | —                       | 用量（可不投）                                                                     |
| `subagent.updated` / `subagent.step`        | `AI_ACTION`             | `AI_ACTION`             | 专家调度行（唤起了哪个专家、进行到哪步；`subagent.usage` 同 `model.usage` 可不投） |
| `run.completed`                             | `OUTPUT`                | `OUTPUT`                | **最终回复**：payload.content = message.content                                    |
| `run.failed`                                | `DEGRADED`              | `DEGRADED`              | 错误态                                                                             |
| `run.cancelled`                             | `DEGRADED`              | `HUMAN_DECISION`        | 取消态                                                                             |

状态映射：SD run `queued/running` → session `STREAMING`；`completed` → `READY`；`failed` → `ERROR/DEGRADED`；`cancelled` → `READY`（带说明）。

**审批桥接**：SD 执行中遇到敏感操作（跑脚本、动文件等）会暂停并广播 `permission.required`「等批准」；Plane 收到后把会话置 `WAITING_APPROVAL`、弹出审批抽屉（前端组件现成）。审批抽屉提供三个按钮，Plane 翻译成 SD 认识的词转发回去（`decideApproval` → adapter `POST /agent/approvals/{request_id}`）：**批准一次**（`APPROVED→allow_once`）、**批准并记住**（→`allow_matching`：本会话内完全相同的操作不再询问——同一条命令、同一路径才算相同，连接器按整个连接器，仅本会话有效、不跨会话）、**拒绝**（`REJECTED→deny`）。SD 再继续或中止——整个过程学生不用离开 Plane 界面。「批准并记住」的按钮文案要写明范围（如「批准并记住（本次会话内相同操作不再询问）」），避免被理解成永久放行。

## 8. 产物展示与归档

SD 运行期间产出的报告、图表、数据集，分三层落到 Plane：第一层零成本（现有代码直接命中），第二层加一个代理端点，第三层复用现有流程。

**第一层：会话内产物卡——前端零改动**。SD 每产出或更新一个产物，会广播 `artifact.upserted` 事件（带产物名、类型 kind、描述、版本号）；BFF 照 §7 对照表把它投影成 `INTERMEDIATE_ARTIFACT` 事件，并把字段翻译进 payload：`kind → artifact_type`（report/markdown/figure/dataset…）、`name + description → summary`、`action: created/updated`。前端「产物」面板本来就收集 `DATA_CHANGE / INTERMEDIATE_ARTIFACT / OUTPUT` 三类事件并逐条渲染卡片，卡片正文读 payload 的 `summary / artifact_type / action`——字段对上，产物卡自动出现，与 Synlora 的 `file/send` 走同一条路。`run.completed` 附带的产出文件与过程中的 `workspace.changed` 也照表映射成文件变更行，与产物卡并列。

**第二层：内容查看与下载——新增一个 BFF 代理端点**。产物本体存在 SD 的内容寻址存储（CAS，按内容哈希寻址、天然版本化）里，Plane 不复制字节——与 §9 文件通道同一原则。SD 已有现成端点：`GET /api/sessions/{sid}/artifacts`（列产物）、`GET /api/sessions/{sid}/artifact-versions/{vid}/content`（直接返回字节流，带正确的文件类型）、`GET .../artifact-versions/{vid}/provenance`（溯源：谁在哪一轮生成、输入是什么）。Plane BFF 加一个代理端点转发即可，前端产物卡片配「查看/下载」。两条安全约束：只有 chain 成员可取；`vid` 必须是本会话事件流里出现过的版本，防止越权取别家会话的产物。

**第三层：升格为课题正式留痕——复用「保存到节点」流程**。Plane 已有人工确认产物的完整流程：用户填类型、摘要并确认 → 未确认时存 `ResearchAnalysisResult` 草稿，确认后创建不可变的 `ResearchChainSnapshot` 挂到研究节点（节点详情六段视图可见）并回写 `DATA_CHANGE` 事件。对接方式：在产物卡片上加「保存到节点」，表单自动预填 SD 产物信息，SD 的 version id / 内容哈希写进 `source_versions` 引用，保证 Plane 快照随时能回指 SD 原件。唯一要新做的是一张类型收敛映射表：Plane 只认六类快照（`ANALYSIS_SUMMARY / LITERATURE_REFERENCE / EXPERIMENT_DATA / EXPERIMENT_RECORD / RESEARCH_PLAN_DRAFT / PROCESS_NOTE`），SD 的 kind 有十类（dataset/figure/html/json/latex/markdown/notebook/other/report/structure），放不进的（figure/html）归入最接近的类或扩展集合——见 §15 决策点 3。

## 9. 文件通道：上传时分叉（fan-out）

**原则**：Plane 不存文件字节、SD 只认会话工作区，因此正确姿势是让文件**在经过 Plane BFF 的那一刻分一路给 SD**——上传时顺路捎带，而不是事后回库里取（如 §2.4 所述，今天取不回来）。

```
用户附加文件 → Plane BFF（内存中转）
   ├─ 权限校验：chain 成员 + allowed_file_ids 装配约束
   ├─ 类型/大小/哈希/幂等（现有逻辑）
   ├─→ 转发 RAGPortal → WeKnora      ← 检索通道（文献、PDF、文档；类型限 PDF/MD/txt/Word）
   └─→ 转发 SD workspace/upload       ← 分析通道（任意类型，配额内；本方案新增）
```

两条通道用途不同：送 RAGPortal/WeKnora 是为了**日后能检索到它**（所以只收文档类格式）；送 SD 是为了**这次对话里 AI 能直接打开分析它**（什么格式都收，包括 Excel、图片、仪器原始数据）。

分两期落地：

| 期次         | 入口                   | 做法                                                                                                                                                                                                 |
| ------------ | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 一期（必做） | **Agent 界面附加文件** | AI 会话已建立，用户在输入框旁传文件 → 前端传 BFF → BFF 校验后 multipart 转传 SD（`POST /api/sessions/{sid}/workspace/upload`）→ 成功后写 Chain Event（`DATA_CHANGE`，refs 指向 ResearchChainUpload） |
| 二期（可选） | 节点资料上传双写       | 用户往节点传资料时 BFF 同时分叉两路（RAGPortal + SD 暂存到课题对应会话）                                                                                                                             |

**治理要点**：

- 权限判定在 Plane（`allowed_file_ids` ∩ 用户选择），SD 不判权限
- **哈希对账**：Plane `file_hash`(sha256) 与 SD 上传返回的 `hash` 都写进 Chain Event，保证「给模型的文件」与「Plane 记录的文件」逐字节一致（「哈希」即文件指纹：内容相同指纹必相同，指纹一致即内容一致）
- 配额双份执行：Plane `MAX_UPLOAD_BYTES` ∩ SD `uploadMaxFileBytes / maxRequestBytes / maxWorkspaceBytes`
- SD 侧自动产生 provenance（origin=user_upload）+ SourceFile 记忆节点，与 Plane Chain Event 双向可追溯

**已知坑**：

1. 大文件：现有 `knowledge.py` 是 `uploaded.read()` 全量进内存，双写后内存峰值翻倍——SD 通道先设保守上限（如 100MB），大文件后续改流式
2. 「分析历史节点文件」今天做不到（RAGPortal/WeKnora 无取回端点）：一期让用户在 Agent 界面重传；二期评估给 RAGPortal 补按 id 取字节端点
3. 两通道类型口径不同是**特性不是 bug**：csv/xlsx/图片/仪器原始数据本来就不适合入库检索，分析通道是新增能力

## 10. 专业智能体的供给：让 spec_agent 在 SD 里开箱即用

现状是两套插件体系互不认识：Synlora 的插件（spec_agent、poly_agent 等）部署在 Synlora 云端、经 capabilities 清单广播给 Plane；SD 完全不知道它们的存在——SD 侧对应的概念叫 specialist（内置 8 个，可自定义）。指望学生装好本地 SD 后再照着文档手工创建「谱图解析专家」，既不现实也违背开箱即用的初衷。

**下发什么**：Plane 维护一份「专业智能体目录」（初始内容从 Synlora 插件的提示词/方法论移植），每个目录项落到 SD 的两个既有对象上：

| SD 对象           | API                                                                                                                     | 用途                                                         |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| custom specialist | `POST /api/specialists`（name/description/instructions/connectorIds/enabledSkillIds）、`PUT /api/specialists/{id}`      | 专业智能体本体：人设 + 方法论写进 instructions               |
| 技能库（可选）    | `POST /api/skill-libraries` 建库、`POST /api/skill-libraries/{id}/versions` 发版；或 `POST /api/skills/import` 整包导入 | 方法论较长时单独成库，消息级用 skillLibraryRefs 钉住版本引用 |

**逐插件盘点**（依据 Synlora 插件目录源码，`apps/web/backend/catalog/plugins/`）：

| 插件                      | 构成                                                                                                                                                                                             | 判定                                                                                                                                                           |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **ars** 学术研究          | system_prompt + 4 个方法论技能（深度研究/论文写作/同行评审/端到端流水线，纯 SKILL.md + 参考资料），无自有工具——工具白名单全是 Synlora 内置通用能力（web 搜索、文件读写、python/shell、知识检索） | **纯提示词**：移植为 specialist + 技能库即可；其依赖的通用能力 SD 原生都有，零 MCP                                                                             |
| **spec_agent** 谱图解析   | 2 个技能（spec-nmr/spec-spectra）是提示词；但核磁正/反向预测与库检索是 HTTP 调用 Spec_Agent 服务，五类谱图异步解析（NMR/IR/GPC/Raman/LC-MS，上传→提交→轮询）是真实的 job 连接器                  | **混合**：技能走方法论移植；核磁工具与异步谱图解析走 MCP 反向供给                                                                                              |
| **poly_agent** 高分子预测 | 5 个工具全是 HTTP 调用 Poly_Agent 服务（Tg 预测/电解质配方/Raman 解析/共聚拟合/硅键评分），带账号密码自动登录                                                                                    | **全真实逻辑**：MCP 反向供给；凭证必须留在网关侧，不下发给学生                                                                                                 |
| **sciverse** 文献检索     | 语义/结构化检索与全文读取是调用公网 Sciverse API（Bearer token）                                                                                                                                 | **全真实逻辑：MCP 反向供给**。SD 内置的五连接器（pubmed/arxiv/europe-pmc/biorxiv/medrxiv）不含 Sciverse 语域，属增量来源——与 SD 原生文献检索并存互补，不是顶替 |

上表中带真实逻辑的三处（spec_agent 的核磁工具与谱图异步解析、poly_agent、sciverse），提示词移植救不了——其「工具」本质都是 httpx 客户端包装外部 HTTP 服务（AI⁴MS 内网服务或公网 Sciverse），不含计算本身。出路是 **MCP 反向供给**：SynlysAI 侧跑**一个 MCP 网关**，把这些 HTTP API 统一包装成 MCP 工具，用 SD 的 `POST /api/mcp/servers` 注册成自定义连接器，再让下发的 specialist 以 connectorIds 引用之——专业能力仍运行在 SynlysAI 侧，学生 SD 只是调用方。凭证（Poly_Agent 账号密码、Sciverse token）由网关集中持有、永不下发到学生 SD；网关只需一处连通上游，各学生 SD 只需连通网关（与 §5 同一个网络可达性前提），网络位置需同时连通两类上游——AI⁴MS 内网服务（10.26.15.93）与公网 Sciverse API，部署在校园内网即可兼得。实现上唯一要留意的点：spec_agent 的谱图解析是长耗时异步任务（上游 350 秒），包成 MCP 工具后是慢工具调用——SD 的 run 本来就异步，工具超时放宽即可。MCP 网关虽是独立于 Plane 的新增服务，但**已纳入本方案范围**（§13 P7），与 P6 的下发逻辑同期交付。

**何时下发**：幂等设计，两个触发时机任选或并用——(a) 学生在 §5 的配置界面点「测试连接」成功时；(b) 每次建会话前 BFF 核对目录版本，缺则补建、旧则更新。学生若误删了自己 SD 里的 specialist，下次检查自动重建——反正幂等，重建无副作用。

**怎么用上**：两条路，贴合 SD 的设计哲学（主 agent 自行分派专家）——

1. **主 agent 自行调度（推荐先做）**：不动会话配置，Plane 把节点上下文（如「这是实验数据节点，请考虑谱图解析方法论」）写进消息，SD 主 agent 通过 task 工具自行唤起对应 specialist——task 调用照 §7 对照表投影成工具卡，`subagent.*` 事件补充专家进度
2. **会话级指定**：建会话时按 Plane 节点类型传 `specialistId`（如研究计划节点 → 方案类 specialist），行为更可控，但更僵硬

**目录范围**：首期覆盖全部四个插件——ars 与 spec_agent 的技能走方法论移植；spec_agent 的核磁工具与异步谱图解析、poly_agent、sciverse 走 MCP 网关（P7；网关部署位置届时与网络规划一起定）。两点边界要认：目录由 Plane 侧人工维护，Synlora 插件升级不会自动同步过来；SD 内置的 8 个专家（文献检索、证据提取、代码工程、报告撰写等）本就覆盖科研主链路，这四个属于增量补齐。

## 11. 安全与治理

核心风险一句话：**SD 只认一把钥匙、不区分来客身份**。对策因此围绕两条线展开——钥匙只由 Plane 后端保管、SD 只待在内网；「谁在什么时候干了什么」全部由 Plane 侧的 Chain Event 记录（每条都带课题/节点/用户），相当于 SD 只管干活、Plane 负责门禁和登记：

| 风险                                     | 对策                                                                                                                                                                                                                              |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SD 单 token、无租户隔离                  | 用户级一人一 SD（§5）下天然消解——各用各的钥匙、数据、模型 key。token 只存 Plane 后端（credential_ref 模式，接口只回显「已配置」）；SD 不暴露公网（PRD 红线）                                                                      |
| 所有 Plane 用户在 SD 侧同一身份          | 用户级连接下不存在——一人一连接，SD 的 project/session 天然按学生分开（§5）                                                                                                                                                        |
| 学生自配后端引入 SSRF（借 BFF 探测内网） | 仅允许 http/https；域名解析出 IP 后限定私有网段 CIDR 白名单；显式拒绝云 metadata 地址与回环；仅放行 SD 已知的 `/api/` 路径前缀，不做通用代理；不跟随重定向（详见 §5）                                                             |
| 装配的工具白名单/persona 对 SD 失效      | SD 不认识 `allowed_tools`/`allowed_plugins`/persona（那是 Synlora 插件体系概念）。一期接受「SD 会话不受工具白名单约束」并在 UI/文档标注；用 SD 侧 `approvalMode`、skills、specialistId 近似控制；二期评估 SD per-session 工具策略 |
| 上游不可用                               | fail-closed（失败即关：上游一有问题就明确报错、进入降级态，而不是装作正常）——未配置/不可达都返回现有错误码 `AGENT_UPSTREAM_NOT_CONFIGURED`（不可达时消息写明「本地 SD 不可达」），前端走现成 degraded 态，不影响人工科研记录      |
| 长任务占用                               | 异步化（§6）+ run 超时与取消语义对齐（Plane `cancelRun` → SD `/runs/{id}/cancel`）                                                                                                                                                |

## 12. 与 PRD 的关系

PRD §6.2 写「Synlora 作为唯一云端通用 Agent Runtime，SD 是本地工作站」。本方案技术上不冲突（SD 仍在内网当工作站，Plane 课题标识 + Chain 留痕主线不变），但表述需更新：建议以「**runtime provider 扩展点**」立项，PRD 补一句「SD 可作为内网重型科研执行 runtime 经同一 BFF 契约接入」；§5 的用户级后端再补一句「成员可自助接入自有 runtime（需 workspace 治理开关放行）」，避免评审争议。

## 13. 实施计划

| 阶段                  | 内容                                                                                                                                                                |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **P0 验证**           | curl（命令行 HTTP 工具）脚本打通全链路：建 project/session → 发 run → 轮询 events 到终态 → 验证事件映射表；确认本机 5300 的 token、模型 profile、配额               |
| **P1 MVP**            | `ScienceDiscoveryClient` + 事件投影 + sendMessage 异步化 + provider 解析（开发期以环境变量直连测试 SD，正式入口随 P5 用户级连接上线）+ 前端自动轮询；不含审批、文件 |
| **P2 审批桥接**       | permission.required → 审批抽屉（三按钮：批准一次 / 批准并记住 / 拒绝）→ `/agent/approvals` 转发（枚举映射）                                                         |
| **P3 文件通道**       | Agent 界面附加文件 → BFF 转传 SD workspace + 哈希对账 + Chain Event                                                                                                 |
| **P4 产物与收尾**     | 产物内容代理端点 +「保存到节点」预填 + kind 映射表、节点上传双写（可选）、per-session modelId 钉住（可选）、PRD/运维手册更新、联调                                  |
| **P5 用户级后端**     | `ResearchAgentBackendConnection` 连接 CRUD + 测试端点 + 解析路由 + SSRF 校验 + 设置面板（§5）——用户级是学生接入 SD 的唯一正式入口                                   |
| **P6 专业智能体下发** | 目录维护（四个插件全量）+ specialist/技能库幂等下发 + 会话装配（§10）                                                                                               |
| **P7 MCP 网关**       | 新增服务：把 poly_agent / spec_agent 核磁工具与谱图异步解析 / sciverse 的上游 HTTP API 包装成 MCP 工具 + 凭证集中管理 + 部署联调（§10）                             |

**实施顺序建议**：P0 先行——映射表在真实事件流上验证过了，P1 之后都是照葫芦画瓢；SD 侧全程零代码改动。

## 14. 关键代码位置索引

> 这一节是给开发同学的导航地图（改哪些文件、参考哪些现有实现），非开发读者可跳过，不影响理解前文。

**Plane（改这里）**

- 新增 `apps/api/plane/research/services/sciencediscovery.py`（参照 `synlora.py`）
- 修改 `apps/api/plane/research/views/agent.py`（message 异步化、provider 分支、审批转发、产物代理端点）
- 修改 `apps/api/plane/research/services/chain_projection.py`（EVENT_TYPE_MAP 泛化）
- 修改 `apps/api/plane/research/services/agent_orchestrator.py`（provider 装配分支）
- 前端 `apps/web/core/components/research/agent/use-research-agent-session.ts`（自动轮询）；其余组件零改动
- 用户级后端（§5）：新增 `ResearchAgentBackendConnection` 模型 + 设置页 CRUD/测试端点（模型写法参照 `ExternalSystemConnection`，`apps/api/plane/db/models/research/integration.py`）；开发期调试可用 `apps/api/.env` 临时直连（`SCIENCE_DISCOVERY_BASE_URL` / `SCIENCE_DISCOVERY_AUTH_TOKEN`，仅测试环境）

**ScienceDiscovery（只读，不改）**

- 会话/运行：`services/api/src/http/index.ts`（POST /api/projects/{pid}/sessions、POST /api/sessions/{id}/runs、GET .../runs/{runId}/events）
- 事件 schema：`packages/schema/src/session.ts`（RunStreamEvent 联合类型，L405-472）
- 文件上传：`services/api/src/http/index.ts:2726`（workspace/upload，multipart + 配额）
- 模型管理：`services/api/src/http/index.ts:1926`（/api/models）+ `services/api/src/runs/index.ts:725`（无模型即 400）
- 审批：adapter `services/adapter/src/sciencediscovery_adapter/agent_runs.py:619`（POST /agent/approvals/{request_id}）
- 产物：`services/api/src/http/index.ts:3052`（`artifact-versions/{vid}/content` 返回字节流 + mediaType）、`:2981`（`/artifacts` 列表）、`:3059`（`/provenance` 溯源）
- 认证：`services/api/src/http/auth.ts`（单 Bearer token，timing-safe 比对）
- 专业智能体下发用的开放接口（§10，只读调用，不改）：`services/api/src/http/index.ts:1657`（specialist CRUD：GET/POST/PUT/DELETE）、`services/api/src/http/skill-libraries.ts:40`（技能库建库/发版）、`services/api/src/http/index.ts:1680`（`POST /api/skills/import` 整包导入）、`services/api/src/http/custom-mcp.ts:47`（`/api/mcp/servers` 注册自定义 MCP）

**SynlysAI（新增 MCP 网关，§10 / P7）**

- 包装对象：`apps/web/backend/catalog/plugins/{spec_agent,poly_agent,sciverse}/tools.py`（上游 HTTP 契约与调用参数即在此，照抄改写成 MCP tool handler）；spec_agent 异步任务另参照同目录 `connectors.py`（上传→提交→轮询→取结果）
- 注册入口：SD `POST /api/mcp/servers`（见上）；凭证管理参照 Synlora `config_store.py` 的加密落库模式

## 15. 遗留决策点（评审时定）

1. **模型归属**：默认「模型归 SD 管」（本方案，见 §2.3）；若团队要求所有 LLM 流量统一走 Plane 侧私有 OpenAI 兼容网关，需另行评估接入方式（不在本方案范围）
2. **快照存不存产物原件**：「摘要 + 引用」——快照只存摘要文本、指回 SD 原件，零额外成本，但原件随学生 SD 存亡；「内嵌内容」——产物字节一并存进 Plane（需加对象存储，成本上升），原件长期留存有保障。选哪个，取决于学校有没有科研数据原件的合规留存要求
3. **产物类型映射**：SD 的十类产物 kind 收敛到 Plane 六类快照类型的对照表（figure/html 等放不进的如何归属）——不要求评审本方案时定，推迟到开发进行到产物阶段（P4「产物与收尾」，见 §13）拿真实产物样本对照着定：归错类可改、不丢数据，也不阻塞前面任何阶段
4. **是否增设平台级（workspace 共享）SD 连接**：本方案只做用户级；若确有课题组想共享一台常开工作站（长任务要求机器常开，组内几人到十几人共用一台比人人笔记本更实际），可后续补一条 workspace 级连接——但共享单实例时数据、模型 key、配额全混（SD 单 token 无租户隔离），仅适合互信小团体，且需 Plane 全量留痕补偿；若做，还需定开放范围（全员/指定课题组）。大班集中算力不靠它解决——更干净的形态是一人一实例、各自走用户级连接
