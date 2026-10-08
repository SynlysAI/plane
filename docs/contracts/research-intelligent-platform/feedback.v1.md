# Plane 用户反馈契约 v1

## 边界

Plane 拥有完整的用户反馈闭环：反馈记录、截图、授权、筛选、状态流转和处置审计均保存在 Plane 内。反馈记录使用 Plane PostgreSQL 研究模型；截图复用 `FileAsset` 与 Plane S3 存储；审计使用 append-only `ResearchAuditEvent`。Plane 不调用 AI4MS Feedback API，AI4MS 也不是 Plane 的反馈后端或数据源。

AI4MS 继续独立维护其原有 Spec_Agent、Poly_Agent、SpecLabOS、RAGPortal 反馈体系。两套反馈体系不共享平台标识、身份映射、存储、管理端或发布依赖。

## 4.21 历史数据切换

4.21.0 曾短暂发布 Plane → AI4MS BFF。切换到本契约前必须在 Plane API 容器执行只读预检：

```bash
python manage.py import_research_feedback_from_ai4ms \
  --mongo-uri "$AI4MS_MONGO_URI" \
  --mongo-database "$AI4MS_MONGO_DB" \
  --workspace-slug "$PLANE_WORKSPACE_SLUG"
```

- 预检记录数为 0 时，保存 JSON 输出，可直接部署 Plane 本地闭环并发布 AI4MS 2.0.0 清理。
- 预检记录数大于 0 时，必须备份 Plane PostgreSQL/S3 与 AI4MS MongoDB/GridFS，再追加 `--execute` 执行幂等导入，并按[迁移 runbook](../../operations/research-feedback-ai4ms-migration.md) 核验记录数、截图数、状态历史和权限范围。
- 导入命令只读 AI4MS 源数据；迁移完成后也不删除或改写 AI4MS MongoDB。切换后新增反馈只能写入 Plane，不得反向同步。

## 数据与隐私

| 字段              | 规则                                                            |
| ----------------- | --------------------------------------------------------------- |
| `content`         | 1–5000 字，去除首尾空白后不能为空                               |
| `feedback_type`   | `bug` / `ux` / `idea` / `other`                                 |
| `path`            | 只保存 `urlsplit(path).path`，去除 query 与 fragment，最长 2048 |
| `browser`         | 最长 500 字                                                     |
| `module`          | 最长 100 字，默认 `plane`                                       |
| `screenshots`     | 每条 0–3 张，PNG/JPEG/WebP，每张 1 Byte–10 MB                   |
| `idempotency_key` | 16–128 字符；同键同负载返回原记录，同键不同负载返回 409         |

截图必须同时通过扩展名、MIME 与文件头校验。Plane 不采集页面正文、Cookie、Authorization、URL query 或 fragment。反馈正文和截图不写入测试证据或普通日志。

## 提交滥用边界

- 每个用户在每个工作区内最多成功提交 5 条反馈/小时；幂等重试命中原记录时不消耗次数。
- 活动截图存储投影上限为 100 MB/用户，计算范围包含当前用户在本工作区内未软删反馈的活动截图，并计入本次待上传文件。
- 同一用户同一工作区同时只允许一个反馈提交在途；并发请求返回 `research_feedback_busy`。
- Django cache 不可用时提交 fail-closed 返回 `research_feedback_storage_unavailable`，不得退化为无锁写入。
- 超限错误：`research_feedback_rate_limited` 返回 429，`research_feedback_storage_quota_exceeded` 返回 413。

## API

所有路径均位于 Plane 同源 API 下：

| 方法与路径                                                                       | 说明                                                         |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `POST /api/research/workspaces/{slug}/feedback/`                                 | multipart 提交反馈与截图，成功返回 `{code:0,data:record}`    |
| `GET /api/research/workspaces/{slug}/feedback/`                                  | 本人或管理分页查询，返回 `data.results/count/page/page_size` |
| `PATCH /api/research/workspaces/{slug}/feedback/{id}/status/`                    | 管理处置，必须提供 1–2000 字说明，返回更新后的完整记录       |
| `GET /api/research/workspaces/{slug}/feedback/{id}/screenshots/{screenshot_id}/` | 受控读取截图流，`private,no-store` 且 `nosniff`              |

列表筛选支持 `feedback_type`、`status`、`module`、`q`、`date_from`、`date_to`、`page` 和 `page_size`。默认页大小 20，最大 100。反馈和截图 ID 均为 Plane UUID。

## 权限与状态

- 普通工作区成员可提交反馈，并仅能查看本人的反馈和截图。
- 主 PI 按 `managing_org_units_for` 解析出的组织树查看和处置；即使兼任工作区管理员，也不因此扩大为全工作区。
- 工作区管理员和平台管理员查看并处置当前工作区反馈。

状态值为 `open`、`in_progress`、`done`、`closed`。每次状态变更在同一数据库事务中锁定反馈行，并追加包含操作者快照、前后状态、处理说明和时间的审计事件。本轮不提供删除接口；反馈和截图按本契约长期保留，未来如需擦除或保留期策略须另立兼容设计。

## 存储与通用资产边界

截图登记为 `FileAsset.EntityTypeContext.FEEDBACK_SCREENSHOT`，对象键位于工作区研究命名空间下，并由 `ResearchFeedbackScreenshot` 保存顺序和归属。Plane 通用资产接口（workspace/project/user、legacy file-assets 与 duplicate-assets）不得创建、读取、修改、删除或恢复反馈截图，避免绕过反馈专属路由。

部署备份必须同时覆盖 Plane PostgreSQL 数据库和 S3 bucket。S3 失败或数据库登记失败时，提交返回受控 503，不留下反馈半成品；已上传但未完成登记的新对象会尽最大努力清理，清理失败只记录对象键和异常类型告警。浏览器不接收 S3 签名 URL，截图经 Plane API 流式返回。

`FileAsset.attributes.sha256` 与 `storage_metadata.SHA256` 保存截图内容哈希，仅用于幂等导入与完整性核对；公开截图响应仍只暴露 id、MIME 和大小。列表、幂等命中、配额和截图读取均排除软删反馈/截图登记，避免未来保留期策略复活已删数据。

`FEEDBACK_SCREENSHOT` 对 Plane 通用资产接口完全独占：通用创建/预签名上传、复制、下载、修改、删除和恢复均返回拒绝；唯一读取路径是本文的反馈截图端点。该规则避免伪造反馈资产、孤儿对象和可复用 S3 签名 URL。
