"""单负责人历史数据迁移的回归测试。"""

from django.apps import apps
from django.db import connection
from django.utils import timezone
from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path
from uuid import uuid4, UUID

from plane.db.models import DraftIssue, DraftIssueAssignee, Issue, IssueAssignee, Project, User, Workspace


def _retain_latest_assignee():
    """加载文件名以数字开头的迁移函数。"""
    path = Path(__file__).parents[3] / "db/migrations/0188_single_work_item_assignee.py"
    spec = spec_from_file_location("single_work_item_assignee_migration", path)
    assert spec is not None and spec.loader is not None
    module = module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.retain_latest_assignee


def _update_created_at(model, row_id, created_at):
    """直接写入创建时间，绕过模型的 auto_now_add 行为。"""
    model.all_objects.filter(pk=row_id).update(created_at=created_at)


def test_single_work_item_migration_retains_latest_assignee(db):
    """创建时间相同时，迁移应保留主键较大的最新负责人。"""
    owner = User.objects.create(email="migration-owner@plane.so", username="migration_owner")
    first_assignee = User.objects.create(email="migration-first@plane.so", username="migration_first")
    latest_assignee = User.objects.create(email="migration-latest@plane.so", username="migration_latest")
    workspace = Workspace.objects.create(name="Migration workspace", slug="migration-workspace", owner=owner)
    project = Project.objects.create(workspace=workspace, name="Migration project", identifier="mig", created_by=owner)
    issue = Issue.objects.create(name="Migration issue", project=project, workspace=workspace, created_by=owner)
    draft = DraftIssue.objects.create(name="Migration draft", project=project, workspace=workspace, created_by=owner)
    created_at = timezone.now()

    id_base = uuid4().int
    first_id = UUID(int=id_base)
    latest_id = UUID(int=id_base + 1)
    issue_first = IssueAssignee.objects.create(
        id=first_id, issue=issue, assignee=first_assignee, project=project, workspace=workspace
    )
    issue_latest = IssueAssignee.objects.create(
        id=latest_id, issue=issue, assignee=latest_assignee, project=project, workspace=workspace
    )
    draft_first = DraftIssueAssignee.objects.create(
        id=first_id, draft_issue=draft, assignee=first_assignee, project=project, workspace=workspace
    )
    draft_latest = DraftIssueAssignee.objects.create(
        id=latest_id, draft_issue=draft, assignee=latest_assignee, project=project, workspace=workspace
    )
    for row in (issue_first, issue_latest, draft_first, draft_latest):
        _update_created_at(IssueAssignee if hasattr(row, "issue_id") else DraftIssueAssignee, row.id, created_at)

    _retain_latest_assignee()(apps, connection.schema_editor())

    assert IssueAssignee.objects.filter(issue=issue).get().id == issue_latest.id
    assert DraftIssueAssignee.objects.filter(draft_issue=draft).get().id == draft_latest.id
    assert IssueAssignee.all_objects.filter(issue=issue, deleted_at__isnull=False).count() == 1
    assert DraftIssueAssignee.all_objects.filter(draft_issue=draft, deleted_at__isnull=False).count() == 1
