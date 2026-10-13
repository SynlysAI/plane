# 本地开发环境重建

`rebuild_dev_environment` 用于清理选定工作区的业务数据，保留账号、工作区成员、组织、导师关系和集成配置。默认范围为 `public,pi`。所有账号的测试密码统一从 `PLANE_DEV_TEST_PASSWORD` 环境变量读取，账号会话在轮换密码时失效。

此命令仅供本地测试环境使用。日常服务重启无需执行重建；实际清理前应保留数据库和上传文件备份。不要在生产环境执行，不要将凭据清单提交到 Git。

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
