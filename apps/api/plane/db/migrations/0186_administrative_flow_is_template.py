from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("db", "0185_rename_workspace_m_group_i_9e3c83_idx_workspace_m_group_i_fbdc8b_idx_and_more"),
    ]

    operations = [
        migrations.AddField(
            model_name="administrativeapprovalflow",
            name="is_template",
            field=models.BooleanField(default=True),
        ),
    ]
