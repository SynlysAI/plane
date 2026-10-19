# 周报正文图片加载故障修复与部署验证

## 原因与修复行为

2026 年 10 月 19 日只读排查确认：编辑器保存的是 JSON `imageComponent` 节点和 HTML `<image-component>` 标签，后端图片解析此前仅识别 `image` 和 `<img>`，导致正式快照的 `image_manifest` 漏记资源。导师虽有报告下载权限，图片接口仍返回 `404 attachment_not_found`。

此次调整统一识别新旧格式。保存和提交继续校验本地图片的工作区、报告归属、资源类型、上传完成状态和移除状态。

历史正式快照读取时，保留已有清单及其元数据，并从该快照自身的 JSON、HTML 补充遗漏的已上传报告图片。图片权限判断和正式报告上下文使用同一合并结果。补全不读取当前草稿，不回写快照，也不修改已提交正文。正式快照引用过、后来从草稿移除的图片继续可读。

本次无需数据库迁移或前端构建。部署前后 API 路径、响应结构和签名跳转方式一致。

## 本地验证

以下命令在 `apps/api` 目录运行，使用项目现有 `.venv`。数据库使用内存配置，缓存使用本地内存；Redis 地址仅满足应用初始化，测试不连接该地址，也不启动 Docker 服务。

```bash
DJANGO_SETTINGS_MODULE=plane.settings.test \
DATABASE_URL=sqlite:///:memory: \
REDIS_URL=redis://127.0.0.1:1/0 \
.venv/bin/python - <<'PY'
import django
from django.conf import settings

settings.CACHES = {
    "default": {"BACKEND": "django.core.cache.backends.locmem.LocMemCache"}
}
django.setup()

import pytest

raise SystemExit(pytest.main([
    "plane/tests/unit/research/test_report_images.py",
    "plane/tests/unit/research/test_files.py",
    "plane/tests/unit/settings/test_storage.py",
    "-q", "--tb=short", "-p", "no:cacheprovider",
]))
PY
```

API 契约测试已扩充为 21 个场景，覆盖新旧格式、独立 JSON/HTML、去重、资源校验、历史空清单与部分清单、权限拒绝和草稿隔离。实际执行需要隔离的测试数据库、Redis 及既有夹具所需服务；本次仅检查用例收集，不启动或构建 `docker-compose-test.yml`。具备隔离测试配置后执行：

```bash
python -m pytest plane/tests/contract/app/test_research_report_images.py -q
```

全项目 Django 检查在本次验证时受工作区已有的成员标签路由引用错误影响：`WorkspaceMemberTagGroupsEndpoint` 未定义。本次未修改该路由；该结果不代表本次图片修复的契约测试已实际通过。

## 部署与验收

生产由维护者部署。需要更新的业务代码为 `plane/research/utils/report_images.py` 和 `plane/research/services/report_context.py`，路径均相对于 `apps/api`。按现有发布流程发布，并重启加载后端代码的进程。回滚时还原这两处代码并重启，无数据回滚步骤。

排查时确认以下三个正式快照存在清单遗漏，涉及的七张图片均在存储中且已完成上传：

| 报告 ID                                | 正式版本 | 正文图片数 |
| -------------------------------------- | -------- | ---------- |
| `3bfd927c-8b18-418e-811a-f5a16a10d742` | v1       | 1          |
| `ab5affbb-e22b-4615-8fef-168ac887817b` | v1       | 4          |
| `88219455-073a-4e53-8510-2df638342291` | v1       | 2          |

部署后按以下顺序验收：

1. 使用有报告权限的导师账号刷新这三份报告，确认所有正文图片正常显示。
2. 在浏览器网络面板确认报告图片接口返回 `302`，随后存储请求返回 `200` 或有效范围请求的 `206`，内容类型为图片。
3. 使用无报告权限的账号访问相同图片地址，确认仍被拒绝。
4. 在测试环境新建草稿，插入图片后保存、提交，确认正式快照图片清单完整且导师可以读取。
5. 在测试环境退回报告并修改草稿，确认导师只能读取正式版本引用过的图片，草稿新增图片不可读。

已有三份历史报告不需要重新上传图片、退回或再次提交。
