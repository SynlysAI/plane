"""Add fencing tokens to durable email delivery leases."""

from django.db import migrations, models


class Migration(migrations.Migration):
    """Prevent an expired Celery task from sending a reclaimed delivery."""

    dependencies = [
        ("db", "0222_notification_outbox_links"),
    ]

    operations = [
        migrations.AddField(
            model_name="notificationemaildelivery",
            name="lease_token",
            field=models.CharField(blank=True, default="", max_length=64),
        ),
    ]
