"""Workspace-wide layout defaults for administrative system views."""

from django.db import transaction
from rest_framework import status
from rest_framework.response import Response

from plane.app.permissions import ROLE, allow_permission
from plane.app.serializers.workspace import WorkspaceAdministrativeViewDefaultSerializer
from plane.app.views.base import BaseAPIView
from plane.db.models import (
    Workspace,
    WorkspaceAdministrativeViewDefault,
)
from plane.db.models.workspace import (
    get_default_administrative_view_display_filters,
    get_default_administrative_view_display_properties,
)


def serialize_default_layout(default_layout):
    """Convert an optional persisted layout into the API response shape.

    Args:
        default_layout: A persisted workspace layout or ``None``.

    Returns:
        A dictionary containing complete display filters and properties.
    """
    return {
        "display_filters": (
            default_layout.display_filters if default_layout else get_default_administrative_view_display_filters()
        ),
        "display_properties": (
            default_layout.display_properties
            if default_layout
            else get_default_administrative_view_display_properties()
        ),
        "updated_at": default_layout.updated_at if default_layout else None,
    }


class WorkspaceAdministrativeViewDefaultEndpoint(BaseAPIView):
    """Read and publish the workspace default for administrative system views."""

    @allow_permission([ROLE.ADMIN, ROLE.MEMBER, ROLE.GUEST], level="WORKSPACE")
    def get(self, request, slug):
        """Return the active default without creating a database row."""
        default_layout = WorkspaceAdministrativeViewDefault.objects.filter(workspace__slug=slug).first()
        return Response(serialize_default_layout(default_layout), status=status.HTTP_200_OK)

    @allow_permission([ROLE.ADMIN], level="WORKSPACE")
    def patch(self, request, slug):
        """Publish display settings as the forced default for all members."""
        workspace = Workspace.objects.filter(slug=slug).first()
        if workspace is None:
            return Response({"detail": "Workspace not found"}, status=status.HTTP_404_NOT_FOUND)

        serializer = WorkspaceAdministrativeViewDefaultSerializer(data=request.data, partial=True)
        if not serializer.is_valid():
            return Response(serializer.errors, status=status.HTTP_400_BAD_REQUEST)

        with transaction.atomic():
            default_layout = (
                WorkspaceAdministrativeViewDefault.objects.select_for_update().filter(workspace=workspace).first()
            )
            current = serialize_default_layout(default_layout)
            display_filters = {**current["display_filters"], **serializer.validated_data.get("display_filters", {})}
            display_properties = {
                **current["display_properties"],
                **serializer.validated_data.get("display_properties", {}),
            }
            if default_layout is None:
                default_layout = WorkspaceAdministrativeViewDefault(workspace=workspace)
            default_layout.display_filters = display_filters
            default_layout.display_properties = display_properties
            default_layout.save()

        return Response(
            WorkspaceAdministrativeViewDefaultSerializer(default_layout).data,
            status=status.HTTP_200_OK,
        )
