# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

# Django imports
from django.db import transaction
from django.db.models import Count, Exists, OuterRef, Q, Case, When, BooleanField
from django.utils import timezone

# Third party imports
from rest_framework import status
from rest_framework.response import Response

from plane.app.serializers import (
    NotificationSerializer,
    SystemAnnouncementCreateSerializer,
    SystemAnnouncementSerializer,
    UserNotificationPreferenceSerializer,
)
from plane.db.models import (
    EmailNotificationLog,
    ExperimentAmendment,
    ExperimentRecord,
    Issue,
    IssueAssignee,
    IssueSubscriber,
    NotificationDeliveryAudit,
    PeriodicReport,
    Notification,
    NotificationEmailDelivery,
    NotificationEvent,
    NotificationGenerationOutbox,
    ProjectMember,
    ResearchChain,
    ResearchChainNodeTask,
    ResearchChainStage,
    ResearchFeedback,
    ResearchPaperReview,
    ResearchStageInstance,
    SystemAnnouncement,
    User,
    UserNotificationPreference,
    Workspace,
    WorkspaceNotificationPolicy,
    WorkspaceMember,
)
from plane.utils.paginator import BasePaginator
from plane.utils.order_queryset import NOTIFICATION_ORDER_BY_ALLOWLIST, sanitize_order_by
from plane.utils.administrative_projects import (
    administrative_organization_project_ids,
    administrative_projects_for_user,
    public_administrative_project_ids,
)
from plane.app.permissions import allow_permission, ROLE

# Module imports
from ..base import BaseAPIView, BaseViewSet


def parse_request_flag(value, default=False):
    """Convert a query or JSON flag to a boolean.

    Args:
        value: Raw value received from the client.
        default: Value used when the client omits the flag.

    Returns:
        Parsed boolean flag.
    """
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    return str(value).lower() in {"true", "1", "yes"}


