"""Add notification constraints after preference data has been normalized."""

from django.db import migrations, models


class Migration(migrations.Migration):
    """Create notification lookup indexes and enforce unique preferences."""

    dependencies = [
        ("db", "0220_notification_delivery_outbox"),
    ]

    operations = [
        migrations.AddConstraint(
            model_name="usernotificationpreference",
            constraint=models.UniqueConstraint(
                fields=("user",),
                name="notification_preference_unique_user",
            ),
        ),
        migrations.AddIndex(
            model_name="notificationevent",
            index=models.Index(
                fields=["receiver", "created_at"],
                name="notif_event_receiver_idx",
            ),
        ),
        migrations.AddIndex(
            model_name="notificationevent",
            index=models.Index(
                fields=["workspace", "entity_name", "entity_identifier"],
                name="notif_event_entity_idx",
            ),
        ),
        migrations.AddIndex(
            model_name="notificationemaildelivery",
            index=models.Index(
                fields=["status", "available_at"],
                name="notif_mail_due_idx",
            ),
        ),
        migrations.AddIndex(
            model_name="notificationemaildelivery",
            index=models.Index(
                fields=["status", "lease_until"],
                name="notif_mail_lease_idx",
            ),
        ),
    ]
