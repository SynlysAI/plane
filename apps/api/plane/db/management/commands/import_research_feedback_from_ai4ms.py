"""Import the short-lived 4.21 Plane feedback records from AI4MS MongoDB."""

import json

from django.core.management.base import BaseCommand, CommandError

from plane.db.models import Workspace
from plane.research.services.feedback_migration import (
    Ai4MSFeedbackSource,
    MigrationExecutionError,
    MigrationValidationError,
    import_prepared_feedback,
    prepare_feedback_migration,
)


class Command(BaseCommand):
    """Dry-run or idempotently import legacy AI4MS Plane feedback data."""

    help = "Precheck and import platform=plane feedback from AI4MS MongoDB without mutating the source."

    def add_arguments(self, parser):
        """Register the MongoDB source, Plane target and execution switch."""
        parser.add_argument("--mongo-uri", required=True)
        parser.add_argument("--mongo-database", required=True)
        parser.add_argument("--workspace-slug", required=True)
        parser.add_argument("--execute", action="store_true")

    def handle(self, *args, **options):
        """Validate all legacy records and optionally import valid records.

        Args:
            *args: Django positional arguments.
            **options: Parsed command-line options.
        """
        workspace = Workspace.objects.filter(slug=options["workspace_slug"], deleted_at__isnull=True).first()
        if workspace is None:
            raise CommandError(f"工作区不存在：{options['workspace_slug']}")

        source = Ai4MSFeedbackSource(options["mongo_uri"], options["mongo_database"])
        try:
            summary, prepared_records = prepare_feedback_migration(source, workspace)
            self._write(summary)
            if summary["failed_records"]:
                raise CommandError(f"预检失败：{summary['failed_records']} 条记录需要修正。")
            if not options["execute"]:
                self.stdout.write(self.style.WARNING("Dry run 完成；确认后追加 --execute 执行导入。"))
                return

            summary["mode"] = "execute"
            imported = 0
            try:
                for prepared in prepared_records:
                    if prepared.already_imported:
                        continue
                    import_prepared_feedback(prepared, workspace, source)
                    imported += 1
            except MigrationExecutionError as error:
                summary["imported_records"] = imported
                self._write(summary)
                raise CommandError(str(error)) from error

            summary["imported_records"] = imported
            summary["skipped_records"] = summary["already_imported"]
            self._write(summary)
            self.stdout.write(
                self.style.SUCCESS(f"导入完成：{imported} 条新增，{summary['already_imported']} 条跳过。")
            )
        except MigrationExecutionError as error:
            raise CommandError(str(error)) from error
        except MigrationValidationError as error:
            raise CommandError(f"AI4MS 源数据读取失败：{error}") from error
        finally:
            source.close()

    def _write(self, payload: dict):
        """Write a stable JSON report without feedback content or credentials.

        Args:
            payload: Migration summary safe for release evidence.
        """
        self.stdout.write(json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True))
