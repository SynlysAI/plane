# 科研智能平台 Phase 1.5：1008 反馈发布说明

## 本次交付

- 报告列表默认加载当前用户有权查看的全部报告；“仅看我的”改为显式筛选，并保留 URL 筛选回放。
- 报告和科研项目创建表单移入独立对话框，列表工具栏只保留浏览与筛选控制。
- 报告附件支持 PDF、Markdown、图片、DOC/DOCX、XLS/XLSX、PPT/PPTX、CSV/TSV；办公文件按工作区大小限制、扩展名、MIME 与文件头签名校验。
- 平台设置增加办公附件大小限制，默认 50 MB；正式报告快照、附件 ACL 与 Agent Context 既有语义保持不变。

## 验证

- Web 组件回归：`research-project-list-query`、`research-platform-settings-form`，共 10 项通过。
- Web 目标文件格式检查、OxLint 和 `@plane/types` 类型检查通过。
- API 研究模块代码完成 Python 编译检查；当前执行环境缺少 `celery`，Django pytest 未能启动，需在完整 API 测试容器中补跑。
- 已按正确性、可读性、架构、安全和性能五个维度完成 review，并补充 Office 文件签名负例测试。

## 回滚与后续

- 回滚可依次反向应用本轮阶段 commit，并执行 Django migration 回退 `0162_research_office_attachment_limits`；不涉及已有报告数据删除。
- 反馈提交/管理闭环、统一 PersonSelect、成果独立视图和跨仓 `/api/v1/feedback` 契约仍按 1008 计划后续阶段实施，当前未伪称完成。

---

# 4.21.0：1008 问题补齐发布说明

## 本次交付

- 报告详情收敛为「报告正文 + 附件」两个主区域，正文统一复用 `DocumentEditor` 可视化编辑；支持插入本地 JPEG/PNG/WebP/GIF 正文图片（选择、粘贴、拖放），可预览、调整尺寸、替换和删除，并保留 HTTP(S) 远程图片。
- 报告正文图片使用 FileAsset 与 S3 独立接口；提交时冻结图片资源清单，退回后删除草稿图片不影响已提交快照引用，通用资产路由执行相同权限检查。
- Markdown 导入同步更新 JSON、HTML 与编辑器二进制状态，不再出现导入后旧内容显示；正文有未保存修改时先确认再替换。
- 附件登记改为读取 S3 真实对象并校验文件头与 Office 容器内部结构，伪造 MIME 或非法内容的对象会被拒绝。
- 报告与成果提供同页双视图和各自筛选；科研项目与研究链支持人员搜索、关键词、日期预设、范围筛选、服务端分页，筛选与分页状态进入 URL 并支持回放，旧请求晚返回时不会覆盖新结果。
- Agent 新增受控正式报告内容接口：固定版本正文、附件清单、来源与版本展示；所选报告 ID 与正式版本纳入授权与哈希，逐次校验 ACL、撤销、过期与版本变化，正文上限 50,000 字符，办公二进制仅列元数据不注入模型。
- 新增 AI4MS 与 Plane 跨仓反馈闭环：Plane 通过后端 BFF 以服务端 HMAC 调用 AI4MS；反馈支持描述、分类、路径、浏览器信息与最多 3 张 PNG/JPEG/WebP 截图（每张 10 MB），存储于 AI4MS MongoDB GridFS；普通用户查看本人反馈，主 PI 按组织树管理，管理员看全工作区；状态为待处理/处理中/已解决/已关闭并记录审计。
- `docs/` 按职责重组为 `product/`、`plans/`、`architecture/`、`contracts/`、`operations/`、`releases/`、`archive/`、`assets/`、`evidence/`；全部迁移使用 `git mv` 并修复引用，迁移映射见 `docs/README.md`。

## 配置与迁移

- Plane 后端新增 `PLANE_FEEDBACK_BASE_URL`、`PLANE_FEEDBACK_SECRET`（HMAC 密钥，勿与门户管理员令牌混用）；AI4MS 后端新增 `PLANE_FEEDBACK_SECRET` 与 MongoDB GridFS 截图库配置，参见双方 `.env.example`。
- Django 迁移顺序：`0163_report_image_snapshots` → `0164_formal_report_context`；AI4MS 首次运行自动建反馈集合索引（提交人+时间、范围+状态、幂等 nonce）。
- 两仓部署顺序：先部署 AI4MS 后端（反馈 API），再部署 Plane API 与 Web（BFF 与界面）；旧 Spec_Agent/Poly_Agent 提交与门户反馈管理页保持兼容。

## 验证

- Plane Web 组件全量测试：39 个文件、148 项通过。
- Plane API：报告与附件隔离容器回归 90 项；科研浏览契约 13 项与 URL/请求顺序 6 项；Agent 与既有授权 40 项；反馈 BFF 与浏览 26 项。
- AI4MS 后端：真实隔离 MongoDB/GridFS 测试 8 项，覆盖 HMAC、截图、幂等、本人查询、组织隔离与四状态审计。
- 文档迁移后本地链接检查：279 个链接，无新增断链。

## 回滚与后续

- 回滚 Plane 时反向应用本轮 commit 并依次回退 `0164`、`0163` migration；已上传正文图片与附件对象保留在 S3，可按 FileAsset 记录清理。
- 回滚 AI4MS 反馈闭环不影响既有 Spec_Agent/Poly_Agent 简式提交；GridFS 截图随反馈删除清理。
- 病毒扫描与 Office/PDF 文本解析仍是后续依赖：当前界面对办公附件明确显示未扫描、未解析，不宣称已送入模型。
