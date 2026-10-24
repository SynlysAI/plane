# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Workspace member operations-account configuration API."""

from django.db import transaction
from django.db.models import Prefetch
from django.utils import timezone
from rest_framework import status
from rest_framework.response import Response

from plane.app.permissions import ROLE, WorkspaceViewerPermission, allow_permission
from plane.app.serializers import WorkspaceMemberAdminSerializer
from plane.app.views.base import BaseAPIView
from plane.db.models import WorkspaceMember, WorkspaceMemberTagAssignment


class WorkspaceMemberAccountConfigBulkEndpoint(BaseAPIView):
    """Set or cancel the workspace-scoped feedback operations marker."""

    permission_classes = [WorkspaceViewerPermission]

    @allow_permission([ROLE.ADMIN], level="WORKSPACE")
    @transaction.atomic
    def post(self, request, slug):
        """Configure selected ordinary members in one all-or-nothing transaction.

        Args:
            request: Admin DRF request carrying member user IDs and target state.
            slug: Workspace slug from the URL.

        Returns:
            The refreshed member records, or a validation/authorization error.
        """
        member_ids = request.data.get("member_ids")
        is_operations_account = request.data.get("is_operations_account")
        if not isinstance(member_ids, list) or not member_ids:
            return Response(
                {"error": "member_ids must be a non-empty list."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        if not isinstance(is_operations_account, bool):
            return Response(
                {"error": "is_operations_account must be a boolean."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        unique_member_ids = {str(member_id) for member_id in member_ids}
        members = list(
            WorkspaceMember.objects.filter(
                workspace__slug=slug,
                member_id__in=unique_member_ids,
                is_active=True,
                member__is_bot=False,
            )
            .select_related("member", "member__avatar_asset")
            .prefetch_related(
                Prefetch(
                    "tag_assignments",
                    queryset=WorkspaceMemberTagAssignment.objects.select_related("tag__group"),
                    to_attr="prefetched_tag_assignments",
                )
            )
            .order_by("member_id")
        )
        if len(members) != len(unique_member_ids) or any(member.role != ROLE.MEMBER.value for member in members):
            return Response(
                {"error": "Only active ordinary members in this workspace can be configured."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        now = timezone.now()
        for member in members:
            member.is_operations_account = is_operations_account
            member.updated_by = request.user
            member.updated_at = now
        WorkspaceMember.objects.bulk_update(
            members,
            ["is_operations_account", "updated_by", "updated_at"],
            batch_size=100,
        )

        return Response(
            {
                "members": WorkspaceMemberAdminSerializer(
                    members,
                    fields=(
                        "id",
                        "member",
                        "role",
                        "is_active",
                        "is_operations_account",
                        "created_at",
                        "tags",
                    ),
                    many=True,
                ).data
            }
        )
