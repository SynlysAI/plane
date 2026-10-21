"""草稿单负责人写入契约测试。"""

from uuid import uuid4

import pytest

from plane.app.serializers.draft import DraftIssueCreateSerializer
from plane.db.models import (
    DraftIssue,
    DraftIssueAssignee,
    Project,
    ProjectMember,
    State,
    User,
    Workspace,
    WorkspaceMember,
)


def _user(name):
    """创建唯一的草稿指派测试用户。"""
    unique = uuid4().hex[:8]
    return User.objects.create_user(
        email=f"{name}-{unique}@plane.so", username=f"{name}_{unique}", first_name=name.title()
    )


@pytest.mark.django_db
def test_draft_reassignment_keeps_one_active_owner():
    """草稿重指派后仅保留新的有效负责人，并软删除历史关联。"""
    owner = _user("draft-owner")
    first = _user("draft-first")
    second = _user("draft-second")
    workspace = Workspace.objects.create(name="Draft workspace", slug=f"draft-{uuid4().hex[:12]}", owner=owner)
    project = Project.objects.create(workspace=workspace, name="Draft project", identifier="DRA", created_by=owner)
    State.objects.create(
        name="Todo", color="#000000", group="unstarted", default=True, project=project, workspace=workspace
    )
    draft = DraftIssue.objects.create(name="Draft assignment", project=project, workspace=workspace, created_by=owner)
    for member in (owner, first, second):
        WorkspaceMember.objects.create(workspace=workspace, member=member, role=15, is_active=True)
    for member in (first, second):
        ProjectMember.objects.create(workspace=workspace, project=project, member=member, role=15, is_active=True)

    serializer = DraftIssueCreateSerializer(
        draft,
        data={"assignee_ids": [str(second.id)]},
        partial=True,
        context={"workspace_id": workspace.id, "project_id": project.id, "actor": owner},
    )
    assert serializer.is_valid(), serializer.errors
    serializer.save()

    assert list(DraftIssueAssignee.objects.filter(draft_issue=draft).values_list("assignee_id", flat=True)) == [
        second.id
    ]


@pytest.mark.django_db
def test_draft_rejects_invalid_project_member():
    """草稿负责人必须是当前项目的有效成员。"""
    owner = _user("draft-invalid-owner")
    outsider = _user("draft-outsider")
    workspace = Workspace.objects.create(
        name="Draft invalid workspace", slug=f"draft-invalid-{uuid4().hex[:12]}", owner=owner
    )
    project = Project.objects.create(
        workspace=workspace, name="Draft invalid project", identifier="DRI", created_by=owner
    )
    draft = DraftIssue.objects.create(
        name="Invalid draft assignment", project=project, workspace=workspace, created_by=owner
    )

    serializer = DraftIssueCreateSerializer(
        draft,
        data={"assignee_ids": [str(outsider.id)]},
        partial=True,
        context={"workspace_id": workspace.id, "project_id": project.id, "actor": owner},
    )

    assert not serializer.is_valid()
    assert "assignee_ids" in serializer.errors
