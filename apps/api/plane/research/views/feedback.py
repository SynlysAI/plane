"""Plane-native research feedback API endpoints."""

from django.http import StreamingHttpResponse
from rest_framework.response import Response

from plane.research.services.feedback import (
    create_feedback,
    list_feedback,
    open_feedback_screenshot,
    update_feedback_status,
)
from plane.research.utils.errors import ResearchAPIException
from plane.research.views.base import ResearchAPIView


def _error_response(exception):
    """Convert a controlled research exception to the API error envelope.

    Args:
        exception: Research service validation or authorization error.

    Returns:
        A DRF response carrying the stable error code and message.
    """
    return Response(
        {"error_code": exception.error_code, "message": exception.message_text},
        status=exception.status_code,
    )


class ResearchFeedbackEndpoint(ResearchAPIView):
    """Create feedback and list the caller's own or managed records."""

    nav_capability = None

    def get(self, request, slug):
        """Return own feedback, or the management scope when explicitly authorized.

        Args:
            request: Authenticated DRF request.
            slug: Workspace slug from the URL.

        Returns:
            The paginated feedback response or a controlled error.
        """
        workspace, error = self.get_workspace(nav=None, require_enabled=False)
        if error:
            return error
        try:
            data = list_feedback(request, request.user, workspace)
        except ResearchAPIException as exception:
            return _error_response(exception)
        return Response({"code": 0, "data": data})

    def post(self, request, slug):
        """Validate and persist a feedback submission with optional screenshots.

        Args:
            request: Authenticated multipart request.
            slug: Workspace slug from the URL.

        Returns:
            The created feedback record or a controlled error.
        """
        workspace, error = self.get_workspace(nav=None, require_enabled=False)
        if error:
            return error
        try:
            data = create_feedback(request, request.user, workspace)
        except ResearchAPIException as exception:
            return _error_response(exception)
        return Response({"code": 0, "data": data})


class ResearchFeedbackStatusEndpoint(ResearchAPIView):
    """Update the status of a feedback record in an authorized management scope."""

    nav_capability = None

    def patch(self, request, slug, feedback_id):
        """Apply a status transition and return the updated record.

        Args:
            request: Authenticated manager request.
            slug: Workspace slug from the URL.
            feedback_id: UUID of the feedback record.

        Returns:
            The updated feedback record or a controlled error.
        """
        workspace, error = self.get_workspace(nav=None, require_enabled=False)
        if error:
            return error
        try:
            data = update_feedback_status(request, request.user, workspace, feedback_id)
        except ResearchAPIException as exception:
            return _error_response(exception)
        return Response({"code": 0, "data": data})


class ResearchFeedbackScreenshotEndpoint(ResearchAPIView):
    """Stream an authorized feedback screenshot from Plane storage."""

    nav_capability = None

    def get(self, request, slug, feedback_id, screenshot_id):
        """Return a no-store image stream after applying feedback ACL.

        Args:
            request: Authenticated request.
            slug: Workspace slug from the URL.
            feedback_id: UUID of the parent feedback record.
            screenshot_id: UUID of the screenshot registration.

        Returns:
            A streamed screenshot response or a controlled error.
        """
        workspace, error = self.get_workspace(nav=None, require_enabled=False)
        if error:
            return error
        try:
            body, content_type = open_feedback_screenshot(
                request,
                request.user,
                workspace,
                feedback_id,
                screenshot_id,
            )
        except ResearchAPIException as exception:
            return _error_response(exception)
        response = StreamingHttpResponse(body, content_type=content_type)
        response["Cache-Control"] = "private, no-store"
        response["X-Content-Type-Options"] = "nosniff"
        return response
