# Research Intelligent Platform 跨仓契约

本目录冻结跨仓库交换契约。当前 Plane 代码版本为 `4.15.1`；Phase 0 的 `*.v1` 契约继续兼容，Phase 1 的 `agent-context.v2`、能力投影和 Agent OWNER/REVIEW scope 已进入当前实现。消费者必须忽略未知字段，新增字段默认可选；枚举只能追加值。删除或重命名字段、改变字段语义或收窄枚举必须发布新的主版本。

## 文件约定

- `schemas/*.json`：JSON Schema Draft 2020-12。
- `examples/*.json`：可直接作为 contract fixture 的最小合法示例。
- `error-codes.json`：Plane BFF、外部适配器和 Agent 运行统一错误码。
- `taxonomy.json`：节点、事件、快照、待办和降级状态字典。
- `research-capabilities.v1.json`：资源动作能力投影；每个动作都返回允许状态、稳定错误码和中文原因。
- `agent-context.v2.json`：Agent 的 OWNER/REVIEW scope、工具白名单和策略版本；REVIEW 只允许检索、读取、评论与分析草稿。
- `examples/error-codes.v1.json`：当前实现使用的 `KB_NOT_READY`、`KB_SCOPE_CONFLICT` 和 `AGENT_SCOPE_INVALID` 等稳定错误码示例。

契约对象必须携带 `schema_version`（事件对象另以 `event_id` 幂等）。跨服务写请求必须携带 `request_id`；同一 `request_id` 与相同 payload hash 重放时返回首次结果，不同 hash 返回 `IDEMPOTENCY_CONFLICT`。

## 兼容性规则

1. 新增字段必须是可选字段，并提供服务端默认值。
2. 消费者不得因未知字段失败，也不得把未知字段复制到权限范围之外。
3. 枚举值只能追加；遇到未知值时，读取端保留原始值并映射为 `UNKNOWN` 展示，不得丢弃整条记录。
4. 生产者在至少一个完整发布周期内同时支持当前版本和上一个兼容版本。
5. 事件、快照和回调分别以 `event_id`、`snapshot_id` 和 `request_id` 幂等。
6. 任何正文、密钥和长期 token 都不属于这些跨仓元数据契约。

## 当前实现约束

- 课题创建或项目创建会生成一对一的知识库申请；申请未回填为 `READY` 前，上传接口必须返回 `KB_NOT_READY`。
- 一个外部知识库只能绑定一个研究链；重复绑定返回 `KB_SCOPE_CONFLICT`。
- `OWNER` scope 按课题成员权限执行；`REVIEW` scope 面向直接导师和主 PI，只允许知识检索、文件读取、评论和分析草稿，不允许节点生命周期写入、正式报告覆盖、上传或外部引用确认。
- Plane 只保存能力投影和策略版本，不复制 Synlora 运行时注册表；错误响应统一使用稳定错误码，不返回裸 `detail`。

## 变更评审清单

- [ ] 是否只增加了可选字段或追加枚举值？
- [ ] 是否更新了 schema、示例、错误码/字典和兼容测试？
- [ ] 是否确认未知字段、未知枚举和重复请求的行为？
- [ ] 是否确认权限范围、脱敏和审计字段没有扩大？
- [ ] 是否提供迁移/回滚说明，并由所有消费者评审？