def _visible_research_notifications(*, workspace_slug, receiver, visible_project_ids):
    """Build an entity filter from current research resource permissions."""
    if receiver is None:
        return Q(pk__in=[])
    if not WorkspaceMember.objects.filter(
        workspace__slug=workspace_slug,
        member=receiver,
        is_active=True,
        deleted_at__isnull=True,
    ).exists():
        return Q(pk__in=[])

    entity_names = (
        "research_report",
        "research_approval",
        "research_chain_task",
        "research_paper_review",
        "research_stage_review",
        "research_chain_stage",
        "research_stage",
        "research_experiment",
        "research_experiment_amendment",
        "research_feedback",
        "user_mention",
    )
    candidates = Notification.objects.filter(
        workspace__slug=workspace_slug,
        receiver=receiver,
        entity_name__in=entity_names,
        entity_identifier__isnull=False,
    )
    candidate_ids = {}
    for entity_name, entity_id in candidates.values_list("entity_name", "entity_identifier").distinct():
        candidate_ids.setdefault(entity_name, set()).add(entity_id)

    visible = Q(pk__in=[])

    approval_ids = candidate_ids.get("research_approval", set())
    if approval_ids and visible_project_ids:
        allowed_ids = Issue.objects.filter(
            pk__in=approval_ids,
            workspace__slug=workspace_slug,
            project_id__in=visible_project_ids,
            archived_at__isnull=True,
            project__archived_at__isnull=True,
        ).values_list("pk", flat=True)
        visible |= Q(entity_name="research_approval", entity_identifier__in=allowed_ids)

    report_ids = candidate_ids.get("research_report", set())
    if report_ids:
        from plane.research.utils.acl import build_actor_context, check_access
        from plane.research.utils.reports import report_resource

        reports = (
            PeriodicReport.objects.filter(
                pk__in=report_ids,
                workspace__slug=workspace_slug,
                deleted_at__isnull=True,
            )
            .select_related("workspace", "org_unit")
            .prefetch_related("access_grants")
        )
        contexts = {}
        allowed_ids = []
        for report in reports:
            context = contexts.get(report.workspace_id)
            if context is None:
                context = build_actor_context(receiver, report.workspace_id)
                contexts[report.workspace_id] = context
            if check_access(receiver, "view", report_resource(report), context=context):
                allowed_ids.append(report.pk)
        visible |= Q(entity_name="research_report", entity_identifier__in=allowed_ids)

    stage_ids = candidate_ids.get("research_stage", set()) | candidate_ids.get("research_stage_review", set())
    if stage_ids:
        from plane.research.utils.acl import build_actor_context, check_access
        from plane.research.utils.stages import stage_resource

        stages = ResearchStageInstance.objects.filter(
            pk__in=stage_ids,
            workspace__slug=workspace_slug,
            deleted_at__isnull=True,
        ).select_related("workspace", "project__research_profile", "org_unit")
        contexts = {}
        allowed_ids = set()
        for stage in stages:
            context = contexts.get(stage.workspace_id)
            if context is None:
                context = build_actor_context(receiver, stage.workspace_id)
                contexts[stage.workspace_id] = context
            if check_access(receiver, "view", stage_resource(stage, with_reviewers=True), context=context):
                allowed_ids.add(stage.pk)
        for entity_name in ("research_stage", "research_stage_review"):
            entity_ids = allowed_ids & candidate_ids.get(entity_name, set())
            visible |= Q(entity_name=entity_name, entity_identifier__in=entity_ids)

    experiment_ids = candidate_ids.get("research_experiment", set())
    amendment_ids = candidate_ids.get("research_experiment_amendment", set())
    if experiment_ids or amendment_ids:
        from plane.research.utils.acl import build_actor_context, check_access
        from plane.research.utils.resource_projections import experiment_resource

        records = (
            ExperimentRecord.objects.filter(
                Q(pk__in=experiment_ids) | Q(amendments__pk__in=amendment_ids),
                workspace__slug=workspace_slug,
                deleted_at__isnull=True,
            )
            .select_related("workspace", "project__research_profile", "stage_instance__org_unit")
            .distinct()
        )
        contexts = {}
        allowed_record_ids = set()
        for record in records:
            context = contexts.get(record.workspace_id)
            if context is None:
                context = build_actor_context(receiver, record.workspace_id)
                contexts[record.workspace_id] = context
            if check_access(receiver, "view", experiment_resource(record), context=context):
                allowed_record_ids.add(record.pk)
        visible |= Q(entity_name="research_experiment", entity_identifier__in=allowed_record_ids)
        if amendment_ids and allowed_record_ids:
            allowed_amendments = ExperimentAmendment.objects.filter(
                pk__in=amendment_ids,
                record_id__in=allowed_record_ids,
                record__workspace__slug=workspace_slug,
                deleted_at__isnull=True,
            ).values_list("pk", flat=True)
            visible |= Q(entity_name="research_experiment_amendment", entity_identifier__in=allowed_amendments)

    chain_task_ids = candidate_ids.get("research_chain_task", set())
    paper_review_ids = candidate_ids.get("research_paper_review", set())
    chain_stage_ids = candidate_ids.get("research_chain_stage", set())
    if chain_task_ids or paper_review_ids or chain_stage_ids:
        from plane.research.utils.settings import workspace_research_enabled
        from plane.research.views.projects import can_read_project_research_metadata

        workspace = Workspace.objects.filter(slug=workspace_slug).first()
        chain_query = (
            Q(node_tasks__pk__in=chain_task_ids)
            | Q(paper_reviews__pk__in=paper_review_ids)
            | Q(stage_approvals__pk__in=chain_stage_ids)
        )
        chains = ResearchChain.objects.filter(
            chain_query,
            workspace__slug=workspace_slug,
            deleted_at__isnull=True,
            project__deleted_at__isnull=True,
            project__research_profile__isnull=False,
            project__research_profile__deleted_at__isnull=True,
        ).select_related("workspace", "project__research_profile")
        allowed_chain_ids = set()
        if workspace and workspace_research_enabled(workspace):
            for chain in chains:
                if can_read_project_research_metadata(workspace, receiver, chain.project.research_profile):
                    allowed_chain_ids.add(chain.pk)
        if allowed_chain_ids:
            allowed_tasks = ResearchChainNodeTask.objects.filter(
                pk__in=chain_task_ids, chain_id__in=allowed_chain_ids, deleted_at__isnull=True
            ).values_list("pk", flat=True)
            allowed_reviews = ResearchPaperReview.objects.filter(
                pk__in=paper_review_ids, chain_id__in=allowed_chain_ids, deleted_at__isnull=True
            ).values_list("pk", flat=True)
            allowed_stages = ResearchChainStage.objects.filter(
                pk__in=chain_stage_ids, chain_id__in=allowed_chain_ids, deleted_at__isnull=True
            ).values_list("pk", flat=True)
            visible |= Q(entity_name="research_chain_task", entity_identifier__in=allowed_tasks)
            visible |= Q(entity_name="research_paper_review", entity_identifier__in=allowed_reviews)
            visible |= Q(entity_name="research_chain_stage", entity_identifier__in=allowed_stages)

    feedback_ids = candidate_ids.get("research_feedback", set())
    workspace = Workspace.objects.filter(slug=workspace_slug).first() if feedback_ids else None
    if feedback_ids and workspace:
        from plane.research.services.feedback import visible_feedback_queryset

        feedback_queryset = visible_feedback_queryset(receiver, workspace, scope="reply")
        allowed_feedback = feedback_queryset.filter(pk__in=feedback_ids).values_list("pk", flat=True)
        visible |= Q(entity_name="research_feedback", entity_identifier__in=allowed_feedback)

    mention_ids = candidate_ids.get("user_mention", set())
    if mention_ids:
        active_mentions = User.objects.filter(pk__in=mention_ids, is_active=True).values_list("pk", flat=True)
        visible |= Q(entity_name="user_mention", entity_identifier__in=active_mentions)

    return visible


