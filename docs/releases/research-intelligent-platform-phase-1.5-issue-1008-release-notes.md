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
