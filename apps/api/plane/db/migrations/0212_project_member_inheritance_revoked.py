from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("db", "0211_merge_latest_develop_unified_mcp"),
    ]

    operations = [
        migrations.AddField(
            model_name="projectmember",
            name="inheritance_revoked",
            field=models.BooleanField(default=False),
        ),
    ]
