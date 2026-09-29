# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Confirm one uniquely named RAGPortal library for a research team."""

import json

from django.core.management.base import BaseCommand, CommandError

from plane.db.models import OrgUnit, Workspace
from plane.research.services.group_knowledge import (
    GroupKnowledgeConfirmError,
    confirm_group_binding,
    describe_ragportal_candidates,
)
from plane.research.utils.roles import PUBLIC_WORKSPACE_SLUG


class Command(BaseCommand):
    """按唯一库名确认小组知识库。不提供默认库名。"""

    help = "从 RAGPortal 候选中按唯一名称确认一个小组知识库。"

    def add_arguments(self, parser):
        """注册工作区、小组、唯一库名和预览。"""
        parser.add_argument("--workspace", default=PUBLIC_WORKSPACE_SLUG)
        parser.add_argument("--team", required=True)
        parser.add_argument("--unique-name", required=True)
        parser.add_argument("--dry-run", action="store_true")
        parser.add_argument("--json", action="store_true")

    def handle(self, *args, **options):
        """预览或确认。候选不唯一时不写入。

        Args:
            *args: Django 位置参数。
            **options: 命令行选项。
        """
        workspace = Workspace.objects.filter(slug=options["workspace"]).first()
        if workspace is None or workspace.slug != PUBLIC_WORKSPACE_SLUG:
            raise CommandError("器件库确认只能作用于 public 工作区。")
        team_name = str(options["team"]).strip()
        unique_name = str(options["unique_name"]).strip()
        if not team_name or not unique_name:
            raise CommandError("必须同时给出小组名和唯一库名。")
        team = OrgUnit.objects.filter(
            workspace=workspace,
            name=team_name,
            unit_type=OrgUnit.UnitType.TEAM,
            is_active=True,
            deleted_at__isnull=True,
        ).first()
        if team is None:
            raise CommandError(f"找不到活动小组：{team_name}")
        described = describe_ragportal_candidates(workspace)
        if described["connection_status"] != "connected":
            raise CommandError("RAGPortal 未连接或健康检查未通过，已停止确认。")
        matches = [item for item in described["candidates"] if item["name"] == unique_name]
        payload = {
            "mode": "dry-run" if options["dry_run"] else "apply",
            "team": team.name,
            "unique_name": unique_name,
            "match_count": len(matches),
            "connection_status": described["connection_status"],
        }
        if len(matches) != 1:
            payload["written"] = False
            self._emit(options, payload)
            raise CommandError("候选不唯一或名称不一致，未写入绑定。")
        match = matches[0]
        payload.update(
            {
                "external_id": match["external_id"],
                "source": match["source"],
                "seen_at": match["seen_at"],
            }
        )
        if options["dry_run"]:
            payload["written"] = False
            self._emit(options, payload)
            return
        try:
            binding = confirm_group_binding(
                workspace,
                team,
                match["external_id"],
                match["name"],
                workspace.owner,
                source=match["source"],
                seen_at=match["seen_at"],
            )
        except GroupKnowledgeConfirmError as error:
            raise CommandError(error.message) from error
        payload.update({"written": True, "state": binding.state})
        self._emit(options, payload)

    def _emit(self, options, payload):
        """输出不含文档正文的 JSON。"""
        self.stdout.write(json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True))
