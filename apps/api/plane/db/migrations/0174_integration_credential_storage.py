# Generated for the direct-credential integration config refactor.
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("db", "0173_remove_research_agent_enabled"),
    ]

    operations = [
        migrations.AddField(
            model_name="externalsystemconnection",
            name="credential",
            field=models.TextField(blank=True, default=""),
        ),
        migrations.AddField(
            model_name="externalsystemconnection",
            name="credential_mode",
            field=models.CharField(
                choices=[("SHARED", "Shared credential"), ("PERSONAL", "Per-user credential")],
                default="SHARED",
                max_length=16,
            ),
        ),
        migrations.RemoveField(
            model_name="externalsystemconnection",
            name="credential_ref",
        ),
    ]