def renderable_inbox_notifications(workspace_slug, receiver_id):
    """Return renderable work item, research, and system notifications.

    Work item notifications keep their existing entity validation. System
    announcements are rendered from their canonical announcement record and are
    safe to include without a project or work item. Research snapshots are
    filtered through the current permission of their backing resource.

    Args:
        workspace_slug: Workspace slug from the request.
        receiver_id: User whose notifications are being read.

    Returns:
        Notification queryset scoped to the requesting user's valid inbox items.
    """
    linked_issue = Issue.objects.filter(
        pk=OuterRef("entity_identifier"),
        workspace__slug=workspace_slug,
        archived_at__isnull=True,
        project__archived_at__isnull=True,
        is_draft=False,
    )
    intake_issue = Issue.objects.filter(
        pk=OuterRef("entity_identifier"),
        workspace__slug=workspace_slug,
        issue_intake__status__in=[0, 2, -2],
    )
    valid_research_report = PeriodicReport.objects.filter(
        pk=OuterRef("entity_identifier"),
        workspace__slug=workspace_slug,
        deleted_at__isnull=True,
    )
    valid_research_approval_issue = Issue.objects.filter(
        pk=OuterRef("entity_identifier"),
        workspace__slug=workspace_slug,
        archived_at__isnull=True,
        project__archived_at__isnull=True,
    )
    valid_chain_task = ResearchChainNodeTask.objects.filter(
        pk=OuterRef("entity_identifier"),
        workspace__slug=workspace_slug,
        deleted_at__isnull=True,
    )
    valid_feedback = ResearchFeedback.objects.filter(
        pk=OuterRef("entity_identifier"),
        workspace__slug=workspace_slug,
        deleted_at__isnull=True,
    )
    valid_paper_review = ResearchPaperReview.objects.filter(
        pk=OuterRef("entity_identifier"),
        workspace__slug=workspace_slug,
        deleted_at__isnull=True,
    )
    valid_stage_review = ResearchStageInstance.objects.filter(
        pk=OuterRef("entity_identifier"),
        workspace__slug=workspace_slug,
        deleted_at__isnull=True,
    )
    valid_chain_stage = ResearchChainStage.objects.filter(
        pk=OuterRef("entity_identifier"),
        workspace__slug=workspace_slug,
        deleted_at__isnull=True,
    )
    valid_stage = ResearchStageInstance.objects.filter(
        pk=OuterRef("entity_identifier"),
        workspace__slug=workspace_slug,
        deleted_at__isnull=True,
    )
    valid_experiment = ExperimentRecord.objects.filter(
        pk=OuterRef("entity_identifier"),
        workspace__slug=workspace_slug,
        deleted_at__isnull=True,
    )
    valid_experiment_amendment = ExperimentAmendment.objects.filter(
        pk=OuterRef("entity_identifier"),
        record__workspace__slug=workspace_slug,
        record__deleted_at__isnull=True,
        deleted_at__isnull=True,
    )
    valid_mentioned_user = User.objects.filter(
        pk=OuterRef("entity_identifier"),
        is_active=True,
    )

    receiver = User.objects.filter(pk=receiver_id, is_active=True).first()
    visible_project_ids = set()
    if (
        receiver
        and WorkspaceMember.objects.filter(
            workspace__slug=workspace_slug,
            member_id=receiver_id,
            is_active=True,
            deleted_at__isnull=True,
        ).exists()
    ):
        visible_project_ids.update(
            ProjectMember.objects.filter(
                project__workspace__slug=workspace_slug,
                member_id=receiver_id,
                is_active=True,
                deleted_at__isnull=True,
            ).values_list("project_id", flat=True)
        )
        visible_project_ids.update(
            public_administrative_project_ids(receiver, workspace_slug).values_list("id", flat=True)
        )
        visible_project_ids.update(
            administrative_organization_project_ids(receiver, workspace_slug).values_list("id", flat=True)
        )
        visible_project_ids.update(
            administrative_projects_for_user(receiver, workspace_slug).values_list("id", flat=True)
        )

    visible_research = _visible_research_notifications(
        workspace_slug=workspace_slug,
        receiver=receiver,
        visible_project_ids=visible_project_ids,
    )

    renderable_issue = (
        Q(project__isnull=False)
        & Q(entity_name="issue")
        & Q(project_id__in=visible_project_ids)
        & Q(entity_identifier__isnull=False)
        & Q(data__issue__id__isnull=False)
        & Q(data__issue_activity__field__isnull=False)
        & ~Q(data__issue__id="")
        & ~Q(data__issue_activity__field="")
    )
    renderable_announcement = Q(announcement__isnull=False) & Q(announcement__deleted_at__isnull=True)
    renderable_research = visible_research & (
        (Q(entity_name="research_report") & Exists(valid_research_report))
        | (Q(entity_name="research_approval") & Exists(valid_research_approval_issue))
        | (Q(entity_name="research_chain_task") & Exists(valid_chain_task))
        | (Q(entity_name="research_paper_review") & Exists(valid_paper_review))
        | (Q(entity_name="research_stage_review") & Exists(valid_stage_review))
        | (Q(entity_name="research_chain_stage") & Exists(valid_chain_stage))
        | (Q(entity_name="research_stage") & Exists(valid_stage))
        | (Q(entity_name="research_experiment") & Exists(valid_experiment))
        | (Q(entity_name="research_experiment_amendment") & Exists(valid_experiment_amendment))
        | (Q(entity_name="research_feedback") & Exists(valid_feedback))
        | (Q(entity_name="user_mention") & Exists(valid_mentioned_user))
    )

    return (
        Notification.objects.filter(
            workspace__slug=workspace_slug,
            receiver_id=receiver_id,
        )
        .filter(renderable_issue | renderable_announcement | renderable_research)
        .annotate(is_inbox_issue=Exists(intake_issue))
        .annotate(is_intake_issue=Exists(intake_issue))
        .annotate(
            is_mentioned_notification=Case(
                When(sender__icontains="mentioned", then=True),
                default=False,
                output_field=BooleanField(),
            )
        )
        .annotate(is_renderable_issue=Exists(linked_issue))
        .filter(Q(is_renderable_issue=True) | renderable_announcement | renderable_research)
        .select_related("workspace", "project", "triggered_by", "receiver", "announcement", "announcement__workspace")
    )


