# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

import django.db.models.deletion
import uuid
from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):
    """Add workspace operations accounts and persisted feedback replies."""

    dependencies = [
        ("db", "0191_merge_retire_and_mcp_settings"),
        ("db", "0196_system_announcements"),
    ]

    operations = [
        migrations.AddField(
            model_name="workspacemember",
            name="is_operations_account",
            field=models.BooleanField(default=False),
        ),
        migrations.CreateModel(
            name="ResearchFeedbackReply",
            fields=[
                (
                    "created_at",
                    models.DateTimeField(auto_now_add=True, verbose_name="Created At"),
                ),
                (
                    "updated_at",
                    models.DateTimeField(auto_now=True, verbose_name="Last Modified At"),
                ),
                (
                    "deleted_at",
                    models.DateTimeField(blank=True, null=True, verbose_name="Deleted At"),
                ),
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
                ("content", models.TextField()),
                ("author_name", models.CharField(max_length=255)),
                (
                    "feedback",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="replies",
                        to="db.researchfeedback",
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
            ],
            options={
                "verbose_name": "Research Feedback Reply",
                "verbose_name_plural": "Research Feedback Replies",
                "db_table": "research_feedback_replies",
                "ordering": ("created_at", "id"),
            },
        ),
        migrations.AddIndex(
            model_name="researchfeedbackreply",
            index=models.Index(
                fields=["feedback", "created_at"],
                name="rsch_fb_reply_created_idx",
            ),
        ),
    ]
