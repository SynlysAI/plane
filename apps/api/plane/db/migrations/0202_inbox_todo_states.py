# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

import django.db.models.deletion
import hashlib
import json
import uuid
from django.conf import settings
from django.db import migrations, models


def _todo_fingerprint(todo):
    """Build the rollout fingerprint for one historical todo.

    Args:
        todo: One ``research-todo.v2`` envelope.

    Returns:
        SHA-256 digest matching the inbox service fingerprint.
    """
    fingerprint = {
        "business_status": todo.get("business_status"),
        "handling_status": todo.get("handling_status"),
        "next_action": todo.get("next_action"),
        "due_at": todo.get("due_at"),
        "updated_at": todo.get("updated_at"),
        "assignees": todo.get("assignees"),
    }
    encoded = json.dumps(fingerprint, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def bootstrap_existing_todos_as_read(apps, schema_editor):
    """Mark todos existing before inbox rollout as already read.

    Args:
        apps: Migration application registry.
        schema_editor: Database schema editor for the current connection.

    Returns:
        Nothing; receiver states are inserted in batches.
    """
    from django.utils import timezone

    from plane.db.models import WorkspaceMember
    from plane.research.services.research_todos import collect_research_todos

    inbox_state = apps.get_model("db", "InboxTodoState")
    rows = []
    now = timezone.now()
    memberships = (
        WorkspaceMember.objects.filter(
            is_active=True,
            deleted_at__isnull=True,
            member__is_active=True,
        )
        .exclude(member__is_bot=True)
        .select_related("workspace", "member")
    )
    for membership in memberships.iterator(chunk_size=200):
        try:
            todos, _ = collect_research_todos(membership.workspace, membership.member, "to_me")
        except Exception:
            # A degraded source must not block the inbox migration. Its current
            # todos will still project normally after deployment.
            continue
        for todo in todos:
            rows.append(
                inbox_state(
                    workspace_id=membership.workspace_id,
                    receiver_id=membership.member_id,
                    source=todo["source"],
                    object_id=str(todo["object_id"]),
                    dedupe_key=f"todo:{todo['source']}:{todo['object_id']}",
                    payload_hash=_todo_fingerprint(todo),
                    read_at=now,
                    last_seen_at=now,
                )
            )
    inbox_state.objects.bulk_create(rows, ignore_conflicts=True, batch_size=500)


def remove_inbox_todo_states(apps, schema_editor):
    """Remove all inbox state rows with the model table.

    Args:
        apps: Migration application registry.
        schema_editor: Database schema editor for the current connection.
    """
    apps.get_model("db", "InboxTodoState").objects.all().delete()


class Migration(migrations.Migration):
    """Add presentation state for dynamically projected inbox todos."""

    dependencies = [
        ("db", "0201_asset_preview_chain_upload"),
    ]

    operations = [
        migrations.CreateModel(
            name="InboxTodoState",
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
                ("source", models.CharField(max_length=64)),
                ("object_id", models.CharField(max_length=255)),
                ("dedupe_key", models.CharField(max_length=512)),
                ("payload_hash", models.CharField(max_length=128)),
                ("read_at", models.DateTimeField(null=True)),
                ("archived_at", models.DateTimeField(null=True)),
                ("snoozed_till", models.DateTimeField(null=True)),
                ("last_seen_at", models.DateTimeField(null=True)),
                ("last_reminder_key", models.CharField(blank=True, default="", max_length=255)),
                ("last_reminder_at", models.DateTimeField(null=True)),
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
                    "receiver",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="inbox_todo_states",
                        to=settings.AUTH_USER_MODEL,
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
                    "workspace",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="inbox_todo_states",
                        to="db.workspace",
                    ),
                ),
            ],
            options={
                "verbose_name": "Inbox Todo State",
                "verbose_name_plural": "Inbox Todo States",
                "db_table": "inbox_todo_states",
                "ordering": ("-updated_at",),
            },
        ),
        migrations.AddConstraint(
            model_name="inboxtodostate",
            constraint=models.UniqueConstraint(
                fields=("workspace", "receiver", "source", "object_id"),
                name="inbox_todo_state_unique_item",
            ),
        ),
        migrations.AddIndex(
            model_name="inboxtodostate",
            index=models.Index(
                fields=("workspace", "receiver", "read_at"),
                name="inbox_todo_state_read_idx",
            ),
        ),
        migrations.AddIndex(
            model_name="inboxtodostate",
            index=models.Index(
                fields=("workspace", "receiver", "archived_at", "snoozed_till"),
                name="inbox_todo_state_state_idx",
            ),
        ),
        migrations.RunPython(bootstrap_existing_todos_as_read, remove_inbox_todo_states),
    ]
