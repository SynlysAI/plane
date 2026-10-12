"""Phase 1.6 L1 领域模型的数据库契约测试。"""

from uuid import uuid4

import pytest
from django.core.exceptions import ValidationError
from django.db import IntegrityError
from django.db import transaction
from django.utils import timezone

from plane.db.models import FileAsset, ResearchChainNode
from plane.tests.research_fixtures import make_research_boundary_fixture

pytestmark = [pytest.mark.unit, pytest.mark.django_db]


def make_review_asset(fixture, name="paper-v1.pdf"):
    """创建论文评审版本使用的文件资产。

    Args:
        fixture: Phase 1.6 L0 边界夹具。
        name: 文件展示名。

    Returns:
        已保存的 FileAsset 对象。
    """
    return FileAsset.objects.create(
        workspace=fixture["workspace"],
        user=fixture["student"],
        created_by=fixture["student"],
        asset=f"{fixture['workspace'].id}/{uuid4().hex}-{name}",
        size=1024,
        attributes={"name": name, "type": "application/pdf"},
        entity_type=FileAsset.EntityTypeContext.REPORT_ATTACHMENT,
        entity_identifier=str(fixture["paper_node"].id),
        is_uploaded=True,
    )


def test_chain_node_task_freezes_resource_and_status_contract():
    """任务保持独立状态并强制资源类型与资源 ID 成对出现。"""
    fixture = make_research_boundary_fixture()
    task = fixture["paper_node"].tasks.create(
        workspace=fixture["workspace"],
        chain=fixture["chain"],
        title="Revise discussion section",
        instruction="Address reviewer comments.",
        status="ASSIGNED",
        assignee=fixture["student"],
        assigned_by=fixture["advisor"],
        resource_type="NONE",
        resource_id=None,
        request_id=f"task-{uuid4().hex}",
        payload_hash="a" * 64,
        metadata={"source": "contract-test"},
    )

    assert task.status == "ASSIGNED"
    assert fixture["chain"].node_tasks.filter(id=task.id).exists()

    missing_resource = dict(resource_type="REPORT", resource_id=None)
    orphan_resource = dict(resource_type="NONE", resource_id=uuid4())
    for invalid_resource in (missing_resource, orphan_resource):
        invalid_task = fixture["paper_node"].tasks.model(
            workspace=fixture["workspace"],
            chain=fixture["chain"],
            node=fixture["paper_node"],
            title="Invalid resource",
            resource_type=invalid_resource["resource_type"],
            resource_id=invalid_resource["resource_id"],
            request_id=f"task-{uuid4().hex}",
            payload_hash="b" * 64,
        )
        with pytest.raises(ValidationError):
            invalid_task.full_clean()


def test_periodic_report_read_receipt_is_append_only_and_official_only():
    """已读回执只能追加，且只能挂在已提交报告上。"""
    fixture = make_research_boundary_fixture()
    receipt = fixture["report"].read_receipts.create(
        reader=fixture["advisor"],
        snapshot_version=fixture["snapshot"].version_no,
        source="DETAIL_VIEW",
    )

    assert receipt.read_at is not None
    with pytest.raises(TypeError):
        receipt.snapshot_version = 2
        receipt.save()
    with pytest.raises(TypeError):
        receipt.delete()
    with pytest.raises(TypeError):
        fixture["report"].read_receipts.update(snapshot_version=2)
    with pytest.raises(TypeError):
        fixture["report"].read_receipts.delete()

    fixture["report"].submitted_at = None
    with pytest.raises(ValidationError):
        fixture["report"].read_receipts.create(
            reader=fixture["workspace_admin"],
            snapshot_version=3,
        )


def test_paper_review_requires_paper_writing_node_and_versions_are_append_only():
    """论文评审绑定写作节点，版本记录不可修改或删除。"""
    fixture = make_research_boundary_fixture()
    review = fixture["paper_node"].paper_reviews.create(
        workspace=fixture["workspace"],
        chain=fixture["chain"],
        owner=fixture["student"],
        final_reviewer=fixture["advisor"],
        status="WAITING_REVIEW",
        current_version_no=1,
        request_id=f"review-{uuid4().hex}",
        payload_hash="c" * 64,
        metadata={
            "owner_id_snapshot": str(fixture["student"].id),
            "final_reviewer_id_snapshot": str(fixture["advisor"].id),
        },
    )
    asset = make_review_asset(fixture)
    version = review.versions.create(
        version_no=1,
        asset=asset,
        file_name="paper-v1.pdf",
        content_type="application/pdf",
        file_size=1024,
        change_summary="Address methodology comments.",
        status="SUBMITTED",
        submitted_by=fixture["student"],
        submitted_at=timezone.now(),
        content_hash="d" * 64,
        request_id=f"review-version-{uuid4().hex}",
    )

    assert version.review_id == review.id
    with pytest.raises(IntegrityError):
        with transaction.atomic():
            review.versions.create(
                version_no=1,
                asset=asset,
                file_name="duplicate.pdf",
                content_type="application/pdf",
                file_size=1024,
                change_summary="Duplicate version.",
                status="SUBMITTED",
                submitted_by=fixture["student"],
                submitted_at=timezone.now(),
                content_hash="e" * 64,
                request_id=f"review-version-{uuid4().hex}",
            )
    with pytest.raises(TypeError):
        version.change_summary = "Tampered."
        version.save()
    with pytest.raises(TypeError):
        version.delete()

    literature_node = ResearchChainNode.objects.create(
        chain=fixture["chain"],
        node_type="LITERATURE_REVIEW",
        title="Literature review",
        loop_iteration=1,
        request_id=f"node-{uuid4().hex}",
        payload_hash="f" * 64,
    )
    invalid_review = literature_node.paper_reviews.model(
        workspace=fixture["workspace"],
        chain=fixture["chain"],
        node=literature_node,
        owner=fixture["student"],
        request_id=f"review-{uuid4().hex}",
        payload_hash="1" * 64,
    )
    with pytest.raises(ValidationError):
        invalid_review.full_clean()
