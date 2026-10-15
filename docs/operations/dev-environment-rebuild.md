# 本地开发环境重建

`rebuild_dev_environment` 用于清理选定工作区的业务数据，保留账号、工作区成员、组织、导师关系和集成配置。默认范围为 `public,pi`。所有账号的测试密码统一从 `PLANE_DEV_TEST_PASSWORD` 环境变量读取，账号会话在轮换密码时失效。

`prune_dev_accounts` 是更强的一次性清理：删除全部科研/行政项目和多余人类账号，只保留 5 个测试账号与系统 bot，并把组织收敛为 `π-Lab → 基础研究 → 器件`。该命令不轮换密码，也不清理 MinIO 孤儿文件。

这些命令仅供本地测试环境使用。日常服务重启无需执行重建；实际清理前应保留数据库和上传文件备份。不要在生产环境执行，不要将凭据清单提交到 Git。

## 清空多余账号与项目

默认 dry-run，无需开关。`--yes` 必须同时满足 `PLANE_DEV_PRUNE=1`，且 `WEB_URL` 不是生产地址（`10.26.15.` / `openeva.xmuzc.com`）。缺一即拒绝并回滚。

保留账号：

- `whong@xmu.edu.cn` 洪文晶（Main PI）
- `admin@ai4ms.local`（实例管理员、两个工作区 owner）
- `jyliu@xmu.edu.cn` 刘俊扬（直接导师）
- `17720599271@163.com` 张曦宇（学生）
- `gaopeng.member@ai4ms.local` 高鹏（仅 public 普通成员）

系统 bot 全部保留。清库后 `rebuild-pi-lab-baseline.sh --verify-only` 会失败，这是预期：本地不再维持 189 学生 Excel 基线。

```bash
mkdir -p .runtime/db-backups
docker exec plane-plane-db-1 pg_dump -Fc -U plane plane > ".runtime/db-backups/plane-dev-before-prune-$(date -u +%Y%m%dT%H%M%SZ).dump"
docker exec plane-api-1 python manage.py prune_dev_accounts --dry-run --json
docker exec -e PLANE_DEV_PRUNE=1 plane-api-1 python manage.py prune_dev_accounts --yes --json
```

dry-run JSON 会预告将删除的项目数、账号数和组织节点。不能同时指定 `--dry-run` 和 `--yes`。

## 只读预览

```bash
docker exec plane-api-1 python manage.py rebuild_dev_environment --dry-run --json
```

预览不需要密码，不修改数据。使用 `--workspace public` 可缩小工作区范围。

## 密码轮换与重建

通过本机安全存储设置 `PLANE_DEV_TEST_PASSWORD` 后，将变量传给容器。密码不会进入命令输出，CSV 默认写入容器挂载目录下的 `.runtime/account-exports/pilab-dev-passwords.csv`，文件权限为 `0600`。

```bash
docker exec -e PLANE_DEV_TEST_PASSWORD plane-api-1 python manage.py rebuild_dev_environment --password-only --json
docker exec -e PLANE_DEV_TEST_PASSWORD plane-api-1 python manage.py rebuild_dev_environment --verify --json
```

`--password-only` 保留业务数据，仅轮换所有账号密码。`--verify` 只读校验所有账号是否接受指定密码。

确认预览范围及备份后，使用 `--yes` 清理选定工作区业务数据并轮换密码：

```bash
docker exec -e PLANE_DEV_TEST_PASSWORD plane-api-1 python manage.py rebuild_dev_environment --yes --json
```

每次只能指定 `--dry-run`、`--yes`、`--verify`、`--password-only` 中的一个模式。密码校验或凭据输出失败时，数据库清理与密码轮换回滚。凭据文件写入不属于数据库事务，失败后应检查本机清单并重新导出。
