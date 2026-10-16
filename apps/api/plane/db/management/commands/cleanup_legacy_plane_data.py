"""预览或清理科研项目的旧 Plane 数据。"""

import json

from django.core.management.base import BaseCommand, CommandError
from django.core.serializers.json import DjangoJSONEncoder

from plane.db.models import Workspace
from plane.utils.legacy_plane_cleanup import cleanup_legacy_plane_data


class Command(BaseCommand):
    help = "清理科研项目的旧 Plane 数据，保留科研链及行政项目；默认仅预览。"

    def add_arguments(self, parser):
        """声明工作区和显式执行参数。

        Args:
            parser: 命令参数解析器。
        """
        parser.add_argument("--workspace", required=True)
        parser.add_argument("--apply", action="store_true")

    def handle(self, *args, **options):
        """执行预览或清理并输出 JSON 审计结果。

        Args:
            args: 命令位置参数。
            options: 已解析的命令选项。
        """
        workspace = Workspace.objects.filter(slug=options["workspace"]).first()
        if workspace is None:
            raise CommandError("工作区不存在")
        try:
            report = cleanup_legacy_plane_data(workspace, apply=options["apply"])
        except RuntimeError as error:
            raise CommandError(str(error)) from error
        self.stdout.write(json.dumps(report, cls=DjangoJSONEncoder, ensure_ascii=False, sort_keys=True))
