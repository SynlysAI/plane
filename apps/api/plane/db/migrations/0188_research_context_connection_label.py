from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [("db", "0187_research_task_comment_attachments")]
    operations = [
        migrations.AddField(
            model_name="researchcontextgrant",
            name="connection_label",
            field=models.CharField(max_length=100, blank=True, default=""),
        )
    ]
