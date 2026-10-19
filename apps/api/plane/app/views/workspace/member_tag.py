"""Workspace member tag management endpoints."""

from django.db import IntegrityError, transaction
from django.db.models import Prefetch, Q
from rest_framework import status
from rest_framework.response import Response

from plane.app.permissions import ROLE, WorkspaceViewerPermission, allow_permission
from plane.app.serializers import (
    WorkspaceMemberAdminSerializer,
    WorkspaceMemberTagGroupSerializer,
    WorkspaceMemberTagSerializer,
    WorkSpaceMemberSerializer,
)
from plane.app.views.base import BaseAPIView
from plane.db.models import (
    WorkspaceMember,
    WorkspaceMemberTag,
    WorkspaceMemberTagAssignment,
    WorkspaceMemberTagGroup,
)


TAG_COLORS = {"sage", "sand", "slate", "mist", "clay", "moss"}


def _tag_queryset(workspace_slug):
    """返回指定工作区的有序标签组查询集。"""
    return WorkspaceMemberTagGroup.objects.filter(workspace__slug=workspace_slug).prefetch_related(
        Prefetch("tags", queryset=WorkspaceMemberTag.objects.order_by("sort_order", "name"))
    )


def _serialize_member(member):
    """序列化一个带标签关联的工作区成员。"""
    serializer_class = WorkspaceMemberAdminSerializer if member.role > 5 else WorkSpaceMemberSerializer
    return serializer_class(member).data


def _member_queryset(workspace_slug, member_ids):
    """返回工作区内的成员记录，兼容用户 ID 与成员关系 ID。"""
    return WorkspaceMember.objects.filter(
        Q(id__in=member_ids) | Q(member_id__in=member_ids),
        workspace__slug=workspace_slug,
        is_active=True,
    )


class WorkspaceMemberTagGroupsEndpoint(BaseAPIView):
    """读取和创建工作区成员标签组。"""

    permission_classes = [WorkspaceViewerPermission]

    def get(self, request, slug):
        """返回当前工作区的标签组和标签。"""
        if not WorkspaceMember.objects.filter(workspace__slug=slug, member=request.user, is_active=True).exists():
            return Response({"error": "You don't have the required permissions."}, status=status.HTTP_403_FORBIDDEN)
        return Response(WorkspaceMemberTagGroupSerializer(_tag_queryset(slug), many=True).data)

    @allow_permission([ROLE.ADMIN], level="WORKSPACE")
    def post(self, request, slug):
        """创建一个成员标签组。"""
        name = str(request.data.get("name", "")).strip()
        if not name:
            return Response({"name": "This field is required."}, status=status.HTTP_400_BAD_REQUEST)
        try:
            group = WorkspaceMemberTagGroup.objects.create(
                workspace_id=WorkspaceMember.objects.get(workspace__slug=slug, member=request.user).workspace_id,
                name=name,
                sort_order=request.data.get("sort_order", 65535),
            )
        except (WorkspaceMember.DoesNotExist, IntegrityError, ValueError):
            return Response({"error": "A tag group with this name already exists."}, status=status.HTTP_400_BAD_REQUEST)
        return Response(WorkspaceMemberTagGroupSerializer(group).data, status=status.HTTP_201_CREATED)


class WorkspaceMemberTagGroupDetailEndpoint(BaseAPIView):
    """修改或删除单个成员标签组。"""

    permission_classes = [WorkspaceViewerPermission]

    def _get_group(self, slug, group_id):
        return WorkspaceMemberTagGroup.objects.get(id=group_id, workspace__slug=slug)

    @allow_permission([ROLE.ADMIN], level="WORKSPACE")
    def patch(self, request, slug, group_id):
        """更新标签组名称或排序。"""
        try:
            group = self._get_group(slug, group_id)
        except WorkspaceMemberTagGroup.DoesNotExist:
            return Response({"error": "Tag group not found."}, status=status.HTTP_404_NOT_FOUND)
        if "name" in request.data:
            name = str(request.data["name"]).strip()
            if not name:
                return Response({"name": "This field is required."}, status=status.HTTP_400_BAD_REQUEST)
            group.name = name
        if "sort_order" in request.data:
            group.sort_order = request.data["sort_order"]
        try:
            group.save()
        except IntegrityError:
            return Response({"error": "A tag group with this name already exists."}, status=status.HTTP_400_BAD_REQUEST)
        return Response(WorkspaceMemberTagGroupSerializer(group).data)

    @allow_permission([ROLE.ADMIN], level="WORKSPACE")
    def delete(self, request, slug, group_id):
        """软删除标签组及其标签和成员关联。"""
        try:
            group = self._get_group(slug, group_id)
        except WorkspaceMemberTagGroup.DoesNotExist:
            return Response({"error": "Tag group not found."}, status=status.HTTP_404_NOT_FOUND)
        group.delete()
        return Response(status=status.HTTP_204_NO_CONTENT)


