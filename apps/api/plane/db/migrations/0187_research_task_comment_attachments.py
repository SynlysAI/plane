import django.db.models.deletion
import uuid
from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("db", "0186_administrative_flow_is_template"),
    ]

    operations = [
        migrations.CreateModel(
            name="ResearchTaskCommentAttachment",
            fields=[
                ("created_at", models.DateTimeField(auto_now_add=True, verbose_name="Created At")),
                ("updated_at", models.DateTimeField(auto_now=True, verbose_name="Last Modified At")),
                ("deleted_at", models.DateTimeField(blank=True, null=True, verbose_name="Deleted At")),
                (
                    "id",
                    models.UUIDField(
                        db_index=True,
                        default=uuid.uuid4,
                        editable=False,
                        primary_key=True,
                        serialize=False,
                        unique=True,
                    ),
                ),
                ("file_name", models.CharField(blank=True, default="", max_length=500)),
                ("file_size", models.BigIntegerField(default=0)),
                ("content_type", models.CharField(blank=True, default="", max_length=255)),
                (
                    "comment",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="attachments",
                        to="db.researchtaskcomment",
                    ),
                ),
                (
                    "asset",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="research_task_comment_attachments",
                        to="db.fileasset",
                    ),
                ),
                (
                    "created_by",
                    models.ForeignKey(
                        null=True,
                        on_delete=django.db.models.deletion.SET_NULL,
                        related_name="%(class)s_created_by",
                        to=settings.AUTH_USER_MODEL,
                        verbose_name="Created By",
                    ),
                ),
                (
                    "updated_by",
                    models.ForeignKey(
                        null=True,
                        on_delete=django.db.models.deletion.SET_NULL,
                        related_name="%(class)s_updated_by",
                        to=settings.AUTH_USER_MODEL,
                        verbose_name="Last Modified By",
                    ),
                ),
                (
                    "uploaded_by",
                    models.ForeignKey(
                        null=True,
                        on_delete=django.db.models.deletion.SET_NULL,
                        related_name="research_task_comment_attachments",
                        to=settings.AUTH_USER_MODEL,
                    ),
                ),
            ],
            options={
                "verbose_name": "Research Task Comment Attachment",
                "verbose_name_plural": "Research Task Comment Attachments",
                "db_table": "research_task_comment_attachments",
                "ordering": ("created_at", "id"),
                "indexes": [
                    models.Index(fields=["comment", "asset"], name="rsch_task_comment_att_idx"),
                ],
            },
        ),
        migrations.AddConstraint(
            model_name="researchtaskcommentattachment",
            constraint=models.UniqueConstraint(
                condition=models.Q(("deleted_at__isnull", True)),
                fields=("comment", "asset"),
                name="rsch_task_comment_attachment_uq",
            ),
        ),
    ]
