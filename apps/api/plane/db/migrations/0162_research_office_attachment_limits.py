from django.db import migrations, models


class Migration(migrations.Migration):
    """Add a workspace-scoped limit for office report attachments."""

    dependencies = [("db", "0161_research_synlora")]

    operations = [
        migrations.AddField(
            model_name="workspaceresearchsetting",
            name="office_max_mb",
            field=models.PositiveIntegerField(default=50),
        ),
    ]
