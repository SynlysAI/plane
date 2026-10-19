"""清理超过保留时间且尚未登记的科研报告附件资产。"""

from datetime import timedelta

from django.core.management.base import BaseCommand
from django.utils import timezone

from plane.db.models import FileAsset
from plane.settings.storage import S3Storage


class Command(BaseCommand):
    """按预览或执行模式清理过期的待登记附件。"""

    help = "清理过期且未登记的科研报告附件资产，默认仅预览。"

    def add_arguments(self, parser):
        """声明清理保留时间和执行开关。"""
        parser.add_argument("--older-than-hours", type=int, default=24)
        parser.add_argument("--apply", action="store_true")

    def handle(self, *args, **options):
        """输出待清理数量，并在显式执行时删除对象和资产记录。"""
        cutoff = timezone.now() - timedelta(hours=max(options["older_than_hours"], 1))
        assets = FileAsset.objects.filter(
            entity_type=FileAsset.EntityTypeContext.REPORT_ATTACHMENT,
            is_uploaded=False,
            created_at__lt=cutoff,
        ).exclude(research_report_attachments__isnull=False)
        assets = list(assets)
        if options["apply"] and assets:
            storage = S3Storage()
            deleted = storage.delete_files([asset.asset.name for asset in assets])
            if deleted:
                FileAsset.objects.filter(pk__in=[asset.pk for asset in assets]).delete()
        self.stdout.write(
            self.style.SUCCESS(
                f"发现 {len(assets)} 个过期待登记附件，模式={'执行' if options['apply'] else '预览'}。"
            )
        )
