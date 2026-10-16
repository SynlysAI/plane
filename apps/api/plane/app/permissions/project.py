# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

# Third Party imports
from rest_framework.permissions import SAFE_METHODS, BasePermission

# Module import
from plane.db.models import ProjectMember, WorkspaceMember
from plane.db.models.project import ROLE
from plane.utils.workspace_access import user_can_access_workspace
from plane.utils.administrative_projects import (
    administrative_organization_project_ids,
    public_administrative_project_ids,
    user_can_manage_administrative_project,
)


def _passes_workspace_access_gate(request, view):
    return user_can_access_workspace(request.user, workspace_slug=view.workspace_slug)


def _is_research_review_reader(request, view) -> bool:
    """判断当前请求是不是研究链只读读者。

    Args:
        request: 当前请求。
        view: 带工作区和项目参数的视图。

    Returns:
        可以只读打开该科研项目时为 True。写请求不走这里。
    """
    project_id = getattr(view, "project_id", None)
    slug = getattr(view, "workspace_slug", None)
    if not project_id or not slug:
        return False
    from plane.research.utils.project_review import user_can_review_research_project

    return user_can_review_research_project(request.user, slug, project_id)


def _is_administrative_project_admin(request, view):
    """检查当前请求是否具有行政项目的默认管理权限。

    Args:
        request: 当前请求。
        view: 带工作区和项目参数的视图。

    Returns:
        当前用户能默认管理该行政项目时为 True。
    """
    project_id = getattr(view, "project_id", None)
    if not project_id and getattr(view, "project_identifier", None):
        from plane.db.models import Project

        project_id = (
            Project.objects.filter(workspace__slug=view.workspace_slug, identifier__iexact=view.project_identifier)
            .values_list("id", flat=True)
            .first()
        )
    return user_can_manage_administrative_project(request.user, view.workspace_slug, project_id)


def _is_administrative_organization_reader(request, view):
    """检查当前请求是否通过行政组织继承只读权限。

    Args:
        request: 当前请求。
        view: 带工作区和项目参数的视图。

    Returns:
        活跃组织成员可只读访问项目时为 True。
    """
    project_id = getattr(view, "project_id", None)
    slug = getattr(view, "workspace_slug", None)
    if not project_id or not slug:
        return False
    return administrative_organization_project_ids(request.user, slug).filter(id=project_id).exists()


def _is_public_administrative_project_reader(request, view):
    """检查当前请求是否读取默认公共组织下的公共行政项目。

    Args:
        request: 当前请求。
        view: 带工作区和项目参数的视图。

    Returns:
        公共行政项目对全体有效工作区成员只读开放时为 True。
    """
    project_id = getattr(view, "project_id", None)
    slug = getattr(view, "workspace_slug", None)
    if not project_id or not slug:
        return False
    return public_administrative_project_ids(request.user, slug).filter(id=project_id).exists()


class ProjectBasePermission(BasePermission):
    def has_permission(self, request, view):
        if request.user.is_anonymous:
            return False
        if not _passes_workspace_access_gate(request, view):
            return False
        if _is_administrative_project_admin(request, view):
            return True

        ## Safe Methods -> Handle the filtering logic in queryset
        if request.method in SAFE_METHODS:
            return WorkspaceMember.objects.filter(
                workspace__slug=view.workspace_slug, member=request.user, is_active=True
            ).exists()

        ## Only workspace owners or admins can create the projects
        if request.method == "POST":
            return WorkspaceMember.objects.filter(
                workspace__slug=view.workspace_slug,
                member=request.user,
                role__in=[ROLE.ADMIN.value, ROLE.MEMBER.value],
                is_active=True,
            ).exists()

        project_member_qs = ProjectMember.objects.filter(
            workspace__slug=view.workspace_slug,
            member=request.user,
            project_id=view.project_id,
            is_active=True,
        )

        ## Only project admins or workspace admin who is part of the project can access

        if project_member_qs.filter(role=ROLE.ADMIN.value).exists():
            return True
        else:
            return (
                project_member_qs.exists()
                and WorkspaceMember.objects.filter(
                    member=request.user,
                    workspace__slug=view.workspace_slug,
                    role=ROLE.ADMIN.value,
                    is_active=True,
                ).exists()
            )


