# 0213 生产迁移故障修复记录

## 故障与修复

2026 年 10 月 30 日，`10.26.15.93` 的完整部署在
`0213_project_administrative_settings_lock` 中失败：

```text
AttributeError: type object 'ResearchProjectProfile' has no attribute 'all_objects'
```

迁移通过历史模型注册表读取模型，而 `all_objects` 没有序列化到历史状态中。
`ResearchProjectProfile` 和 `Project` 均受影响，正向与反向迁移都需要修复。
补丁使用历史模型的 `_base_manager`，并通过
`schema_editor.connection.alias` 绑定数据库连接。

迁移规则保持不变：将旧工作区锁应用于未删除的行政项目，排除所有科研项目关联，
包括软删除的科研关联；反向迁移根据未删除项目的锁状态恢复工作区锁。
部署脚本在迁移失败或超时时直接输出最后 100 行容器日志，随后终止部署。

## 验证结果

- 使用独立临时 PostgreSQL 和 Valkey 容器完成验证，未启用测试 Compose 栈。
- 3 项历史模型测试通过，实际执行 `0212 → 0213 → 0212 → 0214` 的迁移操作，
  覆盖工作区隔离、科研项目、软删除项目与关联、未开启旧锁及尚无工作区设置。
- 5 项现有行政项目锁权限测试通过。
- 4 项部署脚本测试通过，覆盖迁移失败、超时、日志读取失败及成功部署。

在已配置独立测试数据库、Redis、`WEB_URL` 和 `APP_BASE_URL` 的后端测试环境中运行：

```bash
cd apps/api
python -m pytest \
  plane/tests/unit/db/test_project_administrative_settings_lock_migration.py \
  plane/tests/contract/app/test_administrative_settings_admin_only.py \
  -q --tb=short
```

部署脚本测试只使用临时目录和命令替身，可在仓库根目录直接运行：

```bash
python3 -m unittest discover -s scripts/tests -p test_deploy.py -v
bash -n scripts/deploy.sh
```

## 生产恢复记录

- 生产目录：`/home/fangyikai/github_project/SynlysAI/plane`。
- 热修基线：`main`，提交 `53b6149281b9109beeb3f80f18bf36e81db7de23`。
- 备份目录：`/home/fangyikai/plane-deployment-backups/20261030-174122-migration-0213`。
- 备份包含 PostgreSQL 自定义格式转储、生产配置归档、原始文件校验值、迁移记录、
  部署日志及 `hotfix.patch`；配置归档包含凭据，仅保留在服务器受限目录中。
- 仅同步迁移文件和 `scripts/deploy.sh`，执行
  `./scripts/deploy.sh --backend --skip-pull` 后，全部健康检查通过。
- 0213、0214 于北京时间 17:45 成功应用；迁移容器退出码为 `0`，
  `manage.py migrate --check` 通过，字段已从工作区设置迁至项目。
- API、Worker、Beat 运行正常且重启次数为 `0`，Worker 响应 `pong`；
  项目和工作区设置只读查询正常，Web、Admin、实例 API 均返回 `200`。

生产当前仍以原 `main` 提交加两个未提交补丁运行，前端未重建，界面版本仍为
`9.1.0`。仓库统一升级至 `9.1.1`，待 PR 合并后执行完整部署，使正式版本信息生效。

## PR 合并后的归并

仅在 `main` 已包含本次修复后执行以下步骤。先审阅服务器差异，确认两个文件
仍是本次热修内容；反向应用补丁会保留其他文件的改动，校验失败时应先检查差异。

```bash
cd /home/fangyikai/github_project/SynlysAI/plane
BACKUP_DIR=/home/fangyikai/plane-deployment-backups/20261030-174122-migration-0213

git diff -- apps/api/plane/db/migrations/0213_project_administrative_settings_lock.py scripts/deploy.sh
git apply --reverse --check "$BACKUP_DIR/hotfix.patch"
git apply --reverse "$BACKUP_DIR/hotfix.patch"
git pull --ff-only
./scripts/deploy.sh --skip-pull
```

以上操作只归并源代码补丁，无需回滚已完成的数据库迁移。不要使用 `--fake`、
历史的一次性修库脚本或重新运行会覆盖 `.env` 的 `setup.sh` 处理此次故障。
