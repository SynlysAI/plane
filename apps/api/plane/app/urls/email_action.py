"""Email action routes."""

from django.urls import path

from plane.app.views.email_action import AssignmentTransferEndpoint

urlpatterns = [
    path(
        "email-actions/assignment-transfer/",
        AssignmentTransferEndpoint.as_view(),
        name="email-assignment-transfer",
    ),
]