def filter_notifications_by_state(notifications, snoozed=False, archived=False):
    """Apply mutually understood snooze and archive filters to notifications.

    Args:
        notifications: Base notification queryset.
        snoozed: Whether snoozed notifications should be returned.
        archived: Whether archived notifications should be returned.

    Returns:
        Filtered notification queryset.
    """
    notifications = notifications.filter(
        snoozed_till__isnull=not snoozed,
        archived_at__isnull=not archived,
    )
    return notifications


def filter_notifications_by_type(notifications, workspace_slug, receiver_id, notification_type):
    """Apply the inbox work item type filter to notifications.

    Args:
        notifications: Base notification queryset.
        workspace_slug: Workspace slug from the request.
        receiver_id: User whose notifications are being filtered.
        notification_type: Comma-separated type value used by the inbox.

    Returns:
        Filtered notification queryset.
    """
    types = {notification_type_part.strip() for notification_type_part in notification_type.split(",")}
    q_filters = Q()

    if "subscribed" in types:
        issue_ids = (
            IssueSubscriber.objects.filter(workspace__slug=workspace_slug, subscriber_id=receiver_id)
            .annotate(created=Exists(Issue.objects.filter(created_by=receiver_id, pk=OuterRef("issue_id"))))
            .annotate(assigned=Exists(IssueAssignee.objects.filter(pk=OuterRef("issue_id"), assignee=receiver_id)))
            .filter(created=False, assigned=False)
            .values_list("issue_id", flat=True)
        )
        q_filters |= Q(entity_identifier__in=issue_ids)

    if "assigned" in types:
        issue_ids = IssueAssignee.objects.filter(workspace__slug=workspace_slug, assignee_id=receiver_id).values_list(
            "issue_id", flat=True
        )
        q_filters |= Q(entity_identifier__in=issue_ids)

    if "created" in types:
        if WorkspaceMember.objects.filter(
            workspace__slug=workspace_slug,
            member_id=receiver_id,
            role__lt=15,
            is_active=True,
        ).exists():
            return notifications.none()
        issue_ids = Issue.objects.filter(workspace__slug=workspace_slug, created_by_id=receiver_id).values_list(
            "pk", flat=True
        )
        q_filters |= Q(entity_identifier__in=issue_ids)

    return notifications.filter(q_filters)


