# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only

from django.db import migrations, models


class Migration(migrations.Migration):
    """Store hashed AccountLink verification codes and their expiry."""

    dependencies = [("db", "0148_research_context_grants")]

    operations = [
        migrations.RemoveConstraint(
            model_name="accountlink",
            name="rsch_account_link_uq_identity",
        ),
        migrations.AddField("accountlink", "verification_hash", models.CharField(blank=True, default="", max_length=64)),
        migrations.AddField("accountlink", "verification_expires_at", models.DateTimeField(blank=True, null=True)),
        migrations.AddIndex(
            model_name="accountlink",
            index=models.Index(fields=["provider", "canonical_identity"], name="rsch_account_link_identity_idx"),
        ),
    ]
