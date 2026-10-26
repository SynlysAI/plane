from django.db import migrations, models
from django.db.models import Q


class Migration(migrations.Migration):
    """Cache previews for research-chain uploads stored in external systems."""

    dependencies = [
        ("db", "0200_orgunit_weekly_confidentiality_default"),
    ]

    operations = [
        migrations.AddField(
            model_name="assetpreview",
            name="chain_upload",
            field=models.ForeignKey(
                blank=True,
                null=True,
                on_delete=models.CASCADE,
                related_name="previews",
                to="db.researchchainupload",
            ),
        ),
        migrations.AddConstraint(
            model_name="assetpreview",
            constraint=models.UniqueConstraint(
                condition=Q(chain_upload__isnull=False),
                fields=("chain_upload", "fingerprint", "converter_version"),
                name="chain_upload_preview_source_version_uq",
            ),
        ),
    ]