class NotificationViewSet(BaseViewSet, BasePaginator):
    model = Notification
    serializer_class = NotificationSerializer

    def get_queryset(self):
        return renderable_inbox_notifications(
            self.kwargs.get("slug"),
            self.request.user.id,
        ).order_by("snoozed_till", "-created_at")

    @allow_permission(allowed_roles=[ROLE.ADMIN, ROLE.MEMBER, ROLE.GUEST], level="WORKSPACE")
    def list(self, request, slug):
        # Get query parameters
        snoozed = parse_request_flag(request.GET.get("snoozed"), False)
        archived = parse_request_flag(request.GET.get("archived"), False)
        read = request.GET.get("read", None)
        notification_type = request.GET.get("type", "all")
        mentioned = parse_request_flag(request.GET.get("mentioned"), False)

        notifications = self.get_queryset()
        notifications = filter_notifications_by_state(
            notifications,
            snoozed=snoozed,
            archived=archived,
        )

        if read == "false":
            notifications = notifications.filter(read_at__isnull=True)

        if read == "true":
            notifications = notifications.filter(read_at__isnull=False)

        if mentioned:
            notifications = notifications.filter(sender__icontains="mentioned")
        notifications = filter_notifications_by_type(
            notifications,
            workspace_slug=slug,
            receiver_id=request.user.id,
            notification_type=notification_type,
        )

        # Pagination
        if request.GET.get("per_page", False) and request.GET.get("cursor", False):
            return self.paginate(
                order_by=sanitize_order_by(
                    request.GET.get("order_by", "-created_at"),
                    NOTIFICATION_ORDER_BY_ALLOWLIST,
                    "-created_at",
                ),
                request=request,
                queryset=(notifications),
                on_results=lambda notifications: NotificationSerializer(notifications, many=True).data,
            )

        serializer = NotificationSerializer(notifications, many=True)
        return Response(serializer.data, status=status.HTTP_200_OK)

    @allow_permission(allowed_roles=[ROLE.ADMIN, ROLE.MEMBER, ROLE.GUEST], level="WORKSPACE")
    def partial_update(self, request, slug, pk):
        notification = self.get_queryset().get(pk=pk)
        # Only read_at and snoozed_till can be updated
        notification_data = {"snoozed_till": request.data.get("snoozed_till", None)}
        serializer = NotificationSerializer(notification, data=notification_data, partial=True)

        if serializer.is_valid():
            serializer.save()
            return Response(serializer.data, status=status.HTTP_200_OK)
        return Response(serializer.errors, status=status.HTTP_400_BAD_REQUEST)

    @allow_permission(allowed_roles=[ROLE.ADMIN, ROLE.MEMBER, ROLE.GUEST], level="WORKSPACE")
    def destroy(self, request, *args, **kwargs):
        notification = self.get_queryset().get(pk=kwargs.get("pk"))
        # Soft-delete only this recipient row without scheduling unrelated cascade work.
        notification.deleted_at = timezone.now()
        notification.save()
        return Response(status=status.HTTP_204_NO_CONTENT)

    @allow_permission(allowed_roles=[ROLE.ADMIN, ROLE.MEMBER, ROLE.GUEST], level="WORKSPACE")
    def mark_read(self, request, slug, pk):
        notification = self.get_queryset().get(pk=pk)
        notification.read_at = timezone.now()
        notification.save()
        serializer = NotificationSerializer(notification)
        return Response(serializer.data, status=status.HTTP_200_OK)

    @allow_permission(allowed_roles=[ROLE.ADMIN, ROLE.MEMBER, ROLE.GUEST], level="WORKSPACE")
    def mark_unread(self, request, slug, pk):
        notification = self.get_queryset().get(pk=pk)
        notification.read_at = None
        notification.save()
        serializer = NotificationSerializer(notification)
        return Response(serializer.data, status=status.HTTP_200_OK)

    @allow_permission(allowed_roles=[ROLE.ADMIN, ROLE.MEMBER, ROLE.GUEST], level="WORKSPACE")
    def archive(self, request, slug, pk):
        notification = self.get_queryset().get(pk=pk)
        notification.archived_at = timezone.now()
        notification.save()
        serializer = NotificationSerializer(notification)
        return Response(serializer.data, status=status.HTTP_200_OK)

    @allow_permission(allowed_roles=[ROLE.ADMIN, ROLE.MEMBER, ROLE.GUEST], level="WORKSPACE")
    def unarchive(self, request, slug, pk):
        notification = self.get_queryset().get(pk=pk)
        notification.archived_at = None
        notification.save()
        serializer = NotificationSerializer(notification)
        return Response(serializer.data, status=status.HTTP_200_OK)


