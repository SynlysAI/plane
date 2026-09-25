# Research Intelligent Platform 跨仓契约

本目录冻结 Phase 0 的跨仓库交换契约。所有契约均使用 `*.v1` 的稳定版本名，消费者必须忽略未知字段，新增字段默认可选；枚举只能追加值。删除或重命名字段、改变字段语义或收窄枚举必须发布新的主版本。

## 文件约定

- `schemas/*.json`：JSON Schema Draft 2020-12。
- `examples/*.json`：可直接作为 contract fixture 的最小合法示例。
- `error-codes.json`：Plane BFF、外部适配器和 Agent 运行统一错误码。
- `taxonomy.json`：节点、事件、快照、待办和降级状态字典。
- `research-capabilities.v1.json`：资源动作能力投影；每个动作都返回允许状态、稳定错误码和中文原因。
- `agent-context.v2.json`：Agent 的 OWNER/REVIEW scope、工具白名单和策略版本；REVIEW 只允许检索、读取、评论与分析草稿。

契约对象必须携带 `schema_version`（事件对象另以 `event_id` 幂等）。跨服务写请求必须携带 `request_id`；同一 `request_id` 与相同 payload hash 重放时返回首次结果，不同 hash 返回 `IDEMPOTENCY_CONFLICT`。

## 兼容性规则

1. 新增字段必须是可选字段，并提供服务端默认值。
2. 消费者不得因未知字段失败，也不得把未知字段复制到权限范围之外。
3. 枚举值只能追加；遇到未知值时，读取端保留原始值并映射为 `UNKNOWN` 展示，不得丢弃整条记录。
4. 生产者在至少一个完整发布周期内同时支持当前版本和上一个兼容版本。
5. 事件、快照和回调分别以 `event_id`、`snapshot_id` 和 `request_id` 幂等。
6. 任何正文、密钥和长期 token 都不属于这些跨仓元数据契约。

## 变更评审清单

- [ ] 是否只增加了可选字段或追加枚举值？
- [ ] 是否更新了 schema、示例、错误码/字典和兼容测试？
- [ ] 是否确认未知字段、未知枚举和重复请求的行为？
- [ ] 是否确认权限范围、脱敏和审计字段没有扩大？
- [ ] 是否提供迁移/回滚说明，并由所有消费者评审？
