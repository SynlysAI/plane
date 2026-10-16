# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

# Third party imports
from django.db.models import Q
from rest_framework import status
from rest_framework.response import Response

from plane.db.models import (
    Issue,
    Page,
    Project,
    ProjectMember,
    ProjectPage,
    ResearchChain,
    ResearchProjectProfile,
    UserRecentVisit,
)
from plane.app.serializers import WorkspaceRecentVisitSerializer
from plane.utils.administrative_projects import administrative_projects_for_user

# Modules imports
from ..base import BaseViewSet
from plane.app.permissions import allow_permission, ROLE


class UserRecentVisitViewSet(BaseViewSet):
    model = UserRecentVisit
    use_read_replica = True

    @staticmethod
    def _administrative_projects(user, slug):
        """返回当前用户可访问的有效行政项目。

        Args:
            user: 当前登录用户。
            slug: 工作区别名。

        Returns:
            排除所有科研关联、归档和删除项目的授权查询集。
        """
        member_ids = ProjectMember.objects.filter(workspace__slug=slug, member=user, is_active=True).values(
            "project_id"
        )
        return (
            Project.objects.filter(workspace__slug=slug, archived_at__isnull=True)
            .filter(Q(id__in=member_ids) | Q(id__in=administrative_projects_for_user(user, slug).values("id")))
            .exclude(id__in=ResearchProjectProfile.all_objects.values("project_id"))
            .exclude(id__in=ResearchChain.all_objects.values("project_id"))
        )

    def get_serializer_class(self):
        return WorkspaceRecentVisitSerializer

    @allow_permission([ROLE.ADMIN, ROLE.MEMBER, ROLE.GUEST], level="WORKSPACE")
    def list(self, request, slug):
        """读取最近访问；行政范围先检查实体与权限，再截取最近 20 条。"""
        user_recent_visits = UserRecentVisit.objects.filter(workspace__slug=slug, user=request.user)

        entity_name = request.query_params.get("entity_name")

        if entity_name:
            user_recent_visits = user_recent_visits.filter(entity_name=entity_name)

        user_recent_visits = user_recent_visits.filter(entity_name__in=["issue", "page", "project"])

        serializer_context = {}
        if request.query_params.get("scope") == "administrative":
            projects = self._administrative_projects(request.user, slug)
            project_ids = projects.values("id")
            issues = Issue.issue_objects.filter(workspace__slug=slug, project_id__in=project_ids)
            page_ids = ProjectPage.objects.filter(workspace__slug=slug, project_id__in=project_ids).values("page_id")
            pages = (
                Page.objects.filter(workspace__slug=slug, id__in=page_ids, archived_at__isnull=True)
                .filter(Q(access=Page.PUBLIC_ACCESS) | Q(owned_by=request.user))
                .exclude(research_report__isnull=False)
                .exclude(research_stage_materials__isnull=False)
            )
            user_recent_visits = user_recent_visits.filter(
                Q(entity_name="project", entity_identifier__in=project_ids)
                | Q(entity_name="issue", entity_identifier__in=issues.values("id"))
                | Q(entity_name="page", entity_identifier__in=pages.values("id"))
            ).order_by("-visited_at", "-id")
            serializer_context["recent_administrative_projects"] = projects

        serializer = WorkspaceRecentVisitSerializer(user_recent_visits[:20], many=True, context=serializer_context)
        return Response(serializer.data, status=status.HTTP_200_OK)