class SystemAnnouncementEndpoint(BaseViewSet, BasePaginator):
    """Publish and list workspace-wide system announcements."""

    model = SystemAnnouncement
    serializer_class = SystemAnnouncementSerializer
    use_read_replica = False

    def get_queryset(self):
        return SystemAnnouncement.objects.filter(
            workspace__slug=self.kwargs.get("slug"),
            created_by=self.request.user,
        ).select_related("workspace", "created_by")

    @allow_permission(allowed_roles=[ROLE.ADMIN], level="WORKSPACE")
    def list(self, request, slug):
        """Return announcements published by the requesting administrator."""
        announcements = self.get_queryset().order_by("-published_at", "-created_at")
        return self.paginate(
            request=request,
            queryset=announcements,
            on_results=lambda announcements: SystemAnnouncementSerializer(announcements, many=True).data,
            default_per_page=20,
        )

    @allow_permission(allowed_roles=[ROLE.ADMIN], level="WORKSPACE")
    def create(self, request, slug):
        """Atomically publish an announcement to all active human members."""
        request_serializer = SystemAnnouncementCreateSerializer(data=request.data)
        if not request_serializer.is_valid():
            return Response(request_serializer.errors, status=status.HTTP_400_BAD_REQUEST)

        title = request_serializer.validated_data["title"]
        body = request_serializer.validated_data["body"]
        idempotency_key = request_serializer.validated_data.get("idempotency_key", "")

        with transaction.atomic():
            # Lock the workspace row to serialize concurrent idempotent publishes.
            workspace = Workspace.objects.select_for_update().get(slug=slug)

            existing_announcement = (
                SystemAnnouncement.objects.filter(workspace=workspace, idempotency_key=idempotency_key).first()
                if idempotency_key
                else None
            )
            if existing_announcement:
                return Response(
                    SystemAnnouncementSerializer(existing_announcement).data,
                    status=status.HTTP_200_OK,
                )

            published_at = timezone.now()
            announcement = SystemAnnouncement.objects.create(
                workspace=workspace,
                title=title,
                body=body,
                published_at=published_at,
                idempotency_key=idempotency_key,
                created_by=request.user,
            )
            recipient_ids = list(
                WorkspaceMember.objects.filter(
                    workspace=workspace,
                    is_active=True,
                    deleted_at__isnull=True,
                    member__is_active=True,
                )
                .exclude(member__is_bot=True)
                .values_list("member_id", flat=True)
            )
            policy = WorkspaceNotificationPolicy.objects.filter(
                workspace=workspace,
                category=WorkspaceNotificationPolicy.Category.SYSTEM_ANNOUNCEMENT,
                deleted_at__isnull=True,
            ).first()
            in_app_enabled = True if policy is None else policy.in_app_enabled
            if in_app_enabled:
                Notification.objects.bulk_create(
                    [
                        Notification(
                            workspace=workspace,
                            announcement=announcement,
                            receiver_id=recipient_id,
                            entity_identifier=announcement.id,
                            entity_name="system_announcement",
                            title=announcement.title,
                            message_html="",
                            message_stripped="",
                            sender="system:announcement",
                            triggered_by=request.user,
                            created_by=request.user,
                        )
                        for recipient_id in recipient_ids
                    ],
                    batch_size=500,
                )
            announcement.recipient_count = len(recipient_ids) if in_app_enabled else 0
            announcement.save()

        return Response(
            SystemAnnouncementSerializer(announcement).data,
            status=status.HTTP_201_CREATED,
        )


class UnreadNotificationEndpoint(BaseAPIView):
    # Keep the count on the primary database so it immediately reflects read,
    # archive, and snooze mutations for refreshes and multi-device clients.
    use_read_replica = False

    @allow_permission(allowed_roles=[ROLE.ADMIN, ROLE.MEMBER, ROLE.GUEST], level="WORKSPACE")
    def get(self, request, slug):
        unread_notifications = renderable_inbox_notifications(slug, request.user.id).filter(
            read_at__isnull=True,
            archived_at__isnull=True,
            snoozed_till__isnull=True,
        )
        unread_notification_counts = unread_notifications.aggregate(
            total_unread_notifications_count=Count("id", distinct=True),
            mention_unread_notifications_count=Count(
                "id",
                distinct=True,
                filter=Q(sender__icontains="mentioned"),
            ),
        )

        return Response(
            {
                "total_unread_notifications_count": int(unread_notification_counts["total_unread_notifications_count"]),
                "mention_unread_notifications_count": int(
                    unread_notification_counts["mention_unread_notifications_count"]
                ),
            },
            status=status.HTTP_200_OK,
        )


class MarkAllReadNotificationViewSet(BaseViewSet):
    @allow_permission(allowed_roles=[ROLE.ADMIN, ROLE.MEMBER, ROLE.GUEST], level="WORKSPACE")
    def create(self, request, slug):
        snoozed = parse_request_flag(request.data.get("snoozed"), False)
        archived = parse_request_flag(request.data.get("archived"), False)
        notification_type = request.data.get("type", "all")
        mentioned = parse_request_flag(request.data.get("mentioned"), False)

        notifications = renderable_inbox_notifications(slug, request.user.id).filter(
            read_at__isnull=True,
        )
        notifications = filter_notifications_by_state(
            notifications,
            snoozed=snoozed,
            archived=archived,
        )
        if mentioned:
            notifications = notifications.filter(sender__icontains="mentioned")
        notifications = filter_notifications_by_type(
            notifications,
            workspace_slug=slug,
            receiver_id=request.user.id,
            notification_type=notification_type,
        )

        updated_notifications = []
        for notification in notifications:
            notification.read_at = timezone.now()
            updated_notifications.append(notification)
        Notification.objects.bulk_update(updated_notifications, ["read_at"], batch_size=100)
        return Response({"message": "Successful"}, status=status.HTTP_200_OK)


