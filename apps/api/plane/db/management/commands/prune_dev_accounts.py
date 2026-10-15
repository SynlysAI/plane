"""清空 Plane 本地开发环境中的多余账号、项目与组织节点。"""

import json

from django.core.management.base import BaseCommand, CommandError

from plane.research.services.dev_account_prune import (
    DevAccountPruneError,
    preview_dev_account_prune,
    prune_dev_accounts,
)


class Command(BaseCommand):
    """提供开发环境账号清理的只读预览与受保护写入。"""

    help = "清空本地测试账号和项目，只保留最小科研测试身份。默认 dry-run。"

    def add_arguments(self, parser):
        """注册预览、写入与 JSON 输出参数。

        Args:
            parser: Django 管理命令参数解析器。
        """
        parser.add_argument("--dry-run", action="store_true", help="只读预览，不修改数据库。")
        parser.add_argument("--yes", action="store_true", help="执行破坏性清理。需要 PLANE_DEV_PRUNE=1。")
        parser.add_argument("--json", action="store_true", help="输出 JSON。命令始终输出 JSON，此参数保留兼容。")

    def handle(self, *args, **options):
        """按 dry-run 或 --yes 预览或清理本地开发账号。

        Args:
            *args: Django 传入的位置参数。
            **options: 解析后的命令参数。
        """
        if options["dry_run"] and options["yes"]:
            raise CommandError("不能同时指定 --dry-run 和 --yes")
        try:
            result = prune_dev_accounts() if options["yes"] else preview_dev_account_prune()
        except DevAccountPruneError as error:
            raise CommandError(str(error)) from error
        output = json.dumps(result, ensure_ascii=False, indent=2, sort_keys=True, default=str)
        self.stdout.write(output)
