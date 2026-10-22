"""保留最新的负责人，再限制每个工作项只能有一条有效指派。"""

from django.db import migrations, models
from django.utils import timezone


def retain_latest_assignee(apps, schema_editor):
    """按创建时间和主键倒序保留最新负责人，软删除其余有效记录。"""
    alias = schema_editor.connection.alias
    for model_name, field in (("IssueAssignee", "issue_id"), ("DraftIssueAssignee", "draft_issue_id")):
        model = apps.get_model("db", model_name)
        rows = model.objects.using(alias).filter(deleted_at__isnull=True)
        previous = None
        remove_ids = []
        for parent_id, row_id in rows.order_by(field, "-created_at", "-id").values_list(field, "id").iterator():
            if parent_id == previous:
                remove_ids.append(row_id)
            previous = parent_id
            if len(remove_ids) == 1000:
                model.objects.using(alias).filter(pk__in=remove_ids).update(deleted_at=timezone.now())
                remove_ids = []
        if remove_ids:
            model.objects.using(alias).filter(pk__in=remove_ids).update(deleted_at=timezone.now())


class Migration(migrations.Migration):
    dependencies = [("db", "0187_research_task_comment_attachments")]
    operations = [
        migrations.RunPython(retain_latest_assignee, migrations.RunPython.noop),
        migrations.AddConstraint(
            model_name="issueassignee",
            constraint=models.UniqueConstraint(
                fields=["issue"], condition=models.Q(deleted_at__isnull=True), name="issue_single_active_assignee"
            ),
        ),
        migrations.AddConstraint(
            model_name="draftissueassignee",
            constraint=models.UniqueConstraint(
                fields=["draft_issue"], condition=models.Q(deleted_at__isnull=True), name="draft_single_active_assignee"
            ),
        ),
    ]
