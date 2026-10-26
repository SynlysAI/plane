from django.db import migrations, models


class Migration(migrations.Migration):
    """Add workspace/time indexes used by cursor-based home activity pages."""

    dependencies = [
        ("db", "0202_inbox_todo_states"),
    ]

    operations = [
        migrations.AddIndex(
            model_name="issueactivity",
            index=models.Index(fields=["workspace", "created_at"], name="issue_activity_ws_created_idx"),
        ),
        migrations.AddIndex(
            model_name="issuecomment",
            index=models.Index(fields=["workspace", "created_at"], name="issue_comment_ws_created_idx"),
        ),
    ]
