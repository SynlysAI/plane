"""扩展科研项目和研究链的可恢复删除状态，不修改现有数据。"""

from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [("db", "0167_research_task_paper_review_models")]

    operations = [
        migrations.AlterField(
            model_name="researchprojectprofile",
            name="workflow_status",
            field=models.CharField(
                choices=[
                    ("ACTIVE", "Active"),
                    ("ARCHIVED", "Archived"),
                    ("COMPLETED", "Completed"),
                    ("DELETED", "Deleted"),
                ],
                default="ACTIVE",
                max_length=16,
            ),
        ),
        migrations.AlterField(
            model_name="researchchain",
            name="status",
            field=models.CharField(
                choices=[
                    ("ACTIVE", "Active"),
                    ("ARCHIVED", "Archived"),
                    ("COMPLETED", "Completed"),
                    ("DELETED", "Deleted"),
                ],
                default="ACTIVE",
                max_length=16,
            ),
        ),
    ]
