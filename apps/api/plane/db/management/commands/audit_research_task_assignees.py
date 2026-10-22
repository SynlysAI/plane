"""只读审计科研任务中已失效的负责人资格。"""

import json

from django.core.management.base import BaseCommand, CommandError

from plane.db.models import ResearchChainNodeTask, Workspace
from plane.research.services.chain_tasks import chain_assignable_user_ids


class Command(BaseCommand):
    help = "列出不具备有效课题成员资格的科研任务负责人，不修改任何数据"

    def add_arguments(self, parser):
        """声明工作区与 JSON 输出参数。

        Args:
            parser: Django 命令参数解析器。
        """
        parser.add_argument("workspace_slug")
        parser.add_argument("--json", action="store_true", help="输出 JSON")

    def handle(self, *args, **options):
        """输出当前工作区的无效指派，包括已完成任务的历史记录。

        Args:
            args: 未使用的位置参数。
            options: 工作区与输出选项。
        """
        workspace = Workspace.objects.filter(slug=options["workspace_slug"]).first()
        if workspace is None:
            raise CommandError("工作区不存在。")
        tasks = (
            ResearchChainNodeTask.objects.filter(workspace=workspace, assignee__isnull=False)
            .select_related("chain__project", "assignee")
            .order_by("chain_id", "created_at", "id")
        )
        candidates = {}
        invalid = []
        for task in tasks.iterator():
            if task.chain_id not in candidates:
                candidates[task.chain_id] = chain_assignable_user_ids(workspace, task.chain)
            if task.assignee_id in candidates[task.chain_id]:
                continue
            invalid.append(
                {
                    "task_id": str(task.id),
                    "title": task.title,
                    "status": task.status,
                    "project_id": str(task.chain.project_id),
                    "project_name": task.chain.project.name,
                    "chain_id": str(task.chain_id),
                    "assignee_id": str(task.assignee_id),
                    "assignee_name": task.assignee.display_name,
                    "reason": "负责人不具备有效课题成员资格",
                }
            )
        if options["json"]:
            self.stdout.write(json.dumps({"workspace": workspace.slug, "tasks": invalid}, ensure_ascii=False))
            return
        for row in invalid:
            self.stdout.write(
                f"{row['task_id']} | {row['project_name']} | {row['title']} | {row['assignee_name']} | {row['status']}"
            )
        self.stdout.write(f"发现 {len(invalid)} 条无效指派；未修改任何数据。")