class WorkspaceMemberTagsEndpoint(BaseAPIView):
    """创建工作区标签或更新成员标签集合。"""

    permission_classes = [WorkspaceViewerPermission]

    @allow_permission([ROLE.ADMIN], level="WORKSPACE")
    def post(self, request, slug, group_id):
        """在指定标签组下创建标签。"""
        try:
            group = WorkspaceMemberTagGroup.objects.get(id=group_id, workspace__slug=slug)
        except WorkspaceMemberTagGroup.DoesNotExist:
            return Response({"error": "Tag group not found."}, status=status.HTTP_404_NOT_FOUND)
        name = str(request.data.get("name", "")).strip()
        color = str(request.data.get("color", "sage"))
        if not name:
            return Response({"name": "This field is required."}, status=status.HTTP_400_BAD_REQUEST)
        if color not in TAG_COLORS:
            return Response({"color": "Unsupported tag color."}, status=status.HTTP_400_BAD_REQUEST)
        try:
            tag = WorkspaceMemberTag.objects.create(
                group=group,
                name=name,
                color=color,
                sort_order=request.data.get("sort_order", 65535),
            )
        except (IntegrityError, ValueError):
            return Response({"error": "A tag with this name already exists."}, status=status.HTTP_400_BAD_REQUEST)
        return Response(WorkspaceMemberTagSerializer(tag).data, status=status.HTTP_201_CREATED)


class WorkspaceMemberTagDetailEndpoint(BaseAPIView):
    """修改或删除单个成员标签。"""

    permission_classes = [WorkspaceViewerPermission]

    def _get_tag(self, slug, tag_id):
        return WorkspaceMemberTag.objects.get(id=tag_id, group__workspace__slug=slug)

    @allow_permission([ROLE.ADMIN], level="WORKSPACE")
    def patch(self, request, slug, tag_id):
        """更新成员标签名称、颜色或排序。"""
        try:
            tag = self._get_tag(slug, tag_id)
        except WorkspaceMemberTag.DoesNotExist:
            return Response({"error": "Tag not found."}, status=status.HTTP_404_NOT_FOUND)
        if "name" in request.data:
            name = str(request.data["name"]).strip()
            if not name:
                return Response({"name": "This field is required."}, status=status.HTTP_400_BAD_REQUEST)
            tag.name = name
        if "color" in request.data:
            if request.data["color"] not in TAG_COLORS:
                return Response({"color": "Unsupported tag color."}, status=status.HTTP_400_BAD_REQUEST)
            tag.color = request.data["color"]
        if "sort_order" in request.data:
            tag.sort_order = request.data["sort_order"]
        try:
            tag.save()
        except IntegrityError:
            return Response({"error": "A tag with this name already exists."}, status=status.HTTP_400_BAD_REQUEST)
        return Response(WorkspaceMemberTagSerializer(tag).data)

    @allow_permission([ROLE.ADMIN], level="WORKSPACE")
    def delete(self, request, slug, tag_id):
        """软删除成员标签及其关联。"""
        try:
            tag = self._get_tag(slug, tag_id)
        except WorkspaceMemberTag.DoesNotExist:
            return Response({"error": "Tag not found."}, status=status.HTTP_404_NOT_FOUND)
        tag.delete()
        return Response(status=status.HTTP_204_NO_CONTENT)


