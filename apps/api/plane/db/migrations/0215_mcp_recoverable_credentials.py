"""为项目及周报连接增加可恢复密钥和永久有效期。"""

from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [("db", "0214_user_background_asset_type")]

    operations = [
        migrations.AddField(
            model_name="unifiedmcpconnection",
            name="token_encrypted",
            field=models.TextField(blank=True, default=""),
        ),
        migrations.AddField(
            model_name="reportagentgrant",
            name="token_encrypted",
            field=models.TextField(blank=True, default=""),
        ),
        migrations.AlterField(
            model_name="unifiedmcpconnection",
            name="expires_at",
            field=models.DateTimeField(blank=True, db_index=True, null=True),
        ),
        migrations.AlterField(
            model_name="reportagentgrant",
            name="expires_at",
            field=models.DateTimeField(blank=True, db_index=True, null=True),
        ),
    ]
