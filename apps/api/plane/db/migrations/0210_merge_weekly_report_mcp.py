from django.db import migrations


class Migration(migrations.Migration):
    """Join weekly-report MCP with the current research approval history."""

    dependencies = [
        ("db", "0210_administrative_settings_admin_only"),
        ("db", "0206_merge_weekly_report_demo"),
    ]

    operations = []
