# 账号与密码恢复

## 目标与验收

- 无 SMTP 时，登录页提供“联系管理员重置”，展示人工核验说明和可复制的求助信息。
- 管理员联系邮箱为 `fangyikai@xmu.edu.cn`，点击后通过本机邮件应用撰写；不会在站内自动提交申请。
- 忘记登录邮箱时，通过既有联系渠道提供姓名、课题组等信息，由管理员在成员列表核对。
- 管理员在“工作区设置 → 成员”中核验身份、验证自己的密码后，为普通成员生成临时密码。
- 临时密码仅在本次响应中展示，不写入导入报告或审计记录；重置撤销现有会话，下次登录必须修改密码。
- 密码属于实例账号，跨工作区生效。工作区管理员不能重置任何工作区管理员、实例管理员、系统账号或自身。
- 实例管理员仍须具有当前工作区管理员席位，才能使用该工作区入口；可处理其他管理员账号。

## 接口与实现位置

`POST /api/workspaces/{slug}/members/{user_id}/reset-password/`

请求：`{"current_password": "当前操作者的密码"}`。

响应：`{"temporary_password": "本次生成的临时密码"}`，设置 `Cache-Control: no-store`。

路径中的 `user_id` 是用户 ID，与既有成员编辑接口使用的工作区成员记录 ID 不同。

- 后端：`apps/api/plane/app/views/workspace/password_reset.py`。
- 登录恢复：`apps/web/core/components/account/auth-forms/`。
- 管理入口：`apps/web/core/components/workspace/settings/`。
- 沿用 Django 密码哈希、Plane 工作区权限和首次登录改密机制；使用 CSRF 验证和认证限流。
- 新函数使用中文功能注释，UI 沿用项目样式及 `academic-editorial-ui` 规范。

## 验证与边界

前端组件测试覆盖入口、核验、生成结果、失败重试和关闭后清除。后端测试覆盖普通成员拒绝、跨工作区拒绝、管理员账号保护、密码校验、会话撤销和审计脱敏。

```bash
pnpm --filter web exec vitest run tests/components/account-password-recovery.test.tsx tests/components/workspace-password-reset.test.tsx
pnpm --filter web check:types
```

后端数据库测试由部署者按仓库测试约定运行；本任务不启动或构建 `docker-compose-test.yml`。不配置真实邮箱凭据、不发送真实邮件、不修改任何现有账号密码、不部署。

2026-10-19 验证：后端不连接数据库的独立测试 9 项通过，覆盖真实密码哈希、权限装饰器、CSRF、登录态限流及日志脱敏；前端相关测试 8 项通过。桌面及 390px 手机宽度已验证联系入口和重置弹窗；弹窗使用替身服务展示临时密码，未请求真实重置接口。完整数据库契约测试尚未运行。主工作区的全量类型检查曾受同期其他改动影响；提交前导出独立提交内容，重新构建类型和常量包，并固定到该提交的声明文件后，TypeScript 检查通过。

## SMTP 配置

未配置 SMTP 时不能通过邮件自助重置，仍可由管理员重置。忘记登录邮箱也须人工核验，邮件重置只能恢复密码。

推荐接入已有邮箱或邮件服务商的 SMTP，不必单独搭建邮件服务器。实例管理员打开管理后台的“Email”页面（通常为 `/god-mode/email/`），开启邮件功能，按邮箱服务商提供的参数填写：

| 页面字段               | 配置键                            | 填写内容                                                |
| ---------------------- | --------------------------------- | ------------------------------------------------------- |
| Host                   | `EMAIL_HOST`                      | 邮箱服务商提供的 SMTP 主机地址                          |
| Port                   | `EMAIL_PORT`                      | 常用 `587`（STARTTLS）或 `465`（SSL），以服务商文档为准 |
| Sender's email address | `EMAIL_FROM`                      | 经过授权的发件邮箱                                      |
| Username               | `EMAIL_HOST_USER`                 | 通常为完整邮箱地址                                      |
| Password               | `EMAIL_HOST_PASSWORD`             | SMTP 授权码、应用密码或服务商指定的凭据                 |
| Email security         | `EMAIL_USE_TLS` / `EMAIL_USE_SSL` | STARTTLS 选择 TLS；隐式 TLS 选择 SSL，两者不能同时启用  |

保存后点击“Send test email”，确认邮件实际收到，再测试一次忘记密码。`EMAIL_HOST` 非空只表示已填写配置，不代表服务可达或发送成功；实际重置邮件还依赖后台 worker、消息队列及正确的站点对外地址。

项目默认 `SKIP_ENV_VAR=1`，邮件参数优先读取数据库中的实例配置，建议使用管理后台配置。仅修改 `.env` 可能被数据库配置覆盖。若明确使用 `SKIP_ENV_VAR=0`，才通过环境变量管理下列内容，并确保 API、worker 读取一致配置：

```dotenv
EMAIL_HOST=smtp.example.com
EMAIL_PORT=587
EMAIL_HOST_USER=noreply@example.com
EMAIL_HOST_PASSWORD=<邮箱服务商提供的凭据>
EMAIL_FROM=noreply@example.com
EMAIL_USE_TLS=1
EMAIL_USE_SSL=0
ENABLE_SMTP=1
```

已有支持 SMTP 的邮箱时只需填写上述参数；主要准备工作是开通 SMTP、申请授权码，并确保服务器可以访问对应的出站端口。这里的管理员联系邮箱不要求同时作为 SMTP 发件邮箱。厦大邮箱的服务器地址、端口及授权策略须以学校信息中心提供的配置为准。

参考：Plane 官方文档“Configure SMTP for email notifications”，路径 `developers.plane.so/self-hosting/govern/communication`。
