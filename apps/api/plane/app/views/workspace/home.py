# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""User-scoped home layout preferences."""

from ..base import BaseAPIView
from plane.db.models.workspace import WorkspaceHomePreference
from plane.app.permissions import allow_permission, ROLE
from plane.db.models import Workspace
from plane.app.serializers.workspace import WorkspaceHomePreferenceSerializer

from rest_framework.response import Response
from rest_framework import status


# Descending sort order is part of the existing home-widget API contract.
DEFAULT_HOME_PREFERENCES = (
    (WorkspaceHomePreference.HomeWidgetKeys.MY_TODOS, True, {"size": "medium"}, 1100),
    (WorkspaceHomePreference.HomeWidgetKeys.RESEARCH_PROJECTS, True, {"size": "large"}, 1000),
    (WorkspaceHomePreference.HomeWidgetKeys.ADMINISTRATIVE_PROJECTS, True, {"size": "medium"}, 900),
    (WorkspaceHomePreference.HomeWidgetKeys.RECENT_ACTIVITY, True, {"size": "medium"}, 800),
    (WorkspaceHomePreference.HomeWidgetKeys.REPORT_SUMMARY, True, {"size": "medium"}, 700),
    (WorkspaceHomePreference.HomeWidgetKeys.QUICK_LINKS, True, {}, 500),
    (WorkspaceHomePreference.HomeWidgetKeys.RECENTS, True, {}, 400),
    (WorkspaceHomePreference.HomeWidgetKeys.MY_STICKIES, True, {}, 300),
    (
        WorkspaceHomePreference.HomeWidgetKeys.WORKBENCH_LAYOUT,
        True,
        {"density": "compact"},
        100,
    ),
)


class WorkspaceHomePreferenceViewSet(BaseAPIView):
    """Read and patch the requesting user's home-widget preferences."""

    model = WorkspaceHomePreference

    def get_serializer_class(self):
        return WorkspaceHomePreferenceSerializer

    @allow_permission([ROLE.ADMIN, ROLE.MEMBER, ROLE.GUEST], level="WORKSPACE")
    def get(self, request, slug):
        """Return preferences, creating only rows missing for this user."""
        workspace = Workspace.objects.get(slug=slug)
        known_keys = {key for key, _ in WorkspaceHomePreference.HomeWidgetKeys.choices}
        preferences = WorkspaceHomePreference.objects.filter(
            user=request.user,
            workspace_id=workspace.id,
            key__in=known_keys,
        )
        existing_keys = set(preferences.values_list("key", flat=True))
        missing = [
            WorkspaceHomePreference(
                key=key,
                user=request.user,
                workspace=workspace,
                is_enabled=is_enabled,
                config=config,
                sort_order=sort_order,
            )
            for key, is_enabled, config, sort_order in DEFAULT_HOME_PREFERENCES
            if key not in existing_keys
        ]
        if missing:
            # Concurrent home loads can both observe a missing key. The unique
            # constraint makes the second insert a no-op and the refetch below
            # remains authoritative.
            WorkspaceHomePreference.objects.bulk_create(missing, ignore_conflicts=True)

        preferences = WorkspaceHomePreference.objects.filter(
            user=request.user,
            workspace_id=workspace.id,
            key__in=known_keys,
        ).exclude(key__in=["quick_tutorial", "new_at_plane"])

        return Response(
            preferences.values("key", "is_enabled", "config", "sort_order"),
            status=status.HTTP_200_OK,
        )

    @allow_permission([ROLE.ADMIN, ROLE.MEMBER, ROLE.GUEST], level="WORKSPACE")
    def patch(self, request, slug, key):
        """Patch one preference row for the requesting user only."""
        if key not in WorkspaceHomePreference.HomeWidgetKeys.values:
            return Response({"detail": "Preference not found"}, status=status.HTTP_400_BAD_REQUEST)

        preference = WorkspaceHomePreference.objects.filter(
            key=key,
            workspace__slug=slug,
            user=request.user,
        ).first()
        if preference is None:
            return Response({"detail": "Preference not found"}, status=status.HTTP_400_BAD_REQUEST)

        serializer = WorkspaceHomePreferenceSerializer(preference, data=request.data, partial=True)
        if serializer.is_valid():
            serializer.save()
            return Response(serializer.data, status=status.HTTP_200_OK)
        return Response(serializer.errors, status=status.HTTP_400_BAD_REQUEST)
