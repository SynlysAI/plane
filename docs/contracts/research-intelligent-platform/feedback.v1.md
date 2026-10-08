# AI4MS / Plane 反馈契约 v1

AI4MS 保存唯一权威记录和 GridFS 截图；Plane 仅 BFF 代理，无反馈副本。旧 `/api/v1/feedback` 继续接受 Spec_Agent / Poly_Agent 等原平台；Plane 使用专用 `/api/v1/plane-feedback`。

## 认证

Plane 后端配置 `AI4MS_FEEDBACK_BASE_URL` 与独立 `AI4MS_FEEDBACK_SECRET`；AI4MS 配置相同 `PLANE_FEEDBACK_SECRET`，至少 32 字符，禁止与门户 `AUTH_SECRET` 共用。凭据不进入浏览器。

请求头：`X-Plane-Timestamp`、`X-Plane-Nonce`、`X-Plane-Principal`（URL-safe base64 JSON）、`X-Plane-Signature`。

签名材料以换行连接：HTTP 方法、路径及编码后查询、时间戳、nonce、完整身份头、实际请求体 SHA-256。HMAC-SHA256 输出 hex。时间差最多 60 秒，MongoDB nonce 唯一索引与 TTL 防重放；重试须重新签发 HMAC，保留反馈幂等标识。

身份字段：`workspace_id`、`user_id`、`username`、`org_unit_id`、`scope=self/org/workspace`、`org_unit_ids`、`permissions=submit/read/manage`。组织归属只从 Plane 有效关系取值；历史记录不推测归属。

## 端点

| AI4MS 端点                            | 请求与结果                                                                                                                          |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/v1/plane-feedback`         | multipart：`payload` JSON 和最多 3 个 `screenshots`；正文 1–5000 字，分类 bug/ux/idea/other，path、browser、module、idempotency_key |
| `GET /api/v1/plane-feedback`          | page/page_size、分类、状态、module、q、date_from/date_to；响应 `data.results/count/page/page_size`                                  |
| `GET /{feedback_id}/screenshots/{id}` | 同记录范围鉴权，返回图片，private/no-store/nosniff                                                                                  |
| `PATCH /{feedback_id}/status`         | `status` 与非空 `comment`；原子记录操作者、前后状态、说明、时间                                                                     |
| `DELETE /{feedback_id}`               | 管理授权显式删除，并清理 GridFS 截图                                                                                                |

Plane 同源代理位于 `/api/research/workspaces/{slug}/feedback/`，查询 `scope=manage` 使用组织树/工作区管理授权；默认只本人。普通用户不能处置，主 PI 按所属组织树（即使兼任工作区管理员），平台管理员查看当前工作区全部 Plane 反馈。截图读取与状态处置使用同一范围条件。

状态保留 `open`（待处理）、`done`（已解决），追加 `in_progress`（处理中）、`closed`（已关闭）。截图每张最多 10 MB，只接受真实 PNG/JPEG/WebP，实际解码校验，不信任客户端 MIME。唯一幂等索引绑定工作区、提交人和幂等 key；相同内容重试复用记录，不同内容返回 409。

只收集去掉 query/fragment 的路径和浏览器信息，不采集页面正文或认证凭据。上游失败返回受控 503，表单和截图保留供重试。截图长期保留；备份需同时包含 `feedbacks`、`feedback_screenshots.files` 和 `feedback_screenshots.chunks`，并与元数据保持同一时间点。
