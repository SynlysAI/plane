"""验证旧 Plane 清理的预览、科研资源保护及事务回滚。"""

from unittest.mock import patch

import pytest
from django.utils import timezone

from plane.db.models import FileAsset, Issue, Page, PeriodicReport, Project, ProjectPage, ReportAttachment, ResearchChain, ResearchProjectProfile, State
from plane.utils.legacy_plane_cleanup import cleanup_legacy_plane_data

pytestmark = [pytest.mark.unit, pytest.mark.django_db]


@pytest.fixture
def env(workspace, create_user):
    """创建科研项目旧工作项、页面和行政数据。"""
    research = Project.objects.create(workspace=workspace, name="Research", identifier="RES")
    admin = Project.objects.create(workspace=workspace, name="Administrative", identifier="ADM")
    ResearchProjectProfile.objects.create(project=research, workspace=workspace, owner=create_user)
    chain = ResearchChain.objects.create(project=research, workspace=workspace, owner=create_user, request_id="cleanup", payload_hash="hash")
    issues = []
    for project in (research, admin):
        state = State.objects.create(project=project, workspace=workspace, name="Todo", group="backlog")
        issues.append(Issue.objects.create(project=project, workspace=workspace, state=state, name=project.name))
    Issue.all_objects.filter(pk=issues[0].pk).update(deleted_at=timezone.now())
    page = Page.objects.create(workspace=workspace, owned_by=create_user, name="Old page")
    ProjectPage.objects.create(project=research, workspace=workspace, page=page)
    return workspace, research, admin, chain, issues, page


def test_preview_then_apply_preserves_chain_and_admin_and_is_idempotent(env):
    """预览不改变数据，清理包括软删除记录且重复执行为空。"""
    workspace, research, admin, chain, issues, page = env
    preview = cleanup_legacy_plane_data(workspace)
    assert str(issues[0].id) in preview["deletions"]["db.Issue"]
    assert Issue.all_objects.filter(pk=issues[0].id).exists()
    report = cleanup_legacy_plane_data(workspace, apply=True)
    assert report["verified"] and report["deleted_count"] > 0
    assert not Issue.all_objects.filter(pk=issues[0].id).exists()
    assert not Page.all_objects.filter(pk=page.id).exists()
    assert Issue.objects.filter(pk=issues[1].id).exists()
    assert Project.objects.filter(pk__in=[research.id, admin.id]).count() == 2
    assert ResearchChain.objects.filter(pk=chain.id).exists()
    assert cleanup_legacy_plane_data(workspace, apply=True)["deleted_count"] == 0


def test_shared_and_research_referenced_pages_are_preserved(env):
    """行政共享页面和科研 JSON 引用的页面不能删除。"""
    workspace, research, admin, chain, _, page = env
    ProjectPage.objects.create(project=admin, workspace=workspace, page=page)
    referenced = Page.objects.create(workspace=workspace, owned_by=chain.owner, name="Research resource")
    ProjectPage.objects.create(project=research, workspace=workspace, page=referenced)
    ResearchChain.all_objects.filter(pk=chain.id).update(payload_hash=str(referenced.id))
    report = cleanup_legacy_plane_data(workspace, apply=True)
    assert report["verified"]
    assert Page.all_objects.filter(pk__in=[page.id, referenced.id]).count() == 2
    assert ProjectPage.all_objects.filter(page=referenced).exists()


def test_changed_protected_fingerprint_rolls_back(env):
    """清理后保留数据校验失败时整个事务回滚。"""
    workspace, _, _, _, issues, page = env
    with patch("plane.utils.legacy_plane_cleanup.protected_fingerprint", side_effect=[{"before": 1}, {"after": 2}]):
        with pytest.raises(RuntimeError, match="事务已回滚"):
            cleanup_legacy_plane_data(workspace, apply=True)
    assert Issue.all_objects.filter(pk=issues[0].id).exists()
    assert Page.all_objects.filter(pk=page.id).exists()


