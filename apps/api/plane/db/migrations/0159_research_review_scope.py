from django.db import migrations, models


class Migration(migrations.Migration):
    """Persist the explicit OWNER/REVIEW scope on Context grants."""

    dependencies = [("db", "0158_research_outcome_attachments")]

    operations = [
        migrations.AddField(
            model_name="researchcontextgrant",
            name="scope_kind",
            field=models.CharField(default="OWNER", max_length=16),
        ),
        migrations.AddField(
            model_name="researchcontextgrant",
            name="scope_source",
            field=models.CharField(default="chain_owner", blank=True, max_length=64),
        ),
        migrations.AddField(
            model_name="researchcontextgrant",
            name="policy_version",
            field=models.CharField(default="research-agent-policy.v1", max_length=64),
        ),
    ]
