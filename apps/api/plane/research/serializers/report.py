# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

from rest_framework import serializers

from plane.db.models import (
    PeriodicReport,
    PeriodicReportReadReceipt,
    ReportAccessGrant,
    ReportReviewLog,
)

from plane.research.utils.reports import supervisor_reader_ids

from .org import ResearchUserSerializer


class ReportReviewLogSerializer(serializers.ModelSerializer):
    actor_detail = ResearchUserSerializer(source="actor", read_only=True)

    class Meta:
        model = ReportReviewLog
        fields = [
            "id",
            "report",
            "actor",
            "actor_detail",
            "action",
            "from_status",
            "to_status",
            "comment",
            "snapshot_version",
            "created_at",
        ]
        read_only_fields = fields


class ReportAccessGrantSerializer(serializers.ModelSerializer):
    class Meta:
        model = ReportAccessGrant
        fields = [
            "id",
            "grantee_user",
            "grantee_org_unit",
            "granted_by",
            "expires_at",
            "is_revoked",
            "created_at",
        ]
        read_only_fields = ["id", "granted_by", "created_at"]


class PeriodicReportReadReceiptSerializer(serializers.ModelSerializer):
    """Append-only read facts returned only to receipt-summary viewers."""

    reader_detail = ResearchUserSerializer(source="reader", read_only=True)

    class Meta:
        model = PeriodicReportReadReceipt
        fields = [
            "id",
            "report",
            "reader",
            "reader_detail",
            "snapshot_version",
            "read_at",
            "source",
        ]
        read_only_fields = fields


