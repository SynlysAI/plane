from django.conf import settings
from django.db import migrations, models
import django.db.models.deletion
import uuid


class Migration(migrations.Migration):
    dependencies = [("db", "0157_research_knowledge_requests")]

    operations = [
        migrations.CreateModel(
            name="ResearchOutcomeAttachment",
            fields=[
                ("created_at", models.DateTimeField(auto_now_add=True, verbose_name="Created At")),
                ("updated_at", models.DateTimeField(auto_now=True, verbose_name="Last Modified At")),
                ("deleted_at", models.DateTimeField(blank=True, null=True, verbose_name="Deleted At")),
                ("id", models.UUIDField(db_index=True, default=uuid.uuid4, editable=False, primary_key=True, serialize=False, unique=True)),
                ("file_name", models.CharField(max_length=255)),
                ("content_type", models.CharField(blank=True, default="", max_length=128)),
                ("file_size", models.PositiveBigIntegerField(default=0)),
                ("asset", models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name="research_outcome_attachments", to="db.fileasset")),
                ("created_by", models.ForeignKey(null=True, on_delete=django.db.models.deletion.SET_NULL, related_name="%(class)s_created_by", to=settings.AUTH_USER_MODEL, verbose_name="Created By")),
                ("outcome", models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name="attachments", to="db.researchoutcome")),
                ("updated_by", models.ForeignKey(null=True, on_delete=django.db.models.deletion.SET_NULL, related_name="%(class)s_updated_by", to=settings.AUTH_USER_MODEL, verbose_name="Last Modified By")),
            ],
            options={"db_table": "research_outcome_attachments", "ordering": ("-created_at",)},
        ),
        migrations.AddConstraint(
            model_name="researchoutcomeattachment",
            constraint=models.UniqueConstraint(fields=("outcome", "asset"), name="rsch_outcome_attachment_uq"),
        ),
    ]
