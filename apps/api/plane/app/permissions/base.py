# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

from plane.db.models import WorkspaceMember, ProjectMember
from functools import wraps
from rest_framework.response import Response
from rest_framework import status
from plane.utils.workspace_access import user_can_access_workspace
from plane.utils.administrative_projects import (
    administrative_organization_project_ids,
    effective_project_member,
    user_can_manage_administrative_project,
)

from enum import Enum


class ROLE(Enum):
    ADMIN = 20
    MEMBER = 15
    GUEST = 5


def project_role_allows(user, slug, project_id, allowed_roles):
    """The native effective-project-role decision, shared with machine writes."""
    values = [role.value if isinstance(role, ROLE) else role for role in allowed_roles]
    if ROLE.ADMIN.value in values and user_can_manage_administrative_project(user, slug, project_id):
        return True
    if ProjectMember.objects.filter(
        member=user, workspace__slug=slug, project_id=project_id, role__in=values, is_active=True
    ).exists():
        return True
    member = effective_project_member(user, slug, project_id) if project_id else None
    if member is not None and member.role in values:
        return True
    return (
        ProjectMember.objects.filter(member=user, workspace__slug=slug, project_id=project_id, is_active=True).exists()
        and WorkspaceMember.objects.filter(
            member=user, workspace__slug=slug, role=ROLE.ADMIN.value, is_active=True
        ).exists()
    )


def allow_permission(allowed_roles, level="PROJECT", creator=False, model=None, research_review_read=False):
    def decorator(view_func):
        @wraps(view_func)
        def _wrapped_view(instance, request, *args, **kwargs):
            if not user_can_access_workspace(request.user, workspace_slug=kwargs.get("slug")):
                return Response(
                    {"error": "You don't have the required permissions."},
                    status=status.HTTP_403_FORBIDDEN,
                )

            # Check for creator if required
            if creator and model:
                # check if the user is part of the workspace or not
                if not WorkspaceMember.objects.filter(
                    member=request.user,
                    workspace__slug=kwargs["slug"],
                    is_active=True,
                ).exists():
                    return Response(
                        {"error": "You don't have the required permissions."},
                        status=status.HTTP_403_FORBIDDEN,
                    )

                obj = model.objects.filter(id=kwargs["pk"], created_by=request.user).exists()
                if obj:
                    return view_func(instance, request, *args, **kwargs)

            # Convert allowed_roles to their values if they are enum members
            allowed_role_values = [role.value if isinstance(role, ROLE) else role for role in allowed_roles]

            # Check role permissions
            if level == "WORKSPACE":
                if WorkspaceMember.objects.filter(
                    member=request.user,
                    workspace__slug=kwargs["slug"],
                    role__in=allowed_role_values,
                    is_active=True,
                ).exists():
                    return view_func(instance, request, *args, **kwargs)
            else:
                is_user_has_allowed_role = project_role_allows(
                    request.user, kwargs["slug"], kwargs["project_id"], allowed_roles
                )
                if (
                    request.method in ("GET", "HEAD", "OPTIONS")
                    and administrative_organization_project_ids(request.user, kwargs["slug"])
                    .filter(id=kwargs["project_id"])
                    .exists()
                ):
                    is_user_has_allowed_role = True

                # Return if the user has the allowed role else if they are workspace admin and part of the project regardless of the role # noqa: E501
                if is_user_has_allowed_role:
                    return view_func(instance, request, *args, **kwargs)
            # Research-chain reviewers may read specific project resources without a member row.
            if (
                research_review_read
                and level != "WORKSPACE"
                and request.method in ("GET", "HEAD", "OPTIONS")
                and kwargs.get("slug")
                and kwargs.get("project_id")
            ):
                from plane.research.utils.project_review import user_can_review_research_project

                if user_can_review_research_project(request.user, kwargs["slug"], kwargs["project_id"]):
                    return view_func(instance, request, *args, **kwargs)

            # Return permission denied if no conditions are met
            return Response(
                {"error": "You don't have the required permissions."},
                status=status.HTTP_403_FORBIDDEN,
            )

        return _wrapped_view

    return decorator
