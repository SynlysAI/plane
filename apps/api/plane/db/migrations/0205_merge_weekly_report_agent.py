from django.db import migrations


class Migration(migrations.Migration):
    """Join weekly-report MCP and develop without rewriting applied migrations."""

    dependencies = [
        ("db", "0201_weekly_report_agent"),
        ("db", "0204_researchchainnodetaskattachment"),
    ]

    operations = []
