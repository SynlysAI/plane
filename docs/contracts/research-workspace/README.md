# Research Workspace 跨系统契约

| 项目        | 内容                                               |
| ----------- | -------------------------------------------------- |
| 状态        | Stage RWS-0 草案，待联合评审冻结                   |
| 分支        | `ai-naive-workspace`                               |
| Schema 方言 | JSON Schema Draft 2020-12                          |
| 使用方      | Plane、Workspace Runner、Synlora、RAGPortal 适配层 |

本目录定义 AI-Native Research Workspace 的稳定跨系统对象。契约解决“固定输入是什么”和“运行绑定允许做什么”，不承载文件正文、密钥、长期下载地址或宿主路径。

## 文件

| 文件                                         | 用途                                       |
| -------------------------------------------- | ------------------------------------------ |
| `schemas/research-resource-ref.v1.json`      | Git、LFS、资产和遗留外部资源的固定引用     |
| `schemas/research-workspace-binding.v1.json` | Synlora 与 Workspace Runner 的短期运行绑定 |
| `schemas/research-dataset-manifest.v1.json`  | 不可变实验资产清单                         |
| `examples/*.json`                            | 最小合法示例                               |
| `error-codes.json`                           | 跨服务稳定错误码                           |

## 兼容规则

1. 消费者必须忽略未知字段，不得把未知字段当作授权扩张。
2. 新增字段必须可选；删除、重命名或收窄字段必须发布新主版本。
3. 枚举只能追加；读取端遇到未知值保留原值并映射为 `UNKNOWN` 展示。
4. `branch`、`main`、`latest` 只能用于浏览，不得用于审批、阶段封存或可复现输入。
5. `content_sha256`、`lfs_oid`、`blob_oid` 和 `sha256` 必须使用小写十六进制；对象存储 ETag 不能冒充 SHA-256。
6. 所有写请求必须由 Plane / Runner 侧继续携带幂等键；相同 payload 重放返回首次结果，不同 payload 返回 `RWS_IDEMPOTENCY_CONFLICT`。
7. 绑定对象不是授权本身；Synlora 收到后必须用短期凭据向 Plane / Runner 校验。
8. 本地路径、Git secret、S3 secret、原始 MCP token 和长期预签名 URL 不得进入契约对象。

## 评审清单

- [ ] Plane、Runner、Synlora 三方确认字段语义。
- [ ] 确认 Git SHA-1 / SHA-256 仓库兼容策略。
- [ ] 确认 `legacy_external` 只用于迁移期旧资料。
- [ ] 确认资产 manifest 的来源系统与来源运行 ID 字段。
- [ ] 确认错误码与 HTTP 状态映射。
- [ ] 为每个 Schema 添加契约测试和非法示例。

## 当前验证状态

2026-11-07 已完成：

- 全部 JSON 文件语法解析通过。
- 三份最小示例均通过 Draft 2020-12 Schema 校验。
- Git SHA 与内容 hash 的长度约束已由示例验证。

尚未完成：

- 未接入自动化契约测试。
- 未补充非法示例矩阵。
- 未由 Plane、Runner、Synlora 三方评审冻结。
