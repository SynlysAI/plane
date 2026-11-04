"""Link durable notification events and deliveries to their source rows."""

import django.db.models.deletion
from django.db import migrations, models


class Migration(migrations.Migration):
    """Connect the durable event queue to inbox and email snapshots."""

    dependencies = [
        ("db", "0221_notification_delivery_constraints"),
    ]

    operations = [
        migrations.AddField(
            model_name="notificationevent",
            name="notification",
            field=models.OneToOneField(
                blank=True,
                null=True,
                on_delete=django.db.models.deletion.SET_NULL,
                related_name="durable_event",
                to="db.notification",
            ),
        ),
        migrations.AddField(
            model_name="notificationemaildelivery",
            name="source_log",
            field=models.OneToOneField(
                blank=True,
                null=True,
                on_delete=django.db.models.deletion.SET_NULL,
                related_name="durable_delivery",
                to="db.emailnotificationlog",
            ),
        ),
    ]
