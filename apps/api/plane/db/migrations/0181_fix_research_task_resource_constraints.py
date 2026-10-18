from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [("db", "0180_workspace_invite_basic_research_profile")]

    operations = [
        migrations.RemoveConstraint(
            model_name="researchchainnodetask", name="rsch_task_resource_none_ck",
        ),
        migrations.AddConstraint(
            model_name="researchchainnodetask",
            constraint=models.CheckConstraint(
                condition=~models.Q(resource_type="NONE") | models.Q(resource_id__isnull=True),
                name="rsch_task_resource_none_ck",
            ),
        ),
    ]
