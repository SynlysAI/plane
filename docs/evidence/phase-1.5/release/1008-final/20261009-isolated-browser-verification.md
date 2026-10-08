# 2026-10-09 1008 收尾隔离浏览器验证

## 环境与数据边界

- Plane Web：`127.0.0.1:3020`，代理到隔离 API `127.0.0.1:8002`。
- Plane 数据：独立 PostgreSQL 数据库 `plane_browser_1008` 与 Redis DB 4；工作区 `browser1008`，账号、组织、课题、模板、成果和反馈均为合成数据。
- AI4MS：独立 API `127.0.0.1:8003`、Web `127.0.0.1:5174`、MongoDB `ai4ms_browser_1008`；`platform=plane` 历史记录仅作为隔离源数据。
- 截图不包含真实 `public` π-Lab 数据、密码、Token、Cookie、URL query 或完整邮箱。

## Plane 结果

| 场景                          | 结果                                                                                                                                   | 证据                                                                                |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| 学生提交带 PNG 截图的缺陷反馈 | `POST /feedback/` 200；本人列表 1 条；专属截图流 200，图片为 640×360 合成图                                                            | [`student-feedback-screenshot.png`](./20261009-student-feedback-screenshot.png)     |
| 普通成员直达反馈管理页        | 显示“没有反馈管理权限”；未发起 `scope=manage` 请求                                                                                     | [`member-feedback-permission.png`](./20261009-member-feedback-permission.png)       |
| 主 PI 查看并处置反馈          | `GET /feedback/?scope=manage` 200；`PATCH /feedback/{id}/status/` 200；`open → in_progress` 与说明进入历史                             | [`pi-feedback-management.png`](./20261009-pi-feedback-management.png)               |
| 成果按发表/授权日期筛选       | URL `outcome_date_from=2026-10-02&outcome_date_to=2026-10-04`；列表仅显示 `published_at=2026-10-03` 的成果                             | [`outcome-published-date-filter.png`](./20261009-outcome-published-date-filter.png) |
| 报告创建选择模板              | 模板列表 `GET /report-templates/?report_type=WEEKLY` 200；选择 `Browser weekly template` 后 `POST /reports/` 201；详情正文显示模板内容 | [`report-template-detail.png`](./20261009-report-template-detail.png)               |

## AI4MS 结果

- 自有反馈列表仅显示 `Spec_Agent`、`Poly_Agent`、`RAGPortal` 三条合成记录，四态 `open / in_progress / closed` 与处置历史可见。
- 详情弹窗可选择四态并填写处置说明；`platform=plane` 历史记录未出现在列表，也不能通过管理端修改。
- 证据：[`ai4ms-four-state-feedback.png`](./20261009-ai4ms-four-state-feedback.png)。

## 控制台与网络

- 修复侧边栏拖拽把手嵌套按钮后，Plane 与 AI4MS 验证页面控制台错误为 0。
- Vite dev server 仍有 Node 兼容性、MobX strict-mode 与 Canvas readback 开发警告；未出现业务 4xx/5xx 或渲染错误。
- Plane 记录的意外路径仅包括一次修复前的模板列表 403 和一次未加载 S3 配置时的反馈 503；对应修复后复验均为 200。
