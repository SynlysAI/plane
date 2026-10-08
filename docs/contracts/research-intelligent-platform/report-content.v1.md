# 正式报告内容契约 v1

普通 `context/` 和 `context/resources/` 元数据接口保持兼容。新增内容接口仅返回授权的固定正式版本。

| 接口                                                                       | 语义                                                                                         |
| -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `GET /api/research/workspaces/{slug}/formal-reports/?chain_node_id={id}`   | 列出当前课题关联、调用方可见的正式报告：`report_id`、`version_no`、`title`、`characters`     |
| `POST /api/research/workspaces/{slug}/context/exchange-token/`             | 原请求追加可选 `reports: [{report_id, version_no}]`；选择纳入 Context 哈希及持久授权         |
| `GET /api/research/workspaces/{slug}/context/{context_id}/report-content/` | 会话或 Context token 鉴权；检查工作区、用户、课题可见性、报告 ACL、撤销/过期、哈希及版本变化 |
| Agent 消息接口                                                             | 可选 `reports`，Plane BFF 逐次校验后把固定正式文本附来源/版本标记传给既有 Synlora 消息接口   |

响应 `reports` 每项包含 `report_id`、`version_no`、`title`、`source=plane`、`source_url`、正式快照 `html`/`text`、`attachments`、`images`。附件 manifest 追加 `parsed=false`、`scan_status=not_scanned`，办公二进制不注入模型。正文总量最多 50,000 字符；超限返回 `report_context_too_large`，提示调整选择。

正文不从当前 Page 草稿读取。正式版本变更返回 `report_context_version_changed`，禁止静默切换。无关联报告返回 `report_context_denied`；草稿没有正式快照。没有项目的报告须先通过团队课题引用关联，再出现在选择器。失败保留消息和选择，界面显示具体原因。

## 正文图片

`POST reports/{report_id}/images/` 申请直传；`POST images/{asset_id}/` 实际读取 S3 大小、MIME 与文件头后登记；`GET` 重新检查报告 ACL；`DELETE` 仅移除草稿标记。只支持 JPEG、PNG、WebP、GIF。图片使用 `FileAsset.REPORT_IMAGE`，不进入附件表。

保存和提交拒绝跨报告资源、未完成上传与已移除图片；HTTP(S) 远程图片仍可引用。提交冻结 `image_manifest`，草稿移除不删除被正式快照引用的文件。通用资产读取复用报告 ACL，通用修改禁止操作正文图片。
