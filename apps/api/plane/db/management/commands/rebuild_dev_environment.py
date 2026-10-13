"""重建 Plane 本地开发环境业务数据并轮换统一测试密码。"""

import json
import os
from pathlib import Path

from django.core.management.base import BaseCommand, CommandError
from django.db import transaction

from plane.db.models import Workspace
from plane.research.services.dev_environment import (
    reset_passwords,
    reset_report,
    reset_workspace_business_data,
    verify_passwords,
    write_password_manifest,
)


class Command(BaseCommand):
    """提供开发环境清理、校验和密码清单输出。"""

    help = "重建本地业务数据，保留账号和组织成员关系。"

    def add_arguments(self, parser):
        """注册重建模式、工作区范围与凭据输出参数。

        Args:
            parser: Django 管理命令参数解析器。
        """
        parser.add_argument("--workspace", default="public,pi", help="以逗号分隔的工作区标识。")
        parser.add_argument("--dry-run", action="store_true", help="仅输出清理预览。")
        parser.add_argument("--yes", action="store_true", help="执行业务数据清理和密码轮换。")
        parser.add_argument("--verify", action="store_true", help="只读校验测试密码。")
        parser.add_argument("--password-only", action="store_true", help="仅轮换本地账号密码。")
        parser.add_argument("--password-manifest", type=Path, help="权限为 0600 的本地凭据 CSV 路径。")
        parser.add_argument("--json", action="store_true", help="输出 JSON。")

    def handle(self, *args, **options):
        """按所选模式预览、重建或校验本地开发环境。

        Args:
            *args: Django 传入的位置参数。
            **options: 解析后的命令参数。
        """
        modes = sum(bool(options[name]) for name in ("dry_run", "yes", "verify", "password_only"))
        if modes != 1:
            raise CommandError("请且只能指定 --dry-run、--yes、--verify 或 --password-only 其中一个模式")
        password = os.environ.get("PLANE_DEV_TEST_PASSWORD", "")
        if not options["dry_run"] and not password:
            raise CommandError("请通过 PLANE_DEV_TEST_PASSWORD 环境变量注入测试密码")
        slugs = [slug.strip() for slug in options["workspace"].split(",") if slug.strip()]
        if not slugs:
            raise CommandError("工作区范围不能为空")
        workspaces = list(Workspace.objects.filter(slug__in=slugs, deleted_at__isnull=True).order_by("slug"))
        missing = sorted(set(slugs) - {workspace.slug for workspace in workspaces})
        if missing:
            raise CommandError(f"工作区不存在：{', '.join(missing)}")
        if options["dry_run"]:
            result = {"mode": "dry-run", **reset_report(workspaces)}
        elif options["verify"]:
            result = {
                "mode": "verify",
                "passwords": verify_passwords(password=password),
                "workspaces": [{"slug": ws.slug, "name": ws.name} for ws in workspaces],
            }
            result["ok"] = result["passwords"]["ok"]
        else:
            manifest = options["password_manifest"] or Path(".runtime/account-exports/pilab-dev-passwords.csv")
            with transaction.atomic():
                deleted = reset_workspace_business_data(workspaces) if options["yes"] else None
                credentials = reset_passwords(password=password)
                passwords = verify_passwords(password=password)
                if not passwords["ok"]:
                    raise CommandError("统一密码校验失败")
                manifest_result = write_password_manifest(manifest, password=password)
            result = {
                "mode": "rebuild" if options["yes"] else "password-only",
                "credentials": credentials,
                "password_manifest": manifest_result,
                "passwords": passwords,
            }
            if deleted is not None:
                result["deleted"] = deleted
        output = json.dumps(result, ensure_ascii=False, indent=2, sort_keys=True, default=str)
        self.stdout.write(output if options["json"] else self.style.SUCCESS(output))