class WorkspaceMemberTagAssignmentEndpoint(BaseAPIView):
    """替换单个成员的标签集合。"""

    permission_classes = [WorkspaceViewerPermission]

    @allow_permission([ROLE.ADMIN], level="WORKSPACE")
    @transaction.atomic
    def put(self, request, slug, member_id):
        """使用完整标签 ID 列表替换成员标签。"""
        member = WorkspaceMember.objects.filter(
            Q(id=member_id) | Q(member_id=member_id),
            workspace__slug=slug,
            is_active=True,
            member__is_bot=False,
        ).first()
        if not member:
            return Response({"error": "Workspace member not found."}, status=status.HTTP_404_NOT_FOUND)
        tag_ids = request.data.get("tag_ids", [])
        if not isinstance(tag_ids, list):
            return Response({"tag_ids": "Expected a list of tag IDs."}, status=status.HTTP_400_BAD_REQUEST)
        tags = list(WorkspaceMemberTag.objects.filter(id__in=tag_ids, group__workspace__slug=slug))
        if len({str(tag.id) for tag in tags}) != len({str(tag_id) for tag_id in tag_ids}):
            return Response({"tag_ids": "All tags must belong to this workspace."}, status=status.HTTP_400_BAD_REQUEST)
        WorkspaceMemberTagAssignment.objects.filter(workspace_member=member).delete(soft=False)
        WorkspaceMemberTagAssignment.objects.bulk_create(
            [WorkspaceMemberTagAssignment(workspace_member=member, tag=tag) for tag in tags]
        )
        member.prefetched_tag_assignments = [
            WorkspaceMemberTagAssignment(tag=tag, workspace_member=member) for tag in tags
        ]
        return Response({"tags": WorkspaceMemberTagSerializer(tags, many=True).data})


class WorkspaceMemberTagBulkAssignmentEndpoint(BaseAPIView):
    """批量添加和移除成员标签。"""

    permission_classes = [WorkspaceViewerPermission]

    @allow_permission([ROLE.ADMIN], level="WORKSPACE")
    @transaction.atomic
    def post(self, request, slug):
        """对选中的成员执行标签增删操作。"""
        member_ids = request.data.get("member_ids", [])
        add_tag_ids = request.data.get("add_tag_ids", [])
        remove_tag_ids = request.data.get("remove_tag_ids", [])
        if not all(isinstance(value, list) for value in (member_ids, add_tag_ids, remove_tag_ids)):
            return Response({"error": "member_ids, add_tag_ids and remove_tag_ids must be lists."}, status=status.HTTP_400_BAD_REQUEST)
        members = list(_member_queryset(slug, member_ids))
        tags = list(WorkspaceMemberTag.objects.filter(id__in=set(add_tag_ids + remove_tag_ids), group__workspace__slug=slug))
        if len(members) != len(set(member_ids)) or len(tags) != len(set(add_tag_ids + remove_tag_ids)):
            return Response({"error": "Members and tags must belong to this workspace."}, status=status.HTTP_400_BAD_REQUEST)
        if remove_tag_ids:
            WorkspaceMemberTagAssignment.objects.filter(
                workspace_member__in=members, tag_id__in=remove_tag_ids
            ).delete(soft=False)
        existing = {
            (str(member_id), str(tag_id))
            for member_id, tag_id in WorkspaceMemberTagAssignment.objects.filter(
                workspace_member__in=members, tag_id__in=add_tag_ids
            ).values_list("workspace_member_id", "tag_id")
        }
        WorkspaceMemberTagAssignment.objects.bulk_create(
            [
                WorkspaceMemberTagAssignment(workspace_member=member, tag=tag)
                for member in members
                for tag in tags
                if str(tag.id) in add_tag_ids and (str(member.id), str(tag.id)) not in existing
            ],
            ignore_conflicts=True,
        )
        refreshed = []
        for member in members:
            member.prefetched_tag_assignments = list(
                member.tag_assignments.select_related("tag__group").all()
            )
            refreshed.append(_serialize_member(member))
        return Response({"members": refreshed})
