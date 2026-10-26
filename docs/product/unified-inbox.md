# Plane 统一 Inbox 通知中心

## 目标

统一 Inbox 将右上角入口升级为所有“需要用户注意或处理”的事项中心。它同时承接：

- @ 提及与评论事件
- 工作项、科研任务、报告、评审和审批事件
- 科研待办的当前处理状态
- 即将截止、今天截止、逾期和催办提醒
- 系统公告与系统提示

## 核心口径

### 数据来源

- 事件继续写入 `Notification` 表。
- 待办继续由 `research-todo.v2` collector 实时投影。
- Inbox API 将两类来源合并为统一的 `inbox.v1` item。
- `InboxTodoState` 只保存每个接收人的已读、归档、稍后提醒和提醒指纹，不复制业务字段。

### 红点

右上角红点等于：

```text
未读通知 + 新增或发生变化的待办 + 新提醒 + 未读系统公告
```

不包括：

- 已读但未完成的待办
- 已归档通知
- 未到期的稍后提醒
- 已完成、取消或删除的对象

### 已读与完成分离

- 点击 Inbox 待办：只写入 `InboxTodoState.read_at`。
- 点击“全部已读”：只清空红点。
- 待办完成：仍由业务动作驱动；完成后 collector 不再投影该待办。
- Inbox 已读不会影响“我的待办”页面的业务状态。

## API

### 列表

```http
GET /api/workspaces/{workspace_slug}/users/inbox/
```

常用参数：

| 参数       | 说明                                                         |
| ---------- | ------------------------------------------------------------ |
| `tab`      | `all`、`mentions`、`todos`、`approvals`、`reviews`、`system` |
| `read`     | `all`、`true`、`false`                                       |
| `archived` | 是否查看归档桶                                               |
| `snoozed`  | 是否查看稍后提醒桶                                           |
| `per_page` | 每页数量，最大 100                                           |
| `cursor`   | 下一页游标                                                   |

### 未读数

```http
GET /api/workspaces/{workspace_slug}/users/inbox/unread/
```

列表和红点使用同一投影过滤条件，避免“页面有数据但红点不一致”。

### 单项操作

```http
POST /api/workspaces/{workspace_slug}/users/inbox/items/{item_id}/{action}/
```

`action` 支持：

- `read`
- `unread`
- `archive`
- `unarchive`
- `snooze`

`snooze` 请求体可携带 `snoozed_till`。

### 全部已读

```http
POST /api/workspaces/{workspace_slug}/users/inbox/mark-all-read/
```

该操作只更新通知和 Inbox 展示状态，不修改任何科研业务对象。

## 提醒

Celery beat 每 30 分钟执行：

```text
plane.bgtasks.inbox_reminder_task.generate_workspace_inbox_reminders
```

提醒规则：

- `DUE_SOON`：进入 72 小时区间后每个截止日期提醒一次
- `DUE_TODAY`：每天一次
- `OVERDUE`：每天一次
- `NORMAL` 或无截止时间：不提醒

提醒通过稳定键去重：

```text
todo:{source}:{object_id}:reminder:{reminder_type}:{date}
```

提醒不会生成重复列表项，只会把对应待办重新置为未读。归档待办和未到期的稍后提醒不触发。

## 前端行为

- 右上角 Inbox 图标显示统一未读数。
- 点击图标打开最近 8 条的轻量弹层。
- 弹层提供“全部已读”和“查看全部”。
- `/notifications/` 使用同一 Inbox API，提供列表 + 详情布局。
- 标签包含：全部、@ 我、待办、审批、评审、系统。
- 前端每 45 秒轮询，页面聚焦和操作完成后立即刷新。
- 点击弹层条目会标记已读并跳转来源；完整页点击条目只选中详情并标记已读。

## 部署与迁移

1. `InboxTodoState` 由数据库迁移创建。
2. 迁移会把存量开放待办初始化为已读，不产生历史未读红点。
3. 迁移后新增、重新指派、退回、截止时间变化或下一步动作变化的待办才产生未读。
4. Web 需要重新构建；API、worker 和 beat 需要重建以加载新接口与提醒任务。