class ProjectMemberPermission(BasePermission):
    def has_permission(self, request, view):
        if request.user.is_anonymous:
            return False
        if not _passes_workspace_access_gate(request, view):
            return False
        if _is_administrative_project_admin(request, view):
            return True

        ## Safe Methods -> Handle the filtering logic in queryset
        if request.method in SAFE_METHODS:
            return ProjectMember.objects.filter(
                workspace__slug=view.workspace_slug,
                member=request.user,
                project_id=view.project_id,
                is_active=True,
            ).exists() or _is_administrative_organization_reader(request, view) or _is_public_administrative_project_reader(
                request, view
            )
        ## Only workspace owners or admins can create the projects
        if request.method == "POST":
            return WorkspaceMember.objects.filter(
                workspace__slug=view.workspace_slug,
                member=request.user,
                role__in=[ROLE.ADMIN.value, ROLE.MEMBER.value],
                is_active=True,
            ).exists()

        ## Only Project Admins can update project attributes
        return ProjectMember.objects.filter(
            workspace__slug=view.workspace_slug,
            member=request.user,
            role__in=[ROLE.ADMIN.value, ROLE.MEMBER.value],
            project_id=view.project_id,
            is_active=True,
        ).exists()


class ProjectEntityPermission(BasePermission):
    def has_permission(self, request, view):
        if request.user.is_anonymous:
            return False
        if not _passes_workspace_access_gate(request, view):
            return False
        if _is_administrative_project_admin(request, view):
            return True

        if request.method in SAFE_METHODS and _is_research_review_reader(request, view):
            return True

        # Handle requests based on project__identifier
        if hasattr(view, "project_identifier") and view.project_identifier:
            if request.method in SAFE_METHODS:
                return ProjectMember.objects.filter(
                    workspace__slug=view.workspace_slug,
                    member=request.user,
                    project__identifier=view.project_identifier,
                    is_active=True,
                ).exists() or administrative_organization_project_ids(
                    request.user, view.workspace_slug
                ).filter(project__identifier=view.project_identifier).exists()

        ## Safe Methods -> Handle the filtering logic in queryset
        if request.method in SAFE_METHODS:
            return (
                ProjectMember.objects.filter(
                    workspace__slug=view.workspace_slug,
                    member=request.user,
                    project_id=view.project_id,
                    is_active=True,
                ).exists()
                or _is_administrative_organization_reader(request, view)
                or _is_public_administrative_project_reader(request, view)
            )

        ## Only project members or admins can create and edit the project attributes
        return ProjectMember.objects.filter(
            workspace__slug=view.workspace_slug,
            member=request.user,
            role__in=[ROLE.ADMIN.value, ROLE.MEMBER.value],
            project_id=view.project_id,
            is_active=True,
        ).exists()


class ProjectAdminPermission(BasePermission):
    def has_permission(self, request, view):
        if request.user.is_anonymous:
            return False
        if not _passes_workspace_access_gate(request, view):
            return False
        if _is_administrative_project_admin(request, view):
            return True

        return ProjectMember.objects.filter(
            workspace__slug=view.workspace_slug,
            member=request.user,
            role=ROLE.ADMIN.value,
            project_id=view.project_id,
            is_active=True,
        ).exists()


class ProjectLitePermission(BasePermission):
    def has_permission(self, request, view):
        if request.user.is_anonymous:
            return False
        if not _passes_workspace_access_gate(request, view):
            return False
        if _is_administrative_project_admin(request, view):
            return True

        if request.method in SAFE_METHODS and _is_research_review_reader(request, view):
            return True

        if request.method in SAFE_METHODS and (
            _is_administrative_organization_reader(request, view) or _is_public_administrative_project_reader(request, view)
        ):
            return True

        return ProjectMember.objects.filter(
            workspace__slug=view.workspace_slug,
            member=request.user,
            project_id=view.project_id,
            is_active=True,
        ).exists()
