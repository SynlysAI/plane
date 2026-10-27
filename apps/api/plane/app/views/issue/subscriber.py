# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

# Third Party imports
from rest_framework.response import Response
from rest_framework import status

# Module imports
from .. import BaseViewSet
from plane.app.serializers import IssueSubscriberSerializer, ProjectMemberLiteSerializer
from plane.app.permissions import ProjectEntityPermission, ProjectLitePermission
from plane.app.services.task_notification_recipients import (
    issue_notification_recipients,
    replace_issue_cc,
    set_issue_self_subscription,
)
from plane.db.models import Issue, IssueSubscriber, Project, ProjectMember
from plane.research.utils.project_review import project_member_filters
from plane.utils.administrative_projects import research_project_ids


class IssueSubscriberViewSet(BaseViewSet):
    serializer_class = IssueSubscriberSerializer
    model = IssueSubscriber

    permission_classes = [ProjectEntityPermission]

    def get_permissions(self):
        if self.action in [
            "subscribe",
            "unsubscribe",
            "subscription_status",
            "notification_recipient_self",
        ]:
            self.permission_classes = [ProjectLitePermission]
        else:
            self.permission_classes = [ProjectEntityPermission]

        return super(IssueSubscriberViewSet, self).get_permissions()

    def perform_create(self, serializer):
        serializer.save(
            project_id=self.kwargs.get("project_id"),
            issue_id=self.kwargs.get("issue_id"),
        )

    def get_queryset(self):
        return (
            super()
            .get_queryset()
            .filter(workspace__slug=self.kwargs.get("slug"))
            .filter(project_id=self.kwargs.get("project_id"))
            .filter(issue_id=self.kwargs.get("issue_id"))
            .filter(
                **project_member_filters(self.request.user, self.kwargs.get("slug"), self.kwargs.get("project_id")),
                project__archived_at__isnull=True,
            )
            .order_by("-created_at")
            .distinct()
        )

    def list(self, request, slug, project_id, issue_id):
        members = ProjectMember.objects.filter(
            workspace__slug=slug, project_id=project_id, is_active=True
        ).select_related("member")
        serializer = ProjectMemberLiteSerializer(members, many=True)
        return Response(serializer.data, status=status.HTTP_200_OK)

    def _notification_context(self, slug, project_id, issue_id):
        project = Project.objects.filter(
            workspace__slug=slug,
            pk=project_id,
            archived_at__isnull=True,
            deleted_at__isnull=True,
        ).first()
        is_research_project = Project.objects.filter(pk=project.id, id__in=research_project_ids()).exists()
        if project is None or is_research_project:
            return None, None
        issue = Issue.objects.filter(
            workspace__slug=slug,
            project_id=project.id,
            pk=issue_id,
            deleted_at__isnull=True,
        ).first()
        return project, issue

    def notification_recipients(self, request, slug, project_id, issue_id):
        project, issue = self._notification_context(slug, project_id, issue_id)
        if project is None or issue is None:
            return Response({"error": "The required object does not exist."}, status=status.HTTP_404_NOT_FOUND)

        if request.method == "PUT":
            try:
                payload = replace_issue_cc(
                    project=project,
                    issue=issue,
                    actor=request.user,
                    user_ids=request.data.get("user_ids"),
                )
            except ValueError as error:
                return Response({"error": str(error)}, status=status.HTTP_422_UNPROCESSABLE_ENTITY)
        else:
            payload = issue_notification_recipients(project, issue, request.user)
        return Response(payload, status=status.HTTP_200_OK)

    def notification_recipient_self(self, request, slug, project_id, issue_id):
        project, issue = self._notification_context(slug, project_id, issue_id)
        if project is None or issue is None:
            return Response({"error": "The required object does not exist."}, status=status.HTTP_404_NOT_FOUND)
        payload = set_issue_self_subscription(
            project=project,
            issue=issue,
            actor=request.user,
            subscribed=request.method == "POST",
        )
        return Response(payload, status=status.HTTP_200_OK)

    def destroy(self, request, slug, project_id, issue_id, subscriber_id):
        issue_subscriber = IssueSubscriber.objects.get(
            project=project_id,
            subscriber=subscriber_id,
            workspace__slug=slug,
            issue=issue_id,
        )
        issue_subscriber.delete()
        return Response(status=status.HTTP_204_NO_CONTENT)

    def subscribe(self, request, slug, project_id, issue_id):
        if IssueSubscriber.objects.filter(
            issue_id=issue_id,
            subscriber=request.user,
            workspace__slug=slug,
            project=project_id,
        ).exists():
            return Response(
                {"message": "User already subscribed to the issue."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        subscriber = IssueSubscriber.objects.create(
            issue_id=issue_id,
            subscriber_id=request.user.id,
            project_id=project_id,
            source=IssueSubscriber.Source.SELF,
        )
        serializer = IssueSubscriberSerializer(subscriber)
        return Response(serializer.data, status=status.HTTP_201_CREATED)

    def unsubscribe(self, request, slug, project_id, issue_id):
        issue_subscriber = IssueSubscriber.objects.get(
            project=project_id,
            subscriber=request.user,
            workspace__slug=slug,
            issue=issue_id,
        )
        issue_subscriber.delete()
        return Response(status=status.HTTP_204_NO_CONTENT)

    def subscription_status(self, request, slug, project_id, issue_id):
        issue_subscriber = IssueSubscriber.objects.filter(
            issue=issue_id,
            subscriber=request.user,
            workspace__slug=slug,
            project=project_id,
        ).exists()
        return Response({"subscribed": issue_subscriber}, status=status.HTTP_200_OK)
