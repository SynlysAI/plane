# RWS-0 契约三方评审记录

| 项目     | 内容                                                                                        |
| -------- | ------------------------------------------------------------------------------------------- |
| 时间     | 2026-11-07                                                                                  |
| 评审对象 | `research-resource-ref.v1`、`research-workspace-binding.v1`、`research-dataset-manifest.v1` |
| 评审方式 | Plane / Workspace Runner / Synlora 三个消费视角工程评审                                     |
| 结论     | v1 工程冻结，进入 RWS-1 实现                                                                |

## 1. 机器校验

已完成：

- 三份 JSON Schema 语法合法。
- Draft 2020-12 validator 校验通过。
- 三份最小合法示例均通过对应 Schema。
- Git SHA-1 / SHA-256 长度兼容约束通过示例验证。
- 内容 hash 均要求小写 64 位 SHA-256。
- 绑定对象不包含 host path、Git token、S3 token 或原始 MCP token。

## 2. Plane 视角

| 检查点                                       | 结论 |
| -------------------------------------------- | ---- |
| `study_id`、`chain_id` 可映射 ResearchChain  | 通过 |
| Git / LFS / Asset / Legacy External 分型清晰 | 通过 |
| `repository_id` 复用仓库登记身份             | 通过 |
| `branch/latest` 未进入固定引用               | 通过 |
| 阶段材料可保存 immutable resource ref        | 通过 |
| `legacy_external` 仅限迁移期旧资料           | 通过 |
| 索引投影可以由 source digest 生成            | 通过 |

## 3. Workspace Runner 视角

| 检查点                                   | 结论 |
| ---------------------------------------- | ---- |
| Relative path 禁止绝对路径与 `..`        | 通过 |
| Commit 支持 40 / 64 位对象格式           | 通过 |
| LFS oid 与 content hash 分离             | 通过 |
| 资产 manifest 一项一 `asset_revision_id` | 通过 |
| Manifest 记录 size、media type、来源系统 | 通过 |
| `data_dictionary` 保持相对路径           | 通过 |
| 不携带长期下载地址                       | 通过 |

## 4. Synlora 视角

| 检查点                                          | 结论 |
| ----------------------------------------------- | ---- |
| Binding 绑定 study / chain / working copy / run | 通过 |
| Branch 限定 `agent/<run-id>`                    | 通过 |
| `base_commit` 必填且为完整 SHA                  | 通过 |
| `asset_manifest_digest` 必填                    | 通过 |
| Skills、MCP、镜像 digest 可固定                 | 通过 |
| Capabilities 是封闭枚举                         | 通过 |
| `grant_id` 仅作不透明服务端引用                 | 通过 |
| Issued / expires 时间必填                       | 通过 |
| 不包含宿主路径或长期凭据                        | 通过 |

## 5. 冻结决定

1. 三份契约进入 **v1 工程冻结**，RWS-1 可开始模型和 API 实现。
2. 新增字段必须可选，消费者必须忽略未知字段。
3. 删除、重命名、收窄字段或变更语义必须发布 v2。
4. 枚举只能追加，读取端遇未知值映射 `UNKNOWN`，不得丢弃记录。
5. 写请求幂等键由 Plane / Runner API 层补充，不在本三份资源对象内重复建模。
6. 错误码以 `error-codes.json` 为准。
7. RWS-1 实现中若发现字段缺失，先提出契约变更评审，不得私下扩展强字段。

## 6. 未覆盖项

- 尚未接入自动化契约测试。
- 尚未补充非法示例矩阵。
- 尚未由业务负责人签字确认字段命名。
- `legacy_external` 的来源系统枚举留待迁移脚本实现时评审。
