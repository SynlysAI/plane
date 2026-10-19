# 工作项评论附件

普通项目的工作项评论支持附加 PPTX、PDF 等过程文件。工作项完成后仍可追加评论，文件随评论出现在活动时间线中。

## 使用方式

- 在评论工具栏点击「附加文件」，可一次选择多个文件，每条评论最多 10 个文件。
- 单个文件大小沿用实例设置，文件类型沿用现有附件白名单。原有图片入口继续用于内嵌图片。
- 可以只发文件，也可以同时填写说明。上传中或存在失败文件时不能提交；失败文件可重试或移除。
- 编辑评论时可以追加、移除文件。保存成功后生效；取消保留原附件，仅清理新增上传。
- 提交失败保留当前文字与附件。评论已创建、图片关联失败时，重试更新同一条评论。

## 接口约定

项目资产上传接口增加 `COMMENT_ATTACHMENT` 类型；`entity_identifier` 必须是当前项目的工作项 ID。上传复用「获取预签名地址 → 上传对象 → 确认上传」流程，确认前不能关联评论。

工作项评论创建和更新接口支持可选的 `attachment_ids: string[]`。创建时关联已完成上传的本人临时文件；更新时允许保留当前评论已有文件，并加入本人临时文件。省略字段保持附件，空数组清空附件；评论正文与附件不能同时为空。原有 `attachments` 字段保留兼容。

响应增加 `file_attachments` 数组，包含 `id`、`name`、`type`、`size` 和 `download_url`。下载地址是需要认证的稳定 API 地址，服务端临时生成对象存储下载地址，不将预签名地址持久化到评论。

关联和移除在数据库事务中完成。临时文件仅上传者可读；已发布文件沿用评论的项目访问范围，底层资产接口不能直接删除已发布附件。移除附件、删除评论后停用文件；未发布文件默认 7 天后由现有任务回收。

本功能复用已有资产表及 `comment`、`issue` 关联，无数据库结构迁移。科研链任务评论、描述区附件活动展示不在本次修改范围。

## 验证

- 前端：`pnpm --filter web test:components tests/components/comment-attachments.test.tsx tests/components/comment-attachment-forms.test.tsx tests/components/comment-editor-enter.test.tsx tests/components/comment-store.test.ts tests/components/research-task-comments.test.tsx`。
- 后端：`plane/tests/contract/app/test_issue_comment_attachments.py`，覆盖上传白名单、任务范围、原子保存、权限、删除及过期清理；使用独立测试 PostgreSQL，禁止连接业务数据库。
- 浏览器：启动现有浏览器测试配置，访问 `comment-attachments.fixture.html`。页面使用真实评论组件和编辑器，以本地存储替换持久化边界，可验证上传、刷新、编辑取消、模拟提交失败、回车提交和移动端布局；不代表生产对象存储联调。
- 遵守仓库约束，不启动或构建 Docker 测试栈。
