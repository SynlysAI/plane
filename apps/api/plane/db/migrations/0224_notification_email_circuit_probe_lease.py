"""Serialize half-open SMTP probes across worker processes."""

from django.db import migrations, models


class Migration(migrations.Migration):
    """Add a database lease for the shared SMTP circuit probe."""

    dependencies = [
        ("db", "0223_notification_delivery_lease_token"),
    ]

    operations = [
        migrations.AddField(
            model_name="notificationemailcircuit",
            name="probe_lease_until",
            field=models.DateTimeField(null=True),
        ),
        migrations.AddField(
            model_name="notificationemailcircuit",
            name="probe_lease_token",
            field=models.CharField(blank=True, default="", max_length=64),
        ),
    ]
