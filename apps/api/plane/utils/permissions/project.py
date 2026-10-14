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
)


def _passes_workspace_access_gate(request, view):
    return user_can_access_workspace(request.user, workspace_slug=view.workspace_slug)


def _is_public_administrative_project(request, workspace_slug, project_id=None, project_identifier=None):
    """判断当前请求是否访问全员可编辑的公共行政项目。"""
    projects = public_administrative_project_ids(request.user, workspace_slug)
    if project_identifier is not None:
        return projects.filter(project__identifier=project_identifier).exists()
    return projects.filter(id=project_id).exists()


class ProjectBasePermission(BasePermission):
    def has_permission(self, request, view):
        if request.user.is_anonymous:
            return False
        if not _passes_workspace_access_gate(request, view):
            return False

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
        if (
            request.method in SAFE_METHODS
            and administrative_organization_project_ids(request.user, view.workspace_slug)
            .filter(id=view.project_id)
            .exists()
        ):
            return True

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

        ## Safe Methods -> Handle the filtering logic in queryset
        if request.method in SAFE_METHODS:
            return (
                ProjectMember.objects.filter(
                    workspace__slug=view.workspace_slug,
                    member=request.user,
                    project_id=view.project_id,
                    is_active=True,
                ).exists()
                or administrative_organization_project_ids(request.user, view.workspace_slug)
                .filter(id=view.project_id)
                .exists()
                or _is_public_administrative_project(request, view.workspace_slug, project_id=view.project_id)
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
        ).exists() or _is_public_administrative_project(request, view.workspace_slug, project_id=view.project_id)


class ProjectEntityPermission(BasePermission):
    def has_permission(self, request, view):
        if request.user.is_anonymous:
            return False
        if not _passes_workspace_access_gate(request, view):
            return False

        # Handle requests based on project__identifier
        if hasattr(view, "project_identifier") and view.project_identifier:
            if request.method in SAFE_METHODS:
                return (
                    ProjectMember.objects.filter(
                        workspace__slug=view.workspace_slug,
                        member=request.user,
                        project__identifier=view.project_identifier,
                        is_active=True,
                    ).exists()
                    or administrative_organization_project_ids(request.user, view.workspace_slug)
                    .filter(project__identifier=view.project_identifier)
                    .exists()
                    or _is_public_administrative_project(
                        request, view.workspace_slug, project_identifier=view.project_identifier
                    )
                )

        ## Safe Methods -> Handle the filtering logic in queryset
        if request.method in SAFE_METHODS:
            return (
                ProjectMember.objects.filter(
                    workspace__slug=view.workspace_slug,
                    member=request.user,
                    project_id=view.project_id,
                    is_active=True,
                ).exists()
                or administrative_organization_project_ids(request.user, view.workspace_slug)
                .filter(id=view.project_id)
                .exists()
                or _is_public_administrative_project(request, view.workspace_slug, project_id=view.project_id)
            )

        ## Only project members or admins can create and edit the project attributes
        return ProjectMember.objects.filter(
            workspace__slug=view.workspace_slug,
            member=request.user,
            role__in=[ROLE.ADMIN.value, ROLE.MEMBER.value],
            project_id=view.project_id,
            is_active=True,
        ).exists() or _is_public_administrative_project(request, view.workspace_slug, project_id=view.project_id)


class ProjectAdminPermission(BasePermission):
    def has_permission(self, request, view):
        if request.user.is_anonymous:
            return False
        if not _passes_workspace_access_gate(request, view):
            return False

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

        return ProjectMember.objects.filter(
            workspace__slug=view.workspace_slug,
            member=request.user,
            project_id=view.project_id,
            is_active=True,
        ).exists() or _is_public_administrative_project(request, view.workspace_slug, project_id=view.project_id)