class UserNotificationPreferenceEndpoint(BaseAPIView):
    model = UserNotificationPreference
    serializer_class = UserNotificationPreferenceSerializer

    # request the object
    def get(self, request):
        user_notification_preference, _ = UserNotificationPreference.objects.get_or_create(user=request.user)
        serializer = UserNotificationPreferenceSerializer(user_notification_preference)
        return Response(serializer.data, status=status.HTTP_200_OK)

    # update the object
    def patch(self, request):
        with transaction.atomic():
            UserNotificationPreference.objects.get_or_create(user=request.user)
            user_notification_preference = UserNotificationPreference.objects.select_for_update().get(user=request.user)
            serializer = UserNotificationPreferenceSerializer(
                user_notification_preference,
                data=request.data,
                partial=True,
            )
            if serializer.is_valid():
                serializer.save()
                return Response(serializer.data, status=status.HTTP_200_OK)
            return Response(serializer.errors, status=status.HTTP_400_BAD_REQUEST)


class WorkspaceNotificationPolicyEndpoint(BaseAPIView):
    """Manage workspace-wide notification channel policies for administrators."""

    POLICY_CATEGORIES = tuple(category for category, _label in WorkspaceNotificationPolicy.Category.choices)

    @allow_permission(allowed_roles=[ROLE.ADMIN], level="WORKSPACE")
    def get(self, request, slug):
        """Return every manageable category with effective defaults included."""
        workspace = Workspace.objects.get(slug=slug)
        return Response(self._policy_page(workspace), status=status.HTTP_200_OK)

    @allow_permission(allowed_roles=[ROLE.ADMIN], level="WORKSPACE")
    def patch(self, request, slug):
        """Atomically update one or more channel policies and suppress queued mail."""
        policies = request.data.get("policies") if isinstance(request.data, dict) else None
        if not isinstance(policies, list) or not policies:
            return Response({"policies": "必须为非空数组。"}, status=status.HTTP_400_BAD_REQUEST)

        validated = []
        seen_categories = set()
        for item in policies:
            if not isinstance(item, dict):
                return Response({"policies": "每一项必须为对象。"}, status=status.HTTP_400_BAD_REQUEST)
            category = item.get("category")
            if category not in self.POLICY_CATEGORIES or category in seen_categories:
                return Response({"category": "通知类型无效或重复。"}, status=status.HTTP_400_BAD_REQUEST)
            seen_categories.add(category)
            values = {"category": category}
            for field in ("in_app_enabled", "email_enabled"):
                if field in item:
                    if type(item[field]) is not bool:
                        return Response({field: "必须为布尔值。"}, status=status.HTTP_400_BAD_REQUEST)
                    values[field] = item[field]
            if len(values) == 1:
                return Response({"policies": "每一项至少包含一个通知开关。"}, status=status.HTTP_400_BAD_REQUEST)
            validated.append(values)

        disabled_email_categories = [item["category"] for item in validated if item.get("email_enabled") is False]
        with transaction.atomic():
            workspace = Workspace.objects.select_for_update().get(slug=slug)
            existing = {
                policy.category: policy
                for policy in WorkspaceNotificationPolicy.objects.select_for_update().filter(
                    workspace=workspace,
                    category__in=seen_categories,
                    deleted_at__isnull=True,
                )
            }
            updated_by_id = request.user.id
            for item in validated:
                category = item["category"]
                policy = existing.get(category)
                if policy is None:
                    policy = WorkspaceNotificationPolicy(workspace=workspace, category=category)
                    existing[category] = policy
                if "in_app_enabled" in item:
                    policy.in_app_enabled = item["in_app_enabled"]
                if "email_enabled" in item:
                    policy.email_enabled = item["email_enabled"]
                policy.updated_by_id = updated_by_id
                policy.save()

            if disabled_email_categories:
                self._suppress_queued_email(
                    workspace=workspace,
                    categories=disabled_email_categories,
                    actor=request.user,
                )

        return Response(self._policy_page(workspace), status=status.HTTP_200_OK)

    @staticmethod
    def _policy_page(workspace):
        """Build the complete effective-policy page.

        Args:
            workspace: Workspace whose effective policies are requested.

        Returns:
            Every category and its effective channel switches.
        """
        policies = {
            policy.category: policy
            for policy in WorkspaceNotificationPolicy.objects.filter(
                workspace=workspace,
                deleted_at__isnull=True,
            )
        }
        return {
            "policies": [
                {
                    "category": category,
                    "in_app_enabled": policies[category].in_app_enabled if category in policies else True,
                    "email_enabled": policies[category].email_enabled if category in policies else True,
                }
                for category in WorkspaceNotificationPolicy.Category.values
            ]
        }

    @staticmethod
    def _suppress_queued_email(*, workspace, categories, actor):
        """Suppress queued and pre-submission mail after an administrator action.

        Args:
            workspace: Workspace whose email policy changed.
            categories: Categories whose email channel was disabled.
            actor: Administrator who changed the policy.
        """
        now = timezone.now()
        deliveries = (
            NotificationEmailDelivery.objects.select_for_update()
            .select_related("event")
            .filter(
                event__workspace=workspace,
                event__category__in=categories,
                status__in=(
                    NotificationEmailDelivery.Status.PENDING,
                    NotificationEmailDelivery.Status.RETRY,
                    NotificationEmailDelivery.Status.PROCESSING,
                ),
            )
        )
        delivery_rows = list(deliveries)
        if not delivery_rows:
            return

        delivery_ids = [delivery.pk for delivery in delivery_rows]
        source_log_ids = [delivery.source_log_id for delivery in delivery_rows if delivery.source_log_id]
        NotificationEmailDelivery.objects.filter(pk__in=delivery_ids).update(
            status=NotificationEmailDelivery.Status.SUPPRESSED,
            available_at=now,
            lease_until=None,
            lease_token="",
            last_error_code="workspace_policy_disabled",
            last_error_at=now,
            updated_by=actor,
            updated_at=now,
        )
        if source_log_ids:
            EmailNotificationLog.objects.filter(pk__in=source_log_ids).update(
                delivery_status=EmailNotificationLog.DeliveryStatus.SUPPRESSED,
                available_at=now,
                processed_at=now,
                sent_at=None,
                lease_until=None,
                last_error_code="workspace_policy_disabled",
                updated_by=actor,
                updated_at=now,
            )
        NotificationDeliveryAudit.objects.bulk_create(
            [
                NotificationDeliveryAudit(
                    workspace=workspace,
                    delivery=delivery,
                    delivery_identifier=delivery.pk,
                    event_identifier=delivery.event.event_key,
                    actor=actor,
                    created_by=actor,
                    action="policy_suppress",
                    previous_status=delivery.status,
                    new_status=NotificationEmailDelivery.Status.SUPPRESSED,
                    reason="Workspace email policy disabled",
                )
                for delivery in delivery_rows
            ]
        )


