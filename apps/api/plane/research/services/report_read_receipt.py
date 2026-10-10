# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Append-only read receipts for official periodic-report versions."""

from django.db import transaction

from plane.db.models import PeriodicReport, PeriodicReportReadReceipt


class ReportReadUnavailable(Exception):
    """Raised when a report has no official snapshot to read."""


def latest_official_snapshot(report):
    """Return the newest immutable snapshot for a report without mutating it."""
    return report.official_snapshots.order_by("-version_no").first()


def record_report_read(*, report, actor, snapshot_version=None):
    """Append one idempotent read fact for the latest official report version.

    Args:
        report: Visible periodic report being opened.
        actor: Authenticated reader; callers must already exclude the author.
        snapshot_version: Optional explicit version, otherwise the latest official one.

    Returns:
        The existing receipt when the reader/version pair already exists.
    """
    with transaction.atomic():
        locked_report = (
            PeriodicReport.objects.select_for_update(of=("self",)).select_related("workspace").get(pk=report.pk)
        )
        snapshot = latest_official_snapshot(locked_report)
        if snapshot is None or (snapshot_version is not None and snapshot.version_no != snapshot_version):
            raise ReportReadUnavailable

        receipt, _ = PeriodicReportReadReceipt.objects.get_or_create(
            report=locked_report,
            reader=actor,
            snapshot_version=snapshot.version_no,
            defaults={
                "source": PeriodicReportReadReceipt.Source.DETAIL_VIEW,
            },
        )
        return receipt
