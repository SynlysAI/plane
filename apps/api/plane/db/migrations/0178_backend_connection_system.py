# Generated for the personal-credential wiring across agent systems.
from django.db import migrations, models
from django.db.models import Q


class Migration(migrations.Migration):

    dependencies = [
        ("db", "0177_integration_credential_storage"),
    ]

    operations = [
        migrations.AddField(
            model_name="researchagentbackendconnection",
            name="system",
            field=models.CharField(default="SCIENCE_DISCOVERY", max_length=24),
        ),
        migrations.AlterField(
            model_name="researchagentbackendconnection",
            name="base_url",
            field=models.URLField(blank=True, default="", max_length=500),
        ),
        migrations.RemoveConstraint(
            model_name="researchagentbackendconnection",
            constraint="rsch_agent_backend_uq_ws_user",
        ),
        migrations.AddConstraint(
            model_name="researchagentbackendconnection",
            constraint=models.UniqueConstraint(
                condition=Q(deleted_at__isnull=True),
                fields=["workspace", "user", "system"],
                name="rsch_agent_backend_uq_ws_user",
            ),
        ),
    ]
