# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Contract coverage for workspace member tag management."""

import pytest
from rest_framework import status

from plane.db.models import User, Workspace, WorkspaceMember


def _groups_url(workspace):
    return f"/api/workspaces/{workspace.slug}/member-tag-groups/"


def _member_tags_url(workspace, member):
    return f"/api/workspaces/{workspace.slug}/members/{member.id}/tags/"


def _bulk_tags_url(workspace):
    return f"/api/workspaces/{workspace.slug}/members/tags/bulk/"


@pytest.fixture
def tagged_member(db, workspace):
    """创建用于标签分配测试的普通工作区成员。"""
    user = User.objects.create(
        email="member-tags@plane.so",
        first_name="Member",
        last_name="Tags",
    )
    WorkspaceMember.objects.create(workspace=workspace, member=user, role=15)
    return user


@pytest.fixture
def member_client(api_client, workspace, tagged_member):
    """返回以普通工作区成员身份认证的 API 客户端。"""
    api_client.force_authenticate(user=tagged_member)
    return api_client


@pytest.mark.contract
@pytest.mark.django_db
class TestWorkspaceMemberTags:
    """验证成员标签的工作区边界、权限和更新行为。"""

    def test_admin_can_manage_tags_and_member_assignments(self, session_client, workspace, tagged_member):
        """管理员可创建标签并替换单个成员的标签集合。"""
        group_response = session_client.post(_groups_url(workspace), {"name": "年级"}, format="json")
        assert group_response.status_code == status.HTTP_201_CREATED

        tag_response = session_client.post(
            f"{_groups_url(workspace)}{group_response.data['id']}/tags/",
            {"name": "2025 级研究生", "color": "sage"},
            format="json",
        )
        assert tag_response.status_code == status.HTTP_201_CREATED

        assignment_response = session_client.put(
            _member_tags_url(workspace, tagged_member),
            {"tag_ids": [tag_response.data["id"]]},
            format="json",
        )
        assert assignment_response.status_code == status.HTTP_200_OK
        assert assignment_response.data["tags"] == [tag_response.data]

        members_response = session_client.get(f"/api/workspaces/{workspace.slug}/members/")
        assert members_response.status_code == status.HTTP_200_OK
        tagged = next(member for member in members_response.data if member["member"]["id"] == str(tagged_member.id))
        assert tagged["tags"] == [tag_response.data]

    def test_member_can_read_tags_but_cannot_modify_them(self, member_client, workspace):
        """普通成员可读取标签配置，但不能执行写操作。"""
        assert member_client.get(_groups_url(workspace)).status_code == status.HTTP_200_OK
        response = member_client.post(_groups_url(workspace), {"name": "研究方向"}, format="json")
        assert response.status_code == status.HTTP_403_FORBIDDEN

    def test_rejects_tags_from_another_workspace(self, session_client, workspace, tagged_member, create_user):
        """成员不能关联其他工作区创建的标签。"""
        other_workspace = Workspace.objects.create(name="Other", owner=create_user, slug="other-member-tags")
        WorkspaceMember.objects.create(workspace=other_workspace, member=create_user, role=20)
        other_group = session_client.post(_groups_url(other_workspace), {"name": "Other group"}, format="json")
        other_tag = session_client.post(
            f"{_groups_url(other_workspace)}{other_group.data['id']}/tags/",
            {"name": "Other tag", "color": "sage"},
            format="json",
        )

        response = session_client.put(
            _member_tags_url(workspace, tagged_member),
            {"tag_ids": [other_tag.data["id"]]},
            format="json",
        )
        assert response.status_code == status.HTTP_400_BAD_REQUEST

    def test_bulk_update_only_changes_requested_tags(self, session_client, workspace, tagged_member):
        """批量移除和新增只影响指定标签，保留成员的其他标签。"""
        group = session_client.post(_groups_url(workspace), {"name": "角色"}, format="json").data
        first_tag = session_client.post(
            f"{_groups_url(workspace)}{group['id']}/tags/", {"name": "导师", "color": "sage"}, format="json"
        ).data
        second_tag = session_client.post(
            f"{_groups_url(workspace)}{group['id']}/tags/", {"name": "项目负责人", "color": "sand"}, format="json"
        ).data

        session_client.put(_member_tags_url(workspace, tagged_member), {"tag_ids": [first_tag["id"]]}, format="json")
        response = session_client.post(
            _bulk_tags_url(workspace),
            {
                "member_ids": [str(tagged_member.id)],
                "add_tag_ids": [second_tag["id"]],
                "remove_tag_ids": [],
            },
            format="json",
        )

        assert response.status_code == status.HTTP_200_OK
        assert {tag["id"] for tag in response.data["members"][0]["tags"]} == {first_tag["id"], second_tag["id"]}
