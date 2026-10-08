# 4.21 AI4MS 反馈数据迁移 Runbook

## 目标与边界

- 本 runbook 只处理 4.21.0 短暂 Plane → AI4MS BFF 架构产生的 `platform=plane` 历史反馈。
- AI4MS MongoDB/GridFS 是只读源；本命令不删除、不更新、不反向同步源数据。
- Plane PostgreSQL `ResearchFeedback`/`ResearchFeedbackScreenshot`/`ResearchAuditEvent` 与 Plane S3 是唯一目标。
- 4.22.0 部署后新增反馈不会进入 AI4MS，本 runbook 不处理新增数据。
- dry-run 只在内存中保留截图元数据和 SHA-256，不保留完整截图字节；`--execute` 时逐张重新读取源对象并复验大小、文件头、MIME 与哈希后上传。
- Plane 按旧 AI4MS 1.1 算法重算 `payload_hash`，不信任 Mongo 文档中的哈希字符串；预检与执行间源数据变化会失败并要求重新 dry-run。

## 2026-10-09 发布例外

- 用户已明确取消生产 MongoDB 凭据门禁并授权 Plane 4.22.0 / AI4MS 2.0.0 直接发布。
- 本轮未执行生产 dry-run、AI4MS MongoDB/GridFS 备份或 `--execute` 导入；不得把它们记录为已验收。
- AI4MS `platform=plane` 历史数据不会被 2.0.0 删除或改写，但也不会出现在 AI4MS 管理端。取得生产凭据后必须补做本 runbook；若 `source_records > 0`，仍需按原流程备份、导入、核对截图哈希、状态历史和权限。

## 前置条件

1. 在 Shell 中注入一次性变量，不要把真实 URI 写入命令历史、工单或文档：

   ```bash
   export AI4MS_MONGO_URI='<从密钥管理系统注入的 MongoDB 连接串>'
   export AI4MS_MONGO_DB='ai4ms_production'
   export PLANE_WORKSPACE_SLUG='public'
   ```

2. 确认 Plane 已应用 `0163 → 0164 → 0165`，并完成 Plane PostgreSQL 与 S3 备份。
3. 确认 AI4MS MongoDB/GridFS 已备份，且迁移期间不再部署 4.21 Plane BFF。
4. 在 Plane API 容器内执行命令；容器镜像必须包含 `pymongo>=4.14,<5`。

## 1. Dry-run 预检

```bash
set -o pipefail
python manage.py import_research_feedback_from_ai4ms \
  --mongo-uri "$AI4MS_MONGO_URI" \
  --mongo-database "$AI4MS_MONGO_DB" \
  --workspace-slug "$PLANE_WORKSPACE_SLUG" \
  | tee plane-feedback-precheck-$(date -u +%Y%m%dT%H%M%SZ).json
```

预检会输出 `source_records`、`source_screenshots`、`source_history`、`valid_records`、`already_imported`、`records_to_import`、`failed_records` 与逐条失败原因。失败输出只包含旧反馈 ID 和原因，不包含正文、用户凭据或截图内容。

## 2. 分支处理

### 源记录数为 0

1. 保存 dry-run JSON 作为发布证据。
2. 部署 Plane 4.22.0。
3. 单独发布 AI4MS 2.0.0，移除其 Plane 专用 API 和环境变量。

### 存在失败记录

1. 不执行 `--execute`。
2. 根据失败原因修正目标工作区、账号/组织映射或 GridFS 缺失对象。
3. 重新 dry-run，直到 `failed_records=0`。

### 源记录数大于 0 且预检全部通过

1. 保持数据库和对象存储备份可恢复。
2. 执行幂等导入：

   ```bash
   set -o pipefail
   python manage.py import_research_feedback_from_ai4ms \
     --mongo-uri "$AI4MS_MONGO_URI" \
     --mongo-database "$AI4MS_MONGO_DB" \
     --workspace-slug "$PLANE_WORKSPACE_SLUG" \
     --execute \
     | tee plane-feedback-import-$(date -u +%Y%m%dT%H%M%SZ).json
   ```

3. 保存完整 JSON 输出。

## 3. 结果验收

在 Plane API Django shell 中核对：

```python
from plane.db.models import ResearchAuditEvent, ResearchFeedback
from plane.research.utils.audit import ResearchAuditAction

print(ResearchFeedback.objects.filter(legacy_feedback_id__isnull=False).count())
print(ResearchAuditEvent.objects.filter(action=ResearchAuditAction.FEEDBACK_IMPORT).count())
```

验收要求：

- `source_records = already_imported + imported_records`。
- 每个 legacy 记录的截图登记数等于该记录在源数据中的截图数。
- 每张截图的 `sha256`、类型、大小与 dry-run 结果一致。
- 状态历史事件总数等于 `source_history`，且每条历史的 actor、前后状态、说明和时间完整一致；`feedback.import` 事件数等于导入记录数。
- 随机抽样本人、主 PI 组织树和工作区管理员三种视角：列表范围正确，专属截图端点可打开，通用 workspace/project 资产端点返回 403/400。
- 对比旧 `feedback_id`、正文、分类、状态、提交人、组织、时间戳和处置说明；`legacy_feedback_id` 不出现在前端 API 响应。

## 4. 失败与回滚

- S3 或数据库失败会回滚该条 Plane 记录并清理本轮新上传对象；若清理失败，日志只包含对象键，需按对象键在 S3 控制台清理孤儿对象。
- 命令按记录逐条提交；前面已成功的记录保留，修复后可直接重跑 `--execute`，完整导入记录会跳过。
- 不使用删除生产 Plane 数据的方式回滚。确需回滚应用版本时，先停止反馈入口，保留 0165 表数据，再从 PostgreSQL/S3 备份恢复到评审批准的恢复点。
- 任何情况下都不删除 AI4MS MongoDB/GridFS 源数据；确需清理必须另立数据保留期审批。
