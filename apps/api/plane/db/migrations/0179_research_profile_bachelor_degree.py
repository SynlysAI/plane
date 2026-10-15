from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("db", "0178_backend_connection_system"),
    ]

    operations = [
        migrations.AlterField(
            model_name="researchuserprofile",
            name="degree",
            field=models.CharField(
                blank=True,
                choices=[("BS", "Bachelor"), ("MS", "Master"), ("PHD", "Doctor")],
                default="",
                max_length=8,
            ),
        ),
    ]