def test_research_reference_to_old_work_item_aborts(env):
    """科研资源仍引用旧工作项时，清理终止而不破坏引用。"""
    workspace, _, _, chain, issues, _ = env
    ResearchChain.all_objects.filter(pk=chain.id).update(payload_hash=str(issues[0].id))
    with pytest.raises(RuntimeError, match="科研引用"):
        cleanup_legacy_plane_data(workspace, apply=True)
    assert Issue.all_objects.filter(pk=issues[0].id).exists()


def test_report_page_and_parent_are_preserved(env):
    """真实科研报告及其软删除正文和父页面完整保留。"""
    workspace, research, _, chain, _, parent = env
    page = Page.objects.create(
        workspace=workspace, owned_by=chain.owner, name="Report", parent=parent,
        description_binary=b"\x00research report\xff",
    )
    ProjectPage.objects.create(project=research, workspace=workspace, page=page)
    report = PeriodicReport.objects.create(
        workspace=workspace, project=research, owner=chain.owner, page=page,
        report_type="WEEKLY", period_key="2026-W41",
        period_start="2026-10-05", period_end="2026-10-11",
    )
    Page.all_objects.filter(pk=page.id).update(deleted_at=timezone.now())
    result = cleanup_legacy_plane_data(workspace, apply=True)
    assert result["verified"]
    assert PeriodicReport.objects.filter(pk=report.id, page_id=page.id).exists()
    assert Page.all_objects.filter(pk__in=[parent.id, page.id]).count() == 2


def test_administrative_child_reference_aborts_preview(env):
    """科研旧工作项的级联会删除行政子项时，预览立即终止。"""
    workspace, _, _, _, issues, _ = env
    Issue.all_objects.filter(pk=issues[1].id).update(parent_id=issues[0].id)
    with pytest.raises(RuntimeError, match="行政数据"):
        cleanup_legacy_plane_data(workspace)
    assert Issue.all_objects.filter(pk=issues[1].id, parent_id=issues[0].id).exists()


def test_old_attachment_with_empty_research_cascades_is_deleted(env):
    """旧附件没有科研引用时，空的科研级联查询不能阻止清理。"""
    workspace, research, _, _, issues, _ = env
    asset = FileAsset.objects.create(
        workspace=workspace, project=research, issue=issues[0], asset="legacy/attachment.pdf",
    )
    preview = cleanup_legacy_plane_data(workspace)
    assert str(asset.id) in preview["deletions"]["db.FileAsset"]
    result = cleanup_legacy_plane_data(workspace, apply=True)
    assert result["verified"]
    assert not FileAsset.all_objects.filter(pk=asset.id).exists()


def test_referenced_attachment_preserves_its_host_page(env):
    """科研报告引用的附件与其原始页面关联（含软删除引用）完整保留。"""
    workspace, research, _, chain, _, page = env
    body = Page.objects.create(workspace=workspace, owned_by=chain.owner, name="Report body")
    report = PeriodicReport.objects.create(
        workspace=workspace, project=research, owner=chain.owner, page=body,
        report_type="WEEKLY", period_key="2026-W41",
        period_start="2026-10-05", period_end="2026-10-11",
    )
    asset = FileAsset.objects.create(
        workspace=workspace, project=research, page=page, asset="research/attachment.pdf",
    )
    attachment = ReportAttachment.objects.create(report=report, asset=asset)
    ReportAttachment.all_objects.filter(pk=attachment.id).update(deleted_at=timezone.now())
    result = cleanup_legacy_plane_data(workspace, apply=True)
    assert result["verified"]
    assert FileAsset.all_objects.filter(pk=asset.id, page_id=page.id).exists()
    assert Page.all_objects.filter(pk=page.id).exists()
    assert ReportAttachment.all_objects.filter(pk=attachment.id, asset_id=asset.id).exists()
    assert cleanup_legacy_plane_data(workspace)["deletions"] == {}
