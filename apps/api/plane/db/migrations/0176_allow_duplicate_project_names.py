"""允许工作区内项目同名，仅保留编号唯一约束。"""

from django.db import migrations


class Migration(migrations.Migration):
    dependencies = [
        ("db", "0175_rename_default_administrative_organization"),
    ]

    operations = [
        migrations.AlterUniqueTogether(
            name="project",
            unique_together={("identifier", "workspace", "deleted_at")},
        ),
        migrations.RemoveConstraint(
            model_name="project",
            name="project_unique_name_workspace_when_deleted_at_null",
        ),
    ]
