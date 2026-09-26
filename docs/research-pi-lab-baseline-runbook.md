# π-Lab 真实科研基线重建 Runbook

## 1. 适用范围与锁定数据

本流程只用于本机 `docker-compose-local.yml` 实例，把 `public` 工作区重建为 π-Lab 真实人员与组织基线；`pi` 工作区保持无科研业务数据。流程会删除所有工作区的科研业务数据、研究型 Plane Project、附件、审批、Agent 会话、Context grant、身份映射和科研审计，但保留 Workspace、全局 User、登录凭据、非科研业务数据和部署密钥。

| 数据源                            | 行数 | SHA-256                                                            |
| --------------------------------- | ---: | ------------------------------------------------------------------ |
| `refer/π-Lab学生-导入信息表.xlsx` |  190 | `cda7489f256601179b587d7a5bb7035145854272325e1599c62723f0cf0ecaa0` |
| `refer/导师信息表.xlsx`           |   15 | `ac21aba18ebc147a5b6d5c50ab6f4acdf595aec2b0f3c37a1f0bbb18a8f6e548` |

原始 xlsx 和一次性密码不进入 Git。`refer/issue.docx` 含原始明文密码，只作为脱敏转录来源，同样不进入版本库。

## 2. 重建前检查

```bash
cd /home/fangyikai/code/_AI4MS/plane

# 只解析和校验源表，不写库
./scripts/rebuild-pi-lab-baseline.sh --dry-run

# 确认当前服务可用；如代码更新，先完成 API/Web 构建和迁移
docker compose -f docker-compose-local.yml -f docker-compose-local.override.yml ps
```

dry-run 必须输出：190 行源学生、导入 189 人、剔除 1 人、导师 14 人、小组 21 个、主导师缺口 37 人、联合导师引用缺口 14 处。

## 3. 备份、恢复演练与重建

```bash
# 默认输出到 .runtime/backups/pi-lab-<UTC时间戳>/
./scripts/rebuild-pi-lab-baseline.sh --yes

# 也可显式指定备份根目录
./scripts/rebuild-pi-lab-baseline.sh --yes --backup-root /path/to/protected/backups
```

脚本按顺序执行：

1. 校验两个 xlsx 哈希。
2. 停止 `api`、`worker`、`beat-worker`，阻止科研写入。
3. 导出 PostgreSQL custom-format 快照和 MinIO `uploads` 卷快照。
4. 生成对象 SHA-256 清单。
5. 在临时 PostgreSQL 数据库恢复快照并比对全部 public 表行数。
6. 在临时目录恢复 MinIO 快照并比对对象哈希。
7. 写入 `manifest.json`，状态为 `VERIFIED`、恢复演练为 `PASSED`。
8. 调用 `rebuild_pi_lab_baseline --yes`：导出历史、事务内清理和重建、事务后再删除旧科研附件对象。
9. 重启写入服务。

备份目录至少包含：

- `manifest.json`
- `database.dump`
- `uploads.tar.gz`
- `uploads.sha256`
- `source-table-counts.tsv` / `drill-table-counts.tsv`
- `restore-drill/uploads.sha256`
- `history/*.jsonl`
- `credentials.json`（权限 `0600`，一次性初始密码）

不要把备份目录放到 Git 工作树可提交位置；默认 `.runtime/` 已被忽略。`credentials.json` 只作为受保护的发放底稿，不进入 Git，也不作为网站下载入口。新建账号时，同一份明文会写入账号来源，供系统管理中的批次报告和「下载全部初始密码」使用。再次重建发现账号已存在时不轮换密码，也不会用空行覆盖已经保存的初始密码。

## 4. 固定基线

- 组织：`π-Lab` ROOT → 21 个 TEAM。
- 洪文晶是唯一有效组织 PI、paired workspace 的 Main PI 和唯一有效 `MAIN_PI` 标签。
- 其他 13 位导师为 ADVISOR；`测试组` 不建导师账号。
- `小白鼠` 不导入；`测试` 小组仍保留为空小组，用于保持 21 个组织节点基线。
- 189 名学生均创建账号、公共工作区座位、Profile 和小组主归属。
- 152 名学生建立主导师绑定；37 人主导师邮箱缺失，账号照常导入但关系待补。
- 14 处联合导师邮箱缺失，仅记录待补关系，不创建占位导师。
- `庄玎玲`、`张昕阳` 的学号 `0` 在 Profile 中置空，原始值保留在导入行 `raw`。
- 初始 Project、ResearchProjectProfile、ResearchChain、KB 申请数量均为 0；课题必须由真实用户上线后创建。
- 旧演示账号保留全局登录能力，但科研组织角色和科研内容权限被清理。

## 5. 验收与回滚

```bash
# 代码层验收
docker compose -f docker-compose-test.yml run --rm api-tests \
  pytest plane/tests/unit/research/test_pi_lab_baseline.py -q

# 运行库验收
./scripts/rebuild-pi-lab-baseline.sh --verify-only
```

`--verify-only` 会断言 `pi` 为空、组织树为 22 个节点、唯一 PI 为洪文晶、189/14 账号Profile、152 条主导师绑定、37 条主导师缺口、2 个无效学号置空，以及无预造课题/链/KB。

回滚时先停止写入服务，用备份目录中的 `database.dump` 和 `uploads.tar.gz` 恢复原卷，再启动服务。恢复操作必须由维护人复核 `manifest.json` 哈希后在变更窗口执行。

## 6. 初始密码下载与历史回填

系统管理的人员导入区始终提供「下载全部初始密码」。它导出当前 `public` 工作区的活跃成员，不包含已停用账号，也不包含从未加入本工作区的历史 seed。没有发放记录时密码列为空。密码列是最近一次发放的初始密码；哈希不可逆，不能从这里查看用户改密后的当前密码。

若某次基线重建只把明文留在 `credentials.json`、没有写入账号来源，可在确认文件权限为 `0600` 后回填。回填只接受能通过当前密码哈希校验的明文，不修改哈希；来源中已有不同明文时不覆盖，因此可以重复执行。

```bash
docker compose -f docker-compose-local.yml -f docker-compose-local.override.yml exec api \
  python manage.py backfill_initial_passwords \
  --credentials /path/to/credentials.json \
  --workspace public
```

命令输出只有计数和未写入邮箱，不打印密码。哈希不一致的账号留空，需要管理员显式重新生成后才能下载新的可登录初始密码。
