# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Backfill verified initial passwords without changing password hashes.

The credentials file is the protected manifest written by a baseline rebuild.
This command copies matching plaintext onto the account-source record used by
the administrator download. It never prints passwords.
"""

import json
from pathlib import Path

from django.core.management.base import BaseCommand, CommandError

from plane.db.models import User, Workspace
from plane.research.services.user_import import backfill_initial_passwords
from plane.research.utils.roles import PUBLIC_WORKSPACE_SLUG


class Command(BaseCommand):
    """把已核对的初始密码回填到账号来源。"""

    help = "Backfill verified initial passwords without changing password hashes."

    def add_arguments(self, parser):
        parser.add_argument("--credentials", required=True, help="protected credentials.json")
        parser.add_argument("--workspace", default=PUBLIC_WORKSPACE_SLUG)
        parser.add_argument("--actor", default="", help="email recorded as the operator")
        parser.add_argument("--dry-run", action="store_true")

    def handle(self, *args, **options):
        path = Path(options["credentials"])
        if not path.is_file():
            raise CommandError(f"Credentials file not found: {path}")
        workspace = Workspace.objects.filter(slug=options["workspace"], deleted_at__isnull=True).first()
        if workspace is None:
            raise CommandError(f"Workspace '{options['workspace']}' does not exist")
        actor = None
        if options["actor"]:
            actor = User.objects.filter(email__iexact=options["actor"]).first()
            if actor is None:
                raise CommandError(f"Actor account '{options['actor']}' does not exist")
        payload = json.loads(path.read_text(encoding="utf-8"))
        accounts = payload.get("accounts") if isinstance(payload, dict) else payload
        if not isinstance(accounts, list):
            raise CommandError("Credentials file does not contain an accounts list.")
        result = backfill_initial_passwords(
            workspace,
            accounts,
            actor=actor,
            dry_run=bool(options["dry_run"]),
        )
        emails = result.pop("skipped_emails")
        for key, value in result.items():
            self.stdout.write(f"{key}={value}")
        for key, values in emails.items():
            if values:
                self.stdout.write(f"{key}_emails={','.join(values)}")
