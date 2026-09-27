# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Migrate the live public org tree onto two direction nodes."""

import json
from pathlib import Path

from django.core.management.base import BaseCommand, CommandError

from plane.db.models import Workspace
from plane.research.services.pi_lab_direction_migration import (
    PiLabDirectionMigrationError,
    apply_direction_migration,
    capture_snapshot,
    plan_direction_migration,
    restore_direction_snapshot,
    verify_direction_migration,
)
from plane.research.utils.roles import PUBLIC_WORKSPACE_SLUG


class Command(BaseCommand):
    """重挂 public 的方向节点。不重建基线，也不清理已有课题。"""

    help = "把 public 的 21 个小组挂到基础研究和产业化之下，并停用空的验证单元。"

    def add_arguments(self, parser):
        """注册 dry-run、apply、verify 和 rollback。"""
        parser.add_argument("--workspace", default=PUBLIC_WORKSPACE_SLUG)
        parser.add_argument("--snapshot", type=Path)
        parser.add_argument("--json", action="store_true")
        mode = parser.add_mutually_exclusive_group(required=True)
        mode.add_argument("--dry-run", action="store_true")
        mode.add_argument("--apply", action="store_true")
        mode.add_argument("--verify", action="store_true")
        mode.add_argument("--rollback", action="store_true")

    def handle(self, *args, **options):
        """执行一种迁移模式。

        Args:
            *args: Django 传入的位置参数。
            **options: 命令行选项。
        """
        try:
            self._handle(options)
        except PiLabDirectionMigrationError as error:
            raise CommandError(str(error)) from error

    def _handle(self, options):
        """按模式预览、迁移、校验或回滚。"""
        workspace = Workspace.objects.filter(slug=options["workspace"]).first()
        if workspace is None:
            raise CommandError(f"工作区不存在：{options['workspace']}")
        if options["dry_run"]:
            payload = plan_direction_migration(workspace)
        elif options["verify"]:
            payload = verify_direction_migration(workspace)
        elif options["rollback"]:
            payload = restore_direction_snapshot(workspace, self._read_snapshot(options["snapshot"]))
        else:
            snapshot_path = options.get("snapshot")
            if snapshot_path is None:
                raise PiLabDirectionMigrationError("--apply 必须同时给出 --snapshot。")
            snapshot = capture_snapshot(workspace)
            self._write_snapshot(snapshot_path, snapshot)
            payload = apply_direction_migration(workspace, workspace.owner)
            snapshot["created_direction_ids"] = payload["created_direction_ids"]
            self._write_snapshot(snapshot_path, snapshot)
            payload["snapshot"] = str(snapshot_path)
        self._emit(options, payload)

    def _read_snapshot(self, path: Path | None) -> dict:
        """读取回滚快照。

        Args:
            path: 快照文件路径。

        Returns:
            快照对象。
        """
        if path is None or not path.is_file():
            raise PiLabDirectionMigrationError("--rollback 必须指向已有的 --snapshot 文件。")
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as error:
            raise PiLabDirectionMigrationError(f"无法读取组织迁移快照：{error}") from error
        if not isinstance(payload, dict):
            raise PiLabDirectionMigrationError("组织迁移快照格式不正确。")
        return payload

    @staticmethod
    def _write_snapshot(path: Path, payload: dict):
        """把快照写到调用方指定的路径。"""
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True), encoding="utf-8")

    def _emit(self, options, payload):
        """输出 JSON。默认也使用 JSON，避免把邮箱混进说明文字。"""
        text = json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True)
        if options["json"]:
            self.stdout.write(text)
            return
        self.stdout.write(self.style.SUCCESS("π-Lab direction migration completed"))
        self.stdout.write(text)
