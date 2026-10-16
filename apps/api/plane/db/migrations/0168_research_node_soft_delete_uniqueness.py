from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [("db", "0167_research_task_paper_review_models")]

    operations = [
        migrations.RemoveConstraint(model_name="researchchainnode", name="rsch_node_uq_loop"),
        migrations.AddConstraint(
            model_name="researchchainnode",
            constraint=models.UniqueConstraint(
                fields=("chain", "parent_node", "loop_iteration"),
                condition=models.Q(deleted_at__isnull=True),
                name="rsch_node_uq_loop",
            ),
        ),
    ]
