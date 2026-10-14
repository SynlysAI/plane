# Generated for the research agent plugin removal.
from django.db import migrations


class Migration(migrations.Migration):

    dependencies = [
        ("db", "0171_administrative_organizations"),
    ]

    operations = [
        migrations.DeleteModel(
            name="ResearchAgentRunEvent",
        ),
        migrations.DeleteModel(
            name="ResearchAgentSession",
        ),
    ]
