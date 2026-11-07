from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("db", "0233_profile_preferred_collaborators"),
    ]

    operations = [
        migrations.AlterField(
            model_name="researchchainstagereviewaction",
            name="action",
            field=models.CharField(
                choices=[
                    ("APPROVE", "Approve"),
                    ("RETURN", "Return"),
                    ("WITHDRAW", "Withdraw"),
                ],
                max_length=16,
            ),
        ),
        migrations.AlterField(
            model_name="researchchainstagereviewaction",
            name="reviewer_role",
            field=models.CharField(
                choices=[
                    ("ADVISOR", "Direct advisor"),
                    ("PI", "Principal investigator"),
                    ("SUBMITTER", "Submitter"),
                ],
                max_length=16,
            ),
        ),
    ]
