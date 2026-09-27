# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Register the dev RAGPortal and Synlora connections for public."""

import json

from django.core.management.base import BaseCommand, CommandError

from plane.db.models import Workspace
from plane.research.services.workspace_integration_registration import (
    WorkspaceIntegrationRegistrationError,
    register_workspace_integrations,
)
from plane.research.utils.roles import PUBLIC_WORKSPACE_SLUG


class Command(BaseCommand):
    """登记 public 的 RAGPortal 和 Synlora。不输出密钥。"""

    help = "幂等登记 public 的 RAGPortal 与 Synlora，并做健康检查。"

    def add_arguments(self, parser):
        """注册预览、登记、停用和地址覆盖。"""
        parser.add_argument("--workspace", default=PUBLIC_WORKSPACE_SLUG)
        parser.add_argument("--dry-run", action="store_true")
        parser.add_argument("--disable", action="store_true")
        parser.add_argument("--ragportal-url", default="")
        parser.add_argument("--synlora-url", default="")
        parser.add_argument("--json", action="store_true")

    def handle(self, *args, **options):
        """登记或停用两个连接。

        Args:
            *args: Django 位置参数。
            **options: 命令行选项。
        """
        workspace = Workspace.objects.filter(slug=options["workspace"]).first()
        if workspace is None:
            raise CommandError(f"工作区不存在：{options['workspace']}")
        try:
            payload = register_workspace_integrations(
                workspace,
                base_urls={
                    "RAGPORTAL": options["ragportal_url"],
                    "SYNLORA": options["synlora_url"],
                },
                disable=options["disable"],
                dry_run=options["dry_run"],
            )
        except WorkspaceIntegrationRegistrationError as error:
            raise CommandError(str(error)) from error
        self.stdout.write(json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True))
