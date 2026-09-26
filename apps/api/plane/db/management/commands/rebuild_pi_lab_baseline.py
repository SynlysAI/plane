"""Rebuild the locked π-Lab baseline after a verified instance backup."""

import json
from pathlib import Path

from django.core.management.base import BaseCommand, CommandError
from django.db import transaction

from plane.db.models import Workspace, WorkspaceMember
from plane.research.services.pi_lab_baseline import (
    PiLabBaselineError,
    build_pi_lab_baseline,
    collect_research_asset_paths,
    delete_research_asset_objects,
    export_research_history,
    load_pi_lab_plan,
    purge_instance_research_data,
    verify_pi_lab_baseline,
    verify_pi_lab_source_files,
    write_credential_manifest,
)
from plane.research.utils.roles import PUBLIC_WORKSPACE_SLUG

WORKSPACE_ADMIN_ROLE = 20


class Command(BaseCommand):
    help = "Validate backups and rebuild the real π-Lab account/organization baseline"

    def add_arguments(self, parser):
        parser.add_argument("--workspace", default=PUBLIC_WORKSPACE_SLUG)
        parser.add_argument("--students", type=Path, default=Path("/refer/π-Lab学生-导入信息表.xlsx"))
        parser.add_argument("--advisors", type=Path, default=Path("/refer/导师信息表.xlsx"))
        parser.add_argument("--backup-manifest", type=Path)
        parser.add_argument("--credential-manifest", type=Path)
        parser.add_argument("--overwrite-credentials", action="store_true")
        parser.add_argument("--json", action="store_true")
        mode = parser.add_mutually_exclusive_group(required=True)
        mode.add_argument("--dry-run", action="store_true")
        mode.add_argument("--verify", action="store_true")
        mode.add_argument("--yes", action="store_true")

    def handle(self, *args, **options):
        try:
            self._handle(options)
        except PiLabBaselineError as error:
            raise CommandError(str(error)) from error

    def _handle(self, options):
        workspace = Workspace.objects.filter(slug=options["workspace"]).first()
        if workspace is None:
            raise CommandError(f"workspace '{options['workspace']}' does not exist")
        if workspace.slug != PUBLIC_WORKSPACE_SLUG:
            raise PiLabBaselineError("π-Lab baseline may only target the public workspace.")

        verify_pi_lab_source_files(options["students"], options["advisors"])
        plan = load_pi_lab_plan(options["students"], options["advisors"])
        plan_report = {
            "source_students": plan.expected.original_student_rows,
            "imported_students": len(plan.students),
            "excluded_students": list(plan.excluded_students),
            "imported_advisors": len(plan.advisor_mapping),
            "teams": len(plan.team_directions),
            "primary_relation_gaps": len(plan.primary_relation_gaps),
            "co_advisor_reference_gaps": len(plan.co_advisor_reference_gaps),
        }
        if options["dry_run"]:
            self._write(options, {"mode": "dry-run", "plan": plan_report})
            return
        if options["verify"]:
            report = verify_pi_lab_baseline(workspace, plan)
            self._write(options, {"mode": "verify", "baseline": report})
            return

        backup_manifest = options.get("backup_manifest")
        credential_manifest = options.get("credential_manifest")
        if backup_manifest is None or credential_manifest is None:
            raise PiLabBaselineError("--yes requires both --backup-manifest and --credential-manifest.")
        self._validate_backup(backup_manifest)
        if credential_manifest.exists() and not options["overwrite_credentials"]:
            raise PiLabBaselineError(f"credential manifest already exists: {credential_manifest}")
        if options["overwrite_credentials"]:
            credential_manifest.unlink(missing_ok=True)

        actor = self._actor(workspace)
        history_dir = backup_manifest.resolve().parent / "history"
        exported = export_research_history(history_dir)
        storage_paths = collect_research_asset_paths()
        credential_path_written = False
        try:
            with transaction.atomic():
                deleted = purge_instance_research_data()
                rebuilt = build_pi_lab_baseline(workspace, actor, plan)
                baseline = verify_pi_lab_baseline(workspace, plan)
                write_credential_manifest(credential_manifest, rebuilt.credentials)
                credential_path_written = True
        except Exception:
            if credential_path_written:
                credential_manifest.unlink(missing_ok=True)
            raise

        deleted_objects = delete_research_asset_objects(storage_paths)
        result = {
            "mode": "rebuild",
            "backup_manifest": str(backup_manifest),
            "history_export": exported,
            "deleted": deleted,
            "deleted_storage_objects": len(deleted_objects),
            "created": {
                "users": rebuilt.users_created,
                "workspace_members": rebuilt.workspace_members,
                "org_units": rebuilt.org_units_created,
                "org_members": rebuilt.org_members_created,
                "mentor_bindings": rebuilt.mentor_bindings_created,
                "one_time_credentials": len(rebuilt.credentials),
            },
            "credential_manifest": str(credential_manifest),
            "baseline": baseline,
        }
        self._write(options, result)

    def _actor(self, workspace):
        """Use the workspace owner or first active administrator as rebuild actor."""
        actor = workspace.owner
        if actor is None or not actor.is_active:
            actor = (
                WorkspaceMember.objects.filter(
                    workspace=workspace,
                    role=WORKSPACE_ADMIN_ROLE,
                    is_active=True,
                    member__is_active=True,
                )
                .order_by("created_at")
                .select_related("member")
                .first()
            )
            actor = actor.member if actor else None
        if actor is None:
            raise PiLabBaselineError("public workspace has no active owner/administrator actor.")
        return actor

    def _validate_backup(self, manifest_path: Path):
        """Verify that the backup manifest and its artifacts are complete and drilled."""
        try:
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as error:
            raise PiLabBaselineError(f"backup manifest is unreadable: {error}") from error
        if manifest.get("schema_version") != 1:
            raise PiLabBaselineError("backup manifest schema_version must be 1.")
        if manifest.get("status") != "VERIFIED":
            raise PiLabBaselineError("backup status must be VERIFIED.")
        if manifest.get("restore_drill", {}).get("status") != "PASSED":
            raise PiLabBaselineError("backup restore drill did not pass.")
        for key in ("database", "objects"):
            artifact = manifest.get(key)
            if not isinstance(artifact, dict):
                raise PiLabBaselineError(f"backup manifest lacks {key} artifact.")
            path = self._artifact_path(manifest_path, artifact.get("path", ""))
            if not path.is_file():
                raise PiLabBaselineError(f"backup artifact does not exist: {path}")
            if self._sha256(path) != artifact.get("sha256"):
                raise PiLabBaselineError(f"backup artifact hash mismatch: {path}")

    @staticmethod
    def _artifact_path(manifest_path: Path, relative: str) -> Path:
        """Resolve one artifact below the manifest directory without traversal."""
        base = manifest_path.resolve().parent
        path = (base / relative).resolve()
        if path == base or base not in path.parents:
            raise PiLabBaselineError(f"unsafe backup artifact path: {relative}")
        return path

    @staticmethod
    def _sha256(path: Path) -> str:
        """Hash one backup artifact."""
        import hashlib

        digest = hashlib.sha256()
        with path.open("rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(chunk)
        return digest.hexdigest()

    def _write(self, options, payload):
        """Emit machine-readable JSON or concise human output."""
        if options["json"]:
            self.stdout.write(json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True, default=str))
            return
        self.stdout.write(self.style.SUCCESS("π-Lab baseline operation completed"))
        self.stdout.write(json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True, default=str))