class PeriodicReportSerializer(serializers.ModelSerializer):
    owner_detail = ResearchUserSerializer(source="owner", read_only=True)
    org_unit_detail = serializers.SerializerMethodField()
    can_edit = serializers.SerializerMethodField()
    can_delete = serializers.SerializerMethodField()
    can_review = serializers.SerializerMethodField()
    attachment_count = serializers.SerializerMethodField()
    team_projects = serializers.SerializerMethodField()
    latest_official_version = serializers.SerializerMethodField()
    has_read = serializers.SerializerMethodField()
    read_count = serializers.SerializerMethodField()
    latest_read_at = serializers.SerializerMethodField()
    official_content = serializers.SerializerMethodField()
    draft_content = serializers.SerializerMethodField()
    page_project = serializers.SerializerMethodField()

    class Meta:
        model = PeriodicReport
        fields = [
            "id",
            "workspace",
            "project",
            "team_projects",
            "owner",
            "owner_detail",
            "org_unit",
            "org_unit_detail",
            "page",
            "page_project",
            "report_type",
            "period_key",
            "period_start",
            "period_end",
            "timezone",
            "status",
            "visibility",
            "is_backfill",
            "submitted_at",
            "accepted_at",
            "reviewer",
            "created_at",
            "updated_at",
            "can_edit",
            "can_delete",
            "can_review",
            "attachment_count",
            "latest_official_version",
            "has_read",
            "read_count",
            "latest_read_at",
            "official_content",
            "draft_content",
        ]
        read_only_fields = ["id", "created_at", "updated_at"]

    def get_org_unit_detail(self, obj):
        if not obj.org_unit_id or obj.org_unit is None:
            return None
        return {"id": str(obj.org_unit_id), "name": obj.org_unit.name, "unit_type": obj.org_unit.unit_type}

    def get_can_edit(self, obj):
        request = self.context.get("request")
        if request is None:
            return False
        return bool(obj.owner_id == request.user.id and obj.status in ("DRAFT", "NEEDS_REVISION"))

    def get_can_review(self, obj):
        context = self.context.get("actor_context")
        if context is None:
            return False
        from plane.research.utils.acl import check_access
        from plane.research.utils.reports import report_resource

        request = self.context.get("request")
        if request is None:
            return False
        return check_access(request.user, "review", report_resource(obj), context=context)

    def get_can_delete(self, obj):
        request = self.context.get("request")
        return bool(request and obj.owner_id == request.user.id and obj.status == "DRAFT" and not obj.submitted_at)

    def get_attachment_count(self, obj):
        prefetched = getattr(obj, "_prefetched_objects_cache", {}).get("attachments")
        return len(prefetched) if prefetched is not None else obj.attachments.count()

    def get_team_projects(self, obj):
        prefetched = getattr(obj, "_prefetched_objects_cache", {}).get("team_projects")
        if prefetched is not None:
            return [str(project.id) for project in prefetched]
        return [str(item) for item in obj.team_projects.values_list("id", flat=True)]

    def _official_snapshot(self, obj):
        if not hasattr(obj, "_latest_official_snapshot"):
            prefetched = getattr(obj, "_prefetched_objects_cache", {}).get("official_snapshots")
            if prefetched is not None:
                obj._latest_official_snapshot = (
                    max(prefetched, key=lambda snapshot: snapshot.version_no) if prefetched else None
                )
            else:
                obj._latest_official_snapshot = obj.official_snapshots.order_by("-version_no").first()
        return obj._latest_official_snapshot

    def get_latest_official_version(self, obj):
        snapshot = self._official_snapshot(obj)
        return snapshot.version_no if snapshot else None

    def _latest_read_receipts(self, obj):
        snapshot = self._official_snapshot(obj)
        if snapshot is None:
            return []
        prefetched = getattr(obj, "_prefetched_objects_cache", {}).get("read_receipts")
        if prefetched is not None:
            return [receipt for receipt in prefetched if receipt.snapshot_version == snapshot.version_no]
        return list(obj.read_receipts.filter(snapshot_version=snapshot.version_no))

    def get_has_read(self, obj):
        request = self.context.get("request")
        if request is None or request.user is None or not request.user.is_authenticated:
            return False
        receipts = self._latest_read_receipts(obj)
        return any(receipt.reader_id == request.user.id for receipt in receipts)

    def _supervisor_read_receipts(self, obj):
        """Receipts from the author's mentors and the main PI — the only
        readers that light the author-facing mentor-read badge."""
        receipts = self._latest_read_receipts(obj)
        if not receipts:
            return []
        supervisor_ids = supervisor_reader_ids(
            obj,
            self.context.get("actor_context"),
            mentor_cache=self.context.get("mentor_cache"),
        )
        return [receipt for receipt in receipts if receipt.reader_id in supervisor_ids]

    def get_read_count(self, obj):
        return len(self._supervisor_read_receipts(obj))

    def get_latest_read_at(self, obj):
        receipts = self._supervisor_read_receipts(obj)
        return max((receipt.read_at for receipt in receipts), default=None)

    def get_official_content(self, obj):
        request = self.context.get("request")
        if request is None or obj.owner_id == request.user.id:
            return None
        snapshot = self._official_snapshot(obj)
        if snapshot is None:
            return None
        return {
            "version_no": snapshot.version_no,
            "description_json": snapshot.description_json,
            "description_html": snapshot.description_html,
            "description_stripped": snapshot.description_stripped,
        }

    def get_draft_content(self, obj):
        request = self.context.get("request")
        if (
            request is None
            or obj.owner_id != request.user.id
            or not self.context.get("include_draft_content", False)
        ):
            return None
        return {
            "description_json": obj.page.description_json,
            "description_html": obj.page.description_html,
            "description_stripped": obj.page.description_stripped,
        }

    def get_page_project(self, obj):
        prefetched = getattr(obj.page, "_prefetched_objects_cache", {}).get("project_pages")
        if prefetched is not None:
            project_id = next((link.project_id for link in prefetched if link.deleted_at is None), None)
        else:
            project_id = (
                obj.page.project_pages.filter(deleted_at__isnull=True)
                .values_list("project_id", flat=True)
                .first()
            )
        return str(project_id) if project_id else None
