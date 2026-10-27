from django.db import migrations


class Migration(migrations.Migration):
    """Join the reviewed weekly-report history with develop's subscriber model."""

    dependencies = [
        ("db", "0205_merge_weekly_report_agent"),
        ("db", "0205_action_item_notification_subscribers"),
    ]

    operations = []
