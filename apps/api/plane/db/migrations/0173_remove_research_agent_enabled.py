# Generated for the research agent plugin removal.
from django.db import migrations


class Migration(migrations.Migration):

    dependencies = [
        ("db", "0172_delete_research_agent_models"),
    ]

    operations = [
        migrations.RemoveField(
            model_name="workspaceresearchsetting",
            name="research_agent_enabled",
        ),
    ]