class NotificationDeliveryDiagnosticsEndpoint(BaseAPIView):
    """Expose workspace-scoped notification delivery state to administrators."""

    @allow_permission(allowed_roles=[ROLE.ADMIN], level="WORKSPACE")
    def get(self, request, slug):
        """Return recent generation, delivery, and manual retry records without content."""
        try:
            limit = min(max(int(request.query_params.get("limit", 50)), 1), 100)
        except (TypeError, ValueError):
            return Response({"error": "limit must be an integer"}, status=status.HTTP_400_BAD_REQUEST)

        delivery_status = request.query_params.get("status")
        valid_statuses = {value for value, _label in NotificationEmailDelivery.Status.choices}
        if delivery_status and delivery_status not in valid_statuses:
            return Response({"error": "Invalid delivery status"}, status=status.HTTP_400_BAD_REQUEST)

        generation_rows = NotificationGenerationOutbox.objects.filter(workspace__slug=slug).order_by("-created_at")[
            :limit
        ]
        generation = [
            {
                "id": str(row.pk),
                "event_type": (row.payload or {}).get("type", ""),
                "issue_id": (row.payload or {}).get("issue_id"),
                "status": row.status,
                "attempts": row.attempts,
                "last_error_code": row.last_error_code,
                "created_at": row.created_at,
                "processed_at": row.processed_at,
            }
            for row in generation_rows
        ]

        events = NotificationEvent.objects.filter(workspace__slug=slug)
        if delivery_status:
            events = events.filter(email_delivery__status=delivery_status)
        events = events.select_related("receiver", "triggered_by", "email_delivery").order_by("-created_at")[:limit]
        deliveries = []
        for event in events:
            try:
                delivery = event.email_delivery
            except NotificationEmailDelivery.DoesNotExist:
                delivery = None
            deliveries.append(
                {
                    "event_id": str(event.event_key),
                    "recipient": event.receiver.email,
                    "entity": event.entity_name,
                    "entity_id": str(event.entity_identifier) if event.entity_identifier else None,
                    "action": event.action,
                    "category": event.category,
                    "recipient_reason": event.recipient_reason,
                    "status": delivery.status if delivery else "not_scheduled",
                    "attempts": delivery.attempts if delivery else 0,
                    "last_error_code": delivery.last_error_code if delivery else "",
                    "created_at": event.created_at,
                    "smtp_accepted_at": delivery.smtp_accepted_at if delivery else None,
                }
            )

        audits = (
            NotificationDeliveryAudit.objects.filter(workspace__slug=slug)
            .select_related("actor")
            .order_by("-created_at")[:limit]
        )
        audit_rows = [
            {
                "delivery_id": str(row.delivery_identifier),
                "event_id": str(row.event_identifier) if row.event_identifier else None,
                "actor": row.actor.email if row.actor else None,
                "action": row.action,
                "previous_status": row.previous_status,
                "new_status": row.new_status,
                "reason": row.reason,
                "created_at": row.created_at,
            }
            for row in audits
        ]
        return Response(
            {"generation": generation, "deliveries": deliveries, "audits": audit_rows},
            status=status.HTTP_200_OK,
        )
